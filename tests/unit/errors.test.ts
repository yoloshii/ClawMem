import { describe, it, expect } from "bun:test";
import { ClawMemError, toUserError, toErrorResponse } from "../../src/errors.ts";

describe("ClawMemError", () => {
  it("sets code, message, and details", () => {
    const err = new ClawMemError("TEST_CODE", "test message", { key: "val" });
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
    expect(err.details).toEqual({ key: "val" });
    expect(err.name).toBe("ClawMemError");
  });

  it("toJSON returns structured error", () => {
    const err = new ClawMemError("ERR", "msg", { a: 1 });
    expect(err.toJSON()).toEqual({
      ok: false,
      error: { code: "ERR", message: "msg", details: { a: 1 } },
    });
  });

  it("toJSON omits details when undefined", () => {
    const err = new ClawMemError("ERR", "msg");
    const json = err.toJSON();
    expect(json.error).not.toHaveProperty("details");
  });

  it("preserves cause chain", () => {
    const cause = new Error("root cause");
    const err = new ClawMemError("ERR", "msg", undefined, cause);
    expect(err.cause).toBe(cause);
  });
});

describe("toUserError", () => {
  it("formats ClawMemError with code prefix", () => {
    const err = new ClawMemError("MY_CODE", "something broke");
    expect(toUserError(err)).toBe("[MY_CODE] something broke");
  });

  it("formats plain Error with message only", () => {
    expect(toUserError(new Error("oops"))).toBe("oops");
  });

  it("stringifies non-Error values", () => {
    expect(toUserError("string error")).toBe("string error");
    expect(toUserError(42)).toBe("42");
    expect(toUserError(null)).toBe("null");
  });
});

describe("toErrorResponse", () => {
  it("uses ClawMemError toJSON", () => {
    const err = new ClawMemError("CODE", "msg");
    expect(toErrorResponse(err)).toEqual({
      ok: false,
      error: { code: "CODE", message: "msg" },
    });
  });

  it("wraps plain errors as INTERNAL_ERROR", () => {
    expect(toErrorResponse(new Error("boom"))).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });
  });

  it("wraps non-Error values", () => {
    expect(toErrorResponse("bad")).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "bad" },
    });
  });
});
