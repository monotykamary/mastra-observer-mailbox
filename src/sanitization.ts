/**
 * Content Sanitization
 *
 * Utilities for sanitizing observer message content before injection
 * into prompts to prevent prompt injection attacks.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationIssue {
  type: "length" | "pattern" | "encoding";
  message: string;
  severity: "warning" | "error";
}

export interface ValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
}

export interface SanitizeOptions {
  /** Maximum content length (default: 10000) */
  maxLength?: number;
  /** Whether to escape XML-like tags (default: true) */
  escapeXmlTags?: boolean;
  /** Whether to strip control characters (default: true) */
  stripControlChars?: boolean;
  /** Custom patterns to escape */
  escapePatterns?: Array<{ pattern: RegExp; replacement: string }>;
}

export interface ContentSanitizer {
  /**
   * Sanitize content for safe injection into prompts.
   */
  sanitize(content: string, options?: SanitizeOptions): string;

  /**
   * Validate content and return any issues found.
   */
  validate(content: string, options?: SanitizeOptions): ValidationResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_LENGTH = 10000;

/**
 * Patterns that could be used for prompt injection attacks.
 * These are escaped or neutralized during sanitization.
 */
const DANGEROUS_PATTERNS = [
  // XML-like tags that could break our observer-context wrapper
  { pattern: /<\/?observer-context[^>]*>/gi, replacement: "[observer-context]" },
  { pattern: /<\/?system[^>]*>/gi, replacement: "[system]" },
  { pattern: /<\/?assistant[^>]*>/gi, replacement: "[assistant]" },
  { pattern: /<\/?user[^>]*>/gi, replacement: "[user]" },
  { pattern: /<\/?tool[^>]*>/gi, replacement: "[tool]" },

  // Common prompt injection markers
  { pattern: /\[INST\]/gi, replacement: "[inst]" },
  { pattern: /\[\/INST\]/gi, replacement: "[/inst]" },
  { pattern: /<<SYS>>/gi, replacement: "[[SYS]]" },
  { pattern: /<<\/SYS>>/gi, replacement: "[[/SYS]]" },

  // Anthropic-specific markers
  { pattern: /Human:/gi, replacement: "human:" },
  { pattern: /Assistant:/gi, replacement: "assistant:" },

  // Potential instruction override attempts
  { pattern: /ignore (?:all )?(?:previous |prior |above )?instructions/gi, replacement: "[filtered]" },
  { pattern: /disregard (?:all )?(?:previous |prior |above )?instructions/gi, replacement: "[filtered]" },
];

/**
 * Control characters that should be stripped (except common whitespace)
 */
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// ─────────────────────────────────────────────────────────────────────────────
// Default Sanitizer Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default content sanitizer implementation.
 */
export const defaultSanitizer: ContentSanitizer = {
  sanitize(content: string, options: SanitizeOptions = {}): string {
    const {
      maxLength = DEFAULT_MAX_LENGTH,
      escapeXmlTags = true,
      stripControlChars = true,
      escapePatterns = [],
    } = options;

    let result = content;

    // Strip control characters
    if (stripControlChars) {
      result = result.replace(CONTROL_CHAR_REGEX, "");
    }

    // Escape dangerous patterns
    if (escapeXmlTags) {
      for (const { pattern, replacement } of DANGEROUS_PATTERNS) {
        result = result.replace(pattern, replacement);
      }
    }

    // Apply custom escape patterns
    for (const { pattern, replacement } of escapePatterns) {
      result = result.replace(pattern, replacement);
    }

    // Truncate if too long
    if (result.length > maxLength) {
      result = result.slice(0, maxLength - 3) + "...";
    }

    return result;
  },

  validate(content: string, options: SanitizeOptions = {}): ValidationResult {
    const { maxLength = DEFAULT_MAX_LENGTH, escapeXmlTags = true } = options;

    const issues: ValidationIssue[] = [];

    // Check length
    if (content.length > maxLength) {
      issues.push({
        type: "length",
        message: `Content exceeds maximum length of ${maxLength} characters (got ${content.length})`,
        severity: "warning",
      });
    }

    // Check for control characters
    if (CONTROL_CHAR_REGEX.test(content)) {
      issues.push({
        type: "encoding",
        message: "Content contains control characters",
        severity: "warning",
      });
    }

    // Check for dangerous patterns
    if (escapeXmlTags) {
      for (const { pattern } of DANGEROUS_PATTERNS) {
        // Reset lastIndex for global regex
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
          issues.push({
            type: "pattern",
            message: `Content contains potentially dangerous pattern: ${pattern.source}`,
            severity: "warning",
          });
          // Reset again after test
          pattern.lastIndex = 0;
        }
      }
    }

    return {
      isValid: issues.filter((i) => i.severity === "error").length === 0,
      issues,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitize content using the default sanitizer.
 */
export function sanitizeContent(
  content: string,
  options?: SanitizeOptions
): string {
  return defaultSanitizer.sanitize(content, options);
}

/**
 * Validate content using the default sanitizer.
 */
export function validateContent(
  content: string,
  options?: SanitizeOptions
): ValidationResult {
  return defaultSanitizer.validate(content, options);
}

/**
 * Create a custom sanitizer with pre-configured options.
 */
export function createSanitizer(defaultOptions: SanitizeOptions): ContentSanitizer {
  return {
    sanitize(content: string, options?: SanitizeOptions): string {
      return defaultSanitizer.sanitize(content, { ...defaultOptions, ...options });
    },
    validate(content: string, options?: SanitizeOptions): ValidationResult {
      return defaultSanitizer.validate(content, { ...defaultOptions, ...options });
    },
  };
}

/**
 * Escape a string for safe inclusion in XML-like content.
 * This is a simple escape that handles basic XML entities.
 */
export function escapeXml(content: string): string {
  return content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
