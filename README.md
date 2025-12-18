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

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         OBSERVER SYSTEM                                    │
│                                                                            │
│   ┌────────────────────────────────────────────────────────────────────┐   │
│   │                   ObserverContext (primitives)                     │   │
│   │  ┌───────────────┐              ┌──────────────────────┐           │   │
│   │  │getPending     │────────────▶ │ Inject context into  │           │   │
│   │  │ Context()     │   read()     │ prompt               │           │   │
│   │  └───────────────┘              └──────────────────────┘           │   │
│   │         │                                                          │   │
│   │         │                        ┌──────────────────────┐          │   │
│   │         │                        │   MailboxStore       │          │   │
│   │         │                        │  ┌────────────────┐  │          │   │
│   │         │              read()    │  │ messages[]     │  │          │   │
│   │         │           ◀────────────│  │ snapshots[]    │  │          │   │
│   │         │                        │  │ config         │  │          │   │
│   │         │                        │  └────────────────┘  │          │   │
│   │         │                        └──────────┬───────────┘          │   │
│   │         │                                   │                      │   │
│   │         │                          write()  │                      │   │
│   │         │                                   │                      │   │
│   │  ┌──────▼──────┐               ┌────────────┴────────────┐         │   │
│   │  │dispatchTo   │──────────────▶│   ObserverAgent         │         │   │
│   │  │ Observers() │   trigger     │   (background async)    │         │   │
│   │  └─────────────┘   with        │                         │         │   │
│   │                    StepSnapshot│   - Analyzes last step  │         │   │
│   │                                │   - Writes insights     │         │   │
│   │                                │   - Cheap/fast model    │         │   │
│   │                                └─────────────────────────┘         │   │
│   └────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────┘
```

## Lifecycle Visualization

```
TIME ──────────────────────────────────────────────────────────────────────▶

STEP 1          STEP 2          STEP 3          STEP 4          STEP 5
  │               │               │               │               │
  ▼               ▼               ▼               ▼               ▼
┌─────┐         ┌─────┐         ┌─────┐         ┌─────┐         ┌─────┐
│ LLM │         │ LLM │         │ LLM │         │ LLM │         │ LLM │
│CALL │         │CALL │         │CALL │         │CALL │         │CALL │
└──┬──┘         └──┬──┘         └──┬──┘         └──┬──┘         └──┬──┘
   │               │               │               │               │
   │ trigger       │ trigger       │ trigger       │ trigger       │
   ▼               ▼               ▼               ▼               ▼
┌─────┐        ┌─────┐         ┌─────┐         ┌─────┐         ┌─────┐
│ OBS │ ─ ─ ─ ▶│ OBS │ ─ ─ ─  ▶│ OBS │ ─ ─ ─ ▶ │ OBS │─ ─ ─ ─ ▶│ OBS │
│ RUN │  async │ RUN │  async  │SKIP │  async  │ RUN │  async  │ RUN │
└──┬──┘        └──┬──┘         └─────┘         └──┬──┘         └──┬──┘
   │              │              (still           │               │
   │              │               working)        │               │
   ▼              ▼                               ▼               ▼

 MAILBOX STATE OVER TIME:

 Step 1:        Step 2:        Step 3:        Step 4:        Step 5:
 ┌────────┐    ┌────────┐     ┌────────┐     ┌────────┐     ┌────────┐
 │ empty  │    │ A ○    │     │ A ○    │     │ A ✓    │     │ A ✓    │
 │        │    │        │     │ B ○    │     │ B ✓    │     │ B ✓    │
 │        │    │        │     │        │     │ C ○    │     │ C ✓    │
 │        │    │        │     │        │     │        │     │ D ○    │
 └────────┘    └────────┘     └────────┘     └────────┘     └────────┘

 ○ = pending    A arrives     B arrives      C arrives      D arrives
 ✓ = incorporated             (obs still     A,B read       C read
                               running       & marked       & marked
                               from step 1)
