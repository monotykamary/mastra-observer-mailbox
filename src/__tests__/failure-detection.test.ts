import { describe, test, expect } from "bun:test";
import {
  KeywordFailureDetector,
  ToolErrorDetector,
  PredicateFailureDetector,
  CompositeFailureDetector,
  createDefaultFailureDetector,
  createPredicateDetector,
} from "../failure-detection.ts";
import type { ResponseSnapshot } from "../failure-detection.ts";

describe("KeywordFailureDetector", () => {
  const detector = new KeywordFailureDetector();

  test("detects simple error keyword", () => {
    const response: ResponseSnapshot = { text: "There was an error processing the request" };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(true);
    expect(result.reason).toContain("error");
  });

  test("detects 'failed' keyword", () => {
    const response: ResponseSnapshot = { text: "The operation failed" };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(true);
  });

  test("detects 'unable to' keyword", () => {
    const response: ResponseSnapshot = { text: "I was unable to complete the task" };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(true);
    expect(result.severity).toBe("warning");
  });

  test("does NOT trigger on negation: 'no error'", () => {
    const response: ResponseSnapshot = { text: "No error occurred during the process" };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(false);
  });

  test("does NOT trigger on negation: 'without error'", () => {
    const response: ResponseSnapshot = { text: "Completed without error" };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(false);
  });

  test("does NOT trigger on success phrases", () => {
    const response: ResponseSnapshot = { text: "The task was completed successfully" };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(false);
  });

  test("does NOT trigger on 'fixed' negation", () => {
    const response: ResponseSnapshot = { text: "The error has been fixed" };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(false);
  });

  test("handles empty text", () => {
    const response: ResponseSnapshot = { text: "" };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(false);
  });

  test("handles undefined text", () => {
    const response: ResponseSnapshot = {};
    const result = detector.detect(response);
    expect(result.isFailure).toBe(false);
  });

  test("is case insensitive by default", () => {
    const response: ResponseSnapshot = { text: "ERROR: Something went wrong" };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(true);
  });

  test("assigns critical severity to crash/exception", () => {
    const response: ResponseSnapshot = { text: "An exception was thrown" };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(true);
    expect(result.severity).toBe("critical");
  });

  test("assigns error severity to general failures", () => {
    const response: ResponseSnapshot = { text: "The request failed" };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(true);
    expect(result.severity).toBe("error");
  });

  describe("with custom config", () => {
    test("uses custom failure keywords", () => {
      const customDetector = new KeywordFailureDetector({
        failureKeywords: ["broken", "kaput"],
      });

      const response: ResponseSnapshot = { text: "The system is broken" };
      expect(customDetector.detect(response).isFailure).toBe(true);

      // Default keyword should not trigger
      const response2: ResponseSnapshot = { text: "There was an error" };
      expect(customDetector.detect(response2).isFailure).toBe(false);
    });

    test("uses custom negation phrases", () => {
      const customDetector = new KeywordFailureDetector({
        negationPhrases: ["all good", "working fine"],
      });

      // Error with default negation should still trigger (no custom negation match)
      const response: ResponseSnapshot = { text: "Error: but no error occurred" };
      expect(customDetector.detect(response).isFailure).toBe(true);

      // Error with custom negation should not trigger
      const response2: ResponseSnapshot = { text: "Error handling is all good" };
      expect(customDetector.detect(response2).isFailure).toBe(false);
    });
  });
});

