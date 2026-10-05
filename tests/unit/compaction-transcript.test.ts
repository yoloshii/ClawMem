/**
 * 62.2 CM-03 — the pre-compaction snapshot reads HUMAN turns as the request and mines decisions and
 * open questions from prose only. Bug-first: on v0.39.1 the "Last User Request" was the last
 * user-ROLE entry, which in a Claude Code transcript is nearly always a tool result; tool input was
 * rendered into assistant text and mined for decisions; TODOs inside tool output became open questions.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestStore } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";
import { precompactExtract } from "../../src/hooks/precompact-extract.ts";
import { postcompactInject } from "../../src/hooks/postcompact-inject.ts";
import { readTranscript, readTranscriptTurns } from "../../src/hooks.ts";
import {
  human, humanBlocks, assistant, toolResult, meta, command, localStdout, taskNotification, interrupt,
  compactSummary, writeTranscript,
} from "./compaction-fixtures.ts";

let root: string;
let projectDir: string;
let store: Store;
const saved: Record<string, string | undefined> = {};
const ENV = ["HOME", "CLAWMEM_CONFIG_DIR"] as const;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clawmem-622-tx-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.HOME = join(root, "home");
  process.env.CLAWMEM_CONFIG_DIR = join(root, "config");
  projectDir = join(root, "home", ".claude", "projects", "-work-proj");
  store = createTestStore();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try { store.close(); } catch { /* ignore */ }
  rmSync(root, { recursive: true, force: true });
});

