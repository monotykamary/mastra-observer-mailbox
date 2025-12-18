/**
 * Observer Middleware Implementation
 *
 * Middleware that injects observer messages into prompts and triggers
 * observer analysis after each step.
 */

import type {
  MailboxStore,
  MailboxMessage,
  StepSnapshot,
  PromptMessage,
  ThreadId,
  StepNumber,
  MessageId,
  InjectionConfig,
  TriggerConfig,
  ObserverMiddlewareConfig,
  TriggerMode,
} from "./types.ts";
import {
  DEFAULT_INJECTION_CONFIG,
  DEFAULT_TRIGGER_CONFIG,
} from "./types.ts";
import type { FailureDetector, ResponseSnapshot } from "./failure-detection.ts";
import { createDefaultFailureDetector } from "./failure-detection.ts";
import { sanitizeContent } from "./sanitization.ts";
import type { ObserverRegistry } from "./observer-registry.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Injection Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format messages for injection into prompts.
 * Content is sanitized to prevent prompt injection attacks.
 */
export function formatMessagesForInjection(
  messages: MailboxMessage[],
  options?: { sanitize?: boolean }
): string {
  if (messages.length === 0) return "";

  const shouldSanitize = options?.sanitize ?? true;

  const formatted = messages.map((m) => {
    const typeLabel = m.type.toUpperCase();
    const confidenceStr = (m.confidence * 100).toFixed(0);
    const content = shouldSanitize ? sanitizeContent(m.content) : m.content;
    return `[${typeLabel} confidence=${confidenceStr}%]\n${content}`;
  });

  return `<observer-context>\n\n${formatted.join("\n\n")}\n\n</observer-context>`;
}

/**
 * Inject observer context into a prompt based on the injection target.
 */