```

## Quick Start

```typescript
import {
  InMemoryMailboxStore,
  createObserverContext,
  TriggerFilters,
} from "mastra-observer-mailbox";

// 1. Create the store
const store = new InMemoryMailboxStore({
  dedupeWindowSteps: 5,
  defaultTtlSteps: 8,
});

// 2. Create a context bound to a thread
const ctx = createObserverContext({
  store,
  threadId: "thread-123",
  injection: {
    target: "end-of-history", // Cache-friendly position
    maxMessagesPerTurn: 3,
    minConfidence: 0.6,
  },
});

// 3. Use in your agent loop
async function agentStep(prompt: Message[]) {
  ctx.nextStep();

  // Get pending messages and inject into prompt
  const { formattedContext, messageIds } = ctx.getPendingContext();
  const enrichedPrompt = ctx.injectContext(prompt, formattedContext);

  // Call your LLM
  const response = await llm.generate(enrichedPrompt);

  // Mark messages as incorporated
  ctx.markIncorporated(messageIds);

  // Create snapshot and dispatch to observer
  const snapshot = ctx.createSnapshot(prompt, response);

  if (TriggerFilters.onToolCall()({ snapshot, response })) {
    await ctx.dispatchToObservers(snapshot, async (snap) => {
      const insight = await observerAgent.analyze(snap);
      store.send({ ...insight });
    });
  }

  ctx.gc();
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

### Message Lifecycle State Machine

```
                                    ┌─────────────────────────────────────┐
                                    │                                     │
                                    ▼                                     │
┌──────────────┐   send()    ┌──────────────┐   markIncorporated()  ┌─────┴────────┐
│              │ ──────────▶ │              │ ────────────────────▶ │              │
│   (none)     │             │   PENDING    │                       │ INCORPORATED │
│              │             │              │                       │              │
└──────────────┘             └──────┬───────┘                       └──────┬───────┘
                                    │                                      │
                                    │ gc() if                              │ gc() if
                                    │ currentStep > expiresAtStep          │ too old
                                    │                                      │
                                    ▼                                      ▼
                             ┌──────────────┐                       ┌──────────────┐
                             │              │                       │              │
                             │   EXPIRED    │                       │   ARCHIVED   │
                             │  (deleted)   │                       │  (deleted)   │
                             │              │                       │              │
                             └──────────────┘                       └──────────────┘
```

### State Transitions Over Time

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step  │ Message A                │ Message B              │ Message C       │
├───────┼──────────────────────────┼────────────────────────┼─────────────────┤
│   1   │ ○ PENDING (just sent)    │ -                      │ -               │
│   2   │ ○ PENDING (not read yet) │ ○ PENDING (just sent)  │ -               │
│   3   │ ✓ INCORPORATED (step 3)  │ ✓ INCORPORATED (step 3)│ ○ PENDING       │
│   4   │ ✓ INCORPORATED (step 3)  │ ✓ INCORPORATED (step 3)│ ○ PENDING       │
│   5   │ x ARCHIVED (gc'd)        │ ✓ INCORPORATED (step 3)│ ✓ INCORPORATED  │
└───────┴──────────────────────────┴────────────────────────┴─────────────────┘
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

### Prompt Injection Example

**Before Injection (raw prompt from agent):**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ role: system                                                                │
│ content: "You are a helpful assistant that browses the web..."              │
├─────────────────────────────────────────────────────────────────────────────┤
│ role: user                                                                  │
│ content: "Find the cheapest flight to Tokyo"                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ role: assistant                                                             │
│ content: "I'll search for flights..." + tool_call(search)                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ role: tool                                                                  │
│ content: [search results...]                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

**After Injection (with observer messages):**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ role: system                                                                │
│ content: "You are a helpful assistant that browses the web..."              │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ <observer-context>                                                      │ │
│ │                                                                         │ │
│ │ [INSIGHT confidence=0.85]                                               │ │
│ │ The user mentioned "cheapest" - prioritize budget airlines and          │ │
│ │ consider nearby airports (NRT vs HND) for better prices.                │ │
│ │                                                                         │ │
│ │ [WARNING confidence=0.72]                                               │ │
│ │ Previous search only checked one airline. Expedia and Google Flights    │ │
│ │ may have aggregated results.                                            │ │
│ │                                                                         │ │
│ │ </observer-context>                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│ role: user                                                                  │
│ content: "Find the cheapest flight to Tokyo"                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ ... rest of conversation ...                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Prompt Caching Optimization

**Problem: Observer context in middle breaks cache**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────┐                                │
│  │ SYSTEM PROMPT (static)                  │ ◀── CACHED                     │
│  └─────────────────────────────────────────┘                                │
│  ┌─────────────────────────────────────────┐                                │
│  │ OBSERVER CONTEXT (dynamic)              │ ◀── CHANGES EACH STEP          │
│  └─────────────────────────────────────────┘     (breaks cache here)        │
│  ┌─────────────────────────────────────────┐                                │
│  │ CONVERSATION HISTORY                    │ ◀── CACHE BROKEN               │
│  └─────────────────────────────────────────┘                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Solution: Put observer context at the END**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────┐                                │
│  │ SYSTEM PROMPT (static)                  │ ◀── CACHED ✓                   │
│  └─────────────────────────────────────────┘                                │
│  ┌─────────────────────────────────────────┐                                │
│  │ CONVERSATION HISTORY                    │ ◀── CACHED ✓                   │
│  │ [user, assistant, tool, ...]            │                                │
│  └─────────────────────────────────────────┘                                │
│  ┌─────────────────────────────────────────┐                                │
│  │ OBSERVER CONTEXT (as user message)      │ ◀── NEW (small, changes)       │
│  │ "[Observer: Consider checking...]"      │                                │
│  └─────────────────────────────────────────┘                                │
│  ┌─────────────────────────────────────────┐                                │
│  │ LATEST USER MESSAGE / TOOL RESULT       │ ◀── NEW (expected)             │
│  └─────────────────────────────────────────┘                                │
└─────────────────────────────────────────────────────────────────────────────┘

Result: System + History = CACHED, only Observer + Latest = NEW
```

### Handling Observer Latency

When observer is slower than main agent's tick rate:

```
         Step 1       Step 2       Step 3       Step 4       Step 5
           │            │            │            │            │
Main:      ●───────────▶●───────────▶●───────────▶●───────────▶●
           │            │            │            │            │
Observer:  ●━━━━━━━━━━━━━━━━━━━━━━━━▶○            │            │
           ▲            ▲            ▲            │            │
           │            │            │            │            │
           trigger      (still       completes!   │            │
           for step 1   running)     sends msg    │            │
                                                  │            │
Observer:                            ●━━━━━━━━━━━━━━━━━━━━━━━━▶○
                                     ▲                         ▲
                                     │                         │
                                     trigger                   completes
                                     for step 3

RESULT: Messages arrive 1-2 steps late, but are still useful context.
```

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

### Primitives API

The primitives API provides composable functions for building observer systems. Import from `mastra-observer-mailbox/primitives` or directly from the main package.

#### createObserverContext

Factory function that creates a context bound to a thread with all observer operations.

```typescript
import { createObserverContext } from "mastra-observer-mailbox/primitives";

const ctx = createObserverContext({
  store,
  threadId: "thread-123",
  autoIncrementStep: false, // Set true to auto-increment on getPendingContext
  initialStep: 0,
  injection: {
    target: "end-of-history",
    maxMessagesPerTurn: 3,
    minConfidence: 0.6,
  },
});

// Context properties
ctx.threadId;     // The bound thread ID
ctx.currentStep;  // Current step number
ctx.store;        // Access to the mailbox store

// Step management
ctx.nextStep();                    // Increment step
ctx.setStep(5);                    // Set specific step

// Context injection
const { formattedContext, messageIds } = ctx.getPendingContext();
const enriched = ctx.injectContext(messages, formattedContext);

// After LLM call
ctx.markIncorporated(messageIds);

// Create and dispatch snapshots
const snapshot = ctx.createSnapshot(originalPrompt, response, workingMemory);
await ctx.dispatchToObservers(snapshot, async (snap) => {
  const insight = await analyzeWithObserver(snap);
  store.send(insight);
});

// Cleanup
ctx.gc();
```

#### InjectionFilters

Composable predicates for controlling when to inject observer context.

```typescript
import { InjectionFilters } from "mastra-observer-mailbox/primitives";

// Built-in filters
InjectionFilters.always();           // Always inject
InjectionFilters.never();            // Never inject
InjectionFilters.hasPending();       // Only if pending messages exist
InjectionFilters.minMessages(n);     // Only if >= n pending messages
InjectionFilters.minConfidence(0.7); // Only if any message has >= confidence

// Combinators
InjectionFilters.and(filter1, filter2);  // Both must pass
InjectionFilters.or(filter1, filter2);   // Either passes
InjectionFilters.not(filter);            // Inverts filter

// Example usage
const shouldInject = InjectionFilters.and(
  InjectionFilters.hasPending(),
  InjectionFilters.minConfidence(0.6)
);

if (shouldInject({ messages: pendingMessages })) {
  // Inject context
}
```

#### TriggerFilters

Composable predicates for controlling when to dispatch to observers.

```typescript
import { TriggerFilters } from "mastra-observer-mailbox/primitives";

// Built-in filters
TriggerFilters.always();                      // Always trigger
TriggerFilters.never();                       // Never trigger
TriggerFilters.onToolCall();                  // When response has tool calls
TriggerFilters.onToolResult();                // When response has tool results
TriggerFilters.onError();                     // When response text contains errors
TriggerFilters.containsKeywords(["error"]);   // When text contains keywords
TriggerFilters.everyNSteps(3);                // Every N steps

// Combinators
TriggerFilters.anyOf(filter1, filter2);  // Any filter passes
TriggerFilters.allOf(filter1, filter2);  // All filters pass
TriggerFilters.not(filter);              // Inverts filter

// Example: trigger on tool calls OR errors
const shouldTrigger = TriggerFilters.anyOf(
  TriggerFilters.onToolCall(),
  TriggerFilters.onError()
);

if (shouldTrigger({ snapshot, response })) {
  await ctx.dispatchToObservers(snapshot, handler);
}
```

#### Injection Utilities

Low-level utilities for formatting and injecting messages.

```typescript
import {
  formatMessagesForInjection,
  injectIntoPrompt,
  injectObserverMessages,
} from "mastra-observer-mailbox/primitives";

// Format messages for injection
const formatted = formatMessagesForInjection(messages, { sanitize: true });
// => "<observer-context>\n[INSIGHT confidence=85%]\n..."

// Inject into specific position
const enriched = injectIntoPrompt(prompt, formatted, "end-of-history");

// All-in-one injection
const { enrichedPrompt, messageIds } = injectObserverMessages(store, {
  threadId: "thread-1",
  prompt: messages,
  target: "end-of-history",
  minConfidence: 0.6,
  maxMessages: 3,
});
```

### ObserverMiddleware (Deprecated)

> **Deprecated:** Use `createObserverContext` from `mastra-observer-mailbox/primitives` instead.

```typescript
// Migration guide:
// Old:
const middleware = createObserverMiddleware({ store, ... });
const enriched = middleware.transformParams(threadId, step, prompt);
await middleware.afterGenerate(threadId, response);

// New:
import { createObserverContext } from "mastra-observer-mailbox/primitives";
const ctx = createObserverContext({ store, threadId });
ctx.nextStep();
const { formattedContext, messageIds } = ctx.getPendingContext();
const enriched = ctx.injectContext(prompt, formattedContext);
// ... LLM call ...
ctx.markIncorporated(messageIds);
const snapshot = ctx.createSnapshot(prompt, response);
await ctx.dispatchToObservers(snapshot, handler);
ctx.gc();
```

## Testing

```bash
bun test
```

## License

MIT
