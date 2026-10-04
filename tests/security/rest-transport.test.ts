/**
 * OKF-8 — the REST server's transport defence against browser-borne attacks (BACKLOG 62.4, CM-56).
 *
 * Every test names what it does on v0.41.5: FAILS there for the reason it names (the server was open, parsed any
 * Content-Type as JSON, answered every preflight with `*`, and checked no Origin or Host), is a control that holds on
 * both, or is "new" — it needs the token option or the token file, which v0.41.5 lacks. Each server is a real `Bun.serve` on an ephemeral port with its own config directory; the token file lives
 * there, never in the user's configuration.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { connect } from "node:net";
import { createStore, type Store } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";
import { startServer } from "../../src/server.ts";

type Srv = ReturnType<typeof startServer>;
const newToken = () => randomBytes(32).toString("base64url");
const TOKEN = newToken();

let root: string;
let store: Store;
const servers: Srv[] = [];
const savedEnv = { token: process.env.CLAWMEM_API_TOKEN, dir: process.env.CLAWMEM_CONFIG_DIR };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "clawmem-sec-"));
  store = createStore(join(root, "vault.sqlite"));
});

afterAll(() => {
  for (const s of servers) s.stop(true);
  store.close();
  if (savedEnv.token === undefined) delete process.env.CLAWMEM_API_TOKEN; else process.env.CLAWMEM_API_TOKEN = savedEnv.token;
  process.env.CLAWMEM_CONFIG_DIR = savedEnv.dir;
  rmSync(root, { recursive: true, force: true });
});

/** A server with an explicit token (the default for these tests) or, with `opts` given, exactly those options. */
function serve(opts: Record<string, unknown> = { token: TOKEN }, host = "127.0.0.1"): Srv {
  const s = (startServer as (...a: unknown[]) => Srv)(store, 0, host, opts);
  servers.push(s);
  return s;
}

/** A server started the default way — no token option — under a fresh config directory (the token file's home). */
function serveDefault(env: { token?: string } = {}): { s: Srv; dir: string } {
  const dir = mkdtempSync(join(root, "cfg-"));
  process.env.CLAWMEM_CONFIG_DIR = dir;
  if (env.token === undefined) delete process.env.CLAWMEM_API_TOKEN; else process.env.CLAWMEM_API_TOKEN = env.token;
  try {
    const s = (startServer as (...a: unknown[]) => Srv)(store, 0, "127.0.0.1");
    servers.push(s);
    return { s, dir };
  } finally {
    delete process.env.CLAWMEM_API_TOKEN;
    process.env.CLAWMEM_CONFIG_DIR = savedEnv.dir;
  }
}

let seq = 0;
function seedDoc(opts: { modified?: string } = {}): { id: number; docid: string } {
  const body = `# Doc ${++seq}\n\nbody ${seq} ${randomBytes(4).toString("hex")}`;
  const hash = hashContent(body);
  const when = opts.modified ?? new Date().toISOString();
  store.insertContent(hash, body, when);
  store.insertDocument("sec", `doc-${seq}.md`, `Doc ${seq}`, hash, when, when);
  const row = store.db.prepare("SELECT id FROM documents WHERE collection = 'sec' AND path = ?").get(`doc-${seq}.md`) as { id: number };
  return { id: row.id, docid: hash.slice(0, 6) };
}
const isActive = (id: number) => (store.db.prepare("SELECT active FROM documents WHERE id = ?").get(id) as { active: number }).active === 1;
const isPinned = (id: number) => (store.db.prepare("SELECT pinned FROM documents WHERE id = ?").get(id) as { pinned: number }).pinned === 1;
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

async function call(s: Srv, method: string, path: string, o: { headers?: Record<string, string>; body?: string; token?: string | null } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  const tok = o.token === undefined ? TOKEN : o.token;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  return fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers, body: o.body });
}
const JSON_CT = { "Content-Type": "application/json" };

