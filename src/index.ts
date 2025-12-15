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
