/**
 * 62.1 on Hermes: the plugin (`src/hermes/__init__.py`) keeps its own transcript — `sync_turn` appends each completed
 * turn — and prefetches context in the background: after turn N it runs context-surfacing on turn N's text, and the
 * result reaches the agent with a later prompt, or with none.
 *
 * Found at the 62.1 docs stage (against the implementation that cleared review): the plugin ran the Stop-family hooks
 * only at `on_session_end`, and a transcript's first Stop anchors its cursors at the current turn (design D2), so a
 * Hermes session extracted its LAST turn only and wrote no handoff (one turn holds 2 of the 4 messages the handoff
 * needs); v0.40.3 read the last 200 messages at that one Stop. And a prefetch row paired as Claude Code's (the turn of
 * its own prompt), so its references were tested in the turn BEFORE the one its context reached.
 *
 * T28/T29 (codex): a first pass that runs late or fails must not skip earlier turns (a Hermes transcript begun after
 * the upgrade starts at its first line — a small header line the plugin writes gives its start time); "the next turn"
 * is not proof of delivery — a trivial prompt skips the prefetch, a late result is dropped, a lagging sync reorders
 * lines — so delivery is carried by IDENTITY: context-surfacing hands the plugin its row's id, and the plugin writes, on
 * the user line of the turn it handed the context to, that id (or null) and when; the session end runs its own
 * transcript's final pass.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { type Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { getDefaultLlamaCpp, setDefaultLlamaCpp } from "../../src/llm.ts";
import { runStopWorkerTick } from "../../src/stop-worker.ts";
import { decisionExtractor } from "../../src/hooks/decision-extractor.ts";
import { handoffGenerator } from "../../src/hooks/handoff-generator.ts";
import { feedbackLoop } from "../../src/hooks/feedback-loop.ts";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { applySurfacingBookkeeping, type SurfacingBookkeepingJob } from "../../src/hooks/surfacing-bookkeeping.ts";
import { attributeTranscript } from "../../src/stop-feedback.ts";
import { hermesMark, scanHermesTranscript } from "../../src/stop-hermes-scan.ts";
import { promptSha, transcriptKey } from "../../src/stop-pairing.ts";
import { STOP_SCHEMA_MARKER } from "../../src/stop-schema.ts";
import { T0, iso } from "./stop-fixtures.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "clawmem-621-hermes-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  setDefaultLlamaCpp(null);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type Delivery = { usage_id: number | null; at: number };
/** One turn as the plugin's `sync_turn` writes it: both lines at the sync's millisecond time; the user line carries the
 * prefetch the turn received, when prefetch() ran for it. */
function hermesTurn(user: string, reply: string, tMs: number, delivery?: Delivery): string {
  const userLine: Record<string, unknown> = { type: "message", message: { role: "user", content: user }, timestamp: iso(tMs) };
  if (delivery) userLine.clawmem_delivery = { usage_id: delivery.usage_id, at: iso(delivery.at) };
  return JSON.stringify(userLine) + "\n"
    + JSON.stringify({ type: "message", message: { role: "assistant", content: reply }, timestamp: iso(tMs) }) + "\n";
}
/** The plugin's record that a prefetch's row is settled with no recipient turn. */
const hermesOutcome = (usageId: number, outcome: "dropped" | "unresolved", tMs: number) =>
  JSON.stringify({ type: "clawmem-prefetch-outcome", usage_id: usageId, outcome, timestamp: iso(tMs) }) + "\n";
/** The header line the plugin writes when it creates a transcript. */
const hermesHeader = (tMs: number) => JSON.stringify({ type: "clawmem-transcript", host: "hermes", timestamp: iso(tMs) }) + "\n";
/** The time this vault's stop pipeline was installed (the fixtures' clock is T0). */
function installedAt(store: Store, tMs: number): void {
  store.db.prepare(`UPDATE vault_flags SET updated_at = ? WHERE flag = ?`).run(iso(tMs), STOP_SCHEMA_MARKER);
}

const HOST = "hermes";

function fakeModels(observed: string[][]) {
  setDefaultLlamaCpp({
    generate: async (p: string) => {
      if (p.includes("session summarizer")) {
        return { text: `<summary><request>R</request><investigated>None</investigated><learned>None</learned><completed>Done</completed><next_steps>None</next_steps></summary>`, model: "f", done: true };
      }
      if (!p.includes("Extract observations:")) return { text: "", model: "f", done: true };
      const section = p.slice(p.indexOf("--- TRANSCRIPT ---"));
      const turns = [...new Set([...section.matchAll(/question for turn (\d+)/g)].map(m => m[1]!))];
      observed.push(turns);
      return {
        text: turns.map(n => `<observation><type>decision</type><title>Decision for turn ${n}</title><facts><fact>Turn ${n} decided to ship feature ${n}</fact></facts><narrative>Turn ${n} needed it.</narrative></observation>`).join("\n"),
        model: "f", done: true,
      };
    },
    embed: async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: "f" }),
  } as any);
}
const reply = (n: number) => `For turn ${n} we decided to ship feature ${n} after reviewing the options carefully.`;
const observationTitles = (store: Store) =>
  (store.db.prepare(`SELECT title FROM documents WHERE collection = '_clawmem' AND path LIKE 'observations/%' AND active = 1 ORDER BY id`).all() as { title: string }[]).map(r => r.title);
const digestCount = (store: Store, sid: string) =>
  (store.db.prepare(`SELECT COUNT(*) AS n FROM stop_items WHERE session_id = ? AND kind = 'turn-digest'`).get(sid) as { n: number }).n;

// ─── The Stop-family hooks, run the way the plugin now runs them (a pass after every synced turn) ──────────────────
describe("Hermes: a Stop pass after every synced turn covers the whole session", () => {
  let observed: string[][] = [];
  beforeEach(() => { observed = []; fakeModels(observed); });

  it("every turn is extracted once, and the handoff covers the session", async () => {
    const store = createTestStore();
    const path = join(tmp(), "sess-hermes-0001.jsonl");
    writeFileSync(path, "");
    const input = { sessionId: "sess-hermes-0001", transcriptPath: path, hookEventName: "Stop", host: HOST } as any;
    for (let n = 1; n <= 4; n++) {
      appendFileSync(path, hermesTurn(`question for turn ${n}`, reply(n), n * 60_000));
      await decisionExtractor(store, input);
      await handoffGenerator(store, input);
    }
    // The session-end pass finds nothing new.
    await decisionExtractor(store, input);
    expect(observed).toEqual([["1"], ["2"], ["3"], ["4"]]);
    expect(observationTitles(store)).toEqual(["Decision for turn 1", "Decision for turn 2", "Decision for turn 3", "Decision for turn 4"]);
    // Two turns hold the four messages a handoff needs: the first summary covers turns 1-2, the later turns are digests,
    // which the session end's render-only flush shows.
    expect(store.db.prepare(`SELECT 1 FROM stop_items WHERE session_id = ? AND kind = 'handoff-summary'`).get("sess-hermes-0001")).not.toBeNull();
    await handoffGenerator(store, { ...input, hookEventName: "SessionEnd" });
    const handoff = store.db.prepare(
      `SELECT c.doc AS body FROM documents d JOIN content c ON c.hash = d.hash WHERE d.collection = '_clawmem' AND d.path LIKE 'handoffs/%' AND d.active = 1`
    ).all() as { body: string }[];
    expect(handoff.length).toBe(1);
    expect(handoff[0]!.body).toContain("question for turn 3");
    expect(handoff[0]!.body).toContain("question for turn 4");
  });
});