export function injectIntoPrompt(
  messages: PromptMessage[],
  observerContext: string,
  target: InjectionConfig["target"]
): PromptMessage[] {
  if (!observerContext) return messages;

  const result = [...messages];

  switch (target) {
    case "system-prompt": {
      // Append to the system message
      const systemIdx = result.findIndex((m) => m.role === "system");
      if (systemIdx !== -1) {
        const systemMsg = result[systemIdx]!;
        result[systemIdx] = {
          ...systemMsg,
          content: `${systemMsg.content}\n\n${observerContext}`,
        };
      } else {
        // No system message, prepend as new system message
        result.unshift({
          role: "system",
          content: observerContext,
        });
      }
      break;
    }

    case "user-message": {
      // Insert as a synthetic user message before the last user message
      const lastUserIdx = result.findLastIndex((m) => m.role === "user");
      if (lastUserIdx !== -1) {
        result.splice(lastUserIdx, 0, {
          role: "user",
          content: `[Observer Notes]\n${observerContext}`,
        });
      } else {
        // No user message, append at end
        result.push({
          role: "user",
          content: `[Observer Notes]\n${observerContext}`,
        });
      }
      break;
    }

    case "end-of-history":
    default: {
      // Insert before the last message (cache-friendly position)
      if (result.length > 0) {
        result.splice(result.length - 1, 0, {
          role: "user",
          content: `[Observer Context]\n${observerContext}`,
        });
      } else {
        result.push({
          role: "user",
          content: `[Observer Context]\n${observerContext}`,
        });
      }
      break;
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * State tracked per thread during a step.
 */
interface StepState {
  threadId: ThreadId;
  stepNumber: StepNumber;
  pendingMessageIds: MessageId[];
  originalPrompt: PromptMessage[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Observer Middleware Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Middleware that provides bidirectional communication between
 * main agents and observer agents.
 *
 * Usage:
 * ```typescript
 * const middleware = new ObserverMiddleware({
 *   store,
 *   injection: { target: 'end-of-history', maxMessagesPerTurn: 3, minConfidence: 0.6 },
 *   trigger: { mode: 'every-step', async: true },
 *   onTrigger: async (snapshot) => {
 *     // Run your observer agent here
 *     const insight = await observerAgent.analyze(snapshot);
 *     store.send({ ...insight });
 *   },
 * });
 * ```
 */
export class ObserverMiddleware {
  private store: MailboxStore;
  private injection: InjectionConfig;
  private trigger: TriggerConfig;
  private onTrigger?: (snapshot: StepSnapshot) => void | Promise<void>;
  private registry?: ObserverRegistry;
  private failureDetector: FailureDetector | null = null;

  // Track current step state
  private stepStates = new Map<ThreadId, StepState>();

  constructor(config: ObserverMiddlewareConfig) {
    this.store = config.store;
    this.injection = { ...DEFAULT_INJECTION_CONFIG, ...config.injection };
    this.trigger = { ...DEFAULT_TRIGGER_CONFIG, ...config.trigger };
    this.onTrigger = config.onTrigger;
    this.registry = config.registry;

    // Store custom failure detector if provided (lazy init default)
    if (config.trigger?.failureDetector) {
      this.failureDetector = config.trigger.failureDetector;
    }
  }

  /**
   * Get or create the failure detector (lazy initialization)
   */
  private getFailureDetector(): FailureDetector {
    if (!this.failureDetector) {
      this.failureDetector = createDefaultFailureDetector();
    }
    return this.failureDetector;
  }

  /**
   * Execute observers (either via registry or single onTrigger) with retry logic.
   */
  private async executeObservers(snapshot: StepSnapshot): Promise<void> {
    const maxRetries = this.trigger.maxRetries ?? 0;
    const baseDelayMs = this.trigger.retryDelayMs ?? 100;
    const onError = this.trigger.onError;

    let lastError: Error | null = null;
    let attempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts = attempt + 1;
      try {
        // Use registry if available, otherwise use onTrigger
        if (this.registry) {
          await this.registry.dispatch(snapshot);
        } else if (this.onTrigger) {
          await Promise.resolve(this.onTrigger(snapshot));
        }
        return; // Success
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // If we have more retries, wait with exponential backoff
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted
    if (lastError) {
      if (onError) {
        // Use custom error handler
        onError(lastError, snapshot, attempts);
      } else {
        // Fallback to console.error for backward compatibility
        console.error(
          `[ObserverMiddleware] Trigger failed after ${attempts} attempt(s):`,
          lastError
        );
      }
    }
  }

  /**
   * Sleep for a given number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Transform params before LLM call.
   * Queries pending messages and injects them into the prompt.
   */
  transformParams(
    threadId: ThreadId,
    stepNumber: StepNumber,
    prompt: PromptMessage[]
  ): PromptMessage[] {
    // Query pending messages
    const pending = this.store.query(threadId, {
      status: "pending",
      minConfidence: this.injection.minConfidence,
      limit: this.injection.maxMessagesPerTurn,
    });

    // Store state for later
    this.stepStates.set(threadId, {
      threadId,
      stepNumber,
      pendingMessageIds: pending.map((m) => m.id),
      originalPrompt: prompt,
    });

    // Inject messages if any
    if (pending.length > 0) {
      const observerContext = formatMessagesForInjection(pending);
      return injectIntoPrompt(prompt, observerContext, this.injection.target);
    }

    return prompt;
  }

  /**
   * Process result after LLM call.
   * Marks messages as incorporated, stores snapshot, and triggers observer.
   */
  async afterGenerate(
    threadId: ThreadId,
    response: {
      text?: string;
      toolCalls?: Array<{ name: string; args: unknown }>;
      toolResults?: Array<{ name: string; result: unknown }>;
    },
    workingMemory: Record<string, unknown> = {}
  ): Promise<void> {
    const state = this.stepStates.get(threadId);
    if (!state) return;

    const { stepNumber, pendingMessageIds, originalPrompt } = state;

    // Mark messages as incorporated
    if (pendingMessageIds.length > 0) {
      this.store.markIncorporated(pendingMessageIds, stepNumber);
    }

    // Create snapshot
    const snapshot: StepSnapshot = {
      threadId,
      stepNumber,
      timestamp: Date.now(),
      promptMessages: originalPrompt,
      workingMemory,
      response: {
        text: response.text,
        toolCalls: response.toolCalls,
        toolResults: response.toolResults,
      },
      incorporatedMessageIds: pendingMessageIds,
    };

    // Store snapshot
    this.store.storeSnapshot(snapshot);

    // Determine if we should trigger observer
    const shouldTrigger = this.shouldTrigger(response);

    if (shouldTrigger && (this.onTrigger || this.registry)) {
      if (this.trigger.async) {
        // Fire and forget with error handling
        this.executeObservers(snapshot).catch(() => {
          // Error already handled in executeObservers
        });
      } else {
        // Wait for observer with error handling
        await this.executeObservers(snapshot);
      }
    }

    // Cleanup
    this.store.gc(threadId, stepNumber);
    this.stepStates.delete(threadId);
  }

  /**
   * Determine if observer should be triggered based on mode.
   */
  private shouldTrigger(response: ResponseSnapshot): boolean {
    switch (this.trigger.mode) {
      case "every-step":
        return true;

      case "on-tool-call":
        return (response.toolCalls?.length ?? 0) > 0;

      case "on-failure": {
        // Use configurable failure detector (with negation awareness)
        const detector = this.getFailureDetector();
        const result = detector.detect(response);
        return result.isFailure;
      }

      default:
        return true;
    }
  }

  /**
   * Get the store (useful for sending messages from observer).
   */
  getStore(): MailboxStore {
    return this.store;
  }

  /**
   * Get current configuration.
   */
  getConfig(): { injection: InjectionConfig; trigger: TriggerConfig } {
    return {
      injection: { ...this.injection },
      trigger: { ...this.trigger },
    };
  }

  /**
   * Get the observer registry (if using multi-observer mode).
   */
  getRegistry(): ObserverRegistry | undefined {
    return this.registry;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an observer middleware instance.
 */
export function createObserverMiddleware(
  config: ObserverMiddlewareConfig
): ObserverMiddleware {
  return new ObserverMiddleware(config);
}
