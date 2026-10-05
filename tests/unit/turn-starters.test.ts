/**
 * BACKLOG 72.4: turns started by anything but a typed prompt (DESIGN rev 3.3, §5).
 *
 * Baseline (v0.42.0): the transcript readers start a turn only at a `human` line, and only a typed prompt or a prompt
 * command WITH arguments is `human`. A prompt command without arguments, a background task's notice and another
 * session's message are `meta`, so the reply to each folds into the previous typed prompt's turn in every Stop
 * extractor and in feedback attribution; input the model receives mid-turn (`queued_command` attachments) is read by
 * nothing; and a bounded read that ends right after a built-in command with arguments keeps it as a `human` line when
 * `releaseTrailingCommand` is on (gap (e)). 61 of these 95 tests fail on v0.42.0; 31 guard behaviour the change must
 * keep (meta stays meta, the hard exclusions, what is never a last request, the release=false (e) case, and — CODE T1 —
 * no over-matching of local output; four of them, step-0.1 precedence and present-but-invalid metadata, are cases the
 * first draft of this change broke and v0.42.0 already had right). 3 are `todo`: limits of the oversized-line check
 * that v0.42.0 already had and this change keeps (BACKLOG 72.8).
 *
 * BACKLOG 72.9 (v0.43.1): 17 more tests at the end. 11 fail on v0.43.0; 6 guard behaviour the fix must keep (an opening
 * notice ends the look for a built-in's output, a prompt command's expansion after queued input, a record released by
 * its caller or a prompt command is not held back, and — codex 72.9 T1-1 — a record the backward scan holds back with
 * no earlier opener anchors the current turn at it, and — T2-1 — the backward scan still reads a complete successor
 * larger than a read whole).
 *
 * Fixture text is synthetic; the row shapes are the ones the 72.4 survey counted (DESIGN §1).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import type { Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import * as hooks from "../../src/hooks.ts";
import * as cursor from "../../src/stop-cursor.ts";
import * as extract from "../../src/stop-extract.ts";
import * as handoff from "../../src/stop-handoff.ts";
import { observerContract, observerContractInputs } from "../../src/observer.ts";
import { feedbackLoop } from "../../src/hooks/feedback-loop.ts";
import { applySurfacingBookkeeping, type SurfacingBookkeepingJob } from "../../src/hooks/surfacing-bookkeeping.ts";
import { precompactExtract } from "../../src/hooks/precompact-extract.ts";
import { promptSha, transcriptKey } from "../../src/stop-pairing.ts";
import { iso, human, assistant, command, localStdout, meta, writeTranscriptFile, appendEntries, lineStarts, type Entry } from "./stop-fixtures.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "clawmem-724-"));
  dirs.push(d);
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

// ─── Row shapes (DESIGN §1) ─────────────────────────────────────────────────────────────────────────────────────────
/** A writer that records turn openers (`turnOrigin`, Claude Code ≥ 2.1.278), and one that predates them. */
const V_NEW = "2.1.289";
const V_OLD = "2.1.104";
let uidN = 0;
const uid = () => `u-${++uidN}`;
const stamp = (e: Entry, t: number | null): Entry => (t === null ? e : { ...e, timestamp: iso(t) });

const TASK_XML = (summary: string, status = "completed") =>
  `<task-notification>\n<task-id>bx1</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<output-file>/tmp/OUTPUT-PATH-x.txt</output-file>\n` +
  `<status>${status}</status>\n<summary>${summary}</summary>\n<result>RESULT-BODY-SECRET</result>\n</task-notification>`;

type RowOpts = { turnOrigin?: string | null; version?: string | null; origin?: Record<string, unknown> | null; isMeta?: boolean };
const rowMeta = (o: RowOpts, defaults: { turnOrigin: string; origin: Record<string, unknown> | null }) => ({
  ...(o.version === null ? {} : { version: o.version ?? V_NEW }),
  ...(o.turnOrigin === null ? {} : { turnOrigin: o.turnOrigin ?? defaults.turnOrigin }),
  ...(o.origin === null || (o.origin === undefined && defaults.origin === null) ? {} : { origin: o.origin ?? defaults.origin }),
  ...(o.isMeta ? { isMeta: true } : {}),
});

/** A background task's notice row; `turnOrigin` present = the writer recorded it as a turn opener. */
const taskRow = (summary: string, t: number | null, o: RowOpts = {}): Entry => stamp({
  type: "user", uuid: uid(), ...rowMeta(o, { turnOrigin: "task_notification", origin: { kind: "task-notification" } }),
  message: { role: "user", content: TASK_XML(summary) },
}, t);

const PEER_PREAMBLE = "Another Claude session sent a message:\n";
const PEER_EL = (body: string) => `<cross-session-message from="/tmp/PEER-SOCKET.sock" name="lane-b">${body}</cross-session-message>`;
/** Another session's message: Claude Code's preamble, then the element. */
const peerRow = (body: string, t: number | null, o: RowOpts & { name?: string | null } = {}): Entry => stamp({
  type: "user", uuid: uid(), isMeta: true,
  ...rowMeta(o, {
    turnOrigin: "peer",
    origin: { kind: "peer", from: "/tmp/PEER-SOCKET.sock", ...(o.name === null ? {} : { name: o.name ?? "lane-b" }), body, msg_id: "m1" },
  }),
  message: { role: "user", content: `${PEER_PREAMBLE}${PEER_EL(body)}` },
}, t);
/** A background agent's hand-back: a peer row without the element. */
const handbackRow = (body: string, t: number | null): Entry => stamp({
  type: "user", uuid: uid(), isMeta: true, version: V_NEW, turnOrigin: "peer",
  origin: { kind: "peer", from: "/tmp/AGENT-SOCKET.sock", body, handback: true, senderTaskId: "t1" },
  message: { role: "user", content: `A background agent reported back:\n${body}` },
}, t);
const pluginRow = (text: string, t: number | null, turnOrigin?: string): Entry => stamp({
  type: "user", uuid: uid(), isMeta: true, version: V_NEW, ...(turnOrigin ? { turnOrigin } : {}),
  origin: { kind: "plugin", name: "ysk-always" }, message: { role: "user", content: text },
}, t);
/** Input received while the model worked: a `queued_command` attachment (string or content-block prompt). */
const queued = (prompt: string | unknown[], t: number | null, o: { commandMode?: string; origin?: Record<string, unknown> } = {}): Entry => stamp({
  type: "attachment", uuid: uid(), version: V_NEW,
  attachment: { type: "queued_command", prompt, commandMode: o.commandMode ?? "prompt", ...(o.origin ? { origin: o.origin } : {}) },
}, t);
/** A built-in command's output as newer writers record it: a `system` row, no message. */
const localCommandRow = (text: string, t: number | null): Entry => stamp({
  type: "system", subtype: "local_command", uuid: uid(), version: V_NEW, level: "info",
  content: `<local-command-stdout>${text}</local-command-stdout>`,
}, t);
/** A typed prompt / prompt command as a writer that records openers writes it. */
const typed = (text: string, t: number | null): Entry => ({ ...human(text, t), version: V_NEW, turnOrigin: "human", origin: { kind: "human" } });
const promptCommand = (name: string, args: string, t: number | null): Entry =>
  ({ ...command(name, args, t), version: V_NEW, turnOrigin: "human", origin: { kind: "human" } });

const write = (entries: Entry[]) => writeTranscriptFile(tmp(), "s.jsonl", entries);
/** Every line of a transcript, classified (the Stop readers' path). */
const linesOf = (entries: Entry[]) => cursor.readLines(write(entries), 0, { releaseTrailingCommand: true }).lines;
/** The PreCompact reader's path. */
const turnsOf = (entries: Entry[]) => hooks.readTranscriptTurns(write(entries), 200);
const notice = (l: any) => l.notice as { source: string; opens: boolean; typedText?: string; identitySha?: string } | undefined;
/** Half of a surrogate pair, alone. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const EMOJI = "\u{1F600}";
/** A task notice row holding `xml` as its element (CODE T1-1 shapes; P17 found every surveyed element clean). */
const taskRowXml = (xml: string, t: number | null): Entry => stamp({
  type: "user", uuid: uid(), version: V_NEW, turnOrigin: "task_notification", origin: { kind: "task-notification" },
  message: { role: "user", content: xml },
}, t);
const TN = (...children: string[]) => `<task-notification>\n${children.join("\n")}\n</task-notification>`;

