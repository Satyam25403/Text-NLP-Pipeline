# Databricks notebook source
# gold_aggregation.py
#
# Called by ADF Pipeline Activity 2 (Databricks Notebook activity)
# Reads silver layer from ADLS Gen2, computes gold aggregations, writes back.
#
# Gold outputs:
#   gold/sentiment_trends/{date}/     → sentiment by category, daily rolling 7-day window
#   gold/top_entities/{date}/         → top entities per category per week
#   gold/trending_keywords/{date}/    → trending key phrases over rolling 3-day window
#
# MERGE (upsert) semantics: each run is idempotent — REPLACE WHERE on date partition
# so re-running for the same date overwrites cleanly without duplicates.

# COMMAND ----------

# Parameters — injected by ADF via Databricks Notebook activity widgets
dbutils.widgets.text("run_date",       "", "Run date (YYYY-MM-DD, blank = yesterday)")
dbutils.widgets.text("silver_root",    "abfss://articles-silver@<account>.dfs.core.windows.net", "Silver ADLS path")
dbutils.widgets.text("gold_root",      "abfss://articles-gold@<account>.dfs.core.windows.net",   "Gold ADLS path")
dbutils.widgets.text("lookback_days",  "7",  "Days to look back for trend windows")
dbutils.widgets.text("keyword_window", "3",  "Rolling window in days for keyword trends")
dbutils.widgets.text("categories",     "technology,business,science,health", "Comma-separated ingest categories — must match Logic App + fn-index-refresh")

# COMMAND ----------

import re
from datetime import date, timedelta, datetime
from pyspark.sql import functions as F
from pyspark.sql.window import Window
from pyspark.sql.types import StringType, DoubleType

# ── Parameters ──────────────────────────────────────────────────────────────
run_date_str   = dbutils.widgets.get("run_date").strip()
silver_root    = dbutils.widgets.get("silver_root").rstrip("/")
gold_root      = dbutils.widgets.get("gold_root").rstrip("/")
lookback_days  = int(dbutils.widgets.get("lookback_days") or "7")
keyword_window = int(dbutils.widgets.get("keyword_window") or "3")
categories_raw = dbutils.widgets.get("categories") or "technology,business,science,health"
categories     = [c.strip() for c in categories_raw.split(",") if c.strip()]

# Default to yesterday if no date supplied
if not run_date_str:
    run_date_str = (date.today() - timedelta(days=1)).isoformat()

run_date = datetime.strptime(run_date_str, "%Y-%m-%d").date()

print(f"Run date        : {run_date_str}")
print(f"Silver root     : {silver_root}")
print(f"Gold root       : {gold_root}")
print(f"Lookback days   : {lookback_days}")
print(f"Keyword window  : {keyword_window}")

# COMMAND ----------

# ── Load silver data for the rolling window ──────────────────────────────────
# We load `lookback_days` of silver data so rolling-window aggregations
# have enough history. We don't load the entire dataset — partitioned by date dir.

window_start = run_date - timedelta(days=lookback_days - 1)

# Build list of date strings for the window
date_range = [
    (window_start + timedelta(days=i)).isoformat()
    for i in range(lookback_days)
]

print(f"Loading silver for dates: {date_range[0]} → {date_range[-1]}")

# Read silver JSON files for all categories × all dates in window
# Pattern: {silver_root}/{category}/{date}/*.json
# categories driven by widget parameter above — not hardcoded here

silver_dfs = []
for cat in categories:
    for d in date_range:
        path = f"{silver_root}/{cat}/{d}/"
        try:
            df = spark.read.json(path)
            df = df.withColumn("_category", F.lit(cat)).withColumn("_date", F.lit(d))
            silver_dfs.append(df)
        except Exception as e:
            # Path may not exist for some category/date combos — skip silently
            print(f"  Skipping {cat}/{d}: {str(e)[:80]}")

if not silver_dfs:
    print("No silver data found in window — exiting")
    dbutils.notebook.exit("NO_DATA")

silver = silver_dfs[0]
for df in silver_dfs[1:]:
    silver = silver.unionByName(df, allowMissingColumns=True)

# Normalise column names — silver schema may vary slightly across dates
silver = silver.select(
    F.col("id"),
    F.col("category").alias("category"),
    F.col("_date").alias("article_date"),
    F.col("published_at"),
    F.col("sentiment.label").alias("sentiment_label"),
    F.col("sentiment.scores.positive").cast(DoubleType()).alias("sentiment_positive"),
    F.col("sentiment.scores.negative").cast(DoubleType()).alias("sentiment_negative"),
    F.col("sentiment.scores.neutral").cast(DoubleType()).alias("sentiment_neutral"),
    F.col("entities"),
    F.col("keyPhrases"),
    F.col("nlpStatus"),
).filter(F.col("nlpStatus") == "ok")  # only use successfully enriched articles

total_articles = silver.count()
print(f"Total articles loaded (nlpStatus=ok): {total_articles}")

# COMMAND ----------

# ── Gold 1: Sentiment Trends by Category (daily, rolling 7-day) ─────────────
#
# Output schema:
#   run_date | category | article_date | article_count
#   | avg_positive | avg_negative | avg_neutral | dominant_sentiment

