import { describe, test, expect, beforeEach, mock } from "bun:test";
import { InMemoryMailboxStore } from "../store.ts";
import {
  ObserverMiddleware,
  createObserverMiddleware,
  formatMessagesForInjection,
  injectIntoPrompt,
} from "../middleware.ts";
import type { MailboxMessage, PromptMessage, StepSnapshot } from "../types.ts";

describe("formatMessagesForInjection", () => {
  test("should return empty string for empty messages", () => {
    expect(formatMessagesForInjection([])).toBe("");
  });

  test("should format single message correctly", () => {
    const messages: MailboxMessage[] = [
      {
        id: "1",
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "This is an insight",
        confidence: 0.85,
        incorporatedAtStep: null,
        expiresAtStep: null,
        contentHash: "abc123",
      },
    ];

    const result = formatMessagesForInjection(messages);

    expect(result).toContain("<observer-context>");
    expect(result).toContain("</observer-context>");
    expect(result).toContain("[INSIGHT confidence=85%]");
    expect(result).toContain("This is an insight");
  });

  test("should format multiple messages correctly", () => {
    const messages: MailboxMessage[] = [
      {
        id: "1",
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Insight content",
        confidence: 0.9,
        incorporatedAtStep: null,
        expiresAtStep: null,
        contentHash: "abc123",
      },
      {
        id: "2",
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 2,
        sentAtTime: Date.now(),
        type: "warning",
        content: "Warning content",
        confidence: 0.72,
        incorporatedAtStep: null,
        expiresAtStep: null,
        contentHash: "def456",
      },
    ];

    const result = formatMessagesForInjection(messages);

    expect(result).toContain("[INSIGHT confidence=90%]");
    expect(result).toContain("Insight content");
    expect(result).toContain("[WARNING confidence=72%]");
    expect(result).toContain("Warning content");
  });
});

describe("injectIntoPrompt", () => {
  const observerContext = "<observer-context>Test</observer-context>";

  describe("system-prompt target", () => {
    test("should append to existing system message", () => {
      const messages: PromptMessage[] = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ];

      const result = injectIntoPrompt(messages, observerContext, "system-prompt");

      expect(result.length).toBe(2);
      expect(result[0]!.role).toBe("system");
      expect(result[0]!.content).toContain("You are helpful.");
      expect(result[0]!.content).toContain(observerContext);
    });

    test("should prepend new system message if none exists", () => {
      const messages: PromptMessage[] = [{ role: "user", content: "Hello" }];

      const result = injectIntoPrompt(messages, observerContext, "system-prompt");

      expect(result.length).toBe(2);
      expect(result[0]!.role).toBe("system");
      expect(result[0]!.content).toBe(observerContext);
    });
  });

  describe("user-message target", () => {
    test("should insert before last user message", () => {
      const messages: PromptMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "First message" },
        { role: "assistant", content: "Response" },
        { role: "user", content: "Second message" },
      ];

      const result = injectIntoPrompt(messages, observerContext, "user-message");

      expect(result.length).toBe(5);
      expect(result[3]!.role).toBe("user");
      expect(result[3]!.content).toContain("[Observer Notes]");
      expect(result[3]!.content).toContain(observerContext);
      expect(result[4]!.content).toBe("Second message");
    });

    test("should append if no user message exists", () => {
      const messages: PromptMessage[] = [{ role: "system", content: "System" }];

      const result = injectIntoPrompt(messages, observerContext, "user-message");

      expect(result.length).toBe(2);
      expect(result[1]!.role).toBe("user");
      expect(result[1]!.content).toContain("[Observer Notes]");
    });
  });

  describe("end-of-history target", () => {
    test("should insert before last message", () => {
      const messages: PromptMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "Latest" },
      ];

      const result = injectIntoPrompt(messages, observerContext, "end-of-history");

      expect(result.length).toBe(5);
      expect(result[3]!.role).toBe("user");
      expect(result[3]!.content).toContain("[Observer Context]");
      expect(result[4]!.content).toBe("Latest");
    });

    test("should handle empty messages array", () => {
      const messages: PromptMessage[] = [];

      const result = injectIntoPrompt(messages, observerContext, "end-of-history");

      expect(result.length).toBe(1);
      expect(result[0]!.role).toBe("user");
      expect(result[0]!.content).toContain("[Observer Context]");
    });
  });

  test("should return original messages if context is empty", () => {
    const messages: PromptMessage[] = [{ role: "user", content: "Hello" }];

    const result = injectIntoPrompt(messages, "", "system-prompt");

    expect(result).toEqual(messages);
  });
});

