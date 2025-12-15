# Mastra Observer Mailbox

A hybrid message-oriented store for passive, event-driven communication between AI agents for Mastra.

## Overview

Observer Mailbox enables **bidirectional context injection** for multi-agent systems. An observer agent can analyze a main agent's actions and automatically enrich its context on subsequent turns—like AI pair programming.

Key features:

- **Passive injection**: Main agent doesn't need to call a tool or be aware of the observer
- **Event-driven**: Uses main agent's turns as the "tick rate", not polling
- **Async-tolerant**: Observer can be slower than main agent; missed deadlines consolidate
- **Cache-friendly**: Prompt structure optimized for LLM prompt caching
- **Deduplicated**: Repeated insights don't spam the context
- **Step-based TTL**: Messages expire after N steps, aligned with context relevance

## Installation

```bash
bun add mastra-observer-mailbox
```

## Quick Start

```typescript
import {
  InMemoryMailboxStore,
  createObserverMiddleware,
} from "mastra-observer-mailbox";

// 1. Create the store
const store = new InMemoryMailboxStore({
  dedupeWindowSteps: 5,
  defaultTtlSteps: 8,
});

// 2. Create middleware
const middleware = createObserverMiddleware({
  store,
  injection: {
    target: "end-of-history", // Cache-friendly position
    maxMessagesPerTurn: 3,
    minConfidence: 0.6,
  },
  trigger: {
    mode: "every-step",
    async: true, // Don't block main agent
  },
  onTrigger: async (snapshot) => {
    // Run your observer agent here
    // const insight = await observerAgent.analyze(snapshot);
    // store.send({ ...insight });
  },
});

// 3. Use in your agent loop
function agentStep(threadId: string, stepNumber: number, prompt: Message[]) {
  // Transform params before LLM call (injects pending messages)
  const enrichedPrompt = middleware.transformParams(threadId, stepNumber, prompt);

  // Call your LLM
  const response = await llm.generate(enrichedPrompt);

  // Process result (marks messages, triggers observer)
  await middleware.afterGenerate(threadId, response);

  return response;
}
```

## Core Concepts

### Mailbox vs Inbox

Unlike traditional actor-model inboxes where messages are consumed sequentially, the Observer Mailbox treats messages as **queryable state**:

```
Inbox (Akka-style):              Mailbox (Hybrid):
┌─────────┐                      ┌─────────────────────────────────┐
│ ▶ msg1  │ ← process            │  msg1  ✓ incorporated step 5    │
│   msg2  │   one by one         │  msg2  ✓ incorporated step 5    │
│   msg3  │                      │  msg3  ○ pending                │
│   msg4  │                      │  msg4  ○ pending                │
└─────────┘                      │  msg5  ○ pending (just arrived) │
Sequential consume               └─────────────────────────────────┘
                                 Query & filter, mark as seen
```

### Message Types

```typescript
type MessageType = "insight" | "correction" | "warning" | "context";

interface MailboxMessage {
  id: MessageId;
  threadId: ThreadId;
  from: AgentId;
  sentAtStep: StepNumber;
  type: MessageType;
  content: string;
  confidence: number; // 0-1
  incorporatedAtStep: StepNumber | null;
  expiresAtStep: StepNumber | null;
}
```

### Injection Targets

| Target              | Placement                  | Best For         |
| ------------------- | -------------------------- | ---------------- |
| `system-prompt`     | End of system message      | General guidance |
| `user-message`      | Before latest user message | Corrections      |
| `end-of-history`    | Before last message        | Default (cache-friendly) |

### Trigger Modes

| Mode          | Triggers When                    |
| ------------- | -------------------------------- |
| `every-step`  | After every LLM call             |
| `on-tool-call`| Only when tools are called       |
| `on-failure`  | Only on error-like responses     |

## API Reference

### InMemoryMailboxStore

```typescript
const store = new InMemoryMailboxStore({
  dedupeWindowSteps: 5,    // Check for duplicate content within N steps
  maxMessagesPerThread: 50, // Hard limit on mailbox size
  snapshotRetentionSteps: 10, // How many snapshots to keep
  defaultTtlSteps: 10,     // Default message expiry
});

// Send a message (returns false if deduplicated)
store.send({
  threadId: "thread-1",
  from: "observer-agent",
  sentAtStep: 5,
  sentAtTime: Date.now(),
  type: "insight",
  content: "Consider checking the API rate limits",
  confidence: 0.8,
  expiresAtStep: null, // Uses default TTL
});

// Query messages
const pending = store.query("thread-1", {
  status: "pending",
  minConfidence: 0.6,
  types: ["insight", "warning"],
  limit: 5,
});

// Mark as incorporated
store.markIncorporated(pending.map(m => m.id), currentStep);

// Store/retrieve snapshots
store.storeSnapshot(snapshot);
const snapshots = store.getSnapshots("thread-1", 5);

// Garbage collection
store.gc("thread-1", currentStep);
```

### ObserverMiddleware

```typescript
const middleware = createObserverMiddleware({
  store,
  injection: {
    target: "end-of-history",
    maxMessagesPerTurn: 3,
    minConfidence: 0.6,
  },
  trigger: {
    mode: "every-step",
    async: true,
  },
  onTrigger: async (snapshot) => {
    // Analyze the snapshot and send insights
  },
});

// Before LLM call
const enrichedPrompt = middleware.transformParams(threadId, step, prompt);

// After LLM call
await middleware.afterGenerate(threadId, response, workingMemory);

// Access store
const store = middleware.getStore();
```

## Testing

```bash
bun test
```

## License

MIT