// ─── Classification (§3.2) ──────────────────────────────────────────────────────────────────────────────────────────
describe("72.4 §3.2 classification: prompt commands, built-ins and their output rows", () => {
  it("a prompt command without arguments is a human line \"/name\" (bareCommand), in both readers", () => {
    const entries = [typed("please look at the indexer", 0), assistant("Looking.", 1), command("/pre-compact", "", 2),
      meta("expansion of the prompt command", 3), assistant("Prepared the compaction notes.", 4)];
    for (const ls of [linesOf(entries), turnsOf(entries)] as any[][]) {
      expect(ls[2]).toMatchObject({ kind: "human", text: "/pre-compact", bareCommand: true });
    }
  });

  it("a built-in command followed by <local-command-stdout> is meta, with and without arguments", () => {
    for (const args of ["", "sonnet"]) {
      const entries = [typed("first question here", 0), assistant("answer", 1), command("/model", args, 2), localStdout("Set model", 3)];
      expect(linesOf(entries)[2]!.kind).toBe("meta");
      expect(turnsOf(entries)[2]!.kind).toBe("meta");
    }
  });

  it("a built-in command followed by a system/local_command row is meta, with and without arguments (newer writers)", () => {
    for (const args of ["", "sonnet"]) {
      const entries = [typed("first question here", 0), assistant("answer", 1), command("/model", args, 2), localCommandRow("Set model", 3)];
      expect(linesOf(entries)[2]!.kind).toBe("meta");
      const turns = turnsOf(entries);
      expect(turns.find(t => t.text.startsWith("/model"))).toBeUndefined();
      expect(turns.filter(t => t.kind === "human").map(t => t.text)).toEqual(["first question here"]);
    }
  });

  it("/compact stays meta, with and without instructions", () => {
    for (const args of ["", "keep the plan"]) {
      const entries = [typed("first question here", 0), assistant("answer", 1), command("/compact", args, 2), assistant("ok", 3)];
      expect(linesOf(entries)[2]!.kind).toBe("meta");
      expect(turnsOf(entries)[2]!.kind).toBe("meta");
    }
  });

  it("local output after a command record demotes it even when it carries turnOrigin=human (an unobserved shape)", () => {
    const entries = [typed("first question here", 0), assistant("answer", 1), promptCommand("/model", "sonnet", 2), localStdout("Set model", 3)];
    expect(linesOf(entries)[2]!.kind).toBe("meta");
    expect(turnsOf(entries)[2]!.kind).toBe("meta");
  });

  it("a command record carrying turnOrigin=human is a prompt command: never held back at EOF", () => {
    for (const args of ["", "the release plan"]) {
      const path = write([typed("first question here", 0), assistant("answer", 1), promptCommand("/review", args, 2)]);
      const read = cursor.readLines(path, 0);   // releaseTrailingCommand off
      expect(read.lines.length).toBe(3);
      expect(read.lines[2]).toMatchObject({ kind: "human", text: args ? `/review ${args}` : "/review" });
      expect(read.next).toBe(readFileSync(path).length);
    }
  });
});

describe("72.4 §3.2 classification: notices", () => {
  it("a task row carrying turnOrigin is an opening task notice", () => {
    const l = linesOf([typed("start the export", 0), assistant("Started.", 1), taskRow("export finished", 2), assistant("Done.", 3)])[2]!;
    expect(l.kind).toBe("notice");
    expect(notice(l)).toMatchObject({ source: "task", opens: true });
  });

  it("a task row WITHOUT turnOrigin on a writer that records openers does not open a turn", () => {
    const l = linesOf([typed("start the export", 0), assistant("Started.", 1), taskRow("export finished", 2, { turnOrigin: null })])[2]!;
    expect(l.kind).toBe("notice");
    expect(notice(l)).toMatchObject({ source: "task", opens: false });
  });

  it("the same row from an older or unversioned writer opens by shape", () => {
    for (const version of [V_OLD, null]) {
      const l = linesOf([taskRow("export finished", 2, { turnOrigin: null, version, origin: null })])[0]!;
      expect(l.kind).toBe("notice");
      expect(notice(l)).toMatchObject({ source: "task", opens: true });
    }
  });

  it("a peer row opens a turn: by turnOrigin, and by origin or preamble shape on older writers", () => {
    const viaTurnOrigin = linesOf([peerRow("BODY-SECRET hello", 2)])[0]!;
    const viaOrigin = linesOf([peerRow("BODY-SECRET hello", 2, { turnOrigin: null, version: V_OLD })])[0]!;
    const viaPreamble = linesOf([peerRow("BODY-SECRET hello", 2, { turnOrigin: null, version: V_OLD, origin: null })])[0]!;
    for (const l of [viaTurnOrigin, viaOrigin, viaPreamble]) {
      expect(l.kind).toBe("notice");
      expect(notice(l)).toMatchObject({ source: "peer", opens: true });
    }
  });

  it("a typed prompt that merely quotes a <cross-session-message> stays human (not meta: no preamble form)", () => {
    const l = linesOf([human(`look at this: ${PEER_EL("quoted")}`, 0)])[0]!;
    expect(l.kind).toBe("human");
  });

  it("an unknown turnOrigin value opens an `other` notice", () => {
    const l = linesOf([stamp({ type: "user", uuid: uid(), version: V_NEW, turnOrigin: "scheduled_wakeup", isMeta: true,
      message: { role: "user", content: "wake up and check the queue" } }, 2)])[0]!;
    expect(l.kind).toBe("notice");
    expect(notice(l)).toMatchObject({ source: "other", opens: true });
    expect(l.text).toBe("[turn started by scheduled_wakeup]");
  });

  it("a plugin row (ysk notes) stays meta, whatever turnOrigin says", () => {
    for (const to of [undefined, "peer", "task_notification", "human"]) {
      expect(linesOf([pluginRow("<ysk-note>NOTE-SECRET</ysk-note>", 2, to)])[0]!.kind).toBe("meta");
    }
  });
});

describe("72.4 §3.2 step 0: one executable precedence order (codex T2 F1, T3 F1)", () => {
  const userRow = (extra: Record<string, unknown>, content = "some meta text") =>
    stamp({ type: "user", uuid: uid(), version: V_NEW, ...extra, message: { role: "user", content } }, 2);
  const cases: [string, Entry, { kind: hooks.TranscriptTurnKind; source?: string; opens?: boolean }][] = [
    ["isMeta + task_notification", userRow({ isMeta: true, turnOrigin: "task_notification" }), { kind: "notice", source: "task", opens: true }],
    ["isMeta + peer without peer shape", userRow({ isMeta: true, turnOrigin: "peer" }), { kind: "notice", source: "peer", opens: true }],
    ["isMeta + an unknown token", userRow({ isMeta: true, turnOrigin: "cron_fire" }), { kind: "notice", source: "other", opens: true }],
    ["plugin + turnOrigin", userRow({ isMeta: true, turnOrigin: "peer", origin: { kind: "plugin", name: "x" } }), { kind: "meta" }],
    ["compact summary + turnOrigin", userRow({ isCompactSummary: true, isVisibleInTranscriptOnly: true, turnOrigin: "peer" }), { kind: "meta" }],
    ["isMeta + human", userRow({ isMeta: true, turnOrigin: "human" }), { kind: "meta" }],
    ["system role + peer", stamp({ type: "user", uuid: uid(), turnOrigin: "peer", message: { role: "system", content: "x" } }, 2), { kind: "meta" }],
    ["unknown role + task_notification", stamp({ type: "user", uuid: uid(), turnOrigin: "task_notification", message: { role: "robot", content: "x" } }, 2), { kind: "meta" }],
    ["no message + peer", stamp({ type: "progress", uuid: uid(), turnOrigin: "peer" }, 2), { kind: "meta" }],
  ];
  for (const [name, row, want] of cases) {
    it(name, () => {
      const l = linesOf([row])[0]!;
      expect(l.kind).toBe(want.kind);
      if (want.source) expect(notice(l)).toMatchObject({ source: want.source, opens: want.opens });
    });
  }
});

// ─── Queued attachments (§3.2 step 5) ───────────────────────────────────────────────────────────────────────────────
describe("72.4 §3.2.5 queued attachments: classified, never human, never opening", () => {
  const first = (e: Entry) => linesOf([typed("the first question", 0), assistant("working", 1), e])[2]!;

  it("a typed queued prompt (origin human, string) keeps the user's words as typedText", () => {
    const l = first(queued("also add jitter to the retry delays", 2, { origin: { kind: "human" } }));
    expect(l.kind).toBe("notice");
    expect(notice(l)).toMatchObject({ source: "queued-prompt", opens: false, typedText: "also add jitter to the retry delays" });
    expect(l.text).toBe("[typed while the assistant was working] also add jitter to the retry delays");
  });

  it("a content-block prompt keeps its text blocks only; an image-only prompt has empty typedText", () => {
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    const both = first(queued([{ type: "text", text: "see this screenshot" }, img], 2, { origin: { kind: "human" } }));
    expect(notice(both)).toMatchObject({ source: "queued-prompt", typedText: "see this screenshot" });
    const imageOnly = first(queued([img], 2, { origin: { kind: "human" } }));
    expect(notice(imageOnly)).toMatchObject({ source: "queued-prompt", typedText: "" });
    expect(imageOnly.text).not.toContain("iVBOR");
  });

  it("typedText is bounded", () => {
    const l = first(queued("x".repeat(5_000), 2, { origin: { kind: "human" } }));
    expect(notice(l)!.typedText!.length).toBeLessThanOrEqual(2_000);
  });

  it("a queued peer message and a queued task notice are non-opening notices with labels", () => {
    const peer = first(queued(`${PEER_PREAMBLE}${PEER_EL("BODY-SECRET")}`, 2, { origin: { kind: "peer", name: "lane-b", body: "BODY-SECRET", from: "/tmp/PEER-SOCKET.sock" } }));
    expect(notice(peer)).toMatchObject({ source: "peer", opens: false });
    expect(peer.text).toBe("[message from lane-b]");
    const task = first(queued(TASK_XML("tests passed"), 2, { commandMode: "task-notification", origin: { kind: "task-notification" } }));
    expect(notice(task)).toMatchObject({ source: "task", opens: false });
    const taskNoOrigin = first(queued(TASK_XML("tests passed"), 2, { commandMode: "task-notification" }));
    expect(notice(taskNoOrigin)).toMatchObject({ source: "task", opens: false });
  });

  it("a queued prompt without origin is queued-unknown: a neutral label, no text", () => {
    const l = first(queued("UNKNOWN-SOURCE-TEXT please", 2));
    expect(notice(l)).toMatchObject({ source: "queued-unknown", opens: false });
    expect(notice(l)!.typedText).toBeUndefined();
    expect(l.text).toBe("[input received while the assistant was working]");
    expect(l.rendered).not.toContain("UNKNOWN-SOURCE-TEXT");
  });

  it("the PreCompact reader sees queued attachments too", () => {
    const turns = turnsOf([typed("the first question", 0), assistant("working", 1), queued("also add jitter", 2, { origin: { kind: "human" } })]) as any[];
    expect(turns[2]).toMatchObject({ kind: "notice", role: "user" });
    expect(turns[2].notice).toMatchObject({ source: "queued-prompt", typedText: "also add jitter" });
  });
});

