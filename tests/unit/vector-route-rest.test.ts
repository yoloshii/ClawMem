/**
 * BACKLOG 82.2, D4 — the REST rows of the route table (`POST /search`, `POST /retrieve`): `hybrid` and
 * `rest-semantic`. A query vector the endpoint answered with a malformed vector does not fail the request and is
 * never answered silently: the lexical side answers and the reply says `vector-fault`. Stored vectors the scan
 * skipped are counted in the same structure (operator ruling 24 A: `degraded` + `degradedLegs`, the names MCP uses,
 * present only when something was degraded). Dimension and model errors keep failing the request.
 * On v0.43.6 a refused query vector is a 500 (`rethrowIfFatalVectorError`) and no reply has a degraded field.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "fs";
import { createStore, VecReadModelMismatchError, type SearchResult, type Store } from "../../src/store.ts";
import { VecPoisonError, EmbedEnvelopeError } from "../../src/vector-guard.ts";
import { hashContent } from "../../src/indexer.ts";
import { startServer } from "../../src/server.ts";

import { seedContent } from "../helpers/seed-content.ts";
const TOKEN = "rest-route-test-token-82-2-000000000000000000";
const DB = `/tmp/clawmem-route-rest-${process.pid}.sqlite`;
const PORT = 17461;
let store: Store;
let server: ReturnType<typeof startServer>;
let vecHit: SearchResult;

const post = async (path: string, body: object) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> & { results?: { path: string }[] } };
};
type Vec = Store["searchVecWithFaults"];
const vector = (impl: Vec) => { store.searchVecWithFaults = impl; };
const poison = () => new VecPoisonError("non-finite", "endpoint", { context: "query" }, { elementIndex: 0 });
const QUERY = "JWT authentication decision";

beforeAll(() => {
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(DB + s); } catch { /* none */ } }
  store = createStore(DB);
  const now = new Date().toISOString();
  const seed = (path: string, title: string, body: string) => {
    const hash = hashContent(body);
    seedContent(store.db, hash, body, now);
    store.insertDocument("test", path, title, hash, now, now);
    return hash;
  };
  seed("decisions/auth.md", "Auth Decision", "# Auth Decision\n\nWe chose JWT for authentication.");
  const vecHash = seed("notes/tokens.md", "Token Notes", "# Token Notes\n\nSession tokens rotate daily.");
  vecHit = {
    filepath: "clawmem://test/notes/tokens.md", displayPath: "test/notes/tokens.md", title: "Token Notes", hash: vecHash,
    docid: vecHash.slice(0, 6), collectionName: "test", modifiedAt: now, bodyLength: 40, body: "# Token Notes\n\nSession tokens rotate daily.",
    context: null, score: 0.9, source: "vec",
  } as SearchResult;
  server = startServer(store, PORT, "127.0.0.1", { token: TOKEN });
});

afterAll(() => {
  server.stop();
  store.close();
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(DB + s); } catch { /* none */ } }
});

for (const path of ["/search", "/retrieve"]) {
  describe(`POST ${path}`, () => {
    test("hybrid, healthy: both sides answer and the reply has no degraded field", async () => {
      vector(async () => ({ results: [vecHit], vectorFaults: 0 }));
      const { status, json } = await post(path, { query: QUERY, mode: "hybrid" });
      expect(status).toBe(200);
      expect(json.results!.map(r => r.path).sort()).toEqual(["test/decisions/auth.md", "test/notes/tokens.md"]);
      expect("degraded" in json).toBe(false);
      expect("degradedLegs" in json).toBe(false);
    });

    test("hybrid, stored vectors skipped: the results stand and the count is in the reply", async () => {
      vector(async () => ({ results: [vecHit], vectorFaults: 2, firstFault: "x_0" }));
      const { status, json } = await post(path, { query: QUERY, mode: "hybrid" });
      expect(status).toBe(200);
      expect(json.results!.length).toBe(2);
      expect(json.degraded).toBe(true);
      expect(json.degradedLegs).toEqual([{ leg: "vector", reason: "vector-fault", vectorFaults: 2 }]);
    });

    for (const [label, thrown] of [["a malformed vector", poison], ["a malformed envelope", () => new EmbedEnvelopeError("data is not an array", { context: "query" })]] as const) {
      test(`hybrid, the query vector is refused (${label}): the lexical side answers, marked vector-fault`, async () => {
        vector(async () => { throw thrown(); });
        const { status, json } = await post(path, { query: QUERY, mode: "hybrid" });
        expect(status).toBe(200);
        expect(json.results!.map(r => r.path)).toEqual(["test/decisions/auth.md"]);
        expect(json.degraded).toBe(true);
        expect(json.degradedLegs).toEqual([{ leg: "vector", reason: "vector-fault" }]);
      });

      test(`semantic, the query vector is refused (${label}): the lexical fallback answers, marked vector-fault`, async () => {
        vector(async () => { throw thrown(); });
        const { status, json } = await post(path, { query: QUERY, mode: "semantic" });
        expect(status).toBe(200);
        expect(json.results!.map(r => r.path)).toEqual(["test/decisions/auth.md"]);
        expect(json.degradedLegs).toEqual([{ leg: "vector", reason: "vector-fault" }]);
      });
    }

    test("semantic, stored vectors skipped: the vector results stand, with the count", async () => {
      vector(async () => ({ results: [vecHit], vectorFaults: 1, firstFault: "x_0" }));
      const { status, json } = await post(path, { query: QUERY, mode: "semantic" });
      expect(status).toBe(200);
      expect(json.results!.map(r => r.path)).toEqual(["test/notes/tokens.md"]);
      expect(json.degradedLegs).toEqual([{ leg: "vector", reason: "vector-fault", vectorFaults: 1 }]);
    });

    test("a model mismatch still fails the request in both modes (not a vector-fault)", async () => {
      vector(async () => { throw new VecReadModelMismatchError(["old"], "new"); });
      for (const mode of ["hybrid", "semantic"]) {
        const { status, json } = await post(path, { query: QUERY, mode });
        expect(status).not.toBe(200);
        expect("degradedLegs" in json).toBe(false);
      }
    });

    test("an endpoint that is down is not a vector-fault: lexical answers, no degraded field (as before)", async () => {
      vector(async () => { throw new Error("connect ECONNREFUSED"); });
      const { status, json } = await post(path, { query: QUERY, mode: "hybrid" });
      expect(status).toBe(200);
      expect(json.results!.map(r => r.path)).toEqual(["test/decisions/auth.md"]);
      expect("degraded" in json).toBe(false);
    });
  });
}
