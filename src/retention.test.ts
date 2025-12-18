/**
 * Retention Policy Tests
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { MailboxMessage, MessageType } from "./types.ts";
import {
  RetentionManager,
  createRetentionManager,
  applyRetention,
  DEFAULT_RETENTION_POLICIES,
  DEFAULT_RETENTION_CONFIG,
} from "./retention.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createMessage(
  overrides: Partial<MailboxMessage> & { type: MessageType }
): MailboxMessage {
  const base: MailboxMessage = {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    threadId: "thread-1",
    from: "observer-1",
    sentAtStep: 1,
    sentAtTime: Date.now(),
    type: "insight",
    content: "Test message",
    confidence: 0.8,
    status: "active",
    expiresAtStep: null,
    contentHash: `hash-${Math.random().toString(36).slice(2)}`,
  };
  return { ...base, ...overrides };
}

function createMessages(
  type: MessageType,
  count: number,
  options: { confidence?: number; contentHash?: string; stepOffset?: number } = {}
): MailboxMessage[] {
  return Array.from({ length: count }, (_, i) =>
    createMessage({
      type,
      id: `${type}-${i}`,
      confidence: options.confidence ?? 0.8,
      contentHash: options.contentHash ?? `hash-${type}-${i}`,
      sentAtStep: (options.stepOffset ?? 0) + i,
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("RetentionManager", () => {
  let manager: RetentionManager;

  beforeEach(() => {
    manager = new RetentionManager();
  });

  describe("constructor", () => {
    it("should use default config when none provided", () => {
      const config = manager.getConfig();
      expect(config.policies).toEqual(DEFAULT_RETENTION_POLICIES);
      expect(config.globalMaxMessages).toBe(15);
    });

    it("should merge custom config with defaults", () => {
      const custom = new RetentionManager({
        globalMaxMessages: 20,
      });
      const config = custom.getConfig();
      expect(config.globalMaxMessages).toBe(20);
      expect(config.policies).toEqual(DEFAULT_RETENTION_POLICIES);
    });
  });

  describe("apply", () => {
    it("should return all messages when under limits", () => {
      const messages = [
        createMessage({ type: "insight" }),
        createMessage({ type: "warning" }),
      ];

      const result = manager.apply(messages);

      expect(result.keep.length).toBe(2);
      expect(result.cull.length).toBe(0);
      expect(result.stats.totalInput).toBe(2);
      expect(result.stats.totalKept).toBe(2);
    });

    it("should apply maxCount per type", () => {
      // Default insight maxCount is 5
      const insights = createMessages("insight", 10);

      const result = manager.apply(insights);

      expect(result.keep.length).toBe(5);
      expect(result.cull.length).toBe(5);
      expect(result.stats.culledByType.insight).toBe(5);
    });

    it("should apply globalMaxMessages limit", () => {
      const manager = new RetentionManager({ globalMaxMessages: 5 });
      const insights = createMessages("insight", 3);
      const warnings = createMessages("warning", 3);
      const messages = [...insights, ...warnings];

      const result = manager.apply(messages);

      expect(result.keep.length).toBe(5);
      expect(result.cull.length).toBe(1);
    });

    it("should deduplicate messages with same contentHash", () => {
      const messages = [
        createMessage({ type: "insight", contentHash: "same-hash", sentAtStep: 1 }),
        createMessage({ type: "insight", contentHash: "same-hash", sentAtStep: 2 }),
        createMessage({ type: "insight", contentHash: "same-hash", sentAtStep: 3 }),
      ];

      const result = manager.apply(messages);

      expect(result.keep.length).toBe(1);
      expect(result.stats.culledByDedup).toBe(2);
      // Should keep the newest (step 3)
      expect(result.keep[0]!.sentAtStep).toBe(3);
    });

    it("should filter by minimum confidence", () => {
      const manager = new RetentionManager({
        policies: [
          { type: "insight", minConfidence: 0.7 },
        ],
      });

      const messages = [
        createMessage({ type: "insight", confidence: 0.9 }),
        createMessage({ type: "insight", confidence: 0.5 }),
        createMessage({ type: "insight", confidence: 0.8 }),
      ];

      const result = manager.apply(messages);

      expect(result.keep.length).toBe(2);
      expect(result.stats.culledByConfidence).toBe(1);
      expect(result.keep.every((m) => m.confidence >= 0.7)).toBe(true);
    });

    it("should sort by newest priority", () => {
      const manager = new RetentionManager({
        policies: [
          { type: "warning", maxCount: 2, priority: "newest" },
        ],
      });

      const messages = [
        createMessage({ type: "warning", sentAtStep: 1, id: "old" }),
        createMessage({ type: "warning", sentAtStep: 3, id: "newest" }),
        createMessage({ type: "warning", sentAtStep: 2, id: "middle" }),
      ];

      const result = manager.apply(messages);

      expect(result.keep.length).toBe(2);
      expect(result.keep[0]!.id).toBe("newest");
      expect(result.keep[1]!.id).toBe("middle");
    });

    it("should sort by oldest priority", () => {
      const manager = new RetentionManager({
        policies: [
          { type: "context", maxCount: 2, priority: "oldest" },
        ],
      });

      const messages = [
        createMessage({ type: "context", sentAtStep: 3, id: "newest" }),
        createMessage({ type: "context", sentAtStep: 1, id: "oldest" }),
        createMessage({ type: "context", sentAtStep: 2, id: "middle" }),
      ];

      const result = manager.apply(messages);

      expect(result.keep.length).toBe(2);
      expect(result.keep[0]!.id).toBe("oldest");
      expect(result.keep[1]!.id).toBe("middle");
    });

    it("should sort by highest-confidence priority", () => {
      const manager = new RetentionManager({
        policies: [
          { type: "insight", maxCount: 2, priority: "highest-confidence" },
        ],
      });

      const messages = [
        createMessage({ type: "insight", confidence: 0.5, id: "low" }),
        createMessage({ type: "insight", confidence: 0.9, id: "high" }),
        createMessage({ type: "insight", confidence: 0.7, id: "medium" }),
      ];

      const result = manager.apply(messages);

      expect(result.keep.length).toBe(2);
      expect(result.keep[0]!.id).toBe("high");
      expect(result.keep[1]!.id).toBe("medium");
    });

    it("should use tiebreaker for highest-confidence priority", () => {
      const manager = new RetentionManager({
        policies: [
          { type: "insight", maxCount: 1, priority: "highest-confidence" },
        ],
      });

      const messages = [
        createMessage({ type: "insight", confidence: 0.8, sentAtStep: 1, id: "older" }),
        createMessage({ type: "insight", confidence: 0.8, sentAtStep: 2, id: "newer" }),
      ];

      const result = manager.apply(messages);

      expect(result.keep.length).toBe(1);
      // With same confidence, should prefer newer
      expect(result.keep[0]!.id).toBe("newer");
    });

    it("should handle empty messages array", () => {
      const result = manager.apply([]);

      expect(result.keep.length).toBe(0);
      expect(result.cull.length).toBe(0);
      expect(result.stats.totalInput).toBe(0);
    });

    it("should handle mixed message types", () => {
      const messages = [
        ...createMessages("insight", 3),
        ...createMessages("warning", 2),
        ...createMessages("correction", 1),
        ...createMessages("context", 1),
      ];

      const result = manager.apply(messages);

      expect(result.keep.length).toBe(7);
      expect(result.stats.totalKept).toBe(7);
    });
  });

  describe("getPolicy", () => {
    it("should return explicit policy for configured type", () => {
      const policy = manager.getPolicy("insight");
      expect(policy.type).toBe("insight");
      expect(policy.maxCount).toBe(5);
    });

    it("should return default policy for unconfigured type", () => {
      // Cast to MessageType since our types are strict
      const policy = manager.getPolicy("correction");
      expect(policy.type).toBe("correction");
      expect(policy.maxCount).toBe(3);
    });

    it("should use fallback when no default policy", () => {
      const manager = new RetentionManager({
        policies: [],
        defaultPolicy: undefined,
      });

      const policy = manager.getPolicy("insight");
      expect(policy.maxCount).toBe(5);
      expect(policy.dedupe).toBe(false);
    });
  });

  describe("setPolicy", () => {
    it("should update existing policy", () => {
      manager.setPolicy({ type: "insight", maxCount: 10 });

      const policy = manager.getPolicy("insight");
      expect(policy.maxCount).toBe(10);
    });

    it("should add new policy", () => {
      const manager = new RetentionManager({ policies: [] });
      manager.setPolicy({ type: "warning", maxCount: 7, dedupe: true });

      const policy = manager.getPolicy("warning");
      expect(policy.maxCount).toBe(7);
      expect(policy.dedupe).toBe(true);
    });

    it("should reflect in getConfig", () => {
      manager.setPolicy({ type: "insight", maxCount: 15 });

      const config = manager.getConfig();
      const insightPolicy = config.policies.find((p) => p.type === "insight");
      expect(insightPolicy?.maxCount).toBe(15);
    });
  });

  describe("stats", () => {
    it("should track culled counts by type", () => {
      const manager = new RetentionManager({
        policies: [
          { type: "insight", maxCount: 2 },
          { type: "warning", maxCount: 1 },
        ],
      });

      const messages = [
        ...createMessages("insight", 5),
        ...createMessages("warning", 3),
      ];

      const result = manager.apply(messages);

      expect(result.stats.culledByType.insight).toBe(3);
      expect(result.stats.culledByType.warning).toBe(2);
    });

    it("should track dedup and confidence culls separately", () => {
      const manager = new RetentionManager({
        policies: [
          { type: "insight", dedupe: true, minConfidence: 0.7 },
        ],
      });

      const messages = [
        createMessage({ type: "insight", contentHash: "dup", confidence: 0.8 }),
        createMessage({ type: "insight", contentHash: "dup", confidence: 0.9 }),
        createMessage({ type: "insight", contentHash: "unique", confidence: 0.5 }),
      ];

      const result = manager.apply(messages);

      expect(result.stats.culledByDedup).toBe(1);
      expect(result.stats.culledByConfidence).toBe(1);
    });
  });
});

describe("createRetentionManager", () => {
  it("should create manager with default config", () => {
    const manager = createRetentionManager();
    expect(manager).toBeInstanceOf(RetentionManager);
  });

  it("should create manager with custom config", () => {
    const manager = createRetentionManager({ globalMaxMessages: 100 });
    const config = manager.getConfig();
    expect(config.globalMaxMessages).toBe(100);
  });
});

describe("applyRetention", () => {
  it("should apply retention in one call", () => {
    const messages = createMessages("insight", 10);

    const result = applyRetention(messages);

    // Default insight maxCount is 5
    expect(result.keep.length).toBeLessThanOrEqual(DEFAULT_RETENTION_CONFIG.globalMaxMessages!);
    expect(result.stats.totalInput).toBe(10);
  });

  it("should respect maxCount when explicitly set", () => {
    const messages = createMessages("insight", 10);

    const result = applyRetention(messages, {
      policies: [{ type: "insight", maxCount: 3 }],
      globalMaxMessages: 100,
    });

    expect(result.keep.length).toBe(3);
    expect(result.cull.length).toBe(7);
  });

  it("should accept custom config", () => {
    const messages = createMessages("insight", 10);

    const result = applyRetention(messages, {
      policies: [{ type: "insight", maxCount: 3 }],
    });

    expect(result.keep.length).toBeLessThanOrEqual(3);
  });
});

describe("DEFAULT_RETENTION_POLICIES", () => {
  it("should have policies for all main types", () => {
    const types = DEFAULT_RETENTION_POLICIES.map((p) => p.type);
    expect(types).toContain("insight");
    expect(types).toContain("correction");
    expect(types).toContain("warning");
    expect(types).toContain("context");
  });

  it("should have reasonable defaults", () => {
    // Check that policies array has content
    expect(DEFAULT_RETENTION_POLICIES.length).toBeGreaterThan(0);

    // Verify structure of policies
    for (const policy of DEFAULT_RETENTION_POLICIES) {
      expect(policy.type).toBeDefined();
      expect(typeof policy.type).toBe("string");
    }
  });
});

describe("DEFAULT_RETENTION_CONFIG", () => {
  it("should have a reasonable global limit", () => {
    expect(DEFAULT_RETENTION_CONFIG.globalMaxMessages).toBeGreaterThan(0);
    expect(DEFAULT_RETENTION_CONFIG.globalMaxMessages).toBeLessThanOrEqual(50);
  });

  it("should have default policy", () => {
    expect(DEFAULT_RETENTION_CONFIG.defaultPolicy).toBeDefined();
    expect(DEFAULT_RETENTION_CONFIG.defaultPolicy?.maxCount).toBeGreaterThan(0);
  });
});
