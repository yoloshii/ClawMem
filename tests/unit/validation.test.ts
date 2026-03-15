import { describe, it, expect } from "bun:test";
import {
  assertNonEmptyString,
  assertMaxLength,
  assertFiniteNumber,
  assertBounds,
  assertSafePath,
  clampBounds,
  assertArrayLengthMatch,
} from "../../src/validation.ts";
import { ClawMemError } from "../../src/errors.ts";

describe("assertNonEmptyString", () => {
  it("throws INVALID_INPUT for empty string", () => {
    expect(() => assertNonEmptyString("", "field")).toThrow(ClawMemError);
  });

  it("throws for non-string input", () => {
    expect(() => assertNonEmptyString(42, "field")).toThrow(ClawMemError);
    expect(() => assertNonEmptyString(null, "field")).toThrow(ClawMemError);
    expect(() => assertNonEmptyString(undefined, "field")).toThrow(ClawMemError);
  });

  it("passes for valid string", () => {
    expect(() => assertNonEmptyString("hello", "field")).not.toThrow();
  });
});

describe("assertMaxLength", () => {
  it("throws INPUT_TOO_LONG when exceeded", () => {
    expect(() => assertMaxLength("abcdef", 3, "field")).toThrow(ClawMemError);
  });

  it("passes at exact limit", () => {
    expect(() => assertMaxLength("abc", 3, "field")).not.toThrow();
  });

  it("passes under limit", () => {
    expect(() => assertMaxLength("ab", 3, "field")).not.toThrow();
  });
});

describe("assertFiniteNumber", () => {
  it("throws for NaN", () => {
    expect(() => assertFiniteNumber(NaN, "field")).toThrow(ClawMemError);
  });

  it("throws for Infinity", () => {
    expect(() => assertFiniteNumber(Infinity, "field")).toThrow(ClawMemError);
    expect(() => assertFiniteNumber(-Infinity, "field")).toThrow(ClawMemError);
  });

  it("throws for non-number", () => {
    expect(() => assertFiniteNumber("5", "field")).toThrow(ClawMemError);
  });

  it("passes for valid number", () => {
    expect(() => assertFiniteNumber(42, "field")).not.toThrow();
    expect(() => assertFiniteNumber(0, "field")).not.toThrow();
    expect(() => assertFiniteNumber(-3.14, "field")).not.toThrow();
  });
});

describe("assertBounds", () => {
  it("throws OUT_OF_BOUNDS when below min", () => {
    expect(() => assertBounds(-1, 0, 10, "field")).toThrow(ClawMemError);
  });

  it("throws OUT_OF_BOUNDS when above max", () => {
    expect(() => assertBounds(11, 0, 10, "field")).toThrow(ClawMemError);
  });

  it("throws for NaN", () => {
    expect(() => assertBounds(NaN, 0, 10, "field")).toThrow(ClawMemError);
  });

  it("passes within bounds", () => {
    expect(() => assertBounds(0, 0, 10, "field")).not.toThrow();
    expect(() => assertBounds(10, 0, 10, "field")).not.toThrow();
    expect(() => assertBounds(5, 0, 10, "field")).not.toThrow();
  });
});

describe("assertArrayLengthMatch", () => {
  it("throws LENGTH_MISMATCH when different lengths", () => {
    expect(() => assertArrayLengthMatch([1, 2], [1], "a", "b")).toThrow(ClawMemError);
  });

  it("passes when same length", () => {
    expect(() => assertArrayLengthMatch([1, 2], [3, 4], "a", "b")).not.toThrow();
  });
});

describe("assertSafePath", () => {
  it("throws PATH_TRAVERSAL for paths with '..'", () => {
    expect(() => assertSafePath("foo/../bar")).toThrow(ClawMemError);
    expect(() => assertSafePath("../etc/passwd")).toThrow(ClawMemError);
  });

  it("throws INVALID_PATH for null bytes", () => {
    expect(() => assertSafePath("foo\0bar")).toThrow(ClawMemError);
  });

  it("throws PATH_TOO_LONG for paths > 1000 chars", () => {
    expect(() => assertSafePath("a".repeat(1001))).toThrow(ClawMemError);
  });

  it("passes for normal paths", () => {
    expect(() => assertSafePath("/home/user/docs/file.md")).not.toThrow();
    expect(() => assertSafePath("relative/path/file.txt")).not.toThrow();
  });

  it("allows .. in filenames that aren't path segments", () => {
    // "foo..bar" has no ".." as a standalone segment
    expect(() => assertSafePath("foo..bar")).not.toThrow();
  });
});

describe("clampBounds", () => {
  it("clamps NaN to min", () => {
    expect(clampBounds(NaN, 0, 10)).toBe(0);
  });

  it("clamps below min to min", () => {
    expect(clampBounds(-5, 0, 10)).toBe(0);
  });

  it("clamps above max to max", () => {
    expect(clampBounds(15, 0, 10)).toBe(10);
  });

  it("returns value when within bounds", () => {
    expect(clampBounds(5, 0, 10)).toBe(5);
  });

  it("clamps Infinity to min", () => {
    expect(clampBounds(Infinity, 0, 10)).toBe(0);
  });
});