// ─── Renderings (§3.3, operator D1 (a)) ─────────────────────────────────────────────────────────────────────────────
describe("72.4 §3.3 renderings: a label says who spoke, never a peer's body", () => {
  it("a peer notice holds no body and no socket path; a hand-back reads as a background agent", () => {
    const [peer, anon, back] = linesOf([peerRow("BODY-SECRET", 1), peerRow("BODY-SECRET", 2, { name: null }), handbackRow("BODY-SECRET", 3)]);
    expect(peer!.text).toBe("[message from lane-b]");
    expect(anon!.text).toBe("[message from another session]");
    expect(back!.text).toBe("[message from a background agent]");
    for (const l of [peer!, anon!, back!]) {
      expect(l.rendered).toBe(l.text);
      expect(l.rendered).not.toContain("BODY-SECRET");
      expect(l.rendered).not.toContain("SOCKET");
    }
  });

  it("a task notice holds its status and summary only, at most 300 characters", () => {
    const [l] = linesOf([taskRow("nightly export finished", 1)]);
    expect(l!.text).toBe("[background task completed] nightly export finished");
    expect(l!.rendered).toBe(l!.text);
    const [long] = linesOf([taskRow("s".repeat(1_000), 1)]);
    expect(long!.text.length).toBeLessThanOrEqual(300);
    for (const x of [l!, long!]) {
      expect(x.rendered).not.toContain("RESULT-BODY-SECRET");
      expect(x.rendered).not.toContain("OUTPUT-PATH");
    }
  });

  it("a notice line carries no tool calls and no delivery", () => {
    const [l] = linesOf([{ ...taskRow("done", 1), clawmem_delivery: { usage_id: 7, at: iso(1) } }]);
    expect((l as any).toolUses).toBeUndefined();
    expect((l as any).delivery).toBeUndefined();
  });
});

// ─── Segmentation and anchors (§3.4) ────────────────────────────────────────────────────────────────────────────────
describe("72.4 §3.4 segmentation and the first-sight anchor", () => {
  it("a reply after an opening notice is its own segment; a queued notice does not split", () => {
    const ls = linesOf([typed("Q1 here please", 0), assistant("A1", 1), taskRow("done", 2), assistant("A2", 3),
      queued("more", 4, { origin: { kind: "human" } }), assistant("A3", 5)]);
    const segs = cursor.segmentTurns(ls, { trailingComplete: true }) as any[];
    expect(segs.length).toBe(2);
    expect(segs[0]).toMatchObject({ humanIndex: 0, openIndex: 0 });
    expect(segs[1]).toMatchObject({ humanIndex: null, openIndex: 2 });
    expect(segs[1].lines.length).toBe(4);
  });

  it("currentTurnStart: the last answered opening notice; a trailing unanswered opener never moves it", () => {
    const answered = write([typed("Q1 here please", 0), assistant("A1", 1), taskRow("done", 2), assistant("A2", 3), taskRow("again", 4)]);
    expect(cursor.currentTurnStart(answered)).toBe(lineStarts(answered)[2]!);
    const unanswered = write([typed("Q1 here please", 0), assistant("A1", 1), taskRow("done", 2)]);
    expect(cursor.currentTurnStart(unanswered)).toBe(0);
  });

  it("toObserverMessages: a notice is a user-role label; an opening one starts the next turn", () => {
    const ls = linesOf([typed("Q1 here please", 0), assistant("A1", 1), taskRow("done", 2), assistant("A2", 3),
      queued("more", 4, { origin: { kind: "human" } })]);
    expect(extract.toObserverMessages(ls)).toEqual([
      { role: "user", content: "Q1 here please", turn: 0, opening: true },
      { role: "assistant", content: "A1", turn: 0 },
      { role: "user", content: "[background task completed] done", turn: 1, opening: true },
      { role: "assistant", content: "A2", turn: 1 },
      { role: "user", content: "[typed while the assistant was working] more", turn: 1, opening: false },
    ]);
  });
});

// ─── Observer accumulation (F3) ─────────────────────────────────────────────────────────────────────────────────────
describe("72.4 F3 observer accumulation", () => {
  it("a long notice-opened turn keeps its label after the 100-message window drops it", () => {
    const entries: Entry[] = [taskRow("nightly export finished", 0)];
    for (let i = 1; i <= 150; i++) entries.push(assistant(`step ${i} of the follow-up work`, i));
    const path = write(entries);
    const big = (extract as any).accumulateLines(path, 0, { stopAtNextOpening: true });
    const msgs = extract.accumulatedMessages(big.acc);
    expect(msgs[0]).toEqual({ role: "user", content: "[background task completed] nightly export finished", turn: 0, opening: true });
    expect(msgs.length).toBe(100);
  });

  it("a replayed range holding several newly recognised turns numbers them in order", () => {
    const path = write([typed("Q1 here please", 0), assistant("A1", 1), taskRow("done", 2), assistant("A2", 3),
      peerRow("BODY", 4), assistant("A3", 5)]);
    const r = (extract as any).accumulateLines(path, 0, { stopAtNextOpening: false, releaseTrailingCommand: true });
    expect(r.acc.messages.map((m: any) => [m.turn, m.content])).toEqual([
      [0, "Q1 here please"], [0, "A1"], [1, "[background task completed] done"], [1, "A2"], [2, "[message from lane-b]"], [2, "A3"],
    ]);
  });

  it("a streamed stretch stops at the next opening notice", () => {
    const path = write([typed("Q1 here please", 0), assistant("A1", 1), taskRow("done", 2), assistant("A2", 3)]);
    const r = (extract as any).accumulateLines(path, 0, { stopAtNextOpening: true });
    expect(r.reachedOpening).toBe(true);
    expect(r.acc.lines).toBe(2);
  });
});

// ─── Handoff digests (F4) ───────────────────────────────────────────────────────────────────────────────────────────
describe("72.4 F4 handoff digests", () => {
  const SID = "sess0724-handoff";
  const digests = (store: Store, path: string) =>
    (store.db.prepare(`SELECT seq, fp, range_from, payload FROM stop_items WHERE session_id = ? AND transcript_key = ? AND kind = 'turn-digest' ORDER BY seq`)
      .all(SID, transcriptKey(path)) as { seq: number; fp: string; range_from: number; payload: string }[])
      .map(r => ({ seq: r.seq, from: r.range_from, ...JSON.parse(r.payload) }));
  const firstStop = (store: Store, path: string) => {
    // A first Stop anchors at the current turn: start the cursor at the file's first line instead.
    store.db.prepare(`INSERT INTO stop_cursors (session_id, hook, transcript_key, transcript_path, file_dev, file_ino, first_line_sha,
      anchor_epoch, next_digest_seq, byte_offset, tail_sha, turn_start_offset, human_turns) VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, 1, 0, ?, NULL, 0)`)
      .run(SID, handoff.HANDOFF_HOOK, transcriptKey(path), path, cursorFirstLineSha(path), cursor.EMPTY_LINE_SHA);
  };

  it("a notice turn gets its own digest whose request is the label", () => {
    const store = createTestStore();
    const path = write([typed("please start the nightly export", 0), assistant("Started the export job.", 1),
      taskRow("nightly export finished", 2), assistant("The export finished; I checked the row counts and they match.", 3)]);
    firstStop(store, path);
    handoff.runHandoffDigests(store, { sessionId: SID, transcriptPath: path, atStop: true });
    expect(digests(store, path).map(d => d.request)).toEqual(["please start the nightly export", "[background task completed] nightly export finished"]);
  });

  it("the worker gives a trailing notice turn a provisional digest whose request is the label", () => {
    const store = createTestStore();
    const path = write([typed("please start the nightly export", 0), assistant("Started the export job.", 1),
      taskRow("nightly export finished", 2), assistant("Checking the row counts now.", 3)]);
    firstStop(store, path);
    const run = handoff.runHandoffDigests(store, { sessionId: SID, transcriptPath: path, atStop: false });
    expect(run.provisional).toBe(1);
    expect(digests(store, path).at(-1)!.request).toBe("[background task completed] nightly export finished");
  });

  it("a notice turn without substantive assistant activity gets no digest", () => {
    const store = createTestStore();
    const path = write([typed("please start the nightly export", 0), assistant("Started the export job.", 1), taskRow("nightly export finished", 2)]);
    firstStop(store, path);
    handoff.runHandoffDigests(store, { sessionId: SID, transcriptPath: path, atStop: true });
    expect(digests(store, path).map(d => d.request)).toEqual(["please start the nightly export"]);
  });

  it("the streamed path (a turn larger than one read) agrees with the normal path, short replies included", () => {
    const entries = [taskRow("nightly export finished", 2), assistant("ok", 3)];
    const normal = createTestStore();
    const p1 = write(entries);
    firstStop(normal, p1);
    handoff.runHandoffDigests(normal, { sessionId: SID, transcriptPath: p1, atStop: true });
    const streamed = createTestStore();
    const p2 = write(entries);
    firstStop(streamed, p2);
    handoff.runHandoffDigests(streamed, { sessionId: SID, transcriptPath: p2, atStop: true, readMaxBytes: lineStarts(p2)[1]! });
    const strip = (d: any) => ({ request: d.request, outcome: d.outcome, files: d.files });
    expect(digests(normal, p1).map(strip)).toEqual([{ request: "[background task completed] nightly export finished", outcome: "ok", files: [] }]);
    expect(digests(streamed, p2).map(strip)).toEqual(digests(normal, p1).map(strip));
  });

  it("(codex T1) a short stretch without an opener gets a digest on both paths", () => {
    const entries = [assistant("Still checking the export.", 2), assistant("ok", 3)];
    const normal = createTestStore();
    const p1 = write(entries);
    firstStop(normal, p1);
    handoff.runHandoffDigests(normal, { sessionId: SID, transcriptPath: p1, atStop: true });
    const streamed = createTestStore();
    const p2 = write(entries);
    firstStop(streamed, p2);
    handoff.runHandoffDigests(streamed, { sessionId: SID, transcriptPath: p2, atStop: true, readMaxBytes: lineStarts(p2)[1]! });
    const strip = (d: any) => ({ request: d.request, outcome: d.outcome, files: d.files });
    expect(digests(normal, p1).map(strip)).toEqual([{ request: "", outcome: "ok", files: [] }]);
    expect(digests(streamed, p2).map(strip)).toEqual(digests(normal, p1).map(strip));
  });
});

