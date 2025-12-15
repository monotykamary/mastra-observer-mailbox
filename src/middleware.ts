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

// ─────────────────────────────────────────────────────────────────────────────
// Injection Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format messages for injection into prompts.
 */
export function formatMessagesForInjection(messages: MailboxMessage[]): string {
  if (messages.length === 0) return "";

  const formatted = messages.map((m) => {
    const typeLabel = m.type.toUpperCase();
    const confidenceStr = (m.confidence * 100).toFixed(0);
    return `[${typeLabel} confidence=${confidenceStr}%]\n${m.content}`;
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

  // Track current step state
  private stepStates = new Map<ThreadId, StepState>();

  constructor(config: ObserverMiddlewareConfig) {
    this.store = config.store;
    this.injection = { ...DEFAULT_INJECTION_CONFIG, ...config.injection };
    this.trigger = { ...DEFAULT_TRIGGER_CONFIG, ...config.trigger };
    this.onTrigger = config.onTrigger;
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

    if (shouldTrigger && this.onTrigger) {
      if (this.trigger.async) {
        // Fire and forget
        Promise.resolve(this.onTrigger(snapshot)).catch((err: unknown) => {
          console.error("[ObserverMiddleware] Async trigger error:", err);
        });
      } else {
        // Wait for observer
        await this.onTrigger(snapshot);
      }
    }

    // Cleanup
    this.store.gc(threadId, stepNumber);
    this.stepStates.delete(threadId);
  }

  /**
   * Determine if observer should be triggered based on mode.
   */
  private shouldTrigger(response: {
    text?: string;
    toolCalls?: Array<{ name: string; args: unknown }>;
    toolResults?: Array<{ name: string; result: unknown }>;
  }): boolean {
    switch (this.trigger.mode) {
      case "every-step":
        return true;

      case "on-tool-call":
        return (response.toolCalls?.length ?? 0) > 0;

      case "on-failure":
        // Check for failure indicators in response
        // This is a heuristic - could be customized
        const text = response.text?.toLowerCase() ?? "";
        const hasError =
          text.includes("error") ||
          text.includes("failed") ||
          text.includes("unable to") ||
          text.includes("cannot");
        return hasError;

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
