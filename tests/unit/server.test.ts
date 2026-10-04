/**
 * Tests for ClawMem HTTP REST API Server
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "fs";
import { createStore, type Store } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";
import { startServer } from "../../src/server.ts";

// The REST server needs a token on every request and a JSON Content-Type on every POST (BACKLOG 62.4).
const REST_TOKEN = "rest-test-token-62-4-0000000000000000000000";
const AUTH = { Authorization: `Bearer ${REST_TOKEN}` };
/** A request to the test server with the token. */
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) } });

let store: Store;
let server: ReturnType<typeof startServer>;
let authDocHash: string;
let handoffDocHash: string;
const TEST_DB = "/tmp/clawmem-server-test.sqlite";
const PORT = 17438;
const BASE = `http://127.0.0.1:${PORT}`;

beforeAll(() => {
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + "-wal"); } catch {}
  try { unlinkSync(TEST_DB + "-shm"); } catch {}
  process.env.INDEX_PATH = TEST_DB;
  delete process.env.CLAWMEM_API_TOKEN;
  store = createStore(TEST_DB);

  // Seed test data — use real SHA-256 hashes so docid lookup works (6-char hex prefix)
  const now = new Date().toISOString();
  const authBody = "# Auth Decision\n\nWe chose JWT for authentication.";
  authDocHash = hashContent(authBody);
  store.insertContent(authDocHash, authBody, now);
  store.insertDocument("test", "decisions/auth.md", "Auth Decision", authDocHash, now, now);
  store.updateDocumentMeta(1, { content_type: "decision", confidence: 0.9 });

  const handoffBody = "# Handoff 2026-03-14\n\nWorked on auth module.";
  handoffDocHash = hashContent(handoffBody);
  store.insertContent(handoffDocHash, handoffBody, now);
  store.insertDocument("test", "handoffs/2026-03-14.md", "Handoff", handoffDocHash, now, now);
  store.updateDocumentMeta(2, { content_type: "handoff", confidence: 0.6 });

  const apiBody = "# API Design Notes\n\nREST over GraphQL.";
  const apiHash = hashContent(apiBody);
  store.insertContent(apiHash, apiBody, now);
  store.insertDocument("test", "notes/api.md", "API Design", apiHash, now, now);

  server = startServer(store, PORT, "127.0.0.1", { token: REST_TOKEN });
});

afterAll(() => {
  server.stop();
  store.close();
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + "-wal"); } catch {}
  try { unlinkSync(TEST_DB + "-shm"); } catch {}
});

describe("GET /health", () => {
  test("returns ok status", async () => {
    const res = await api(`/health`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe("ok");
    expect(data.service).toBe("clawmem");
    expect(data.documents).toBe(3);
  });
});

describe("GET /stats", () => {
  test("returns document stats", async () => {
    const res = await api(`/stats`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.totalDocuments).toBe(3);
  });
});

describe("POST /search", () => {
  test("searches by keyword", async () => {
    const res = await api(`/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "authentication", mode: "keyword" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0].title).toContain("Auth");
  });

  test("returns error without query", async () => {
    const res = await api(`/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("compact mode returns snippets", async () => {
    const res = await api(`/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "JWT", compact: true }),
    });
    const data = await res.json() as any;
    if (data.results.length > 0) {
      expect(data.results[0]).toHaveProperty("snippet");
      expect(data.results[0]).not.toHaveProperty("body");
    }
  });
});

describe("GET /documents/:docid", () => {
  test("returns document by docid (6-char hash prefix)", async () => {
    const docid = authDocHash.slice(0, 6);
    const res = await api(`/documents/${docid}`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.title).toBe("Auth Decision");
    expect(data.body).toContain("JWT");
  });

  test("returns 404 for unknown docid", async () => {
    const res = await api(`/documents/zzzzzz`);
    expect(res.status).toBe(404);
  });
});

describe("GET /timeline/:docid", () => {
  test("returns timeline for document", async () => {
    const docid = handoffDocHash.slice(0, 6);
    const res = await api(`/timeline/${docid}`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.focus).toBeDefined();
    expect(data.before).toBeInstanceOf(Array);
    expect(data.after).toBeInstanceOf(Array);
  });
});

describe("GET /collections", () => {
  test("returns collection list", async () => {
    const res = await api(`/collections`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.count).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /lifecycle/status", () => {
  test("returns lifecycle stats", async () => {
    const res = await api(`/lifecycle/status`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.active).toBe(3);
  });
});

describe("POST /documents/:docid/pin", () => {
  test("pins a document", async () => {
    const docid = authDocHash.slice(0, 6);
    const res = await api(`/documents/${docid}/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.pinned).toBe(true);
  });
});

describe("404 handling", () => {
  test("returns 404 for unknown routes", async () => {
    const res = await api(`/nonexistent`);
    expect(res.status).toBe(404);
  });
});

describe("auth", () => {
  test("refuses a request without the token, or with another", async () => {
    expect((await fetch(`${BASE}/health`)).status).toBe(401);
    expect((await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${"x".repeat(43)}` } })).status).toBe(401);
    expect((await api(`/health`)).status).toBe(200);
  });
});

describe("GET /export", () => {
  test("exports all documents", async () => {
    const res = await api(`/export`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.version).toBe("1.0.0");
    expect(data.count).toBe(3);
    expect(data.documents.length).toBe(3);
  });
});
