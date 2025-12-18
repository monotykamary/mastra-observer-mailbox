/**
 * Observer Context Factory
 *
 * Creates a context object bound to a specific thread with methods
 * for input processing, output processing, and step management.
 */

import type {
  ObserverContext,
  ObserverContextConfig,
  PendingContextResult,
  GetPendingContextOptions,
  CreateSnapshotOptions,
  DispatchOptions,
  PromptMessage,
  StepSnapshot,
  MessageId,
  StepNumber,
  InjectionTarget,
  InjectionConfig,
} from "../types.ts";
import { DEFAULT_INJECTION_CONFIG } from "../types.ts";
import {
  formatMessagesForInjection,
  injectIntoPrompt,
} from "./injection.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONTEXT_CONFIG = {
  autoIncrementStep: false,
  initialStep: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an observer context bound to a specific thread.
 *
 * The context provides methods for:
 * - Input processing: getPendingContext(), injectContext()
 * - Output processing: markIncorporated(), createSnapshot(), dispatchToObservers()
 * - Step management: nextStep(), setStep(), gc()
 *
 * @example
 * ```typescript
 * const ctx = createObserverContext({
 *   store,
 *   threadId: 'thread-123',
 *   autoIncrementStep: false,
 * });
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
export function createObserverContext(
  config: ObserverContextConfig
): ObserverContext {
  const {
    store,
    threadId,
    autoIncrementStep = DEFAULT_CONTEXT_CONFIG.autoIncrementStep,
    initialStep = DEFAULT_CONTEXT_CONFIG.initialStep,
    injection,
  } = config;

  // Merge injection config with defaults
  const injectionConfig: InjectionConfig = {
    ...DEFAULT_INJECTION_CONFIG,
    ...injection,
  };

  // Mutable state
  let currentStep: StepNumber = initialStep;

  // ─────────────────────────────────────────────────────────────────────────
  // Input Processing
  // ─────────────────────────────────────────────────────────────────────────

  function getPendingContext(
    opts?: GetPendingContextOptions
  ): PendingContextResult {
    // Auto-increment step if configured
    if (autoIncrementStep) {
      currentStep++;
    }

    // Query pending messages from store
    const messages = store.query(threadId, {
      status: "pending",
      minConfidence: opts?.minConfidence ?? injectionConfig.minConfidence,
      limit: opts?.maxMessages ?? injectionConfig.maxMessagesPerTurn,
      types: opts?.types,
    });

    // Format messages for injection
    const formattedContext =
      messages.length > 0 ? formatMessagesForInjection(messages) : "";

    // Extract message IDs
    const messageIds = messages.map((m) => m.id);

    return {
      messages,
      formattedContext,
      messageIds,
    };
  }

  function injectContext(
    messages: PromptMessage[],
    formattedContext: string,
    target?: InjectionTarget
  ): PromptMessage[] {
    if (!formattedContext) {
      return messages;
    }
    return injectIntoPrompt(
      messages,
      formattedContext,
      target ?? injectionConfig.target
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Output Processing
  // ─────────────────────────────────────────────────────────────────────────

  function markIncorporated(messageIds: MessageId[]): void {
    if (messageIds.length > 0) {
      store.markIncorporated(messageIds, currentStep);
    }
  }

  function createSnapshot(
    originalPrompt: PromptMessage[],
    response: StepSnapshot["response"],
    opts?: CreateSnapshotOptions
  ): StepSnapshot {
    return {
      threadId,
      stepNumber: currentStep,
      timestamp: Date.now(),
      promptMessages: originalPrompt,
      workingMemory: opts?.workingMemory ?? {},
      response,
      incorporatedMessageIds: [],
    };
  }

  async function dispatchToObservers(
    snapshot: StepSnapshot,
    handler: (snapshot: StepSnapshot) => void | Promise<void>,
    opts?: DispatchOptions
  ): Promise<void> {
    const shouldAwait = opts?.await ?? false;
    const maxRetries = opts?.maxRetries ?? 0;
    const baseDelayMs = opts?.retryDelayMs ?? 100;

    const execute = async (): Promise<void> => {
      let lastError: Error | null = null;
      let attempts = 0;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        attempts = attempt + 1;
        try {
          await Promise.resolve(handler(snapshot));
          return; // Success
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err));

          if (attempt < maxRetries) {
            const delay = baseDelayMs * Math.pow(2, attempt);
            await sleep(delay);
          }
        }
      }

      // All retries exhausted
      if (lastError) {
        if (opts?.onError) {
          opts.onError(lastError, snapshot, attempts);
        } else {
          console.error(
            `[ObserverContext] Dispatch failed after ${attempts} attempt(s):`,
            lastError
          );
        }
      }
    };

    if (shouldAwait) {
      await execute();
    } else {
      // Fire and forget
      execute().catch(() => {
        // Error already handled in execute()
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step Management
  // ─────────────────────────────────────────────────────────────────────────

  function nextStep(): StepNumber {
    currentStep++;
    return currentStep;
  }

  function setStep(step: StepNumber): void {
    currentStep = step;
  }

  function gc(): void {
    store.gc(threadId, currentStep);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Return Context Object
  // ─────────────────────────────────────────────────────────────────────────

  return {
    get threadId() {
      return threadId;
    },
    get currentStep() {
      return currentStep;
    },
    get store() {
      return store;
    },

    // Input processing
    getPendingContext,
    injectContext,

    // Output processing
    markIncorporated,
    createSnapshot,
    dispatchToObservers,

    // Step management
    nextStep,
    setStep,
    gc,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
