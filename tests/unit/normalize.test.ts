import { describe, it, expect } from "bun:test";
import { normalizeFile, chunkConversation, scanConversationDir, type NormalizedConversation } from "../../src/normalize.ts";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TMP = join(tmpdir(), `clawmem-normalize-test-${Date.now()}`);

function setup() {
  mkdirSync(TMP, { recursive: true });
}

function cleanup() {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}

function writeTemp(name: string, content: string): string {
  const p = join(TMP, name);
  writeFileSync(p, content);
  return p;
}

// ─── Claude Code JSONL ─────────────────────────────────────────────

describe("Claude Code JSONL", () => {
  it("normalizes basic conversation", () => {
    setup();
    const jsonl = [
      JSON.stringify({ type: "human", message: { content: "What is ClawMem?" } }),
      JSON.stringify({ type: "assistant", message: { content: "ClawMem is a memory system." } }),
      JSON.stringify({ type: "human", message: { content: "How does it work?" } }),
      JSON.stringify({ type: "assistant", message: { content: "It uses SQLite and vector search." } }),
    ].join("\n");

    const file = writeTemp("session.jsonl", jsonl);
    const result = normalizeFile(file);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("claude-code");
    expect(result!.messages).toHaveLength(4);
    expect(result!.messages[0].role).toBe("user");
    expect(result!.messages[1].role).toBe("assistant");
    cleanup();
  });

  it("handles content as array of blocks", () => {
    setup();
    const jsonl = [
      JSON.stringify({ type: "human", message: { content: [{ type: "text", text: "Hello" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hi there" }] } }),
    ].join("\n");

    const file = writeTemp("blocks.jsonl", jsonl);
    const result = normalizeFile(file);
    expect(result).not.toBeNull();
    expect(result!.messages[0].content).toBe("Hello");
    cleanup();
  });

  it("rejects single-message files", () => {
    setup();
    const jsonl = JSON.stringify({ type: "human", message: { content: "solo" } });
    const file = writeTemp("solo.jsonl", jsonl);
    expect(normalizeFile(file)).toBeNull();
    cleanup();
  });
});

// ─── Codex CLI JSONL ───────────────────────────────────────────────

describe("Codex CLI JSONL", () => {
  it("normalizes with session_meta + event_msg", () => {
    setup();
    const jsonl = [
      JSON.stringify({ type: "session_meta", payload: {} }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Fix the bug" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Done, fixed in store.ts" } }),
    ].join("\n");

    const file = writeTemp("codex.jsonl", jsonl);
    const result = normalizeFile(file);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("codex-cli");
    expect(result!.messages).toHaveLength(2);
    cleanup();
  });

  it("rejects without session_meta", () => {
    setup();
    const jsonl = [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Hello" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Hi" } }),
    ].join("\n");

    const file = writeTemp("no-meta.jsonl", jsonl);
    // Without session_meta, should not match codex format
    const result = normalizeFile(file);
    // May fall through to other parsers or return null
    if (result) expect(result.format).not.toBe("codex-cli");
    cleanup();
  });
});

// ─── ChatGPT JSON ──────────────────────────────────────────────────

describe("ChatGPT JSON", () => {
  it("normalizes mapping tree format", () => {
    setup();
    const data = {
      mapping: {
        root: { parent: null, message: null, children: ["msg1"] },
        msg1: { parent: "root", message: { author: { role: "user" }, content: { parts: ["What is AI?"] } }, children: ["msg2"] },
        msg2: { parent: "msg1", message: { author: { role: "assistant" }, content: { parts: ["AI is artificial intelligence."] } }, children: [] },
      },
    };

    const file = writeTemp("chatgpt.json", JSON.stringify(data));
    const result = normalizeFile(file);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("chatgpt");
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0].content).toBe("What is AI?");
    cleanup();
  });
});

// ─── Claude.ai JSON ────────────────────────────────────────────────

describe("Claude.ai JSON", () => {
  it("normalizes flat messages list", () => {
    setup();
    const data = {
      messages: [
        { role: "user", content: "Explain quantum computing" },
        { role: "assistant", content: "Quantum computing uses qubits." },
      ],
    };

    const file = writeTemp("claude-ai.json", JSON.stringify(data));
    const result = normalizeFile(file);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("claude-ai");
    expect(result!.messages).toHaveLength(2);
    cleanup();
  });

  it("normalizes privacy export format", () => {
    setup();
    const data = [
      {
        chat_messages: [
          { role: "human", content: "Hello" },
          { role: "assistant", content: "Hi there" },
        ],
      },
    ];

    const file = writeTemp("privacy.json", JSON.stringify(data));
    const result = normalizeFile(file);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("claude-ai");
    cleanup();
  });
});

