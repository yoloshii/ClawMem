/**
 * Migrate-a-copy for frozen eval bundles (§51.6 T1 HIGH-1).
 *
 * Frozen bundle snapshots predate later forward-only schema migrations (e.g.
 * v0.27.0 `authored_at`), and current code cannot open them read-only. The
 * freeze contract forbids writing the canonical bundle, so runs execute against
 * a digest-verified COPY that has the migrations applied:
 *
 *   1. source WAL must be empty (the main file IS the database) — else abort;
 *   2. sha256 the canonical snapshot + manifest, copy both, re-hash the copies
 *      (byte-equality proof of the copy);
 *   3. open the copy writable ONCE via createStore (runs the forward-only
 *      migration chain), then assert: `authored_at` exists, EVERY value is
 *      NULL, and the active document count is unchanged;
 *   4. checkpoint the copy (TRUNCATE) so it is self-contained again, and print
 *      the post-migration digest — the identity the run transcript records.
 *
 * The harness's own bundle-integrity asserts (pool-10/pool-20/recency-baseline
 * bit-identity vs the frozen manifest) remain the end-to-end proof that the
 * migrated copy reproduces the frozen bundle exactly.
 *
 * Usage: bun scripts/eval-bundle-migrate-copy.ts --bundle <canonical-dir> --out <dir>
 */
import { parseArgs } from "util";
import { copyFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { createStore } from "../src/store.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { bundle: { type: "string" }, out: { type: "string" } },
});
if (!values.bundle || !values.out) {
  console.error("Usage: bun scripts/eval-bundle-migrate-copy.ts --bundle <canonical-dir> --out <dir>");
  process.exit(2);
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

const srcSnap = join(values.bundle, "snapshot.sqlite");
const srcManifest = join(values.bundle, "manifest.json");
const srcWal = srcSnap + "-wal";
if (!existsSync(srcSnap) || !existsSync(srcManifest)) {
  console.error(`not a bundle dir: ${values.bundle}`);
  process.exit(2);
}
if (existsSync(srcWal) && statSync(srcWal).size !== 0) {
  console.error(`source WAL is non-empty (${statSync(srcWal).size} bytes) — the main file is not the complete database; refusing (the canonical bundle is never written by this tool)`);
  process.exit(2);
}
if (existsSync(values.out)) {
  console.error(`refusing to overwrite existing out dir ${values.out}`);
  process.exit(2);
}
mkdirSync(values.out, { recursive: true });
const dstSnap = join(values.out, "snapshot.sqlite");
const dstManifest = join(values.out, "manifest.json");

const srcSnapDigest = await sha256(srcSnap);
const srcManifestDigest = await sha256(srcManifest);
copyFileSync(srcSnap, dstSnap);
copyFileSync(srcManifest, dstManifest);
const dstSnapDigest = await sha256(dstSnap);
const dstManifestDigest = await sha256(dstManifest);
if (dstSnapDigest !== srcSnapDigest || dstManifestDigest !== srcManifestDigest) {
  console.error("copy digest mismatch — aborting");
  process.exit(2);
}

// Pre-migration facts from the untouched copy.
const pre = new Database(dstSnap, { readonly: true });
const preCols = (pre.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[]).map(c => c.name);
const preCount = (pre.prepare(`SELECT COUNT(*) as n FROM documents WHERE active = 1`).get() as { n: number }).n;
pre.close();

// One writable open — the forward-only migration chain runs here.
const store = createStore(dstSnap);
store.close();

const post = new Database(dstSnap);
const postCols = (post.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[]).map(c => c.name);
const postCount = (post.prepare(`SELECT COUNT(*) as n FROM documents WHERE active = 1`).get() as { n: number }).n;
const datedCount = postCols.includes("authored_at")
  ? (post.prepare(`SELECT COUNT(*) as n FROM documents WHERE authored_at IS NOT NULL`).get() as { n: number }).n
  : -1;
post.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
post.close();

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "OK " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};
check(!preCols.includes("authored_at"), `pre-migration schema lacks authored_at (${preCols.length} columns)`);
check(postCols.includes("authored_at"), "post-migration schema has authored_at");
check(datedCount === 0, `every authored_at is NULL (non-null count = ${datedCount})`);
check(postCount === preCount, `active document count unchanged (${preCount} → ${postCount})`);

console.log(`source  snapshot sha256 ${srcSnapDigest}`);
console.log(`source  manifest sha256 ${srcManifestDigest}`);
console.log(`copied  snapshot sha256 ${dstSnapDigest} (pre-migration, byte-identical)`);
console.log(`migrated snapshot sha256 ${await sha256(dstSnap)}`);
if (failures > 0) {
  console.error(`\nMIGRATE-COPY INVALID: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nMigrated bundle copy ready at ${values.out} — run the harness with --bundle ${values.out}`);
process.exit(0);
