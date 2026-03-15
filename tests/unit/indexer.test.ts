import { describe, it, expect } from "bun:test";
import {
  shouldExclude,
  hashContent,
  extractTitle,
  parseDocument,
  computeQualityScore,
} from "../../src/indexer.ts";

// ─── shouldExclude ──────────────────────────────────────────────────

describe("shouldExclude", () => {
  it("excludes .git directories", () => {
    expect(shouldExclude(".git/config")).toBe(true);
    expect(shouldExclude("repo/.git/HEAD")).toBe(true);
  });

  it("excludes node_modules", () => {
    expect(shouldExclude("node_modules/pkg/index.js")).toBe(true);
  });

  it("excludes gits directories", () => {
    expect(shouldExclude("gits/repo/file.md")).toBe(true);
  });

  it("excludes _PRIVATE", () => {
    expect(shouldExclude("_PRIVATE/notes.md")).toBe(true);
  });

  it("excludes hidden directories (dot-prefixed)", () => {
    expect(shouldExclude(".hidden/file.md")).toBe(true);
    expect(shouldExclude("path/.secret/file.md")).toBe(true);
  });

  it("does NOT exclude normal paths", () => {
    expect(shouldExclude("docs/notes.md")).toBe(false);
    expect(shouldExclude("research/analysis.md")).toBe(false);
    expect(shouldExclude("MEMORY.md")).toBe(false);
  });

  it("excludes nested excluded dirs", () => {
    expect(shouldExclude("project/gits/repo/file.md")).toBe(true);
    expect(shouldExclude("deep/path/node_modules/pkg.md")).toBe(true);
  });

  it("excludes scraped directory", () => {
    expect(shouldExclude("scraped/page.md")).toBe(true);
  });

  it("excludes dist and build", () => {
    expect(shouldExclude("dist/bundle.js")).toBe(true);
    expect(shouldExclude("build/output.md")).toBe(true);
  });
});

// ─── hashContent ────────────────────────────────────────────────────

describe("hashContent", () => {
  it("produces consistent SHA-256 hex digest", () => {
    const h1 = hashContent("hello world");
    const h2 = hashContent("hello world");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA-256 hex
  });

  it("produces different hashes for different content", () => {
    const h1 = hashContent("content A");
    const h2 = hashContent("content B");
    expect(h1).not.toBe(h2);
  });
});

// ─── extractTitle ───────────────────────────────────────────────────

describe("extractTitle", () => {
  it("extracts first heading from markdown", () => {
    expect(extractTitle("# My Title\n\nBody text", "file.md")).toBe("My Title");
  });

  it("extracts h2 heading", () => {
    expect(extractTitle("## Section Title\nContent", "file.md")).toBe("Section Title");
  });

  it("falls back to filename without extension", () => {
    expect(extractTitle("No heading here", "my-notes.md")).toBe("my-notes");
  });

  it("handles files with no headings", () => {
    expect(extractTitle("Just plain text", "readme.txt")).toBe("readme");
  });

  it("trims whitespace from heading", () => {
    expect(extractTitle("#   Spaced Title  \n", "file.md")).toBe("Spaced Title");
  });
});

// ─── parseDocument ──────────────────────────────────────────────────

describe("parseDocument", () => {
  it("extracts frontmatter fields from YAML", () => {
    const content = `---
content_type: decision
tags: [api, rest]
domain: backend
---

# Decision

Body here.`;
    const { body, meta } = parseDocument(content, "file.md");
    expect(meta.content_type).toBe("decision");
    expect(meta.tags).toEqual(["api", "rest"]);
    expect(meta.domain).toBe("backend");
    expect(body.trim()).toContain("# Decision");
  });

  it("infers content_type from path when not in frontmatter", () => {
    const { meta } = parseDocument("# Notes\nSome text", "sessions/2026-03-01.md");
    expect(meta.content_type).toBe("handoff");
  });

  it("handles documents without frontmatter gracefully", () => {
    const { body, meta } = parseDocument("# Just a title\nBody", "random.md");
    expect(body).toContain("# Just a title");
    expect(meta.content_type).toBe("note");
  });

  it("returns body without frontmatter delimiters", () => {
    const content = `---
title: Test
---

Body content here.`;
    const { body } = parseDocument(content, "file.md");
    expect(body.trim()).toBe("Body content here.");
    expect(body).not.toContain("---");
  });
});

// ─── computeQualityScore ────────────────────────────────────────────

describe("computeQualityScore", () => {
  it("returns base 0.3 for empty doc with no meta", () => {
    const score = computeQualityScore("", { content_type: "note" });
    // base 0.3, stub penalty -0.1 (length < 50) = 0.2
    expect(score).toBeCloseTo(0.2, 2);
  });

  it("boosts for document length > 200", () => {
    const short = computeQualityScore("x".repeat(100), { content_type: "note" });
    const medium = computeQualityScore("x".repeat(300), { content_type: "note" });
    expect(medium).toBeGreaterThan(short);
  });

  it("boosts for document length > 500", () => {
    const medium = computeQualityScore("x".repeat(300), { content_type: "note" });
    const long = computeQualityScore("x".repeat(600), { content_type: "note" });
    expect(long).toBeGreaterThan(medium);
  });

  it("boosts for headings", () => {
    const noHeading = computeQualityScore("x".repeat(300), { content_type: "note" });
    const heading = computeQualityScore("## Section\n" + "x".repeat(300), { content_type: "note" });
    expect(heading).toBeGreaterThan(noHeading);
  });

  it("boosts for bullet lists", () => {
    const noList = computeQualityScore("x".repeat(300), { content_type: "note" });
    const list = computeQualityScore("- item one\n" + "x".repeat(300), { content_type: "note" });
    expect(list).toBeGreaterThan(noList);
  });

  it("boosts for decision keywords", () => {
    const plain = computeQualityScore("x".repeat(300), { content_type: "note" });
    const decision = computeQualityScore("We decided to use REST " + "x".repeat(300), { content_type: "note" });
    expect(decision).toBeGreaterThan(plain);
  });

  it("boosts for fix/bug keywords", () => {
    const plain = computeQualityScore("x".repeat(300), { content_type: "note" });
    const fix = computeQualityScore("Fixed the authentication bug " + "x".repeat(300), { content_type: "note" });
    expect(fix).toBeGreaterThan(plain);
  });

  it("boosts for rich frontmatter (up to +0.15)", () => {
    const sparse = computeQualityScore("x".repeat(300), { content_type: "note" });
    const rich = computeQualityScore("x".repeat(300), {
      content_type: "note",
      tags: ["a", "b"],
      domain: "backend",
      workstream: "auth",
    });
    expect(rich).toBeGreaterThan(sparse);
    expect(rich - sparse).toBeLessThanOrEqual(0.15 + 0.001);
  });

  it("penalizes trivial stubs (<50 chars)", () => {
    const stub = computeQualityScore("Short.", { content_type: "note" });
    expect(stub).toBeLessThan(0.3); // base minus penalty
  });

  it("clamps between 0 and 1.0", () => {
    // Max possible: base 0.3 + length 0.2 + heading 0.1 + list 0.05 + decision 0.15 + fix 0.1 + meta 0.15 = 1.05 → clamped to 1.0
    const maxDoc = "## Heading\n- item\nWe decided to fix the bug\n" + "x".repeat(600);
    const score = computeQualityScore(maxDoc, {
      content_type: "decision",
      tags: ["a"],
      domain: "d",
      workstream: "w",
    });
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});
