/**
 * 62.1 D1: turn identity — which transcript turn a context-surfacing usage row belongs to.
 *
 * A row pairs with a human turn only when BOTH hold: the row's `prompt_sha` equals the hash of the turn's host text,
 * and the host's ordering rule holds on the entries' own timestamps. Claude Code builds the user message before its
 * UserPromptSubmit hooks run (the row is written after its human entry, before the next one): `H.ts <= U.ts <
 * H_next.ts`. OpenClaw runs ClawMem's surfacing in `before_prompt_build`, before it submits the prompt (the row
 * precedes its human entry): `E_prev.ts <= U.ts <= H.ts`, E_prev being the entry just before H. Hermes' plugin
 * prefetches in the background once a turn is synced: its row carries the text of the turn just written (Claude Code's
 * rule), but the turn its references are tested in is the one the plugin says received the context, found by the
 * row's id (`hermesRecipient`), not by pairing. A pairing must be unique in both directions; zero or several
 * candidates leave the row unattributed — never guessed. When a timestamp the rule needs is missing, only the hash
 * decides, and it must then be unique among the rows and the turns given.
 *
 * 72.4: an opening notice (a task's notice, a peer's message) opens a turn too. It is a candidate when its identity —
 * the hash of the text the surfacing hook received for it, computed by the classifier — equals the row's hash, and
 * every window closes at the next opening, human or notice.
 *
 * Pure: callers pass one transcript's entries and that transcript's pending rows (a row without a transcript key is
 * never passed — it waits until it is bound, D1 rev 14).
 */

import { createHash } from "crypto";
import { resolve } from "path";
import { cleanPromptForSearch } from "./openclaw/prompt-clean.ts";

export type StopHost = "claude-code" | "openclaw" | "hermes";

/** The host a hook input names: `host: "openclaw"` / `"hermes"`; absent (or anything else) is Claude Code. */
export function stopHostOf(host: string | undefined | null): StopHost {
  return host === "openclaw" ? "openclaw" : host === "hermes" ? "hermes" : "claude-code";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** NFC, whitespace runs collapsed to one space, trimmed. */
export function normalizePromptForIdentity(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** The hash a usage row records for the prompt its surfacing hook received. */
export function promptSha(prompt: string): string {
  return sha256(normalizePromptForIdentity(prompt));
}

/** sha256 of the transcript's absolute path: the transcript's identity in every per-transcript key. */
export function transcriptKey(transcriptPath: string): string {
  return sha256(resolve(transcriptPath));
}

/** A transcript entry's or usage row's time in epoch ms: ISO string or epoch-ms number; anything else is unknown. */
export function parseEntryTime(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** The text a host's surfacing hook hashed for this human entry: as typed (Claude Code), or cleaned (OpenClaw). */
export function hostText(host: StopHost, humanText: string): string {
  return host === "openclaw" ? cleanPromptForSearch(humanText) : humanText;
}

/**
 * `human`: a human entry (its text is hashed); `notice`: an opening notice (its `identitySha` is the hash); any other
 * kind (OpenClaw's `prev`) only bounds a window.
 */
export type PairingEntry = { kind: string; text: string; ts: number | null; identitySha?: string };

/** An entry that opens a turn: a human entry or an opening notice. */
export const opensPairingTurn = (e: PairingEntry) => e.kind === "human" || e.kind === "notice";
export type PairingRow = { id: number; promptSha: string | null; ts: number | null };

type Window = { lo: number; hi: number; hiInclusive: boolean } | null;   // null: undecidable, the hash alone decides

function windowOf(host: StopHost, entries: readonly PairingEntry[], i: number): Window {
  const h = entries[i]!;
  if (h.ts === null) return null;
  if (host === "openclaw") {
    if (i === 0) return { lo: -Infinity, hi: h.ts, hiInclusive: true };
    const prev = entries[i - 1]!;
    return prev.ts === null ? null : { lo: prev.ts, hi: h.ts, hiInclusive: true };
  }
  for (let j = i + 1; j < entries.length; j++) {
    if (!opensPairingTurn(entries[j]!)) continue;
    const next = entries[j]!.ts;
    return next === null ? null : { lo: h.ts, hi: next, hiInclusive: false };
  }
  return { lo: h.ts, hi: Infinity, hiInclusive: false };
}

/**
 * Whether the human entry at `index` has a CLOSED time window — both bounds known — so no later entry can change the
 * pairing (T24 #2, T25 #1). OpenClaw's window [E_prev.ts, H.ts] is closed once H is written; Claude Code's
 * [H.ts, H_next.ts) is open for the trailing turn (a later entry without a timestamp would make it undecidable), so
 * a trailing Claude Code turn is never credited provisionally: its end is proven by a Stop, a stop marker, a later
 * turn or the session's end. A hash-only pairing is never closed.
 */
export function pairWindowClosed(host: StopHost, entries: readonly PairingEntry[], index: number): boolean {
  const w = windowOf(host, entries, index);
  return w !== null && Number.isFinite(w.hi);
}

function inWindow(w: Window, ts: number | null): boolean {
  if (w === null || ts === null) return true;   // undecidable: uniqueness of the hash is the only test left
  return ts >= w.lo && (w.hiInclusive ? ts <= w.hi : ts < w.hi);
}

/**
 * Pair usage rows with the turns of ONE transcript. Returns row id → index (into `entries`) of its human entry or
 * opening notice, for the rows that pair uniquely in both directions; every other row is unattributed.
 */
export function pairTurns(host: StopHost, entries: readonly PairingEntry[], rows: readonly PairingRow[]): Map<number, number> {
  const turns: { index: number; sha: string; window: Window }[] = [];
  entries.forEach((e, i) => {
    if (e.kind === "human") turns.push({ index: i, sha: promptSha(hostText(host, e.text)), window: windowOf(host, entries, i) });
    else if (e.kind === "notice" && e.identitySha) turns.push({ index: i, sha: e.identitySha, window: windowOf(host, entries, i) });
  });
  const byRow = new Map<number, number[]>();    // row id → candidate turn indexes
  const byTurn = new Map<number, number[]>();   // turn index → candidate row ids
  for (const r of rows) {
    if (!r.promptSha) continue;
    for (const t of turns) {
      if (t.sha !== r.promptSha || !inWindow(t.window, r.ts)) continue;
      (byRow.get(r.id) ?? byRow.set(r.id, []).get(r.id)!).push(t.index);
      (byTurn.get(t.index) ?? byTurn.set(t.index, []).get(t.index)!).push(r.id);
    }
  }
  const pairs = new Map<number, number>();
  for (const [rowId, cands] of byRow) {
    if (cands.length !== 1) continue;
    if (byTurn.get(cands[0]!)!.length !== 1) continue;
    pairs.set(rowId, cands[0]!);
  }
  return pairs;
}