describe("ToolErrorDetector", () => {
  const detector = new ToolErrorDetector();

  test("detects error field in tool result", () => {
    const response: ResponseSnapshot = {
      toolResults: [{ name: "test_tool", result: { error: "Something went wrong" } }],
    };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(true);
    expect(result.reason).toContain("test_tool");
  });

  test("detects isError boolean field", () => {
    const response: ResponseSnapshot = {
      toolResults: [{ name: "api_call", result: { isError: true, data: null } }],
    };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(true);
  });

  test("does NOT trigger on isError: false", () => {
    const response: ResponseSnapshot = {
      toolResults: [{ name: "api_call", result: { isError: false, data: "success" } }],
    };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(false);
  });

  test("does NOT trigger on empty error string", () => {
    const response: ResponseSnapshot = {
      toolResults: [{ name: "test_tool", result: { error: "" } }],
    };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(false);
  });

  test("handles missing tool results", () => {
    const response: ResponseSnapshot = { text: "No tools called" };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(false);
  });

  test("handles non-object tool results", () => {
    const response: ResponseSnapshot = {
      toolResults: [{ name: "simple_tool", result: "string result" }],
    };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(false);
  });

  test("handles null tool results", () => {
    const response: ResponseSnapshot = {
      toolResults: [{ name: "null_tool", result: null }],
    };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(false);
  });

  test("checks multiple tool results", () => {
    const response: ResponseSnapshot = {
      toolResults: [
        { name: "tool1", result: { success: true } },
        { name: "tool2", result: { error: "Failed!" } },
        { name: "tool3", result: { data: "ok" } },
      ],
    };
    const result = detector.detect(response);
    expect(result.isFailure).toBe(true);
    expect(result.reason).toContain("tool2");
  });

  describe("with custom error fields", () => {
    test("uses custom error field names", () => {
      const customDetector = new ToolErrorDetector(["fault", "problem"]);

      const response: ResponseSnapshot = {
        toolResults: [{ name: "custom_tool", result: { fault: "Something broke" } }],
      };
      expect(customDetector.detect(response).isFailure).toBe(true);

      // Default field should not trigger
      const response2: ResponseSnapshot = {
        toolResults: [{ name: "custom_tool", result: { error: "This should not trigger" } }],
      };
      expect(customDetector.detect(response2).isFailure).toBe(false);
    });
  });
});

describe("PredicateFailureDetector", () => {
  test("works with boolean predicate", () => {
    const detector = new PredicateFailureDetector(
      (response) => response.text?.includes("ABORT") ?? false
    );

    expect(detector.detect({ text: "ABORT mission" }).isFailure).toBe(true);
    expect(detector.detect({ text: "Continue mission" }).isFailure).toBe(false);
  });

  test("works with FailureResult predicate", () => {
    const detector = new PredicateFailureDetector((response) => {
      if (response.text?.includes("critical")) {
        return { isFailure: true, reason: "Critical keyword found", severity: "critical" };
      }
      return { isFailure: false };
    });

    const result = detector.detect({ text: "critical failure" });
    expect(result.isFailure).toBe(true);
    expect(result.severity).toBe("critical");
  });
});

describe("CompositeFailureDetector", () => {
  test("returns failure if any detector finds failure", () => {
    const detector = new CompositeFailureDetector([
      new KeywordFailureDetector({ failureKeywords: ["keyword1"] }),
      new KeywordFailureDetector({ failureKeywords: ["keyword2"] }),
    ]);

    expect(detector.detect({ text: "keyword1 present" }).isFailure).toBe(true);
    expect(detector.detect({ text: "keyword2 present" }).isFailure).toBe(true);
    expect(detector.detect({ text: "no keywords" }).isFailure).toBe(false);
  });

  test("returns first failure found", () => {
    const detector = new CompositeFailureDetector([
      new PredicateFailureDetector(() => ({ isFailure: true, reason: "First" })),
      new PredicateFailureDetector(() => ({ isFailure: true, reason: "Second" })),
    ]);

    const result = detector.detect({});
    expect(result.reason).toBe("First");
  });

  test("returns no failure if all detectors pass", () => {
    const detector = new CompositeFailureDetector([
      new PredicateFailureDetector(() => false),
      new PredicateFailureDetector(() => false),
    ]);

    expect(detector.detect({}).isFailure).toBe(false);
  });
});

describe("createDefaultFailureDetector", () => {
  const detector = createDefaultFailureDetector();

  test("combines keyword and tool error detection", () => {
    // Keyword detection
    expect(detector.detect({ text: "error occurred" }).isFailure).toBe(true);

    // Tool error detection
    expect(detector.detect({
      toolResults: [{ name: "tool", result: { error: "Failed" } }],
    }).isFailure).toBe(true);

    // Neither
    expect(detector.detect({ text: "all good" }).isFailure).toBe(false);
  });

  test("respects negation in default detector", () => {
    expect(detector.detect({ text: "No error found" }).isFailure).toBe(false);
    expect(detector.detect({ text: "Successfully completed" }).isFailure).toBe(false);
  });
});

describe("createPredicateDetector", () => {
  test("creates a PredicateFailureDetector", () => {
    const detector = createPredicateDetector((r) => r.text === "fail");

    expect(detector.detect({ text: "fail" }).isFailure).toBe(true);
    expect(detector.detect({ text: "pass" }).isFailure).toBe(false);
  });
});
