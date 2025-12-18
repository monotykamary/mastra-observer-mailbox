/**
 * Observer Mailbox Type Definitions
 *
 * A hybrid message-oriented store for passive, event-driven communication
 * between AI agents.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Primitive Types
// ─────────────────────────────────────────────────────────────────────────────

export type StepNumber = number;
export type AgentId = string;
export type ThreadId = string;
export type MessageId = string;

// ─────────────────────────────────────────────────────────────────────────────
// Message Types
// ─────────────────────────────────────────────────────────────────────────────

export type MessageType = "insight" | "correction" | "warning" | "context";

/**
 * A message in the mailbox. Immutable once created.
 */
export interface MailboxMessage {
  // Identity
  id: MessageId;
  threadId: ThreadId;

  // Origin
  from: AgentId;
  sentAtStep: StepNumber;
  sentAtTime: number;

  // Content
  type: MessageType;
  content: string;
  confidence: number;

  // Lifecycle (mutable by store only)
  incorporatedAtStep: StepNumber | null; // null = pending
  expiresAtStep: StepNumber | null; // null = never expires

  // Deduplication
  contentHash: string; // For detecting duplicates
}

/**
 * Input for sending a message (without auto-generated fields)
 */
export type SendMessageInput = Omit<
  MailboxMessage,
  "id" | "incorporatedAtStep" | "contentHash"
>;

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic message format for prompt messages
 */
export interface PromptMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  [key: string]: unknown;
}

/**
 * Tool call information
 */
export interface ToolCall {
  name: string;
  args: unknown;
}

/**
 * Tool result information
 */
export interface ToolResult {
  name: string;
  result: unknown;
}

/**
 * Snapshot of agent state, sent TO observer for analysis
 */
export interface StepSnapshot {
  threadId: ThreadId;
  stepNumber: StepNumber;
  timestamp: number;

  // What the main agent saw
  promptMessages: PromptMessage[];
  workingMemory: Record<string, unknown>;

  // What the main agent did
  response: {
    text?: string;
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
  };