function cursorFirstLineSha(path: string): string {
  const buf = readFileSync(path);
  const nl = buf.indexOf(0x0a);
  return createHash("sha256").update(buf.subarray(0, nl < 0 ? buf.length : nl)).digest("hex");
}

// ─── Feedback and pairing (F6, F7) ──────────────────────────────────────────────────────────────────────────────────
describe("72.4 F6/F7 feedback attribution closes at openings and pairs notices by identity", () => {
  function seedDoc(store: Store, path: string, title: string): number {
    const hash = `h-${path}-${Math.random().toString(36).slice(2, 8)}`;
    store.insertContent(hash, `# ${title}\n\nbody`, iso(0));
    store.insertDocument("notes", path, title, hash, iso(0), iso(0));
    return store.findActiveDocument("notes", path)!.id;
  }
  function usageRow(store: Store, sessionId: string, t: number, prompt: string, path: string): number {
    return store.insertUsage({
      sessionId, timestamp: iso(t), hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0,
      turnIndex: 0, queryText: null as any, promptSha: promptSha(prompt), transcriptKey: transcriptKey(path), host: "claude-code", sessionKey: null,
    });
  }
  function surface(store: Store, usageId: number, sessionId: string): void {
    applySurfacingBookkeeping(store, {
      v: 1, kind: "surfacing-bookkeeping", jobId: `job-${usageId}`, sessionId, turnIndex: 0, usageId, queryHash: "qh",
      injectedPaths: ["notes/a/alpha.md"], estimatedTokens: 10, vaults: [{ vault: null, docs: [{ displayPath: "notes/a/alpha.md", searchScore: 0.9 }] }],
      manifest: [{ vault: null, displayPath: "notes/a/alpha.md", displayedTitle: "Alpha design notes" }],
    } as SurfacingBookkeepingJob);
  }
  const state = (store: Store, u: number) =>
    store.db.prepare(`SELECT state, reason FROM feedback_turns WHERE usage_id = ?`).get(u) as { state: string; reason: string | null };
  const access = (store: Store, id: number) => (store.db.prepare(`SELECT access_count FROM documents WHERE id = ?`).get(id) as { access_count: number }).access_count;

  it("a repeated prompt hash across a notice boundary does not pair with the earlier human turn", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "a/alpha.md", "Alpha design notes");
    const path = write([typed("the same prompt text here", 100), assistant("Nothing to cite.", 110),
      taskRow("export finished", 200), assistant("Per a/alpha.md the export is fine.", 210)]);
    const u = usageRow(store, "s", 201, "the same prompt text here", path);
    surface(store, u, "s");
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path });
    expect(state(store, u)).toEqual({ state: "unattributable", reason: "no-unique-pair" });
    expect(access(store, a)).toBe(0);
  });

  it("an opening notice pairs when its identity matches: the reply's reference is credited to it", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "a/alpha.md", "Alpha design notes");
    const path = write([typed("start the export please", 100), assistant("Started.", 110),
      taskRow("export finished", 200), assistant("Per a/alpha.md the export is fine.", 210)]);
    const u = usageRow(store, "s", 201, TASK_XML("export finished"), path);
    surface(store, u, "s");
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path });
    expect(state(store, u).state).toBe("attributed");
    expect(access(store, a)).toBe(1);
  });

  it("a peer row (preamble + element) pairs with a usage row hashed over the element only", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "a/alpha.md", "Alpha design notes");
    const path = write([typed("start the export please", 100), assistant("Started.", 110),
      peerRow("please check alpha", 200), assistant("Per a/alpha.md all is fine.", 210)]);
    const u = usageRow(store, "s", 201, PEER_EL("please check alpha"), path);
    surface(store, u, "s");
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path });
    expect(state(store, u).state).toBe("attributed");
    expect(access(store, a)).toBe(1);
  });

  it("a hand-back's usage row (no identity match) concludes no-unique-pair", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "a/alpha.md", "Alpha design notes");
    const path = write([typed("start the export please", 100), assistant("Started.", 110),
      handbackRow("agent result", 200), assistant("Per a/alpha.md all is fine.", 210)]);
    const u = usageRow(store, "s", 201, "a form the transcript never shows", path);
    surface(store, u, "s");
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path });
    expect(state(store, u)).toEqual({ state: "unattributable", reason: "no-unique-pair" });
    expect(access(store, a)).toBe(0);
  });
});

// ─── PreCompact (F2, F5) ────────────────────────────────────────────────────────────────────────────────────────────
describe("72.4 F2/F5 precompact: the last request is typed text; notices bound decision context", () => {
  let root: string;
  let store: Store;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clawmem-724-pc-"));
    dirs.push(root);
    for (const k of ["HOME", "CLAWMEM_CONFIG_DIR"]) saved[k] = process.env[k];
    process.env.HOME = join(root, "home");
    process.env.CLAWMEM_CONFIG_DIR = join(root, "config");
    store = createTestStore();
  });
  afterEach(() => {
    for (const k of ["HOME", "CLAWMEM_CONFIG_DIR"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { store.close(); } catch { /* ignore */ }
  });
  async function extracted(sessionId: string, entries: Entry[]) {
    const path = writeTranscriptFile(join(root, "home", ".claude", "projects", "-work"), `${sessionId}.jsonl`, entries);
    await precompactExtract(store, { sessionId, transcriptPath: path, hookEventName: "PreCompact" } as any);
    const row = store.db.prepare(`SELECT payload FROM compaction_state WHERE session_id = ?`).get(sessionId) as { payload: string | null } | null;
    return row?.payload ? JSON.parse(row.payload) as { lastRequest: string; decisions: { text: string; context: string }[] } : null;
  }

  it("a later queued typed prompt is the last request, picked by its typed length", async () => {
    const s = await extracted("sess-pc1", [typed("first real request about the uploader", 0), assistant("Working on the uploader.", 1),
      queued("also please add jitter to the retry delays", 2, { origin: { kind: "human" } }), assistant("Added jitter.", 3)]);
    expect(s!.lastRequest).toBe("also please add jitter to the retry delays");
  });

  it("a short queued prompt with a long label is not picked", async () => {
    const s = await extracted("sess-pc2", [typed("first real request about the uploader", 0), assistant("Working on the uploader.", 1),
      queued("ok go", 2, { origin: { kind: "human" } }), assistant("Going.", 3)]);
    expect(s!.lastRequest).toBe("first real request about the uploader");
  });

  it("a task, peer, other or queued-unknown notice is never the last request", async () => {
    const s = await extracted("sess-pc3", [typed("first real request about the uploader", 0), assistant("Working.", 1),
      taskRow("a long background summary that is well over ten characters", 2), assistant("Noted.", 3),
      peerRow("a long peer body well over ten characters", 4), assistant("Noted.", 5),
      queued("an unknown-source prompt well over ten characters", 6), assistant("Noted.", 7)]);
    expect(s!.lastRequest).toBe("first real request about the uploader");
  });

  it("a bare slash command typed while the assistant worked is never the last request", async () => {
    const s = await extracted("sess-pc6", [typed("please refactor the indexer for speed", 0), assistant("Refactoring.", 1),
      queued("/pre-compact", 2, { origin: { kind: "human" } }), assistant("Noted.", 3)]);
    expect(s!.lastRequest).toBe("please refactor the indexer for speed");
  });

  it("after /pre-compact the last request stays the earlier typed prompt (regression guard for bare commands)", async () => {
    const s = await extracted("sess-pc4", [typed("please refactor the indexer for speed", 0), assistant("Refactoring.", 1),
      command("/pre-compact", "", 2), meta("expansion of the prompt command", 3), assistant("Notes persisted.", 4)]);
    expect(s!.lastRequest).toBe("please refactor the indexer for speed");
  });

  it("a decision's stored context after a notice is the notice label, not the earlier prompt", async () => {
    const s = await extracted("sess-pc5", [typed("earlier prompt about the database schema", 0), assistant("Looked at the schema.", 1),
      taskRow("nightly export finished", 2),
      assistant("We decided to keep the nightly export at 02:00 UTC because traffic is lowest then.", 3)]);
    const d = s!.decisions.find(x => x.text.includes("02:00 UTC"));
    expect(d!.context).toBe("[background task completed] nightly export finished");
  });

  it("(T1-7) exactly ten typed characters qualify, typed or queued; nine do not", async () => {
    const first = [typed("first real request about the uploader", 0), assistant("Working.", 1)];
    const typedTen = await extracted("sess-pc7", [...first, typed("add jitter", 2), assistant("Added.", 3)]);
    expect(typedTen!.lastRequest).toBe("add jitter");
    const queuedTen = await extracted("sess-pc8", [...first, queued("add jitter", 2, { origin: { kind: "human" } }), assistant("Added.", 3)]);
    expect(queuedTen!.lastRequest).toBe("add jitter");
    const nine = await extracted("sess-pc9", [...first, typed("add retry", 2), assistant("Added.", 3)]);
    expect(nine!.lastRequest).toBe("first real request about the uploader");
  });

  it("(T1-4) the 500-character last request never ends on half of a surrogate pair, typed or queued", async () => {
    const long = "a".repeat(499) + EMOJI + " and the rest of it";
    const t = await extracted("sess-pc10", [typed(long, 0), assistant("Working.", 1)]);
    expect(t!.lastRequest.startsWith("a".repeat(499))).toBe(true);
    expect(LONE_SURROGATE.test(t!.lastRequest)).toBe(false);
    const q = await extracted("sess-pc11", [typed("first real request about the uploader", 0), assistant("Working.", 1),
      queued(long, 2, { origin: { kind: "human" } }), assistant("ok", 3)]);
    expect(q!.lastRequest.startsWith("a".repeat(499))).toBe(true);
    expect(LONE_SURROGATE.test(q!.lastRequest)).toBe(false);
  });

  it("(codex T1) a notice's text never becomes an open question; a typed question does", async () => {
    const s = await extracted("sess-pc12", [typed("should we add jitter to the retry delays?", 0), assistant("Looking.", 1),
      taskRow("should we rotate the signing keys now?", 2), assistant("Noted the export.", 3),
      peerRow("should we page the on-call team today?", 4), assistant("Noted.", 5),
      queued("should we drop the staging tables tonight?", 6), assistant("Noted.", 7)]);
    const qs = (s as any).openQuestions as string[];
    expect(qs.some(q => q.includes("jitter"))).toBe(true);
    for (const leaked of ["signing keys", "on-call", "staging tables"]) expect(qs.some(q => q.includes(leaked))).toBe(false);
  });
});