/** A raw HTTP exchange, for what `fetch` cannot send (duplicate headers, no Host). Returns the status code. */
function raw(s: Srv, text: string): Promise<number> {
  return new Promise((resolve) => {
    const sock = connect(s.port!, "127.0.0.1", () => sock.write(text));
    let buf = "";
    sock.on("data", (d) => { buf += d; });
    const done = () => resolve(Number(buf.split(" ")[1] ?? "0"));
    sock.on("end", done);
    sock.on("error", done);
    setTimeout(() => { sock.destroy(); done(); }, 3000);
  });
}

describe("L4 — JSON bodies only", () => {
  test("S1: a text/plain sweep (a simple request) is refused before it archives anything", async () => {
    const s = serve();
    const doc = seedDoc({ modified: daysAgo(400) });
    const res = await call(s, "POST", "/lifecycle/sweep", { headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ dry_run: false }) });
    expect(res.status).toBe(415);
    expect(isActive(doc.id)).toBe(true);
  });

  test("S2: form and multipart restores are refused and restore nothing", async () => {
    const s = serve();
    const doc = seedDoc({ modified: daysAgo(400) });
    store.archiveDocuments([doc.id]);
    expect(isActive(doc.id)).toBe(false);
    const form = await call(s, "POST", "/lifecycle/restore", { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=b" });
    expect(form.status).toBe(415);
    const fd = new FormData(); fd.set("a", "b");
    const multi = await fetch(`http://127.0.0.1:${s.port}/lifecycle/restore`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: fd });
    expect(multi.status).toBe(415);
    expect(isActive(doc.id)).toBe(false);
  });

  test("S3: a bodyless forget with no Content-Type is refused", async () => {
    const s = serve();
    const doc = seedDoc();
    const res = await call(s, "POST", `/documents/${doc.docid}/forget`);
    expect(res.status).toBe(415);
    expect(isActive(doc.id)).toBe(true);
  });

  test("control: a JSON POST with parameters in its media type passes", async () => {
    const s = serve();
    const res = await call(s, "POST", "/search", { headers: { "Content-Type": "Application/JSON; charset=utf-8" }, body: JSON.stringify({ query: "doc", mode: "keyword" }) });
    expect(res.status).toBe(200);
  });
});

describe("L1 — Origin", () => {
  test("S4: a JSON pin from a foreign Origin is refused, whatever the token", async () => {
    const s = serve();
    const doc = seedDoc();
    const res = await call(s, "POST", `/documents/${doc.docid}/pin`, { headers: { ...JSON_CT, Origin: "https://evil.example" }, body: "{}" });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(isPinned(doc.id)).toBe(false);
  });

  test("S11: null, 0.0.0.0, foreign and credentialed Origins are refused", async () => {
    const s = serve();
    for (const origin of ["null", `http://0.0.0.0:${s.port}`, "https://evil.example", `http://user@localhost:${s.port}`, "http://localhost:7438/path"]) {
      const res = await call(s, "GET", "/health", { headers: { Origin: origin } });
      expect({ origin, status: res.status }).toEqual({ origin, status: 403 });
    }
  });

  test("S12 (control): loopback Origins in every spelling pass", async () => {
    const s = serve();
    for (const origin of [`http://localhost:${s.port}`, "http://localhost:5173", `http://127.0.0.2:${s.port}`, `http://[::1]:${s.port}`, `http://[::ffff:127.0.0.1]:${s.port}`, "http://app.localhost:3000"]) {
      const res = await call(s, "GET", "/health", { headers: { Origin: origin } });
      expect({ origin, status: res.status }).toEqual({ origin, status: 200 });
    }
  });

  test("an allowlisted non-loopback Origin passes; another does not", async () => {
    const s = serve({ token: TOKEN, allowedOrigins: ["https://dash.example"] });
    expect((await call(s, "GET", "/health", { headers: { Origin: "https://dash.example" } })).status).toBe(200);
    expect((await call(s, "GET", "/health", { headers: { Origin: "https://dash.example:8443" } })).status).toBe(403);
  });
});

