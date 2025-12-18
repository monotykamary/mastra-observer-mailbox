/**
 * Injection and Trigger Filters
 *
 * Composable filter functions for controlling when observer context
 * is injected and when observers are triggered.
 */

import type {
  InjectionFilterFn,
  InjectionFilterInput,
  TriggerFilterFn,
  TriggerFilterInput,
  PromptMessage,
} from "../types.ts";
import type { FailureDetector } from "../failure-detection.ts";
import { createDefaultFailureDetector } from "../failure-detection.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Injection Filters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Factory functions for creating injection filters.
 * These determine WHEN to inject observer context into prompts.
 */
export const InjectionFilters = {
  /**
   * Always inject observer context.
   */
  always: (): InjectionFilterFn => () => true,

  /**
   * Never inject observer context.
   */
  never: (): InjectionFilterFn => () => false,

  /**
   * Only inject if the last message is from a user.
   */
  userInputOnly: (): InjectionFilterFn => ({ messages }) => {
    if (messages.length === 0) return false;
    const lastMessage = messages[messages.length - 1];
    return lastMessage?.role === "user";
  },

  /**
   * Only inject on every N steps.
   */
  everyNSteps: (n: number): InjectionFilterFn => ({ step }) => step % n === 0,

  /**
   * Only inject after a specific step number.
   */
  afterStep: (minStep: number): InjectionFilterFn => ({ step }) =>
    step > minStep,

  /**
   * Only inject on the first N steps.
   */
  firstNSteps: (n: number): InjectionFilterFn => ({ step }) => step <= n,

  /**
   * Only inject if there's at least one user message.
   */
  hasUserMessage: (): InjectionFilterFn => ({ messages }) =>
    messages.some((m) => m.role === "user"),

  /**
   * Only inject after minimum conversation turns.
   */
  minTurns: (count: number): InjectionFilterFn => ({ messages }) => {
    const userMessages = messages.filter((m) => m.role === "user");
    return userMessages.length >= count;
  },

  /**
   * Only inject if conversation contains certain keywords.
   */
  conversationContains:
    (...keywords: string[]): InjectionFilterFn =>
    ({ messages }) => {
      const text = messages.map((m) => m.content).join(" ").toLowerCase();
      return keywords.some((k) => text.includes(k.toLowerCase()));
    },

  /**
   * Combine multiple filters with AND logic.
   */
  allOf:
    (...filters: InjectionFilterFn[]): InjectionFilterFn =>
    (input) =>
      filters.every((f) => f(input)),

  /**
   * Combine multiple filters with OR logic.
   */
  anyOf:
    (...filters: InjectionFilterFn[]): InjectionFilterFn =>
    (input) =>
      filters.some((f) => f(input)),

  /**
   * Negate a filter.
   */
  not:
    (filter: InjectionFilterFn): InjectionFilterFn =>
    (input) =>
      !filter(input),

  /**
   * Use a custom filter function.
   */
  custom: (fn: InjectionFilterFn): InjectionFilterFn => fn,
};

// ─────────────────────────────────────────────────────────────────────────────
// Trigger Filters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Factory functions for creating trigger filters.
 * These determine WHEN to dispatch to observers after generation.
 */
export const TriggerFilters = {
  /**
   * Always trigger observers.
   */
  everyStep: (): TriggerFilterFn => () => true,

  /**
   * Never trigger observers.
   */
  never: (): TriggerFilterFn => () => false,

  /**
   * Trigger when any tool calls are present.
   */
  onToolCall: (): TriggerFilterFn => ({ response }) =>
    (response.toolCalls?.length ?? 0) > 0,

  /**
   * Trigger for specific tool names.
   */
  onToolNames:
    (...names: string[]): TriggerFilterFn =>
    ({ response }) =>
      response.toolCalls?.some((tc) => names.includes(tc.name)) ?? false,

  /**
   * Trigger when tool results contain errors.
   */
  onToolError: (): TriggerFilterFn => ({ response }) =>
    response.toolResults?.some((tr) =>
      String(tr.result).toLowerCase().includes("error")
    ) ?? false,

  /**
   * Trigger when a failure is detected.
   */
  onFailure: (detector?: FailureDetector): TriggerFilterFn => {
    const failureDetector = detector ?? createDefaultFailureDetector();
    return ({ response }) => failureDetector.detect(response).isFailure;
  },

  /**
   * Trigger when response text contains keywords.
   */
  containsKeywords:
    (...keywords: string[]): TriggerFilterFn =>
    ({ response }) => {
      const text = (response.text ?? "").toLowerCase();
      return keywords.some((k) => text.includes(k.toLowerCase()));
    },

  /**
   * Trigger when response exceeds length threshold.
   */
  responseLongerThan:
    (chars: number): TriggerFilterFn =>
    ({ response }) =>
      (response.text?.length ?? 0) > chars,

  /**
   * Trigger based on step number from snapshot.
   */
  onStep:
    (predicate: (step: number) => boolean): TriggerFilterFn =>
    ({ snapshot }) =>
      predicate(snapshot.stepNumber),

  /**
   * Combine multiple filters with AND logic.
   */
  allOf:
    (...filters: TriggerFilterFn[]): TriggerFilterFn =>
    (input) =>
      filters.every((f) => f(input)),

  /**
   * Combine multiple filters with OR logic.
   */
  anyOf:
    (...filters: TriggerFilterFn[]): TriggerFilterFn =>
    (input) =>
      filters.some((f) => f(input)),

  /**
   * Negate a filter.
   */
  not:
    (filter: TriggerFilterFn): TriggerFilterFn =>
    (input) =>
      !filter(input),

  /**
   * Use a custom filter function.
   */
  custom: (fn: TriggerFilterFn): TriggerFilterFn => fn,
};