// ─── (e) bounded reads (§3.5) ───────────────────────────────────────────────────────────────────────────────────────
describe("72.4 (e): a bounded read that ends right after a built-in command peeks at its successor", () => {
  for (const release of [false, true]) {
    it(`releaseTrailingCommand ${release}: /model sonnet + local output → meta`, () => {
      const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2),
        localStdout("Set model to sonnet", 3), typed("second question here", 4)]);
      const r = cursor.readLines(path, 0, { maxBytes: lineStarts(path)[3]!, releaseTrailingCommand: release });
      expect(r.bounded).toBe(true);
      expect(r.lines.length).toBe(3);
      expect(r.lines[2]!.kind).toBe("meta");
    });
  }
});

// ─── Migration (§4) ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("72.4 §4 migration", () => {
  it("the observer checkpoint contract carries the classifier revision, so a v0.42 checkpoint restarts its range", () => {
    const rev = (hooks as any).TRANSCRIPT_CLASSIFIER_REVISION;
    expect(rev).toBeGreaterThanOrEqual(2);
    const inputs = observerContractInputs() as Record<string, unknown>;
    expect(inputs.classifier).toBe(rev);
    const { classifier: _c, ...v042 } = inputs;
    expect(observerContract()).not.toBe(createHash("sha256").update(JSON.stringify(v042)).digest("hex"));
  });

  it("a provisional digest with an older derivRev is re-derived; a settled digest is not", () => {
    const SID = "sess0724-mig";
    const store = createTestStore();
    const path = write([typed("question one about the parser", 0), assistant("Answer one, with detail.", 1),
      typed("question two about the lexer", 2), assistant("Working on two.", 3)]);
    store.db.prepare(`INSERT INTO stop_cursors (session_id, hook, transcript_key, transcript_path, file_dev, file_ino, first_line_sha,
      anchor_epoch, next_digest_seq, byte_offset, tail_sha, turn_start_offset, human_turns) VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, 1, 0, ?, NULL, 0)`)
      .run(SID, handoff.HANDOFF_HOOK, transcriptKey(path), path, cursorFirstLineSha(path), cursor.EMPTY_LINE_SHA);
    handoff.runHandoffDigests(store, { sessionId: SID, transcriptPath: path, atStop: false });
    const rows = () => store.db.prepare(`SELECT seq, range_from, payload FROM stop_items WHERE session_id = ? AND kind = 'turn-digest' ORDER BY range_from`)
      .all(SID) as { seq: number; range_from: number; payload: string }[];
    expect(rows().map(r => r.seq)).toEqual([1, 2]);
    // Make both rows v0.42.0 rows (no derivation revision).
    store.db.prepare(`UPDATE stop_items SET payload = json_remove(payload, '$.derivRev') WHERE session_id = ? AND kind = 'turn-digest'`).run(SID);
    handoff.runHandoffDigests(store, { sessionId: SID, transcriptPath: path, atStop: false });
    const after = rows();
    expect(after[0]!.seq).toBe(1);                                  // settled: before the cursor, never re-planned
    expect(JSON.parse(after[0]!.payload).derivRev).toBeUndefined();
    expect(after[1]!.seq).toBe(3);                                  // provisional: re-derived under the new revision
    expect(JSON.parse(after[1]!.payload).derivRev).toBe((handoff as any).DIGEST_DERIV_REV);
  });
});

// ─── CODE T1 (codex code review, turn 1) ────────────────────────────────────────────────────────────────────────────
describe("CODE T1-1: a task label reads <status> and <summary> from the element's leading header children only", () => {
  const NESTED = "<result><status>failed</status><summary>PRIVATE-OUTPUT</summary></result>";
  const cases: [string, string, string][] = [
    ["no direct status/summary, only nested ones", TN("<task-id>b1</task-id>", NESTED), "[background task]"],
    ["status/summary after a result (outside the leading header)",
      TN("<task-id>b1</task-id>", NESTED, "<status>completed</status>", "<summary>PRIVATE-OUTPUT finished</summary>"), "[background task]"],
    ["text between the children (not a clean child sequence)",
      TN("<task-id>b1</task-id>", "stray PRIVATE-OUTPUT words", "<status>completed</status>", "<summary>s1</summary>"), "[background task]"],
    ["a result that closes early and forges a second summary",
      TN("<status>completed</status>", "<summary>nightly export finished</summary>", "<result>a</result><summary>PRIVATE-OUTPUT</summary><result>b</result>"),
      "[background task completed] nightly export finished"],
    ["an event that closes early and forges a summary (the monitor shape: no status)",
      TN("<task-id>b1</task-id>", "<summary>monitor event</summary>", "<event>a</event><summary>PRIVATE-OUTPUT</summary><event>b</event>"),
      "[background task] monitor event"],
    ["a summary repeated inside the header", TN("<task-id>b1</task-id>", "<summary>one</summary>", "<summary>two</summary>"), "[background task]"],
  ];
  for (const [name, xml, label] of cases) {
    it(`${name}: both readers, and a queued task notice`, () => {
      const row = linesOf([taskRowXml(xml, 1)])[0]!;
      const turn = turnsOf([taskRowXml(xml, 1)])[0]!;
      const q = linesOf([typed("the first question", 0), assistant("working", 1),
        queued(xml, 2, { commandMode: "task-notification", origin: { kind: "task-notification" } })])[2]!;
      for (const l of [row, turn, q]) {
        expect(l.kind).toBe("notice");
        expect(l.text).toBe(label);
        expect(l.rendered).toBe(label);
      }
    });
  }
});

