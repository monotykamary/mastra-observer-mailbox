import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryMailboxStore } from "../store.ts";
import type { SendMessageInput } from "../types.ts";

describe("InMemoryMailboxStore", () => {
  let store: InMemoryMailboxStore;

  beforeEach(() => {
    store = new InMemoryMailboxStore();
  });

  describe("send()", () => {
    test("should add a message to the store", () => {
      const message: SendMessageInput = {
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "This is an insight",
        confidence: 0.8,
        expiresAtStep: null,
      };

      const result = store.send(message);

      expect(result).toBe(true);
      expect(store.getMessageCount("thread-1")).toBe(1);
    });

    test("should auto-generate id and contentHash", () => {
      const message: SendMessageInput = {
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "This is an insight",
        confidence: 0.8,
        expiresAtStep: null,
      };

      store.send(message);
      const messages = store.query("thread-1", { status: "all" });

      expect(messages.length).toBe(1);
      expect(messages[0]!.id).toBeDefined();
      expect(messages[0]!.contentHash).toBeDefined();
      expect(messages[0]!.incorporatedAtStep).toBeNull();
    });

    test("should deduplicate messages with same content within window", () => {
      const message: SendMessageInput = {
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Duplicate content",
        confidence: 0.8,
        expiresAtStep: null,
      };

      const result1 = store.send(message);
      const result2 = store.send({ ...message, sentAtStep: 2 });

      expect(result1).toBe(true);
      expect(result2).toBe(false);
      expect(store.getMessageCount("thread-1")).toBe(1);
    });

    test("should allow same content outside deduplication window", () => {
      const store = new InMemoryMailboxStore({ dedupeWindowSteps: 2 });

      const message: SendMessageInput = {
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Duplicate content",
        confidence: 0.8,
        expiresAtStep: null,
      };

      const result1 = store.send(message);
      const result2 = store.send({ ...message, sentAtStep: 5 }); // Outside window

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(store.getMessageCount("thread-1")).toBe(2);
    });

    test("should set default TTL if not specified", () => {
      const store = new InMemoryMailboxStore({ defaultTtlSteps: 5 });

      const message: SendMessageInput = {
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 3,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test",
        confidence: 0.8,
        expiresAtStep: null, // Should be set to sentAtStep + defaultTtlSteps
      };

      store.send(message);
      const messages = store.query("thread-1", { status: "all" });

      expect(messages[0]!.expiresAtStep).toBe(8); // 3 + 5
    });

    test("should respect custom expiresAtStep", () => {
      const message: SendMessageInput = {
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test",
        confidence: 0.8,
        expiresAtStep: 100,
      };

      store.send(message);
      const messages = store.query("thread-1", { status: "all" });

      expect(messages[0]!.expiresAtStep).toBe(100);
    });

    test("should enforce maxMessagesPerThread", () => {
      const store = new InMemoryMailboxStore({ maxMessagesPerThread: 3 });

      for (let i = 0; i < 5; i++) {
        store.send({
          threadId: "thread-1",
          from: "observer-1",
          sentAtStep: i,
          sentAtTime: Date.now(),
          type: "insight",
          content: `Message ${i}`,
          confidence: 0.8,
          expiresAtStep: null,
        });
      }

      expect(store.getMessageCount("thread-1")).toBe(3);
    });
  });

  describe("query()", () => {
    beforeEach(() => {
      // Add test messages
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Insight 1",
        confidence: 0.9,
        expiresAtStep: 20,
      });

      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 2,
        sentAtTime: Date.now(),
        type: "warning",
        content: "Warning 1",
        confidence: 0.7,
        expiresAtStep: 20,
      });

      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 3,
        sentAtTime: Date.now(),
        type: "correction",
        content: "Correction 1",
        confidence: 0.5,
        expiresAtStep: 20,
      });
    });

    test("should return all messages with status=all", () => {
      const messages = store.query("thread-1", { status: "all" });
      expect(messages.length).toBe(3);
    });

    test("should return only pending messages with status=pending", () => {
      // Mark one as incorporated
      const all = store.query("thread-1", { status: "all" });
      store.markIncorporated([all[0]!.id], 4);

      const pending = store.query("thread-1", { status: "pending" });
      expect(pending.length).toBe(2);
    });

    test("should return only incorporated messages with status=incorporated", () => {
      const all = store.query("thread-1", { status: "all" });
      store.markIncorporated([all[0]!.id], 4);

      const incorporated = store.query("thread-1", { status: "incorporated" });
      expect(incorporated.length).toBe(1);
    });

    test("should filter by minConfidence", () => {
      const messages = store.query("thread-1", {
        status: "all",
        minConfidence: 0.8,
      });

      expect(messages.length).toBe(1);
      expect(messages[0]!.confidence).toBeGreaterThanOrEqual(0.8);
    });

    test("should filter by types", () => {
      const messages = store.query("thread-1", {
        status: "all",
        types: ["insight", "warning"],
      });

      expect(messages.length).toBe(2);
      expect(messages.every((m) => ["insight", "warning"].includes(m.type))).toBe(
        true
      );
    });

    test("should filter by newerThanStep", () => {
      const messages = store.query("thread-1", {
        status: "all",
        newerThanStep: 2,
      });

      expect(messages.length).toBe(1);
      expect(messages[0]!.sentAtStep).toBe(3);
    });

    test("should apply limit", () => {
      const messages = store.query("thread-1", {
        status: "all",
        limit: 2,
      });

      expect(messages.length).toBe(2);
    });

    test("should sort by confidence (descending) then by step (descending)", () => {
      const messages = store.query("thread-1", { status: "all" });

      // Highest confidence first
      expect(messages[0]!.confidence).toBe(0.9);
      expect(messages[1]!.confidence).toBe(0.7);
      expect(messages[2]!.confidence).toBe(0.5);
    });

    test("should exclude expired messages", () => {
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Expired message",
        confidence: 0.99,
        expiresAtStep: 2, // Expires at step 2
      });

      const messages = store.query("thread-1", {
        status: "all",
        newerThanStep: 3, // Current step is 3+
      });

      // The expired message should not be included
      const expired = messages.find((m) => m.content === "Expired message");
      expect(expired).toBeUndefined();
    });

    test("should return empty array for unknown thread", () => {
      const messages = store.query("unknown-thread");
      expect(messages).toEqual([]);
    });
  });

  describe("markIncorporated()", () => {
    test("should mark messages as incorporated", () => {
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test",
        confidence: 0.8,
        expiresAtStep: null,
      });

      const messages = store.query("thread-1", { status: "all" });
      const messageId = messages[0]!.id;

      store.markIncorporated([messageId], 5);

      const updated = store.query("thread-1", { status: "all" });
      expect(updated[0]!.incorporatedAtStep).toBe(5);
    });

    test("should mark multiple messages at once", () => {
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test 1",
        confidence: 0.8,
        expiresAtStep: null,
      });

      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 2,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test 2",
        confidence: 0.8,
        expiresAtStep: null,
      });

      const messages = store.query("thread-1", { status: "all" });
      const ids = messages.map((m) => m.id);

      store.markIncorporated(ids, 5);

      const pending = store.query("thread-1", { status: "pending" });
      expect(pending.length).toBe(0);
    });
  });

  describe("storeSnapshot() and getSnapshots()", () => {
    test("should store and retrieve snapshots", () => {
      store.storeSnapshot({
        threadId: "thread-1",
        stepNumber: 1,
        timestamp: Date.now(),
        promptMessages: [{ role: "user", content: "Hello" }],
        workingMemory: {},
        response: { text: "Hi there" },
        incorporatedMessageIds: [],
      });

      const snapshots = store.getSnapshots("thread-1", 10);
      expect(snapshots.length).toBe(1);
      expect(snapshots[0]!.stepNumber).toBe(1);
    });

    test("should limit snapshot retention", () => {
      const store = new InMemoryMailboxStore({ snapshotRetentionSteps: 3 });

      for (let i = 0; i < 5; i++) {
        store.storeSnapshot({
          threadId: "thread-1",
          stepNumber: i,
          timestamp: Date.now(),
          promptMessages: [],
          workingMemory: {},
          response: {},
          incorporatedMessageIds: [],
        });
      }

      const snapshots = store.getSnapshots("thread-1", 10);
      expect(snapshots.length).toBe(3);
      // Should keep most recent
      expect(snapshots[0]!.stepNumber).toBe(2);
      expect(snapshots[2]!.stepNumber).toBe(4);
    });

    test("should return limited snapshots", () => {
      for (let i = 0; i < 5; i++) {
        store.storeSnapshot({
          threadId: "thread-1",
          stepNumber: i,
          timestamp: Date.now(),
          promptMessages: [],
          workingMemory: {},
          response: {},
          incorporatedMessageIds: [],
        });
      }

      const snapshots = store.getSnapshots("thread-1", 2);
      expect(snapshots.length).toBe(2);
      // Should return most recent
      expect(snapshots[0]!.stepNumber).toBe(3);
      expect(snapshots[1]!.stepNumber).toBe(4);
    });
  });

  describe("gc()", () => {
    test("should remove expired messages", () => {
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test",
        confidence: 0.8,
        expiresAtStep: 5,
      });

      expect(store.getMessageCount("thread-1")).toBe(1);

      store.gc("thread-1", 6);

      expect(store.getMessageCount("thread-1")).toBe(0);
    });

    test("should remove old incorporated messages", () => {
      const store = new InMemoryMailboxStore({ snapshotRetentionSteps: 3 });

      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test",
        confidence: 0.8,
        expiresAtStep: 100, // Won't expire by TTL
      });

      const messages = store.query("thread-1", { status: "all" });
      store.markIncorporated([messages[0]!.id], 2);

      expect(store.getMessageCount("thread-1")).toBe(1);

      // GC at step 10 (incorporated at 2, retention is 3, so 2 < 10 - 3)
      store.gc("thread-1", 10);

      expect(store.getMessageCount("thread-1")).toBe(0);
    });

    test("should keep pending messages within TTL", () => {
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test",
        confidence: 0.8,
        expiresAtStep: 20,
      });

      store.gc("thread-1", 10);

      expect(store.getMessageCount("thread-1")).toBe(1);
    });
  });

  describe("clearThread() and clear()", () => {
    test("should clear a specific thread", () => {
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test",
        confidence: 0.8,
        expiresAtStep: null,
      });

      store.send({
        threadId: "thread-2",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test",
        confidence: 0.8,
        expiresAtStep: null,
      });

      store.clearThread("thread-1");

      expect(store.getMessageCount("thread-1")).toBe(0);
      expect(store.getMessageCount("thread-2")).toBe(1);
    });

    test("should clear all data", () => {
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test",
        confidence: 0.8,
        expiresAtStep: null,
      });

      store.send({
        threadId: "thread-2",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Test",
        confidence: 0.8,
        expiresAtStep: null,
      });

      store.clear();

      expect(store.getMessageCount("thread-1")).toBe(0);
      expect(store.getMessageCount("thread-2")).toBe(0);
    });
  });

  describe("thread isolation", () => {
    test("should isolate messages between threads", () => {
      store.send({
        threadId: "thread-1",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Thread 1 message",
        confidence: 0.8,
        expiresAtStep: null,
      });

      store.send({
        threadId: "thread-2",
        from: "observer-1",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "insight",
        content: "Thread 2 message",
        confidence: 0.8,
        expiresAtStep: null,
      });

      const thread1Messages = store.query("thread-1", { status: "all" });
      const thread2Messages = store.query("thread-2", { status: "all" });

      expect(thread1Messages.length).toBe(1);
      expect(thread2Messages.length).toBe(1);
      expect(thread1Messages[0]!.content).toBe("Thread 1 message");
      expect(thread2Messages[0]!.content).toBe("Thread 2 message");
    });
  });
});
