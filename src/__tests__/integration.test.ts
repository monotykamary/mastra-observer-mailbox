/**
 * Integration Tests
 *
 * Tests for multi-step scenarios with observer feedback loops
 * to validate the entire system end-to-end.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryMailboxStore } from "../store.ts";
import { ObserverMiddleware, createObserverMiddleware } from "../middleware.ts";
import type {
  StepSnapshot,
  PromptMessage,
  SendMessageInput,
  MailboxMessage,
} from "../types.ts";
import { KeywordFailureDetector } from "../failure-detection.ts";

describe("Integration: Multi-step observer feedback loop", () => {
  let store: InMemoryMailboxStore;
  let observerInsights: SendMessageInput[];
  let snapshotsReceived: StepSnapshot[];

  beforeEach(() => {
    store = new InMemoryMailboxStore({
      dedupeWindowSteps: 3,
      defaultTtlSteps: 5,
    });
    observerInsights = [];
    snapshotsReceived = [];
  });

  test("should complete a full feedback loop across multiple steps", async () => {
    // Simulate an observer that generates insights based on main agent responses
    const middleware = createObserverMiddleware({
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
      onTrigger: async (snapshot) => {
        snapshotsReceived.push(snapshot);

        // Observer generates insight based on response
        if (snapshot.response.text?.includes("search")) {
          const insight: SendMessageInput = {
            threadId: snapshot.threadId,
            from: "observer",
            sentAtStep: snapshot.stepNumber,
            sentAtTime: Date.now(),
            type: "insight",
            content: "Consider filtering search results by date",
            confidence: 0.8,
            expiresAtStep: snapshot.stepNumber + 3,
          };
          observerInsights.push(insight);
          store.send(insight);
        }
      },
    });

    const threadId = "test-thread";

    // Step 1: Initial prompt
    const prompt1: PromptMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Find information about AI" },
    ];

    const enriched1 = middleware.transformParams(threadId, 1, prompt1);
    // No observer context yet
    expect(enriched1).toEqual(prompt1);

    await middleware.afterGenerate(threadId, {
      text: "I'll search for AI information.",
      toolCalls: [{ name: "search", args: { query: "AI" } }],
    });

    // Observer should have received snapshot and generated insight
    expect(snapshotsReceived.length).toBe(1);
    expect(observerInsights.length).toBe(1);

    // Step 2: Continue with feedback
    const prompt2: PromptMessage[] = [
      ...prompt1,
      { role: "assistant", content: "I'll search for AI information." },
      { role: "user", content: "Show me the results" },
    ];

    const enriched2 = middleware.transformParams(threadId, 2, prompt2);
    // Now should have observer context injected
    expect(enriched2.length).toBe(prompt2.length + 1);
    const observerMessage = enriched2.find((m) =>
      m.content.includes("observer-context")
    );
    expect(observerMessage).toBeDefined();
    expect(observerMessage!.content).toContain("filtering search results");

    await middleware.afterGenerate(threadId, {
      text: "Here are the search results filtered by date.",
    });

    // Insight should now be incorporated
    const pending = store.query(threadId, { status: "pending" });
    const incorporated = store.query(threadId, { status: "incorporated" });
    expect(pending.length).toBe(0);
    expect(incorporated.length).toBe(1);
    expect(incorporated[0]!.incorporatedAtStep).toBe(2);
  });

  test("should handle multiple observers sending insights", async () => {
    let observerCount = 0;

    const middleware = createObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 5,
        minConfidence: 0.5,
      },
      trigger: {
        mode: "every-step",
        async: false,
      },
      onTrigger: async (snapshot) => {
        observerCount++;

        // Multiple "observers" send insights
        store.send({
          threadId: snapshot.threadId,
          from: "security-observer",
          sentAtStep: snapshot.stepNumber,
          sentAtTime: Date.now(),
          type: "warning",
          content: "Check for SQL injection",
          confidence: 0.9,
          expiresAtStep: snapshot.stepNumber + 3,
        });

        store.send({
          threadId: snapshot.threadId,
          from: "performance-observer",
          sentAtStep: snapshot.stepNumber,
          sentAtTime: Date.now(),
          type: "insight",
          content: "Consider caching this query",
          confidence: 0.7,
          expiresAtStep: snapshot.stepNumber + 3,
        });

        store.send({
          threadId: snapshot.threadId,
          from: "ux-observer",
          sentAtStep: snapshot.stepNumber,
          sentAtTime: Date.now(),
          type: "context",
          content: "User prefers detailed explanations",
          confidence: 0.6,
          expiresAtStep: snapshot.stepNumber + 3,
        });
      },
    });

    const threadId = "multi-observer-thread";
    const prompt: PromptMessage[] = [
      { role: "user", content: "Execute database query" },
    ];

    // Step 1
    middleware.transformParams(threadId, 1, prompt);
    await middleware.afterGenerate(threadId, { text: "Executing query..." });

    // Step 2 - should have all 3 insights
    const prompt2: PromptMessage[] = [
      ...prompt,
      { role: "assistant", content: "Executing query..." },
      { role: "user", content: "Continue" },
    ];

    const enriched = middleware.transformParams(threadId, 2, prompt2);
    const observerContext = enriched.find((m) =>
      m.content.includes("observer-context")
    );

    expect(observerContext).toBeDefined();
    expect(observerContext!.content).toContain("SQL injection");
    expect(observerContext!.content).toContain("caching");
    expect(observerContext!.content).toContain("detailed explanations");

    // Check ordering by confidence (highest first)
    const content = observerContext!.content;
    const warningIndex = content.indexOf("SQL injection");
    const insightIndex = content.indexOf("caching");
    const contextIndex = content.indexOf("detailed explanations");

    // Warning (0.9) should come before insight (0.7) which should come before context (0.6)
    expect(warningIndex).toBeLessThan(insightIndex);
    expect(insightIndex).toBeLessThan(contextIndex);
  });

  test("should handle message deduplication across steps", async () => {
    const middleware = createObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 5,
        minConfidence: 0.5,
      },
      trigger: {
        mode: "every-step",
        async: false,
      },
      onTrigger: async (snapshot) => {
        // Observer tries to send the same insight every step
        store.send({
          threadId: snapshot.threadId,
          from: "observer",
          sentAtStep: snapshot.stepNumber,
          sentAtTime: Date.now(),
          type: "insight",
          content: "This is a repeated insight",
          confidence: 0.8,
          expiresAtStep: snapshot.stepNumber + 5,
        });
      },
    });

    const threadId = "dedup-thread";

    // Run 5 steps
    for (let step = 1; step <= 5; step++) {
      const prompt: PromptMessage[] = [
        { role: "user", content: `Step ${step}` },
      ];
      middleware.transformParams(threadId, step, prompt);
      await middleware.afterGenerate(threadId, { text: `Response ${step}` });
    }

    // Should only have 2 messages due to deduplication window of 3 steps
    // Steps 1-3: first message (deduplicated)
    // Steps 4+: new message (outside dedup window)
    const allMessages = store.query(threadId, { status: "all" });
    expect(allMessages.length).toBeLessThanOrEqual(2);
  });

  test("should respect TTL and expire old messages", async () => {
    const middleware = createObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 5,
        minConfidence: 0.5,
      },
      trigger: {
        mode: "every-step",
        async: false,
      },
      onTrigger: async (snapshot) => {
        // Send message with short TTL
        store.send({
          threadId: snapshot.threadId,
          from: "observer",
          sentAtStep: snapshot.stepNumber,
          sentAtTime: Date.now(),
          type: "insight",
          content: `Insight from step ${snapshot.stepNumber}`,
          confidence: 0.8,
          expiresAtStep: snapshot.stepNumber + 2, // Short TTL
        });
      },
    });

    const threadId = "ttl-thread";

    // Step 1: Send first insight
    middleware.transformParams(threadId, 1, [{ role: "user", content: "Step 1" }]);
    await middleware.afterGenerate(threadId, { text: "Response 1" });

    // Step 5: First insight should be expired (expiresAtStep: 3)
    middleware.transformParams(threadId, 5, [{ role: "user", content: "Step 5" }]);
    await middleware.afterGenerate(threadId, { text: "Response 5" });

    // Check that step 1 insight is gone
    const allMessages = store.query(threadId, { status: "all" });
    const step1Insight = allMessages.find((m) =>
      m.content.includes("step 1")
    );
    expect(step1Insight).toBeUndefined();
  });

  test("should handle concurrent threads independently", async () => {
    const threadInsights = new Map<string, string[]>();

    const middleware = createObserverMiddleware({
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
      onTrigger: async (snapshot) => {
        const insights = threadInsights.get(snapshot.threadId) ?? [];
        insights.push(`Insight for ${snapshot.threadId}`);
        threadInsights.set(snapshot.threadId, insights);

        store.send({
          threadId: snapshot.threadId,
          from: "observer",
          sentAtStep: snapshot.stepNumber,
          sentAtTime: Date.now(),
          type: "insight",
          content: `Insight specific to ${snapshot.threadId}`,
          confidence: 0.8,
          expiresAtStep: snapshot.stepNumber + 5,
        });
      },
    });

    // Process two threads concurrently
    const threads = ["thread-A", "thread-B"];

    for (const threadId of threads) {
      middleware.transformParams(threadId, 1, [
        { role: "user", content: `Hello from ${threadId}` },
      ]);
      await middleware.afterGenerate(threadId, { text: `Response for ${threadId}` });
    }

    // Step 2: Check each thread gets its own insights
    for (const threadId of threads) {
      const enriched = middleware.transformParams(threadId, 2, [
        { role: "user", content: "Continue" },
      ]);

      const observerContext = enriched.find((m) =>
        m.content.includes("observer-context")
      );
      expect(observerContext).toBeDefined();
      expect(observerContext!.content).toContain(threadId);

      // Each thread should NOT see the other thread's insights
      const otherThread = threads.find((t) => t !== threadId);
      expect(observerContext!.content).not.toContain(otherThread);
    }
  });

  test("should handle failure detection triggering observer", async () => {
    let failureDetected = false;

    const middleware = createObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 3,
        minConfidence: 0.5,
      },
      trigger: {
        mode: "on-failure",
        async: false,
        failureDetector: new KeywordFailureDetector({
          failureKeywords: ["error", "failed", "exception"],
          negationPhrases: ["no error", "succeeded"],
        }),
      },
      onTrigger: async (snapshot) => {
        failureDetected = true;
        store.send({
          threadId: snapshot.threadId,
          from: "error-observer",
          sentAtStep: snapshot.stepNumber,
          sentAtTime: Date.now(),
          type: "correction",
          content: "Error detected, suggesting retry with different approach",
          confidence: 0.95,
          expiresAtStep: snapshot.stepNumber + 5,
        });
      },
    });

    const threadId = "failure-thread";

    // Step 1: Success response - observer should NOT trigger
    middleware.transformParams(threadId, 1, [
      { role: "user", content: "Do something" },
    ]);
    await middleware.afterGenerate(threadId, { text: "Task completed successfully" });
    expect(failureDetected).toBe(false);

    // Step 2: Failure response - observer SHOULD trigger
    failureDetected = false;
    middleware.transformParams(threadId, 2, [
      { role: "user", content: "Try again" },
    ]);
    await middleware.afterGenerate(threadId, {
      text: "An error occurred while processing",
    });
    expect(failureDetected).toBe(true);

    // Step 3: Check correction was injected
    const enriched = middleware.transformParams(threadId, 3, [
      { role: "user", content: "What happened?" },
    ]);
    const observerContext = enriched.find((m) =>
      m.content.includes("observer-context")
    );
    expect(observerContext).toBeDefined();
    expect(observerContext!.content).toContain("CORRECTION");
    expect(observerContext!.content).toContain("retry with different approach");
  });

  test("should handle working memory persistence across steps", async () => {
    const workingMemorySnapshots: Record<string, unknown>[] = [];

    const middleware = createObserverMiddleware({
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
      onTrigger: async (snapshot) => {
        workingMemorySnapshots.push({ ...snapshot.workingMemory });
      },
    });

    const threadId = "memory-thread";

    // Step 1 with initial memory
    middleware.transformParams(threadId, 1, [
      { role: "user", content: "Start" },
    ]);
    await middleware.afterGenerate(
      threadId,
      { text: "Started" },
      { taskId: "task-1", progress: 0 }
    );

    // Step 2 with updated memory
    middleware.transformParams(threadId, 2, [
      { role: "user", content: "Continue" },
    ]);
    await middleware.afterGenerate(
      threadId,
      { text: "Continuing" },
      { taskId: "task-1", progress: 50, items: ["a", "b"] }
    );

    // Check working memory was captured correctly
    expect(workingMemorySnapshots.length).toBe(2);
    expect(workingMemorySnapshots[0]).toEqual({ taskId: "task-1", progress: 0 });
    expect(workingMemorySnapshots[1]).toEqual({
      taskId: "task-1",
      progress: 50,
      items: ["a", "b"],
    });
  });

  test("should provide complete tool call information to observer", async () => {
    let capturedSnapshot: StepSnapshot | null = null;

    const middleware = createObserverMiddleware({
      store,
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 3,
        minConfidence: 0.5,
      },
      trigger: {
        mode: "on-tool-call",
        async: false,
      },
      onTrigger: async (snapshot) => {
        capturedSnapshot = snapshot;
      },
    });

    const threadId = "tool-thread";

    middleware.transformParams(threadId, 1, [
      { role: "user", content: "Search for something" },
    ]);

    await middleware.afterGenerate(threadId, {
      text: "Searching...",
      toolCalls: [
        { name: "web_search", args: { query: "AI news", limit: 10 } },
        { name: "fetch_url", args: { url: "https://example.com" } },
      ],
      toolResults: [
        { name: "web_search", result: { results: ["item1", "item2"] } },
        { name: "fetch_url", result: { content: "Page content" } },
      ],
    });

    expect(capturedSnapshot).not.toBeNull();
    expect(capturedSnapshot!.response.toolCalls).toHaveLength(2);
    expect(capturedSnapshot!.response.toolCalls![0]!.name).toBe("web_search");
    expect(capturedSnapshot!.response.toolResults).toHaveLength(2);
    expect(capturedSnapshot!.response.toolResults![0]!.result).toEqual({
      results: ["item1", "item2"],
    });
  });
});

describe("Integration: Edge cases", () => {
  let store: InMemoryMailboxStore;

  beforeEach(() => {
    store = new InMemoryMailboxStore();
  });

  test("should handle empty prompt gracefully", async () => {
    const middleware = createObserverMiddleware({
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
    });

    const enriched = middleware.transformParams("thread", 1, []);
    expect(enriched).toEqual([]);
  });

  test("should handle no onTrigger callback", async () => {
    const middleware = createObserverMiddleware({
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
      // No onTrigger provided
    });

    // Should not throw
    middleware.transformParams("thread", 1, [{ role: "user", content: "Hello" }]);
    await middleware.afterGenerate("thread", { text: "Hi" });
  });

  test("should handle very long content with sanitization", async () => {
    const middleware = createObserverMiddleware({
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
      onTrigger: async (snapshot) => {
        // Send very long content
        store.send({
          threadId: snapshot.threadId,
          from: "observer",
          sentAtStep: snapshot.stepNumber,
          sentAtTime: Date.now(),
          type: "insight",
          content: "x".repeat(20000), // Very long
          confidence: 0.8,
          expiresAtStep: snapshot.stepNumber + 5,
        });
      },
    });

    middleware.transformParams("thread", 1, [{ role: "user", content: "Hello" }]);
    await middleware.afterGenerate("thread", { text: "Hi" });

    // Step 2: Long content should be truncated
    const enriched = middleware.transformParams("thread", 2, [
      { role: "user", content: "Continue" },
    ]);
    const observerContext = enriched.find((m) =>
      m.content.includes("observer-context")
    );
    expect(observerContext).toBeDefined();
    // Content should be truncated (default max is 10000)
    expect(observerContext!.content.length).toBeLessThan(15000);
  });
});