// ─── Slack JSON ────────────────────────────────────────────────────

describe("Slack JSON", () => {
  it("normalizes 2-party DM", () => {
    setup();
    const data = [
      { type: "message", user: "U001", text: "Hey, did you review the PR?" },
      { type: "message", user: "U002", text: "Yes, looks good." },
      { type: "message", user: "U001", text: "Great, merging." },
      { type: "message", user: "U002", text: "Sounds good." },
    ];

    const file = writeTemp("slack-dm.json", JSON.stringify(data));
    const result = normalizeFile(file);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("slack");
    expect(result!.messages).toHaveLength(4);
    cleanup();
  });

  it("rejects multi-person channels (>2 speakers)", () => {
    setup();
    const data = [
      { type: "message", user: "U001", text: "Meeting at 3?" },
      { type: "message", user: "U002", text: "Works for me" },
      { type: "message", user: "U003", text: "Same here" },
    ];

    const file = writeTemp("slack-channel.json", JSON.stringify(data));
    expect(normalizeFile(file)).toBeNull();
    cleanup();
  });
});

// ─── Plain Text ────────────────────────────────────────────────────

describe("Plain text", () => {
  it("normalizes User:/Assistant: format", () => {
    setup();
    const content = `User: What is the capital of France?
Assistant: Paris is the capital of France.
User: And Germany?
Assistant: Berlin is the capital of Germany.`;

    const file = writeTemp("plain.txt", content);
    const result = normalizeFile(file);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("plain-text");
    expect(result!.messages).toHaveLength(4);
    cleanup();
  });

  it("does not false-positive on markdown with blockquotes", () => {
    setup();
    const content = `# Notes
> This is a quote
> Another quote
> Third quote
Some regular text.`;

    const file = writeTemp("notes.md", content);
    expect(normalizeFile(file)).toBeNull();
    cleanup();
  });

  it("requires both user and assistant roles", () => {
    setup();
    const content = `User: question 1
User: question 2
User: question 3
User: question 4`;

    const file = writeTemp("users-only.txt", content);
    expect(normalizeFile(file)).toBeNull();
    cleanup();
  });
});

// ─── Chunking ──────────────────────────────────────────────────────

describe("chunkConversation", () => {
  it("groups user+assistant into exchange pairs", () => {
    const conv: NormalizedConversation = {
      source: "test.jsonl",
      format: "claude-code",
      messages: [
        { role: "user", content: "Question 1" },
        { role: "assistant", content: "Answer 1" },
        { role: "user", content: "Question 2" },
        { role: "assistant", content: "Answer 2" },
      ],
    };

    const chunks = chunkConversation(conv);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].body).toContain("Question 1");
    expect(chunks[0].body).toContain("Answer 1");
    expect(chunks[1].body).toContain("Question 2");
  });

  it("collects consecutive assistant messages", () => {
    const conv: NormalizedConversation = {
      source: "test.jsonl",
      format: "claude-code",
      messages: [
        { role: "user", content: "Tell me about X" },
        { role: "assistant", content: "Part 1 of answer" },
        { role: "assistant", content: "Part 2 of answer" },
        { role: "assistant", content: "Part 3 of answer" },
      ],
    };

    const chunks = chunkConversation(conv);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].body).toContain("Part 1");
    expect(chunks[0].body).toContain("Part 2");
    expect(chunks[0].body).toContain("Part 3");
  });

  it("handles user-only messages gracefully", () => {
    const conv: NormalizedConversation = {
      source: "test.jsonl",
      format: "claude-code",
      messages: [
        { role: "user", content: "Question with no response" },
        { role: "user", content: "Another question" },
        { role: "assistant", content: "Late response" },
      ],
    };

    const chunks = chunkConversation(conv);
    // First user has no assistant, second user has assistant
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Directory Scanner ─────────────────────────────────────────────

describe("scanConversationDir", () => {
  it("finds conversation files", () => {
    setup();
    writeTemp("chat.json", "{}");
    writeTemp("session.jsonl", "{}");
    writeTemp("notes.txt", "hello");
    writeTemp("code.ts", "export {}"); // should be excluded

    const files = scanConversationDir(TMP);
    expect(files.length).toBe(3); // json, jsonl, txt — not ts
    cleanup();
  });

  it("skips .git and node_modules", () => {
    setup();
    mkdirSync(join(TMP, ".git"), { recursive: true });
    mkdirSync(join(TMP, "node_modules"), { recursive: true });
    writeFileSync(join(TMP, ".git", "config.json"), "{}");
    writeFileSync(join(TMP, "node_modules", "pkg.json"), "{}");
    writeTemp("real.json", "{}");

    const files = scanConversationDir(TMP);
    expect(files).toHaveLength(1);
    cleanup();
  });
});