// ─── T28 #1: a late or failed first pass loses no turn of a transcript begun after the upgrade ────────────────────
describe("Hermes: a transcript begun after the upgrade is read from its first line (T28 #1)", () => {
  let observed: string[][] = [];
  beforeEach(() => { observed = []; fakeModels(observed); });

  it("a first pass that comes after two turns extracts and digests both", async () => {
    const store = createTestStore();
    installedAt(store, -3_600_000);   // installed an hour before the session began
    const sid = "sess-hermes-late";
    const path = join(tmp(), `${sid}.jsonl`);
    writeFileSync(path, hermesHeader(60_000) + hermesTurn("question for turn 1", reply(1), 60_000)
      + hermesTurn("question for turn 2", reply(2), 120_000));
    const input = { sessionId: sid, transcriptPath: path, hookEventName: "Stop", host: HOST } as any;
    await decisionExtractor(store, input);
    await handoffGenerator(store, input);
    expect(observed.flat()).toEqual(["1", "2"]);
    expect(observationTitles(store)).toEqual(["Decision for turn 1", "Decision for turn 2"]);
    // Both turns were digested (the first summary then covered them).
    const summary = store.db.prepare(`SELECT 1 FROM stop_items WHERE session_id = ? AND kind = 'handoff-summary'`).get(sid);
    expect(digestCount(store, sid) + (summary ? 2 : 0)).toBe(2);
  });

  it("a first user message larger than one read does not defeat it: the header dates the transcript (T29 #5)", async () => {
    const store = createTestStore();
    installedAt(store, -3_600_000);
    const sid = "sess-hermes-big";
    const path = join(tmp(), `${sid}.jsonl`);
    const big = "question for turn 1 " + "x".repeat(200_000);
    writeFileSync(path, hermesHeader(60_000) + hermesTurn(big, reply(1), 60_000)
      + hermesTurn("question for turn 2", reply(2), 120_000) + hermesTurn("question for turn 3", reply(3), 180_000));
    await decisionExtractor(store, { sessionId: sid, transcriptPath: path, hookEventName: "Stop", host: HOST } as any);
    expect(observed.flat()).toEqual(["1", "2", "3"]);
  });

  it("a Hermes transcript begun BEFORE the upgrade still starts at its current turn (history is not replayed)", async () => {
    const store = createTestStore();
    installedAt(store, 86_400_000);   // installed a day after these turns
    const sid = "sess-hermes-old";
    const path = join(tmp(), `${sid}.jsonl`);
    writeFileSync(path, hermesTurn("question for turn 1", reply(1), 60_000) + hermesTurn("question for turn 2", reply(2), 120_000));
    await decisionExtractor(store, { sessionId: sid, transcriptPath: path, hookEventName: "Stop", host: HOST } as any);
    expect(observed.flat()).toEqual(["2"]);
  });

  it("a Claude Code transcript keeps the current-turn rule (a forked session opens with copied history)", async () => {
    const store = createTestStore();
    installedAt(store, -3_600_000);
    const sid = "sess-cc-fork";
    const path = join(tmp(), `${sid}.jsonl`);
    const cc = (role: string, text: string, t: number) => JSON.stringify(
      role === "user" ? { type: "user", message: { role: "user", content: text }, timestamp: iso(t) }
        : { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, timestamp: iso(t) }) + "\n";
    writeFileSync(path, cc("user", "question for turn 1", 60_000) + cc("assistant", reply(1), 60_500)
      + cc("user", "question for turn 2", 120_000) + cc("assistant", reply(2), 120_500));
    await decisionExtractor(store, { sessionId: sid, transcriptPath: path, hookEventName: "Stop" } as any);
    expect(observed.flat()).toEqual(["2"]);
  });
});

// ─── Feedback: a prefetch is credited only through the plugin's delivery mark ──────────────────────────────────────
function seedDoc(store: Store, collection: string, path: string, title: string): number {
  const hash = `h-${collection}-${path}`;
  store.insertContent(hash, `# ${title}\n\nbody`, iso(0));
  store.insertDocument(collection, path, title, hash, iso(0), iso(0));
  return store.findActiveDocument(collection, path)!.id;
}

/** The row `queue_prefetch` leaves after turn N (prompt = turn N's text), with its manifest drained. */
function prefetchRow(store: Store, sessionId: string, path: string, prompt: string, tMs: number, entries: { displayPath: string; title: string }[]): number {
  const id = store.insertUsage({
    sessionId, timestamp: iso(tMs), hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0,
    turnIndex: 0, queryText: prompt, promptSha: promptSha(prompt), transcriptKey: transcriptKey(path), host: HOST, sessionKey: null,
  });
  const job = {
    v: 1, kind: "surfacing-bookkeeping", jobId: `job-${id}`, sessionId, turnIndex: 0, usageId: id, queryHash: "qh",
    injectedPaths: entries.map(e => e.displayPath), estimatedTokens: 10,
    vaults: [{ vault: null, docs: entries.map(e => ({ displayPath: e.displayPath, searchScore: 0.9 })) }],
    manifest: entries.map(e => ({ vault: null, displayPath: e.displayPath, displayedTitle: e.title })),
  } as SurfacingBookkeepingJob;
  expect(applySurfacingBookkeeping(store, job).failedUnits).toEqual([]);
  return id;
}
const stateOf = (store: Store, id: number) =>
  store.db.prepare(`SELECT state, reason FROM feedback_turns WHERE usage_id = ?`).get(id) as { state: string; reason: string | null };
const accessOf = (store: Store, id: number) => (store.db.prepare(`SELECT access_count FROM documents WHERE id = ?`).get(id) as { access_count: number }).access_count;