describe("L2 — CORS", () => {
  test("S5: a preflight from a foreign Origin is refused, with no CORS grant", async () => {
    const s = serve();
    const res = await call(s, "OPTIONS", "/search", { token: null, headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("S6: a preflight from a loopback Origin is answered with exactly that origin", async () => {
    const s = serve();
    const res = await call(s, "OPTIONS", "/search", { token: null, headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("vary")).toContain("Origin");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  test("S15: responses carry the request's own allowed origin, and nothing without an Origin", async () => {
    const s = serve();
    const withOrigin = await call(s, "GET", "/health", { headers: { Origin: "http://LOCALHOST:5173" } });
    expect(withOrigin.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(withOrigin.headers.get("vary")).toContain("Origin");
    const without = await call(s, "GET", "/health");
    expect(without.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("S20: a loopback Origin's Authorization preflight is granted, and the request still needs the token", async () => {
    const s = serve();
    const pre = await call(s, "OPTIONS", "/export", { token: null, headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } });
    expect(pre.status).toBe(204);
    const res = await call(s, "GET", "/export", { token: newToken(), headers: { Origin: "http://localhost:5173" } });
    expect(res.status).toBe(401);
  });
});

describe("L1 — Host", () => {
  test("S7: a rebound read (foreign Host, no Origin) is refused on a loopback bind, whatever the token", async () => {
    const s = serve();
    const res = await call(s, "GET", "/export", { headers: { Host: `attacker.example:${s.port}` } });
    expect(res.status).toBe(403);
  });

  test("S13: malformed and foreign Hosts are refused; a duplicated Host too", async () => {
    const s = serve();
    for (const host of [`attacker.example:${s.port}`, `user@127.0.0.1:${s.port}`, `127.0.0.1:${s.port}/x`, `127.0.0.999:${s.port}`, `127.0.0.1:99999`, ""]) {
      const res = await call(s, "GET", "/health", { headers: { Host: host } });
      expect({ host, status: res.status }).toEqual({ host, status: 403 });
    }
    const dup = await raw(s, `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nHost: attacker.example:${s.port}\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`);
    expect([400, 403]).toContain(dup);
  });

  // The spellings are controls. The request with no Host FAILS on v0.41.5: its request URL is relative, and the
  // handler's `new URL(req.url)` threw (500).
  test("S14: loopback Hosts in every spelling pass, and a request with no Host", async () => {
    const s = serve();
    for (const host of [`localhost:${s.port}`, `[::1]:${s.port}`, `127.0.0.2:${s.port}`, `127.1:${s.port}`, `[::ffff:7f00:1]:${s.port}`, "LOCALHOST"]) {
      const res = await call(s, "GET", "/health", { headers: { Host: host } });
      expect({ host, status: res.status }).toEqual({ host, status: 200 });
    }
    const noHost = await raw(s, `GET /health HTTP/1.0\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
    expect(noHost).toBe(200);
  });

  test("S18: a wildcard bind with a Host allowlist matches the name on any valid port", async () => {
    const s = serve({ token: TOKEN, allowedHosts: ["proxy.example"] }, "0.0.0.0");
    for (const [host, want] of [["proxy.example", 200], ["proxy.example:80", 200], ["proxy.example:080", 200], [`proxy.example:${s.port}`, 200], ["other.example:80", 403], ["proxy.example:99999", 403]] as const) {
      const res = await call(s, "GET", "/health", { headers: { Host: host } });
      expect({ host, status: res.status }).toEqual({ host, status: want });
    }
  });

  test("S19: a wildcard bind with no allowlist rests on the token alone, and says so at start", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const started = (() => {
      try {
        const srv = serve({ token: TOKEN }, "0.0.0.0");
        return { srv, warnings: warn.mock.calls.map(c => String(c[0])) };
      } finally { warn.mockRestore(); }
    })();
    const s = started.srv;
    expect(started.warnings.filter(m => m.includes("Host check off") && m.includes("CLAWMEM_ALLOWED_HOSTS")).length).toBe(1);
    expect((await call(s, "GET", "/export", { token: newToken(), headers: { Host: `attacker.example:${s.port}` } })).status).toBe(401);
    expect((await call(s, "GET", "/export", { headers: { Host: `attacker.example:${s.port}` } })).status).toBe(200);
  });
});

const ROUTES: [string, string, string?][] = [
  ["GET", "/health"], ["GET", "/stats"], ["POST", "/search", '{"query":"doc","mode":"keyword"}'],
  ["POST", "/retrieve", '{"query":"doc","mode":"keyword"}'], ["GET", "/documents?pattern=*"], ["GET", "/documents/abc123"],
  ["GET", "/timeline/abc123"], ["GET", "/sessions"], ["GET", "/collections"], ["GET", "/profile"],
  ["GET", "/graph/causal/abc123"], ["GET", "/graph/similar/abc123"], ["GET", "/graph/evolution/abc123"],
  ["GET", "/lifecycle/status"], ["POST", "/lifecycle/sweep", '{"dry_run":true}'], ["POST", "/lifecycle/restore", '{"collection":"__none__"}'],
  ["POST", "/documents/abc123/pin", "{}"], ["POST", "/documents/abc123/snooze", "{}"], ["POST", "/documents/abc123/forget", "{}"],
  ["POST", "/reindex", '{"collection":"__none__"}'], ["POST", "/graphs/build", '{"temporal":false,"semantic":false}'], ["GET", "/export"],
];

describe("L3 — a token by default", () => {
  test("S8: a default start answers every route, /health included, with 401 when no token is sent", async () => {
    const { s } = serveDefault();
    for (const [method, path, body] of ROUTES) {
      const res = await call(s, method, path, { token: null, headers: body ? JSON_CT : {}, body });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
      if (res.status === 401) expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
  });

  test("S9 (new): with the file's token every read route and the two searches reach their handlers", async () => {
    const { s, dir } = serveDefault();
    const fileToken = readFileSync(join(dir, "serve-token"), "utf-8").trim();
    for (const [method, path, body] of ROUTES.filter(([m, p]) => m === "GET" || p === "/search" || p === "/retrieve")) {
      const res = await call(s, method, path, { token: fileToken, headers: body ? JSON_CT : {}, body });
      expect({ method, path, rejected: [401, 403, 415].includes(res.status) }).toEqual({ method, path, rejected: false });
    }
  });

  test("S10: an env token replaces the file's; an empty env token means the file, never open", async () => {
    const envToken = newToken();
    const { s, dir } = serveDefault({ token: envToken });
    expect((await call(s, "GET", "/health", { token: envToken })).status).toBe(200);
    expect(existsSync(join(dir, "serve-token"))).toBe(false);
    expect((await call(s, "GET", "/health", { token: newToken() })).status).toBe(401);

    const empty = serveDefault({ token: "" });
    const fileToken = readFileSync(join(empty.dir, "serve-token"), "utf-8").trim();
    expect((await call(empty.s, "GET", "/health", { token: fileToken })).status).toBe(200);
    expect((await call(empty.s, "GET", "/health", { token: newToken() })).status).toBe(401);
  });

  test("S16 (new): a wrong token of equal length, a prefix and a suffix are refused", async () => {
    const s = serve();
    for (const bad of [newToken(), TOKEN.slice(0, 20), TOKEN.slice(10), `${TOKEN}x`]) {
      expect((await call(s, "GET", "/health", { token: bad })).status).toBe(401);
    }
    expect((await call(s, "GET", "/health")).status).toBe(200);
  });

  test("S17: rotation — two servers share the file; after both restart on a new file the old token is refused by both", async () => {
    const dir = mkdtempSync(join(root, "cfg-rot-"));
    const start = () => (startServer as (...a: unknown[]) => Srv)(store, 0, "127.0.0.1", { configDir: dir });
    let a = start(), b = start();
    const oldToken = readFileSync(join(dir, "serve-token"), "utf-8").trim();
    expect((await call(a, "GET", "/health", { token: oldToken })).status).toBe(200);
    expect((await call(b, "GET", "/health", { token: oldToken })).status).toBe(200);
    a.stop(true); b.stop(true);
    unlinkSync(join(dir, "serve-token"));
    a = start(); b = start(); servers.push(a, b);
    const newer = readFileSync(join(dir, "serve-token"), "utf-8").trim();
    expect(newer).not.toBe(oldToken);
    for (const s of [a, b]) {
      expect((await call(s, "GET", "/health", { token: oldToken })).status).toBe(401);
      expect((await call(s, "GET", "/health", { token: newer })).status).toBe(200);
    }
  });
});