describe("CODE T1-2: an oversized system/local_command successor demotes the command before it", () => {
  const bigLocal = (wrapped: boolean, t: number): Entry => stamp({
    type: "system", subtype: "local_command", uuid: uid(), version: V_NEW, level: "info",
    content: wrapped ? `<local-command-stdout>${"x".repeat(20_000)}</local-command-stdout>` : `Status ${"x".repeat(20_000)}`,
  }, t);
  const entriesWith = (wrapped: boolean) => [typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2),
    bigLocal(wrapped, 3), typed("second question here", 4)];
  for (const release of [false, true]) {
    for (const wrapped of [false, true]) {
      const form = wrapped ? "wrapped" : "unwrapped";
      it(`release ${release}, ${form}: the peek at the read's bound demotes /model sonnet`, () => {
        const path = write(entriesWith(wrapped));
        const r = cursor.readLines(path, 0, { maxBytes: lineStarts(path)[3]!, releaseTrailingCommand: release });
        expect(r.bounded).toBe(true);
        expect(r.lines.length).toBe(3);
        expect(r.lines[2]!.kind).toBe("meta");
      });
      it(`release ${release}, ${form}: a streamed stretch runs past the built-in to the next prompt`, () => {
        const path = write(entriesWith(wrapped));
        const s = (extract as any).accumulateLines(path, 0, { stopAtNextOpening: true, maxBytes: lineStarts(path)[3]!, releaseTrailingCommand: release });
        expect(s.reachedOpening).toBe(true);
        expect(s.acc.lines).toBe(4);
      });
    }
  }
  // Successors longer than the 64 KiB prefix itself, so the prefix is cut inside their content.
  it("a successor longer than the 64 KiB prefix: a system/local_command row demotes the command, on both paths", () => {
    for (const wrapped of [false, true]) {
      const row = stamp({ type: "system", subtype: "local_command", uuid: uid(), version: V_NEW, level: "info",
        content: wrapped ? `<local-command-stdout>${"x".repeat(100_000)}</local-command-stdout>` : `Status ${"x".repeat(100_000)}` }, 3);
      const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2), row, typed("second question here", 4)]);
      const starts = lineStarts(path);
      expect(starts[4]! - starts[3]!).toBeGreaterThan(64 * 1024 + 30_000);
      expect(cursor.readLines(path, 0, { releaseTrailingCommand: true }).lines[2]!.kind).toBe("meta");   // parsed: no bound
      for (const release of [false, true]) {
        const r = cursor.readLines(path, 0, { maxBytes: starts[3]!, releaseTrailingCommand: release });
        expect(r.lines.length).toBe(3);
        expect(r.lines[2]!.kind).toBe("meta");
      }
    }
  });

  it("a successor longer than the 64 KiB prefix: a prompt command's expansion keeps the command a turn, on both paths", () => {
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/review", "the plan", 2),
      meta(`expansion ${"x".repeat(100_000)}`, 3), assistant("Reviewing.", 4)]);
    const starts = lineStarts(path);
    expect(starts[4]! - starts[3]!).toBeGreaterThan(64 * 1024 + 30_000);
    expect(cursor.readLines(path, 0, { releaseTrailingCommand: true }).lines[2]).toMatchObject({ kind: "human", text: "/review the plan" });
    for (const release of [false, true]) {
      const r = cursor.readLines(path, 0, { maxBytes: starts[3]!, releaseTrailingCommand: release });
      expect(r.lines[2]).toMatchObject({ kind: "human", text: "/review the plan" });
    }
  });

  it("an oversized successor that is not local output (a prompt command's expansion) keeps the command a turn", () => {
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/review", "the plan", 2),
      meta(`expansion ${"x".repeat(20_000)}`, 3), assistant("Reviewing.", 4)]);
    const r = cursor.readLines(path, 0, { maxBytes: lineStarts(path)[3]!, releaseTrailingCommand: false });
    expect(r.lines[2]).toMatchObject({ kind: "human", text: "/review the plan" });
  });

  // CODE T2-1: valid JSON may spell a key or a value with escapes; the parsed classifier decodes them, so must the scan.
  const escapedSuccessor = (spell: (line: string) => string) => {
    const entries = entriesWith(false);
    const lines = entries.map(e => JSON.stringify(e));
    lines[3] = spell(lines[3]!);
    expect(lines[3]).not.toContain('"type":"system"');
    const path = join(tmp(), "escaped.jsonl");
    writeFileSync(path, lines.join("\n") + "\n", "utf-8");
    return path;
  };
  for (const [form, spell] of [
    ["escaped values", (l: string) => l.replace('"type":"system"', '"type":"sys\\u0074em"').replace('"subtype":"local_command"', '"subtype":"local\\u005fcommand"')],
    ["escaped keys", (l: string) => l.replace('"type":"system"', '"t\\u0079pe":"system"').replace('"subtype":"local_command"', '"s\\u0075btype":"local_command"')],
  ] as const) {
    it(`(T2-1) an oversized successor whose envelope uses ${form} still demotes /model sonnet`, () => {
      const path = escapedSuccessor(spell);
      expect(hooks.classifyTranscriptRow(JSON.parse(readFileSync(path, "utf-8").split("\n")[3]!))).toMatchObject({ localOutput: true });
      for (const release of [false, true]) {
        const r = cursor.readLines(path, 0, { maxBytes: lineStarts(path)[3]!, releaseTrailingCommand: release });
        expect(r.lines.length).toBe(3);
        expect(r.lines[2]!.kind).toBe("meta");
      }
    });
  }

  // The same for the older shape: a user row whose content starts with <local-command-stdout>, spelled with escapes.
  const oldShapePath = (spell: (line: string) => string, text: string) => {
    const lines = [typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2),
      localStdout(text, 3), typed("second question here", 4)].map(e => JSON.stringify(e));
    lines[3] = spell(lines[3]!);
    const path = join(tmp(), "old-shape.jsonl");
    writeFileSync(path, lines.join("\n") + "\n", "utf-8");
    return path;
  };
  // BACKLOG 72.8: v0.42.0's pattern reads the raw prefix, so an escaped "<" hides the output from the oversized path.
  it.todo("(T2-1, BACKLOG 72.8) an oversized <local-command-stdout> successor spelled with escapes still demotes /model sonnet", () => {
    for (const spell of [
      (l: string) => l.replace('"content":"<local-command-stdout>', '"content":"\\u003clocal-command-stdout>'),
      (l: string) => l.replace('"content":"<local-command-stdout>', '"c\\u006fntent":"\\u000a<local\\u002dcommand-stdout>'),
    ]) {
      const path = oldShapePath(spell, "x".repeat(20_000));
      expect(cursor.readLines(path, 0, { releaseTrailingCommand: true }).lines[2]!.kind).toBe("meta");   // parsed: no bound
      for (const release of [false, true]) {
        const r = cursor.readLines(path, 0, { maxBytes: lineStarts(path)[3]!, releaseTrailingCommand: release });
        expect(r.lines.length).toBe(3);
        expect(r.lines[2]!.kind).toBe("meta");
      }
    }
  });

  it("(T2-1) a row QUOTING the JSON of local output is not local output, on either path", () => {
    const quoting = (l: string) => l.replace('"content":"<local-command-stdout>',
      '"content":"see {\\"content\\":\\"<local-command-stdout>and \\u0022content\\u0022:\\u0022<local-command-stdout>');
    const path = oldShapePath(quoting, "x".repeat(20_000));
    expect(cursor.readLines(path, 0, { releaseTrailingCommand: true }).lines[2]!.kind).toBe("human");   // parsed: no bound
    const r = cursor.readLines(path, 0, { maxBytes: lineStarts(path)[3]!, releaseTrailingCommand: false });
    expect(r.lines[2]).toMatchObject({ kind: "human", text: "/model sonnet" });
  });

  // CODE T3-1: an escaped quote INSIDE a key (`note"content`) must never read as a key boundary. BACKLOG 72.8: the
  // literal form fools v0.42.0's raw pattern, which the oversized path keeps.
  for (const [form, spell, known] of [
    ["a literal escaped quote", (l: string) => l, true],
    ["a Unicode-escaped quote", (l: string) => l.replace('"note\\"content":"<local-command-stdout>"', '"note\\u0022content":"\\u003clocal-command-stdout>"'), false],
  ] as const) {
    (known ? it.todo : it)(`(T3-1${known ? ", BACKLOG 72.8" : ""}) a key holding ${form} before "content" is not local output, on either path`, () => {
      const expansion: Entry = { type: "user", uuid: uid(), isMeta: true, version: V_NEW, timestamp: iso(3),
        message: { role: "user", 'note"content': "<local-command-stdout>", content: `Expansion ${"x".repeat(20_000)}` } };
      const lines = [typed("first question here", 0), assistant("answer", 1), command("/review", "the plan", 2), expansion,
        assistant("Reviewing.", 4)].map(e => JSON.stringify(e));
      lines[3] = spell(lines[3]!);
      expect(lines[3]).toContain("note\\");
      const path = join(tmp(), "quoted-key.jsonl");
      writeFileSync(path, lines.join("\n") + "\n", "utf-8");
      expect(cursor.readLines(path, 0, { releaseTrailingCommand: true }).lines[2]).toMatchObject({ kind: "human", text: "/review the plan" });
      for (const release of [false, true]) {
        const r = cursor.readLines(path, 0, { maxBytes: lineStarts(path)[3]!, releaseTrailingCommand: release });
        expect(r.lines[2]).toMatchObject({ kind: "human", text: "/review the plan" });
      }
    });
  }

  // BACKLOG 72.8: v0.42.0's pattern matches a content/text key at any depth.
  it.todo("(T3-1, BACKLOG 72.8) a nested content field starting with <local-command-stdout> (a tool's input) is not local output, on either path", () => {
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/review", "the plan", 2),
      assistant("Writing the notes.", 3, [{ id: "toolu_1", name: "Write",
        input: { file_path: "/tmp/notes.md", content: `<local-command-stdout>${"x".repeat(20_000)}</local-command-stdout>` } }]),
      assistant("Done.", 4)]);
    expect(cursor.readLines(path, 0, { releaseTrailingCommand: true }).lines[2]).toMatchObject({ kind: "human", text: "/review the plan" });
    for (const release of [false, true]) {
      const r = cursor.readLines(path, 0, { maxBytes: lineStarts(path)[3]!, releaseTrailingCommand: release });
      expect(r.lines[2]).toMatchObject({ kind: "human", text: "/review the plan" });
    }
  });

  it("(T3-1) an oversized assistant row whose rendered text starts with <local-command-stdout> demotes, as the parsed path does", () => {
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2),
      assistant(`<local-command-stdout>${"x".repeat(20_000)}</local-command-stdout>`, 3), assistant("Done.", 4)]);
    expect(cursor.readLines(path, 0, { releaseTrailingCommand: true }).lines[2]!.kind).toBe("meta");
    for (const release of [false, true]) {
      expect(cursor.readLines(path, 0, { maxBytes: lineStarts(path)[3]!, releaseTrailingCommand: release }).lines[2]!.kind).toBe("meta");
    }
  });

  it("only a TOP-LEVEL system/local_command envelope counts: a nested one in an oversized row does not", () => {
    const nested = { type: "system", subtype: "local_command", content: "not an envelope" };
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/review", "the plan", 2),
      assistant(`Reviewing ${"x".repeat(20_000)}`, 3, [{ id: "toolu_1", name: "Write", input: { file_path: "/tmp/a.json", nested } }]),
      assistant("Reviewed.", 4)]);
    const r = cursor.readLines(path, 0, { maxBytes: lineStarts(path)[3]!, releaseTrailingCommand: false });
    expect(r.lines[2]).toMatchObject({ kind: "human", text: "/review the plan" });
  });
});

