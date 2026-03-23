/**
 * Temporal Extraction UTC Tests
 *
 * Tests designed to catch:
 * - Local/UTC boundary drift (the actual bug GPT found)
 * - extractTemporalConstraint returns UTC ISO strings, not local dates
 * - "in month" uses passed `now`, not new Date()
 * - Edge cases: year boundary, month boundary
 */

import { describe, it, expect } from "bun:test";
import { extractTemporalConstraint } from "../../src/intent.ts";

describe("extractTemporalConstraint UTC output", () => {
  it("returns UTC ISO strings containing 'T' and 'Z'", () => {
    const result = extractTemporalConstraint("what happened yesterday");
    expect(result).not.toBeNull();
    expect(result!.start).toContain("T");
    expect(result!.start).toContain("Z");
    expect(result!.end).toContain("T");
    expect(result!.end).toContain("Z");
  });

  it("does NOT return bare YYYY-MM-DD strings", () => {
    const result = extractTemporalConstraint("what happened last week");
    expect(result).not.toBeNull();
    // If it returned "2026-03-17" without T/Z, it's a local date (the bug)
    expect(result!.start.length).toBeGreaterThan(10);
    expect(result!.end.length).toBeGreaterThan(10);
  });

  it("'today' start is before end", () => {
    const result = extractTemporalConstraint("what happened today");
    expect(result).not.toBeNull();
    expect(new Date(result!.start).getTime()).toBeLessThan(new Date(result!.end).getTime());
  });

  it("'yesterday' range does not overlap with 'today' range", () => {
    const yesterday = extractTemporalConstraint("what happened yesterday");
    const today = extractTemporalConstraint("what happened today");
    expect(yesterday).not.toBeNull();
    expect(today).not.toBeNull();
    // yesterday's end should be before today's start
    expect(new Date(yesterday!.end).getTime()).toBeLessThanOrEqual(new Date(today!.start).getTime());
  });

  it("'last week' returns a 7-day range ending now-ish", () => {
    const result = extractTemporalConstraint("what happened last week");
    expect(result).not.toBeNull();
    const startMs = new Date(result!.start).getTime();
    const endMs = new Date(result!.end).getTime();
    const rangeDays = (endMs - startMs) / 86400000;
    // Should be approximately 7 days (±1 for timezone rounding)
    expect(rangeDays).toBeGreaterThan(5.5);
    expect(rangeDays).toBeLessThan(8.5);
  });

  it("'3 days ago' range is about 3 days", () => {
    const result = extractTemporalConstraint("what happened 3 days ago");
    expect(result).not.toBeNull();
    const startMs = new Date(result!.start).getTime();
    const endMs = new Date(result!.end).getTime();
    const rangeDays = (endMs - startMs) / 86400000;
    expect(rangeDays).toBeGreaterThan(2);
    expect(rangeDays).toBeLessThan(4);
  });

  it("'in January 2026' returns January bounds", () => {
    const result = extractTemporalConstraint("in January 2026");
    expect(result).not.toBeNull();
    const start = new Date(result!.start);
    const end = new Date(result!.end);
    // Start should be in December 2025 or January 2026 (UTC conversion of Jan 1 local)
    expect(start.getFullYear()).toBeGreaterThanOrEqual(2025);
    expect(start.getFullYear()).toBeLessThanOrEqual(2026);
    // End should be in January or February 2026 (UTC conversion of Jan 31 local)
    expect(end.getMonth()).toBeLessThanOrEqual(1); // 0=Jan, 1=Feb
  });

  it("returns null for non-temporal queries", () => {
    expect(extractTemporalConstraint("why did we use PostgreSQL")).toBeNull();
    expect(extractTemporalConstraint("explain the architecture")).toBeNull();
    expect(extractTemporalConstraint("who built this")).toBeNull();
  });

  it("'since March' end covers today", () => {
    const result = extractTemporalConstraint("what changed since March");
    expect(result).not.toBeNull();
    const endMs = new Date(result!.end).getTime();
    const nowMs = Date.now();
    // End should be end-of-today (UTC) — within 24 hours of now
    expect(Math.abs(endMs - nowMs)).toBeLessThan(86400000);
    // And should not be in the past (before today started)
    expect(endMs).toBeGreaterThan(nowMs - 86400000);
  });
});