  // What messages were incorporated this step
  incorporatedMessageIds: MessageId[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Types
// ─────────────────────────────────────────────────────────────────────────────

export type MessageStatus = "pending" | "incorporated" | "all";

export interface QueryOptions {
  status?: MessageStatus;
  minConfidence?: number;
  types?: MessageType[];
  limit?: number;
  newerThanStep?: StepNumber;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface MailboxStore {
  // ─────────────────────────────────────────────────────────────────────────
  // WRITE SIDE (called by observers)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a message to an agent's mailbox.
   * Non-blocking, append-only.
   * Returns false if deduplicated (same contentHash within window)
   */
  send(message: SendMessageInput): boolean;

  /**
   * Store a snapshot for observer to analyze.
   * Observers can query recent snapshots for context.
   */
  storeSnapshot(snapshot: StepSnapshot): void;

  // ─────────────────────────────────────────────────────────────────────────
  // READ SIDE (called by middleware at each tick)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Query pending messages for a thread.
   * Does NOT mark as incorporated (read is side-effect free)
   */
  query(threadId: ThreadId, opts?: QueryOptions): MailboxMessage[];

  /**
   * Mark messages as incorporated.
   * Called after successfully injecting into prompt.
   */
  markIncorporated(messageIds: MessageId[], atStep: StepNumber): void;

  /**
   * Get recent snapshots for observer context.
   */
  getSnapshots(threadId: ThreadId, limit: number): StepSnapshot[];

  // ─────────────────────────────────────────────────────────────────────────
  // MAINTENANCE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Remove expired messages and old snapshots.
   * Called periodically or at step boundaries.
   */
  gc(threadId: ThreadId, currentStep: StepNumber): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MailboxStoreConfig {
  /** How many steps back to check for dupes */
  dedupeWindowSteps: number;
  /** Hard limit on mailbox size */
  maxMessagesPerThread: number;
  /** How many snapshots to keep */
  snapshotRetentionSteps: number;
  /** Default expiry for messages */
  defaultTtlSteps: number;
}

export const DEFAULT_MAILBOX_CONFIG: MailboxStoreConfig = {
  dedupeWindowSteps: 5,
  maxMessagesPerThread: 50,
  snapshotRetentionSteps: 10,
  defaultTtlSteps: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Middleware Configuration Types
// ─────────────────────────────────────────────────────────────────────────────

export type InjectionTarget =
  | "system-prompt"
  | "user-message"
  | "end-of-history";

export type TriggerMode = "every-step" | "on-tool-call" | "on-failure";

export interface InjectionConfig {
  target: InjectionTarget;
  maxMessagesPerTurn: number;
  minConfidence: number;
}

export interface TriggerConfig {
  mode: TriggerMode;
  /** false = wait for observer before next step */
  async: boolean;
  /**
   * Custom failure detector for 'on-failure' mode.
   * If not provided, uses the default keyword-based detector with negation awareness.
   */
  failureDetector?: import("./failure-detection.ts").FailureDetector;
  /**
   * Maximum number of retry attempts for observer trigger on failure.
   * Default: 0 (no retries)
   */
  maxRetries?: number;
  /**
   * Base delay in milliseconds between retry attempts (exponential backoff).
   * Default: 100ms
   */
  retryDelayMs?: number;
  /**
   * Callback when observer trigger fails (after all retries exhausted).
   * Provides structured error reporting instead of just console.error.
   */
  onError?: (error: Error, snapshot: StepSnapshot, attempts: number) => void;
}

export interface ObserverMiddlewareConfig {
  store: MailboxStore;
  injection: InjectionConfig;
  trigger: TriggerConfig;

  /**
   * Called when observer should analyze a step.
   * This is where you'd invoke your observer agent.
   * Mutually exclusive with `registry`.
   */
  onTrigger?: (snapshot: StepSnapshot) => void | Promise<void>;

  /**
   * Observer registry for multi-observer support.
   * When provided, dispatches snapshots to all registered observers.
   * Mutually exclusive with `onTrigger`.
   */
  registry?: import("./observer-registry.ts").ObserverRegistry;
}

export const DEFAULT_INJECTION_CONFIG: InjectionConfig = {
  target: "end-of-history",
  maxMessagesPerTurn: 3,
  minConfidence: 0.6,
};

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  mode: "every-step",
  async: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Primitives Types (for createObserverContext)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for creating an observer context.
 */
export interface ObserverContextConfig {
  /** The mailbox store to use */
  store: MailboxStore;

  /** Thread ID this context is bound to */
  threadId: ThreadId;

  /** Whether to auto-increment step on each getPendingContext call */
  autoIncrementStep?: boolean;

  /** Initial step number (default: 0) */
  initialStep?: StepNumber;

  /** Injection configuration */
  injection?: Partial<InjectionConfig>;
}

/**
 * Result from getPendingContext().
 */
export interface PendingContextResult {
  /** The pending messages retrieved from the store */
  messages: MailboxMessage[];

  /** Formatted context string ready for injection */
  formattedContext: string;

  /** Message IDs for later marking as incorporated */
  messageIds: MessageId[];
}

/**
 * Options for getPendingContext().
 */
export interface GetPendingContextOptions {
  /** Override min confidence for this query */
  minConfidence?: number;

  /** Override max messages for this query */
  maxMessages?: number;

  /** Filter by message types */
  types?: MessageType[];
}

/**
 * Options for createSnapshot().
 */
export interface CreateSnapshotOptions {
  /** Working memory to include in snapshot */
  workingMemory?: Record<string, unknown>;
}

/**
 * Options for dispatchToObservers().
 */
export interface DispatchOptions {
  /** Whether to await the handler (default: false, fire-and-forget) */
  await?: boolean;

  /** Maximum retry attempts on failure */
  maxRetries?: number;

  /** Base delay between retries in ms (exponential backoff) */
  retryDelayMs?: number;

  /** Error callback */
  onError?: (error: Error, snapshot: StepSnapshot, attempts: number) => void;
}

/**
 * Observer context returned by createObserverContext factory.
 * Provides bound methods for a specific thread.
 */
export interface ObserverContext {
  /** The thread ID this context is bound to */
  readonly threadId: ThreadId;

  /** Current step number */
  readonly currentStep: StepNumber;

  /** The underlying store */
  readonly store: MailboxStore;

  // ─────────────────────────────────────────────────────────────────────────
  // Input Processing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get pending messages and format them for injection.
   * If autoIncrementStep is false, call nextStep() before this.
   */
  getPendingContext(opts?: GetPendingContextOptions): PendingContextResult;

  /**
   * Inject formatted context into messages at the specified target.
   */
  injectContext(
    messages: PromptMessage[],
    formattedContext: string,
    target?: InjectionTarget
  ): PromptMessage[];

  // ─────────────────────────────────────────────────────────────────────────
  // Output Processing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Mark messages as incorporated after successful injection.
   */
  markIncorporated(messageIds: MessageId[]): void;

  /**
   * Create a snapshot of the current step for observer analysis.
   */
  createSnapshot(
    originalPrompt: PromptMessage[],
    response: StepSnapshot["response"],
    opts?: CreateSnapshotOptions
  ): StepSnapshot;

  /**
   * Dispatch snapshot to observer handler(s).
   * By default, fire-and-forget. Use opts.await = true to wait.
   */
  dispatchToObservers(
    snapshot: StepSnapshot,
    handler: (snapshot: StepSnapshot) => void | Promise<void>,
    opts?: DispatchOptions
  ): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Step Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Increment and return the new step number.
   */
  nextStep(): StepNumber;

  /**
   * Set the step number explicitly.
   */
  setStep(step: StepNumber): void;

  /**
   * Run garbage collection for this thread.
   */
  gc(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input provided to injection filter functions.
 */
export interface InjectionFilterInput {
  messages: PromptMessage[];
  step: StepNumber;
  threadId: ThreadId;
}

/**
 * Input provided to trigger filter functions.
 */
export interface TriggerFilterInput {
  snapshot: StepSnapshot;
  response: StepSnapshot["response"];
}

/**
 * Filter function that determines whether to inject observer context.
 */
export type InjectionFilterFn = (input: InjectionFilterInput) => boolean;

/**
 * Filter function that determines whether to trigger observers.
 */
export type TriggerFilterFn = (input: TriggerFilterInput) => boolean;
