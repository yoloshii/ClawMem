/**
 * BACKLOG 82.2, D4 — the hook row of the route table, through the REAL context-surfacing handler: the hook trace
 * records what its vector leg met. Stored vectors the scan skipped are a count on the leg's entry; a refused QUERY
 * vector (the embedding endpoint answered with a malformed vector) is the path `vector-fault`, the hook does not
 * fail, and the lexical side still answers.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startVectorDaemon, type VectorDaemonHandle } from "../../src/vector-daemon.ts";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { newSurfacingTrace } from "../../src/eval/hook-trace.ts";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";
import { clearConfigCache } from "../../src/config.ts";
import { VecPoisonError } from "../../src/vector-guard.ts";

const ENV_KEYS = ["CLAWMEM_PROFILE", "CLAWMEM_HOOK_DEDUP_WINDOW_SEC", "CLAWMEM_SURFACE_SECONDARY_VAULTS", "CLAWMEM_SESSION_FOCUS", "CLAWMEM_VECTOR_DAEMON_REQUIRED", "CLAWMEM_VAULTS", "XDG_RUNTIME_DIR"] as const;
let saved: Record<string, string | undefined>;
let runtimeDir: string | null = null;
let daemon: VectorDaemonHandle | null = null;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
  process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "false";
  process.env.CLAWMEM_PROFILE = "balanced";
  delete process.env.CLAWMEM_SESSION_FOCUS;
  delete process.env.CLAWMEM_VECTOR_DAEMON_REQUIRED;
  delete process.env.CLAWMEM_VAULTS;
  // An isolated socket dir: the only daemon for a test's vault is the one that test starts.
  runtimeDir = mkdtempSync(join(tmpdir(), "clawmem-822-fault-trace-"));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  clearConfigCache();
});
afterEach(() => {
  daemon?.close(); daemon = null;
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  runtimeDir = null;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  clearConfigCache();
});

const PROMPT = "deployment pipeline rollback checklist for the release train";
function vault(): Store {
  const store = createTestStore();
  seedDocuments(store, [
    { path: "m/keyword-hit.md", title: "deployment pipeline rollback checklist", body: "deployment pipeline rollback checklist for the release train operators", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
  ]);
  return store;
}
type Faulty = Store["searchVecWithFaults"];
const primary = (trace: ReturnType<typeof newSurfacingTrace>) => (trace.vectorLegs ?? []).filter(leg => leg.leg === "primary");

describe("the hook trace and a vector fault", () => {
  it("a healthy scan: the entry has no fault count", async () => {
    const store = vault();
    store.searchVecWithFaults = (async () => ({ results: [], vectorFaults: 0 })) as Faulty;
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: PROMPT, sessionId: "fault-trace-clean" }, { trace });
    expect(primary(trace)).toEqual([{ leg: "primary", path: "absent" }]);
  }, 20_000);

  it("stored vectors the scan skipped: ONE entry for the leg, with the count", async () => {
    const store = vault();
    store.searchVecWithFaults = (async () => ({ results: [], vectorFaults: 2, firstFault: "abc_0" })) as Faulty;
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: PROMPT, sessionId: "fault-trace-stored" }, { trace });
    expect(primary(trace)).toEqual([{ leg: "primary", path: "absent", vectorFaults: 2 }]);
  }, 20_000);

  it("a refused query vector: the path is `vector-fault`, the hook does not fail, the lexical side answers", async () => {
    const store = vault();
    store.searchVecWithFaults = (async () => { throw new VecPoisonError("non-finite", "endpoint", { context: "query" }, { elementIndex: 0 }); }) as Faulty;
    const trace = newSurfacingTrace();
    const out = await contextSurfacing(store, { prompt: PROMPT, sessionId: "fault-trace-refused" }, { trace });
    expect(primary(trace)).toEqual([{ leg: "primary", path: "vector-fault" }]);
    expect(JSON.stringify(out)).toContain("rollback checklist");
  }, 20_000);

  it("a live daemon whose scan skipped stored vectors: the leg entry is `ok` WITH the count", async () => {
    const store = vault();
    daemon = await startVectorDaemon(store, () => {}, async () => ({ hits: [], vectorFaults: 3, firstFault: "abc_0", scanned: 3 }));
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: PROMPT, sessionId: "fault-trace-daemon" }, { trace });
    const entries = primary(trace);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ leg: "primary", path: "ok", vectorFaults: 3 });
  }, 20_000);

  it("a live daemon with a clean scan: `ok`, no count", async () => {
    const store = vault();
    daemon = await startVectorDaemon(store, () => {}, async () => ({ hits: [], vectorFaults: 0, scanned: 0 }));
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: PROMPT, sessionId: "fault-trace-daemon-clean" }, { trace });
    const entries = primary(trace);
    expect(entries.length).toBe(1);
    expect(entries[0]!.path).toBe("ok");
    expect(entries[0]!.vectorFaults).toBeUndefined();
  }, 20_000);
});
