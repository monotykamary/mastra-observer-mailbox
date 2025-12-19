/**
 * Static Context Injection Tests
 *
 * Tests for deterministic, rule-based context injection without AI agents.
 * This validates the pattern where context is injected based on rules
 * rather than observer agent analysis.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryMailboxStore } from "../store.ts";
import { createObserverContext } from "../primitives/context.ts";
import type {
  StepSnapshot,
  PromptMessage,
  SendMessageInput,
  ObserverContext,
} from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Rule-based Context Providers
// ─────────────────────────────────────────────────────────────────────────────

type ContextRule = (snapshot: StepSnapshot, store: InMemoryMailboxStore) => void;

/**
 * Security rules - inject warnings based on tool usage patterns
 */
const securityRules: ContextRule = (snapshot, store) => {
  const { response, threadId, stepNumber } = snapshot;

  // Warn on navigation to sensitive pages
  const navToSensitive = response.toolCalls?.some((tc) => {
    if (tc.name !== "navigate") return false;
    const url = String(tc.args?.url ?? "");
    return (
      url.includes("/checkout") ||
      url.includes("/payment") ||
      url.includes("/login") ||
      url.includes("/admin")
    );
  });

  if (navToSensitive) {
    store.send({
      threadId,
      from: "security-rules",
      sentAtStep: stepNumber,
      sentAtTime: Date.now(),
      type: "warning",
      content:
        "Sensitive page detected. Verify SSL certificate, check URL for typosquatting, and never enter credentials on suspicious sites.",
      confidence: 1.0,
      expiresAtStep: stepNumber + 2,
    });
  }

  // Warn on file system operations
  const hasFileOps = response.toolCalls?.some((tc) =>
    ["write_file", "delete_file", "execute"].includes(tc.name)
  );

  if (hasFileOps) {
    store.send({
      threadId,
      from: "security-rules",
      sentAtStep: stepNumber,
      sentAtTime: Date.now(),
      type: "warning",
      content:
        "File system operation detected. Verify paths are within allowed directories and sanitize any user-provided input.",
      confidence: 1.0,
      expiresAtStep: stepNumber + 3,
    });
  }
};

/**
 * Search optimization rules - inject context for search operations
 */
const searchRules: ContextRule = (snapshot, store) => {
  const { response, threadId, stepNumber } = snapshot;

  const isSearching = response.toolCalls?.some((tc) =>
    ["search", "web_search", "google"].includes(tc.name)
  );

  if (isSearching) {
    store.send({
      threadId,
      from: "search-rules",
      sentAtStep: stepNumber,
      sentAtTime: Date.now(),
      type: "context",
      content:
        "Search best practices: Prefer official documentation over forums. Filter results by last 12 months for technical topics. Cross-reference multiple sources.",
      confidence: 0.9,
      expiresAtStep: stepNumber + 3,
    });
  }
};

/**
 * Domain knowledge rules - inject context based on keyword detection
 */
const domainKnowledgeRules: ContextRule = (snapshot, store) => {
  const { response, threadId, stepNumber } = snapshot;
  const text = response.text?.toLowerCase() ?? "";

  // Rate limiting knowledge
  if (text.includes("rate limit") || text.includes("429") || text.includes("too many requests")) {
    store.send({
      threadId,
      from: "domain-rules",
      sentAtStep: stepNumber,
      sentAtTime: Date.now(),
      type: "insight",
      content:
        "Rate limit guidance: Implement exponential backoff starting at 1s, doubling up to 32s max. Add jitter (±10%) to prevent thundering herd.",
      confidence: 1.0,
      expiresAtStep: stepNumber + 5,
    });
  }

  // Authentication errors
  if (text.includes("401") || text.includes("unauthorized") || text.includes("token expired")) {
    store.send({
      threadId,
      from: "domain-rules",
      sentAtStep: stepNumber,
      sentAtTime: Date.now(),
      type: "insight",
      content:
        "Auth error detected: Check token expiration, verify credentials, ensure correct auth header format (Bearer vs Basic).",
      confidence: 1.0,
      expiresAtStep: stepNumber + 4,
    });
  }

  // Timeout issues
  if (text.includes("timeout") || text.includes("timed out") || text.includes("ETIMEDOUT")) {
    store.send({
      threadId,
      from: "domain-rules",
      sentAtStep: stepNumber,
      sentAtTime: Date.now(),
      type: "insight",
      content:
        "Timeout detected: Consider increasing timeout threshold, check network connectivity, or break request into smaller chunks.",
      confidence: 0.95,
      expiresAtStep: stepNumber + 3,
    });
  }
};