sentiment_trends = (
    silver
    .groupBy("category", "article_date")
    .agg(
        F.count("id").alias("article_count"),
        F.round(F.avg("sentiment_positive"), 4).alias("avg_positive"),
        F.round(F.avg("sentiment_negative"), 4).alias("avg_negative"),
        F.round(F.avg("sentiment_neutral"),  4).alias("avg_neutral"),
    )
    .withColumn(
        "dominant_sentiment",
        F.when(F.col("avg_positive") >= F.col("avg_negative"), "positive")
         .when(F.col("avg_negative") > F.col("avg_neutral"), "negative")
         .otherwise("neutral")
    )
    .withColumn("run_date", F.lit(run_date_str))
    .orderBy("category", "article_date")
)

sentiment_out = f"{gold_root}/sentiment_trends/{run_date_str}"
(
    sentiment_trends.write
    .mode("overwrite")                         # idempotent: REPLACE WHERE this date
    .json(sentiment_out)
)
print(f"Sentiment trends written → {sentiment_out} ({sentiment_trends.count()} rows)")

# COMMAND ----------

# ── Gold 2: Top Entities per Category per Week ───────────────────────────────
#
# Explode entities array, count occurrences, rank top 20 per category.
# Output schema:
#   run_date | category | entity_text | entity_count | rank

# Silver stores entities as array of structs {text, category, confidenceScore}
# Handle both struct and plain-string formats defensively

entities_flat = (
    silver
    .filter(F.col("entities").isNotNull())
    .select("id", "category", "article_date", F.explode("entities").alias("entity"))
    .withColumn(
        "entity_text",
        # If entity is a struct with a `text` field, extract it; otherwise use as-is
        F.when(F.col("entity.text").isNotNull(), F.col("entity.text"))
         .otherwise(F.col("entity").cast(StringType()))
    )
    .filter(F.col("entity_text").isNotNull() & (F.length(F.col("entity_text")) > 1))
)

entity_counts = (
    entities_flat
    .groupBy("category", "entity_text")
    .agg(F.count("id").alias("entity_count"))
)

window_spec = Window.partitionBy("category").orderBy(F.desc("entity_count"))
top_entities = (
    entity_counts
    .withColumn("rank", F.row_number().over(window_spec))
    .filter(F.col("rank") <= 20)
    .withColumn("run_date", F.lit(run_date_str))
    .orderBy("category", "rank")
)

entities_out = f"{gold_root}/top_entities/{run_date_str}"
(
    top_entities.write
    .mode("overwrite")
    .json(entities_out)
)
print(f"Top entities written → {entities_out} ({top_entities.count()} rows)")

# COMMAND ----------

# ── Gold 3: Trending Keywords (rolling 3-day window) ────────────────────────
#
# Explode keyPhrases, count within the keyword_window, compare to prior window
# to surface phrases that are rising. Output the top 30 per category.
#
# Output schema:
#   run_date | category | key_phrase | count_current | count_prior | trend_score | rank

# Current window: last keyword_window days (includes run_date)
kw_cutoff_current = (run_date - timedelta(days=keyword_window - 1)).isoformat()

# Prior window: the keyword_window days before that
kw_cutoff_prior_end   = (run_date - timedelta(days=keyword_window)).isoformat()
kw_cutoff_prior_start = (run_date - timedelta(days=keyword_window * 2 - 1)).isoformat()

phrases_flat = (
    silver
    .filter(F.col("keyPhrases").isNotNull())
    .select("id", "category", "article_date", F.explode("keyPhrases").alias("key_phrase"))
    .filter(F.col("key_phrase").isNotNull() & (F.length(F.col("key_phrase")) > 2))
    .withColumn("key_phrase", F.lower(F.trim(F.col("key_phrase"))))  # normalise
)

# Current window counts
current_counts = (
    phrases_flat
    .filter(F.col("article_date") >= kw_cutoff_current)
    .groupBy("category", "key_phrase")
    .agg(F.count("id").alias("count_current"))
)

# Prior window counts
prior_counts = (
    phrases_flat
    .filter(
        (F.col("article_date") >= kw_cutoff_prior_start) &
        (F.col("article_date") <= kw_cutoff_prior_end)
    )
    .groupBy("category", "key_phrase")
    .agg(F.count("id").alias("count_prior"))
)

# Join and compute trend score = current / (prior + 1)  (avoid div-by-zero)
trending = (
    current_counts
    .join(prior_counts, on=["category", "key_phrase"], how="left")
    .fillna({"count_prior": 0})
    .withColumn(
        "trend_score",
        F.round(F.col("count_current") / (F.col("count_prior") + 1), 4)
    )
)

kw_window_spec = Window.partitionBy("category").orderBy(F.desc("trend_score"), F.desc("count_current"))
trending_keywords = (
    trending
    .withColumn("rank", F.row_number().over(kw_window_spec))
    .filter(F.col("rank") <= 30)
    .withColumn("run_date", F.lit(run_date_str))
    .orderBy("category", "rank")
)

keywords_out = f"{gold_root}/trending_keywords/{run_date_str}"
(
    trending_keywords.write
    .mode("overwrite")
    .json(keywords_out)
)
print(f"Trending keywords written → {keywords_out} ({trending_keywords.count()} rows)")

# COMMAND ----------

# ── Summary ──────────────────────────────────────────────────────────────────
summary = {
    "run_date":         run_date_str,
    "silver_articles":  total_articles,
    "sentiment_rows":   sentiment_trends.count(),
    "entity_rows":      top_entities.count(),
    "keyword_rows":     trending_keywords.count(),
    "outputs": {
        "sentiment_trends":  sentiment_out,
        "top_entities":      entities_out,
        "trending_keywords": keywords_out,
    }
}

print("\n── Gold aggregation complete ──────────────────────────────────────────")
for k, v in summary.items():
    print(f"  {k}: {v}")

dbutils.notebook.exit(str(summary))