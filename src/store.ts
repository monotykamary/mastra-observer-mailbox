/**
 * In-Memory Mailbox Store Implementation
 *
 * A queryable state store for observer messages with incorporation tracking,
 * deduplication, and TTL-based expiration.
 */

import type {
  MailboxStore,
  MailboxStoreConfig,
  MailboxMessage,
  StepSnapshot,
  SendMessageInput,
  QueryOptions,
  ThreadId,
  MessageId,
  StepNumber,
} from "./types.ts";
import { DEFAULT_MAILBOX_CONFIG } from "./types.ts";

/**
 * Compute a content hash for deduplication.
 * Uses a simple hash function suitable for in-memory deduplication.
 */
function computeContentHash(content: string): string {
  // Simple hash using Bun's crypto
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex").slice(0, 16);
}

/**
 * Generate a unique message ID
 */
function generateMessageId(): MessageId {
  return crypto.randomUUID();
}

/**
 * In-memory implementation of the MailboxStore interface.
 *
 * Features:
 * - Content-based deduplication within a configurable window
 * - TTL-based message expiration
 * - Configurable retention limits
 * - Thread-isolated storage
 */
export class InMemoryMailboxStore implements MailboxStore {
  private messages = new Map<ThreadId, MailboxMessage[]>();
  private snapshots = new Map<ThreadId, StepSnapshot[]>();
  private config: MailboxStoreConfig;

  constructor(config: Partial<MailboxStoreConfig> = {}) {
    this.config = { ...DEFAULT_MAILBOX_CONFIG, ...config };
  }

  /**
   * Send a message to an agent's mailbox.
   * Returns false if the message was deduplicated.
   */
  send(message: SendMessageInput): boolean {
    const threadMessages = this.messages.get(message.threadId) ?? [];

    // Compute content hash for deduplication
    const contentHash = computeContentHash(message.content);

    // Check for duplicates within deduplication window
    const isDuplicate = threadMessages.some(
      (m) =>
        m.contentHash === contentHash &&
        m.sentAtStep >= message.sentAtStep - this.config.dedupeWindowSteps
    );

    if (isDuplicate) {
      return false;
    }

    // Create full message with auto-generated fields
    const fullMessage: MailboxMessage = {
      ...message,
      id: generateMessageId(),
      contentHash,
      incorporatedAtStep: null,
      expiresAtStep:
        message.expiresAtStep ?? message.sentAtStep + this.config.defaultTtlSteps,
    };

    threadMessages.push(fullMessage);

    // Enforce max messages (drop oldest incorporated first)
    this.enforceMaxMessages(threadMessages);

    this.messages.set(message.threadId, threadMessages);
    return true;
  }

  /**
   * Store a snapshot for observer to analyze.
   */
  storeSnapshot(snapshot: StepSnapshot): void {
    const threadSnapshots = this.snapshots.get(snapshot.threadId) ?? [];
    threadSnapshots.push(snapshot);

    // Keep only recent snapshots
    if (threadSnapshots.length > this.config.snapshotRetentionSteps) {
      threadSnapshots.shift();
    }

    this.snapshots.set(snapshot.threadId, threadSnapshots);
  }

  /**
   * Query messages for a thread with optional filters.
   * Does NOT mark as incorporated (read is side-effect free).
   */
  query(threadId: ThreadId, opts: QueryOptions = {}): MailboxMessage[] {
    const messages = this.messages.get(threadId) ?? [];
    const currentStep = opts.newerThanStep ?? 0;

    let filtered = messages.filter((m) => {
      // Status filter
      if (opts.status === "pending" && m.incorporatedAtStep !== null) {
        return false;
      }
      if (opts.status === "incorporated" && m.incorporatedAtStep === null) {
        return false;
      }

      // Confidence filter
      if (opts.minConfidence !== undefined && m.confidence < opts.minConfidence) {
        return false;
      }

      // Type filter
      if (opts.types && !opts.types.includes(m.type)) {
        return false;
      }

      // Recency filter
      if (opts.newerThanStep !== undefined && m.sentAtStep <= opts.newerThanStep) {
        return false;
      }

      // Not expired
      if (m.expiresAtStep !== null && m.expiresAtStep <= currentStep) {
        return false;
      }

      return true;
    });

    // Sort by confidence (highest first), then by step (newest first)
    filtered.sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      return b.sentAtStep - a.sentAtStep;
    });

    // Apply limit
    if (opts.limit !== undefined) {
      filtered = filtered.slice(0, opts.limit);
    }

    return filtered;
  }

  /**
   * Mark messages as incorporated at the given step.
   */
  markIncorporated(messageIds: MessageId[], atStep: StepNumber): void {
    for (const [, messages] of this.messages) {
      for (const message of messages) {
        if (messageIds.includes(message.id)) {
          message.incorporatedAtStep = atStep;
        }
      }
    }
  }

  /**
   * Get recent snapshots for a thread.
   */
  getSnapshots(threadId: ThreadId, limit: number): StepSnapshot[] {
    const snapshots = this.snapshots.get(threadId) ?? [];
    return snapshots.slice(-limit);
  }

  /**
   * Remove expired messages and old snapshots.
   */
  gc(threadId: ThreadId, currentStep: StepNumber): void {
    const messages = this.messages.get(threadId);
    if (!messages) return;

    const remaining = messages.filter((m) => {
      // Remove expired messages
      if (m.expiresAtStep !== null && m.expiresAtStep <= currentStep) {
        return false;
      }

      // Remove old incorporated messages (keep for audit trail window)
      if (
        m.incorporatedAtStep !== null &&
        m.incorporatedAtStep < currentStep - this.config.snapshotRetentionSteps
      ) {
        return false;
      }

      return true;
    });

    this.messages.set(threadId, remaining);
  }

  /**
   * Clear all data for a thread (useful for testing or cleanup).
   */
  clearThread(threadId: ThreadId): void {
    this.messages.delete(threadId);
    this.snapshots.delete(threadId);
  }

  /**
   * Clear all data (useful for testing).
   */
  clear(): void {
    this.messages.clear();
    this.snapshots.clear();
  }

  /**
   * Get current configuration (useful for testing).
   */
  getConfig(): MailboxStoreConfig {
    return { ...this.config };
  }

  /**
   * Get message count for a thread (useful for monitoring).
   */
  getMessageCount(threadId: ThreadId): number {
    return this.messages.get(threadId)?.length ?? 0;
  }

  /**
   * Get snapshot count for a thread (useful for monitoring).
   */
  getSnapshotCount(threadId: ThreadId): number {
    return this.snapshots.get(threadId)?.length ?? 0;
  }

  /**
   * Enforce maximum messages per thread by removing oldest incorporated messages.
   */
  private enforceMaxMessages(messages: MailboxMessage[]): void {
    while (messages.length > this.config.maxMessagesPerThread) {
      // Find oldest incorporated message to remove
      const incorporated = messages.filter((m) => m.incorporatedAtStep !== null);

      if (incorporated.length > 0) {
        const oldest = incorporated.sort((a, b) => a.sentAtStep - b.sentAtStep)[0];
        const idx = messages.indexOf(oldest!);
        if (idx !== -1) {
          messages.splice(idx, 1);
          continue;
        }
      }

      // If no incorporated messages, remove oldest pending
      const oldest = messages.sort((a, b) => a.sentAtStep - b.sentAtStep)[0];
      const idx = messages.indexOf(oldest!);
      if (idx !== -1) {
        messages.splice(idx, 1);
      } else {
        // Safety: break if we can't remove anything
        break;
      }
    }
  }
}
