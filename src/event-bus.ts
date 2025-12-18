/**
 * Event Bus for Observability
 *
 * Provides a pub/sub system for monitoring mailbox activity.
 * Inspired by browser-use's watchdog pattern for continuous observation.
 */

import type { MailboxMessage, StepSnapshot, MessageType } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base event interface
 */
export interface BaseEvent {
  /** Event type discriminator */
  type: string;

  /** Timestamp when event occurred */
  timestamp: number;

  /** Thread ID if applicable */
  threadId?: string;
}

/**
 * Message sent to the mailbox
 */
export interface MessageSentEvent extends BaseEvent {
  type: "message:sent";
  message: MailboxMessage;
}

/**
 * Message read from the mailbox
 */
export interface MessageReadEvent extends BaseEvent {
  type: "message:read";
  messageIds: string[];
  step: number;
}

/**
 * Message expired from the mailbox
 */
export interface MessageExpiredEvent extends BaseEvent {
  type: "message:expired";
  messageIds: string[];
  step: number;
}

/**
 * Message deduplicated (not stored)
 */
export interface MessageDedupedEvent extends BaseEvent {
  type: "message:deduped";
  originalHash: string;
  duplicateContent: string;
}

/**
 * Messages injected into prompt
 */
export interface MessagesInjectedEvent extends BaseEvent {
  type: "messages:injected";
  messageCount: number;
  step: number;
}

/**
 * Observer triggered
 */
export interface ObserverTriggeredEvent extends BaseEvent {
  type: "observer:triggered";
  step: number;
  triggerReason: "every-step" | "on-change" | "on-failure";
  observerId?: string;
}

/**
 * Observer completed
 */
export interface ObserverCompletedEvent extends BaseEvent {
  type: "observer:completed";
  step: number;
  durationMs: number;
  observerId?: string;
  messagesGenerated: number;
}

/**
 * Observer failed
 */
export interface ObserverFailedEvent extends BaseEvent {
  type: "observer:failed";
  step: number;
  error: string;
  observerId?: string;
  retryCount: number;
}

/**
 * Retention applied
 */
export interface RetentionAppliedEvent extends BaseEvent {
  type: "retention:applied";
  keptCount: number;
  culledCount: number;
  stats: {
    culledByType: Record<MessageType, number>;
    culledByDedup: number;
    culledByConfidence: number;
  };
}

/**
 * Step completed
 */
export interface StepCompletedEvent extends BaseEvent {
  type: "step:completed";
  step: number;
  activeMessages: number;
  incorporatedMessages: number;
}

/**
 * Union of all event types
 */
export type MailboxEvent =
  | MessageSentEvent
  | MessageReadEvent
  | MessageExpiredEvent
  | MessageDedupedEvent
  | MessagesInjectedEvent
  | ObserverTriggeredEvent
  | ObserverCompletedEvent
  | ObserverFailedEvent
  | RetentionAppliedEvent
  | StepCompletedEvent;

/**
 * Event type string literals
 */
export type MailboxEventType = MailboxEvent["type"];

// ─────────────────────────────────────────────────────────────────────────────
// Event Handler Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handler function for a specific event type
 */
export type EventHandler<T extends MailboxEvent = MailboxEvent> = (event: T) => void | Promise<void>;

/**
 * Unsubscribe function returned when subscribing
 */
export type Unsubscribe = () => void;

/**
 * Event bus configuration
 */
export interface EventBusConfig {
  /** Maximum number of handlers per event type */
  maxHandlers?: number;

  /** Whether to catch and log handler errors */
  catchHandlerErrors?: boolean;

  /** Custom error logger */
  errorLogger?: (error: Error, event: MailboxEvent, handler: EventHandler) => void;

  /** Whether to emit events asynchronously */
  async?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Bus Implementation
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<EventBusConfig> = {
  maxHandlers: 100,
  catchHandlerErrors: true,
  errorLogger: (error, event) => {
    console.error(`[EventBus] Handler error for ${event.type}:`, error);
  },
  async: true,
};

/**
 * Event bus for mailbox observability.
 *
 * @example
 * ```typescript
 * const bus = new EventBus();
 *
 * // Subscribe to specific events
 * bus.on("message:sent", (event) => {
 *   console.log(`Message sent: ${event.message.content}`);
 * });
 *
 * // Subscribe to all events
 * bus.on("*", (event) => {
 *   metrics.increment(`mailbox.${event.type}`);
 * });
 *
 * // Emit events
 * bus.emit({
 *   type: "message:sent",
 *   timestamp: Date.now(),
 *   message: { ... },
 * });
 * ```
 */
export class EventBus {
  private config: Required<EventBusConfig>;
  private handlers: Map<string, Set<EventHandler>>;
  private wildcardHandlers: Set<EventHandler>;

