/**
 * OKF-8 — the REST server's guard and token resolver as units (BACKLOG 62.4, CM-56). All new behaviour: on v0.41.5
 * `src/server-guard.ts`, `clawmem serve-token` and `serve --no-token` do not exist.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import {
  checkRequest, configDirProblem, createTokenFile, isJsonContentType, isLoopbackHost, parseAuthority, parseOrigin,
  resolveServeGuard, resolveServeToken, ServeConfigError, serveWarnings, tokenFileProblem, tokensEqual, validToken,
} from "../../src/server-guard.ts";
import { createStore } from "../../src/store.ts";
import { startServer } from "../../src/server.ts";

const CLI = resolve(import.meta.dir, "../../src/clawmem.ts");
const BUN = process.execPath;
let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "clawmem-guard-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
const fresh = (name = "cfg") => mkdtempSync(join(root, `${name}-`));
const euid = process.geteuid?.() ?? 0;
const token43 = () => randomBytes(32).toString("base64url");

/** The resolver's refusal, its message checked to hold no part of `secret`. */
function refusal(fn: () => unknown, secret?: string): string {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(ServeConfigError);
    const msg = (e as Error).message;
    if (secret) for (let i = 0; i + 8 <= secret.length; i += 4) expect(msg).not.toContain(secret.slice(i, i + 8));
    return msg;
  }
  throw new Error("expected a refusal");
}

/** `fn`'s result with the console warnings it logged, captured without printing them. */
function withWarnings<T>(fn: () => T): { value: T; warnings: string[] } {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const value = fn();
    return { value, warnings: warn.mock.calls.map(c => String(c[0])) };
  } finally { warn.mockRestore(); }
}

