import { describe, it, expect } from "bun:test";

/**
 * Retrieval gate — force-intent contract (§51.5).
 *
 * FORCE_RETRIEVE_PATTERNS are documented "(checked before skip)". That must
 * hold inside shouldSkipRetrieval AND be independently consumable by
 * context-surfacing's own gates via hasForceRetrieveIntent — the §51.5 bug was
 * the hook's MIN_PROMPT_LENGTH return firing before the gate ever ran.
 */

import { hasForceRetrieveIntent, shouldSkipRetrieval } from "../../src/retrieval-gate.ts";

describe("hasForceRetrieveIntent", () => {
  it("matches every force family", () => {
    expect(hasForceRetrieveIntent("remember the plan")).toBe(true);      // memory verb
    expect(hasForceRetrieveIntent("last time we met")).toBe(true);       // temporal ref
    expect(hasForceRetrieveIntent("what's my email?")).toBe(true);       // personal data
    expect(hasForceRetrieveIntent("what did I say?")).toBe(true);        // did-i family
  });

  it("does not match plain short prompts", () => {
    expect(hasForceRetrieveIntent("hello there")).toBe(false);
    expect(hasForceRetrieveIntent("run the tests")).toBe(false);
    expect(hasForceRetrieveIntent("")).toBe(false);
  });

  it("tests against the NORMALIZED prompt (cron wrapper stripped)", () => {
    expect(hasForceRetrieveIntent("[cron:daily] what did I say?")).toBe(true);
  });
});

describe("shouldSkipRetrieval — force checked before every skip", () => {
  it("a bare force term shorter than every length threshold is never skipped", () => {
    expect(shouldSkipRetrieval("recall")).toBe(false); // 6 chars — under the 15-char non-question floor
  });

  it("skip patterns still apply to non-force prompts", () => {
    expect(shouldSkipRetrieval("hi")).toBe(true);
    expect(shouldSkipRetrieval("run build")).toBe(true);
    expect(shouldSkipRetrieval("ok")).toBe(true);
  });
});