  constructor(config: EventBusConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.handlers = new Map();
    this.wildcardHandlers = new Set();
  }

  /**
   * Subscribe to events of a specific type.
   * Use "*" to subscribe to all events.
   */
  on<T extends MailboxEventType>(
    type: T | "*",
    handler: EventHandler<Extract<MailboxEvent, { type: T }>>
  ): Unsubscribe {
    if (type === "*") {
      if (this.wildcardHandlers.size >= this.config.maxHandlers) {
        throw new Error(`Maximum wildcard handlers (${this.config.maxHandlers}) reached`);
      }
      this.wildcardHandlers.add(handler as EventHandler);
      return () => this.wildcardHandlers.delete(handler as EventHandler);
    }

    let handlers = this.handlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(type, handlers);
    }

    if (handlers.size >= this.config.maxHandlers) {
      throw new Error(`Maximum handlers for ${type} (${this.config.maxHandlers}) reached`);
    }

    handlers.add(handler as EventHandler);
    return () => handlers!.delete(handler as EventHandler);
  }

  /**
   * Subscribe to an event once.
   */
  once<T extends MailboxEventType>(
    type: T,
    handler: EventHandler<Extract<MailboxEvent, { type: T }>>
  ): Unsubscribe {
    let called = false;
    const unsubscribe = this.on(type, (event) => {
      if (called) return;
      called = true;
      unsubscribe();
      return handler(event as Extract<MailboxEvent, { type: T }>);
    });
    return unsubscribe;
  }

  /**
   * Emit an event to all subscribed handlers.
   */
  emit<T extends MailboxEvent>(event: T): void {
    const handlers = this.handlers.get(event.type) ?? new Set();
    const allHandlers = [...handlers, ...this.wildcardHandlers];

    for (const handler of allHandlers) {
      if (this.config.async) {
        this.executeAsync(handler, event);
      } else {
        this.executeSync(handler, event);
      }
    }
  }

  /**
   * Remove all handlers for a specific event type.
   */
  off(type: MailboxEventType | "*"): void {
    if (type === "*") {
      this.wildcardHandlers.clear();
    } else {
      this.handlers.delete(type);
    }
  }

