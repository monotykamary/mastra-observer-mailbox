/**
 * Observer Mailbox
 *
 * A hybrid message-oriented store for passive, event-driven communication
 * between AI agents.
 *
 * @example
 * ```typescript
 * import {
 *   InMemoryMailboxStore,
 *   ObserverMiddleware,
 *   createObserverMiddleware,
 * } from 'observer-mailbox';
 *
 * // Create the store
 * const store = new InMemoryMailboxStore({
 *   dedupeWindowSteps: 5,
 *   defaultTtlSteps: 8,
 * });
 *
 * // Create middleware
 * const middleware = createObserverMiddleware({
 *   store,
 *   injection: {
 *     target: 'end-of-history',
 *     maxMessagesPerTurn: 3,
 *     minConfidence: 0.6,
 *   },
 *   trigger: {
 *     mode: 'every-step',
 *     async: true,
 *   },
 *   onTrigger: async (snapshot) => {
 *     // Your observer agent logic here
 *   },
 * });
 * ```
 */

// Types
export type {
  StepNumber,
  AgentId,
  ThreadId,
  MessageId,
  MessageType,
  MailboxMessage,
  SendMessageInput,
  PromptMessage,
  ToolCall,
  ToolResult,
  StepSnapshot,
  MessageStatus,
  QueryOptions,
  MailboxStore,
  MailboxStoreConfig,
  InjectionTarget,
  TriggerMode,
  InjectionConfig,
  TriggerConfig,
  ObserverMiddlewareConfig,
  // Primitives types
  ObserverContext,
  ObserverContextConfig,
  PendingContextResult,
  GetPendingContextOptions,
  CreateSnapshotOptions,
  DispatchOptions,
  InjectionFilterInput,
  TriggerFilterInput,
  InjectionFilterFn,
  TriggerFilterFn,
} from "./types.ts";

// Constants
export {
  DEFAULT_MAILBOX_CONFIG,
  DEFAULT_INJECTION_CONFIG,
  DEFAULT_TRIGGER_CONFIG,
} from "./types.ts";

// Store
export { InMemoryMailboxStore } from "./store.ts";

// Middleware
export {
  ObserverMiddleware,
  createObserverMiddleware,
  formatMessagesForInjection,
  injectIntoPrompt,
} from "./middleware.ts";

// Failure Detection
export type {
  ResponseSnapshot,
  FailureResult,
  FailureDetector,
  KeywordFailureDetectorConfig,
} from "./failure-detection.ts";

export {
  KeywordFailureDetector,
  ToolErrorDetector,
  PredicateFailureDetector,
  CompositeFailureDetector,
  createDefaultFailureDetector,
  createPredicateDetector,
} from "./failure-detection.ts";

// Sanitization
export type {
  ValidationIssue,
  ValidationResult,
  SanitizeOptions,
  ContentSanitizer,
} from "./sanitization.ts";

export {
  defaultSanitizer,
  sanitizeContent,
  validateContent,
  createSanitizer,
  escapeXml,
} from "./sanitization.ts";

// Observer Registry
export type {
  ObserverResult,
  ObserverHandler,
  DispatchResult,
  ObserverRegistryConfig,
} from "./observer-registry.ts";

export {
  ObserverRegistry,
  createObserverRegistry,
  createSimpleObserver,
  createToolCallObserver,
  createKeywordObserver,
} from "./observer-registry.ts";

// Retention Policies
export type {
  RetentionPolicy,
  RetentionResult,
  RetentionManagerConfig,
} from "./retention.ts";

export {
  DEFAULT_RETENTION_POLICIES,
  DEFAULT_RETENTION_CONFIG,
  RetentionManager,
  createRetentionManager,
  applyRetention,
} from "./retention.ts";

// Event Bus
export type {
  BaseEvent,
  MessageSentEvent,
  MessageReadEvent,
  MessageExpiredEvent,
  MessageDedupedEvent,
  MessagesInjectedEvent,
  ObserverTriggeredEvent,
  ObserverCompletedEvent,
  ObserverFailedEvent,
  RetentionAppliedEvent,
  StepCompletedEvent,
  MailboxEvent,
  MailboxEventType,
  EventHandler,
  Unsubscribe,
  EventBusConfig,
  MailboxMetrics,
} from "./event-bus.ts";

export {
  EventBus,
  createEventBus,
  MetricsCollector,
  createMetricsCollector,
  messageSentEvent,
  messageReadEvent,
  observerTriggeredEvent,
  observerCompletedEvent,
  observerFailedEvent,
  stepCompletedEvent,
} from "./event-bus.ts";

// Primitives (composable API)
export {
  createObserverContext,
  InjectionFilters,
  TriggerFilters,
  injectObserverMessages,
} from "./primitives/index.ts";
