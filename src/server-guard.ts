/**
 * The REST server's transport guard (BACKLOG 62.4, CM-56): which browser requests may reach `clawmem serve`, and the
 * token every request carries. Pure parsers and predicates, unit-testable without a socket, plus the token resolver.
 *
 * The token stops a web page, which can never read it. It is NOT authority against a same-user agent or process,
 * which can read the environment and the token file — so nothing here is "authorization".
 */
import { closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from "fs";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { homedir } from "os";
import { join } from "path";

/** A configuration `serve` refuses to start with. Its message never holds a token. */
export class ServeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeConfigError";
  }
}

// =============================================================================
// Tokens
// =============================================================================

export const TOKEN_FILE = "serve-token";
export const MIN_TOKEN = 32;
export const MAX_TOKEN = 4096;
const MAX_FILE = 4096;
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const TOKEN_RULE = `${MIN_TOKEN}–${MAX_TOKEN} characters of A–Z a–z 0–9 - . _ ~ + / with optional trailing "="`;

/**
 * A bearer token (RFC 6750 `b64token`) of 32–4096 characters. The floor matters: a page rebound onto a wildcard bind is
 * same-origin, and a loopback origin is granted `Authorization` by CORS, so either could enumerate a short token.
 */
export function validToken(t: string): boolean {
  return t.length >= MIN_TOKEN && t.length <= MAX_TOKEN && B64TOKEN.test(t);
}

/** Constant-time equality: both sides hashed first, so neither length nor a common prefix shows in the timing. */
export function tokensEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function configDirFor(env: Record<string, string | undefined>): string {
  return env.CLAWMEM_CONFIG_DIR || join(homedir(), ".config", "clawmem");
}

const effectiveUid = (): number | null => (typeof process.geteuid === "function" ? process.geteuid() : null);

/** Why a token file's `fstat` result is unacceptable, or null. */
export function tokenFileProblem(st: { isFile: boolean; uid: number; mode: number; size: number }, euid: number | null): string | null {
  if (!st.isFile) return "is not a regular file — remove it so a new token is generated";
  if (euid !== null && st.uid !== euid) return "is not owned by this user — remove it so a new token is generated";
  if ((st.mode & 0o077) !== 0) return "is readable or writable by other users — run: chmod 600 on it";
  if (st.size > MAX_FILE) return "is larger than 4 KiB — remove it so a new token is generated";
  return null;
}

/** Why the config directory's `stat` result is unacceptable, or null. */
export function configDirProblem(st: { isDirectory: boolean; uid: number; mode: number }, euid: number | null): string | null {
  if (!st.isDirectory) return "is not a directory";
  if (euid !== null && st.uid !== euid) return "is not owned by this user — other users could replace the token file";
  if ((st.mode & 0o022) !== 0) return "is writable by its group or others — run: chmod go-w on it";
  return null;
}

function ensureConfigDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new ServeConfigError(`cannot create the config directory ${dir}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
  }
  if (process.platform === "win32") return;
  let st;
  try {
    st = statSync(realpathSync(dir));
  } catch (e) {
    throw new ServeConfigError(`cannot read the config directory ${dir}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
  }
  const problem = configDirProblem({ isDirectory: st.isDirectory(), uid: st.uid, mode: st.mode }, effectiveUid());
  if (problem) throw new ServeConfigError(`the config directory ${dir} ${problem}`);
}

