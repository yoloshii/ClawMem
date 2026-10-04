/**
 * BACKLOG 62.4 — every REST client learns the token (DESIGN § 4). The Hermes plugin in external mode under both of its
 * HTTP paths (httpx and the urllib fallback) and in managed mode, where the launcher pins the token `clawmem serve-token`
 * prints into its child; the OpenClaw tools under their effective environment ({ ...process.env, ...cfg.env }) and with
 * a managed token; and neither client puts any part of a token into an error or a log line.
 *
 * On v0.41.5 the external cases pass (the server was open — controls); the managed cases fail (the plugin sent no token
 * to a `serve` that took one from the wrapper's .env); the leak cases fail (the header validators quote the value).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { createServer } from "node:net";
import { createStore, type Store } from "../../src/store.ts";
import { startServer } from "../../src/server.ts";
import { createTools } from "../../src/openclaw/tools.ts";
import { readServeTokenFile } from "../../src/openclaw/shell.ts";

const PYTHON = Bun.which("python3");
const PLUGIN = resolve(import.meta.dir, "../../src/hermes/__init__.py");
const LANE = resolve(import.meta.dir, "../..");
const newToken = () => randomBytes(32).toString("base64url");
type Srv = ReturnType<typeof startServer>;

let root: string;
let store: Store;
const servers: Srv[] = [];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "clawmem-clients-"));
  store = createStore(join(root, "vault.sqlite"));
});
afterAll(() => {
  for (const s of servers) s.stop(true);
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const fresh = (name: string) => mkdtempSync(join(root, `${name}-`));
function serve(opts: Record<string, unknown>): Srv {
  const s = (startServer as (...a: unknown[]) => Srv)(store, 0, "127.0.0.1", opts);
  servers.push(s);
  return s;
}
function freePort(): Promise<number> {
  return new Promise((res) => { const srv = createServer(); srv.listen(0, "127.0.0.1", () => { const p = (srv.address() as { port: number }).port; srv.close(() => res(p)); }); });
}
/** No eight-character run of `secret` appears in `text`. */
function holdsNoPartOf(text: string, secret: string): boolean {
  for (let i = 0; i + 8 <= secret.length; i += 2) if (text.includes(secret.slice(i, i + 8))) return false;
  return true;
}
/** A child environment with every ClawMem variable cleared, a scratch vault and config dir, and no local models. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CLAWMEM_") && k !== "INDEX_PATH") env[k] = v;
  return { ...env, INDEX_PATH: join(fresh("idx"), "vault.sqlite"), CLAWMEM_NO_LOCAL_MODELS: "true", PYTHONDONTWRITEBYTECODE: "1", ...extra };
}
/** A copy of bin/clawmem beside an .env file, running the lane's source — the wrapper boundary a managed launcher crosses. */
function fakeWrapper(dotenv: string): string {
  const dir = fresh("wrap");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "clawmem"), readFileSync(join(LANE, "bin", "clawmem")), { mode: 0o755 });
  for (const p of ["src", "node_modules", "package.json"]) symlinkSync(join(LANE, p), join(dir, p));
  writeFileSync(join(dir, ".env"), dotenv);
  return join(dir, "bin", "clawmem");
}

/**
 * Runs `script` against the Hermes plugin (an `agent.memory_provider` stub stands in for Hermes); returns its OUT dict.
 * Asynchronous on purpose: a synchronous spawn would block this process's event loop, and with it the in-process
 * server the script calls.
 */