describe("CODE T1-3: a restored opener keeps its own turn, and only a dropped opener is restored", () => {
  const replay = (entries: Entry[]) =>
    (extract as any).accumulateLines(write(entries), 0, { stopAtNextOpening: false, releaseTrailingCommand: true }).acc as extract.LineAccumulator;

  it("a replay that begins mid-turn: the dropped notice opener comes back as turn 1, once", () => {
    const entries: Entry[] = [assistant("continuing the earlier work", 0), assistant("still continuing", 1), taskRow("export finished", 2)];
    for (let i = 3; i < 153; i++) entries.push(assistant(`step ${i} of the follow-up`, i));
    const msgs = extract.accumulatedMessages(replay(entries));
    expect(msgs.length).toBe(100);
    expect(msgs[0]).toEqual({ role: "user", content: "[background task completed] export finished", turn: 1, opening: true });
    expect(msgs.filter(m => m.opening).length).toBe(1);
    expect([...new Set(msgs.map(m => m.turn))]).toEqual([1]);
  });

  it("an opener still inside the kept tail is not restored a second time", () => {
    const entries: Entry[] = [];
    for (let i = 0; i < 120; i++) entries.push(assistant(`continuing ${i}`, i));
    entries.push(taskRow("export finished", 120));
    for (let i = 121; i < 131; i++) entries.push(assistant(`after ${i}`, i));
    const acc = replay(entries);
    const msgs = extract.accumulatedMessages(acc);
    expect(msgs).toEqual(acc.messages);
    expect(msgs.filter(m => m.opening).length).toBe(1);
  });
});

describe("CODE T1-4: downstream cuts never split a surrogate pair", () => {
  it("a handoff digest's request (200 characters): typed, or a notice's label", () => {
    const typedReq = handoff.digestOf("claude-code", linesOf([typed("a".repeat(198) + EMOJI + " and the rest of the request", 0), assistant("Done.", 1)]));
    // "[background task completed] " is 28 characters: the emoji starts at index 198 of the label.
    const label = handoff.digestOf("claude-code", linesOf([taskRow("s".repeat(170) + EMOJI + " tail", 0), assistant("Done.", 1)]));
    expect(label.request.startsWith("[background task completed] sss")).toBe(true);
    for (const d of [typedReq, label]) {
      expect(d.request.length).toBeLessThanOrEqual(200);
      expect(LONE_SURROGATE.test(d.request)).toBe(false);
    }
  });

  it("an accumulated message (2,000 characters)", () => {
    const r = (extract as any).accumulateLines(write([typed("a".repeat(1_999) + EMOJI + " end", 0)]), 0, { stopAtNextOpening: true });
    const content = r.acc.messages[0].content as string;
    expect(content.startsWith("a".repeat(1_999))).toBe(true);
    expect(LONE_SURROGATE.test(content)).toBe(false);
  });
});

describe("CODE T1-5: step 0.1 comes first, whatever envelope carries the message", () => {
  it("a system/local_command row carrying an assistant message is assistant, in both readers", () => {
    const row = stamp({ type: "system", subtype: "local_command", uuid: uid(), version: V_NEW,
      message: { role: "assistant", content: [{ type: "text", text: "assistant words here" }] } }, 1);
    expect(linesOf([row])[0]).toMatchObject({ kind: "assistant", text: "assistant words here" });
    expect(turnsOf([row])[0]).toMatchObject({ kind: "assistant", text: "assistant words here" });
  });

  it("a queued_command attachment carrying a tool result is a tool result, in both readers", () => {
    const row = stamp({ type: "attachment", uuid: uid(), version: V_NEW,
      attachment: { type: "queued_command", prompt: "typed words", commandMode: "prompt", origin: { kind: "human" } },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "output" }] } }, 1);
    expect(linesOf([row])[0]!.kind).toBe("tool_result");
    expect(turnsOf([row])[0]!.kind).toBe("tool_result");
  });
});

describe("CODE T1-6: metadata that is present but invalid is not absent", () => {
  it("a task-shaped row whose turnOrigin is present but invalid never opens by shape (an older writer)", () => {
    for (const turnOrigin of ["Task-Notification", "", 42, null]) {
      const row = stamp({ type: "user", uuid: uid(), version: V_OLD, turnOrigin, message: { role: "user", content: TASK_XML("export finished") } }, 1);
      expect(linesOf([row])[0]!.kind).toBe("meta");
      expect(turnsOf([row])[0]!.kind).toBe("meta");
    }
  });

  it("a typed row whose turnOrigin is present but invalid stays a typed prompt", () => {
    const row = stamp({ type: "user", uuid: uid(), version: V_NEW, turnOrigin: "Human", message: { role: "user", content: "please look at the indexer" } }, 1);
    expect(linesOf([row])[0]).toMatchObject({ kind: "human", text: "please look at the indexer" });
  });

  it("a peer-preamble row whose origin is present but not an object never reads as a peer", () => {
    for (const origin of ["peer", {}]) {
      const row = stamp({ type: "user", uuid: uid(), isMeta: true, version: V_OLD, origin,
        message: { role: "user", content: `${PEER_PREAMBLE}${PEER_EL("BODY")}` } }, 1);
      expect(linesOf([row])[0]!.kind).toBe("meta");
    }
  });

  it("a queued task-mode prompt whose origin has no valid kind is queued-unknown", () => {
    for (const origin of [{}, { kind: 5 }, { name: "x" }]) {
      const l = linesOf([typed("the first question", 0), assistant("working", 1),
        queued(TASK_XML("tests passed"), 2, { commandMode: "task-notification", origin })])[2]!;
      expect(notice(l)).toMatchObject({ source: "queued-unknown", opens: false });
      expect(l.text).toBe("[input received while the assistant was working]");
    }
  });
});

// ─── BACKLOG 72.9 (v0.43.1) ─────────────────────────────────────────────────────────────────────────────────────────
/**
 * Input received while the model worked (a non-opening notice: a `queued_command` attachment) written between a
 * built-in command's record and its output. v0.43.0 read only the record's immediate successor, so the record stayed a
 * request — in the PreCompact reader, in the Stop reader's in-read rule, at the read-end peek and in the backward scan's
 * one-line lookahead. Found in review; no surveyed transcript holds the shape (each of 4,076 built-in records had its output
 * as the very next row). Without queued input, two more cases change: a bounded read, or a backward scan's
 * step, that ends at a record whose next line is still being written now holds the record back, as the end of the file
 * does, instead of releasing it.
 */