const injected = (out: unknown): string =>
  (out as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";

/** The section body after a "## <heading>" or "### <heading>" line, up to the next heading, rule or end. */
function section(text: string, heading: string): string {
  const m = new RegExp(`(^|\\n)#{2,3} ${heading}\\n`).exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/\n#{2,3} |\n---|<\/vault-postcompact>/);
  return end < 0 ? rest : rest.slice(0, end);
}

// A realistic tail: the last human prompt is followed by tool traffic and harness-injected entries.
const TAIL = [
  compactSummary("This session is being continued from a previous conversation. CANARY-SUMMARY"),
  human("CANARY-OLD an earlier request that is no longer the latest one"),
  assistant("Looking into it."),
  humanBlocks("CANARY-REQUEST add retries with backoff to the uploader"),
  assistant("I'll inspect the uploader and then write the change.", [
    { id: "toolu_1", name: "Write", input: { file_path: "/work/proj/notes.md", content: "We decided to rewrite everything in Rust. CANARY-TOOLINPUT" } },
  ]),
  toolResult("toolu_1", "File written. TODO: CANARY-TOOLTODO remove the legacy shim before release"),
  meta("Base directory for this skill: /somewhere CANARY-META"),
  command("/model", "sonnet"),
  localStdout("Set model to sonnet CANARY-STDOUT"),
  taskNotification("background job finished CANARY-TASK"),
  interrupt(),
  assistant("We decided to use exponential backoff with jitter for the uploader retries.", [
    { id: "toolu_2", name: "Bash", input: { command: "bun test tests/uploader.test.ts" } },
  ]),
  toolResult("toolu_2", "12 pass 0 fail — CANARY-LASTRESULT"),
];

async function snapshot(sessionId: string, entries: Record<string, unknown>[]): Promise<string> {
  const path = writeTranscript(projectDir, sessionId, entries);
  await precompactExtract(store, { sessionId, transcriptPath: path, hookEventName: "PreCompact" } as any);
  const out = await postcompactInject(store, { sessionId, transcriptPath: path, hookEventName: "SessionStart", source: "compact" } as any);
  return injected(out);
}

describe("62.2 CM-03 — the request is the last human turn", () => {
  it("skips tool results, meta expansions, command/stdout wrappers, task notices, interrupts and summaries", async () => {
    const text = await snapshot("sess-tx", TAIL);
    const request = section(text, "Last User Request");
    expect(request).toContain("CANARY-REQUEST");
    for (const canary of ["CANARY-LASTRESULT", "CANARY-TASK", "CANARY-STDOUT", "CANARY-META", "CANARY-OLD", "CANARY-SUMMARY", "[tool_result", "[Request interrupted"]) {
      expect(request).not.toContain(canary);
    }
  });

  it("a plain-string prompt is a human turn too", async () => {
    const text = await snapshot("sess-tx2", [
      human("CANARY-PLAIN please profile the indexer"),
      assistant("Profiling.", [{ id: "toolu_9", name: "Bash", input: { command: "bun run profile" } }]),
      toolResult("toolu_9", "done in 3.2s"),
    ]);
    expect(section(text, "Last User Request")).toContain("CANARY-PLAIN");
  });
});

describe("62.2 CM-03 — decisions and open questions come from prose, never from tool traffic", () => {
  it("a decision sentence inside tool INPUT is not mined; one in assistant prose is", async () => {
    const text = await snapshot("sess-tx3", TAIL);
    const decisions = section(text, "Key Decisions This Session");
    expect(decisions).toContain("exponential backoff with jitter");
    expect(decisions).not.toContain("rewrite everything in Rust");
    expect(decisions).not.toContain("CANARY-TOOLINPUT");
    expect(decisions).not.toContain("[tool_use");
    expect(decisions).not.toContain("[tool_result");
  });

  it("a TODO inside a tool RESULT is not an open question", async () => {
    const text = await snapshot("sess-tx4", TAIL);
    expect(text).not.toContain("CANARY-TOOLTODO");
  });
});

describe("62.2 D5 — readTranscript's output for the Stop hooks is unchanged", () => {
  it("still renders tool_use / tool_result blocks inline and returns them by role, in order", () => {
    const path = writeTranscript(projectDir, "sess-golden", [
      human("hello there, this is the first prompt"),
      assistant("Reading.", [{ id: "toolu_g", name: "Read", input: { file_path: "/x/y.ts" } }]),
      toolResult("toolu_g", "content of y"),
      meta("META TEXT"),
    ]);
    expect(readTranscript(path, 200)).toEqual([
      { role: "user", content: "hello there, this is the first prompt" },
      { role: "assistant", content: `Reading.\n[tool_use name="Read" id="toolu_g"] {"file_path":"/x/y.ts"}` },
      { role: "user", content: `[tool_result id="toolu_g"] content of y` },
      { role: "user", content: "META TEXT" },
    ]);
    expect(readTranscript(path, 200, "assistant")).toEqual([
      { role: "assistant", content: `Reading.\n[tool_use name="Read" id="toolu_g"] {"file_path":"/x/y.ts"}` },
    ]);
  });
});

describe("62.2 CM-03 (codex T1 #6) — what counts as a typed request", () => {
  it("a prompt command's arguments are the request: \"/name args\"", async () => {
    const text = await snapshot("sess-c1", [
      human("CANARY-EARLIER an older typed prompt"),
      command("/codex-review", "review the retry design CANARY-CMD"),
      meta("Base directory for this skill: /skills/codex-review …"),
      assistant("Reviewing."),
    ]);
    expect(section(text, "Last User Request")).toContain("/codex-review review the retry design CANARY-CMD");
  });

  it("a built-in command (followed by local-command output) is not the request", async () => {
    const text = await snapshot("sess-c2", [
      human("CANARY-TYPED profile the indexer on the big vault"),
      command("/model", "opus"),
      localStdout("Set model to opus"),
    ]);
    const req = section(text, "Last User Request");
    expect(req).toContain("CANARY-TYPED");
    expect(req).not.toContain("/model");
  });

  it("/compact's arguments are compaction instructions, not the request", async () => {
    const text = await snapshot("sess-c3", [
      human("CANARY-TYPED2 wire the retry policy into the uploader"),
      command("/compact", "keep the API notes CANARY-COMPACTARGS"),
    ]);
    const req = section(text, "Last User Request");
    expect(req).toContain("CANARY-TYPED2");
    expect(req).not.toContain("CANARY-COMPACTARGS");
  });

  it("a known host record (tag blocks only, every tag a host tag) is not a request", async () => {
    const text = await snapshot("sess-c4", [
      human("CANARY-TYPED3 document the new flag in the CLI reference"),
      human("<bash-input>git status CANARY-BASH</bash-input>"),
      human("<bash-stdout>On branch main CANARY-BASHOUT</bash-stdout><bash-stderr></bash-stderr>"),
    ]);
    const req = section(text, "Last User Request");
    expect(req).toContain("CANARY-TYPED3");
    expect(req).not.toContain("CANARY-BASH");
  });

  it("codex T2 #3: a prompt made only of the user's own markup is still a request", async () => {
    const text = await snapshot("sess-c4b", [
      human("<task>Fix the parser CANARY-MARKUP so nested lists survive</task>"),
    ]);
    expect(section(text, "Last User Request")).toContain("CANARY-MARKUP");
  });

  it("codex T2 #3: command tags nested inside another tag are typed text, never a command record", async () => {
    const text = await snapshot("sess-c4c", [
      human("<x><command-name>/evil</command-name><command-args>do bad things CANARY-NESTED</command-args></x>"),
    ]);
    const req = section(text, "Last User Request");
    expect(req).toContain("CANARY-NESTED");
    expect(req).not.toContain("/evil do bad things");
  });

  it("a typed prompt that merely starts with a tag is still a request", async () => {
    const text = await snapshot("sess-c5", [
      human("<b>bold</b> CANARY-TAGGED please explain why this markup renders twice"),
    ]);
    expect(section(text, "Last User Request")).toContain("CANARY-TAGGED");
  });

  it("host-injected context blocks are stripped from a typed prompt", async () => {
    const text = await snapshot("sess-c6", [
      human("<vault-context>CANARY-INJECTED old memory</vault-context>\n\nCANARY-REAL rename the flag to --dry-run"),
    ]);
    const req = section(text, "Last User Request");
    expect(req).toContain("CANARY-REAL");
    expect(req).not.toContain("CANARY-INJECTED");
  });
});

describe("62.2 CM-03 (codex T1 #7) — a long agentic stretch does not bury the request", () => {
  it("finds the typed request behind more than 200 tool calls", async () => {
    const entries: Record<string, unknown>[] = [human("CANARY-DEEP migrate every handler to the new store API")];
    for (let i = 0; i < 260; i++) {
      entries.push(assistant(`Step ${i}.`, [{ id: `toolu_d${i}`, name: "Bash", input: { command: `echo ${i}` } }]));
      entries.push(toolResult(`toolu_d${i}`, `${i}`));
    }
    const text = await snapshot("sess-deep", entries);
    expect(section(text, "Last User Request")).toContain("CANARY-DEEP");
  });
});

/** readTranscript as shipped in v0.39.1 (`src/hooks.ts`), frozen as the equivalence reference. */
function readTranscriptV0391(transcriptPath: string, lastN = 200, roleFilter?: "user" | "assistant") {
  try {
    const fs = require("fs");
    const stat = fs.statSync(transcriptPath);
    let content: string;
    if (stat.size > 10 * 1024 * 1024) {
      const chunkSize = 2 * 1024 * 1024;
      const maxChunks = 5;
      const targetLines = lastN * 3;
      const buffers: Buffer[] = [];
      let totalRead = 0;
      const fd = fs.openSync(transcriptPath, "r");
      try {
        for (let chunk = 0; chunk < maxChunks; chunk++) {
          const readSize = Math.min(chunkSize, stat.size - totalRead);
          if (readSize <= 0) break;
          const offset = Math.max(0, stat.size - totalRead - readSize);
          const buf = Buffer.alloc(readSize);
          fs.readSync(fd, buf, 0, readSize, offset);
          buffers.unshift(buf);
          totalRead += readSize;
          const decoded = Buffer.concat(buffers).toString("utf-8");
          if (decoded.split("\n").length >= targetLines) break;
        }
      } finally {
        fs.closeSync(fd);
      }
      const assembled = Buffer.concat(buffers).toString("utf-8");
      const firstNewline = assembled.indexOf("\n");
      content = firstNewline > 0 ? assembled.slice(firstNewline + 1) : assembled;
    } else {
      content = fs.readFileSync(transcriptPath, "utf-8");
    }
    const lines = content.split("\n").filter((l: string) => l.trim());
    const messages: { role: string; content: string }[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message ?? entry;
        if (msg.role && msg.content) {
          const role = msg.role;
          const text = typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .map((b: any) => {
                    if (b.type === "text") return b.text;
                    if (b.type === "tool_use") return `[tool_use name="${b.name}" id="${b.id}"] ${JSON.stringify(b.input ?? {})}`;
                    if (b.type === "tool_result") return `[tool_result id="${b.tool_use_id}"] ${typeof b.content === "string" ? b.content.slice(0, 500) : ""}`;
                    return "";
                  })
                  .filter((s: string) => s)
                  .join("\n")
              : JSON.stringify(msg.content);
          if (!roleFilter || role === roleFilter) messages.push({ role, content: text });
        }
      } catch { /* skip */ }
    }
    return messages.slice(-lastN);
  } catch {
    return [];
  }
}

