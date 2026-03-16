import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  PROFILES,
  getActiveProfile,
  clearConfigCache,
  type PerformanceProfile,
} from "../../src/config.ts";

let originalProfile: string | undefined;

beforeEach(() => {
  originalProfile = process.env.CLAWMEM_PROFILE;
  clearConfigCache();
});

afterEach(() => {
  if (originalProfile !== undefined) {
    process.env.CLAWMEM_PROFILE = originalProfile;
  } else {
    delete process.env.CLAWMEM_PROFILE;
  }
  clearConfigCache();
});

// ─── getActiveProfile ───────────────────────────────────────────────

describe("getActiveProfile", () => {
  it("returns balanced profile by default", () => {
    delete process.env.CLAWMEM_PROFILE;
    const p = getActiveProfile();
    expect(p.tokenBudget).toBe(800);
    expect(p.useVector).toBe(true);
  });

  it("returns speed profile when CLAWMEM_PROFILE=speed", () => {
    process.env.CLAWMEM_PROFILE = "speed";
    const p = getActiveProfile();
    expect(p.tokenBudget).toBe(400);
    expect(p.useVector).toBe(false);
  });

  it("returns deep profile when CLAWMEM_PROFILE=deep", () => {
    process.env.CLAWMEM_PROFILE = "deep";
    const p = getActiveProfile();
    expect(p.tokenBudget).toBe(1200);
    expect(p.useVector).toBe(true);
  });

  it("falls back to balanced for unknown profile name", () => {
    process.env.CLAWMEM_PROFILE = "nonexistent";
    const p = getActiveProfile();
    expect(p.tokenBudget).toBe(800);
  });
});

// ─── PROFILES constant ──────────────────────────────────────────────

describe("PROFILES", () => {
  it("speed has useVector=false and low token budget", () => {
    expect(PROFILES.speed.useVector).toBe(false);
    expect(PROFILES.speed.tokenBudget).toBe(400);
    expect(PROFILES.speed.maxResults).toBe(5);
  });

  it("balanced has useVector=true and 800 token budget", () => {
    expect(PROFILES.balanced.useVector).toBe(true);
    expect(PROFILES.balanced.tokenBudget).toBe(800);
    expect(PROFILES.balanced.maxResults).toBe(10);
  });

  it("deep has highest token budget and lowest minScore", () => {
    expect(PROFILES.deep.tokenBudget).toBe(1200);
    expect(PROFILES.deep.minScore).toBeLessThan(PROFILES.balanced.minScore);
    expect(PROFILES.deep.maxResults).toBe(15);
  });

  it("all profiles have required fields", () => {
    for (const name of ["speed", "balanced", "deep"] as PerformanceProfile[]) {
      const p = PROFILES[name];
      expect(typeof p.tokenBudget).toBe("number");
      expect(typeof p.maxResults).toBe("number");
      expect(typeof p.useVector).toBe("boolean");
      expect(typeof p.vectorTimeout).toBe("number");
      expect(typeof p.minScore).toBe("number");
      expect(typeof p.minScoreRatio).toBe("number");
      expect(typeof p.absoluteFloor).toBe("number");
      expect(typeof p.activationFloor).toBe("number");
      expect(typeof p.thresholdMode).toBe("string");
    }
  });

  it("all profiles default to adaptive thresholdMode", () => {
    for (const name of ["speed", "balanced", "deep"] as PerformanceProfile[]) {
      expect(PROFILES[name].thresholdMode).toBe("adaptive");
    }
  });

  it("adaptive thresholds are ordered correctly across profiles", () => {
    // Deeper profiles should be more permissive (lower floors, lower ratios)
    expect(PROFILES.speed.minScoreRatio).toBeGreaterThan(PROFILES.balanced.minScoreRatio);
    expect(PROFILES.balanced.minScoreRatio).toBeGreaterThan(PROFILES.deep.minScoreRatio);
    expect(PROFILES.speed.activationFloor).toBeGreaterThan(PROFILES.balanced.activationFloor);
    expect(PROFILES.balanced.activationFloor).toBeGreaterThan(PROFILES.deep.activationFloor);
    expect(PROFILES.speed.absoluteFloor).toBeGreaterThan(PROFILES.balanced.absoluteFloor);
    expect(PROFILES.balanced.absoluteFloor).toBeGreaterThan(PROFILES.deep.absoluteFloor);
  });

  it("activationFloor > absoluteFloor for all profiles", () => {
    for (const name of ["speed", "balanced", "deep"] as PerformanceProfile[]) {
      expect(PROFILES[name].activationFloor).toBeGreaterThan(PROFILES[name].absoluteFloor);
    }
  });

  it("deep profile has deepEscalation enabled", () => {
    expect(PROFILES.deep.deepEscalation).toBe(true);
    expect(PROFILES.speed.deepEscalation).toBe(false);
    expect(PROFILES.balanced.deepEscalation).toBe(false);
  });
});
