/**
 * Injection Utilities
 *
 * Functions for formatting observer messages and injecting them into prompts.
 */

import type {
  MailboxMessage,
  PromptMessage,
  InjectionTarget,
} from "../types.ts";
import { sanitizeContent } from "../sanitization.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format mailbox messages for injection into prompts.
 * Content is sanitized by default to prevent prompt injection attacks.
 *
 * @example
 * Output format:
 * ```
 * <observer-context>
 *
 * [INSIGHT confidence=85%]
 * The user mentioned "cheapest" - prioritize budget airlines...
 *
 * [WARNING confidence=70%]
 * Previous search timed out, consider retry...
 *
 * </observer-context>
 * ```
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

// ─────────────────────────────────────────────────────────────────────────────
// Injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inject observer context into a prompt at the specified target.
 *
 * Injection targets:
 * - "system-prompt": Append to the system message
 * - "user-message": Insert before the last user message
 * - "end-of-history": Insert before the last message (cache-friendly)
 *
 * @param messages - The original prompt messages
 * @param observerContext - Formatted observer context string
 * @param target - Where to inject the context
 * @returns New array with injected context
 */
export function injectIntoPrompt(
  messages: PromptMessage[],
  observerContext: string,
  target: InjectionTarget
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
// Convenience Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format and inject observer messages in one call.
 *
 * @param promptMessages - The original prompt messages
 * @param observerMessages - Messages from the mailbox to inject
 * @param target - Where to inject the context
 * @param options - Formatting options
 * @returns New array with injected context
 */
export function injectObserverMessages(
  promptMessages: PromptMessage[],
  observerMessages: MailboxMessage[],
  target: InjectionTarget = "end-of-history",
  options?: { sanitize?: boolean }
): PromptMessage[] {
  const formattedContext = formatMessagesForInjection(observerMessages, options);
  return injectIntoPrompt(promptMessages, formattedContext, target);
}