/** The token in `path`, opened without following a symlink and checked on that same descriptor; null when absent. */
export function readTokenFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new ServeConfigError(`the token file ${path} is a symlink — remove it so a new token is generated`);
    throw new ServeConfigError(`cannot open the token file ${path}: ${code ?? "error"}`);
  }
  try {
    const st = fstatSync(fd);
    const problem = process.platform === "win32"
      ? (!st.isFile() || st.size > MAX_FILE ? "is not a regular file of at most 4 KiB — remove it so a new token is generated" : null)
      : tokenFileProblem({ isFile: st.isFile(), uid: st.uid, mode: st.mode, size: st.size }, effectiveUid());
    if (problem) throw new ServeConfigError(`the token file ${path} ${problem}`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    const text = buf.subarray(0, off).toString("utf-8").trim();
    if (text === "") throw new ServeConfigError(`the token file ${path} is empty — remove it so a new token is generated`);
    if (!validToken(text)) throw new ServeConfigError(`the token file ${path} does not hold a valid token (${TOKEN_RULE}) — remove it so a new token is generated`);
    return text;
  } finally {
    closeSync(fd);
  }
}

/** `writeSync`'s shape for one buffer slice: returns how many bytes it took, which may be fewer than offered. */
export type WriteFn = (fd: number, buf: Buffer, offset: number, length: number) => number;
const writeFd: WriteFn = (fd, buf, offset, length) => writeSync(fd, buf, offset, length);

/**
 * Generates a token and publishes it at `path` without ever overwriting: a concurrent winner's token is returned instead,
 * read through the same checks as any token file. Exported for the race tests, which call it with the file already in
 * place (the loser's path) and pass a `write` that takes a few bytes at a time.
 */
export function createTokenFile(dir: string, path: string, write: WriteFn = writeFd): string {
  const token = randomBytes(32).toString("base64url");
  const data = Buffer.from(`${token}\n`);
  const tmp = join(dir, `${TOKEN_FILE}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  let fd: number;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (e) {
    throw new ServeConfigError(`cannot create a token file in ${dir}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
  }
  try {
    try {
      // A write can take fewer bytes than offered: the file is published only once it holds the whole token.
      for (let off = 0; off < data.length;) {
        const n = write(fd, data, off, data.length - off);
        if (!(n > 0)) throw new ServeConfigError(`cannot write a token file in ${dir}: a write made no progress`);
        off += n;
      }
      fsyncSync(fd);
    } catch (e) {
      if (e instanceof ServeConfigError) throw e;
      throw new ServeConfigError(`cannot write a token file in ${dir}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new ServeConfigError(`cannot publish the token file ${path}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
      const winner = readTokenFile(path);
      if (winner === null) throw new ServeConfigError(`the token file ${path} vanished while it was being created — start again`);
      return winner;
    }
    try { // best effort: make the new directory entry durable
      const dfd = openSync(dir, constants.O_RDONLY);
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
    } catch { /* not every platform can fsync a directory */ }
    return token;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

export type ServeToken = { token: string; source: "env" | "file"; path?: string };

/**
 * The token `serve` uses: a non-empty `CLAWMEM_API_TOKEN` (an empty one means unset, never "open"), else the token file
 * `<configDir>/serve-token`, created on first use. Throws ServeConfigError, naming the fix and never the value.
 */
export function resolveServeToken(opts: { env?: Record<string, string | undefined>; configDir?: string } = {}): ServeToken {
  const env = opts.env ?? process.env;
  const fromEnv = env.CLAWMEM_API_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!validToken(fromEnv)) {
      throw new ServeConfigError(`CLAWMEM_API_TOKEN is not a valid token: it must be ${TOKEN_RULE} — set a random one (openssl rand -base64 32) or unset it to use the generated token file`);
    }
    return { token: fromEnv, source: "env" };
  }
  const dir = opts.configDir ?? configDirFor(env);
  const path = join(dir, TOKEN_FILE);
  ensureConfigDir(dir);
  const existing = readTokenFile(path);
  return { token: existing ?? createTokenFile(dir, path), source: "file", path };
}

// =============================================================================
// Origin and Host
// =============================================================================

export type Authority = { host: string; port: number | null };

/**
 * `host[:port]` only — what a `Host` header or an allowlist entry may be. The port is split off here, never read from
 * `url.port` (the URL parser drops a scheme's default port, so `:80` would vanish); the host is canonicalized by the URL
 * parser: lowercase names, dotted IPv4 (`127.1` → `127.0.0.1`), WHATWG IPv6 (`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`).
 */
export function parseAuthority(raw: string): Authority | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300 || /[\s@/?#\\,]/.test(raw)) return null;
  let hostPart: string;
  let portPart: string | null = null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0) return null;
    hostPart = raw.slice(0, end + 1);
    const rest = raw.slice(end + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return null;
      portPart = rest.slice(1);
    }
  } else {
    const parts = raw.split(":");
    if (parts.length > 2) return null; // an unbracketed IPv6 literal, or not an authority
    hostPart = parts[0]!;
    if (parts.length === 2) portPart = parts[1]!;
  }
  let port: number | null = null;
  if (portPart !== null) {
    if (!/^\d{1,5}$/.test(portPart)) return null;
    port = Number(portPart);
    if (port < 1 || port > 65535) return null;
  }
  if (hostPart === "" || hostPart === "[]") return null;
  let url: URL;
  try {
    url = new URL(`http://${hostPart}`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port) return null;
  return { host: url.hostname.toLowerCase(), port };
}

