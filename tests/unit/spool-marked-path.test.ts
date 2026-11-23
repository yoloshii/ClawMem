/**
 * BACKLOG 82.3, Codex T1 S4 (rulings 68 A / 69 A) — which spool jobs name a mark-led identifier.
 *
 * A display path is bound as TWO identifiers, split at its first slash: the collection before it and the relative path
 * after it (`resolveDocId` in src/stop-feedback.ts). Only those two can be refused, so only a mark at the start of either
 * makes a job inadmissible. A mark at the start of a deeper segment (`notes/sub/<mark>x.md`) is inside the relative path,
 * which binds as it is: such a job is applied, never discarded with every other entry it carries. The manifest's display
 * paths are bound the same way and are checked the same way. No mark is typed into this file.
 */
import { describe, expect, test } from "bun:test";
import {
  markedIdentifierInJob, serializeSurfacingBookkeepingJob, validateSurfacingBookkeepingJob, type SurfacingBookkeepingJob,
} from "../../src/hooks/surfacing-bookkeeping.ts";

const MARKS: [string, string][] = [["U+FEFF", String.fromCharCode(0xfeff)], ["U+FFFE", String.fromCharCode(0xfffe)]];

function job(paths: string[], manifest?: string[]): SurfacingBookkeepingJob {
  return {
    v: 1, kind: "surfacing-bookkeeping", jobId: "job-s4", sessionId: "sess-1", turnIndex: 0, usageId: 7, queryHash: "qh",
    injectedPaths: paths, estimatedTokens: 10, vaults: [{ vault: null, docs: paths.map(p => ({ displayPath: p, searchScore: 0.9 })) }],
    ...(manifest ? { manifest: manifest.map(p => ({ vault: null, displayPath: p, displayedTitle: "t" })) as any } : {}),
  };
}

describe("S4: a spool job names a mark-led identifier only at the start of its collection or its relative path", () => {
  test.each(MARKS)("%s at the start of a nested file name: the job is admissible and serialises, its other entries with it", (_n, mark) => {
    const j = job(["notes/sub/" + mark + "x.md", "notes/plain.md"]);
    expect(markedIdentifierInJob(j)).toBeNull();
    expect(validateSurfacingBookkeepingJob(j)).toBe(true);
    expect(serializeSurfacingBookkeepingJob(j)).not.toBeNull();
  });

  test.each(MARKS)("%s after a doubled slash: the relative path starts with a slash, not the mark — admissible", (_n, mark) => {
    expect(markedIdentifierInJob(job(["notes//" + mark + "x.md"]))).toBeNull();
  });

  test.each(MARKS)("%s at the start of the relative path: refused", (_n, mark) => {
    expect(markedIdentifierInJob(job(["notes/" + mark + "x.md"]))).toBe("injected path");
    expect(serializeSurfacingBookkeepingJob(job(["notes/" + mark + "x.md"]))).toBeNull();
  });

  test.each(MARKS)("%s at the start of the collection: refused", (_n, mark) => {
    expect(markedIdentifierInJob(job([mark + "notes/x.md"]))).toBe("injected path");
  });

  test.each(MARKS)("%s in a display path only (not in injectedPaths): refused as a display path", (_n, mark) => {
    const j = job(["notes/plain.md"]);
    j.vaults[0]!.docs.push({ displayPath: "notes/" + mark + "y.md", searchScore: 0.5 });
    expect(markedIdentifierInJob(j)).toBe("display path");
  });

  test.each(MARKS)("%s in a manifest display path: refused as a manifest path; nested in the manifest: admissible", (_n, mark) => {
    expect(markedIdentifierInJob(job(["notes/plain.md"], ["notes/" + mark + "z.md"]))).toBe("manifest path");
    expect(markedIdentifierInJob(job(["notes/plain.md"], ["notes/deep/" + mark + "z.md"]))).toBeNull();
  });

  test.each(MARKS)("%s at the start of the session id: refused (unchanged)", (_n, mark) => {
    const j = job(["notes/plain.md"]);
    j.sessionId = mark + "s";
    expect(markedIdentifierInJob(j)).toBe("session id");
  });

  test("control: a plain job is admissible", () => {
    expect(markedIdentifierInJob(job(["notes/a.md"], ["notes/a.md"]))).toBeNull();
  });
});
