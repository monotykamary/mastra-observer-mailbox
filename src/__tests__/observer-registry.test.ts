import { describe, test, expect, beforeEach, mock } from "bun:test";
import { InMemoryMailboxStore } from "../store.ts";
import {
  ObserverRegistry,
  createObserverRegistry,
  createSimpleObserver,
  createToolCallObserver,
  createKeywordObserver,
} from "../observer-registry.ts";
import type { StepSnapshot, SendMessageInput } from "../types.ts";
import { ObserverMiddleware } from "../middleware.ts";

function createMockSnapshot(overrides: Partial<StepSnapshot> = {}): StepSnapshot {
  return {
    threadId: "test-thread",
    stepNumber: 1,
    timestamp: Date.now(),
    promptMessages: [{ role: "user", content: "Hello" }],
    workingMemory: {},
    response: {
      text: "Hi there",
    },
    incorporatedMessageIds: [],
    ...overrides,
  };
}

describe("ObserverRegistry", () => {
  let store: InMemoryMailboxStore;
  let registry: ObserverRegistry;

  beforeEach(() => {
    store = new InMemoryMailboxStore();
    registry = new ObserverRegistry({ store });
  });

  describe("registration", () => {
    test("should register an observer", () => {
      const handler = {
        id: "test-observer",
        name: "Test Observer",
        priority: 50,
        handle: async () => ({}),
      };

      registry.register(handler);

      expect(registry.has("test-observer")).toBe(true);
      expect(registry.size).toBe(1);
    });

    test("should throw on duplicate registration", () => {
      const handler = {
        id: "test-observer",
        name: "Test Observer",
        priority: 50,
        handle: async () => ({}),
      };

      registry.register(handler);

      expect(() => registry.register(handler)).toThrow(
        'Observer with id "test-observer" already registered'
      );
    });

    test("should return unregister function", () => {
      const handler = {
        id: "test-observer",
        name: "Test Observer",
        priority: 50,
        handle: async () => ({}),
      };

      const unregister = registry.register(handler);
      expect(registry.has("test-observer")).toBe(true);

      unregister();
      expect(registry.has("test-observer")).toBe(false);
    });

    test("should unregister by ID", () => {
      const handler = {
        id: "test-observer",
        name: "Test Observer",
        priority: 50,
        handle: async () => ({}),
      };

      registry.register(handler);
      const result = registry.unregister("test-observer");

      expect(result).toBe(true);
      expect(registry.has("test-observer")).toBe(false);
    });

    test("should return false when unregistering non-existent observer", () => {
      const result = registry.unregister("non-existent");
      expect(result).toBe(false);
    });

    test("should get observer by ID", () => {
      const handler = {
        id: "test-observer",
        name: "Test Observer",
        priority: 50,
        handle: async () => ({}),
      };

      registry.register(handler);
      const retrieved = registry.get("test-observer");

      expect(retrieved).toBe(handler);
    });

    test("should return undefined for non-existent observer", () => {
      expect(registry.get("non-existent")).toBeUndefined();
    });

    test("should get all observer IDs", () => {
      registry.register({ id: "a", name: "A", priority: 1, handle: async () => ({}) });
      registry.register({ id: "b", name: "B", priority: 2, handle: async () => ({}) });
      registry.register({ id: "c", name: "C", priority: 3, handle: async () => ({}) });

      const ids = registry.getIds();
      expect(ids).toContain("a");
      expect(ids).toContain("b");
      expect(ids).toContain("c");
    });

    test("should clear all observers", () => {
      registry.register({ id: "a", name: "A", priority: 1, handle: async () => ({}) });
      registry.register({ id: "b", name: "B", priority: 2, handle: async () => ({}) });

      registry.clear();

      expect(registry.size).toBe(0);
    });
  });

  describe("dispatch", () => {
    test("should dispatch to registered observers", async () => {
      const handleMock = mock(async () => ({}));
      registry.register({
        id: "test-observer",
        name: "Test Observer",
        priority: 50,
        handle: handleMock,
      });

      const snapshot = createMockSnapshot();
      await registry.dispatch(snapshot);

      expect(handleMock).toHaveBeenCalledTimes(1);
      expect(handleMock).toHaveBeenCalledWith(snapshot);
    });

    test("should dispatch in priority order (highest first)", async () => {
      const callOrder: string[] = [];

      registry.register({
        id: "low",
        name: "Low Priority",
        priority: 10,
        handle: async () => {
          callOrder.push("low");
          return {};
        },
      });

      registry.register({
        id: "high",
        name: "High Priority",
        priority: 100,
        handle: async () => {
          callOrder.push("high");
          return {};
        },
      });

      registry.register({
        id: "medium",
        name: "Medium Priority",
        priority: 50,
        handle: async () => {
          callOrder.push("medium");
          return {};
        },
      });

      await registry.dispatch(createMockSnapshot());

      expect(callOrder).toEqual(["high", "medium", "low"]);
    });

    test("should send messages to store", async () => {
      registry.register({
        id: "message-observer",
        name: "Message Observer",
        priority: 50,
        handle: async () => ({
          messages: [
            {
              threadId: "test-thread",
              from: "message-observer",
              sentAtStep: 1,
              sentAtTime: Date.now(),
              type: "insight" as const,
              content: "Test insight",
              confidence: 0.8,
              expiresAtStep: 5,
            },
          ],
        }),
      });

      const snapshot = createMockSnapshot();
      const result = await registry.dispatch(snapshot);

      expect(result.messagesSent).toBe(1);

      const messages = store.query("test-thread", { status: "pending" });
      expect(messages.length).toBe(1);
      expect(messages[0]!.content).toBe("Test insight");
    });

    test("should skip observers based on filter", async () => {
      const handleMock = mock(async () => ({}));

      registry.register({
        id: "filtered-observer",
        name: "Filtered Observer",
        priority: 50,
        filter: (snapshot) => snapshot.response.text?.includes("special") ?? false,
        handle: handleMock,
      });

      // Should skip - no "special" in text
      await registry.dispatch(createMockSnapshot({ response: { text: "Normal response" } }));
      expect(handleMock).not.toHaveBeenCalled();

      // Should run - "special" in text
      await registry.dispatch(createMockSnapshot({ response: { text: "A special response" } }));
      expect(handleMock).toHaveBeenCalledTimes(1);
    });

    test("should track skipped observers", async () => {
      registry.register({
        id: "always-skip",
        name: "Always Skip",
        priority: 50,
        filter: () => false,
        handle: async () => ({}),
      });

      const result = await registry.dispatch(createMockSnapshot());

      expect(result.observersSkipped).toContain("always-skip");
      expect(result.observersRun).toBe(0);
    });

    test("should support short-circuit", async () => {
      const handleMock = mock(async () => ({}));

      registry.register({
        id: "short-circuit",
        name: "Short Circuit",
        priority: 100,
        handle: async () => ({ skipRemainingObservers: true }),
      });

      registry.register({
        id: "should-not-run",
        name: "Should Not Run",
        priority: 50,
        handle: handleMock,
      });

      const result = await registry.dispatch(createMockSnapshot());

      expect(result.shortCircuited).toBe(true);
      expect(handleMock).not.toHaveBeenCalled();
    });

    test("should continue on error by default", async () => {
      const afterErrorMock = mock(async () => ({}));

      registry.register({
        id: "error-observer",
        name: "Error Observer",
        priority: 100,
        handle: async () => {
          throw new Error("Observer error");
        },
      });

      registry.register({
        id: "after-error",
        name: "After Error",
        priority: 50,
        handle: afterErrorMock,
      });

      const result = await registry.dispatch(createMockSnapshot());

      expect(result.errors.length).toBe(1);
      expect(result.errors[0]!.observerId).toBe("error-observer");
      expect(afterErrorMock).toHaveBeenCalled();
    });

    test("should stop on error when continueOnError is false", async () => {
      const registryStrict = new ObserverRegistry({
        store,
        continueOnError: false,
      });

      registryStrict.register({
        id: "error-observer",
        name: "Error Observer",
        priority: 100,
        handle: async () => {
          throw new Error("Observer error");
        },
      });

      await expect(
        registryStrict.dispatch(createMockSnapshot())
      ).rejects.toThrow("Observer error");
    });

    test("should call onObserverError callback", async () => {
      const errorCallback = mock(
        (_observerId: string, _error: Error, _snapshot: StepSnapshot) => {}
      );

      const registryWithCallback = new ObserverRegistry({
        store,
        onObserverError: errorCallback,
      });

      registryWithCallback.register({
        id: "error-observer",
        name: "Error Observer",
        priority: 50,
        handle: async () => {
          throw new Error("Test error");
        },
      });

      await registryWithCallback.dispatch(createMockSnapshot());

      expect(errorCallback).toHaveBeenCalledTimes(1);
      expect(errorCallback.mock.calls[0]![0]).toBe("error-observer");
      expect(errorCallback.mock.calls[0]![1].message).toBe("Test error");
    });

    test("should auto-fill threadId and from in messages", async () => {
      registry.register({
        id: "auto-fill-observer",
        name: "Auto Fill Observer",
        priority: 50,
        handle: async () => ({
          messages: [
            {
              // Intentionally missing threadId and from
              threadId: "", // Will be overwritten
              from: "", // Will be overwritten if empty
              sentAtStep: 1,
              sentAtTime: Date.now(),
              type: "insight" as const,
              content: "Test",
              confidence: 0.8,
              expiresAtStep: 5,
            },
          ],
        }),
      });

      await registry.dispatch(createMockSnapshot({ threadId: "my-thread" }));

      const messages = store.query("my-thread", { status: "pending" });
      expect(messages.length).toBe(1);
      expect(messages[0]!.from).toBe("auto-fill-observer");
    });
  });

  describe("getHandlers", () => {
    test("should return handlers sorted by priority", () => {
      registry.register({ id: "low", name: "Low", priority: 10, handle: async () => ({}) });
      registry.register({ id: "high", name: "High", priority: 100, handle: async () => ({}) });
      registry.register({ id: "medium", name: "Medium", priority: 50, handle: async () => ({}) });

      const handlers = registry.getHandlers();

      expect(handlers[0]!.id).toBe("high");
      expect(handlers[1]!.id).toBe("medium");
      expect(handlers[2]!.id).toBe("low");
    });
  });
});