describe("ObserverMiddleware", () => {
  let store: InMemoryMailboxStore;
  let middleware: ObserverMiddleware;
  let triggerCallback: ReturnType<typeof mock>;

  beforeEach(() => {
    store = new InMemoryMailboxStore();
    triggerCallback = mock(async (_snapshot: StepSnapshot) => {});

    middleware = new ObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 3,
        minConfidence: 0.6,
      },
      trigger: {
        mode: "every-step",
        async: true,
      },
      onTrigger: triggerCallback,
    });
  });

  describe("transformParams()", () => {
    test("should return original prompt when no pending messages", () => {
      const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];

      const result = middleware.transformParams("thread-1", 1, prompt);

      expect(result).toEqual(prompt);
    });

    test("should inject pending messages into prompt", () => {
      // Add a message to the store
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "You should check X",
        confidence: 0.8,
        expiresAtStep: null,
      });

      const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];

      const result = middleware.transformParams("thread-1", 2, prompt);

      expect(result.length).toBe(2);
      expect(result[0]!.content).toContain("observer-context");
      expect(result[0]!.content).toContain("You should check X");
    });

    test("should filter by minConfidence", () => {
      // Add low confidence message
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Low confidence insight",
        confidence: 0.4, // Below threshold
        expiresAtStep: null,
      });

      const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];

      const result = middleware.transformParams("thread-1", 2, prompt);

      // Should not inject low confidence message
      expect(result).toEqual(prompt);
    });

    test("should respect maxMessagesPerTurn limit", () => {
      // Add 5 messages
      for (let i = 0; i < 5; i++) {
        store.send({
          threadId: "thread-1",
          from: "observer-1",
          sentAtStep: i,
          sentAtTime: Date.now(),
          type: "insight",
          content: `Insight ${i}`,
          confidence: 0.8,
          expiresAtStep: null,
        });
      }

      const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];

      const result = middleware.transformParams("thread-1", 10, prompt);

      // Should only inject 3 messages (maxMessagesPerTurn)
      const contextMessage = result.find((m) =>
        m.content.includes("observer-context")
      );
      expect(contextMessage).toBeDefined();

      // Count how many insights are in the context
      const insightCount = (contextMessage!.content.match(/\[INSIGHT/g) || [])
        .length;
      expect(insightCount).toBe(3);
    });
  });

  describe("afterGenerate()", () => {
    test("should mark messages as incorporated", async () => {
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test insight",
        confidence: 0.8,
        expiresAtStep: null,
      });

      const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];

      // Transform params first to register the step
      middleware.transformParams("thread-1", 2, prompt);

      // Process result
      await middleware.afterGenerate("thread-1", { text: "Response" });

      // Message should be incorporated
      const pending = store.query("thread-1", { status: "pending" });
      const incorporated = store.query("thread-1", { status: "incorporated" });

      expect(pending.length).toBe(0);
      expect(incorporated.length).toBe(1);
    });

    test("should store snapshot", async () => {
      const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];

      middleware.transformParams("thread-1", 1, prompt);
      await middleware.afterGenerate("thread-1", { text: "Response" });

      const snapshots = store.getSnapshots("thread-1", 10);
      expect(snapshots.length).toBe(1);
      expect(snapshots[0]!.stepNumber).toBe(1);
      expect(snapshots[0]!.response.text).toBe("Response");
    });

    test("should trigger callback in every-step mode", async () => {
      const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];

      middleware.transformParams("thread-1", 1, prompt);
      await middleware.afterGenerate("thread-1", { text: "Response" });

      expect(triggerCallback).toHaveBeenCalled();
    });

    test("should trigger callback with tool calls in on-tool-call mode", async () => {
      const toolCallCallback = mock(async (_snapshot: StepSnapshot) => {});

      const toolCallMiddleware = new ObserverMiddleware({
        store,
        injection: {
          target: "end-of-history",
          maxMessagesPerTurn: 3,
          minConfidence: 0.6,
        },
        trigger: {
          mode: "on-tool-call",
          async: true,
        },
        onTrigger: toolCallCallback,
      });

      const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];

      // With tool calls
      toolCallMiddleware.transformParams("thread-1", 1, prompt);
      await toolCallMiddleware.afterGenerate("thread-1", {
        text: "Let me search",
        toolCalls: [{ name: "search", args: { q: "test" } }],
      });

      expect(toolCallCallback).toHaveBeenCalled();
    });

    test("should not trigger callback without tool calls in on-tool-call mode", async () => {
      const toolCallCallback = mock(async (_snapshot: StepSnapshot) => {});

      const toolCallMiddleware = new ObserverMiddleware({
        store,
        injection: {
          target: "end-of-history",
          maxMessagesPerTurn: 3,
          minConfidence: 0.6,
        },
        trigger: {
          mode: "on-tool-call",
          async: true,
        },
        onTrigger: toolCallCallback,
      });

      const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];

      // Without tool calls
      toolCallMiddleware.transformParams("thread-1", 1, prompt);
      await toolCallMiddleware.afterGenerate("thread-1", {
        text: "Just text response",
      });

      expect(toolCallCallback).not.toHaveBeenCalled();
    });

    test("should trigger callback on failure in on-failure mode", async () => {
      const failureCallback = mock(async (_snapshot: StepSnapshot) => {});

      const failureMiddleware = new ObserverMiddleware({
        store,
        injection: {
          target: "end-of-history",
          maxMessagesPerTurn: 3,
          minConfidence: 0.6,
        },
        trigger: {
          mode: "on-failure",
          async: true,
        },
        onTrigger: failureCallback,
      });

      const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];

      // With error response
      failureMiddleware.transformParams("thread-1", 1, prompt);
      await failureMiddleware.afterGenerate("thread-1", {
        text: "I encountered an error while processing",
      });

      expect(failureCallback).toHaveBeenCalled();
    });

    test("should run gc after processing", async () => {
      // Add a message that will expire
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Will expire",
        confidence: 0.8,
        expiresAtStep: 5,
      });

      const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];

      middleware.transformParams("thread-1", 10, prompt);
      await middleware.afterGenerate("thread-1", { text: "Response" });

      // GC should have removed the expired message
      const remaining = store.query("thread-1", { status: "all" });
      expect(remaining.length).toBe(0);
    });
  });

  describe("sync trigger mode", () => {
    test("should wait for callback in sync mode", async () => {
      let callbackFinished = false;
      const syncCallback = mock(async (_snapshot: StepSnapshot) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        callbackFinished = true;
      });

      const syncMiddleware = new ObserverMiddleware({
        store,
        injection: {
          target: "end-of-history",
          maxMessagesPerTurn: 3,
          minConfidence: 0.6,
        },
        trigger: {
          mode: "every-step",
          async: false, // Sync mode
        },
        onTrigger: syncCallback,
      });

      const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];

      syncMiddleware.transformParams("thread-1", 1, prompt);
      await syncMiddleware.afterGenerate("thread-1", { text: "Response" });

      expect(callbackFinished).toBe(true);
    });
  });

  describe("getStore()", () => {
    test("should return the store instance", () => {
      expect(middleware.getStore()).toBe(store);
    });
  });

  describe("getConfig()", () => {
    test("should return current configuration", () => {
      const config = middleware.getConfig();

      expect(config.injection.target).toBe("end-of-history");
      expect(config.injection.maxMessagesPerTurn).toBe(3);
      expect(config.injection.minConfidence).toBe(0.6);
      expect(config.trigger.mode).toBe("every-step");
      expect(config.trigger.async).toBe(true);
    });
  });
});

