# databricks/utils/delta_helpers.py
#
# Reusable PySpark utilities imported by gold_aggregation.py.
# Covers Delta Lake MERGE semantics, rolling window helpers, and
# common validation functions used across all three gold outputs.
#
# Import in notebooks:
#   %run ./utils/delta_helpers
# or as a module if using Databricks Repos:
#   from utils.delta_helpers import merge_into_delta, rolling_window_filter

from datetime import date, timedelta
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import StringType


# ── Delta MERGE helpers ────────────────────────────────────────────────────────

def merge_into_delta(
    spark: SparkSession,
    source_df: DataFrame,
    target_path: str,
    merge_keys: list,
    update_cols: list = None,
) -> dict:
    """
    MERGE (upsert) a source DataFrame into a Delta table at target_path.

    If the Delta table doesn't exist yet, creates it from the source.
    If it exists, performs a MERGE ON merge_keys:
      - MATCHED    → UPDATE SET all update_cols (or all columns if None)
      - NOT MATCHED → INSERT all columns

    Returns a dict with { inserted, updated, total } row counts.

    Example:
        merge_into_delta(
            spark,
            sentiment_df,
            "abfss://articles-gold@<acct>.dfs.core.windows.net/sentiment_trends",
            merge_keys=["run_date", "category", "article_date"],
        )
    """
    from delta.tables import DeltaTable

    if not DeltaTable.isDeltaTable(spark, target_path):
        # First run — write as new Delta table
        source_df.write.format("delta").mode("overwrite").save(target_path)
        count = source_df.count()
        print(f"  Created new Delta table at {target_path} ({count} rows)")
        return {"inserted": count, "updated": 0, "total": count}

    delta_table = DeltaTable.forPath(spark, target_path)

    # Build merge condition from keys
    merge_condition = " AND ".join(
        [f"target.{k} = source.{k}" for k in merge_keys]
    )

    # Determine columns to update
    cols_to_update = update_cols or [
        c for c in source_df.columns if c not in merge_keys
    ]
    update_map = {c: f"source.{c}" for c in cols_to_update}

    # All columns for INSERT
    insert_map = {c: f"source.{c}" for c in source_df.columns}

    delta_table.alias("target").merge(
        source_df.alias("source"), merge_condition
    ).whenMatchedUpdate(set=update_map
    ).whenNotMatchedInsert(values=insert_map
    ).execute()

    # Row counts from operation metrics
    metrics    = delta_table.history(1).select("operationMetrics").collect()[0][0]
    inserted   = int(metrics.get("numTargetRowsInserted", 0))
    updated    = int(metrics.get("numTargetRowsUpdated",  0))

    print(f"  MERGE complete: {inserted} inserted, {updated} updated → {target_path}")
    return {"inserted": inserted, "updated": updated, "total": inserted + updated}


def overwrite_partition(
    df: DataFrame,
    target_path: str,
    partition_col: str,
    partition_value: str,
) -> int:
    """
    Overwrite a single partition in a Delta table using REPLACE WHERE.
    Idempotent — re-running for the same partition_value is safe.

    Used by gold outputs that are partitioned by run_date:
        overwrite_partition(sentiment_df, gold_path, "run_date", "2024-01-15")

    Returns row count written.
    """
    count = df.count()
    (
        df.write
        .format("delta")
        .mode("overwrite")
        .option("replaceWhere", f"{partition_col} = '{partition_value}'")
        .save(target_path)
    )
    print(f"  Overwrote partition {partition_col}={partition_value}: {count} rows → {target_path}")
    return count


# ── Rolling window helpers ─────────────────────────────────────────────────────

def rolling_window_filter(
    df: DataFrame,
    date_col: str,
    run_date: date,
    window_days: int,
) -> DataFrame:
    """
    Filter a DataFrame to a rolling window ending on run_date (inclusive).

    Example — 7-day window ending 2024-01-15:
        filtered = rolling_window_filter(silver_df, "article_date", run_date, 7)
        # Returns articles from 2024-01-09 through 2024-01-15
    """
    window_start = (run_date - timedelta(days=window_days - 1)).isoformat()
    window_end   = run_date.isoformat()

    return df.filter(
        (F.col(date_col) >= window_start) & (F.col(date_col) <= window_end)
    )


def prior_window_filter(
    df: DataFrame,
    date_col: str,
    run_date: date,
    window_days: int,
) -> DataFrame:
    """
    Filter to the window BEFORE the current rolling window.
    Used to compute trend_score = current_count / (prior_count + 1).

    Example — prior 3-day window before 2024-01-15 with window_days=3:
        prior = prior_window_filter(silver_df, "article_date", run_date, 3)
        # Returns articles from 2024-01-09 through 2024-01-11
    """
    prior_end   = (run_date - timedelta(days=window_days)).isoformat()
    prior_start = (run_date - timedelta(days=window_days * 2 - 1)).isoformat()

    return df.filter(
        (F.col(date_col) >= prior_start) & (F.col(date_col) <= prior_end)
    )


# ── Data quality helpers ───────────────────────────────────────────────────────

def assert_silver_schema(df: DataFrame) -> None:
    """
    Validate that a silver DataFrame has the minimum required columns.
    Raises ValueError with a clear message if any are missing.
    Call at the start of gold_aggregation.py before any transformations.
    """
    required_cols = {
        "id", "category", "publishedAt", "nlpStatus",
        "sentiment", "entities", "keyPhrases",
    }
    actual_cols = set(df.columns)
    missing     = required_cols - actual_cols

    if missing:
        raise ValueError(
            f"Silver DataFrame missing required columns: {sorted(missing)}. "
            f"Present: {sorted(actual_cols)}"
        )
    print(f"  Silver schema valid — {len(actual_cols)} columns present")


def log_data_quality(df: DataFrame, label: str) -> None:
    """
    Print a quick data quality summary for a DataFrame.
    Call after loading silver data to catch issues early.
    """
    total       = df.count()
    ok_count    = df.filter(F.col("nlpStatus") == "ok").count()
    failed_count = total - ok_count
    pii_count   = df.filter(F.col("hasPii") == True).count() if "hasPii" in df.columns else "N/A"

    print(f"  [{label}] rows={total} nlpOk={ok_count} nlpFailed={failed_count} pii={pii_count}")

    if total == 0:
        print(f"  WARNING: [{label}] DataFrame is empty")
    elif failed_count / max(total, 1) > 0.2:
        print(f"  WARNING: [{label}] >20% NLP failures — check fn-enrich logs")


def safe_explode_entities(df: DataFrame) -> DataFrame:
    """
    Safely explode the entities array, handling both struct format
    (from Language API: {text, category, confidenceScore}) and
    plain string format (from Search index: flattened string[]).

    Returns a DataFrame with columns: id, category (article), entity_text
    """
    has_struct = "text" in [f.name for f in df.schema["entities"].dataType.elementType.fields] \
        if hasattr(df.schema["entities"].dataType, "elementType") \
        and hasattr(df.schema["entities"].dataType.elementType, "fields") \
        else False

    exploded = df.filter(F.col("entities").isNotNull()) \
                 .select("id", "category", F.explode("entities").alias("entity"))

    if has_struct:
        return exploded.withColumn(
            "entity_text",
            F.when(F.col("entity.text").isNotNull(), F.col("entity.text"))
             .otherwise(F.col("entity").cast(StringType()))
        )
    else:
        return exploded.withColumn("entity_text", F.col("entity").cast(StringType()))