describe("createObserverRegistry", () => {
  test("should create a registry instance", () => {
    const store = new InMemoryMailboxStore();
    const registry = createObserverRegistry({ store });

    expect(registry).toBeInstanceOf(ObserverRegistry);
  });
});

describe("Helper functions", () => {
  let store: InMemoryMailboxStore;
  let registry: ObserverRegistry;

  beforeEach(() => {
    store = new InMemoryMailboxStore();
    registry = new ObserverRegistry({ store });
  });

  describe("createSimpleObserver", () => {
    test("should create a simple observer", async () => {
      const observer = createSimpleObserver(
        "simple",
        "Simple Observer",
        async () => [
          {
            threadId: "test",
            from: "simple",
            sentAtStep: 1,
            sentAtTime: Date.now(),
            type: "insight",
            content: "Simple insight",
            confidence: 0.7,
            expiresAtStep: 5,
          },
        ]
      );

      registry.register(observer);
      await registry.dispatch(createMockSnapshot());

      const messages = store.query("test-thread", { status: "pending" });
      expect(messages.length).toBe(1);
    });

    test("should use default priority of 50", () => {
      const observer = createSimpleObserver("test", "Test", async () => []);
      expect(observer.priority).toBe(50);
    });

    test("should accept custom priority", () => {
      const observer = createSimpleObserver("test", "Test", async () => [], {
        priority: 100,
      });
      expect(observer.priority).toBe(100);
    });
  });

  describe("createToolCallObserver", () => {
    test("should only run when tool calls present", async () => {
      const handleMock = mock(async () => []);
      const observer = createToolCallObserver("tool", "Tool Observer", handleMock);

      registry.register(observer);

      // No tool calls
      await registry.dispatch(createMockSnapshot({ response: { text: "No tools" } }));
      expect(handleMock).not.toHaveBeenCalled();

      // With tool calls
      await registry.dispatch(
        createMockSnapshot({
          response: { text: "With tools", toolCalls: [{ name: "test", args: {} }] },
        })
      );
      expect(handleMock).toHaveBeenCalledTimes(1);
    });

    test("should filter by specific tool names", async () => {
      const handleMock = mock(async () => []);
      const observer = createToolCallObserver("tool", "Tool Observer", handleMock, {
        toolNames: ["search", "fetch"],
      });

      registry.register(observer);

      // Wrong tool name
      await registry.dispatch(
        createMockSnapshot({
          response: { toolCalls: [{ name: "other_tool", args: {} }] },
        })
      );
      expect(handleMock).not.toHaveBeenCalled();

      // Matching tool name
      await registry.dispatch(
        createMockSnapshot({
          response: { toolCalls: [{ name: "search", args: {} }] },
        })
      );
      expect(handleMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("createKeywordObserver", () => {
    test("should only run when keywords present", async () => {
      const handleMock = mock(async () => []);
      const observer = createKeywordObserver(
        "keyword",
        "Keyword Observer",
        ["error", "warning"],
        handleMock
      );

      registry.register(observer);

      // No keywords
      await registry.dispatch(
        createMockSnapshot({ response: { text: "Everything is fine" } })
      );
      expect(handleMock).not.toHaveBeenCalled();

      // With keyword
      await registry.dispatch(
        createMockSnapshot({ response: { text: "An error occurred" } })
      );
      expect(handleMock).toHaveBeenCalledTimes(1);
    });

    test("should pass matched keywords to handler", async () => {
      let capturedKeywords: string[] = [];
      const observer = createKeywordObserver(
        "keyword",
        "Keyword Observer",
        ["error", "warning", "critical"],
        async (_snapshot, matched) => {
          capturedKeywords = matched;
          return [];
        }
      );

      registry.register(observer);

      await registry.dispatch(
        createMockSnapshot({ response: { text: "A warning and critical issue" } })
      );

      expect(capturedKeywords).toContain("warning");
      expect(capturedKeywords).toContain("critical");
      expect(capturedKeywords).not.toContain("error");
    });

    test("should be case insensitive by default", async () => {
      const handleMock = mock(async () => []);
      const observer = createKeywordObserver(
        "keyword",
        "Keyword Observer",
        ["ERROR"],
        handleMock
      );

      registry.register(observer);

      await registry.dispatch(
        createMockSnapshot({ response: { text: "An error occurred" } })
      );
      expect(handleMock).toHaveBeenCalled();
    });

    test("should support case sensitive mode", async () => {
      const handleMock = mock(async () => []);
      const observer = createKeywordObserver(
        "keyword",
        "Keyword Observer",
        ["ERROR"],
        handleMock,
        { caseSensitive: true }
      );

      registry.register(observer);

      // Lowercase won't match
      await registry.dispatch(
        createMockSnapshot({ response: { text: "An error occurred" } })
      );
      expect(handleMock).not.toHaveBeenCalled();

      // Uppercase matches
      await registry.dispatch(
        createMockSnapshot({ response: { text: "AN ERROR OCCURRED" } })
      );
      expect(handleMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Integration with ObserverMiddleware", () => {
  test("should work with middleware using registry", async () => {
    const store = new InMemoryMailboxStore();
    const registry = new ObserverRegistry({ store });

    registry.register({
      id: "test-observer",
      name: "Test Observer",
      priority: 50,
      handle: async (snapshot) => ({
        messages: [
          {
            threadId: snapshot.threadId,
            from: "test-observer",
            sentAtStep: snapshot.stepNumber,
            sentAtTime: Date.now(),
            type: "insight" as const,
            content: "Registry observer insight",
            confidence: 0.8,
            expiresAtStep: snapshot.stepNumber + 5,
          },
        ],
      }),
    });

    const middleware = new ObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 3,
        minConfidence: 0.5,
      },
      trigger: {
        mode: "every-step",
        async: false,
      },
      registry, // Use registry instead of onTrigger
    });

    // Step 1
    middleware.transformParams("thread", 1, [{ role: "user", content: "Hello" }]);
    await middleware.afterGenerate("thread", { text: "Hi" });

    // Step 2 - should have observer insight
    const enriched = middleware.transformParams("thread", 2, [
      { role: "user", content: "Continue" },
    ]);

    const observerContext = enriched.find((m) =>
      m.content.includes("observer-context")
    );
    expect(observerContext).toBeDefined();
    expect(observerContext!.content).toContain("Registry observer insight");
  });

  test("should be accessible via getRegistry()", () => {
    const store = new InMemoryMailboxStore();
    const registry = new ObserverRegistry({ store });

    const middleware = new ObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 3,
        minConfidence: 0.5,
      },
      trigger: {
        mode: "every-step",
        async: false,
      },
      registry,
    });

    expect(middleware.getRegistry()).toBe(registry);
  });
});