describe("createObserverMiddleware()", () => {
  test("should create middleware instance", () => {
    const store = new InMemoryMailboxStore();
    const middleware = createObserverMiddleware({
      store,
      injection: {
        target: "system-prompt",
        maxMessagesPerTurn: 5,
        minConfidence: 0.5,
      },
      trigger: {
        mode: "on-tool-call",
        async: false,
      },
    });

    expect(middleware).toBeInstanceOf(ObserverMiddleware);
    expect(middleware.getConfig().injection.target).toBe("system-prompt");
  });
});

describe("Error handling and retry", () => {
  let store: InMemoryMailboxStore;

  beforeEach(() => {
    store = new InMemoryMailboxStore();
  });

  test("should call onError when observer fails (no retries)", async () => {
    const errorCallback = mock((_error: Error, _snapshot: StepSnapshot, _attempts: number) => {});
    const failingTrigger = mock(async () => {
      throw new Error("Observer failed");
    });

    const middleware = new ObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 3,
        minConfidence: 0.6,
      },
      trigger: {
        mode: "every-step",
        async: false,
        onError: errorCallback,
      },
      onTrigger: failingTrigger,
    });

    const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];
    middleware.transformParams("thread-1", 1, prompt);
    await middleware.afterGenerate("thread-1", { text: "Response" });

    expect(failingTrigger).toHaveBeenCalledTimes(1);
    expect(errorCallback).toHaveBeenCalledTimes(1);
    expect(errorCallback.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(errorCallback.mock.calls[0]![0].message).toBe("Observer failed");
    expect(errorCallback.mock.calls[0]![2]).toBe(1); // 1 attempt
  });

  test("should retry on failure with maxRetries", async () => {
    const errorCallback = mock((_error: Error, _snapshot: StepSnapshot, _attempts: number) => {});
    let callCount = 0;
    const failingTrigger = mock(async () => {
      callCount++;
      throw new Error("Observer failed");
    });

    const middleware = new ObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 3,
        minConfidence: 0.6,
      },
      trigger: {
        mode: "every-step",
        async: false,
        maxRetries: 2,
        retryDelayMs: 10, // Short delay for tests
        onError: errorCallback,
      },
      onTrigger: failingTrigger,
    });

    const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];
    middleware.transformParams("thread-1", 1, prompt);
    await middleware.afterGenerate("thread-1", { text: "Response" });

    // 1 initial + 2 retries = 3 attempts
    expect(failingTrigger).toHaveBeenCalledTimes(3);
    expect(errorCallback).toHaveBeenCalledTimes(1);
    expect(errorCallback.mock.calls[0]![2]).toBe(3); // 3 total attempts
  });

  test("should succeed on retry if later attempt works", async () => {
    const errorCallback = mock((_error: Error, _snapshot: StepSnapshot, _attempts: number) => {});
    let callCount = 0;
    const sometimesFailingTrigger = mock(async () => {
      callCount++;
      if (callCount < 2) {
        throw new Error("Observer failed");
      }
      // Second attempt succeeds
    });

    const middleware = new ObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 3,
        minConfidence: 0.6,
      },
      trigger: {
        mode: "every-step",
        async: false,
        maxRetries: 2,
        retryDelayMs: 10,
        onError: errorCallback,
      },
      onTrigger: sometimesFailingTrigger,
    });

    const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];
    middleware.transformParams("thread-1", 1, prompt);
    await middleware.afterGenerate("thread-1", { text: "Response" });

    // Should have been called twice (failed once, succeeded on retry)
    expect(sometimesFailingTrigger).toHaveBeenCalledTimes(2);
    // Should NOT call error callback since it eventually succeeded
    expect(errorCallback).not.toHaveBeenCalled();
  });

  test("should use exponential backoff between retries", async () => {
    const timestamps: number[] = [];
    const failingTrigger = mock(async () => {
      timestamps.push(Date.now());
      throw new Error("Observer failed");
    });

    const middleware = new ObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 3,
        minConfidence: 0.6,
      },
      trigger: {
        mode: "every-step",
        async: false,
        maxRetries: 2,
        retryDelayMs: 50, // 50ms base delay
      },
      onTrigger: failingTrigger,
    });

    const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];
    middleware.transformParams("thread-1", 1, prompt);
    await middleware.afterGenerate("thread-1", { text: "Response" });

    expect(timestamps.length).toBe(3);

    // First retry should be after ~50ms
    const firstDelay = timestamps[1]! - timestamps[0]!;
    expect(firstDelay).toBeGreaterThanOrEqual(40); // Allow some tolerance

    // Second retry should be after ~100ms (exponential: 50 * 2^1)
    const secondDelay = timestamps[2]! - timestamps[1]!;
    expect(secondDelay).toBeGreaterThanOrEqual(80);
  });

  test("should not use retries in async mode but still handle errors", async () => {
    const errorCallback = mock((_error: Error, _snapshot: StepSnapshot, _attempts: number) => {});
    const failingTrigger = mock(async () => {
      throw new Error("Observer failed");
    });

    const middleware = new ObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 3,
        minConfidence: 0.6,
      },
      trigger: {
        mode: "every-step",
        async: true, // Async mode
        maxRetries: 2,
        retryDelayMs: 10,
        onError: errorCallback,
      },
      onTrigger: failingTrigger,
    });

    const prompt: PromptMessage[] = [{ role: "user", content: "Hello" }];
    middleware.transformParams("thread-1", 1, prompt);
    await middleware.afterGenerate("thread-1", { text: "Response" });

    // Wait for async execution
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should still retry in async mode
    expect(failingTrigger).toHaveBeenCalledTimes(3);
    expect(errorCallback).toHaveBeenCalledTimes(1);
  });
});
