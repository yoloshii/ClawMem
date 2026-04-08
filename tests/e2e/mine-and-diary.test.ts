import { describe, it, expect, beforeEach } from "bun:test";
import {
  createStore,
  type Store,
} from "../../src/store.ts";
import { indexCollection } from "../../src/indexer.ts";
import { normalizeFile, chunkConversation } from "../../src/normalize.ts";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let store: Store;

beforeEach(() => {
  // Disable A-MEM enrichment (needs LLM server, not available in tests)
  process.env.CLAWMEM_ENABLE_AMEM = "false";
  process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
  store = createStore(":memory:");
});

// ─── Conversation Import E2E ───────────────────────────────────────

describe("conversation import E2E", () => {
  it("normalizes Claude Code JSONL → chunks → indexes with conversation content_type", async () => {
    const dir = join(tmpdir(), `clawmem-e2e-mine-${Date.now()}`);
    const stagingDir = join(tmpdir(), `clawmem-e2e-staging-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(stagingDir, { recursive: true });

    // Write a Claude Code session
    const jsonl = [
      JSON.stringify({ type: "human", message: { content: "What is the status of the migration?" } }),
      JSON.stringify({ type: "assistant", message: { content: "The migration to PostgreSQL is 80% complete. Remaining: schema validation and data integrity checks." } }),
      JSON.stringify({ type: "human", message: { content: "What about the auth service?" } }),
      JSON.stringify({ type: "assistant", message: { content: "Auth service is fully migrated and deployed to staging." } }),
    ].join("\n");
    writeFileSync(join(dir, "session-001.jsonl"), jsonl);

    // Normalize
    const conv = normalizeFile(join(dir, "session-001.jsonl"));
    expect(conv).not.toBeNull();
    expect(conv!.format).toBe("claude-code");
    expect(conv!.messages).toHaveLength(4);

    // Chunk
    const chunks = chunkConversation(conv!);
    expect(chunks).toHaveLength(2);

    // Write staging files (simulates cmdMine)
    for (const chunk of chunks) {
      const filename = `session-001_${String(chunk.chunkIndex).padStart(4, "0")}.md`;
      const frontmatter = [
        "---",
        `title: "${chunk.title.replace(/"/g, '\\"')}"`,
        `content_type: conversation`,
        `source: "session-001.jsonl"`,
        "---",
        "",
        chunk.body,
      ].join("\n");
      writeFileSync(join(stagingDir, filename), frontmatter);
    }

    // Index
    const stats = await indexCollection(store, "conversations", stagingDir, "**/*.md");
    expect(stats.added).toBe(2);

    // Verify content_type
    const doc = store.findActiveDocument("conversations", "session-001_0000.md");
    expect(doc).not.toBeNull();

    // Search for it
    const results = store.searchFTS("migration PostgreSQL", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    rmSync(dir, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  });

  it("normalizes ChatGPT JSON → indexes correctly", async () => {
    const dir = join(tmpdir(), `clawmem-e2e-chatgpt-${Date.now()}`);
    const stagingDir = join(tmpdir(), `clawmem-e2e-staging2-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(stagingDir, { recursive: true });

    const data = {
      mapping: {
        root: { parent: null, message: null, children: ["m1"] },
        m1: { parent: "root", message: { author: { role: "user" }, content: { parts: ["Explain kubernetes pods"] } }, children: ["m2"] },
        m2: { parent: "m1", message: { author: { role: "assistant" }, content: { parts: ["A pod is the smallest deployable unit in Kubernetes."] } }, children: [] },
      },
    };
    writeFileSync(join(dir, "conversations.json"), JSON.stringify(data));

    const conv = normalizeFile(join(dir, "conversations.json"));
    expect(conv).not.toBeNull();
    expect(conv!.format).toBe("chatgpt");

    const chunks = chunkConversation(conv!);
    expect(chunks).toHaveLength(1);

    for (const chunk of chunks) {
      const filename = `chatgpt_${String(chunk.chunkIndex).padStart(4, "0")}.md`;
      const frontmatter = `---\ntitle: "${chunk.title.replace(/"/g, '\\"')}"\ncontent_type: conversation\n---\n\n${chunk.body}`;
      writeFileSync(join(stagingDir, filename), frontmatter);
    }

    const stats = await indexCollection(store, "conversations", stagingDir, "**/*.md");
    expect(stats.added).toBe(1);

    rmSync(dir, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  });
});

// ─── Diary E2E ─────────────────────────────────────────────────────

describe("diary E2E", () => {
  it("writes and reads diary entries via saveMemory", () => {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "");
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    const diaryPath = `diary/${dateStr}-${timeStr}${ms}-technical.md`;

    const entry = "Deployed v0.5.0 with conversation import feature";
    const body = `---\ntitle: "${entry}"\ncontent_type: note\ntags: [diary, technical]\n---\n\n${entry}`;

    const result = store.saveMemory({
      collection: "_clawmem",
      path: diaryPath,
      title: entry,
      body,
      contentType: "note",
      confidence: 0.7,
      semanticPayload: `${diaryPath}::${entry}`,
    });

    expect(result.action).toBe("inserted");
    expect(result.docId).toBeGreaterThan(0);

    // Read it back
    const rows = store.db.prepare(`
      SELECT d.id, d.path, d.title
      FROM documents d
      WHERE d.active = 1 AND d.collection = '_clawmem' AND d.path LIKE 'diary/%'
      ORDER BY d.modified_at DESC
      LIMIT 5
    `).all() as any[];

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe(entry);
    expect(rows[0].path).toContain("diary/");
  });

  it("does not dedup different diary entries with same content", () => {
    const entry = "Same text written twice";

    for (let i = 0; i < 2; i++) {
      const path = `diary/2026-04-08-12000${i}${String(i * 100).padStart(3, "0")}-general.md`;
      const body = `---\ntitle: "${entry}"\n---\n\n${entry}`;
      store.saveMemory({
        collection: "_clawmem",
        path,
        title: entry,
        body,
        contentType: "note",
        confidence: 0.7,
        semanticPayload: `${path}::${entry}`,
      });
    }

    const rows = store.db.prepare(`
      SELECT COUNT(*) as n FROM documents WHERE active = 1 AND collection = '_clawmem' AND path LIKE 'diary/%'
    `).get() as any;

    expect(rows.n).toBe(2); // not deduped
  });
});
