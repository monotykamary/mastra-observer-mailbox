/**
 * Event Bus Tests
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  EventBus,
  createEventBus,
  MetricsCollector,
  createMetricsCollector,
  messageSentEvent,
  messageReadEvent,
  observerTriggeredEvent,
  observerCompletedEvent,
  observerFailedEvent,
  stepCompletedEvent,
} from "./event-bus.ts";
import type {
  MailboxEvent,
  MessageSentEvent,
  ObserverCompletedEvent,
} from "./event-bus.ts";
import type { MailboxMessage } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createTestMessage(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: "msg-1",
    threadId: "thread-1",
    from: "observer-1",
    sentAtStep: 1,
    sentAtTime: Date.now(),
    type: "insight",
    content: "Test message",
    confidence: 0.8,
    status: "active",
    expiresAtStep: null,
    contentHash: "hash-1",
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe("on", () => {
    it("should subscribe to specific event type", async () => {
      const handler = mock(() => {});
      bus.on("message:sent", handler);

      const event = messageSentEvent(createTestMessage());
      bus.emit(event);

      await sleep(10);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should not receive events of other types", async () => {
      const handler = mock(() => {});
      bus.on("message:sent", handler);

      bus.emit({
        type: "message:read",
        timestamp: Date.now(),
        messageIds: ["msg-1"],
        step: 1,
      });

      await sleep(10);
      expect(handler).not.toHaveBeenCalled();
    });

    it("should support wildcard subscription", async () => {
      const handler = mock(() => {});
      bus.on("*", handler);

      bus.emit(messageSentEvent(createTestMessage()));
      bus.emit(messageReadEvent("thread-1", ["msg-1"], 1));

      await sleep(10);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("should return unsubscribe function", async () => {
      const handler = mock(() => {});
      const unsubscribe = bus.on("message:sent", handler);

      bus.emit(messageSentEvent(createTestMessage()));
      await sleep(10);
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      bus.emit(messageSentEvent(createTestMessage()));
      await sleep(10);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should support multiple handlers for same event", async () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});

      bus.on("message:sent", handler1);
      bus.on("message:sent", handler2);

      bus.emit(messageSentEvent(createTestMessage()));

      await sleep(10);
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("should throw when max handlers reached", () => {
      const bus = new EventBus({ maxHandlers: 2 });

      bus.on("message:sent", () => {});
      bus.on("message:sent", () => {});

      expect(() => {
        bus.on("message:sent", () => {});
      }).toThrow(/Maximum handlers/);
    });
  });

  describe("once", () => {
    it("should only receive event once", async () => {
      const handler = mock(() => {});
      bus.once("message:sent", handler);

      bus.emit(messageSentEvent(createTestMessage()));
      bus.emit(messageSentEvent(createTestMessage()));

      await sleep(10);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should return unsubscribe function", async () => {
      const handler = mock(() => {});
      const unsubscribe = bus.once("message:sent", handler);

      unsubscribe();
      bus.emit(messageSentEvent(createTestMessage()));

      await sleep(10);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("emit", () => {
    it("should emit to all subscribed handlers", async () => {
      const received: MailboxEvent[] = [];

      bus.on("message:sent", (event) => received.push(event));
      bus.on("*", (event) => received.push(event));

      const event = messageSentEvent(createTestMessage());
      bus.emit(event);

      await sleep(10);
      expect(received).toHaveLength(2);
      expect(received.every((e) => e === event)).toBe(true);
    });

    it("should handle async handlers", async () => {
      const results: number[] = [];

      bus.on("message:sent", async () => {
        await sleep(5);
        results.push(1);
      });

      bus.emit(messageSentEvent(createTestMessage()));

      expect(results).toHaveLength(0);
      await sleep(20);
      expect(results).toHaveLength(1);
    });
  });

  describe("error handling", () => {
    it("should catch handler errors by default", async () => {
      const errorLogger = mock(() => {});
      const bus = new EventBus({ errorLogger });

      bus.on("message:sent", () => {
        throw new Error("Handler error");
      });

      bus.emit(messageSentEvent(createTestMessage()));

      await sleep(10);
      expect(errorLogger).toHaveBeenCalled();
    });

    it("should rethrow errors when catchHandlerErrors is false", () => {
      const bus = new EventBus({ catchHandlerErrors: false, async: false });

      bus.on("message:sent", () => {
        throw new Error("Handler error");
      });

      expect(() => {
        bus.emit(messageSentEvent(createTestMessage()));
      }).toThrow("Handler error");
    });

    it("should continue with other handlers after error", async () => {
      const handler1 = mock(() => {
        throw new Error("Error in handler 1");
      });
      const handler2 = mock(() => {});

      bus.on("message:sent", handler1);
      bus.on("message:sent", handler2);

      bus.emit(messageSentEvent(createTestMessage()));

      await sleep(10);
      expect(handler2).toHaveBeenCalled();
    });
  });

  describe("off", () => {
    it("should remove all handlers for event type", async () => {
      const handler = mock(() => {});

      bus.on("message:sent", handler);
      bus.off("message:sent");
      bus.emit(messageSentEvent(createTestMessage()));

      await sleep(10);
      expect(handler).not.toHaveBeenCalled();
    });

    it("should remove wildcard handlers", async () => {
      const handler = mock(() => {});

      bus.on("*", handler);
      bus.off("*");
      bus.emit(messageSentEvent(createTestMessage()));

      await sleep(10);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("should remove all handlers", async () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});

      bus.on("message:sent", handler1);
      bus.on("*", handler2);
      bus.clear();

      bus.emit(messageSentEvent(createTestMessage()));

      await sleep(10);
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe("listenerCount", () => {
    it("should count handlers including wildcards", () => {
      bus.on("message:sent", () => {});
      bus.on("message:sent", () => {});
      bus.on("*", () => {});

      expect(bus.listenerCount("message:sent")).toBe(3);
      expect(bus.listenerCount("*")).toBe(1);
      expect(bus.listenerCount("message:read")).toBe(1); // Only wildcard
    });
  });

  describe("eventTypes", () => {
    it("should return registered event types", () => {
      bus.on("message:sent", () => {});
      bus.on("observer:triggered", () => {});

      const types = bus.eventTypes();
      expect(types).toContain("message:sent");
      expect(types).toContain("observer:triggered");
    });
  });

  describe("sync mode", () => {
    it("should execute handlers synchronously", () => {
      const bus = new EventBus({ async: false });
      const results: number[] = [];

      bus.on("message:sent", () => {
        results.push(1);
      });

      bus.emit(messageSentEvent(createTestMessage()));

      // Should be called synchronously
      expect(results).toHaveLength(1);
    });
  });
});

describe("createEventBus", () => {
  it("should create event bus instance", () => {
    const bus = createEventBus();
    expect(bus).toBeInstanceOf(EventBus);
  });

  it("should accept config", () => {
    const bus = createEventBus({ maxHandlers: 5 });
    expect(bus).toBeInstanceOf(EventBus);
  });
});

describe("Event Factory Functions", () => {
  describe("messageSentEvent", () => {
    it("should create message sent event", () => {
      const message = createTestMessage();
      const event = messageSentEvent(message);

      expect(event.type).toBe("message:sent");
      expect(event.message).toBe(message);
      expect(event.threadId).toBe(message.threadId);
      expect(event.timestamp).toBeGreaterThan(0);
    });
  });

  describe("messageReadEvent", () => {
    it("should create message read event", () => {
      const event = messageReadEvent("thread-1", ["msg-1", "msg-2"], 5);

      expect(event.type).toBe("message:read");
      expect(event.threadId).toBe("thread-1");
      expect(event.messageIds).toEqual(["msg-1", "msg-2"]);
      expect(event.step).toBe(5);
    });
  });

  describe("observerTriggeredEvent", () => {
    it("should create observer triggered event", () => {
      const event = observerTriggeredEvent("thread-1", 3, "every-step", "obs-1");

      expect(event.type).toBe("observer:triggered");
      expect(event.threadId).toBe("thread-1");
      expect(event.step).toBe(3);
      expect(event.triggerReason).toBe("every-step");
      expect(event.observerId).toBe("obs-1");
    });
  });

  describe("observerCompletedEvent", () => {
    it("should create observer completed event", () => {
      const event = observerCompletedEvent("thread-1", 3, 150, 2, "obs-1");

      expect(event.type).toBe("observer:completed");
      expect(event.durationMs).toBe(150);
      expect(event.messagesGenerated).toBe(2);
    });
  });

  describe("observerFailedEvent", () => {
    it("should create observer failed event", () => {
      const event = observerFailedEvent("thread-1", 3, "Network error", 2, "obs-1");

      expect(event.type).toBe("observer:failed");
      expect(event.error).toBe("Network error");
      expect(event.retryCount).toBe(2);
    });
  });

  describe("stepCompletedEvent", () => {
    it("should create step completed event", () => {
      const event = stepCompletedEvent("thread-1", 5, 10, 3);

      expect(event.type).toBe("step:completed");
      expect(event.step).toBe(5);
      expect(event.activeMessages).toBe(10);
      expect(event.incorporatedMessages).toBe(3);
    });
  });
});

describe("MetricsCollector", () => {
  let bus: EventBus;
  let collector: MetricsCollector;

  beforeEach(() => {
    bus = new EventBus();
    collector = new MetricsCollector(bus);
  });

  describe("getMetrics", () => {
    it("should return initial metrics as zeros", () => {
      const metrics = collector.getMetrics();

      expect(metrics.messagesSent).toBe(0);
      expect(metrics.observerTriggers).toBe(0);
      expect(metrics.stepsCompleted).toBe(0);
    });

    it("should count message sent events", async () => {
      bus.emit(messageSentEvent(createTestMessage()));
      bus.emit(messageSentEvent(createTestMessage()));

      await sleep(10);
      const metrics = collector.getMetrics();

      expect(metrics.messagesSent).toBe(2);
    });

    it("should count message read events", async () => {
      bus.emit(messageReadEvent("thread-1", ["msg-1", "msg-2"], 1));
      bus.emit(messageReadEvent("thread-1", ["msg-3"], 2));

      await sleep(10);
      const metrics = collector.getMetrics();

      expect(metrics.messagesRead).toBe(3);
    });

    it("should count observer events", async () => {
      bus.emit(observerTriggeredEvent("thread-1", 1, "every-step"));
      bus.emit(observerCompletedEvent("thread-1", 1, 100, 2));
      bus.emit(observerTriggeredEvent("thread-1", 2, "every-step"));
      bus.emit(observerFailedEvent("thread-1", 2, "Error", 0));

      await sleep(10);
      const metrics = collector.getMetrics();

      expect(metrics.observerTriggers).toBe(2);
      expect(metrics.observerSuccesses).toBe(1);
      expect(metrics.observerFailures).toBe(1);
      expect(metrics.totalObserverDurationMs).toBe(100);
    });

    it("should count step completed events", async () => {
      bus.emit(stepCompletedEvent("thread-1", 1, 5, 2));
      bus.emit(stepCompletedEvent("thread-1", 2, 7, 3));

      await sleep(10);
      const metrics = collector.getMetrics();

      expect(metrics.stepsCompleted).toBe(2);
    });
  });

  describe("reset", () => {
    it("should reset all metrics to zero", async () => {
      bus.emit(messageSentEvent(createTestMessage()));
      bus.emit(observerTriggeredEvent("thread-1", 1, "every-step"));

      await sleep(10);
      collector.reset();
      const metrics = collector.getMetrics();

      expect(metrics.messagesSent).toBe(0);
      expect(metrics.observerTriggers).toBe(0);
    });
  });

  describe("dispose", () => {
    it("should stop collecting after dispose", async () => {
      bus.emit(messageSentEvent(createTestMessage()));
      await sleep(10);

      collector.dispose();
      bus.emit(messageSentEvent(createTestMessage()));
      await sleep(10);

      const metrics = collector.getMetrics();
      expect(metrics.messagesSent).toBe(1);
    });
  });
});

describe("createMetricsCollector", () => {
  it("should create metrics collector", () => {
    const bus = createEventBus();
    const collector = createMetricsCollector(bus);

    expect(collector).toBeInstanceOf(MetricsCollector);
  });
});