describe("Hermes feedback: a prefetch row is credited in the turn that received it, by id (T29)", () => {
  const SID = "sess-hermes-fb01";
  const PLAN = { displayPath: "notes/projects/ingest-plan.md", title: "Ingest pipeline plan" };
  const Q1 = "how should we batch the ingest";
  const Q2 = "and what about the retries?";
  const CITES = "Per the Ingest pipeline plan, retries back off exponentially.";
  const stop = (store: Store, path: string) => feedbackLoop(store, { sessionId: SID, transcriptPath: path, hookEventName: "Stop", host: HOST } as any, { vaults: [] });
  function setup(): { store: Store; doc: number; path: string } {
    const store = createTestStore();
    const doc = seedDoc(store, "notes", "projects/ingest-plan.md", PLAN.title);
    return { store, doc, path: join(tmp(), `${SID}.jsonl`) };
  }
  /** Turn 1, then the prefetch row it queued (written after the turn's sync). */
  function turnOneAndRow(store: Store, path: string, reply1 = "Let me look at the batching code first."): number {
    writeFileSync(path, hermesHeader(100_000) + hermesTurn(Q1, reply1, 100_000));
    return prefetchRow(store, SID, path, Q1, 100_500, [PLAN]);
  }

  it("a reference in the turn that received the prefetch is credited", async () => {
    const { store, doc, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn(Q2, CITES, 200_000, { usage_id: u1, at: 150_000 }));
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(store, doc)).toBe(1);
  });

  it("a mention in the prefetch prompt's own turn — before its context existed — is not credited", async () => {
    const { store, doc, path } = setup();
    const u1 = turnOneAndRow(store, path, "The Ingest pipeline plan says batches of 100.");
    appendFileSync(path, hermesTurn(Q2, "Retries back off exponentially.", 200_000, { usage_id: u1, at: 150_000 }));
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(store, doc)).toBe(0);
  });

  it("a turn with no prefetch (trivial prompt) is passed over: the turn that received it is credited (T28 #2)", async () => {
    const { store, doc, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn("ok", "The Ingest pipeline plan is the reference here.", 200_000)   // no record
      + hermesTurn(Q2, CITES, 300_000, { usage_id: u1, at: 250_000 }));
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(store, doc)).toBe(1);
  });

  it("a mention in that trivial turn — before the hand-over — is not credited (T28 #2)", async () => {
    const { store, doc, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn("ok", "The Ingest pipeline plan is the reference here.", 200_000)
      + hermesTurn(Q2, "Retries back off exponentially.", 300_000, { usage_id: u1, at: 250_000 }));
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(store, doc)).toBe(0);
  });

  it("a result the plugin dropped (too late for its turn) is closed not-delivered, whatever the turn says (T28 #2)", async () => {
    const { store, doc, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn(Q2, CITES, 200_000) + hermesOutcome(u1, "dropped", 201_000));
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "unattributable", reason: "not-delivered" });
    expect(accessOf(store, doc)).toBe(0);
  });

  it("the same prompt prefetched twice: only the row whose id the turn names is credited (T29 #2, #3)", async () => {
    const { store, doc, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn(Q1, "Still looking.", 200_000));   // the prefetch skipped: no record
    const u2 = prefetchRow(store, SID, path, Q1, 200_500, [PLAN]);
    // U2's result replaced U1's before any turn took it: the plugin recorded U1 dropped.
    appendFileSync(path, hermesOutcome(u1, "dropped", 201_000) + hermesTurn(Q2, CITES, 300_000, { usage_id: u2, at: 250_000 }));
    await stop(store, path);
    expect(stateOf(store, u2)).toEqual({ state: "attributed", reason: null });
    expect(stateOf(store, u1)).toEqual({ state: "unattributable", reason: "not-delivered" });
    expect(accessOf(store, doc)).toBe(1);
  });

  it("a row stays open until the plugin settles it; an unresolved record closes it (T30 #3)", async () => {
    const { store, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn(Q2, CITES, 200_000));   // no record for this turn
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "pending", reason: null });   // no clock decides anything
    appendFileSync(path, hermesOutcome(u1, "unresolved", 250_000));
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "unattributable", reason: "not-delivered" });
  });

  it("a transcript clock behind the hook's does not hide the recipient: Hermes is read from the start (T31 #1)", async () => {
    const { store, doc, path } = setup();
    writeFileSync(path, hermesHeader(100_000) + hermesTurn(Q1, "Let me look at the batching code first.", 100_000));
    const u1 = prefetchRow(store, SID, path, Q1, 900_000, [PLAN]);   // the row's clock runs ahead of every line
    appendFileSync(path, hermesTurn(Q2, CITES, 200_000, { usage_id: u1, at: 150_000 })
      + hermesTurn("thanks, next topic", "Sure.", 300_000));
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(store, doc)).toBe(1);
  });

  it("each pass reads only what the transcript gained since the last: the read resumes, never restarts (T32 #3)", async () => {
    const { store, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn(Q2, CITES, 200_000, { usage_id: u1, at: 150_000 }));
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "attributed", reason: null });
    const scanned = () => (store.db.prepare(`SELECT byte_offset FROM hermes_scan WHERE session_id = ?`).get(SID) as { byte_offset: number }).byte_offset;
    expect(scanned()).toBe(statSync(path).size);
    // A record rewritten in place inside the part already read (same length, same file): a pass that read from the
    // start again would find it; one that resumes does not.
    const u2 = prefetchRow(store, SID, path, Q2, 200_500, [PLAN]);
    expect(String(u2).length).toBe(String(u1).length);
    const before = readFileSync(path, "utf-8");
    writeFileSync(path, before.replace(`"usage_id":${u1},`, `"usage_id":${u2},`));
    appendFileSync(path, hermesTurn("and one more question", "Noted.", 300_000));
    await stop(store, path);
    expect(stateOf(store, u2)).toEqual({ state: "pending", reason: null });
    expect(scanned()).toBe(statSync(path).size);
  });

  it("a recipient read in one pass is closed by the next user line read in a later one (T32 #3)", async () => {
    const { store, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn(Q2, CITES, 200_000, { usage_id: u1, at: 150_000 }));
    const pass = (provisional: boolean) =>
      attributeTranscript(store, { sessionId: SID, transcriptPath: path, host: HOST, atStop: false, provisional });
    pass(true);   // the worker, on a quiet transcript: the trailing recipient is credited provisionally
    expect(stateOf(store, u1)).toEqual({ state: "attributed", reason: "provisional" });
    appendFileSync(path, hermesTurn("and one more question", "Noted.", 300_000));
    pass(false);  // the next user line, read by this pass only, ends the recipient's turn
    expect(stateOf(store, u1)).toEqual({ state: "attributed", reason: null });
  });

  it("a transcript replaced under the same key is read again from its start (T32 #3)", async () => {
    const { store, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn(Q2, "Still looking.", 200_000));   // no record for u1
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "pending", reason: null });
    rmSync(path);   // another file at the path: a new inode and a new first line, whose recipient line names u1
    writeFileSync(path, hermesHeader(400_000) + hermesTurn(Q1, "Looking again.", 400_000)
      + hermesTurn(Q2, CITES, 500_000, { usage_id: u1, at: 450_000 }));
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "attributed", reason: null });
  });

  it("a scan of a file replaced (and read again) before it commits records nothing (T33 #2)", () => {
    const { store, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn(Q2, CITES, 200_000, { usage_id: u1, at: 150_000 }));   // the old file names u1's recipient
    const tk = transcriptKey(path);
    const late = scanHermesTranscript(store.db, SID, tk, path, {
      beforeCommit: () => {
        rmSync(path);   // replaced meanwhile — u1 dropped in the new file — and read by another pass first
        writeFileSync(path, hermesHeader(400_000) + hermesTurn(Q1, "Looking again.", 400_000) + hermesOutcome(u1, "dropped", 450_000));
        expect(scanHermesTranscript(store.db, SID, tk, path).committed).toBe(true);
      },
    });
    expect(late.committed).toBe(false);
    expect(hermesMark(store.db, SID, tk, u1)).toEqual({ delivered: null, settled: true });
  });

  it("a scan that read before a final verdict cannot put back the marks the verdict dropped (T33 #2)", () => {
    const { store, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn(Q2, CITES, 200_000, { usage_id: u1, at: 150_000 }));
    const tk = transcriptKey(path);
    const late = scanHermesTranscript(store.db, SID, tk, path, {
      beforeCommit: () => {   // another pass reads, credits u1 for good, and drops its marks
        attributeTranscript(store, { sessionId: SID, transcriptPath: path, host: HOST, atStop: true });
      },
    });
    expect(stateOf(store, u1)).toEqual({ state: "attributed", reason: null });
    expect(late.committed).toBe(false);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM hermes_marks`).get() as { n: number }).n).toBe(0);
  });

  it("fifty rows still waiting for a record never keep a decided one out of the page (T33 #3)", async () => {
    const { store, doc, path } = setup();
    writeFileSync(path, hermesHeader(100_000) + hermesTurn(Q1, "Let me look at the batching code first.", 100_000));
    for (let k = 0; k < 50; k++) prefetchRow(store, SID, path, `waiting prompt number ${k}`, 100_100 + k, [PLAN]);   // no record ever comes
    const u51 = prefetchRow(store, SID, path, Q1, 100_500, [PLAN]);
    appendFileSync(path, hermesTurn(Q2, CITES, 200_000, { usage_id: u51, at: 150_000 }));
    await stop(store, path);
    expect(stateOf(store, u51)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(store, doc)).toBe(1);
  });

  it("the worker comes back for decidable rows a full page left behind (T34 #1)", async () => {
    const { store, path } = setup();
    let text = hermesHeader(100_000) + hermesTurn(Q1, "Let me look at the batching code first.", 100_000);
    const ids: number[] = [];
    for (let k = 0; k < 51; k++) {
      const id = prefetchRow(store, SID, path, `question number ${k}`, 100_100 + k * 1000, [PLAN]);
      ids.push(id);
      text += hermesTurn(`question number ${k + 1}`, "Noted.", 100_500 + k * 1000, { usage_id: id, at: 100_400 + k * 1000 });
    }
    writeFileSync(path, text);
    await handoffGenerator(store, { sessionId: SID, transcriptPath: path, hookEventName: "SessionEnd", host: HOST } as any);
    await runStopWorkerTick(store, [], getDefaultLlamaCpp());   // decides the first page of 50
    await runStopWorkerTick(store, [], getDefaultLlamaCpp());   // and comes back for the 51st: nothing on disk changed
    expect(ids.filter(id => stateOf(store, id).state === "pending")).toEqual([]);
  });

  it("verdicts prepared from marks another pass has since replaced are not applied (T34 #3)", () => {
    const { store, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn(Q2, CITES, 200_000, { usage_id: u1, at: 150_000 }));   // the old file names u1's recipient
    const tk = transcriptKey(path);
    attributeTranscript(store, {
      sessionId: SID, transcriptPath: path, host: HOST, atStop: true,
      beforeVerdict: () => {   // replaced meanwhile (u1 dropped in the new file), and read by another pass
        rmSync(path);
        writeFileSync(path, hermesHeader(400_000) + hermesTurn(Q1, "Looking again.", 400_000) + hermesOutcome(u1, "dropped", 450_000));
        expect(scanHermesTranscript(store.db, SID, tk, path).committed).toBe(true);
      },
    });
    expect(stateOf(store, u1)).toEqual({ state: "pending", reason: null });
    attributeTranscript(store, { sessionId: SID, transcriptPath: path, host: HOST, atStop: true });
    expect(stateOf(store, u1)).toEqual({ state: "unattributable", reason: "not-delivered" });
  });

  it("a pass over a transcript with nothing new reads, checks and records nothing (T34 #5)", async () => {
    const { store, path } = setup();
    turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn(Q2, "Still looking.", 200_000));   // no record: the row stays open
    await stop(store, path);
    const generation = () => (store.db.prepare(`SELECT generation FROM hermes_scan WHERE session_id = ?`).get(SID) as { generation: number }).generation;
    const g = generation();
    await stop(store, path);
    await stop(store, path);
    expect(generation()).toBe(g);
  });

  it("a pass whose scan lost its compare-and-set to another pass says it must run again (T35 #3)", () => {
    const { store, path } = setup();
    const u1 = turnOneAndRow(store, path);
    appendFileSync(path, hermesTurn(Q2, CITES, 200_000, { usage_id: u1, at: 150_000 }));
    const tk = transcriptKey(path);
    const run = attributeTranscript(store, {
      sessionId: SID, transcriptPath: path, host: HOST, atStop: false,
      beforeScanCommit: () => { expect(scanHermesTranscript(store.db, SID, tk, path).committed).toBe(true); },
    });
    expect(run.retry).toBe(true);
    expect(attributeTranscript(store, { sessionId: SID, transcriptPath: path, host: HOST, atStop: true }).retry).toBeUndefined();
  });

  it("a line rewritten in place at the end of what was read is noticed, and the transcript read again (T35 #4)", async () => {
    const { store, path } = setup();
    const u1 = turnOneAndRow(store, path);
    const u2 = prefetchRow(store, SID, path, Q1, 100_600, [PLAN]);
    expect(String(u2).length).toBe(String(u1).length);
    appendFileSync(path, hermesTurn(Q2, "Still looking.", 200_000) + hermesOutcome(u1, "dropped", 201_000));
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "unattributable", reason: "not-delivered" });
    expect(stateOf(store, u2)).toEqual({ state: "pending", reason: null });
    const before = readFileSync(path, "utf-8");   // the last line now names u2: same length, same file
    writeFileSync(path, before.slice(0, before.lastIndexOf(`"usage_id":${u1},`)) + `"usage_id":${u2},` + before.slice(before.lastIndexOf(`"usage_id":${u1},`) + `"usage_id":${u1},`.length));
    await stop(store, path);
    expect(stateOf(store, u2)).toEqual({ state: "unattributable", reason: "not-delivered" });
  });

  it("the prefetch after the last turn waits while the session runs and is closed when the session ends", async () => {
    const { store, path } = setup();
    const u1 = turnOneAndRow(store, path, "Batches of 100, per the Ingest pipeline plan.");
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "pending", reason: null });   // no turn has started since
    // The plugin's session end: the render-only flush records the end, then one more feedback pass.
    await handoffGenerator(store, { sessionId: SID, transcriptPath: path, hookEventName: "SessionEnd", host: HOST } as any);
    await stop(store, path);
    expect(stateOf(store, u1)).toEqual({ state: "unattributable", reason: "not-delivered" });
  });
});

// ─── context-surfacing hands its row's id to the Hermes host, and to no other ─────────────────────────────────────
describe("context-surfacing returns its usage row's id to the Hermes plugin only (T29)", () => {
  const PROMPT = "vortalcrest configuration setup notes";
  function seeded(): Store {
    setDefaultLlamaCpp({ embed: async () => ({ embedding: new Float32Array([0, 0, 1, 0]), model: "f" }), query: async () => null, expandQuery: async () => [] } as any);
    const store = createTestStore();
    const hash = "h-vortalcrest";
    store.insertContent(hash, `Notes on the vortalcrest configuration and its setup steps. ${"Filler prose about unrelated chores. ".repeat(3)}`, iso(0));
    store.insertDocument("notes", "vortalcrest.md", "Vortalcrest setup notes", hash, iso(0), iso(0));
    return store;
  }

  it("host hermes: the output carries the alignment row's id", async () => {
    const store = seeded();
    const out = await contextSurfacing(store, { sessionId: "s-h-1", prompt: PROMPT, transcriptPath: join(tmp(), "s-h-1.jsonl"), host: HOST } as any);
    expect(out.hookSpecificOutput?.additionalContext ?? "").toContain("vortalcrest.md");
    const id = (store.db.prepare(`SELECT MAX(id) AS id FROM context_usage WHERE session_id = 's-h-1'`).get() as { id: number }).id;
    expect(out.clawmemUsageId).toBe(id);
  });

  it("Claude Code: no id in the output", async () => {
    const store = seeded();
    const out = await contextSurfacing(store, { sessionId: "s-cc-1", prompt: PROMPT, transcriptPath: join(tmp(), "s-cc-1.jsonl") } as any);
    expect(out.hookSpecificOutput?.additionalContext ?? "").toContain("vortalcrest.md");
    expect(out.clawmemUsageId).toBeUndefined();
  });
});

// ─── The plugin itself, driven by a stub Hermes and a fake clawmem binary ───────────────────────────────────────────
const PYTHON = Bun.which("python3");
const PLUGIN = resolve(import.meta.dir, "../../src/hermes/__init__.py");

type Call = { hook: string; input: Record<string, unknown> };
function runPlugin(script: string): { calls: Call[]; out: string; dir: string } {
  const dir = tmp();
  mkdirSync(join(dir, "stub", "agent"), { recursive: true });
  writeFileSync(join(dir, "stub", "agent", "__init__.py"), "");
  writeFileSync(join(dir, "stub", "agent", "memory_provider.py"), "class MemoryProvider:\n    pass\n");
  const log = join(dir, "calls.log");
  const bin = join(dir, "clawmem");
  // Logs every call; context-surfacing returns a context and a fresh row id (42, 43, …) — after 4.5 s when the prompt
  // says "slow"; a "slow-" session's Stop hook takes 1.5 s.
  const counter = join(dir, "ids");
  writeFileSync(counter, "41");
  writeFileSync(bin, [
    "#!/bin/bash",
    "input=$(cat)",
    `printf '%s\\t%s\\n' "$2" "$input" >> "${log}"`,
    `case "$2:$input" in`,
    `  context-surfacing:*slow*) sleep 4.5; n=$(( $(cat "${counter}") + 1 )); echo $n > "${counter}"; echo '{"hookSpecificOutput":{"additionalContext":"<vault-context>ctx</vault-context>"},"clawmemUsageId":'$n'}' ;;`,
    `  context-surfacing:*) n=$(( $(cat "${counter}") + 1 )); echo $n > "${counter}"; echo '{"hookSpecificOutput":{"additionalContext":"<vault-context>ctx</vault-context>"},"clawmemUsageId":'$n'}' ;;`,
    `  *'"session_id": "slow-'*) sleep 1.5; echo '{}' ;;`,
    `  *) echo '{}' ;;`,
    "esac",
  ].join("\n") + "\n");
  chmodSync(bin, 0o755);
  const driver = join(dir, "driver.py");
  writeFileSync(driver, [
    "import importlib.util, sys, time",
    `sys.path.insert(0, ${JSON.stringify(join(dir, "stub"))})`,
    `spec = importlib.util.spec_from_file_location("clawmem_hermes", ${JSON.stringify(PLUGIN)})`,
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "real_write_all = m._write_all",
    "def unwritable(): m._write_all = lambda fd, data: (0, len(data) == 0)   # every transcript write fails",
    "def writable(): m._write_all = real_write_all",
    `LOG = ${JSON.stringify(log)}`,
    "def calls(hook=None):",
    "    try: lines = open(LOG).read().splitlines()",
    "    except FileNotFoundError: return []",
    "    return [l for l in lines if hook is None or l.split('\\t', 1)[0] == hook]",
    "def wait_for(hook, n, timeout=5.0):",
    "    end = time.time() + timeout",
    "    while time.time() < end and len(calls(hook)) < n: time.sleep(0.02)",
    "def settle(*providers):",
    "    for x in providers:",
    "        end = time.time() + 10",
    "        while time.time() < end and x._stop_thread is not None and x._stop_thread.is_alive(): x._stop_thread.join(0.1)",
    "p = m.ClawMemProvider()",
    `p.initialize("sess-hermes-plug1", hermes_home=${JSON.stringify(join(dir, "home"))}, agent_context="primary")`,
    script,
    "settle(p)",   // a Stop pass cut off at exit would log half its hook input
  ].join("\n"));
  // No bytecode cache: importing the plugin would otherwise write src/hermes/__pycache__/ into the source tree.
  const r = Bun.spawnSync([PYTHON!, "-B", driver], {
    env: { ...process.env, CLAWMEM_BIN: bin, PYTHONDONTWRITEBYTECODE: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const out = r.stdout.toString() + r.stderr.toString();
  expect(r.exitCode, out).toBe(0);
  let text = "";
  try { text = readFileSync(log, "utf-8"); } catch { /* no call */ }
  const calls = text.split("\n").filter(Boolean).map(l => {
    const tab = l.indexOf("\t");
    return { hook: l.slice(0, tab), input: JSON.parse(l.slice(tab + 1)) };
  });
  return { calls, out, dir };
}
const transcriptLines = (dir: string, sid = "sess-hermes-plug1") =>
  readFileSync(join(dir, "home", "clawmem-transcripts", `${sid}.jsonl`), "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));

describe.skipIf(!PYTHON)("the Hermes plugin runs the stop pipeline the way 62.1 needs it", () => {
  it("runs the three Stop-family hooks after every synced turn, on that turn's transcript, as host hermes", () => {
    const { calls } = runPlugin([
      `p.sync_turn("question for turn 1", "answer 1")`,
      `wait_for("feedback-loop", 1)`,
      `p.sync_turn("question for turn 2", "answer 2")`,
      `wait_for("feedback-loop", 2)`,
    ].join("\n"));
    for (const hook of ["decision-extractor", "handoff-generator", "feedback-loop"]) {
      const mine = calls.filter(c => c.hook === hook);
      expect(mine.length).toBe(2);
      for (const c of mine) {
        expect(c.input).toMatchObject({ session_id: "sess-hermes-plug1", hook_event_name: "Stop", host: "hermes" });
        expect(String(c.input.transcript_path)).toEndWith("clawmem-transcripts/sess-hermes-plug1.jsonl");
      }
    }
  });

  it("at the session end: one more Stop pass, then the render-only SessionEnd flush, then a last feedback pass", () => {
    const { calls } = runPlugin([
      `p.sync_turn("question for turn 1", "answer 1")`,
      `wait_for("feedback-loop", 1)`,
      `p.on_session_end([])`,
    ].join("\n"));
    const seq = calls.map(c => `${c.hook}:${c.input.hook_event_name}`);
    const flush = seq.indexOf("handoff-generator:SessionEnd");
    expect(flush).toBeGreaterThan(0);
    // Before the flush: two complete passes (the turn's, the session end's).
    for (const hook of ["decision-extractor", "handoff-generator", "feedback-loop"]) {
      expect(seq.slice(0, flush).filter(s => s === `${hook}:Stop`).length).toBe(2);
    }
    expect(seq.slice(flush + 1)).toEqual(["feedback-loop:Stop"]);
    expect(calls[flush]!.input).toMatchObject({ session_id: "sess-hermes-plug1", host: "hermes" });
  });

  it("the session end runs its own final pass at once, while another transcript's pass holds the queue (T28 #4)", () => {
    const { calls, out } = runPlugin([
      // A slow pass of another transcript occupies the queue (1.5 s); this session's turn is queued behind it.
      `p._queue_stop_pass("slow-other", "/tmp/clawmem-slow-other.jsonl")`,
      `wait_for("decision-extractor", 1)`,
      `p.sync_turn("question for turn 1", "answer 1")`,
      `t0 = time.time()`,
      `p.on_session_end([])`,
      `print("END_S=%.3f" % (time.time() - t0))`,
    ].join("\n"));
    const mine = calls.filter(c => c.input.session_id === "sess-hermes-plug1").map(c => `${c.hook}:${c.input.hook_event_name}`);
    const flush = mine.indexOf("handoff-generator:SessionEnd");
    expect(flush).toBeGreaterThan(0);
    // Exactly this session's final pass before the flush — its queued pass was taken out and run here.
    for (const hook of ["decision-extractor", "handoff-generator", "feedback-loop"]) {
      expect(mine.slice(0, flush).filter(s => s === `${hook}:Stop`).length).toBe(1);
    }
    // It did not wait behind the other transcript's pass (the plugin reviewed at T28 waited for the whole queue).
    expect(Number(/END_S=([\d.]+)/.exec(out)![1])).toBeLessThan(1.2);
  });

  it("writes a header, millisecond timestamps, and on each turn's user line the prefetch it received (T29)", () => {
    const { dir } = runPlugin([
      `p.queue_prefetch("question for turn 1 about batching")`,
      `wait_for("context-surfacing", 1)`,
      `p._prefetch_thread.join(5)`,
      `p.prefetch("question for turn 2 about retries")`,         // hands over row 42
      `p.sync_turn("question for turn 2 about retries", "answer 2")`,
      `p.sync_turn("question for turn 3", "answer 3")`,          // trivial: no prefetch() call
      `p.prefetch("question for turn 4")`,                       // nothing new to hand over
      `p.sync_turn("question  for turn 4", "answer 4")`,         // same text, other whitespace
      `wait_for("feedback-loop", 1)`,
    ].join("\n"));
    const lines = transcriptLines(dir);
    expect(lines[0]).toMatchObject({ type: "clawmem-transcript", host: "hermes" });
    const users = lines.filter(l => l.message?.role === "user");
    expect(users.map(u => (u.clawmem_delivery === undefined ? "none" : u.clawmem_delivery.usage_id))).toEqual([42, "none", "none"]);
    expect(users[0].clawmem_delivery.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    for (const l of lines) expect(l.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    for (let k = 1; k < lines.length; k++) expect(Date.parse(lines[k].timestamp)).toBeGreaterThanOrEqual(Date.parse(lines[k - 1].timestamp));
  });

  it("dates a new transcript's header by the line it opens, never later (69.14)", () => {
    const { dir } = runPlugin([
      `import itertools`,
      `tick = itertools.count(1791000000000)`,
      `m._now_ms = lambda: next(tick)`,                             // each stamp 1 ms after the one before it
      `p.sync_turn("question for turn 1", "answer 1")`,
    ].join("\n"));
    const lines = transcriptLines(dir);
    expect(lines.map(l => l.message?.role ?? l.type)).toEqual(["clawmem-transcript", "user", "assistant"]);
    expect(lines[0].timestamp).toBe(lines[1].timestamp);
  });

  it("stamps lines in the order they are written, whichever thread writes them (69.14)", () => {
    // The outcome thread stalls right after taking its stamp; turn 2 is synced from another thread meanwhile, and the
    // outcome thread is released only once turn 2 has reached the transcript lock. Every wait is asserted, so a timeout
    // is a failure, never a path through the test.
    const { dir, out } = runPlugin([
      `import itertools, threading`,
      `tick = itertools.count(1791000000000)`,
      `entered, release, contended, seen = threading.Event(), threading.Event(), threading.Event(), {}`,
      `def clock():`,
      `    t = next(tick)`,
      `    if threading.current_thread().name == "outcome":`,
      `        seen["locked"] = p._transcript_lock.locked()`,      // stamped under the write lock? (nothing else holds it)
      `        entered.set(); seen["released"] = release.wait(5)`,
      `    return t`,
      `m._now_ms = clock`,
      `p.sync_turn("question for turn 1", "answer 1")`,
      `settle(p)`,                                                  // turn 1's Stop pass is over: the lock is free
      `class Watched:`,                                             // notes when turn 2 reaches the transcript lock
      `    def __init__(self, inner): self.inner = inner`,
      `    def locked(self): return self.inner.locked()`,
      `    def __enter__(self):`,
      `        if threading.current_thread().name == "turn2": contended.set()`,
      `        return self.inner.__enter__()`,
      `    def __exit__(self, *exc): return self.inner.__exit__(*exc)`,
      `p._transcript_lock = Watched(p._transcript_lock)`,
      `w = threading.Thread(target=p._record_outcome, args=(p._transcript_path, 7, "dropped"), name="outcome")`,
      `w.start()`,
      `assert entered.wait(5)`,
      `t2 = threading.Thread(target=p.sync_turn, args=("question for turn 2", "answer 2"), name="turn2")`,
      `t2.start()`,
      `assert contended.wait(5)`,                                   // turn 2 is at the lock: stamped after the outcome
      `release.set(); w.join(5); t2.join(5)`,
      `assert not w.is_alive() and not t2.is_alive() and seen.get("released") is True`,
      `print("LOCKED_AT_STAMP=%s" % seen.get("locked"))`,
    ].join("\n"));
    expect(out).toContain("LOCKED_AT_STAMP=True");
    const lines = transcriptLines(dir);
    expect(lines.map(l => l.message?.role ?? l.type))
      .toEqual(["clawmem-transcript", "user", "assistant", "clawmem-prefetch-outcome", "user", "assistant"]);
    for (let k = 2; k < lines.length; k++) expect(Date.parse(lines[k].timestamp)).toBeGreaterThanOrEqual(Date.parse(lines[k - 1].timestamp));
  });

  const outcomes = (dir: string) => transcriptLines(dir).filter(l => l.type === "clawmem-prefetch-outcome").map(l => [l.usage_id, l.outcome]);
  const records = (dir: string) => transcriptLines(dir).filter(l => l.message?.role === "user")
    .map(u => (u.clawmem_delivery === undefined ? "none" : u.clawmem_delivery.usage_id));

  it("two unsynced turns of one text cannot be told apart: the hand-over is closed unresolved, no sync records it (T30 #1)", () => {
    const { dir } = runPlugin([
      `p.queue_prefetch("question for turn 1 about batching")`,
      `wait_for("context-surfacing", 1)`,
      `p._prefetch_thread.join(5)`,
      `p.on_turn_start(2, "please run the same check again")`,      // a turn that is never synced (interrupted)…
      `p.prefetch("please run the same check again")`,             // …which received row 42
      `p.on_turn_start(3, "please run the same check again")`,      // its retry (or a sync lagging a turn behind)
      `p.prefetch("please run the same check again")`,
      `p.sync_turn("please run the same check again", "answer")`,
      `wait_for("feedback-loop", 1)`,
    ].join("\n"));
    expect(outcomes(dir)).toEqual([[42, "unresolved"]]);
    expect(records(dir)).toEqual(["none"]);
  });

  it("a third turn of the same text stays unresolved too (the text stays ambiguous while any of them is unsynced)", () => {
    const { dir } = runPlugin([
      `for k in range(3):`,
      `    p.queue_prefetch("question number %d about batching" % k)`,
      `    wait_for("context-surfacing", k + 1)`,
      `    p._prefetch_thread.join(5)`,
      `    p.on_turn_start(10 + k, "the same repeated prompt")`,
      `    p.prefetch("the same repeated prompt")`,
      `p.sync_turn("the same repeated prompt", "a")`,
      `p.sync_turn("the same repeated prompt", "b")`,
      `wait_for("feedback-loop", 1)`,
    ].join("\n"));
    expect(outcomes(dir).sort()).toEqual([[42, "unresolved"], [43, "unresolved"], [44, "unresolved"]]);
    expect(records(dir)).toEqual(["none", "none"]);
  });

  it("a result too late for its turn, and one replaced before any turn took it, are recorded dropped", () => {
    const { dir } = runPlugin([
      `p.queue_prefetch("a slow question about batching")`,        // row 42 arrives after 4.5 s
      `wait_for("context-surfacing", 1)`,
      `p.on_turn_start(2, "question for turn 2")`,
      `p.prefetch("question for turn 2")`,                         // waits 3 s, hands over nothing
      `p.sync_turn("question for turn 2", "answer 2")`,
      `p._prefetch_thread.join(5)`,                                // row 42 lands: too late → dropped
      `p.queue_prefetch("question three about retries")`,           // row 43, cached…
      `wait_for("context-surfacing", 2)`,
      `p._prefetch_thread.join(5)`,
      `p.queue_prefetch("question four about backoff")`,            // …replaced by row 44 before any turn took it
      `wait_for("context-surfacing", 3)`,
      `p._prefetch_thread.join(5)`,
      `wait_for("feedback-loop", 1)`,
    ].join("\n"));
    expect(outcomes(dir)).toEqual([[42, "dropped"], [43, "dropped"]]);
    expect(records(dir)).toEqual(["none"]);
  }, 20_000);

  it("a session switch closes what the old session left open, in the old transcript", () => {
    const { dir } = runPlugin([
      `p.queue_prefetch("question one about batching")`,
      `wait_for("context-surfacing", 1)`,
      `p._prefetch_thread.join(5)`,
      `p.on_turn_start(2, "question two")`,
      `p.prefetch("question two")`,                                 // row 42 handed to a turn that never syncs
      `p.queue_prefetch("question two about retries")`,             // row 43 cached, never handed over
      `wait_for("context-surfacing", 2)`,
      `p._prefetch_thread.join(5)`,
      `p.on_session_switch("sess-hermes-plug2", reset=True)`,
    ].join("\n"));
    expect(outcomes(dir).sort()).toEqual([[42, "unresolved"], [43, "dropped"]]);
  });

  it("past the note cap, the oldest waiting hand-over is closed unresolved, never silently lost (T30 #2)", () => {
    const { dir } = runPlugin([
      `m._PENDING_DELIVERIES_MAX = 2`,
      `for k in range(3):`,
      `    p.queue_prefetch("question number %d about batching" % k)`,
      `    wait_for("context-surfacing", k + 1)`,
      `    p._prefetch_thread.join(5)`,
      `    p.on_turn_start(10 + k, "distinct prompt %d" % k)`,
      `    p.prefetch("distinct prompt %d" % k)`,
      `p.sync_turn("distinct prompt 2", "c")`,
      `wait_for("feedback-loop", 1)`,
    ].join("\n"));
    expect(outcomes(dir)).toEqual([[42, "unresolved"]]);
    expect(records(dir)).toEqual([44]);
  });

  const userTexts = (dir: string) => transcriptLines(dir).filter(l => l.message?.role === "user").map(u => u.message.content);

  it("a turn whose transcript write fails is kept, its record too, and written before the next turn (T31 #2)", () => {
    const { out, dir } = runPlugin([
      `import os`,
      `m._RETRY_MIN_S = m._RETRY_MAX_S = 0`,
      `p.queue_prefetch("question for turn 1 about batching")`,
      `wait_for("context-surfacing", 1)`,
      `p._prefetch_thread.join(5)`,
      `p.prefetch("question for turn 2 about retries")`,          // hands over row 42
      `unwritable()`,                             // the transcript cannot be written
      `p.sync_turn("question for turn 2 about retries", "answer 2")`,
      `time.sleep(0.3)`,
      `print("PASSES", len(calls("feedback-loop")))`,             // no Stop pass over a turn that is not on disk
      `writable()`,
      `p.sync_turn("question for turn 3", "answer 3")`,
      `wait_for("feedback-loop", 1)`,
    ].join("\n"));
    expect(out).toContain("PASSES 0");
    expect(userTexts(dir)).toEqual(["question for turn 2 about retries", "question for turn 3"]);
    expect(records(dir)).toEqual([42, "none"]);
  });

  it("an outcome whose write fails is written at the session end, before the final pass (T31 #2)", () => {
    const { dir } = runPlugin([
      `import os`,
      `unwritable()`,
      `p.queue_prefetch("question one about batching")`,          // row 42 cached
      `wait_for("context-surfacing", 1)`,
      `p._prefetch_thread.join(5)`,
      `p.queue_prefetch("question two about retries")`,           // row 43 replaces it unread: 42 dropped, not writable
      `wait_for("context-surfacing", 2)`,
      `p._prefetch_thread.join(5)`,
      `writable()`,
      `p.on_session_end([])`,
    ].join("\n"));
    expect(outcomes(dir)).toEqual([[42, "dropped"]]);
  });

  const parsedLines = (dir: string, sid = "sess-hermes-plug1") => {
    const raw = readFileSync(join(dir, "home", "clawmem-transcripts", `${sid}.jsonl`), "utf-8").split("\n").filter(Boolean);
    return raw.map(l => { try { return JSON.parse(l); } catch { return null; } });
  };
  /** A disk that fills part-way through a write: `limit(k)` lets the transcript grow by k more bytes only (the write
   * crossing it stops there, every later one fails), `unlimit()` lifts it. And a write can never be taken back:
   * `os.truncate` fails. `userLine(text)`: the length of the plugin's user line for `text`, its newline included. */
  const fillingDisk = [
    `import json, os, resource, signal`,
    `signal.signal(signal.SIGXFSZ, signal.SIG_IGN)`,
    `soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)`,
    `def limit(k): settle(p); resource.setrlimit(resource.RLIMIT_FSIZE, (os.path.getsize(p._transcript_path) + k, hard))`,
    `def unlimit(): resource.setrlimit(resource.RLIMIT_FSIZE, (soft, hard))`,
    `def no_truncate(*a, **k): raise OSError(5, "Input/output error")`,
    `os.truncate = no_truncate`,
    `def userLine(text): return len(json.dumps({"type": "message", "message": {"role": "user", "content": text}, "timestamp": "2026-01-01T00:00:00.000Z"})) + 1`,
  ];

  it("a write that stops part-way goes on from its next byte: no torn line, nothing written twice (T32 #2)", () => {
    const { dir } = runPlugin([
      `m._RETRY_MIN_S = m._RETRY_MAX_S = 0`,
      ...fillingDisk,
      `p.sync_turn("question for turn 1", "answer 1")`,
      `limit(userLine("question for turn 2") + 5)`,              // its user line, and 5 bytes of the reply
      `p.sync_turn("question for turn 2", "answer 2")`,
      `unlimit()`,
      `p.sync_turn("question for turn 3", "answer 3")`,
    ].join("\n"));
    const lines = parsedLines(dir);
    expect(lines.filter(l => l === null).length).toBe(0);
    expect(lines.filter(l => l?.message?.role === "user").map(u => u.message.content))
      .toEqual(["question for turn 1", "question for turn 2", "question for turn 3"]);
    expect(lines.filter(l => l?.message?.role === "assistant").map(u => u.message.content)).toEqual(["answer 1", "answer 2", "answer 3"]);
  });

  it("another process on the same session writes a transcript of its own: nothing interleaves (T33 #1)", () => {
    const { out, dir } = runPlugin([
      `q = m.ClawMemProvider()`,                                 // another process, same session id
      `q.initialize("sess-hermes-plug1", hermes_home=p._hermes_home, agent_context="primary")`,
      `print("Q", os.path.basename(q._transcript_path))`,
      `p.sync_turn("question for turn 1", "answer 1")`,
      `q.sync_turn("from the other process", "its answer")`,
      `p.sync_turn("question for turn 2", "answer 2")`,
      `settle(q)`,
    ].join("\n").replace("print(", "import os\nprint("));
    expect(out).toContain("Q sess-hermes-plug1.2.jsonl");
    expect(userTexts(dir)).toEqual(["question for turn 1", "question for turn 2"]);
    expect(transcriptLines(dir, "sess-hermes-plug1.2").filter(l => l.message?.role === "user").map(u => u.message.content))
      .toEqual(["from the other process"]);
  });

  it("where nothing can be locked, a process writes a transcript of its own name (T33 #5)", () => {
    const { out } = runPlugin([
      `import errno, os`,
      `class NoLocks:`,
      `    LOCK_EX, LOCK_NB = 2, 4`,
      `    @staticmethod`,
      `    def flock(fd, op): raise OSError(errno.ENOLCK, "No locks available")`,
      `for stub in (NoLocks, None):`,                           // a file system without locks; a platform without fcntl
      `    m.fcntl = stub`,
      `    r = m.ClawMemProvider()`,
      `    r.initialize("sess-nolock", hermes_home=p._hermes_home, agent_context="primary")`,
      `    r.sync_turn("question for turn 1", "answer 1")`,
      `    print("R", os.path.basename(r._transcript_path), open(r._transcript_path).read().count("question for turn 1"))`,
      `    settle(r)`,
    ].join("\n"));
    const names = [...out.matchAll(/^R (\S+) (\d+)$/gm)].map(x => [x[1], x[2]]);
    expect(names.length).toBe(2);
    for (const [name, count] of names) {
      expect(name).toMatch(/^sess-nolock\.[0-9a-f]{12}\.jsonl$/);
      expect(count).toBe("1");
    }
    expect(names[0]![0]).not.toBe(names[1]![0]);
  });

  it("a transcript changed under a write cut short gives up the rest of that write, never appends it later (T33 #1)", () => {
    const { out, dir } = runPlugin([
      `import logging`,
      `logging.basicConfig(level=logging.WARNING)`,
      `m._RETRY_MIN_S = m._RETRY_MAX_S = 0`,
      ...fillingDisk,
      `p.sync_turn("question for turn 1", "answer 1")`,
      `limit(userLine("question for turn 2") + 5)`,
      `p.sync_turn("question for turn 2", "answer 2")`,          // its user line is on disk, its reply torn
      `unlimit()`,
      `open(p._transcript_path, "ab").write(b'{"torn": ')`,      // a writer outside the protocol, torn too
      `limit(0)`,
      `p.sync_turn("question for turn 3", "answer 3")`,          // the newline that ends the torn tail fails too
      `unlimit()`,
      `p.sync_turn("question for turn 4", "answer 4")`,
    ].join("\n"));
    const lines = parsedLines(dir);
    expect(lines.filter(l => l === null).length).toBe(1);
    expect(lines.filter(l => l?.message?.role === "user").map(u => u.message.content))
      .toEqual(["question for turn 1", "question for turn 2", "question for turn 3", "question for turn 4"]);
    expect(lines.filter(l => l?.message?.role === "assistant").map(u => u.message.content))
      .toEqual(["answer 1", "answer 3", "answer 4"]);
    expect(out).toContain("changed under a write cut short");
  });

  it("a transcript moved away is written on in the file now at its path (T34 #2)", () => {
    const { out, dir } = runPlugin([
      `import os, logging`,
      `logging.basicConfig(level=logging.WARNING)`,
      `p.sync_turn("question for turn 1", "answer 1")`,
      `os.rename(p._transcript_path, p._transcript_path + ".moved")`,
      `p.sync_turn("question for turn 2", "answer 2")`,
    ].join("\n"));
    expect(userTexts(dir)).toEqual(["question for turn 2"]);
    expect(out).toContain("moved or replaced");
  });

  it("a transcript replaced under a write cut short gives up the rest of it; later turns land in the new file (T34 #2, T35 #1)", () => {
    const { out, dir } = runPlugin([
      `import logging`,
      `logging.basicConfig(level=logging.WARNING)`,
      `m._RETRY_MIN_S = m._RETRY_MAX_S = 0`,
      ...fillingDisk,
      `p.sync_turn("question for turn 1", "answer 1")`,
      `limit(userLine("question for turn 2") + 5)`,
      `p.sync_turn("question for turn 2", "answer 2")`,          // part of it in the file about to be replaced
      `unlimit()`,
      `os.rename(p._transcript_path, p._transcript_path + ".old")`,
      `open(p._transcript_path, "w").close()`,                   // a new, empty file at the path
      `p.sync_turn("question for turn 3", "answer 3")`,
    ].join("\n"));
    const lines = parsedLines(dir);
    expect(lines.filter(l => l === null).length).toBe(0);
    expect(lines.filter(l => l?.message?.role === "user").map(u => u.message.content)).toEqual(["question for turn 3"]);
    expect(out).toContain("the rest of a write cut short");
  });

  it("a copied replacement never gets a turn twice: the torn one stays as it was copied (T35 #1)", () => {
    const { dir } = runPlugin([
      `import shutil`,
      `m._RETRY_MIN_S = m._RETRY_MAX_S = 0`,
      ...fillingDisk,
      `p.sync_turn("question for turn 1", "answer 1")`,
      `limit(userLine("question for turn 2") + 5)`,
      `p.sync_turn("question for turn 2", "answer 2")`,          // its user line on disk, its reply torn
      `unlimit()`,
      `shutil.copy(p._transcript_path, p._transcript_path + ".copy")`,
      `os.rename(p._transcript_path + ".copy", p._transcript_path)`,   // replaced by a copy, torn line and all
      `p.sync_turn("question for turn 3", "answer 3")`,
    ].join("\n"));
    const lines = parsedLines(dir);
    expect(lines.filter(l => l === null).length).toBe(1);
    expect(lines.filter(l => l?.message?.role === "user").map(u => u.message.content))
      .toEqual(["question for turn 1", "question for turn 2", "question for turn 3"]);
    expect(lines.filter(l => l?.message?.role === "assistant").map(u => u.message.content)).toEqual(["answer 1", "answer 3"]);
  });

  it("a transcript moved between two waiting writes gets the second in the file now at its path (T35 #5)", () => {
    const { dir } = runPlugin([
      `m._RETRY_MIN_S = m._RETRY_MAX_S = 0`,
      `unwritable()`,
      `p.sync_turn("question for turn 1", "answer 1")`,
      `p.sync_turn("question for turn 2", "answer 2")`,          // both wait
      `def moving(fd, data):`,
      `    r = real_write_all(fd, data)`,
      `    if b"question for turn 1" in bytes(data): os.rename(p._transcript_path, p._transcript_path + ".moved")`,
      `    return r`,
      `m._write_all = moving`,
      `p._flush_outbox()`,                                         // turn 1, then the file moves: turn 2 is not sent after it
      `writable()`,
      `p._flush_outbox()`,
    ].join("\n").replace("m._RETRY_MIN_S", "import os\nm._RETRY_MIN_S"));
    expect(userTexts(dir)).toEqual(["question for turn 2"]);
  });

  it("a transcript stays held while a prefetch for it runs, so its late outcome is written there (T34 #4)", () => {
    const { out, dir } = runPlugin([
      `import os`,
      `p.queue_prefetch("a slow question about batching")`,        // context-surfacing takes 4.5 s
      `time.sleep(0.3)`,
      `p.on_session_switch("sess-hermes-plug2", reset=True)`,       // its result will come too late: dropped, in plug1
      `q = m.ClawMemProvider()`,                                    // another process, the old session id
      `q.initialize("sess-hermes-plug1", hermes_home=p._hermes_home, agent_context="primary")`,
      `print("Q", os.path.basename(q._transcript_path))`,
      `p._prefetch_thread.join(10)`,
      `print("P", sorted(os.path.basename(x) for x in p._claims))`,
      `settle(q)`,
    ].join("\n"));
    expect(out).toContain("Q sess-hermes-plug1.2.jsonl");
    expect(out).toContain("P ['sess-hermes-plug2.jsonl']");            // let go once the prefetch finished
    expect(outcomes(dir)).toEqual([[42, "dropped"]]);
  });

  it("a torn tail already on disk (a crash) stays a line of its own: the next write starts a new one", () => {
    const { dir } = runPlugin([
      `p.sync_turn("question for turn 1", "answer 1")`,
      `open(p._transcript_path, "a").write('{"type": "mess')`,     // a write torn by a crash
      `p.sync_turn("question for turn 2", "answer 2")`,
    ].join("\n"));
    const raw = readFileSync(join(dir, "home", "clawmem-transcripts", "sess-hermes-plug1.jsonl"), "utf-8").split("\n").filter(Boolean);
    const parsed = raw.map(l => { try { return JSON.parse(l); } catch { return null; } });
    expect(raw.filter((_, k) => parsed[k] === null)).toEqual(['{"type": "mess']);
    expect(parsed.filter(l => l?.message?.role === "user").map(u => u.message.content)).toEqual(["question for turn 1", "question for turn 2"]);
  });

  it("shutdown makes a last try at the waiting writes, and warns of any it could not make (T31 #2)", () => {
    const { out, dir } = runPlugin([
      `import os, logging`,
      `logging.basicConfig(level=logging.WARNING)`,
      `unwritable()`,
      `p.sync_turn("question for turn 1", "answer 1")`,
      `other = p._transcript_path + ".other"`,
      `os.mkdir(other)`,
      `p._record_outcome(other, 77, "dropped")`,                   // a transcript that stays unwritable
      `writable()`,
      `p.shutdown()`,
    ].join("\n"));
    expect(userTexts(dir)).toEqual(["question for turn 1"]);
    expect(out).toContain("lost at shutdown");
  });

  it("past the outbox cap the oldest waiting write is given up with a warning, never a newer one (T31 #2)", () => {
    const { out, dir } = runPlugin([
      `import os, logging`,
      `logging.basicConfig(level=logging.WARNING)`,
      `m._OUTBOX_MAX = 2`,
      `m._RETRY_MIN_S = m._RETRY_MAX_S = 0`,
      `unwritable()`,
      `for k in range(3): p.sync_turn("question for turn %d" % k, "answer")`,
      `writable()`,
      `p.sync_turn("question for turn 3", "answer")`,
    ].join("\n"));
    expect(userTexts(dir)).toEqual(["question for turn 1", "question for turn 2", "question for turn 3"]);
    expect(out).toContain("given up");
  });

  it("past the byte cap too, the oldest waiting write is given up with a warning (T32 #4)", () => {
    const { out, dir } = runPlugin([
      `import os, logging`,
      `logging.basicConfig(level=logging.WARNING)`,
      `m._RETRY_MIN_S = m._RETRY_MAX_S = 0`,
      `p.sync_turn("question for turn A", "answer")`,
      `one = os.path.getsize(p._transcript_path)`,
      `p.sync_turn("question for turn B", "answer")`,
      `m._OUTBOX_MAX_BYTES = 2 * (os.path.getsize(p._transcript_path) - one)`,   // two turns' worth
      `p.on_session_switch("sess-hermes-plug2", reset=True)`,
      `unwritable()`,
      `for k in range(3): p.sync_turn("question for turn %d" % k, "answer")`,
      `writable()`,
      `p.sync_turn("question for turn 3", "answer")`,
    ].join("\n"));
    // Turn 0 was given up while the transcript stayed unwritable; turn 3's write, tried first, took the rest.
    expect(transcriptLines(dir, "sess-hermes-plug2").filter(l => l.message?.role === "user").map(u => u.message.content))
      .toEqual(["question for turn 1", "question for turn 2", "question for turn 3"]);
    expect(out).toContain("given up");
  });

  it("a single write larger than the byte cap is given up too, once it fails (T33 #4)", () => {
    const { out, dir } = runPlugin([
      `import logging`,
      `logging.basicConfig(level=logging.WARNING)`,
      `m._RETRY_MIN_S = m._RETRY_MAX_S = 0`,
      `m._OUTBOX_MAX_BYTES = 10`,
      `unwritable()`,
      `p.sync_turn("question for turn 1", "answer 1")`,          // fails, and alone is over the cap: given up
      `print("WAITING", len(p._outbox))`,
      `writable()`,
      `p.sync_turn("question for turn 2", "answer 2")`,          // written: a write that lands is never given up
    ].join("\n"));
    expect(out).toContain("WAITING 0");
    expect(out).toContain("given up");
    expect(userTexts(dir)).toEqual(["question for turn 2"]);
  });

  it("a transcript whose write failed is tried again after a pause, and at once at the session end (T32 #4)", () => {
    const { out, dir } = runPlugin([
      `import os`,
      `m._RETRY_MIN_S = m._RETRY_MAX_S = 60`,
      `unwritable()`,
      `p.sync_turn("question for turn 1", "answer 1")`,          // fails: tried again in 60 s
      `writable()`,
      `p.sync_turn("question for turn 2", "answer 2")`,          // waits behind it: nothing is tried before the pause ends
      `print("SIZE", os.path.getsize(p._transcript_path))`,
      `p.on_session_end([])`,                                    // at once
    ].join("\n"));
    expect(out).toContain("SIZE 0");
    expect(userTexts(dir)).toEqual(["question for turn 1", "question for turn 2"]);
  });

  it("writes that still cannot be made at the session end are given up before the end is recorded: none lands later (T32 #1)", () => {
    const { out, calls, dir } = runPlugin([
      `import os, logging`,
      `logging.basicConfig(level=logging.WARNING)`,
      `unwritable()`,
      `p.sync_turn("question for turn 1", "answer 1")`,
      `p.on_session_end([])`,
      `writable()`,
      `p.sync_turn("question for turn 2", "answer 2")`,
    ].join("\n"));
    expect(out).toContain("lost at session end");
    expect(userTexts(dir)).toEqual(["question for turn 2"]);
    expect(calls.some(c => c.hook === "handoff-generator" && c.input.hook_event_name === "SessionEnd")).toBe(true);
  });

  it("a prefetch() call slower than the host's patience is not recorded as a delivery (T29 #4)", () => {
    const { dir } = runPlugin([
      `m._DELIVERY_ACK_S = 0.05`,
      `p.queue_prefetch("question for turn 1 about batching")`,
      `wait_for("context-surfacing", 1)`,
      `p._prefetch_thread.join(5)`,
      `orig = p._prefetch_thread`,
      `import threading`,
      `p._prefetch_thread = threading.Thread(target=lambda: time.sleep(0.2))`,   // a wait the call has to sit through
      `p._prefetch_thread.start()`,
      `print(p.prefetch("question for turn 2 about retries"))`,
      `p.sync_turn("question for turn 2 about retries", "answer 2")`,
      `wait_for("feedback-loop", 1)`,
    ].join("\n"));
    expect(records(dir)).toEqual(["none"]);
    expect(outcomes(dir)).toEqual([[42, "unresolved"]]);
  });

  it("tags the read-side hooks with the host too", () => {
    const { calls } = runPlugin([
      `p.queue_prefetch("question for turn 1 about batching")`,
      `wait_for("context-surfacing", 1)`,
    ].join("\n"));
    expect(calls.find(c => c.hook === "session-bootstrap")!.input).toMatchObject({ host: "hermes" });
    expect(calls.find(c => c.hook === "context-surfacing")!.input).toMatchObject({ host: "hermes", prompt: "question for turn 1 about batching" });
  });

  it("a non-primary agent context still writes nothing and runs no Stop pass", () => {
    const { calls, dir } = runPlugin([
      `s = m.ClawMemProvider()`,                                 // a subagent's provider: reads only, and claims no transcript
      `s.initialize("sess-hermes-sub", hermes_home=p._hermes_home, agent_context="subagent")`,
      `s.sync_turn("question for turn 1", "answer 1")`,
      `s.prefetch("question for turn 2")`,
      `time.sleep(0.3)`,
      `s.on_session_end([])`,
    ].join("\n"));
    expect(calls.filter(c => c.hook !== "session-bootstrap")).toEqual([]);
    expect(() => transcriptLines(dir, "sess-hermes-sub")).toThrow();   // no transcript was written at all
  });
});
