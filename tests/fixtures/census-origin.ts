/**
 * Run by `tests/unit/binding-census.test.ts` in a child process with the census recorder on: one statement this
 * file prepares itself (origin `test`) and one ClawMem prepares (origin `src`), each binding a string.
 */
import { createStore } from "../../src/store.ts";
import { normalizedContent } from "../../src/text-policy.ts";

const store = createStore(process.argv[2]!);
const { body, hash } = normalizedContent("census origin body");
store.insertContent(hash, body, "2026-11-23T00:00:00.000Z");                          // prepared under src/
store.db.prepare(`UPDATE content SET created_at = ? WHERE hash = ?`).run("2026-11-23T01:00:00.000Z", hash);  // prepared here
store.close();