async function hermes(script: string, env: Record<string, string>, opts: { urllib?: boolean } = {}): Promise<Record<string, any>> {
  const dir = fresh("py");
  mkdirSync(join(dir, "stub", "agent"), { recursive: true });
  writeFileSync(join(dir, "stub", "agent", "__init__.py"), "");
  writeFileSync(join(dir, "stub", "agent", "memory_provider.py"), "class MemoryProvider:\n    pass\n");
  const driver = join(dir, "driver.py");
  writeFileSync(driver, [
    "import importlib.util, io, json, logging, subprocess, sys",
    `sys.path.insert(0, ${JSON.stringify(join(dir, "stub"))})`,
    opts.urllib ? "sys.modules['httpx'] = None   # the plugin's zero-dependency path" : "import httpx",
    `spec = importlib.util.spec_from_file_location("clawmem_hermes", ${JSON.stringify(PLUGIN)})`,
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "LOG = io.StringIO(); h = logging.StreamHandler(LOG); h.setLevel(logging.DEBUG)",
    "logging.getLogger().addHandler(h); logging.getLogger().setLevel(logging.DEBUG)",
    "OUT = {}",
    script,
    "OUT['logs'] = LOG.getvalue()",
    "print(json.dumps(OUT, default=str))",
  ].join("\n"));
  const proc = Bun.spawn([PYTHON!, "-B", driver], { env, stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => proc.kill(), 60_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(killer);
  expect(code, out + err).toBe(0);
  return JSON.parse(out.trim().split("\n").pop()!);
}

describe.skipIf(!PYTHON)("Hermes", () => {
  for (const urllib of [false, true]) {
    test(`C1 external (${urllib ? "urllib" : "httpx"}): with no env token the plugin reads the token file`, async () => {
      const dir = fresh("cfg");
      const s = serve({ configDir: dir });
      const out = await hermes([
        `OUT['get'] = m._rest_call(${s.port}, 'GET', '/health')`,
        `OUT['post'] = m._rest_call(${s.port}, 'POST', '/retrieve', {'query': 'doc', 'mode': 'keyword'})`,
      ].join("\n"), childEnv({ CLAWMEM_CONFIG_DIR: dir }), { urllib });
      expect(out.get?.status).toBe("ok");
      expect(out.post).not.toBeNull();
    });

    test(`C5 (${urllib ? "urllib" : "httpx"}): an env token with an LF is never sent and never logged`, async () => {
      const bad = `${newToken()}\nX-Evil: 1`;
      const s = serve({ token: newToken() });
      const out = await hermes(`OUT['r'] = m._rest_call(${s.port}, 'GET', '/health')`, childEnv({ CLAWMEM_API_TOKEN: bad, CLAWMEM_CONFIG_DIR: fresh("cfg") }), { urllib });
      expect(out.r).toBeNull();
      expect(holdsNoPartOf(out.logs, bad)).toBe(true);
    });
  }

  test("C6: a token file in a group-writable directory is not used (another user could have replaced it)", async () => {
    const dir = fresh("cfg");
    const s = serve({ configDir: dir });
    chmodSync(dir, 0o770);
    try {
      const out = await hermes(`OUT['r'] = m._rest_call(${s.port}, 'GET', '/health')`, childEnv({ CLAWMEM_CONFIG_DIR: dir }));
      expect(out.r).toBeNull();
      expect(out.logs).toContain("config directory");
    } finally { chmodSync(dir, 0o700); }
  });

  test("C7: a short first read still yields the whole token — its 32-character prefix would pass as a token", async () => {
    const dir = fresh("cfg");
    const t = newToken();
    writeFileSync(join(dir, "serve-token"), `${t}\n`, { mode: 0o600 });
    const out = await hermes([
      "_real_read, _calls = m.os.read, []",
      "def _short_read(fd, n):",
      "    _calls.append(n)",
      "    return _real_read(fd, min(n, 32) if len(_calls) == 1 else n)",
      "m.os.read = _short_read",
      "try:",
      `    OUT['token'] = m._read_token_file(${JSON.stringify(join(dir, "serve-token"))})`,
      "finally:",
      "    m.os.read = _real_read",
      "OUT['reads'] = len(_calls)",
    ].join("\n"), childEnv({ CLAWMEM_CONFIG_DIR: dir }));
    expect(out.reads).toBeGreaterThan(1);
    expect(out.token).toBe(t);
  });

  test("C2 managed: the wrapper's .env token reaches both the child and the client, and survives a lost port race", async () => {
    const envTok = newToken();
    const bin = fakeWrapper(`CLAWMEM_API_TOKEN=${envTok}\n`);
    const port = await freePort();
    const out = await hermes([
      "def launcher():",
      `    p = m.ClawMemProvider(); p._bin = ${JSON.stringify(bin)}; p._port = ${port}; p._env_extra = {}`,
      "    p._start_serve(); return p",
      "p = launcher()",
      "OUT['p'] = p._rest('GET', '/health')",
      "q = launcher()",
      "if q._serve_proc is not None: q._serve_proc.wait(20)   # p's serve can answer q's readiness probe first",
      "OUT['q_child_exited'] = q._serve_proc is None or q._serve_proc.poll() is not None",
      "OUT['q'] = q._rest('GET', '/health')",
      "OUT['same_token'] = p._serve_token == q._serve_token",
      "p._serve_proc.terminate(); p._serve_proc.wait(10)",
    ].join("\n"), childEnv({ CLAWMEM_CONFIG_DIR: fresh("cfg") }));
    expect(out.p?.status).toBe("ok");
    expect(out.q_child_exited).toBe(true);
    expect(out.q?.status).toBe("ok");
    expect(out.same_token).toBe(true);
    expect(holdsNoPartOf(out.logs, envTok)).toBe(true);
  });

  test("C4: two launchers on one port, an external client and `clawmem serve-token` share the one file token", async () => {
    const dir = fresh("cfg");
    const bin = join(LANE, "bin", "clawmem");
    const port = await freePort();
    const out = await hermes([
      "def launcher():",
      `    p = m.ClawMemProvider(); p._bin = ${JSON.stringify(bin)}; p._port = ${port}; p._env_extra = {}`,
      "    p._start_serve(); return p",
      "a = launcher(); b = launcher()",
      "OUT['a'] = a._rest('GET', '/health'); OUT['b'] = b._rest('GET', '/health')",
      `OUT['external'] = m._rest_call(${port}, 'GET', '/health')`,
      `OUT['cli'] = subprocess.run([${JSON.stringify(bin)}, 'serve-token'], capture_output=True, text=True).stdout.strip()`,
      "a._serve_proc.terminate(); a._serve_proc.wait(10)",
    ].join("\n"), childEnv({ CLAWMEM_CONFIG_DIR: dir }));
    const fileToken = readFileSync(join(dir, "serve-token"), "utf-8").trim();
    expect(out.a?.status).toBe("ok");
    expect(out.b?.status).toBe("ok");
    expect(out.external?.status).toBe("ok");
    expect(out.cli).toBe(fileToken);
  });
});

describe("OpenClaw", () => {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const cfgFor = (port: number, env: Record<string, string>) =>
    ({ clawmemBin: join(LANE, "bin", "clawmem"), tokenBudget: 800, profile: "balanced", enableTools: true, servePort: port, env });
  async function search(cfg: ReturnType<typeof cfgFor>, auth?: { token: string | null }): Promise<string> {
    const tools = (createTools as (...a: unknown[]) => { name: string; execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }[])(cfg, logger, auth);
    const r = await tools.find(t => t.name === "clawmem_search")!.execute("t1", { query: "doc", mode: "keyword" });
    return r.content.map(c => c.text).join("\n");
  }
  const saved = process.env.CLAWMEM_API_TOKEN;
  const restore = () => { if (saved === undefined) delete process.env.CLAWMEM_API_TOKEN; else process.env.CLAWMEM_API_TOKEN = saved; };

  test("C3: cfg.env's empty token overrides process.env's — the file is used, as the managed child resolves", async () => {
    const dir = fresh("cfg");
    const s = serve({ configDir: dir });
    process.env.CLAWMEM_API_TOKEN = newToken();
    try {
      expect(await search(cfgFor(s.port!, { CLAWMEM_API_TOKEN: "", CLAWMEM_CONFIG_DIR: dir }))).not.toContain("Search failed");
    } finally { restore(); }
  });

  test("C3: a managed token, when set, is the one sent", async () => {
    const t = newToken();
    const s = serve({ token: t });
    expect(await search(cfgFor(s.port!, { CLAWMEM_CONFIG_DIR: fresh("cfg") }), { token: t })).not.toContain("Search failed");
    expect(await search(cfgFor(s.port!, { CLAWMEM_CONFIG_DIR: fresh("cfg") }), { token: newToken() })).toContain("Search failed");
  });

  test("C6: a token file in a group-writable directory is not used", async () => {
    const dir = fresh("cfg");
    const s = serve({ configDir: dir });
    chmodSync(dir, 0o770);
    try {
      const text = await search(cfgFor(s.port!, { CLAWMEM_CONFIG_DIR: dir }));
      expect(text).toContain("Search failed");
      expect(text).toContain("config directory");
    } finally { chmodSync(dir, 0o700); }
  });

  test("C7: a short first read still yields the whole token — its 32-character prefix would pass as a token", () => {
    const dir = fresh("cfg");
    const t = newToken();
    writeFileSync(join(dir, "serve-token"), `${t}\n`, { mode: 0o600 });
    let reads = 0;
    const got = readServeTokenFile(join(dir, "serve-token"), (fd, buf, off, len, pos) => {
      reads++;
      return readSync(fd, buf, off, reads === 1 ? Math.min(len, 32) : len, pos);
    });
    expect(reads).toBeGreaterThan(1);
    expect(got).toBe(t);
  });

  test("C5: an env token with an LF is never sent and appears in no error", async () => {
    const bad = `${newToken()}\nX-Evil: 1`;
    const s = serve({ token: newToken() });
    process.env.CLAWMEM_API_TOKEN = bad;
    try {
      const text = await search(cfgFor(s.port!, { CLAWMEM_CONFIG_DIR: fresh("cfg") }));
      expect(text).toContain("Search failed");
      expect(holdsNoPartOf(text, bad)).toBe(true);
    } finally { restore(); }
  });
});