  /**
   * Remove all handlers.
   */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }

  /**
   * Get the number of handlers for a specific event type.
   */
  listenerCount(type: MailboxEventType | "*"): number {
    if (type === "*") {
      return this.wildcardHandlers.size;
    }
    return (this.handlers.get(type)?.size ?? 0) + this.wildcardHandlers.size;
  }

  /**
   * Get all registered event types.
   */
  eventTypes(): MailboxEventType[] {
    return Array.from(this.handlers.keys()) as MailboxEventType[];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ───────────────────────────────────────────────────────────────────────────

  private executeAsync(handler: EventHandler, event: MailboxEvent): void {
    Promise.resolve()
      .then(() => handler(event))
      .catch((error) => {
        if (this.config.catchHandlerErrors) {
          this.config.errorLogger(error, event, handler);
        } else {
          throw error;
        }
      });
  }

  private executeSync(handler: EventHandler, event: MailboxEvent): void {
    try {
      const result = handler(event);
      if (result instanceof Promise) {
        result.catch((error) => {
          if (this.config.catchHandlerErrors) {
            this.config.errorLogger(error, event, handler);
          } else {
            throw error;
          }
        });
      }
    } catch (error) {
      if (this.config.catchHandlerErrors) {
        this.config.errorLogger(error as Error, event, handler);
      } else {
        throw error;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an event bus instance.
 */
export function createEventBus(config?: EventBusConfig): EventBus {
  return new EventBus(config);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a message sent event.
 */
export function messageSentEvent(
  message: MailboxMessage
): MessageSentEvent {
  return {
    type: "message:sent",
    timestamp: Date.now(),
    threadId: message.threadId,
    message,
  };
}

/**
 * Create a message read event.
 */
export function messageReadEvent(
  threadId: string,
  messageIds: string[],
  step: number
): MessageReadEvent {
  return {
    type: "message:read",
    timestamp: Date.now(),
    threadId,
    messageIds,
    step,
  };
}

/**
 * Create an observer triggered event.
 */
export function observerTriggeredEvent(
  threadId: string,
  step: number,
  triggerReason: "every-step" | "on-change" | "on-failure",
  observerId?: string
): ObserverTriggeredEvent {
  return {
    type: "observer:triggered",
    timestamp: Date.now(),
    threadId,
    step,
    triggerReason,
    observerId,
  };
}

/**
 * Create an observer completed event.
 */
export function observerCompletedEvent(
  threadId: string,
  step: number,
  durationMs: number,
  messagesGenerated: number,
  observerId?: string
): ObserverCompletedEvent {
  return {
    type: "observer:completed",
    timestamp: Date.now(),
    threadId,
    step,
    durationMs,
    observerId,
    messagesGenerated,
  };
}

/**
 * Create an observer failed event.
 */
export function observerFailedEvent(
  threadId: string,
  step: number,
  error: string,
  retryCount: number,
  observerId?: string
): ObserverFailedEvent {
  return {
    type: "observer:failed",
    timestamp: Date.now(),
    threadId,
    step,
    error,
    observerId,
    retryCount,
  };
}

/**
 * Create a step completed event.
 */
export function stepCompletedEvent(
  threadId: string,
  step: number,
  activeMessages: number,
  incorporatedMessages: number
): StepCompletedEvent {
  return {
    type: "step:completed",
    timestamp: Date.now(),
    threadId,
    step,
    activeMessages,
    incorporatedMessages,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics Collector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metrics collected from events.
 */
export interface MailboxMetrics {
  messagesSent: number;
  messagesRead: number;
  messagesExpired: number;
  messagesDeduplicated: number;
  observerTriggers: number;
  observerSuccesses: number;
  observerFailures: number;
  totalObserverDurationMs: number;
  stepsCompleted: number;
  retentionCulled: number;
}

/**
 * Simple metrics collector that subscribes to the event bus.
 *
 * @example
 * ```typescript
 * const bus = createEventBus();
 * const collector = createMetricsCollector(bus);
 *
 * // ... run your application ...
 *
 * console.log(collector.getMetrics());
 * // { messagesSent: 42, observerTriggers: 100, ... }
 * ```
 */
export class MetricsCollector {
  private metrics: MailboxMetrics;
  private unsubscribes: Unsubscribe[] = [];

  constructor(bus: EventBus) {
    this.metrics = {
      messagesSent: 0,
      messagesRead: 0,
      messagesExpired: 0,
      messagesDeduplicated: 0,
      observerTriggers: 0,
      observerSuccesses: 0,
      observerFailures: 0,
      totalObserverDurationMs: 0,
      stepsCompleted: 0,
      retentionCulled: 0,
    };

    this.subscribe(bus);
  }

  /**
   * Get current metrics.
   */
  getMetrics(): MailboxMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset all metrics to zero.
   */
  reset(): void {
    this.metrics = {
      messagesSent: 0,
      messagesRead: 0,
      messagesExpired: 0,
      messagesDeduplicated: 0,
      observerTriggers: 0,
      observerSuccesses: 0,
      observerFailures: 0,
      totalObserverDurationMs: 0,
      stepsCompleted: 0,
      retentionCulled: 0,
    };
  }

  /**
   * Stop collecting metrics.
   */
  dispose(): void {
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];
  }

  private subscribe(bus: EventBus): void {
    this.unsubscribes.push(
      bus.on("message:sent", () => {
        this.metrics.messagesSent++;
      })
    );

    this.unsubscribes.push(
      bus.on("message:read", (event) => {
        this.metrics.messagesRead += event.messageIds.length;
      })
    );

    this.unsubscribes.push(
      bus.on("message:expired", (event) => {
        this.metrics.messagesExpired += event.messageIds.length;
      })
    );

    this.unsubscribes.push(
      bus.on("message:deduped", () => {
        this.metrics.messagesDeduplicated++;
      })
    );

    this.unsubscribes.push(
      bus.on("observer:triggered", () => {
        this.metrics.observerTriggers++;
      })
    );

    this.unsubscribes.push(
      bus.on("observer:completed", (event) => {
        this.metrics.observerSuccesses++;
        this.metrics.totalObserverDurationMs += event.durationMs;
      })
    );

    this.unsubscribes.push(
      bus.on("observer:failed", () => {
        this.metrics.observerFailures++;
      })
    );

    this.unsubscribes.push(
      bus.on("step:completed", () => {
        this.metrics.stepsCompleted++;
      })
    );

    this.unsubscribes.push(
      bus.on("retention:applied", (event) => {
        this.metrics.retentionCulled += event.culledCount;
      })
    );
  }
}

/**
 * Create a metrics collector for the event bus.
 */
export function createMetricsCollector(bus: EventBus): MetricsCollector {
  return new MetricsCollector(bus);
}