/** A child's stream read until `needle` appears, the stream ends, or `ms` pass. */
async function readUntil(stream: ReadableStream<Uint8Array>, needle: string, ms: number): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  try {
    while (!text.includes(needle) && Date.now() < deadline) {
      const timeout = new Promise<{ done: true; value?: undefined }>(res => setTimeout(() => res({ done: true }), deadline - Date.now()));
      const r = await Promise.race([reader.read(), timeout]);
      if (r.done) break;
      text += dec.decode(r.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
  return text;
}

describe("R5 — parsers", () => {
  test("parseAuthority takes host[:port] only, canonical, with its own port", () => {
    expect(parseAuthority("127.1:7438")).toEqual({ host: "127.0.0.1", port: 7438 });
    expect(parseAuthority("LOCALHOST")).toEqual({ host: "localhost", port: null });
    expect(parseAuthority("[::ffff:127.0.0.1]:80")).toEqual({ host: "[::ffff:7f00:1]", port: 80 });
    expect(parseAuthority("proxy.example:080")).toEqual({ host: "proxy.example", port: 80 });
    expect(parseAuthority("proxy.example:80")).toEqual({ host: "proxy.example", port: 80 });
    for (const bad of ["", " ", "user@127.0.0.1", "127.0.0.1/x", "127.0.0.1?q", "a#b", "a\\b", "a,b", "127.0.0.1:99999",
      "127.0.0.1:0", "127.0.0.1:", "127.0.0.999", "::1", "fd00::5:80", "[::1", "a b", "127.0.0.1:12a"]) {
      expect({ bad, r: parseAuthority(bad) }).toEqual({ bad, r: null });
    }
  });

  test("parseOrigin takes scheme://host[:port] with http or https only", () => {
    expect(parseOrigin("http://LOCALHOST:5173")).toEqual({ origin: "http://localhost:5173", host: "localhost" });
    expect(parseOrigin("https://dash.example:443")).toEqual({ origin: "https://dash.example", host: "dash.example" });
    expect(parseOrigin("http://[::ffff:127.0.0.1]:1")).toEqual({ origin: "http://[::ffff:7f00:1]:1", host: "[::ffff:7f00:1]" });
    for (const bad of ["null", "", "file://x", "ftp://x", "http://user@x", "http://x/path", "http://x?q", "http://x#f", "javascript:alert(1)"]) {
      expect({ bad, r: parseOrigin(bad) }).toEqual({ bad, r: null });
    }
  });

  test("loopback is decided on canonical hosts", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "127.255.0.9", "[::1]", "[::ffff:7f00:1]", "[::ffff:7fff:ffff]"]) expect({ h, l: isLoopbackHost(h) }).toEqual({ h, l: true });
    for (const h of ["0.0.0.0", "[::]", "192.0.2.1", "[::ffff:c000:201]", "localhost.example", "128.0.0.1"]) expect({ h, l: isLoopbackHost(h) }).toEqual({ h, l: false });
  });

  test("JSON media types", () => {
    for (const ct of ["application/json", "Application/JSON", "application/json; charset=utf-8", " application/json ;charset=UTF-8"]) expect(isJsonContentType(ct)).toBe(true);
    for (const ct of [null, "", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", "application/json-patch+json", "text/json"]) expect(isJsonContentType(ct)).toBe(false);
  });

  test("tokens: b64token of 32–4096 characters; equality by value", () => {
    expect(validToken(token43())).toBe(true);
    expect(validToken("a".repeat(32))).toBe(true);
    expect(validToken(`${"A1-._~+/".repeat(4)}==`)).toBe(true);
    for (const t of ["a".repeat(31), "a".repeat(4097), `${"a".repeat(32)}\n`, `${"a".repeat(16)} ${"a".repeat(16)}`, `${"a".repeat(32)}é`, `=${"a".repeat(32)}`, `${"a".repeat(30)}=a=`]) expect(validToken(t)).toBe(false);
    const t = token43();
    expect(tokensEqual(t, t)).toBe(true);
    expect(tokensEqual(t, token43())).toBe(false);
    expect(tokensEqual(t, t.slice(1))).toBe(false);
  });
});

describe("R4 — guard resolution", () => {
  const ok = (g: ReturnType<typeof resolveServeGuard>, host: string | null, origin: string | null = null) => checkRequest({ host, origin }, g).ok;
  test("a wildcard bind without an allowlist does not enforce Host; with one it does", () => {
    for (const bind of ["", "*", "0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0"]) {
      const g = resolveServeGuard({ host: bind, env: {} });
      expect({ bind, enforce: g.enforceHost }).toEqual({ bind, enforce: false });
      expect(ok(g, "attacker.example:1")).toBe(true);
      const g2 = resolveServeGuard({ host: bind, env: { CLAWMEM_ALLOWED_HOSTS: "proxy.example" } });
      expect(g2.enforceHost).toBe(true);
      expect(ok(g2, "proxy.example:9")).toBe(true);
      expect(ok(g2, "attacker.example:1")).toBe(false);
      expect(ok(g2, "localhost:1")).toBe(true);
    }
  });
  test("a named bind allows its own canonical host", () => {
    const g = resolveServeGuard({ host: "192.0.2.5", env: {} });
    expect(g.enforceHost).toBe(true);
    expect(ok(g, "192.0.2.5:7438")).toBe(true);
    expect(ok(g, "192.0.2.6:7438")).toBe(false);
    const g6 = resolveServeGuard({ host: "fd00::5", env: {} });
    expect(ok(g6, "[fd00::5]:7438")).toBe(true);
    expect(ok(g6, "[fd00::6]:7438")).toBe(false);
  });
  test("an unparseable allowlist entry, or a Host entry naming a port, refuses start", () => {
    expect(refusal(() => resolveServeGuard({ host: "127.0.0.1", env: { CLAWMEM_ALLOWED_HOSTS: "proxy.example:80" } }))).toContain("CLAWMEM_ALLOWED_HOSTS");
    expect(refusal(() => resolveServeGuard({ host: "127.0.0.1", env: { CLAWMEM_ALLOWED_HOSTS: "a b" } }))).toContain("CLAWMEM_ALLOWED_HOSTS");
    expect(refusal(() => resolveServeGuard({ host: "127.0.0.1", env: { CLAWMEM_ALLOWED_ORIGINS: "dash.example" } }))).toContain("CLAWMEM_ALLOWED_ORIGINS");
    expect(refusal(() => resolveServeGuard({ host: "not a host", env: {} }))).toContain("host");
  });
  test("an allowlist with an empty entry refuses start — never read as no allowlist; only an empty value is unset", () => {
    // Dropping the empty entries turned " , , " into no Host allowlist: Host checks off on a wildcard bind.
    for (const v of [" , , ", ",", " ", "proxy.example,", ",proxy.example", "a.example,,b.example"]) {
      const hosts = refusal(() => resolveServeGuard({ host: "0.0.0.0", env: { CLAWMEM_ALLOWED_HOSTS: v } }));
      expect({ v, named: hosts.includes("CLAWMEM_ALLOWED_HOSTS has an empty entry") }).toEqual({ v, named: true });
      const origins = refusal(() => resolveServeGuard({ host: "127.0.0.1", env: { CLAWMEM_ALLOWED_ORIGINS: v.replace("proxy.example", "https://dash.example") } }));
      expect({ v, named: origins.includes("CLAWMEM_ALLOWED_ORIGINS has an empty entry") }).toEqual({ v, named: true });
    }
    expect(resolveServeGuard({ host: "0.0.0.0", env: { CLAWMEM_ALLOWED_HOSTS: "" } }).enforceHost).toBe(false);
    const g = resolveServeGuard({ host: "0.0.0.0", env: { CLAWMEM_ALLOWED_HOSTS: " proxy.example , OTHER.example " } });
    expect(g.enforceHost).toBe(true);
    expect(g.allowedHosts).toEqual(["proxy.example", "other.example"]);
  });
  test("Origin rule: absent passes, loopback or allowlisted passes, the rest fails", () => {
    const g = resolveServeGuard({ host: "127.0.0.1", env: { CLAWMEM_ALLOWED_ORIGINS: "https://dash.example" } });
    expect(ok(g, "127.0.0.1:1", null)).toBe(true);
    expect(ok(g, "127.0.0.1:1", "http://localhost:3000")).toBe(true);
    expect(ok(g, "127.0.0.1:1", "https://dash.example")).toBe(true);
    expect(ok(g, "127.0.0.1:1", "https://evil.example")).toBe(false);
    expect(ok(g, "127.0.0.1:1", "null")).toBe(false);
    expect(ok(g, null, null)).toBe(true);
    expect(ok(g, "", null)).toBe(false);
  });
});

describe("R1–R3 — the token file", () => {
  test("R1: a fresh directory gets a 0700 directory and a 0600 file of 43 base64url characters, reused after", () => {
    const parent = fresh();
    const dir = join(parent, "nested", "clawmem");
    const a = resolveServeToken({ env: {}, configDir: dir });
    expect(a.source).toBe("file");
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "serve-token")).mode & 0o777).toBe(0o600);
    expect(resolveServeToken({ env: {}, configDir: dir }).token).toBe(a.token);
    expect(readdirSync(dir)).toEqual(["serve-token"]);
  });

  test("R1: an env token is used as given and writes no file", () => {
    const dir = fresh();
    const t = token43();
    expect(resolveServeToken({ env: { CLAWMEM_API_TOKEN: t }, configDir: dir })).toMatchObject({ token: t, source: "env" });
    expect(existsSync(join(dir, "serve-token"))).toBe(false);
    expect(resolveServeToken({ env: { CLAWMEM_API_TOKEN: "" }, configDir: dir }).source).toBe("file");
  });

  test("R2: eight processes resolving at once agree on one token and leave no temp file", async () => {
    const dir = join(fresh(), "race");
    const code = `import { resolveServeToken } from ${JSON.stringify(resolve(import.meta.dir, "../../src/server-guard.ts"))}; console.log(resolveServeToken({ env: {}, configDir: process.argv[process.argv.length - 1] }).token);`;
    const procs = Array.from({ length: 8 }, () => Bun.spawn([BUN, "-e", code, dir], { stdout: "pipe", stderr: "pipe" }));
    const outs = await Promise.all(procs.map(async p => { await p.exited; return (await new Response(p.stdout).text()).trim(); }));
    expect(new Set(outs).size).toBe(1);
    expect(outs[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readdirSync(dir)).toEqual(["serve-token"]);
  });

  // R2 above cannot make the processes collide; these drive the loser's path directly: the file already in place when
  // link() runs is exactly what a winner leaves between a loser's first read and its link.
  test("R2: the link race's loser returns the winner's token and leaves no temp file", () => {
    const dir = fresh("loser");
    chmodSync(dir, 0o700);
    const path = join(dir, "serve-token");
    const winner = token43();
    writeFileSync(path, `${winner}\n`, { mode: 0o600 });
    expect(createTokenFile(dir, path)).toBe(winner);
    expect(readFileSync(path, "utf-8")).toBe(`${winner}\n`);
    expect(readdirSync(dir)).toEqual(["serve-token"]);
  });

  test("R2: a loser refuses a winner that fails the file checks, leaves it in place, and removes its temp file", () => {
    const secret = token43();
    const cases: [string, (p: string) => void, RegExp][] = [
      ["group-readable", p => { writeFileSync(p, secret); chmodSync(p, 0o640); }, /chmod 600/],
      ["not a token", p => { writeFileSync(p, "short", { mode: 0o600 }); }, /does not hold a valid token/],
      ["symlink", p => { writeFileSync(`${p}-real`, secret, { mode: 0o600 }); symlinkSync(`${p}-real`, p); }, /symlink/],
    ];
    for (const [name, setup, why] of cases) {
      const dir = fresh(name.replace(/\W+/g, "-"));
      chmodSync(dir, 0o700);
      const path = join(dir, "serve-token");
      setup(path);
      const before = { names: readdirSync(dir).sort(), text: readFileSync(path, "utf-8") };
      const msg = refusal(() => createTokenFile(dir, path), secret);
      expect({ name, why: why.test(msg) }).toEqual({ name, why: true });
      expect({ name, after: { names: readdirSync(dir).sort(), text: readFileSync(path, "utf-8") } }).toEqual({ name, after: before });
    }
  });

  test("R2: a write that takes a few bytes at a time still publishes the whole token", () => {
    const dir = fresh("short");
    chmodSync(dir, 0o700);
    const path = join(dir, "serve-token");
    let calls = 0;
    const token = createTokenFile(dir, path, (fd, buf, off, len) => { calls++; return writeSync(fd, buf, off, Math.min(len, 5)); });
    expect(calls).toBeGreaterThan(1);
    expect(validToken(token)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(`${token}\n`);
    expect(resolveServeToken({ env: {}, configDir: dir }).token).toBe(token);
    expect(readdirSync(dir)).toEqual(["serve-token"]);
  });

  test("R2: a write that makes no progress refuses and publishes nothing", () => {
    const dir = fresh("stuck");
    chmodSync(dir, 0o700);
    const path = join(dir, "serve-token");
    expect(refusal(() => createTokenFile(dir, path, () => 0))).toContain("cannot write a token file");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("R3: refusals name the fix and never the value", () => {
    const secret = token43();
    const cases: [string, (d: string) => void][] = [
      ["group-readable", d => { writeFileSync(join(d, "serve-token"), secret); chmodSync(join(d, "serve-token"), 0o640); }],
      ["world-readable", d => { writeFileSync(join(d, "serve-token"), secret); chmodSync(join(d, "serve-token"), 0o604); }],
      ["symlink", d => { writeFileSync(join(d, "real"), secret, { mode: 0o600 }); symlinkSync(join(d, "real"), join(d, "serve-token")); }],
      ["empty", d => { writeFileSync(join(d, "serve-token"), "", { mode: 0o600 }); }],
      ["inner whitespace", d => { writeFileSync(join(d, "serve-token"), `${secret.slice(0, 20)} ${secret.slice(20)}`, { mode: 0o600 }); }],
      ["too short", d => { writeFileSync(join(d, "serve-token"), secret.slice(0, 31), { mode: 0o600 }); }],
      ["over 4 KiB", d => { writeFileSync(join(d, "serve-token"), "a".repeat(5000), { mode: 0o600 }); }],
      ["group-writable dir", d => { chmodSync(d, 0o770); }],
    ];
    for (const [name, setup] of cases) {
      const d = fresh(name.replace(/\W+/g, "-"));
      chmodSync(d, 0o700);
      setup(d);
      const msg = refusal(() => resolveServeToken({ env: {}, configDir: d }), secret);
      expect({ name, hasFix: /chmod|remove|delete|replace|regenerate|token/i.test(msg) }).toEqual({ name, hasFix: true });
    }
  });

  test("R3: the owner and mode rules over synthetic stat results", () => {
    expect(tokenFileProblem({ isFile: true, uid: euid, mode: 0o100600, size: 44 }, euid)).toBeNull();
    expect(tokenFileProblem({ isFile: true, uid: euid + 1, mode: 0o100600, size: 44 }, euid)).toContain("owned");
    expect(tokenFileProblem({ isFile: true, uid: euid, mode: 0o100644, size: 44 }, euid)).toContain("chmod 600");
    expect(tokenFileProblem({ isFile: false, uid: euid, mode: 0o040700, size: 44 }, euid)).not.toBeNull();
    expect(tokenFileProblem({ isFile: true, uid: euid, mode: 0o100600, size: 9000 }, euid)).not.toBeNull();
    expect(configDirProblem({ isDirectory: true, uid: euid, mode: 0o040700 }, euid)).toBeNull();
    expect(configDirProblem({ isDirectory: true, uid: euid, mode: 0o040755 }, euid)).toBeNull();
    expect(configDirProblem({ isDirectory: true, uid: euid, mode: 0o040775 }, euid)).toContain("writable");
    expect(configDirProblem({ isDirectory: true, uid: euid + 1, mode: 0o040700 }, euid)).toContain("owned");
  });

  test("R7: an env token that is not a 32–4096-character b64token refuses, naming the rule and not the value", () => {
    for (const bad of [`${token43()}\nX`, `${token43()} x`, `${token43()}é`, "a".repeat(31), "a".repeat(4097)]) {
      const msg = refusal(() => resolveServeToken({ env: { CLAWMEM_API_TOKEN: bad }, configDir: fresh() }), bad.length > 8 ? bad : undefined);
      expect(msg).toContain("CLAWMEM_API_TOKEN");
    }
    expect(resolveServeToken({ env: { CLAWMEM_API_TOKEN: "a".repeat(32) }, configDir: fresh() }).token).toBe("a".repeat(32));
  });
});

describe("R6, R8 — the CLI", () => {
  const childEnv = (extra: Record<string, string> = {}) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CLAWMEM_") && k !== "INDEX_PATH") env[k] = v;
    return { ...env, INDEX_PATH: join(fresh("idx"), "vault.sqlite"), CLAWMEM_CONFIG_DIR: fresh("cli"), ...extra };
  };

  test("R6: serve --no-token refuses a wildcard bind before it serves anything", () => {
    const r = Bun.spawnSync([BUN, CLI, "serve", "--no-token", "--host", "0.0.0.0", "--port", "0"], { env: childEnv(), stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(r.exitCode).not.toBe(0);
    expect(r.exitCode).not.toBeNull();
    expect(r.stdout.toString() + r.stderr.toString()).toContain("--no-token");
  });

  test("R6: --no-token on loopback serves without a token while the guard still rejects", async () => {
    const store = createStore(join(fresh("nt"), "v.sqlite"));
    const s = withWarnings(() => (startServer as (...a: unknown[]) => ReturnType<typeof startServer>)(store, 0, "127.0.0.1", { noToken: true }));
    expect(s.warnings.filter(m => m.includes("no token (--no-token)") && m.includes("loopback origin")).length).toBe(1);
    try {
      const base = `http://127.0.0.1:${s.value.port}`;
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/health`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
      expect((await fetch(`${base}/health`, { headers: { Host: `attacker.example:${s.value.port}` } })).status).toBe(403);
      expect((await fetch(`${base}/lifecycle/sweep`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
      expect((await fetch(`${base}/search`, { method: "OPTIONS", headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" } })).status).toBe(204);
      // What the warning says: a loopback-origin page needs no token here.
      expect((await fetch(`${base}/health`, { headers: { Origin: "http://localhost:3000" } })).status).toBe(200);
    } finally { s.value.stop(true); store.close(); }
    expect(() => (startServer as (...a: unknown[]) => unknown)(createStore(join(fresh("nt2"), "v.sqlite")), 0, "0.0.0.0", { noToken: true })).toThrow(ServeConfigError);
  });

  test("R6: clawmem serve --no-token logs its warning at start", async () => {
    const p = Bun.spawn([BUN, CLI, "serve", "--no-token", "--port", "0"], { env: childEnv(), stdout: "pipe", stderr: "pipe" });
    let err = "";
    try {
      err = await readUntil(p.stderr, "no token (--no-token)", 20_000);
    } finally { p.kill(); await p.exited; }
    expect(err).toContain("no token (--no-token)");
    expect(err).toContain("loopback origin");
  }, 30_000);

  test("R6: startup warnings name what is left open — no token, Host check off, unchecked file on Windows", () => {
    const loop = resolveServeGuard({ host: "127.0.0.1", env: {} });
    const wild = resolveServeGuard({ host: "0.0.0.0", env: {} });
    expect(serveWarnings({ host: "127.0.0.1", guard: loop, noToken: false, tokenFile: "/x/serve-token", platform: "linux" })).toEqual([]);
    const nt = serveWarnings({ host: "127.0.0.1", guard: loop, noToken: true, tokenFile: null, platform: "linux" });
    expect(nt.length).toBe(1);
    expect(nt[0]).toContain("loopback origin");
    const off = serveWarnings({ host: "0.0.0.0", guard: wild, noToken: false, tokenFile: null, platform: "linux" });
    expect(off.length).toBe(1);
    expect(off[0]).toContain("CLAWMEM_ALLOWED_HOSTS");
    const win = serveWarnings({ host: "127.0.0.1", guard: loop, noToken: false, tokenFile: "C:\\u\\serve-token", platform: "win32" });
    expect(win.length).toBe(1);
    expect(win[0]).toContain("Windows");
    expect(serveWarnings({ host: "127.0.0.1", guard: loop, noToken: false, tokenFile: null, platform: "win32" })).toEqual([]);
  });

  test("R8: serve-token prints the env token, else the file's (creating it), and refuses a bad file without the value", () => {
    const env = childEnv();
    const first = Bun.spawnSync([BUN, CLI, "serve-token"], { env, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(first.exitCode).toBe(0);
    const t = first.stdout.toString().trim();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(env.CLAWMEM_CONFIG_DIR!, "serve-token"), "utf-8").trim()).toBe(t);
    expect(Bun.spawnSync([BUN, CLI, "serve-token"], { env, stdout: "pipe" }).stdout.toString().trim()).toBe(t);
    const envTok = token43();
    expect(Bun.spawnSync([BUN, CLI, "serve-token"], { env: { ...env, CLAWMEM_API_TOKEN: envTok }, stdout: "pipe" }).stdout.toString().trim()).toBe(envTok);
    chmodSync(join(env.CLAWMEM_CONFIG_DIR!, "serve-token"), 0o644);
    const bad = Bun.spawnSync([BUN, CLI, "serve-token"], { env, stdout: "pipe", stderr: "pipe" });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stdout.toString() + bad.stderr.toString()).not.toContain(t.slice(0, 12));
  });

  test("R8: through the wrapper, an .env token for an unset variable is what serve-token prints", () => {
    const fake = fresh("wrap");
    mkdirSync(join(fake, "bin"));
    writeFileSync(join(fake, "bin", "clawmem"), readFileSync(resolve(import.meta.dir, "../../bin/clawmem")), { mode: 0o755 });
    symlinkSync(resolve(import.meta.dir, "../../src"), join(fake, "src"));
    symlinkSync(resolve(import.meta.dir, "../../node_modules"), join(fake, "node_modules"));
    symlinkSync(resolve(import.meta.dir, "../../package.json"), join(fake, "package.json"));
    const envTok = token43();
    writeFileSync(join(fake, ".env"), `CLAWMEM_API_TOKEN=${envTok}\n`);
    const r = Bun.spawnSync([join(fake, "bin", "clawmem"), "serve-token"], { env: childEnv(), stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe(envTok);
  });
});