/** `scheme://host[:port]` with http or https — what an `Origin` header or an origin allowlist entry may be. */
export function parseOrigin(raw: string): { origin: string; host: string } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300 || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  return { origin: url.origin.toLowerCase(), host: url.hostname.toLowerCase() };
}

/** Loopback, decided on a canonical host. `0.0.0.0` is not loopback: browsers reach it without rebinding. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) return Number(v4[1]) === 127;
  if (h === "[::1]") return true;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/.exec(h);
  return mapped !== null && parseInt(mapped[1]!, 16) >> 8 === 0x7f;
}

export function isJsonContentType(ct: string | null): boolean {
  return ct !== null && ct.split(";")[0]!.trim().toLowerCase() === "application/json";
}

export type ServeGuard = {
  allowedOrigins: string[];
  allowedHosts: string[];
  /** False only for a wildcard bind with no Host allowlist, where the legitimate Host is unknowable. */
  enforceHost: boolean;
  wildcard: boolean;
  loopbackBind: boolean;
};

/**
 * A comma list from the environment. Only an empty value means unset: an empty entry (blanks, a stray or doubled comma)
 * is refused, never dropped — dropping it would turn a mistyped Host allowlist into none, and Host checks off with it.
 */
function splitList(name: string, v: string | undefined): string[] {
  if (v === undefined || v === "") return [];
  const items = v.split(",").map(x => x.trim());
  if (items.includes("")) throw new ServeConfigError(`${name} has an empty entry — separate the entries with single commas, or leave it unset`);
  return items;
}
const bracketBareIpv6 = (h: string) => (!h.startsWith("[") && (h.match(/:/g) ?? []).length > 1 ? `[${h}]` : h);

function classifyBind(host: string): { wildcard: boolean; loopback: boolean; canonical: string | null } {
  const raw = host.trim();
  if (raw === "" || raw === "*") return { wildcard: true, loopback: false, canonical: null };
  const a = parseAuthority(bracketBareIpv6(raw));
  if (!a || a.port !== null) throw new ServeConfigError(`the bind address "${host}" is not a valid host`);
  if (a.host === "0.0.0.0" || a.host === "[::]") return { wildcard: true, loopback: false, canonical: a.host };
  return { wildcard: false, loopback: isLoopbackHost(a.host), canonical: a.host };
}