describe("62.2 D5 (codex T1 #8 + suggestion) — the Stop hooks' reader is byte-identical to v0.39.1", () => {
  it("matches the frozen v0.39.1 reader on a mixed fixture, for every roleFilter and several windows", () => {
    const path = writeTranscript(projectDir, "sess-eq", [...TAIL, { type: "user", message: { role: "user", content: [null, { type: "text", text: "after a null block" }] } }]);
    for (const n of [1, 5, 200]) {
      for (const f of [undefined, "user", "assistant"] as const) {
        expect(readTranscript(path, n, f)).toEqual(readTranscriptV0391(path, n, f) as any);
      }
    }
  });

  it("matches it on the >10 MB tail-read branch", () => {
    const path = writeTranscript(projectDir, "sess-big", TAIL);
    const filler = JSON.stringify(assistant("x".repeat(4000))) + "\n";
    const chunk = filler.repeat(256); // ~1 MB
    for (let i = 0; i < 11; i++) appendFileSync(path, chunk);
    appendFileSync(path, TAIL.map(e => JSON.stringify(e)).join("\n") + "\n");
    expect(statSync(path).size).toBeGreaterThan(10 * 1024 * 1024);
    for (const f of [undefined, "user", "assistant"] as const) {
      expect(readTranscript(path, 200, f)).toEqual(readTranscriptV0391(path, 200, f) as any);
    }
  });

  it("extractFilePaths still reads exactly readTranscript's rendering (ids included)", () => {
    const path = writeTranscript(projectDir, "sess-fp", TAIL);
    const turns = readTranscriptTurns(path, 200);
    // 72.4 §3.3 changed one thing on purpose: a notice (here the task notification) renders as its label, never as the
    // raw record. Every other row — the assistant rows file paths are read from included — renders as before.
    const viaTurns = turns.filter(t => t.kind !== "notice").map(t => ({ role: t.role, content: t.rendered }));
    const raw = readTranscript(path, 200).filter(m => !m.content.includes("<task-notification>"));
    expect(viaTurns).toEqual(raw as any);
    expect(viaTurns.some(m => m.content.includes('[tool_use name="Write" id="toolu_1"]'))).toBe(true);
    expect(turns.filter(t => t.kind === "notice").map(t => t.rendered)).toEqual(["[background task completed] background job finished CANARY-TASK"]);
  });
});