/**
 * Apply all rules to a snapshot
 */
function applyAllRules(
  snapshot: StepSnapshot,
  store: InMemoryMailboxStore,
  rules: ContextRule[]
): void {
  for (const rule of rules) {
    rule(snapshot, store);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Static Context Injection", () => {
  let store: InMemoryMailboxStore;
  let ctx: ObserverContext;

  beforeEach(() => {
    store = new InMemoryMailboxStore({
      dedupeWindowSteps: 3,
      defaultTtlSteps: 5,
    });
    ctx = createObserverContext({
      store,
      threadId: "test-thread",
      injection: {
        target: "end-of-history",
        maxMessagesPerTurn: 5,
        minConfidence: 0.5,
      },
    });
  });

  describe("Security Rules", () => {
    test("should inject warning on checkout page navigation", () => {
      ctx.nextStep();

      const prompt: PromptMessage[] = [
        { role: "user", content: "Complete my purchase" },
      ];

      const snapshot = ctx.createSnapshot(prompt, {
        text: "Navigating to checkout...",
        toolCalls: [{ name: "navigate", args: { url: "https://shop.com/checkout" } }],
      });

      securityRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0]!.type).toBe("warning");
      expect(pending[0]!.content).toContain("Sensitive page");
      expect(pending[0]!.content).toContain("SSL");
      expect(pending[0]!.from).toBe("security-rules");
      expect(pending[0]!.confidence).toBe(1.0);
    });

    test("should inject warning on login page navigation", () => {
      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {
        text: "Going to login...",
        toolCalls: [{ name: "navigate", args: { url: "https://app.com/login" } }],
      });

      securityRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0]!.type).toBe("warning");
    });

    test("should inject warning on file write operations", () => {
      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {
        text: "Writing config file...",
        toolCalls: [{ name: "write_file", args: { path: "/etc/config.json" } }],
      });

      securityRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0]!.content).toContain("File system operation");
      expect(pending[0]!.content).toContain("allowed directories");
    });

    test("should not inject warning for safe navigation", () => {
      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {
        text: "Reading documentation...",
        toolCalls: [{ name: "navigate", args: { url: "https://docs.example.com/api" } }],
      });

      securityRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(0);
    });
  });

  describe("Search Rules", () => {
    test("should inject context for search operations", () => {
      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {
        text: "Searching for information...",
        toolCalls: [{ name: "web_search", args: { query: "typescript generics" } }],
      });

      searchRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0]!.type).toBe("context");
      expect(pending[0]!.content).toContain("official documentation");
      expect(pending[0]!.content).toContain("12 months");
      expect(pending[0]!.from).toBe("search-rules");
    });

    test("should not inject context for non-search operations", () => {
      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {
        text: "Reading file...",
        toolCalls: [{ name: "read_file", args: { path: "README.md" } }],
      });

      searchRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(0);
    });
  });

  describe("Domain Knowledge Rules", () => {
    test("should inject rate limit guidance on 429 errors", () => {
      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {
        text: "Error: Received 429 Too Many Requests from API",
      });

      domainKnowledgeRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0]!.type).toBe("insight");
      expect(pending[0]!.content).toContain("exponential backoff");
      expect(pending[0]!.content).toContain("jitter");
    });

    test("should inject auth guidance on 401 errors", () => {
      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {
        text: "API returned 401 Unauthorized - token may be expired",
      });

      domainKnowledgeRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0]!.content).toContain("token expiration");
      expect(pending[0]!.content).toContain("Bearer vs Basic");
    });

    test("should inject timeout guidance", () => {
      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {
        text: "Request timed out after 30 seconds",
      });

      domainKnowledgeRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0]!.content).toContain("timeout threshold");
    });

    test("should handle multiple keyword matches", () => {
      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {
        text: "Got 429 rate limit, then 401 unauthorized after retry",
      });

      domainKnowledgeRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(2);

      const types = pending.map((m) => m.content);
      expect(types.some((c) => c.includes("exponential backoff"))).toBe(true);
      expect(types.some((c) => c.includes("token expiration"))).toBe(true);
    });
  });

  describe("Full Agent Loop with Static Rules", () => {
    test("should inject context on subsequent steps", () => {
      const allRules = [securityRules, searchRules, domainKnowledgeRules];

      // Step 1: Initial search
      ctx.nextStep();
      let { formattedContext, messageIds } = ctx.getPendingContext();
      expect(formattedContext).toBe(""); // No context yet

      const prompt1: PromptMessage[] = [
        { role: "user", content: "Search for API documentation" },
      ];

      const snapshot1 = ctx.createSnapshot(prompt1, {
        text: "Searching...",
        toolCalls: [{ name: "search", args: { query: "REST API docs" } }],
      });

      applyAllRules(snapshot1, store, allRules);
      ctx.gc();

      // Step 2: Should have search context injected
      ctx.nextStep();
      ({ formattedContext, messageIds } = ctx.getPendingContext());
      expect(formattedContext).toContain("observer-context");
      expect(formattedContext).toContain("official documentation");

      const prompt2: PromptMessage[] = [
        ...prompt1,
        { role: "assistant", content: "Searching..." },
        { role: "user", content: "Show results" },
      ];

      const enriched = ctx.injectContext(prompt2, formattedContext);
      expect(enriched.length).toBe(prompt2.length + 1);
      expect(enriched.some((m) => m.content.includes("observer-context"))).toBe(true);

      ctx.markIncorporated(messageIds);

      // Verify message was incorporated
      const pending = store.query("test-thread", { status: "pending" });
      const incorporated = store.query("test-thread", { status: "incorporated" });
      expect(pending.length).toBe(0);
      expect(incorporated.length).toBe(1);
    });

    test("should handle multiple rules triggering in same step", () => {
      const allRules = [securityRules, searchRules];

      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {
        text: "Searching and navigating...",
        toolCalls: [
          { name: "search", args: { query: "payment APIs" } },
          { name: "navigate", args: { url: "https://stripe.com/checkout" } },
        ],
      });

      applyAllRules(snapshot, store, allRules);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(2);

      const contents = pending.map((m) => m.content);
      expect(contents.some((c) => c.includes("official documentation"))).toBe(true);
      expect(contents.some((c) => c.includes("Sensitive page"))).toBe(true);
    });

    test("should respect deduplication across steps", () => {
      ctx.nextStep();

      // Send same rule-based message
      store.send({
        threadId: "test-thread",
        from: "static-rule",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "context",
        content: "Always validate input",
        confidence: 1.0,
        expiresAtStep: 10,
      });

      ctx.nextStep();

      // Try to send duplicate
      const sent = store.send({
        threadId: "test-thread",
        from: "static-rule",
        sentAtStep: 2,
        sentAtTime: Date.now(),
        type: "context",
        content: "Always validate input", // Same content
        confidence: 1.0,
        expiresAtStep: 10,
      });

      expect(sent).toBe(false); // Should be deduplicated

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(1);
    });

    test("should expire old static context", () => {
      // Step 1: Send message with short TTL
      ctx.nextStep();
      store.send({
        threadId: "test-thread",
        from: "static-rule",
        sentAtStep: 1,
        sentAtTime: Date.now(),
        type: "context",
        content: "Short-lived context",
        confidence: 1.0,
        expiresAtStep: 3, // Expires at step 3
      });

      // Advance to step 5 and run GC
      ctx.setStep(5);
      ctx.gc();

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(0);
    });
  });

  describe("Composable Rule Patterns", () => {
    test("should support conditional rule application", () => {
      const conditionalRule: ContextRule = (snapshot, store) => {
        // Only apply if working memory indicates production environment
        const isProduction = snapshot.workingMemory?.env === "production";

        if (isProduction && snapshot.response.toolCalls?.some((tc) => tc.name === "deploy")) {
          store.send({
            threadId: snapshot.threadId,
            from: "deployment-rules",
            sentAtStep: snapshot.stepNumber,
            sentAtTime: Date.now(),
            type: "warning",
            content: "Production deployment detected. Ensure rollback plan is in place.",
            confidence: 1.0,
            expiresAtStep: snapshot.stepNumber + 1,
          });
        }
      };

      ctx.nextStep();

      // Test without production flag - no warning
      const snapshot1 = ctx.createSnapshot(
        [],
        { text: "Deploying...", toolCalls: [{ name: "deploy", args: {} }] },
        { workingMemory: { env: "staging" } }
      );
      conditionalRule(snapshot1, store);
      expect(store.query("test-thread", { status: "pending" }).length).toBe(0);

      // Test with production flag - should warn
      const snapshot2 = ctx.createSnapshot(
        [],
        { text: "Deploying...", toolCalls: [{ name: "deploy", args: {} }] },
        { workingMemory: { env: "production" } }
      );
      conditionalRule(snapshot2, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0]!.content).toContain("rollback plan");
    });

    test("should support rule chaining with early exit", () => {
      let rulesCalled: string[] = [];

      const rule1: ContextRule = (snapshot, store) => {
        rulesCalled.push("rule1");
        // Always runs
      };

      const rule2: ContextRule = (snapshot, store) => {
        rulesCalled.push("rule2");
        // Check if previous rule already handled this
        const existing = store.query(snapshot.threadId, {
          status: "pending",
          types: ["warning"],
        });
        if (existing.length > 0) return; // Early exit

        store.send({
          threadId: snapshot.threadId,
          from: "rule2",
          sentAtStep: snapshot.stepNumber,
          sentAtTime: Date.now(),
          type: "warning",
          content: "From rule2",
          confidence: 0.8,
          expiresAtStep: snapshot.stepNumber + 3,
        });
      };

      const rule3: ContextRule = (snapshot, store) => {
        rulesCalled.push("rule3");
        store.send({
          threadId: snapshot.threadId,
          from: "rule3",
          sentAtStep: snapshot.stepNumber,
          sentAtTime: Date.now(),
          type: "warning",
          content: "From rule3",
          confidence: 0.9,
          expiresAtStep: snapshot.stepNumber + 3,
        });
      };

      ctx.nextStep();
      const snapshot = ctx.createSnapshot([], { text: "Test" });

      // Run rules in order: rule3 adds warning, rule2 exits early
      applyAllRules(snapshot, store, [rule1, rule3, rule2]);

      expect(rulesCalled).toEqual(["rule1", "rule3", "rule2"]);

      // Only rule3's warning should exist (rule2 exited early)
      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0]!.from).toBe("rule3");
    });

    test("should support rule factories with configuration", () => {
      // Factory that creates URL pattern rules
      function createUrlPatternRule(
        patterns: string[],
        warningMessage: string
      ): ContextRule {
        return (snapshot, store) => {
          const matchesPattern = snapshot.response.toolCalls?.some((tc) => {
            if (tc.name !== "navigate") return false;
            const url = String(tc.args?.url ?? "");
            return patterns.some((p) => url.includes(p));
          });

          if (matchesPattern) {
            store.send({
              threadId: snapshot.threadId,
              from: "url-pattern-rule",
              sentAtStep: snapshot.stepNumber,
              sentAtTime: Date.now(),
              type: "warning",
              content: warningMessage,
              confidence: 1.0,
              expiresAtStep: snapshot.stepNumber + 2,
            });
          }
        };
      }

      const socialMediaRule = createUrlPatternRule(
        ["facebook.com", "twitter.com", "instagram.com"],
        "Social media site detected. Be cautious about data scraping policies."
      );

      const bankingRule = createUrlPatternRule(
        ["/banking", "/account", "/transfer"],
        "Banking operation detected. Verify all transaction details carefully."
      );

      ctx.nextStep();

      // Test social media rule
      const snapshot1 = ctx.createSnapshot([], {
        text: "Going to Twitter...",
        toolCalls: [{ name: "navigate", args: { url: "https://twitter.com/user" } }],
      });
      socialMediaRule(snapshot1, store);

      let pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0]!.content).toContain("Social media");

      // Clear for next test
      store.gc("test-thread", 100);

      // Test banking rule
      ctx.nextStep();
      const snapshot2 = ctx.createSnapshot([], {
        text: "Opening account page...",
        toolCalls: [{ name: "navigate", args: { url: "https://bank.com/account/transfer" } }],
      });
      bankingRule(snapshot2, store);

      pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0]!.content).toContain("Banking operation");
    });
  });

  describe("Edge Cases", () => {
    test("should handle empty response gracefully", () => {
      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {});

      // Should not throw
      securityRules(snapshot, store);
      searchRules(snapshot, store);
      domainKnowledgeRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(0);
    });

    test("should handle undefined tool args", () => {
      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {
        text: "Navigating...",
        toolCalls: [{ name: "navigate", args: undefined }],
      });

      // Should not throw
      securityRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(0);
    });

    test("should handle null response text", () => {
      ctx.nextStep();

      const snapshot = ctx.createSnapshot([], {
        text: undefined,
        toolCalls: [],
      });

      // Should not throw
      domainKnowledgeRules(snapshot, store);

      const pending = store.query("test-thread", { status: "pending" });
      expect(pending.length).toBe(0);
    });
  });
});