describe("72.9: queued input between a built-in command and its output", () => {
  const Q = {
    typed: (t: number) => queued("also check the retry path", t, { origin: { kind: "human" } }),
    peer: (t: number) => queued(`${PEER_PREAMBLE}${PEER_EL("BODY-SECRET")}`, t, { origin: { kind: "peer", name: "lane-b", body: "BODY-SECRET", from: "/tmp/PEER-SOCKET.sock" } }),
    task: (t: number) => queued(TASK_XML("tests passed"), t, { commandMode: "task-notification", origin: { kind: "task-notification" } }),
    unknown: (t: number) => queued("UNKNOWN-SOURCE-TEXT", t),
  };
  const humans = (ls: { kind: string; text: string }[]) => ls.filter(l => l.kind === "human").map(l => l.text);
  const kinds = (ls: { kind: string }[]) => ls.map(l => l.kind);

  it("the command is meta in both readers, whatever the queued input and the output row", () => {
    for (const args of ["", "sonnet"]) for (const output of [localStdout, localCommandRow])
      for (const between of [[Q.typed], [Q.peer], [Q.task], [Q.unknown], [Q.typed, Q.task]]) {
        const entries = [typed("first question here", 0), assistant("answer", 1), command("/model", args, 2),
          ...between.map((q, i) => q(3 + i)), output("Set model to sonnet", 10), assistant("a reply after the switch", 11)];
        expect(linesOf(entries)[2]!.kind).toBe("meta");
        expect(humans(linesOf(entries))).toEqual(["first question here"]);
        expect(humans(turnsOf(entries))).toEqual(["first question here"]);
      }
  });

  it("an opening notice after a command record is its successor: the command stays a turn (guard; an unobserved shape)", () => {
    const entries = [typed("first question here", 0), assistant("answer", 1), command("/review", "the diff", 2), taskRow("done", 3),
      localStdout("stray output", 4)];
    expect(linesOf(entries)[2]).toMatchObject({ kind: "human", text: "/review the diff" });
    expect(turnsOf(entries)[2]).toMatchObject({ kind: "human", text: "/review the diff" });
  });

  it("a prompt command followed by queued input and then its expansion stays a turn (guard)", () => {
    const entries = [typed("first question here", 0), assistant("answer", 1), command("/review", "the diff", 2), Q.typed(3),
      meta("expansion of the prompt command", 4), assistant("Reviewed.", 5)];
    expect(humans(linesOf(entries))).toEqual(["first question here", "/review the diff"]);
    expect(humans(turnsOf(entries))).toEqual(["first question here", "/review the diff"]);
  });

  it("Stop reader: a command record followed only by queued input is held back until its output is written", () => {
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2), Q.typed(3), Q.peer(4)]);
    const r = cursor.readLines(path, 0);   // releaseTrailingCommand off
    expect(kinds(r.lines)).toEqual(["human", "assistant"]);
    expect(r.next).toBe(lineStarts(path)[2]!);
    expect(r.eof).toBe(false);
    expect(cursor.currentTurnStart(path)).toBe(0);
    appendEntries(path, [localStdout("Set model to sonnet", 5), assistant("a reply after the switch", 6)]);
    expect(kinds(cursor.readLines(path, r.next).lines)).toEqual(["meta", "notice", "notice", "meta", "assistant"]);
  });

  it("Stop reader: released, or a prompt command, it is not held back (guard)", () => {
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2), Q.typed(3)]);
    expect(kinds(cursor.readLines(path, 0, { releaseTrailingCommand: true }).lines)).toEqual(["human", "assistant", "human", "notice"]);
    const p2 = write([typed("first question here", 0), assistant("answer", 1), promptCommand("/review", "the diff", 2), Q.typed(3)]);
    const r = cursor.readLines(p2, 0);
    expect(kinds(r.lines)).toEqual(["human", "assistant", "human", "notice"]);
    expect(r.next).toBe(readFileSync(p2).length);
  });

  for (const release of [false, true]) {
    it(`Stop reader, a bounded read (releaseTrailingCommand ${release}) ending at the record or inside the queued input: meta`, () => {
      const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2), Q.typed(3), Q.task(4),
        localStdout("Set model to sonnet", 5), typed("second question here", 6)]);
      for (const end of [3, 4, 5]) {
        const r = cursor.readLines(path, 0, { maxBytes: lineStarts(path)[end]!, releaseTrailingCommand: release });
        expect(r.bounded).toBe(true);
        expect(r.lines.length).toBe(end);
        expect(r.lines[2]!.kind).toBe("meta");
      }
    });
  }

  it("Stop reader, a bounded read whose record has only queued input after it: held back like at the end, or released", () => {
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2), Q.typed(3), Q.task(4)]);
    const held = cursor.readLines(path, 0, { maxBytes: lineStarts(path)[3]! });
    expect(kinds(held.lines)).toEqual(["human", "assistant"]);
    expect(held.next).toBe(lineStarts(path)[2]!);
    expect(held.bounded).toBe(false);
    const released = cursor.readLines(path, 0, { maxBytes: lineStarts(path)[3]!, releaseTrailingCommand: true });
    expect(kinds(released.lines)).toEqual(["human", "assistant", "human"]);
    expect(released.bounded).toBe(true);
  });

  it("Stop reader, a bounded read ending at a record whose next line is still being written: held back (no queued input)", () => {
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2)]);
    const complete = readFileSync(path).length;
    const recordStart = lineStarts(path)[2]!;
    const out = JSON.stringify(localStdout("Set model to sonnet", 3)) + "\n";
    writeFileSync(path, readFileSync(path, "utf-8") + out.slice(0, 25));   // its output, not complete yet
    const held = cursor.readLines(path, 0, { maxBytes: complete });
    expect(kinds(held.lines)).toEqual(["human", "assistant"]);
    expect(held.next).toBe(recordStart);
    expect(held.bounded).toBe(false);
    expect(kinds(cursor.readLines(path, 0, { maxBytes: complete, releaseTrailingCommand: true }).lines)).toEqual(["human", "assistant", "human"]);
    writeFileSync(path, readFileSync(path, "utf-8").slice(0, complete) + out);   // the line completes
    expect(kinds(cursor.readLines(path, 0, { maxBytes: complete }).lines)).toEqual(["human", "assistant", "meta"]);
  });

  it("a stream in reads of any size agrees with one whole read", () => {
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2), Q.typed(3), Q.peer(4),
      localCommandRow("Set model to sonnet", 5), assistant("a reply after the switch", 6), typed("second question here", 7), assistant("ok", 8)]);
    const starts = lineStarts(path);
    const size = readFileSync(path).length;
    const longest = Math.max(...starts.map((s, i) => (starts[i + 1] ?? size) - s));
    for (const release of [false, true]) {
      const whole = cursor.readLines(path, 0, { releaseTrailingCommand: release }).lines.map(l => `${l.kind}:${l.text}`);
      expect(whole[2]).toBe("meta:");
      for (let maxBytes = longest; maxBytes <= size; maxBytes += 7) {
        const seen: string[] = [];
        const end = cursor.streamLines(path, 0, l => { seen.push(`${l.kind}:${l.text}`); }, { maxBytes, releaseTrailingCommand: release });
        expect(end.eof).toBe(true);
        expect(seen).toEqual(whole);
      }
    }
  });

  /** stop-cursor's BACK_CHUNK: a backward scan step. A tail of STEP - 1 bytes after the record ends a step right after it. */
  const STEP = 16 * 1024 * 1024;
  const lineBytes = (e: Entry) => Buffer.byteLength(JSON.stringify(e)) + 1;

  it("the backward scan reads past queued input after a record at a step's end (currentTurnStart, humanLineAtOrBefore)", () => {
    const q = Q.typed(3);
    const out = localStdout("Set model to sonnet", 4);
    const reply = assistant("reply ", 5) as any;
    const pad = STEP - 1 - lineBytes(q) - lineBytes(out) - lineBytes(reply);
    reply.message.content[0].text += "r".repeat(pad);
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2), q, out, reply]);
    expect(readFileSync(path).length - lineStarts(path)[3]!).toBe(STEP - 1);
    expect(cursor.currentTurnStart(path)).toBe(0);
    expect(cursor.humanLineAtOrBefore(path, Date.parse(iso(5)))).toBe(0);
  }, 30_000);

  it("the backward scan: queued input from a record at a step's end to the end of the file is the end of the file (held back)", () => {
    const q = Q.typed(3) as any;
    q.attachment.prompt += "q".repeat(STEP - 1 - lineBytes(q));
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2), q]);
    expect(readFileSync(path).length - lineStarts(path)[3]!).toBe(STEP - 1);
    expect(cursor.currentTurnStart(path)).toBe(0);
  }, 30_000);

  it("the backward scan: a record at a step's end before a last line still being written, longer than a step: held back (no queued input)", () => {
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2)]);
    const partial = JSON.stringify(assistant("x".repeat(STEP), 3)).slice(0, STEP + 100);   // no newline yet
    writeFileSync(path, readFileSync(path, "utf-8") + partial);
    expect(cursor.currentTurnStart(path)).toBe(0);
  }, 30_000);

  it("the backward scan, no earlier opener: a record held back in a later step anchors the turn at it (queued input)", () => {
    const rec = command("/review", "the diff", 0);
    const qs: Entry[] = [];
    let tail = STEP - 1;
    while (tail > 0) {
      const q = Q.typed(1) as any;
      const room = tail - lineBytes(q);
      if (room < 0) throw new Error("fixture: a queued line does not fit");
      q.attachment.prompt += "q".repeat(Math.min(room, 4 * 1024 * 1024));
      qs.push(q);
      tail -= lineBytes(q);
    }
    const path = write([rec, ...qs]);
    expect(readFileSync(path).length - lineStarts(path)[1]!).toBe(STEP - 1);
    expect(cursor.currentTurnStart(path)).toBe(0);
    appendEntries(path, [meta("expansion of the prompt command", 2), assistant("Reviewed.", 3)]);
    expect(cursor.currentTurnStart(path)).toBe(0);
  }, 30_000);

  it("the backward scan, no earlier opener: a record before a last line still being written, longer than a step, anchors the turn at it", () => {
    const path = write([command("/review", "the diff", 0)]);
    writeFileSync(path, readFileSync(path, "utf-8") + JSON.stringify(assistant("x".repeat(STEP), 1)).slice(0, STEP + 100));
    expect(cursor.currentTurnStart(path)).toBe(0);
  }, 30_000);

  it("the backward scan reads a complete successor larger than a read whole, as v0.43.0 did (guard; codex 72.9 T2-1)", () => {
    const path = write([typed("first question here", 0), assistant("answer", 1), command("/model", "sonnet", 2)]);
    // A complete local-output row of 70 MiB whose first "<" is the JSON escape \u003c: only a full parse sees the output.
    const row = JSON.stringify(localStdout("x".repeat(70 * 1024 * 1024), 3)).replace("<local-command-stdout>", "\\u003clocal-command-stdout>");
    expect(row.includes("<local-command-stdout>")).toBe(false);
    writeFileSync(path, readFileSync(path, "utf-8") + row + "\n");
    expect(cursor.currentTurnStart(path)).toBe(0);
    expect(cursor.humanLineAtOrBefore(path, Date.parse(iso(3)))).toBe(0);
  }, 60_000);

  it("the classifier revision is 3: state derived under revision 2 is derived again", () => {
    expect(hooks.TRANSCRIPT_CLASSIFIER_REVISION).toBe(3);
    expect((observerContractInputs() as Record<string, unknown>).classifier).toBe(3);
  });
});
