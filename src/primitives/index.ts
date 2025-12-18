/**
 * Composable Primitives for Observer Mailbox
 *
 * A Mastra-idiomatic API for observer message injection and output handling.
 *
 * @example
 * ```typescript
 * import {
 *   createObserverContext,
 *   InjectionFilters,
 *   TriggerFilters,
 * } from 'mastra-observer-mailbox/primitives';
 *
 * const ctx = createObserverContext({ store, threadId: 'thread-123' });
 *
 * // In your agent loop:
 * ctx.nextStep();
 * const { formattedContext, messageIds } = ctx.getPendingContext();
 * const enriched = ctx.injectContext(messages, formattedContext);
 *
 * const response = await agent.generate(enriched);
 *
 * ctx.markIncorporated(messageIds);
 * const snapshot = ctx.createSnapshot(messages, response);
 * await ctx.dispatchToObservers(snapshot, myHandler);
 * ctx.gc();
 * ```
 */

// Context factory
export { createObserverContext } from "./context.ts";

// Filters
export { InjectionFilters, TriggerFilters } from "./triggers.ts";

// Injection utilities
export {
  formatMessagesForInjection,
  injectIntoPrompt,
  injectObserverMessages,
} from "./injection.ts";

// Re-export types from main types.ts for convenience
export type {
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
} from "../types.ts";
