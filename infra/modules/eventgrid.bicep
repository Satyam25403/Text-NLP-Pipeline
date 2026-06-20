// eventgrid.bicep
// Creates two Event Grid subscriptions on the storage account system topic:
//   1. BlobCreated → fn-nlp-trigger  (dedup check → enqueue for enrichment)
//   2. BlobCreated → fn-audit-logger (immutable audit record)
//
// Both subscriptions filter to the articles-bronze container only.
// Fan-out to two independent functions means one failure doesn't affect the other.
//
// DEPENDENCY ORDER:
//   Deploy storage.bicep first (creates the system topic).
//   Deploy functions.bicep first (Function App must exist for webhook endpoint).
//   Then deploy this file.

@description('Event Grid system topic name — output from storage.bicep')
param eventGridTopicName string

@description('Function App hostname — output from functions.bicep')
param functionAppHostname string

@description('Function key for fn-nlp-trigger (from Function App → App keys)')
@secure()
param nlpTriggerFunctionKey string

@description('Function key for fn-audit-logger (from Function App → App keys)')
@secure()
param auditLoggerFunctionKey string

@description('Bronze container name to filter events on')
param bronzeContainerName string = 'articles-bronze'

// ── Reference the existing system topic (created in storage.bicep) ────────────

resource eventGridTopic 'Microsoft.EventGrid/systemTopics@2022-06-15' existing = {
  name: eventGridTopicName
}

// ── Subscription 1: BlobCreated → fn-nlp-trigger ─────────────────────────────

resource nlpTriggerSubscription 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2022-06-15' = {
  parent: eventGridTopic
  name:   'sub-nlp-trigger'
  properties: {
    destination: {
      endpointType: 'WebHook'
      properties: {
        endpointUrl: 'https://${functionAppHostname}/runtime/webhooks/EventGrid?functionName=fn-nlp-trigger&code=${nlpTriggerFunctionKey}'
        maxEventsPerBatch:       1     // one blob = one invocation = one article
        preferredBatchSizeInKilobytes: 64
      }
    }
    filter: {
      includedEventTypes: ['Microsoft.Storage.BlobCreated']
      subjectBeginsWith:  '/blobServices/default/containers/${bronzeContainerName}/'
      subjectEndsWith:    '.json'
      enableAdvancedFilteringOnArrays: true
    }
    eventDeliverySchema: 'EventGridSchema'
    retryPolicy: {
      maxDeliveryAttempts:      30
      eventTimeToLiveInMinutes: 1440    // 24h — after this, dead-lettered
    }
  }
}

// ── Subscription 2: BlobCreated → fn-audit-logger ────────────────────────────

resource auditLoggerSubscription 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2022-06-15' = {
  parent: eventGridTopic
  name:   'sub-audit-logger'
  properties: {
    destination: {
      endpointType: 'WebHook'
      properties: {
        endpointUrl: 'https://${functionAppHostname}/runtime/webhooks/EventGrid?functionName=fn-audit-logger&code=${auditLoggerFunctionKey}'
        maxEventsPerBatch:       1
        preferredBatchSizeInKilobytes: 64
      }
    }
    filter: {
      includedEventTypes: ['Microsoft.Storage.BlobCreated']
      subjectBeginsWith:  '/blobServices/default/containers/${bronzeContainerName}/'
      subjectEndsWith:    '.json'
      enableAdvancedFilteringOnArrays: true
    }
    eventDeliverySchema: 'EventGridSchema'
    retryPolicy: {
      maxDeliveryAttempts:      30
      eventTimeToLiveInMinutes: 1440
    }
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────────

@description('NLP trigger subscription name')
output nlpTriggerSubscriptionName string = nlpTriggerSubscription.name

@description('Audit logger subscription name')
output auditLoggerSubscriptionName string = auditLoggerSubscription.name