/**
 * Failure Detection Strategies
 *
 * Configurable failure detection for the observer middleware trigger system.
 * Replaces naive keyword matching with structured, negation-aware detection.
 */

import type { ToolCall, ToolResult } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Response data passed to failure detectors
 */
export interface ResponseSnapshot {
  text?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

/**
 * Result of failure detection
 */
export interface FailureResult {
  isFailure: boolean;
  reason?: string;
  severity?: "warning" | "error" | "critical";
}

/**
 * Interface for failure detection strategies
 */
export interface FailureDetector {
  /**
   * Detect if the response indicates a failure
   */
  detect(response: ResponseSnapshot): FailureResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword-Based Detection (Improved)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for keyword-based failure detection
 */
export interface KeywordFailureDetectorConfig {
  /** Keywords that indicate failure */
  failureKeywords?: string[];
  /** Phrases that negate failure (e.g., "no error", "successfully") */
  negationPhrases?: string[];
  /** Whether to use case-insensitive matching */
  caseInsensitive?: boolean;
}

const DEFAULT_FAILURE_KEYWORDS = [
  "error",
  "failed",
  "failure",
  "unable to",
  "cannot",
  "could not",
  "exception",
  "crash",
  "timeout",
  "timed out",
];

const DEFAULT_NEGATION_PHRASES = [
  "no error",
  "without error",
  "no failure",
  "successfully",
  "success",
  "completed",
  "resolved",
  "fixed",
  "no issues",
  "worked",
];

/**
 * Improved keyword-based failure detection with negation awareness.
 * Unlike naive keyword matching, this detector understands context:
 * - "There was an error" → failure
 * - "No error occurred" → not a failure
 * - "Successfully completed without error" → not a failure
 */
export class KeywordFailureDetector implements FailureDetector {
  private failureKeywords: string[];
  private negationPhrases: string[];
  private caseInsensitive: boolean;

  constructor(config: KeywordFailureDetectorConfig = {}) {
    this.failureKeywords = config.failureKeywords ?? DEFAULT_FAILURE_KEYWORDS;
    this.negationPhrases = config.negationPhrases ?? DEFAULT_NEGATION_PHRASES;
    this.caseInsensitive = config.caseInsensitive ?? true;
  }

  detect(response: ResponseSnapshot): FailureResult {
    const text = response.text ?? "";
    const normalizedText = this.caseInsensitive ? text.toLowerCase() : text;

    // First check for negation phrases - if present, likely not a failure
    const hasNegation = this.negationPhrases.some((phrase) => {
      const normalizedPhrase = this.caseInsensitive
        ? phrase.toLowerCase()
        : phrase;
      return normalizedText.includes(normalizedPhrase);
    });

    // Check for failure keywords
    const matchedKeyword = this.failureKeywords.find((keyword) => {
      const normalizedKeyword = this.caseInsensitive
        ? keyword.toLowerCase()
        : keyword;
      return normalizedText.includes(normalizedKeyword);
    });

    if (matchedKeyword && !hasNegation) {
      return {
        isFailure: true,
        reason: `Response contains failure indicator: "${matchedKeyword}"`,
        severity: this.determineSeverity(matchedKeyword),
      };
    }

    return { isFailure: false };
  }

  private determineSeverity(
    keyword: string
  ): "warning" | "error" | "critical" {
    const critical = ["crash", "exception", "critical"];
    const warning = ["timeout", "timed out", "unable to"];

    if (critical.some((k) => keyword.toLowerCase().includes(k))) {
      return "critical";
    }
    if (warning.some((k) => keyword.toLowerCase().includes(k))) {
      return "warning";
    }
    return "error";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Error Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects failures based on tool results.
 * Useful for structured error responses from tools.
 */
export class ToolErrorDetector implements FailureDetector {
  private errorFields: string[];

  constructor(errorFields: string[] = ["error", "errorMessage", "isError"]) {
    this.errorFields = errorFields;
  }

  detect(response: ResponseSnapshot): FailureResult {
    const toolResults = response.toolResults ?? [];

    for (const result of toolResults) {
      if (this.hasErrorField(result.result)) {
        return {
          isFailure: true,
          reason: `Tool "${result.name}" returned an error`,
          severity: "error",
        };
      }
    }

    return { isFailure: false };
  }

  private hasErrorField(result: unknown): boolean {
    if (typeof result !== "object" || result === null) {
      return false;
    }

    const obj = result as Record<string, unknown>;

    for (const field of this.errorFields) {
      if (field in obj) {
        const value = obj[field];
        // Check if it's truthy (for boolean fields) or non-empty (for strings)
        if (value === true || (typeof value === "string" && value.length > 0)) {
          return true;
        }
      }
    }

    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Predicate Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allows custom failure detection logic via a predicate function.
 */
export class PredicateFailureDetector implements FailureDetector {
  constructor(
    private predicate: (response: ResponseSnapshot) => FailureResult | boolean
  ) {}

  detect(response: ResponseSnapshot): FailureResult {
    const result = this.predicate(response);

    if (typeof result === "boolean") {
      return { isFailure: result };
    }

    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Combines multiple failure detectors.
 * Returns failure if ANY detector finds a failure (OR logic).
 */
export class CompositeFailureDetector implements FailureDetector {
  constructor(private detectors: FailureDetector[]) {}

  detect(response: ResponseSnapshot): FailureResult {
    for (const detector of this.detectors) {
      const result = detector.detect(response);
      if (result.isFailure) {
        return result;
      }
    }

    return { isFailure: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the default failure detector with improved keyword matching
 * and tool error detection.
 */
export function createDefaultFailureDetector(): FailureDetector {
  return new CompositeFailureDetector([
    new KeywordFailureDetector(),
    new ToolErrorDetector(),
  ]);
}

/**
 * Create a failure detector from a simple predicate function.
 */
export function createPredicateDetector(
  predicate: (response: ResponseSnapshot) => FailureResult | boolean
): FailureDetector {
  return new PredicateFailureDetector(predicate);
}
