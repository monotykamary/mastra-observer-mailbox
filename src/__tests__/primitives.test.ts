/**
 * Primitives Unit Tests
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { InMemoryMailboxStore } from "../store.ts";
import {
  createObserverContext,
  InjectionFilters,
  TriggerFilters,
  formatMessagesForInjection,
  injectIntoPrompt,
  injectObserverMessages,
} from "../primitives/index.ts";
import type { PromptMessage, MailboxMessage, StepSnapshot } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createTestMessage(
  overrides: Partial<MailboxMessage> = {}
): MailboxMessage {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    threadId: "test-thread",
    from: "observer-agent",
    sentAtStep: 1,
    sentAtTime: Date.now(),
    type: "insight",
    content: "Test message content",
    confidence: 0.8,
    incorporatedAtStep: null,
    expiresAtStep: null,
    contentHash: "test-hash",
    ...overrides,
  };
}

function createTestPrompt(): PromptMessage[] {
  return [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello, how are you?" },
    { role: "assistant", content: "I'm doing well, thank you!" },
    { role: "user", content: "Can you help me with something?" },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// createObserverContext Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("createObserverContext", () => {
  let store: InMemoryMailboxStore;

  beforeEach(() => {
    store = new InMemoryMailboxStore();
  });

  it("should create a context with the correct threadId", () => {
    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
    });

    expect(ctx.threadId).toBe("test-thread");
    expect(ctx.currentStep).toBe(0);
  });

  it("should start at initialStep if provided", () => {
    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
      initialStep: 5,
    });

    expect(ctx.currentStep).toBe(5);
  });

  it("should increment step with nextStep()", () => {
    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
    });

    expect(ctx.currentStep).toBe(0);
    expect(ctx.nextStep()).toBe(1);
    expect(ctx.currentStep).toBe(1);
    expect(ctx.nextStep()).toBe(2);
    expect(ctx.currentStep).toBe(2);
  });

  it("should allow setting step explicitly", () => {
    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
    });

    ctx.setStep(10);
    expect(ctx.currentStep).toBe(10);
  });

  it("should auto-increment step if configured", () => {
    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
      autoIncrementStep: true,
    });

    expect(ctx.currentStep).toBe(0);
    ctx.getPendingContext();
    expect(ctx.currentStep).toBe(1);
    ctx.getPendingContext();
    expect(ctx.currentStep).toBe(2);
  });

  it("should query pending messages from store", () => {
    // Add a message to the store
    store.send({
      threadId: "test-thread",
      from: "observer",
      sentAtStep: 1,
      sentAtTime: Date.now(),
      type: "insight",
      content: "You should try X",
      confidence: 0.8,
      expiresAtStep: null,
    });

    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
    });

    const result = ctx.getPendingContext();
    expect(result.messages.length).toBe(1);
    expect(result.messageIds.length).toBe(1);
    expect(result.formattedContext).toContain("INSIGHT");
    expect(result.formattedContext).toContain("You should try X");
  });

  it("should return empty context when no pending messages", () => {
    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
    });

    const result = ctx.getPendingContext();
    expect(result.messages.length).toBe(0);
    expect(result.messageIds.length).toBe(0);
    expect(result.formattedContext).toBe("");
  });

  it("should inject context into messages", () => {
    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
    });

    const prompt = createTestPrompt();
    const formattedContext = "<observer-context>Test</observer-context>";
    const enriched = ctx.injectContext(prompt, formattedContext);

    expect(enriched.length).toBe(prompt.length + 1);
    expect(enriched.some((m) => m.content.includes("Test"))).toBe(true);
  });

  it("should not inject if formattedContext is empty", () => {
    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
    });

    const prompt = createTestPrompt();
    const enriched = ctx.injectContext(prompt, "");

    expect(enriched.length).toBe(prompt.length);
  });

  it("should mark messages as incorporated", () => {
    store.send({
      threadId: "test-thread",
      from: "observer",
      sentAtStep: 1,
      sentAtTime: Date.now(),
      type: "insight",
      content: "Test",
      confidence: 0.8,
      expiresAtStep: null,
    });

    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
    });

    ctx.nextStep();
    const { messageIds } = ctx.getPendingContext();
    ctx.markIncorporated(messageIds);

    // Query again - should be empty since messages are incorporated
    const result = store.query("test-thread", { status: "pending" });
    expect(result.length).toBe(0);
  });

  it("should create snapshots correctly", () => {
    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
    });

    ctx.nextStep();
    const prompt = createTestPrompt();
    const response = { text: "I can help you!" };

    const snapshot = ctx.createSnapshot(prompt, response, {
      workingMemory: { progress: 50 },
    });

    expect(snapshot.threadId).toBe("test-thread");
    expect(snapshot.stepNumber).toBe(1);
    expect(snapshot.promptMessages).toEqual(prompt);
    expect(snapshot.response.text).toBe("I can help you!");
    expect(snapshot.workingMemory.progress).toBe(50);
  });

  it("should dispatch to observers", async () => {
    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
    });

    const handler = mock((snapshot: StepSnapshot) => {
      expect(snapshot.threadId).toBe("test-thread");
    });

    const snapshot = ctx.createSnapshot([], { text: "test" });
    await ctx.dispatchToObservers(snapshot, handler, { await: true });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should run garbage collection", () => {
    const ctx = createObserverContext({
      store,
      threadId: "test-thread",
    });

    // Add an expired message
    store.send({
      threadId: "test-thread",
      from: "observer",
      sentAtStep: 1,
      sentAtTime: Date.now(),
      type: "insight",
      content: "Old message",
      confidence: 0.8,
      expiresAtStep: 2,
    });

    ctx.setStep(10);
    ctx.gc();

    const remaining = store.query("test-thread", { status: "all" });
    expect(remaining.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// InjectionFilters Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("InjectionFilters", () => {
  const baseInput = {
    messages: createTestPrompt(),
    step: 5,
    threadId: "test-thread",
  };

  it("always() should return true", () => {
    const filter = InjectionFilters.always();
    expect(filter(baseInput)).toBe(true);
  });

  it("never() should return false", () => {
    const filter = InjectionFilters.never();
    expect(filter(baseInput)).toBe(false);
  });

  it("userInputOnly() should check last message role", () => {
    const filter = InjectionFilters.userInputOnly();

    // Last message is user
    expect(filter(baseInput)).toBe(true);

    // Last message is assistant
    const assistantLast = {
      ...baseInput,
      messages: [
        ...baseInput.messages,
        { role: "assistant" as const, content: "Response" },
      ],
    };
    expect(filter(assistantLast)).toBe(false);
  });

  it("everyNSteps() should check step modulo", () => {
    const filter = InjectionFilters.everyNSteps(3);

    expect(filter({ ...baseInput, step: 0 })).toBe(true);
    expect(filter({ ...baseInput, step: 1 })).toBe(false);
    expect(filter({ ...baseInput, step: 2 })).toBe(false);
    expect(filter({ ...baseInput, step: 3 })).toBe(true);
    expect(filter({ ...baseInput, step: 6 })).toBe(true);
  });

  it("afterStep() should check minimum step", () => {
    const filter = InjectionFilters.afterStep(3);

    expect(filter({ ...baseInput, step: 2 })).toBe(false);
    expect(filter({ ...baseInput, step: 3 })).toBe(false);
    expect(filter({ ...baseInput, step: 4 })).toBe(true);
  });

  it("minTurns() should count user messages", () => {
    const filter = InjectionFilters.minTurns(2);

    expect(filter(baseInput)).toBe(true); // 2 user messages

    const oneTurn = {
      ...baseInput,
      messages: [{ role: "user" as const, content: "Hi" }],
    };
    expect(filter(oneTurn)).toBe(false);
  });

  it("allOf() should AND filters together", () => {
    const filter = InjectionFilters.allOf(
      InjectionFilters.always(),
      InjectionFilters.afterStep(3)
    );

    expect(filter({ ...baseInput, step: 2 })).toBe(false);
    expect(filter({ ...baseInput, step: 5 })).toBe(true);
  });

  it("anyOf() should OR filters together", () => {
    const filter = InjectionFilters.anyOf(
      InjectionFilters.never(),
      InjectionFilters.afterStep(3)
    );

    expect(filter({ ...baseInput, step: 2 })).toBe(false);
    expect(filter({ ...baseInput, step: 5 })).toBe(true);
  });

  it("not() should negate a filter", () => {
    const filter = InjectionFilters.not(InjectionFilters.always());
    expect(filter(baseInput)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TriggerFilters Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("TriggerFilters", () => {
  const baseInput = {
    snapshot: {
      threadId: "test-thread",
      stepNumber: 5,
      timestamp: Date.now(),
      promptMessages: [],
      workingMemory: {},
      response: { text: "Hello" },
      incorporatedMessageIds: [],
    } as StepSnapshot,
    response: { text: "Hello" },
  };

  it("everyStep() should return true", () => {
    const filter = TriggerFilters.everyStep();
    expect(filter(baseInput)).toBe(true);
  });

  it("never() should return false", () => {
    const filter = TriggerFilters.never();
    expect(filter(baseInput)).toBe(false);
  });

  it("onToolCall() should check for tool calls", () => {
    const filter = TriggerFilters.onToolCall();

    expect(filter(baseInput)).toBe(false);

    const withToolCalls = {
      ...baseInput,
      response: { toolCalls: [{ name: "search", args: {} }] },
    };
    expect(filter(withToolCalls)).toBe(true);
  });

  it("onToolNames() should check for specific tools", () => {
    const filter = TriggerFilters.onToolNames("search", "browse");

    const withSearch = {
      ...baseInput,
      response: { toolCalls: [{ name: "search", args: {} }] },
    };
    expect(filter(withSearch)).toBe(true);

    const withOther = {
      ...baseInput,
      response: { toolCalls: [{ name: "other", args: {} }] },
    };
    expect(filter(withOther)).toBe(false);
  });

  it("containsKeywords() should check response text", () => {
    const filter = TriggerFilters.containsKeywords("error", "failed");

    expect(filter(baseInput)).toBe(false);

    const withError = {
      ...baseInput,
      response: { text: "An error occurred" },
    };
    expect(filter(withError)).toBe(true);
  });

  it("responseLongerThan() should check length", () => {
    const filter = TriggerFilters.responseLongerThan(10);

    const short = { ...baseInput, response: { text: "Hi" } };
    expect(filter(short)).toBe(false);

    const long = {
      ...baseInput,
      response: { text: "This is a longer response" },
    };
    expect(filter(long)).toBe(true);
  });

  it("allOf() should AND filters together", () => {
    const filter = TriggerFilters.allOf(
      TriggerFilters.everyStep(),
      TriggerFilters.containsKeywords("hello")
    );

    // containsKeywords is case-insensitive, so "Hello" matches "hello"
    expect(filter(baseInput)).toBe(true);

    const withoutHello = { ...baseInput, response: { text: "goodbye" } };
    expect(filter(withoutHello)).toBe(false);
  });

  it("anyOf() should OR filters together", () => {
    const filter = TriggerFilters.anyOf(
      TriggerFilters.never(),
      TriggerFilters.containsKeywords("hello")
    );

    const withHello = { ...baseInput, response: { text: "hello" } };
    expect(filter(withHello)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Injection Utilities Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("formatMessagesForInjection", () => {
  it("should format messages with type and confidence", () => {
    const messages = [
      createTestMessage({ type: "insight", confidence: 0.85, content: "Try X" }),
    ];

    const result = formatMessagesForInjection(messages);

    expect(result).toContain("<observer-context>");
    expect(result).toContain("[INSIGHT confidence=85%]");
    expect(result).toContain("Try X");
    expect(result).toContain("</observer-context>");
  });

  it("should return empty string for empty array", () => {
    const result = formatMessagesForInjection([]);
    expect(result).toBe("");
  });

  it("should format multiple messages", () => {
    const messages = [
      createTestMessage({ type: "insight", content: "First" }),
      createTestMessage({ type: "warning", content: "Second" }),
    ];

    const result = formatMessagesForInjection(messages);

    expect(result).toContain("[INSIGHT");
    expect(result).toContain("[WARNING");
    expect(result).toContain("First");
    expect(result).toContain("Second");
  });
});

describe("injectIntoPrompt", () => {
  it("should inject at system-prompt target", () => {
    const prompt = createTestPrompt();
    const context = "<observer-context>Test</observer-context>";

    const result = injectIntoPrompt(prompt, context, "system-prompt");

    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("Test");
    expect(result[0].content).toContain("You are a helpful assistant");
  });

  it("should inject at end-of-history target", () => {
    const prompt = createTestPrompt();
    const context = "<observer-context>Test</observer-context>";

    const result = injectIntoPrompt(prompt, context, "end-of-history");

    // Should be inserted before the last message
    expect(result.length).toBe(prompt.length + 1);
    expect(result[result.length - 2].content).toContain("Test");
  });

  it("should inject at user-message target", () => {
    const prompt = createTestPrompt();
    const context = "<observer-context>Test</observer-context>";

    const result = injectIntoPrompt(prompt, context, "user-message");

    expect(result.length).toBe(prompt.length + 1);
    expect(result.some((m) => m.content.includes("Observer Notes"))).toBe(true);
  });

  it("should return original if context is empty", () => {
    const prompt = createTestPrompt();
    const result = injectIntoPrompt(prompt, "", "end-of-history");

    expect(result).toEqual(prompt);
  });
});

describe("injectObserverMessages", () => {
  it("should format and inject in one call", () => {
    const prompt = createTestPrompt();
    const messages = [
      createTestMessage({ type: "insight", content: "Try X" }),
    ];

    const result = injectObserverMessages(prompt, messages);

    expect(result.length).toBe(prompt.length + 1);
    expect(result.some((m) => m.content.includes("Try X"))).toBe(true);
  });

  it("should use specified target", () => {
    const prompt = createTestPrompt();
    const messages = [createTestMessage({ content: "Test" })];

    const result = injectObserverMessages(prompt, messages, "system-prompt");

    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("Test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Full Integration", () => {
  it("should work end-to-end with issue agent pattern", async () => {
    const store = new InMemoryMailboxStore();
    const ctx = createObserverContext({
      store,
      threadId: "browser-session",
    });

    // Simulate browser automation step
    ctx.nextStep();

    // No messages yet
    const { formattedContext, messageIds } = ctx.getPendingContext();
    expect(formattedContext).toBe("");

    const prompt = createTestPrompt();
    const enriched = ctx.injectContext(prompt, formattedContext);
    expect(enriched.length).toBe(prompt.length);

    // Simulate response with tool call
    const response = {
      text: "Clicked the button",
      toolCalls: [{ name: "click", args: { selector: "#btn" } }],
    };

    ctx.markIncorporated(messageIds);
    const snapshot = ctx.createSnapshot(prompt, response);

    // Check if we should trigger (on tool call)
    const shouldTrigger = TriggerFilters.onToolCall()({
      snapshot,
      response,
    });
    expect(shouldTrigger).toBe(true);

    // Dispatch to observer
    let observerCalled = false;
    await ctx.dispatchToObservers(
      snapshot,
      async (snap) => {
        observerCalled = true;
        // Observer logs an issue
        store.send({
          threadId: snap.threadId,
          from: "issue-agent",
          sentAtStep: snap.stepNumber,
          sentAtTime: Date.now(),
          type: "warning",
          content: "Button click may have failed - no confirmation",
          confidence: 0.7,
          expiresAtStep: null,
        });
      },
      { await: true }
    );

    expect(observerCalled).toBe(true);
    ctx.gc();

    // Next step - issue should be injected
    ctx.nextStep();
    const { formattedContext: fc2, messageIds: ids2 } = ctx.getPendingContext();
    expect(fc2).toContain("WARNING");
    expect(fc2).toContain("Button click may have failed");
  });

  it("should work with guidance observer pattern", async () => {
    const store = new InMemoryMailboxStore();
    const ctx = createObserverContext({
      store,
      threadId: "main-agent",
      injection: { minConfidence: 0.7 },
    });

    // Add guidance from previous analysis
    store.send({
      threadId: "main-agent",
      from: "guidance-agent",
      sentAtStep: 0,
      sentAtTime: Date.now(),
      type: "correction",
      content: "Stay focused on the user's original question",
      confidence: 0.9,
      expiresAtStep: 10,
    });

    ctx.nextStep();
    const { formattedContext, messageIds } = ctx.getPendingContext();
    expect(formattedContext).toContain("CORRECTION");
    expect(formattedContext).toContain("Stay focused");

    const prompt = createTestPrompt();
    const enriched = ctx.injectContext(prompt, formattedContext);
    expect(enriched.length).toBe(prompt.length + 1);

    // Simulate off-track response
    const response = { text: "I'm not sure but let me try something else..." };
    const snapshot = ctx.createSnapshot(prompt, response);

    // Check if guidance is needed
    const needsGuidance = TriggerFilters.containsKeywords("I'm not sure")({
      snapshot,
      response,
    });
    expect(needsGuidance).toBe(true);

    ctx.markIncorporated(messageIds);
    ctx.gc();
  });
});
