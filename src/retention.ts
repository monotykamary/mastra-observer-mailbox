/**
 * Type-Based Retention Policies
 *
 * Smart culling of messages based on type, inspired by magnitude's
 * observation retention patterns.
 */

import type { MailboxMessage, MessageType } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retention policy for a specific message type
 */
export interface RetentionPolicy {
  /** Message type this policy applies to */
  type: MessageType;

  /** Maximum number of messages of this type to keep */
  maxCount?: number;

  /** Whether to deduplicate adjacent identical messages */
  dedupe?: boolean;

  /** Priority for keeping messages: newest, highest-confidence, or oldest */
  priority?: "newest" | "highest-confidence" | "oldest";

  /** Minimum confidence to keep (messages below this are culled first) */
  minConfidence?: number;
}

/**
 * Result of applying retention policies
 */
export interface RetentionResult {
  /** Messages to keep */
  keep: MailboxMessage[];

  /** Messages to cull */
  cull: MailboxMessage[];

  /** Statistics about the culling */
  stats: {
    totalInput: number;
    totalKept: number;
    culledByType: Record<MessageType, number>;
    culledByDedup: number;
    culledByConfidence: number;
  };
}

/**
 * Configuration for the retention manager
 */
export interface RetentionManagerConfig {
  /** Policies for each message type */
  policies: RetentionPolicy[];

  /** Default policy for types without explicit policy */
  defaultPolicy?: Omit<RetentionPolicy, "type">;

  /** Global maximum messages across all types */
  globalMaxMessages?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_RETENTION_POLICIES: RetentionPolicy[] = [
  {
    type: "insight",
    maxCount: 5,
    dedupe: true,
    priority: "highest-confidence",
  },
  {
    type: "correction",
    maxCount: 3,
    dedupe: true,
    priority: "newest",
  },
  {
    type: "warning",
    maxCount: 3,
    dedupe: true,
    priority: "newest",
  },
  {
    type: "context",
    maxCount: 2,
    dedupe: true,
    priority: "newest",
  },
];

export const DEFAULT_RETENTION_CONFIG: RetentionManagerConfig = {
  policies: DEFAULT_RETENTION_POLICIES,
  defaultPolicy: {
    maxCount: 5,
    dedupe: true,
    priority: "newest",
  },
  globalMaxMessages: 15,
};

// ─────────────────────────────────────────────────────────────────────────────
// Retention Manager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages message retention based on type-specific policies.
 *
 * @example
 * ```typescript
 * const manager = new RetentionManager({
 *   policies: [
 *     { type: 'insight', maxCount: 3, dedupe: true },
 *     { type: 'warning', maxCount: 2, priority: 'newest' },
 *   ],
 *   globalMaxMessages: 10,
 * });
 *
 * const result = manager.apply(messages);
 * // result.keep - messages to inject
 * // result.cull - messages to remove
 * ```
 */
export class RetentionManager {
  private config: RetentionManagerConfig;
  private policyMap: Map<MessageType, RetentionPolicy>;

  constructor(config: Partial<RetentionManagerConfig> = {}) {
    this.config = { ...DEFAULT_RETENTION_CONFIG, ...config };

    // Build policy lookup map
    this.policyMap = new Map();
    for (const policy of this.config.policies) {
      this.policyMap.set(policy.type, policy);
    }
  }

  /**
   * Apply retention policies to a list of messages.
   */
  apply(messages: MailboxMessage[]): RetentionResult {
    const stats = {
      totalInput: messages.length,
      totalKept: 0,
      culledByType: {} as Record<MessageType, number>,
      culledByDedup: 0,
      culledByConfidence: 0,
    };

    // Initialize stats
    for (const type of ["insight", "correction", "warning", "context"] as MessageType[]) {
      stats.culledByType[type] = 0;
    }

    // Group messages by type
    const byType = this.groupByType(messages);

    // Apply type-specific policies
    const keptByType = new Map<MessageType, MailboxMessage[]>();
    const culledByType = new Map<MessageType, MailboxMessage[]>();

    for (const [type, typeMessages] of byType) {
      const policy = this.getPolicy(type);
      const { keep, cull, dedupCulled, confidenceCulled } = this.applyPolicy(
        typeMessages,
        policy
      );

      keptByType.set(type, keep);
      culledByType.set(type, cull);
      stats.culledByType[type] = cull.length;
      stats.culledByDedup += dedupCulled;
      stats.culledByConfidence += confidenceCulled;
    }

    // Flatten kept messages
    let keep = Array.from(keptByType.values()).flat();
    let cull = Array.from(culledByType.values()).flat();

    // Apply global limit
    if (this.config.globalMaxMessages && keep.length > this.config.globalMaxMessages) {
      // Sort by confidence and keep top N
      keep.sort((a, b) => b.confidence - a.confidence);
      const excess = keep.slice(this.config.globalMaxMessages);
      keep = keep.slice(0, this.config.globalMaxMessages);
      cull = [...cull, ...excess];
    }

    stats.totalKept = keep.length;

    return { keep, cull, stats };
  }

