/**
 * Observer Registry
 *
 * A registry for managing multiple observers that can analyze step snapshots
 * and send insights to the mailbox. Inspired by browser-use's watchdog pattern.
 */

import type {
  StepSnapshot,
  SendMessageInput,
  MailboxStore,
  ThreadId,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result from an observer handler
 */
export interface ObserverResult {
  /** Messages to send to the mailbox */
  messages?: SendMessageInput[];
  /** If true, skip remaining observers (short-circuit) */
  skipRemainingObservers?: boolean;
}

/**
 * Configuration for an observer handler
 */
export interface ObserverHandler {
  /** Unique identifier for this observer */
  id: string;
  /** Human-readable name */
  name: string;
  /** Priority (higher runs first) */
  priority: number;
  /** Optional filter to determine if this observer should run */
  filter?: (snapshot: StepSnapshot) => boolean;
  /** The handler function that analyzes the snapshot */
  handle: (snapshot: StepSnapshot) => Promise<ObserverResult> | ObserverResult;
}

/**
 * Result from dispatching to all observers
 */
export interface DispatchResult {
  /** Total number of observers that ran */
  observersRun: number;
  /** Total number of messages sent */
  messagesSent: number;
  /** Observers that were skipped due to filter */
  observersSkipped: string[];
  /** Errors that occurred during dispatch */
  errors: Array<{ observerId: string; error: Error }>;
  /** Whether dispatch was short-circuited */
  shortCircuited: boolean;
}

/**
 * Configuration for the observer registry
 */
export interface ObserverRegistryConfig {
  /** The mailbox store to send messages to */
  store: MailboxStore;
  /** Whether to continue on error (default: true) */
  continueOnError?: boolean;
  /** Callback when an observer errors */
  onObserverError?: (observerId: string, error: Error, snapshot: StepSnapshot) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Observer Registry Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registry for managing multiple observer handlers.
 *
 * Observers are executed in priority order (highest first).
 * Each observer can send messages to the mailbox and optionally
 * short-circuit remaining observers.
 *
 * @example
 * ```typescript
 * const registry = new ObserverRegistry({ store });
 *
 * registry.register({
 *   id: 'security-observer',
 *   name: 'Security Observer',
 *   priority: 100,
 *   filter: (snapshot) => snapshot.response.toolCalls?.length > 0,
 *   handle: async (snapshot) => {
 *     // Analyze for security issues
 *     return {
 *       messages: [{
 *         type: 'warning',
 *         content: 'Potential security issue detected',
 *         confidence: 0.8,
 *         ...
 *       }]
 *     };
 *   }
 * });
 * ```
 */
export class ObserverRegistry {
  private handlers = new Map<string, ObserverHandler>();
  private store: MailboxStore;
  private continueOnError: boolean;
  private onObserverError?: ObserverRegistryConfig["onObserverError"];

  constructor(config: ObserverRegistryConfig) {
    this.store = config.store;
    this.continueOnError = config.continueOnError ?? true;
    this.onObserverError = config.onObserverError;
  }

  /**
   * Register an observer handler.
   * Returns an unregister function.
   */
  register(handler: ObserverHandler): () => void {
    if (this.handlers.has(handler.id)) {
      throw new Error(`Observer with id "${handler.id}" already registered`);
    }
    this.handlers.set(handler.id, handler);

    return () => {
      this.unregister(handler.id);
    };
  }

  /**
   * Unregister an observer handler by ID.
   */
  unregister(id: string): boolean {
    return this.handlers.delete(id);
  }

  /**
   * Check if an observer is registered.
   */
  has(id: string): boolean {
    return this.handlers.has(id);
  }

  /**
   * Get a registered observer by ID.
   */
  get(id: string): ObserverHandler | undefined {
    return this.handlers.get(id);
  }

  /**
   * Get all registered observer IDs.
   */
  getIds(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Get all registered observers sorted by priority (highest first).
   */
  getHandlers(): ObserverHandler[] {
    return Array.from(this.handlers.values()).sort(
      (a, b) => b.priority - a.priority
    );
  }

  /**
   * Dispatch a snapshot to all registered observers.
   * Observers are executed in priority order (highest first).
   */
  async dispatch(snapshot: StepSnapshot): Promise<DispatchResult> {
    const result: DispatchResult = {
      observersRun: 0,
      messagesSent: 0,
      observersSkipped: [],
      errors: [],
      shortCircuited: false,
    };

    const handlers = this.getHandlers();

    for (const handler of handlers) {
      // Check filter
      if (handler.filter && !handler.filter(snapshot)) {
        result.observersSkipped.push(handler.id);
        continue;
      }

      try {
        const observerResult = await Promise.resolve(handler.handle(snapshot));
        result.observersRun++;

        // Send messages to mailbox
        if (observerResult.messages && observerResult.messages.length > 0) {
          for (const message of observerResult.messages) {
            // Ensure message has correct threadId
            const fullMessage: SendMessageInput = {
              ...message,
              threadId: snapshot.threadId,
              from: message.from || handler.id,
            };

            if (this.store.send(fullMessage)) {
              result.messagesSent++;
            }
          }
        }

        // Check for short-circuit
        if (observerResult.skipRemainingObservers) {
          result.shortCircuited = true;
          break;
        }
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        result.errors.push({ observerId: handler.id, error: err });

        if (this.onObserverError) {
          this.onObserverError(handler.id, err, snapshot);
        }

        if (!this.continueOnError) {
          throw err;
        }
      }
    }

    return result;
  }

  /**
   * Clear all registered observers.
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Get the number of registered observers.
   */
  get size(): number {
    return this.handlers.size;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an observer registry instance.
 */
export function createObserverRegistry(
  config: ObserverRegistryConfig
): ObserverRegistry {
  return new ObserverRegistry(config);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions for Creating Observers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a simple observer that runs a function on every snapshot.
 */
export function createSimpleObserver(
  id: string,
  name: string,
  handler: (snapshot: StepSnapshot) => Promise<SendMessageInput[]> | SendMessageInput[],
  options?: { priority?: number }
): ObserverHandler {
  return {
    id,
    name,
    priority: options?.priority ?? 50,
    handle: async (snapshot) => ({
      messages: await Promise.resolve(handler(snapshot)),
    }),
  };
}

/**
 * Create an observer that only runs when tool calls are present.
 */
export function createToolCallObserver(
  id: string,
  name: string,
  handler: (snapshot: StepSnapshot) => Promise<SendMessageInput[]> | SendMessageInput[],
  options?: { priority?: number; toolNames?: string[] }
): ObserverHandler {
  return {
    id,
    name,
    priority: options?.priority ?? 50,
    filter: (snapshot) => {
      const toolCalls = snapshot.response.toolCalls ?? [];
      if (toolCalls.length === 0) return false;

      // If specific tool names provided, check for match
      if (options?.toolNames && options.toolNames.length > 0) {
        return toolCalls.some((tc) => options.toolNames!.includes(tc.name));
      }

      return true;
    },
    handle: async (snapshot) => ({
      messages: await Promise.resolve(handler(snapshot)),
    }),
  };
}

/**
 * Create an observer that watches for specific keywords in responses.
 */
export function createKeywordObserver(
  id: string,
  name: string,
  keywords: string[],
  handler: (snapshot: StepSnapshot, matchedKeywords: string[]) => Promise<SendMessageInput[]> | SendMessageInput[],
  options?: { priority?: number; caseSensitive?: boolean }
): ObserverHandler {
  return {
    id,
    name,
    priority: options?.priority ?? 50,
    filter: (snapshot) => {
      const text = snapshot.response.text ?? "";
      const normalizedText = options?.caseSensitive ? text : text.toLowerCase();

      return keywords.some((keyword) => {
        const normalizedKeyword = options?.caseSensitive
          ? keyword
          : keyword.toLowerCase();
        return normalizedText.includes(normalizedKeyword);
      });
    },
    handle: async (snapshot) => {
      const text = snapshot.response.text ?? "";
      const normalizedText = options?.caseSensitive ? text : text.toLowerCase();

      const matchedKeywords = keywords.filter((keyword) => {
        const normalizedKeyword = options?.caseSensitive
          ? keyword
          : keyword.toLowerCase();
        return normalizedText.includes(normalizedKeyword);
      });

      return {
        messages: await Promise.resolve(handler(snapshot, matchedKeywords)),
      };
    },
  };
}
