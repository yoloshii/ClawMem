/**
 * `clawmem setup hermes` — install the Hermes MemoryProvider plugin.
 *
 * Default is a symlink from `$HERMES_HOME/plugins/clawmem` to this install's `src/hermes`, so an
 * upgrade of ClawMem (npm/bun global or a source checkout) reaches Hermes on its next restart with no
 * copy step. `--copy` keeps the previous copy-based install for setups that cannot follow symlinks.
 * An existing copy is moved aside (never deleted) before linking.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve } from "path";
import { isoNow } from "./clock.ts";

export type HermesSetupMode = "link" | "copy" | "remove";

export interface HermesSetupOptions {
  mode: HermesSetupMode;
  sourceDir: string;
  hermesHome?: string;
}

export interface HermesSetupResult {
  mode: HermesSetupMode;
  action: "linked" | "copied" | "unchanged" | "removed" | "absent";
  hermesHome: string;
  target: string;
  backup?: string;
  messages: string[];
}

export function resolveHermesHome(explicit?: string): string {
  return resolve(explicit || process.env.HERMES_HOME || join(process.env.HOME || "~", ".hermes"));
}

function dirDigest(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === "__pycache__" || name.startsWith(".")) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, `${rel}${name}/`);
      else { h.update(`${rel}${name}\0`); h.update(readFileSync(p)); }
    }
  };
  walk(dir, "");
  return h.digest("hex");
}

export type HermesPluginState =
  | { kind: "absent"; target: string }
  | { kind: "linked"; target: string; linkTo: string; current: boolean }
  | { kind: "copy"; target: string; current: boolean }
  | { kind: "broken-link"; target: string; linkTo: string };

/** What is installed at `$HERMES_HOME/plugins/clawmem`, and whether it matches `sourceDir`. */
export function hermesPluginState(sourceDir: string, hermesHome?: string): HermesPluginState {
  const target = join(resolveHermesHome(hermesHome), "plugins", "clawmem");
  let st;
  try { st = lstatSync(target); } catch { return { kind: "absent", target }; }
  if (st.isSymbolicLink()) {
    const linkTo = resolve(dirname(target), readlinkSync(target));
    if (!existsSync(linkTo)) return { kind: "broken-link", target, linkTo };
    return { kind: "linked", target, linkTo, current: resolve(linkTo) === resolve(sourceDir) };
  }
  let current = false;
  try { current = dirDigest(target) === dirDigest(sourceDir); } catch { /* unreadable copy → stale */ }
  return { kind: "copy", target, current };
}

export function setupHermesPlugin(opts: HermesSetupOptions): HermesSetupResult {
  const hermesHome = resolveHermesHome(opts.hermesHome);
  const pluginsDir = join(hermesHome, "plugins");
  const target = join(pluginsDir, "clawmem");
  const messages: string[] = [];
  const source = resolve(opts.sourceDir);
  if (opts.mode !== "remove" && !existsSync(join(source, "plugin.yaml"))) {
    throw new Error(`Hermes plugin source not found at ${source} (expected plugin.yaml)`);
  }
  const state = hermesPluginState(source, hermesHome);

  const moveAside = (): string => {
    const backup = `${target}.bak-${isoNow().replace(/[:.]/g, "-")}`;
    renameSync(target, backup);
    messages.push(`Moved existing plugin aside: ${backup}`);
    return backup;
  };

  if (opts.mode === "remove") {
    if (state.kind === "absent") return { mode: opts.mode, action: "absent", hermesHome, target, messages: [`No Hermes plugin at ${target}`] };
    if (state.kind === "linked" || state.kind === "broken-link") unlinkSync(target);
    else rmSync(target, { recursive: true });
    messages.push(`Removed Hermes plugin at ${target}`);
    return { mode: opts.mode, action: "removed", hermesHome, target, messages };
  }

  mkdirSync(pluginsDir, { recursive: true });
  let backup: string | undefined;

  if (opts.mode === "link") {
    if (state.kind === "linked" && state.current) {
      messages.push(`Hermes plugin already linked: ${target} → ${state.linkTo}`);
      return { mode: opts.mode, action: "unchanged", hermesHome, target, messages };
    }
    if (state.kind === "linked" || state.kind === "broken-link") unlinkSync(target);
    else if (state.kind === "copy") backup = moveAside();
    symlinkSync(source, target, "dir");
    messages.push(`Linked Hermes plugin: ${target} → ${source}`);
    return { mode: opts.mode, action: "linked", hermesHome, target, backup, messages };
  }

  // copy
  if (state.kind === "copy" && state.current) {
    messages.push(`Hermes plugin copy is current: ${target}`);
    return { mode: opts.mode, action: "unchanged", hermesHome, target, messages };
  }
  if (state.kind === "linked" || state.kind === "broken-link") unlinkSync(target);
  else if (state.kind === "copy") backup = moveAside();
  cpSync(source, target, { recursive: true, filter: src => !src.includes("__pycache__") });
  messages.push(`Copied Hermes plugin: ${source} → ${target}`);
  return { mode: opts.mode, action: "copied", hermesHome, target, backup, messages };
}
