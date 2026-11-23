/**
 * BACKLOG 82.3, D6 — one minimum Bun, named the same everywhere (operator ruling 36 A, 2026-11-21: 1.3.14, the
 * lowest version the whole suite passed on). The source of the number is `MINIMUM_BUN` in `src/sqlite-guard.ts`.
 * The upgrade guide and the release notes join this test when their v0.43.7 sections are written.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MINIMUM_BUN } from "../../src/sqlite-guard.ts";

const root = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

describe("the minimum Bun is named once and the same everywhere", () => {
  test("it is a full version number", () => {
    expect(MINIMUM_BUN).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("package.json `engines` names it", () => {
    expect(JSON.parse(read("package.json")).engines.bun).toBe(`>=${MINIMUM_BUN}`);
  });

  test("the README's prerequisites name it, and no older one", () => {
    const text = read("README.md");
    expect(text).toContain(`[Bun](https://bun.sh) v${MINIMUM_BUN}+`);
    expect(text).not.toContain("[Bun](https://bun.sh) v1.0+");
  });

  test("the quickstart's prerequisites name it, and no older one", () => {
    const text = read("docs/quickstart.md");
    expect(text).toContain(`[Bun](https://bun.sh) v${MINIMUM_BUN}+`);
    expect(text).not.toContain("[Bun](https://bun.sh) v1.0+");
  });

  test("troubleshooting quotes the `engines` line as it is", () => {
    const text = read("docs/troubleshooting.md");
    expect(text).toContain(`engines: bun >=${MINIMUM_BUN}`);
    expect(text).not.toContain("engines: bun >=1.0.0");
  });

  test("this suite does not run below it", () => {
    expect(Bun.semver.order(Bun.version, MINIMUM_BUN)).toBeGreaterThanOrEqual(0);
  });
});
