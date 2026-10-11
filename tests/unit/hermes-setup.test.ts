import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, readlinkSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { setupHermesPlugin, hermesPluginState } from "../../src/hermes-setup.ts";

let root: string;
let src: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clawmem-hermes-"));
  src = join(root, "src-hermes");
  home = join(root, "hermes-home");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "plugin.yaml"), "name: clawmem\nversion: 9.9.9\n");
  writeFileSync(join(src, "__init__.py"), "# plugin\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("setup hermes", () => {
  it("links a fresh install", () => {
    const r = setupHermesPlugin({ mode: "link", sourceDir: src, hermesHome: home });
    expect(r.action).toBe("linked");
    const target = join(home, "plugins", "clawmem");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(resolve(readlinkSync(target))).toBe(resolve(src));
    expect(hermesPluginState(src, home)).toMatchObject({ kind: "linked", current: true });
  });

  it("is a no-op when already linked", () => {
    setupHermesPlugin({ mode: "link", sourceDir: src, hermesHome: home });
    expect(setupHermesPlugin({ mode: "link", sourceDir: src, hermesHome: home }).action).toBe("unchanged");
  });

  it("moves a stale copy aside and links", () => {
    const target = join(home, "plugins", "clawmem");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "plugin.yaml"), "name: clawmem\nversion: 0.0.1\n");
    expect(hermesPluginState(src, home)).toMatchObject({ kind: "copy", current: false });
    const r = setupHermesPlugin({ mode: "link", sourceDir: src, hermesHome: home });
    expect(r.action).toBe("linked");
    expect(r.backup && existsSync(r.backup)).toBe(true);
    expect(readdirSync(join(home, "plugins")).some(n => n.startsWith("clawmem.bak-"))).toBe(true);
  });

  it("copy mode reports a matching copy as current", () => {
    expect(setupHermesPlugin({ mode: "copy", sourceDir: src, hermesHome: home }).action).toBe("copied");
    expect(hermesPluginState(src, home)).toMatchObject({ kind: "copy", current: true });
    expect(setupHermesPlugin({ mode: "copy", sourceDir: src, hermesHome: home }).action).toBe("unchanged");
  });

  it("detects a broken link and repairs it", () => {
    mkdirSync(join(home, "plugins"), { recursive: true });
    const gone = join(root, "gone");
    require("fs").symlinkSync(gone, join(home, "plugins", "clawmem"), "dir");
    expect(hermesPluginState(src, home).kind).toBe("broken-link");
    expect(setupHermesPlugin({ mode: "link", sourceDir: src, hermesHome: home }).action).toBe("linked");
  });

  it("removes either form", () => {
    setupHermesPlugin({ mode: "link", sourceDir: src, hermesHome: home });
    expect(setupHermesPlugin({ mode: "remove", sourceDir: src, hermesHome: home }).action).toBe("removed");
    expect(hermesPluginState(src, home).kind).toBe("absent");
  });
});