  /**
   * Get the policy for a message type.
   */
  getPolicy(type: MessageType): RetentionPolicy {
    const explicit = this.policyMap.get(type);
    if (explicit) return explicit;

    // Use default policy
    if (this.config.defaultPolicy) {
      return { type, ...this.config.defaultPolicy };
    }

    // Fallback
    return { type, maxCount: 5, dedupe: false, priority: "newest" };
  }

  /**
   * Update a policy for a specific type.
   */
  setPolicy(policy: RetentionPolicy): void {
    this.policyMap.set(policy.type, policy);

    // Update config
    const existing = this.config.policies.findIndex((p) => p.type === policy.type);
    if (existing >= 0) {
      this.config.policies[existing] = policy;
    } else {
      this.config.policies.push(policy);
    }
  }

  /**
   * Get current configuration.
   */
  getConfig(): RetentionManagerConfig {
    return { ...this.config };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ───────────────────────────────────────────────────────────────────────────

  private groupByType(messages: MailboxMessage[]): Map<MessageType, MailboxMessage[]> {
    const groups = new Map<MessageType, MailboxMessage[]>();

    for (const message of messages) {
      const existing = groups.get(message.type) ?? [];
      existing.push(message);
      groups.set(message.type, existing);
    }

    return groups;
  }

  private applyPolicy(
    messages: MailboxMessage[],
    policy: RetentionPolicy
  ): {
    keep: MailboxMessage[];
    cull: MailboxMessage[];
    dedupCulled: number;
    confidenceCulled: number;
  } {
    let keep = [...messages];
    let cull: MailboxMessage[] = [];
    let dedupCulled = 0;
    let confidenceCulled = 0;

    // Apply minimum confidence filter
    if (policy.minConfidence !== undefined) {
      const { passing, failing } = this.filterByConfidence(keep, policy.minConfidence);
      keep = passing;
      cull = [...cull, ...failing];
      confidenceCulled = failing.length;
    }

    // Apply deduplication
    if (policy.dedupe) {
      const { unique, duplicates } = this.deduplicate(keep);
      keep = unique;
      cull = [...cull, ...duplicates];
      dedupCulled = duplicates.length;
    }

    // Sort by priority
    keep = this.sortByPriority(keep, policy.priority ?? "newest");

    // Apply max count
    if (policy.maxCount !== undefined && keep.length > policy.maxCount) {
      const excess = keep.slice(policy.maxCount);
      keep = keep.slice(0, policy.maxCount);
      cull = [...cull, ...excess];
    }

    return { keep, cull, dedupCulled, confidenceCulled };
  }

  private filterByConfidence(
    messages: MailboxMessage[],
    minConfidence: number
  ): { passing: MailboxMessage[]; failing: MailboxMessage[] } {
    const passing: MailboxMessage[] = [];
    const failing: MailboxMessage[] = [];

    for (const message of messages) {
      if (message.confidence >= minConfidence) {
        passing.push(message);
      } else {
        failing.push(message);
      }
    }

    return { passing, failing };
  }

  private deduplicate(
    messages: MailboxMessage[]
  ): { unique: MailboxMessage[]; duplicates: MailboxMessage[] } {
    const unique: MailboxMessage[] = [];
    const duplicates: MailboxMessage[] = [];
    const seen = new Set<string>();

    // Sort by step first to keep newest of duplicates
    const sorted = [...messages].sort((a, b) => b.sentAtStep - a.sentAtStep);

    for (const message of sorted) {
      if (seen.has(message.contentHash)) {
        duplicates.push(message);
      } else {
        seen.add(message.contentHash);
        unique.push(message);
      }
    }

    return { unique, duplicates };
  }

  private sortByPriority(
    messages: MailboxMessage[],
    priority: "newest" | "highest-confidence" | "oldest"
  ): MailboxMessage[] {
    return [...messages].sort((a, b) => {
      switch (priority) {
        case "newest":
          return b.sentAtStep - a.sentAtStep;
        case "oldest":
          return a.sentAtStep - b.sentAtStep;
        case "highest-confidence":
          if (b.confidence !== a.confidence) {
            return b.confidence - a.confidence;
          }
          return b.sentAtStep - a.sentAtStep;
        default:
          return 0;
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a retention manager with default config.
 */
export function createRetentionManager(
  config?: Partial<RetentionManagerConfig>
): RetentionManager {
  return new RetentionManager(config);
}

/**
 * Apply retention policies to messages (convenience function).
 */
export function applyRetention(
  messages: MailboxMessage[],
  config?: Partial<RetentionManagerConfig>
): RetentionResult {
  const manager = new RetentionManager(config);
  return manager.apply(messages);
}