/** The guard for a server bound to `host`; the allowlists come from `opts` or CLAWMEM_ALLOWED_HOSTS / _ORIGINS. */
export function resolveServeGuard(opts: { host: string; env?: Record<string, string | undefined>; allowedHosts?: string[]; allowedOrigins?: string[] }): ServeGuard {
  const env = opts.env ?? process.env;
  const bind = classifyBind(opts.host);
  const rawHosts = opts.allowedHosts ?? splitList("CLAWMEM_ALLOWED_HOSTS", env.CLAWMEM_ALLOWED_HOSTS);
  const rawOrigins = opts.allowedOrigins ?? splitList("CLAWMEM_ALLOWED_ORIGINS", env.CLAWMEM_ALLOWED_ORIGINS);
  const allowedHosts: string[] = [];
  for (const h of rawHosts) {
    const a = parseAuthority(bracketBareIpv6(h));
    if (!a) throw new ServeConfigError(`CLAWMEM_ALLOWED_HOSTS: "${h}" is not a host name or IP literal`);
    if (a.port !== null) throw new ServeConfigError(`CLAWMEM_ALLOWED_HOSTS: "${h}" names a port — give the host name alone (a Host check defends a name; any port is accepted)`);
    allowedHosts.push(a.host);
  }
  const allowedOrigins: string[] = [];
  for (const o of rawOrigins) {
    const p = parseOrigin(o);
    if (!p) throw new ServeConfigError(`CLAWMEM_ALLOWED_ORIGINS: "${o}" is not an origin (scheme://host[:port], http or https)`);
    allowedOrigins.push(p.origin);
  }
  if (!bind.wildcard && !bind.loopback && bind.canonical) allowedHosts.push(bind.canonical);
  return { allowedOrigins, allowedHosts, enforceHost: !bind.wildcard || rawHosts.length > 0, wildcard: bind.wildcard, loopbackBind: bind.loopback };
}

/**
 * What a server's configuration leaves open, logged at every start by whoever starts it (`startServer`, so
 * `clawmem serve` too). Never holds a token.
 */
export function serveWarnings(o: { host: string; guard: ServeGuard; noToken: boolean; tokenFile: string | null; platform?: string }): string[] {
  const w: string[] = [];
  if (o.noToken) {
    w.push("no token (--no-token): pages from other origins are still refused, but a page served from a loopback origin, or from an entry of CLAWMEM_ALLOWED_ORIGINS, can call this server, and so can any local program");
  }
  if (!o.guard.enforceHost) {
    w.push(`Host check off: bound to ${o.host || "every address"} with no CLAWMEM_ALLOWED_HOSTS, so the token alone stops a DNS-rebound page — list the names clients use in CLAWMEM_ALLOWED_HOSTS`);
  }
  if ((o.platform ?? process.platform) === "win32" && o.tokenFile !== null) {
    w.push(`the owner and mode checks on the token file and its directory do not apply on Windows — make sure only your account can read ${o.tokenFile}`);
  }
  return w;
}

export type GuardVerdict = { ok: true; origin: string | null } | { ok: false; reason: string };

/**
 * A request's `Origin` and `Host` against the guard. An absent Origin passes (non-browser clients send none; what it
 * leaves to the token is DESIGN claim 2); an absent Host passes (no browser omits it). A present value must parse.
 */
export function checkRequest(headers: { origin: string | null; host: string | null }, g: ServeGuard): GuardVerdict {
  let origin: string | null = null;
  if (headers.origin !== null) {
    const p = parseOrigin(headers.origin);
    if (!p || !(isLoopbackHost(p.host) || g.allowedOrigins.includes(p.origin))) return { ok: false, reason: "Origin not allowed" };
    origin = p.origin;
  }
  if (g.enforceHost && headers.host !== null) {
    const a = parseAuthority(headers.host);
    if (!a || !(isLoopbackHost(a.host) || g.allowedHosts.includes(a.host))) return { ok: false, reason: "Host not allowed" };
  }
  return { ok: true, origin };
}

/** CORS headers for a response to an allowed origin: that origin exactly, never `*`. */
export function corsHeaders(origin: string): Record<string, string> {
  return { "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
}

export function preflightHeaders(origin: string): Record<string, string> {
  return {
    ...corsHeaders(origin),
    "Access-Control-Allow-Methods": "GET, POST",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
  };
}
