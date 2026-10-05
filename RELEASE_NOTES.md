# ClawMem — Release Notes

For upgrade instructions (migration steps, opt-in features, verification commands), see [docs/guides/upgrading.md](docs/guides/upgrading.md). This file is the chronological feature record, newest first.

---

## v0.43.0 — a turn started by a task's notice, another session or a bare command is its own turn

The Stop hooks and the PreCompact hook start a turn at each typed prompt. Through v0.42.0 nothing else started one: a
prompt command run without arguments (`/review`), a background task's `<task-notification>` and a message from another
Claude Code session were metadata, so the assistant's reply to any of them was recorded as part of the previous typed
prompt's turn. The observer read that reply as an answer to the earlier prompt, the handoff merged the two turns into
one digest, `feedback-loop` credited a note the reply named to the earlier prompt's surfacing, and the reason the turn
happened was dropped. Input received while the assistant was working (a `queued_command` attachment) was read by
nothing, the user's own mid-turn prompts included.

### What changed

- **What opens a turn.** A typed prompt or a prompt command, now with or without arguments (`/name`); a built-in
  command is still recognised by the output that follows it, now also in the `system`/`local_command` row newer Claude
  Code versions write. A background task's notice and another session's message open a turn too: on Claude Code
  2.1.278 and later by the row's `turnOrigin`, which marks exactly the rows that open a turn (a notice row without it
  opens none); on older versions and other hosts by the row's shape. Input received while the assistant was working
  never opens a turn.
- **A notice is a label, never a message body.** The observer, the handoff and PreCompact see a notice as
  `[background task <status>] <summary>` (at most 300 characters, never the task's output), `[message from <session
  name>]` (never the message's text or its sender's socket path), `[message from a background agent]`, or `[turn
  started by <origin>]`. A prompt typed while the assistant worked keeps the user's words
  (`[typed while the assistant was working] …`, at most 2,000 characters); queued input of unknown origin is labelled
  without its text. The assistant's reply to a notice is recorded as before, and it may restate the notice.
- **Each consumer follows.** The observer numbers turns at every opening and restores a long turn's opening line —
  the typed request or the label — when its 100-message window drops it. A handoff digest's request is the turn's
  opening text, and the streamed path for a turn larger than one read now digests exactly what the normal path does,
  short replies included. `feedback-loop` closes every turn at the next opening, and pairs a surfacing row with a
  notice's turn when the row's prompt hash equals the hash of the text the hook received for that notice (for another
  session's message, its `<cross-session-message>` element); a row with no such match is concluded unattributable,
  never credited to a neighbouring turn. PreCompact's last request is the last text of ten or more characters the user
  typed (through v0.42.0, more than ten) — a mid-turn prompt included, a bare command (`/pre-compact`) never — and a
  decision's stored context after a notice is the notice's label, not the earlier prompt.
- **A bounded read** that ends right after a built-in command with arguments (`/model sonnet`) now looks at the next
  line before classifying it, whatever the caller asked about the read's end; through v0.42.0 such a record could read
  as a turn start. A next line larger than the read is judged from its first 64 KiB, which now also recognises a
  `system`/`local_command` row by its own `type` and `subtype`, whatever its content.
- **Migration, automatic.** The observer's checkpoint contract now carries the transcript classifier's revision, so a
  checkpoint written by v0.42.0 or earlier restarts its range when it is next processed. A handoff digest records how
  it was derived (`derivRev`); a provisional digest (a turn still in progress) written by an older version is derived
  again when it is re-planned, while settled digests are left as they are.
- **Known limits.** A hand-back from a background agent is paired by its row's raw text, because the form the
  surfacing hook receives for it is unmeasured; it normally does not match, so its turn is normally concluded
  unattributable. The `context-surfacing` hook is unchanged: it still stores the prompt it receives, a task's notice
  or another session's message included, as its prior-query input. A next line larger than the read is still judged
  from its first 64 KiB without being parsed: escaped characters, a quote inside a key, a nested field, a host's
  marker row shaped like command output, or invalid JSON, inside that prefix or past it, can make it misjudge whether
  the command before it was a built-in, as in v0.42.0. The check of the row's own `type` and `subtype` that this
  version adds can be misled by the last of these, and it takes a `system`/`local_command` row that carries an
  assistant message for command output, where the full parse reads the assistant's reply.
- **Tests:** `tests/unit/turn-starters.test.ts`.
- **Docs:** `docs/concepts/architecture.md` (Stop pipeline: turns; the surfacing hook's stored prompts),
  `docs/guides/upgrading.md`, `docs/guides/setup-hooks.md`, `docs/troubleshooting.md`, `AGENTS.md`.

### Upgrading

No action needed beyond upgrading every process that shares the vault: the hooks take the new version at their next
run; restart `clawmem watch`, whose worker runs the same readers. Neither plugin's own files changed, so a copied
OpenClaw or Hermes plugin need not be copied again. When a range is next processed, an observer checkpoint written by
an older version restarts it from its first window (the range is not lost), and the digest of a turn still in progress
is derived again; settled work is not redone. See [upgrading](docs/guides/upgrading.md).

### Verification

Run on v0.42.0, 61 of the 95 new tests fail and 31 pass; the 31 guard behaviour the change must keep (metadata stays
metadata, the hard exclusions, what is never a last request, the trailing command a bounded read holds back, local
output that is not over-matched), and four of those are cases a first draft of this change broke: an assistant message
or a tool result inside another envelope, and metadata that is present but invalid. The other 3 are `todo`: the limits
above of the check of a line larger than the read. One existing test changed: the PreCompact reader's rendering
contract (`tests/unit/compaction-transcript.test.ts`) now expects a task's notice as its label; every other row
renders as before. Thirty-four mutants, each undoing one part of the change, each fail at least one new test: an
opening notice that opens nothing; no fallback by shape for older writers; a task's label read from anywhere in the
element or past its header; a peer's body as its label, or its raw row as its identity; an envelope that outranks an
assistant message; invalid metadata read as absent; cuts that split a surrogate pair; a mid-turn prompt that opens a
turn; a bare prompt command as metadata; no recognition of a `system`/`local_command` row, in a next line or in the 64
KiB prefix; no look past a read's end; a prompt command held back at the end of a read; a first cursor that skips an
answered notice; a long turn's opening line not restored; turn numbers, digest requests and streamed reads that take
only typed prompts as openings; a digest never derived again, or given to a turn with nothing in it; PreCompact's
ten-character rule, bare and queued commands as a last request, and a mid-turn prompt never one; a notice's label in
the open questions; a checkpoint contract without the classifier's revision; a notice's turn never paired, or never
closing the turn before it. Full suite on Bun 1.4.2: 3,666 pass / 0 fail across 189 files (3 todo); tsc unchanged. The
adversarial review (one session) cleared the design at its fourth turn, after 15 findings, one of which (the surfacing
hook storing what it receives) is outside this change, as Known limits says. It cleared the implementation at its
fifth, after 13: 9 fixed, 2 in code this change dropped, and 2 accepted as the limits above of the check of a line
larger than the read. Six more turns cleared the docs and these notes, after 4 findings.

### What didn't change

A typed prompt is read as before, and a built-in command whose output follows it is still a setting change. The read
bound (64 MB; 4 MB for the turns read as context) and v0.42.0's check of a next line larger than the read are kept.
The observer's instructions, parser and grammar, the vault's schema, the `context-surfacing` hook and `clawmem mine`
are unchanged.

---

## v0.42.0 — `clawmem serve` turns web pages away and requires a token

`clawmem serve` binds 127.0.0.1, and through v0.41.5 that was its only defence, but a web page in your browser can
reach a loopback port. With no token configured — the default — any page could change the vault. A `text/plain` POST,
which a browser sends without a preflight, was parsed as JSON, so a page could archive documents (`/lifecycle/sweep`),
restore every archived document (`/lifecycle/restore`), reindex, rebuild the graphs, or pin, snooze and forget a
document whose docid it knew. A JSON POST got through as well: the preflight answered every origin with `*`. And with
no Host check, DNS rebinding — a page whose host name is pointed at 127.0.0.1 after it loads — could read the whole
vault from `/export`.

### What changed

- **A token, on by default.** Every request, `/health` included, needs `Authorization: Bearer <token>`, or it gets
  `401`. The token is `CLAWMEM_API_TOKEN` when that is set and non-empty. Otherwise `serve` generates one on its first
  start in the token file `serve-token` under `CLAWMEM_CONFIG_DIR` (default `~/.config/clawmem`): 43 random characters,
  mode 0600, published without ever overwriting a file, so two servers starting at once agree. Every token must be
  32–4096 characters of `A–Z a–z 0–9 - . _ ~ + /` with optional trailing `=`. `serve` refuses to start on a shorter or
  malformed token, on a token file other users can read or that is a symlink, and on a config directory that is not
  yours or that its group or others can write; its messages name the fix and never contain the token. An empty
  `CLAWMEM_API_TOKEN` now means "use the file", never "open". The comparison takes constant time. The token stops web
  pages; it is not a permission system against programs running as your user, which can read it.
- **`clawmem serve-token`** prints the token `serve` would use under the current environment, creating the file if
  needed: `curl -H "Authorization: Bearer $(clawmem serve-token)" …`.
- **`clawmem serve --no-token`** serves without a token, on a loopback bind only, with a warning at every start. It is
  refused on any other bind. Pages from other origins are still refused, but a page served from a loopback origin, or
  from an entry of `CLAWMEM_ALLOWED_ORIGINS`, can call it, and so can any local program.
- **Origin and Host checks** run before routing and answer `403`. A request is refused when its `Origin` names anything
  but a loopback host or an entry of the new `CLAWMEM_ALLOWED_ORIGINS` (`Origin: null` included), or when its `Host` is
  not a loopback host, a named bind's own address, or an entry of the new `CLAWMEM_ALLOWED_HOSTS`. On a wildcard bind
  with no `CLAWMEM_ALLOWED_HOSTS` the legitimate Host cannot be known, so it is not checked; the startup log says so, and
  the token alone stops a rebound page there. Both headers are parsed strictly: credentials, paths, a duplicated `Host`,
  ports outside 1–65535 and invalid addresses are refused, and loopback is recognised in its IPv4 and IPv6 spellings
  (127.0.0.0/8, `[::1]`, `[::ffff:127.0.0.1]`). `serve` refuses to start on an allowlist entry it cannot parse or an
  empty one, so a stray comma cannot turn the Host check off.
- **JSON bodies only.** Every POST, bodyless included, needs `Content-Type: application/json`, or it gets `415`, so a
  POST from a page on another origin always needs a CORS preflight, which a foreign origin fails.
- **Exact CORS.** A preflight from an allowed origin is answered with that origin, never `*`, and responses to it carry
  the same `Access-Control-Allow-Origin` with `Vary: Origin`; other origins get no CORS headers. The
  `http://localhost:*` header, which no browser matched, is gone.
- **A request with no `Host` header** (HTTP/1.0) no longer fails with `500`: its relative request URL is resolved
  before routing.
- **The Hermes and OpenClaw plugins learn the token.** The Hermes plugin in external mode (its default) sends
  `CLAWMEM_API_TOKEN` when set and otherwise reads the token file on every call. A plugin that starts its own `serve` —
  the Hermes plugin in managed mode, and the OpenClaw plugin, whose gateway always starts one — first runs
  `clawmem serve-token` through the same binary and environment and passes the printed token to it, so a token in the
  ClawMem checkout's `.env` (which `bin/clawmem` applies only to unset variables) can no longer leave a plugin and its
  `serve` disagreeing. It keeps that token when its `serve` loses the port to another one started the same way (a
  systemd service included) and resolves it again only when its agent or gateway restarts. Neither plugin sends an
  invalid token or puts any part of a token in an error or a log line.
- **Tests:** a standing security suite in `tests/security/`, and the plugins' token handling in
  `tests/unit/rest-clients-token.test.ts`.
- **Docs:** `docs/reference/rest-api.md` (authentication, browser protection, CORS, cross-machine access),
  `docs/reference/configuration.md`, `docs/reference/cli.md`, `docs/guides/hermes-plugin.md`,
  `docs/guides/openclaw-plugin.md`, `docs/guides/systemd-services.md`, `docs/introduction.md`,
  `docs/guides/upgrading.md`, AGENTS.md.

### Upgrading

**Every REST client must now send the token.** Restart `clawmem serve`: it generates the token file on its first start,
or uses `CLAWMEM_API_TOKEN`. Copy the Hermes plugin's contents over the installed one, re-run `clawmem setup openclaw`
for a copied OpenClaw plugin (a linked one picks it up), and restart the agent. Scripts add
`-H "Authorization: Bearer $(clawmem serve-token)"` to every request and `-H "Content-Type: application/json"` to every
POST. A `CLAWMEM_API_TOKEN` shorter than 32 characters is refused: unset it, or set a random value
(`openssl rand -base64 32`) for `serve` and its clients alike. Behind a proxy, or with clients that reach a wildcard
bind by host name, list those names in `CLAWMEM_ALLOWED_HOSTS`; a browser frontend on a non-loopback origin goes in
`CLAWMEM_ALLOWED_ORIGINS`. The vault is not touched.

### Verification

The new tests were written first and run on v0.41.5. Of the 22 transport tests, 20 failed, each for the reason its
name gives; the 2 that passed are controls (a JSON media type with parameters, and loopback Origins in every
spelling). One of the failures was a defect of its own: a request with no `Host` header crashed the handler with
`500`. The 19 guard and token-resolver tests could not run there, since the module they test does not exist; 7 more
were added during review. Of the 9 client tests, the 3 controls passed (the plugins' external calls and OpenClaw's
environment overlay, against a server that was open) and the 6 others failed: the managed Hermes cases, the managed
OpenClaw token, and a header-unsafe token that both plugins sent and logged; 4 more, added during review, fail on
client readers that skip the config-directory check or stop after one short read. Seventeen mutants each fail at least
one test: no Origin check, no Host check, no JSON check, a port read through the URL parser (which drops `:80`), a
token file opened through a symlink, no 32-character floor, the Hermes plugin ignoring its managed token, OpenClaw's
environment overlay reversed, the Hermes plugin sending an invalid token, empty allowlist entries dropped, a
token-file write that ignores a short byte count, a link-race loser returning its own token, a loser reading the
winner's file unchecked, no startup warnings, no Windows warning, and either plugin's token-file reader stopping after
one read. The six existing test files that start the server now send the token and keep their route-level assertions.
Full suite on Bun 1.4.2: 3,574 pass / 0 fail across 188 files. The adversarial review (one session) cleared the design
at its fourth turn, after 12 findings, and this implementation at its fourth, after 9: 1 noted by a turn that the
reviewer's server ended before its verdict, then 7 and 1.

### What didn't change

The routes, their parameters and their responses; the MCP server (stdio, not HTTP); the hooks; `serve`'s default
address and port.

---

## v0.41.5 — a window whose first message fits under a smaller CONTEXT is never held

v0.41.2 fits each observer window in tokens: it takes the fullest form of the window's CONTEXT that leaves 512 tokens
for the transcript, then fits whole turns under it. When the window's first message did not fit under that form, the
window was held as `capacity:` without trying a smaller form, under which the message fit. A later window's CONTEXT
grows with the transcript's tail, the turn's opening request and the titles recorded so far, so a window
could be held while it fit without them, again on every retry. A format retry's feedback, added to the fullest form,
held a window the same way (`capacity: the format retry's feedback leaves no room`). The hold's reason also reported
the room under the fullest form, not the real limit. Measured on v0.41.4 with the suite's tokenizer fake at a
4,096-token context, a 1,006-token final answer was held with 551 tokens of room, while the form with only the turn's
request and the titles left 1,222.

### What changed

- **`src/observer.ts` `fitWindow`** chooses the CONTEXT form as before. When the window's first message does not fit
  under it, each smaller form is tried in order, fullest first, and the first that fits sends the window. For a later
  window the forms are the tail with the turn's request (when the tail does not already show it) and the titles, then
  the request and the titles, then the titles, then none; for window 1, the CONTEXT section, its titles alone, none. A
  form that repeats an earlier one is tried once. A window that fits under the chosen form is unchanged, byte for byte,
  with the same token counts in the same order. The line fitting moved, unchanged, into `fitLines`.
- **A message that fits under no form** is still held as `capacity: one message needs N tokens; a window holds W`, and
  W is now the room with no CONTEXT, the real limit. The reason still starts `capacity:`, so `clawmem doctor` counts it
  as before.
- **A format retry** re-fits the same way, so its feedback no longer holds a window that fits under a smaller form.
- **The Hermes plugin's timestamps follow the file** (`src/hermes/__init__.py`). A line is stamped as it joins the
  transcript's writes, under the lock that orders them, so a thread can no longer land a line stamped before another
  thread's line after it. A new transcript's header is dated by the line it opens, never later: it was stamped at the
  write, after the first turn's lines, and read 1 ms late about 1 run in 20 of the suite's order check (T29 in
  `tests/unit/stop-hermes.test.ts`), or later still when the first write waited out a failed attempt's pause. The times
  still come from the wall clock, so a clock set back can step one back.
- **Docs:** `docs/concepts/architecture.md` (the CONTEXT forms and the fallback), `docs/guides/upgrading.md` (v0.41.5),
  `docs/guides/hermes-plugin.md` (the transcript format).

### Upgrading

No action needed. Ranges held this way replay at their next attempt; `clawmem repair stop-queue --retry-now held --run`
retries them now. A range still held with `capacity: one message needs …` after the upgrade has a message larger than a
window with no CONTEXT; raise the server's `-c`. Hermes: to take the timestamp fix, copy the plugin's contents over the
installed one and restart Hermes (a symlinked install picks it up on its own); a plugin left as it was keeps working. A
checkpointed range resumes where it stopped, and the observer contract is unchanged: a checkpoint records the line
reached, the observations, the titles and a window bound, and none of them is written or read differently. A window sent
under a smaller form is saved like any other.

### Verification

Five new tests were written first and run on v0.41.4: the four that exercise the fallback failed, each for the reason
its name gives, and the guard passed. They cover a later window sent under the request-and-titles form, one whose
request already sits in the tail sent under the titles alone, a message that fits no form still held and reporting the
room with no CONTEXT, a format retry sent under a smaller form, and later windows that fit keeping the fullest form.
Each checks its geometry against the prompts the fake counted, so a later change to the prompt text fails a named check
instead of testing nothing. Three mutants (no fallback, the emptiest form only, a stale fixed-part count) each fail at
least one test. For the Hermes timestamps, two tests written first failed on v0.41.4: a new transcript's header dated
after the line it opens, under a clock that moves 1 ms per reading, and a line from a second thread landing after a line
stamped later. With either half of the fix undone, its own test fails. The suite's T29 order check
(`tests/unit/stop-hermes.test.ts`), which failed about 1 run in 20 on v0.41.4, passed 40 runs of 40. Full suite on Bun
1.4.2: 3,513 pass / 0 fail across 185 files. The adversarial review cleared the window fitter at its second turn, after
3 findings, all in the notes and the tests, and the Hermes fix at its fourth, after 2 findings, a test's synchronization
and an unqualified promise.

### What didn't change

The 512-token minimum, the CONTEXT forms and their order, how a window that fits is sized, the halving of a cut reply
and its one-line `capacity:` limit (a limit on the reply's size, not the prompt's), the format-retry limit, the parser
and the checkpoint contract. The Hermes transcript's lines keep their keys, their order and their timestamp format.

---

## v0.41.4 — the observer's replies parse, and a reply that is not an answer is never "nothing"

v0.41.2 made the observer's prompt fit the server's context. Its replies still failed on the documented observer
model. In the vault that found this, 35 ranges were quarantined with "no parseable response within the budget"
between the v0.41.2 upgrade and 2026-10-03, and 14 were still held. A read-only re-run of three held ranges against
the documented model (qmd-query-expansion-1.7B) got 2 usable answers from 34 replies:

- 21 replies typed an observation `tool_use`: the transcript renders tool calls as `[tool_use name="…"]`, and the
  parser dropped every block whose type was not on its list.
- 4 replies copied the prompt's own placeholder: the prompt's structure wrote `...` in every field.
- 7 replies came back in the model's query-expansion format. v0.41.3 read a short reply without markup as "nothing
  to record", so a range answered that way committed as empty and was never observed again.
- Every format retry repeated its first reply. Its feedback named a `<content>` tag the schema does not have, said
  nothing about which field failed or what it allows, and quoted 500 characters of the bad reply back.

On a backend whose invocations each afford one call, a window that needed a retry also looped. The retry's state
lived inside the invocation, so the invocation ended `partial`, the range was queued as a continuation (no failure
backoff), and the next invocation sent the same first call again — every minute, indefinitely.

### What changed

- **Only `<none/>` means "nothing".** The prompt asks for exactly `<none/>` when nothing significant happened; the
  sentinel counts alone or inside one complete code fence. An empty reply, prose, or another format is a format
  failure (`empty-reply`, `no-blocks`), never `[]`. A reply that
  holds valid blocks and `<none/>` yields the blocks. The 300-character "plain nothing" rule is gone.
- **The prompt names the types and has nothing to copy.** The type rule lists the nine types and says a type is never
  a transcript role or tool name. The structure's `...` placeholders became `{{type}}`, `{{title}}`, `{{fact}}`,
  `{{entity}}`, `{{why}}`, `{{path}}` skeleton tokens, which the placeholder guards drop when a model copies them. (A
  first draft wrote the type list into the structure's `<type>` line; without the grammar the model copied that line as
  the type in 28 of 39 replies.) The prompt states the escapes (`&lt;` `&gt;` `&amp;`) and the field limits in
  characters.
- **A rejected block says why, in classes.** `type-not-allowed` (with the value's class: `tool-role`,
  `placeholder`, `type-list`, `other`), `type-missing`, `title-missing`, `title-empty`, `title-placeholder`,
  `facts-empty`. A block with no usable fact is now rejected (it was kept with no facts). A held range's reason carries
  the class (`no parseable response: type-not-allowed (tool-role)`), never transcript text.
- **Feedback that can repair.** A format retry names the failing field, its class and the allowed values, and says
  to output exactly `<none/>` if nothing happened. It never mentions `<content>` and never quotes the reply. The
  handoff summary keeps its feedback unchanged, byte for byte.
- **A window ends inside the invocation that started it.** Up to two format retries per window, each a fresh sample
  with that feedback. After a reply that needs a retry — unparseable, cut, a validated oversize, or a refused
  grammar request — every exit before the retry's own reply fails the attempt (`retryable`, with the failure
  backoff, the reason naming that reply's class) instead of queueing a continuation. A one-call backend now takes one backoff step per failure instead of
  looping.
- **A size reduction persists.** A cut reply's halving and an oversize's correction write a shrink-only window
  bound into the range's checkpoint before the smaller window is tried, so the next processor starts small. Repeated
  one-call attempts on a cut window converge. Each validated oversize whose `n_ctx` is below what `/props` claims
  also lowers a ceiling for that `/props` value (7 days; 4 values kept per server), so the next invocation's first
  call fits.
- **Grammar-constrained decoding on llama.cpp.** A server whose `/props` fingerprint is strong (llama-server) and
  the in-process node-llama-cpp model get a GBNF grammar with each request: every type, predicate and concept
  enumerated, the fields bounded, `<none/>` allowed. A refused grammar request — an HTTP 400 (its cause is not
  claimed) or, in process, a grammar that does not compile — turns the grammar off for that server for 24 hours, and
  the observer retries without it at once; a grammarless request must reach that server before the grammar is used
  again. `CLAWMEM_OBSERVER_GRAMMAR=off` disables it. Enforcement is not verified before use: completed replies to
  grammar requests that fail structurally are counted, and `clawmem doctor` reports them.
- **Units, decoding and guards.** Field values are decoded once (`&lt;` `&gt;` `&amp;`), then trimmed, then checked;
  every bound counts code points, so a 41-letter astral subject keeps its triple and a long title is cut without
  splitting a pair. A triple whose subject or object is a tool-call id or a copied rendering (the whole value: an
  entity such as `toolu_abcdef.ts` keeps its triple), or whose subject equals its object, is dropped; repeated facts
  in a block are kept once; an echoed `{{entity}}` or `{{path}}` is dropped. A fact or title that restates one of the
  prompt's own clauses is kept and counted, never dropped.
- **Consolidation fits its prompts (BACKLOG 68.6).** Cluster synthesis and the deductive pass count their prompt
  against the LLM's context and keep the sources that fit; numbering, index bounds, document mapping, the validation
  context and the statistics all use exactly those. Fewer than two sources fit: no synthesis that tick. A cut reply
  is not a synthesis or a deduction.
- **Stale causal runs (BACKLOG 68.2).** The "still in progress after 1 h" warning counts runs started 1–24 hours
  ago. Older ones are reported once, as information: "N unfinished causal run(s) older than 24 hours; not
  automatically replayed".
- **`clawmem repair stop-queue --retry-now <id[,id…]|held> [--limit N]`** makes queued ranges due now (`held`: rows
  whose last error is not a continuation; claimed rows are never touched; at most 50 by default) and prints their ids.
  With `--run`, a pass whose replays all failed no longer ends the drain, and the command reports which of the selected
  ranges it attempted and when the next work is due, counted with each worker's own due rules (an expired claim is
  due now; named vaults' feedback mirrors included).
- **`clawmem doctor`** groups held ranges by class (a v0.41.2–3 reason reads `legacy (unclassified)`), shows a
  server's grammar-off record, and counts structural failures under the grammar.

### Upgrading

- A range's observer checkpoint written by v0.41.2 or v0.41.3 does not match the new contract: its unit restarts at
  line 0 when next reached. A finished range's tombstone still counts.
- Held ranges retry on their own backoff (up to 12 hours apart). To retry them now: `clawmem repair stop-queue
  --retry-now held --run`.
- Ranges v0.41.3 committed as empty after a query-expansion reply are not re-observed.
- The observer's fixed prompt is 110 tokens longer (794 on the documented model, measured): a window holds about 1,660
  transcript tokens at `-c 4096` and 5,400 at `-c 8192`.

### Verification

The three ranges the investigation started from (held for days, 5 or 6 attempts each: 100, 16 and 8 lines) were
re-run read-only against the documented model (llama-server, `-c 8192`) with v0.41.4's code, from line 0 as an upgraded
install will. With the grammar, each finished in one invocation; across 93 calls every reply was structurally valid,
81 held at least one observation and 12 were `<none/>`. Without the grammar, 15 of 29 replies parsed, and 8 of 9
re-runs finished within three invocations. On the same windows, the observer those ranges failed under parsed 2 of 34
replies, and v0.41.3's prompt 4 of 12. The review then tightened the grammar's field boundaries; re-run on the 8-line
range, the server accepted the revised grammar and the range finished in one call.

Fifty-four new tests were written first and run on v0.41.3: 50 failed, each for the reason its name gives, and the 4
guards passed. The implementation review added 25 more, written first the same way: 23 failed before their fix and 2
guards passed. Every new branch has a mutant that a named test kills on an assertion, run from a clean baseline (81 of
81). Full suite on Bun 1.4.2: 3,506 pass / 0 fail across 184 files. The adversarial review (one session) cleared the
design at its sixth turn and this implementation at its third, after 15 and then 5 findings; a docs audit of every
tracked doc then took three more turns (3, 1 and 0 findings), ending with zero remaining findings.

### What didn't change

- The handoff summary's prompt and feedback; the legacy `generate()` request body (the judge test pins its bytes).
- No schema migration; `CHECKPOINT_SCHEMA` stays 1. Only `ok` and `empty` commit a range (62.1 D3).
- The observer model. Content quality on the documented model stays weak, and it answers `<none/>` for about one
  window in eight that holds real work; BACKLOG 69.4 evaluates a stronger model.

---

## v0.41.3 — zerank-2 runs as a Q8_0 GGUF, and the reranker hint stops calling every GGUF broken

Since v0.11.3 the docs said every zerank-2 GGUF is inert, because llama.cpp's standard converter drops
zerank's score head, and that the SOTA reranker must run as the bf16 seq-cls sidecar (~9 GB of VRAM). A
community conversion, `seamon67/Zerank-2-GGUF`, carries the head. Its Q8_0 file ranks like the sidecar
in about two thirds of the VRAM, so the docs now recommend it. `clawmem doctor` and
`clawmem rerank-health` still blamed "the deprecated zerank-2 GGUF" for a degenerate reranker and
pointed at a CLAUDE.md section that no longer exists. Two guides launched zembed-1 without the flags its
last-token pooling needs, and the docs still called the z models non-commercial after ZeroEntropy
relicensed them.

### What changed

- **The zerank-2 reranker can run as a Q8_0 GGUF.** `docs/guides/inference-services.md` gives a
  download pinned to revision `bc7449f` with its sha256, the launch line
  (`llama-server --reranking -c 2048 -b 2048 -ub 2048 --parallel 1`), a scoring check and the
  measurements below. The SOTA stack drops from ~16 GB to ~13 GB of VRAM. The bf16 sidecar in
  `extras/rerankers/zerank-2-seq/` stays as the reference, with its reproducible correctness gate. Most
  other zerank-2 GGUFs still have no score head, and the docs say so. README, AGENTS.md, SKILL.md, the
  quickstart, troubleshooting and the cloud-embedding, systemd and upgrading guides point at the GGUF
  route, and the introduction's diagram no longer names the sidecar.
- **The degenerate-reranker hint** that `clawmem doctor` and `clawmem rerank-health` print now names a
  zerank-2 GGUF without its score head, offers the Q8_0 GGUF or the sidecar, and points at
  `docs/guides/inference-services.md`. The probe's calibration failure names the same cause and both
  routes.
- **zembed-1 launch lines.** The cloud-embedding guide and the systemd example unit now pass
  `--pooling last` and `--override-kv tokenizer.ggml.add_eos_token=bool:true`, as the inference-services
  guide already did. The systemd guide says to drop both for a mean-pooling model like EmbeddingGemma.
- **License.** ZeroEntropy relicensed zerank-2 and zembed-1 from CC-BY-NC-4.0 to Apache-2.0 on
  2026-07-24 and ungated their Hugging Face repos. The stack tables, the SOTA sections, the sidecar
  recipe and the architecture diagram now say commercial use is allowed, and the sidecar's convert step
  needs no `HF_TOKEN`.

### Verification

The Q8_0 GGUF was measured against the bf16 sidecar on 240 query–document pairs from a real vault (24
queries): the same top document for 24 of 24 queries, the same top-three set for 24 of 24, mean Kendall
τ 0.994, and scores within 0.021 (mean 0.005), on the same `sigmoid(logit/5)` scale. Upstream llama.cpp
b11347 ranks the same pairs exactly as the build that measured them (τ 1.000, scores within 0.013). On
an RTX 3090 it uses ~6 GB of VRAM against the sidecar's ~9 GB, at 42 vs 33 ms per document at
ClawMem's request shape. The same repo's Q4_K_M changed the top document for 2 of 24 queries and is not
recommended. `clawmem rerank-health` passes against the Q8_0 server (coverage 8/8, max score 0.97, min
margin 0.66).

Full suite on Bun 1.4.2: 3,425 pass / 1 fail across 178 files. The failure is a wall-clock test
(`tests/hooks/hook-alignment.integration.test.ts`) whose second turn ran past its 1,000 ms budget
under the suite's load; it passes alone, 5 of 5, both here and on v0.41.2. The suite's first run also
hit a flake that v0.41.2 already had: two env-override tests in `tests/unit/text-similarity.test.ts`
re-imported a module with `?t=` + `Date.now()`, so two imports in the same millisecond shared a cached
module (the file failed in 20 of 30 runs on v0.41.2). Each re-import now gets a unique specifier, and
the file passed 30 of 30 runs. The adversarial review (one session) cleared the docs at its second
turn, and the hint fix and the zembed-1 lines at its third, with zero remaining findings.

### What didn't change

- Only the hint's text changed in code: reranking, the rerank cache, the health thresholds and the
  in-process fallback behave as in v0.41.2.
- The default stack (qwen3-reranker-0.6B) is unchanged, and the sidecar recipe works as before.
- No migration, reindex or re-embed is needed for the release itself. A zembed-1 server launched
  without the two flags may need a re-embed once they are added (see upgrading).

---

## v0.41.2 — the observer counts its prompt in tokens and keeps room for its reply

v0.41.1 bounded the observer's prompt in characters: at most 8,000 for the CONTEXT section and the
transcript together, plus a 2,825-character system prompt outside that bound, with up to 2,000 tokens
allowed for the reply. On prose that fits the 4,096-token context the docs prescribed for the observer
model: prose runs about 5.7 characters per token on that model's tokenizer. Transcripts are not all
prose. Measured on the deployed llama-server (qmd-query-expansion-1.7B), hex runs 1.13 characters per
token, tool-like lines 1.63, and Chinese, Japanese or Korean text 1.25.

On 2026-10-01 a real vault held one range of 636 KB after four attempts, each ending "no parseable
response within the budget". A read-only reproduction with v0.41.1's modules built an 11,797-character
prompt: 4,072 tokens of the server's 4,096. The server answered `finish_reason: "length"` after 16
reply tokens (`usage`: 4,080 + 16 = 4,096). Three attempts measured 4,072, 4,018 and 4,042 tokens, and
every reply stopped inside its first `<observation>`. Each retry had the same size, so the range was
retried every 12 hours with no way to succeed. In another run the cut reply was 22 characters with no
`<` in it, and the observer read it as "nothing to record", so that turn's observations were lost
without a quarantine. At `-c 8192` the same prompt ended `finish_reason: "stop"`, with 360 reply tokens
for one observation.

The observer now counts tokens against the context the server reports. Before each model call of the
Stop pipeline, retries included, it reads `/props` (the per-request context: `-c` divided by
`--parallel`), else `CLAWMEM_LLM_CONTEXT_TOKENS`, else an assumed 4,096. It counts the assembled prompt through
`/apply-template` and `/tokenize`: on the deployed server that count equalled the chat completion's own
`usage.prompt_tokens` for every prompt measured, and the refused request's `n_prompt_tokens` for two
prompts over the context. It keeps 40% of the context for the reply (768 to 2,000 tokens; 1,638 at
4,096) and asks for as many observations as that room holds (4 at 4,096, 5 at 8,192). A batch that
does not fit one prompt runs as windows inside the same Stop, each window seeing the titles of the
observations the earlier ones found. A reply the server reports as cut is never parsed: its window runs
again at half its size, and a reply that did not finish as an answer is held for a retry, never read as
"nothing to record".
Progress through the windows is kept in a durable checkpoint, so a range that runs out of calls or time
resumes after its last finished window instead of starting again, and that pause is not counted as a
failure. A range that can never fit, because one message is larger than a window can be on that
server, is held with a `capacity:` reason that `clawmem doctor` counts, and replays by itself once the
context is raised. The handoff summary fits its prompt the same way. The docs now prescribe `-c 8192`
for the observer model: the fixed part of the observer's prompt measures 684 tokens, so a window holds
1,356 to 1,774 transcript tokens at 4,096 and 5,090 to 5,508 at 8,192, for about 470 MiB more VRAM.

Separately, on 2026-09-30 the embed timer ran an incremental `clawmem embed` while the embedding server
was down. The geometry canary was unavailable, all 2,202 fragments failed, no vector was written, and
the run still set the geometry taint, which only a verified full `clawmem embed --force` clears (99
minutes on that vault). A run that did not clear the index and stored nothing cannot have mixed a
second geometry into it, so it no longer sets the taint; it still exits 1. Clearing the taint now also
needs a passing preflight: a `--force --force-geometry` run over a failed canary could clear it before,
because its end check compares the run's vectors with themselves.

### What changed

- `src/llm.ts`: `generateDetailed()` reports why a reply stopped (`stop`, `length`, or `other` for a
  reason such as `content_filter`) and the server's token usage. A server that reports no reason gets a
  best-effort reading, logged once per process: a reply that used its whole allowance counts as cut, any
  other as complete. A 200 without a completion choice, or one that is not JSON, is an error, never an
  empty answer, and counts toward the endpoint's failure streak like an HTTP error (issue #24's 60-second
  cooldown) instead of clearing it. It stays on the backend it was given: a
  remote transport failure returns `unavailable` instead of falling through to in-process generation
  inside the call. An HTTP 400
  `exceed_context_size_error` is classified as `context_exceeded`; the first one per endpoint does not
  count toward the 60-second cooldown streak for 10 minutes, and a repeat that is not smaller does.
  `llmCapacity()` reads `/props` fresh on every call (a strong fingerprint: sha256 of the model path,
  chat template and build, when `/props` names all three; one that gives the context alone is measured
  but weak), else the configured or assumed context (a weak one). `countChatTokens()`
  counts template-exact through `/apply-template` + `/tokenize` (no margin: the count is exact), else
  the content's count plus the template's overhead, measured by a one-token probe and kept 24 hours, and
  a margin of 8 (32 when no probe answers), else an estimate that counts hex
  runs, digits, punctuation and non-ASCII at one character per token and other text at three, scaled by
  a factor that only rises (margin 32). `generate()` logs once per process when the server cut a reply
  at its context; its request body is unchanged, byte for byte. A validated oversize invalidates the
  measured overhead that fed its count. An LLM injected through `setDefaultLlamaCpp` that implements
  only `generate()` is counted by estimate against `CLAWMEM_LLM_CONTEXT_TOKENS`, else an assumed 32,768
  tokens: most units go in one prompt, the largest the observer takes (100 lines of dense tool output)
  in two windows, and a smaller configured context windows more; its replies are read as complete.
  `extractObservationsResult()` runs one invocation without a checkpoint, so a unit that needs more
  calls than its budget allows returns `retryable` and keeps no progress.
- `src/observer.ts`: `extractObservationsWindowed()` — the reply reserve, the observation count, whole-turn
  windows (a turn is cut between messages only when it alone exceeds a window), a CONTEXT for window
  k > 1 made of the transcript just before it (`EARLIER IN THIS EXCHANGE`) and the titles recorded so
  far (`ALREADY RECORDED`), halving on a cut reply, one format retry inside the budget, one re-size from
  an oversize refusal's own count and `n_ctx`, `capacity:` results, and at most 6 model calls per run.
  The capacity is read before every call and checked against the server the run is pinned to: two
  strong fingerprints that differ restart the range; a `/props` that stops giving a fingerprint (no
  answer, an error, a 404, a body that is not llama.cpp's, one without the model, template and build)
  leaves it waiting with its progress kept, however long. A line that fits
  a window alone is never held as `capacity:`: when the fit's guesses fail, it searches down to one
  line, and the window still ends at the last turn boundary that fits, the one after its first line
  included. The measured call time is the mean of the latest 50 model calls.
  `extractSummaryFitted()` fits the summary prompt with a 500-token reply, dropping the recent turn text
  first and then digests from the end, and reports how many digests it used; a digest lists at most 10
  files, and the stored summary is capped (the request at 600 characters, each other field at 800).
- `src/stop-checkpoint.ts` (new): checkpoints as `vault_flags` rows
  `observer-ckpt:<session>|<transcript key>|<hook>|<range key>`, holding the windows done, the
  observer's contract version, the server fingerprint and the pinned backend. Create is
  `INSERT OR IGNORE`, every advance or reset a compare-and-swap on the row's raw value, and only the
  range's committing Phase B writes the tombstone. The sweep removes orphans only, paging from where it
  last stopped so the checkpoints that must stay never hide a newer orphan; a queued range holds a
  checkpoint only when its full identity matches (the transcript's epoch, the offsets and the bytes).
- `src/stop-extract.ts`: each unit loads or matches its checkpoint and saves progress after every
  window. A unit cut short becomes a `continuation`: quarantined with attempts unchanged and due again in
  60 s (or at once after a budget skip). A checkpoint whose server cannot be verified waits as a
  continuation, however long, as for an unreachable backend; it restarts from its first window only on a
  verified change (another strong fingerprint), and the operator can drop the range instead. The latest
  50 measured observer calls, and their mean, are kept in the `observer_call_mean` flag. A first-window
  fallback from the remote to the local backend keeps the run's call cap. A Stop ends its loop at its first quarantine, so one Stop queues at most one range. A replay that finds its range committed elsewhere ends as done without a
  second set of effects. Observations with equal bodies from different windows merge, with their
  triples, before the judge. Messages beyond the observer's 100-message view of one turn are counted in
  the `observer_accumulator_dropped` flag.
- `src/stop-worker.ts`: a due continuation runs first in each tick, in its own slice (twice the
  process's mean observer call plus 5 s, 15 to 23 s), a continuation whose claimant died (its lease
  expired) included, and the tick ends with the checkpoint sweep.
- `src/stop-handoff.ts`: the summary step uses `extractSummaryFitted()`; its watermark moves only past
  the digests the summary used.
- `src/hooks.ts`, `src/hooks/decision-extractor.ts`: observer messages carry their turn; `formatObservation`
  is exported for the grouping.
- `src/clawmem.ts`: `clawmem embed` — a run without `--force` that stored no vector sets no taint (it
  says so and exits 1), and clearing the taint needs a passing preflight. `clawmem doctor` — an
  `LLM context` line (the context and its source, how prompts are counted, the window it leaves, and the
  observer's mean call as the Stop pipeline last measured it, flagged above 18 s) and Stop-pipeline lines
  for `capacity:` holds, queued continuations (with those waiting for a server that could not be
  verified), live checkpoints no queued range owns — split into those a later Stop can still reach, a
  first Stop's with no cursor (resumable by a later Stop that reads the same range, until the sweep's
  7 days), and those behind the transcript's cursor (a dismissed or superseded range) — and unseen
  messages.
- Docs: `docs/guides/inference-services.md`, `docs/quickstart.md` and `CONTRIBUTING.md` (`-c 8192`, the
  measured window sizes and VRAM cost, servers without `/props`), `docs/reference/configuration.md` and
  `README.md` (`CLAWMEM_LLM_CONTEXT_TOKENS`), `docs/reference/cli.md` (the doctor's new lines, the embed taint
  rules, the worker's continuation step), `docs/concepts/architecture.md` (the Stop pipeline's
  windows, checkpoints, continuations and summary fit), `docs/guides/setup-hooks.md`,
  `docs/guides/cloud-embedding.md`, `docs/troubleshooting.md` (dense turns, the doctor lines, the
  context-cut warning, the embed run that wrote nothing), `docs/guides/upgrading.md`, `AGENTS.md`,
  `SKILL.md`.

### Verification

New tests: `tests/unit/observer-budget-v0412.test.ts` (26: the reply reserve and observation count, dense
hex in windows, cut replies and replies that did not finish, window CONTEXTs, resume and progress, the
compare-and-swap and fingerprint outcomes, an unverified server, the oversize re-size and the overhead it
invalidates, a capacity read before every call, a large line among many small ones, the turn boundary
after a one-line turn, a snapped window counted before it is sent, per-call timing, the contract's
inputs, `capacity:`, the summary fit, an injected `generate()`-only LLM up to the largest unit),
`tests/unit/llm-budget-v0412.test.ts` (19, against a fake llama-server: `/props` answered, or not — a
404, a 200 that is not llama.cpp's, a 500, one without the model, template or build — and the unverified
pin it leaves, `/apply-template`, `/tokenize`, the 400, `finish_reason` and `usage`, a reply with no finish
reason (end to end through the observer), a 200 without a choice or not JSON and the cooldown it trips,
the oversize exemption, the overhead's expiry and invalidation, backend pinning),
`tests/unit/stop-checkpoint-v0412.test.ts` (20: continuations through replays, contract resets, separate
sessions, a range committed elsewhere, an unreachable backend, an unverified server however old its
checkpoint, a `/props` answering HTML, 404 or the context alone and then the original one (the real
LlamaCpp: the unit waits, then resumes at its saved line), a repeated first Stop with no cursor resuming
its saved window, one held range per Stop, continuations first in the
worker and an expired claim, merged bodies, the call cap across a backend fallback, the kept call time
and its 50-call mean, the checkpoint transitions, the orphan sweep, its paging and its range identity),
`tests/unit/doctor-observer-v0412.test.ts` (1, the real CLI: queued continuations and the unverified
ones, live checkpoints no queued range owns matched by full identity and split three ways (ahead of
the cursor, a first Stop's with none, behind it), a range dismissed through `clawmem repair stop-queue
--dismiss`, the mean call) and
`tests/unit/embed-taint-v0412.test.ts` (5, the real CLI against a fake `/v1/embeddings` that passes the
real canary). In `tests/unit/stop-observer.test.ts` three token tests replace v0.41.1's two
character-bound tests; `tests/unit/canary-validation.test.ts`'s no-work test now expects no taint.

Against v0.41.1's source, with the two new constants pinned to their specified values: the three token
tests fail (one call where windows were needed; a 100-message unit answered as "nothing to record"
instead of reported; a retry prompt of 3,065 tokens that left 1,031 for the reply), the no-work test
fails, and two of the five embed tests fail (an empty run set the taint; an overridden failed canary
cleared it); the other three pin rules that did not change. The other new files test the new API and do
not load there. The adversarial review's first implementation pass raised fifteen findings. Eighteen
regression tests were written for them: seventeen failed against the code before their fixes, and the
eighteenth pins behaviour that its fix only documents (an injected `generate()`-only LLM). Its second
pass raised seven more: a 200 without a completion never counted toward the cooldown; a turn that fits a
window whole could be cut after a one-line turn, and a snapped window was sent without its count
checked; a re-anchored transcript's range could hold an older checkpoint; a reply with no finish reason
read as complete; the "latest 50 calls" mean decayed instead; a checkpoint whose server could not be
verified reset after an hour with no evidence of a change; and the injected-LLM claim was too broad.
Twelve regression tests were written for them: eleven failed against the code before their fixes, and
the twelfth pins the corrected claim (the largest unit in two windows). Its third pass raised two more:
the second-pass rule that read a `/props` answering 404 or a body that is not llama.cpp's as a changed
server could discard finished windows on a transient proxy answer, so that rule was withdrawn (only a
verified differing fingerprint resets); and the doctor promised a resume to checkpoints no later Stop
reaches. Their three regression tests all failed against the code before the fixes. Its fourth pass
raised two more: a `/props` that gave the context without the model, template and build still made a
strong fingerprint, so a transient answer of that shape reset finished windows (a strong fingerprint
now needs all three); and a first Stop's checkpoint with no cursor can still be resumed by a later Stop
that reads the same range, so the doctor reports those apart. Of the four tests written or extended for
them, three failed against the code before the fixes; the fourth pins the resume the doctor now
reports. Forty-five mutants of the fix
(among them a cut reply parsed; no reply reserve; an advance without compare-and-swap; a sweep that
ignores a queued range, reads one page, or matches a range without its epoch; a Stop that goes on after
its first quarantine; a continuation counted as a failure; an empty run that taints; an overridden
canary that clears; a reply that did not finish, parsed; a malformed 200 that does not strike; a snap
that skips the first turn boundary; a decaying call mean; an unverified checkpoint reset after an hour;
retries that reuse the window's capacity; a fallback with a fresh call cap) each fail at least one
test. The first mutant pass let two through, and both exposed weak tests (a transcript's first Stop
starts at its current turn, so one test never built more than one unit; one doctor count was
symmetric); both tests were fixed.

On the deployed server (llama.cpp, qmd-query-expansion-1.7B, `-c 8192`), with synthetic text: the
template-exact count equalled `usage.prompt_tokens` for five prompts (15, 733, 2,136, 642 and 1,994
tokens: short, prose, hex, Chinese and Japanese with emoji, JSON); the doctor's window is 5,508 tokens
(684 fixed, 2,000 reply). A dense synthetic turn ran in one call at 8,192 (prompt 3,636, reply 233)
and, with the observer's budget capped at 4,096, in 7 windows, every reply ending
`finish_reason: "stop"`: prompts of 1,997 to 2,111 tokens against a limit of 2,458, replies of 177 to
921 (measured again on the final code). Full suite: 3,426 pass / 0 fail across 178 files (Bun 1.4.2).
tsc unchanged. The adversarial review (one session) cleared the design at its tenth turn and this
implementation at its fifteenth, with zero remaining findings.

### What didn't change

- Batches are packed as in v0.41.1 (100 messages, 8,000 characters less the CONTEXT's and a retry's
  share); windows split a batch only when it does not fit one prompt. The observer still reads at most
  the last 100 messages of one turn; `clawmem doctor` now counts the ones it skipped.
- Turns a session's last Stop did not reach (its time ran out, or it held a range) are extracted only
  by a later Stop of the same transcript, as in v0.41.1; a watcher catch-up is planned.
- An embed run killed after it stored vectors (`SIGKILL`, out of memory, power loss) sets no taint, as
  in v0.41.1, because it never reaches its end check. A taint set by v0.41.1 or earlier stays until a
  verified `clawmem embed --force`.
- Consolidation's prompts and the exported `extractSummary()` still go through plain `generate()`.
- A small observer model may still record a decision again in a later window that shows it again;
  equal bodies merge, others stay.
- No migration: checkpoints live in `vault_flags`, continuations in `stop_retries`.

---

## v0.41.1 — the observer's prompt fits its documented context again

v0.41.0 gave the observer a CONTEXT section: the two turns before the batch and the session's recorded
observation titles, marked as already recorded. The section rendered those turns through
`prepareTranscript` with that function's whole budget, 8,000 characters, and listed up to 30 titles,
while the batch's own transcript kept its 8,000. At its largest the prompt grew from about 10,900
characters to about 23,600: from 2,470 tokens to 5,382 on the observer model the docs prescribe
(qmd-query-expansion-1.7B, counted by its server with the chat template, on prose from this
repository's docs). The docs run that model with `-c 4096`, and the server refuses a longer prompt
with HTTP 400. The observer retries a failed call twice, so such a batch went to the server three
times and was refused three times. The third refusal in a row put the process's LLM endpoint into
its 60-second cooldown: that attempt, and the process's other LLM calls for the next minute, ran
in-process through node-llama-cpp (downloading the model on first use), or not at all with
`CLAWMEM_NO_LOCAL_MODELS=true`. A batch left without an answer was quarantined in `stop_retries` as
`model unavailable`, and every replay sent the same prompt again. A prompt under the limit could
still leave the model little room: on one real Claude Code turn the prompt was 3,875 tokens, which
left 221 of the 4,096 for an answer the observer allows 2,000 tokens.

The section now has a bound of its own, and the transcript gets what the section leaves of the
render budget, so the two together, with a retry's error feedback when there is one, stay within the
8,000 characters v0.40's transcript alone could take. The bound is in characters, not tokens. On the
same prose the largest prompt is now 2,403 tokens, and the real turn above is 1,473; text that
tokenizes more densely (Chinese, Japanese or Korean, for instance) can still pass 4,096 tokens within
it, as it could in v0.40.

Separately, the test suite read the developer's own ClawMem configuration. `loadVaultConfig()`
reads `~/.config/clawmem/config.yaml` unless `CLAWMEM_CONFIG_DIR` is set, and the test-mode guard in
`getDefaultDbPath` covers only the general vault. A test that runs `feedbackLoop` without explicit
vaults opens every configured named vault, so on a machine with a skill vault configured,
`bun test tests/unit/stop-feedback.test.ts` opened that real vault writable, and the v0.41 migration
installed the stop-pipeline schema and its fence triggers on it (it wrote no stop-pipeline rows).
Every test file runs in one process, and one of them deleted `CLAWMEM_CONFIG_DIR` after each of its
tests, so even a run that set the variable exposed the real configuration to every test after that
file. Every run now starts from an empty scratch configuration and keeps it, and so do the processes the
tests start. A vault migrated that way keeps the v0.41 schema, as any v0.41 process opening it would
leave it. Before an older ClawMem uses it again, stop every v0.41 or later process that shares it,
then drop the fence with `clawmem repair counters --remove-fence`: an upgraded process reinstalls the
fence at its next writable open.

### What changed

- `src/observer.ts`: the CONTEXT section is at most `OBSERVER_CONTEXT_MAX_CHARS` (2,000) characters.
  The prior turns get 1,100 of them, cut from the front when the turns' first request and final
  response alone are longer, so the latest text stays. The titles get 700: the newest that fit, in
  order, each at most 100 characters. Neither cut leaves half of a surrogate pair (an emoji cut in
  two makes llama-server refuse the request with HTTP 500). The transcript gets
  `OBSERVER_MAX_RENDER_CHARS` (8,000) less the section's length, and on a retry less the retry's
  error feedback too (`OBSERVER_RETRY_FEEDBACK_MAX_CHARS`, 850: the parse error and up to 500
  characters of the answer), through a new `retryPrompt` option of `withRetryAndFeedback`
  (`src/llm-retry.ts`); its other callers keep their retry prompt, byte for byte.
  `prepareTranscript` takes its budget as a parameter and never returns more than it; at its
  default, 8,000, its output is unchanged.
- `src/stop-extract.ts`: turns are packed into batches that leave 2,850 characters free
  (`OBSERVER_BATCH_RESERVED_CHARS`: the section's 2,000 and a retry's 850; `packTurnBatches` had the
  `reservedChars` bound, and nothing passed it), so a packed batch reaches the model whole on every
  attempt. A single turn larger than a batch is cut to its budget, as before, now 8,000 less the
  section (and on a retry, the feedback) instead of 8,000.
- `tests/preload.ts`, loaded before every test file through `bunfig.toml` (Bun reads `bunfig.toml`
  only from the directory it runs in, so run `bun test` from the repository root): points
  `CLAWMEM_CONFIG_DIR` at an empty scratch directory, and back at it before and after every test
  that leaves it unset, and clears `CLAWMEM_VAULTS` and `INDEX_PATH`, which a launcher may export
  with the real paths. A test that needs a configuration, a named vault or an index path sets its
  own, as before. Two tests that start the CLI with a cleaned environment
  (`tests/hooks/eval-vector-daemon.integration.test.ts`, `tests/hooks/hook-replay.integration.test.ts`)
  dropped `CLAWMEM_CONFIG_DIR` with the rest, so the child read the real configuration; they now give
  it a scratch one.
- Docs: `docs/concepts/architecture.md` and `docs/guides/setup-hooks.md` (the section's bound),
  `docs/guides/inference-services.md` (the observer runs on the LLM server; what `-c 4096` fits and
  when to raise it; which HTTP errors trip the cooldown, stale since v0.37.0),
  `docs/reference/configuration.md`, `README.md`, `AGENTS.md`, `docs/quickstart.md`,
  `docs/guides/cloud-embedding.md` and `docs/internals/entity-resolution.md` (the LLM server also
  serves the observer; `cloud-embedding.md` also says the LLM can be a cloud endpoint, which then
  receives session transcripts, and, with `docs/guides/systemd-services.md`, that a fallback is logged), `README.md`'s observer section (a batch the model cannot answer is
  quarantined and replayed, not a regex fallback, since v0.41.0; the prompt's bound),
  `docs/troubleshooting.md` (a new *Hooks* entry), `docs/guides/upgrading.md`, `CONTRIBUTING.md`,
  `docs/contributing.md`, `docs/quickstart.md` and the pull-request template (the isolated suite,
  `tests/preload.ts`, run from the repository root), `SKILL.md`.

### Verification

`tests/unit/stop-observer.test.ts` adds six tests at the observer: the largest CONTEXT beside a batch that
fills the budget (CONTEXT and transcript within 8,000 characters), the section's own bound and its
latest material (the last prior message, the newest titles), a retry after the longest parse error
the observer reports and a long answer (within the bound, its feedback within 850 characters), a
batch at the packing bound (whole on the first attempt and on the retry), the section's cuts through
emoji (no lone surrogate), and `prepareTranscript` under a small budget.
`tests/unit/stop-extract.test.ts` adds two at the Stop hook: a 40-turn backlog packed into several
batches (every prompt within the bound, every turn sent whole exactly once), and the same backlog when
every batch's first answer fails to parse (every retry within the bound, every turn whole in a
retry). `tests/unit/llm-retry.test.ts` adds two: the default retry prompt, byte for byte, and a
caller's `retryPrompt`. Nine of these ten fail against v0.41.0's source; the tenth pins the default
retry prompt, which did not change. `tests/unit/test-isolation.test.ts` adds four: the preload's
scratch configuration, a test that deletes `CLAWMEM_CONFIG_DIR` and the test after it (still on the
scratch directory, seeing only scratch vaults), and a child process started with the suite's
environment (the same scratch configuration). Three of them fail without the preload; the fourth is
the deleting step. Eleven mutants of the fix (no batch reserve, the transcript's full budget, the
prior turns' full budget, the oldest titles, no final cut, no preload, no repair hooks, a front cut or
a title clip that splits a surrogate pair, no retry hook, a reserve without the retry's share) each
fail at least one of these tests.

Measured with the observer server's own tokenizer and chat template (qmd-query-expansion-1.7B,
`-c 4096`): on prose from the docs the largest prompt is 2,403 tokens (v0.41.0: 5,382; v0.40's
shape: 2,470), and the second Stop's prompt on a real Claude Code transcript 1,473 (v0.41.0: 3,875).
Full suite: 3354 pass / 0 fail on Bun 1.3.14. On Bun 1.4.2, 3353 pass and 1 fail: Issue #13's
concurrent first-open test (`SQLITE_BUSY` at `PRAGMA journal_mode = WAL`), which fails now and then
on an unmodified v0.40.3 as well, and passed five reruns. tsc unchanged. Cross-model
adversarial review (codex / GPT-6, one pinned session): turn 1 raised five findings, four Medium (a
retry's feedback could push the prompt past the bound; two test subprocesses read the developer's
configuration; the notes promised a token guarantee the character bound does not give; the
downgrade step lacked its precondition) and one Low (when a quarantined range replays); turn 2 one
Low (the fallback is not necessarily on the CPU). All were fixed. Turns 4 to 7, on the docs audit
that followed, raised eleven more, six Medium and five Low: a token guarantee the docs still implied,
the scope of the fallback and cooldown statements, the LLM's cloud option (which then receives
session transcripts), and stale role lists and test instructions. All were fixed. It cleared at
turn 8 with zero remaining findings.

### What didn't change

- The render budget and the output budget: 8,000 characters of CONTEXT and transcript, and up to
  2,000 tokens of answer. On dense text a prompt at the bound still leaves the model less than 2,000
  tokens of a 4,096-token context to answer in, as v0.40's did.
- Ranges v0.41.0 quarantined are due again at most 12 hours after their last attempt, and replay
  when the watcher or a later Stop next runs; `clawmem repair stop-queue` shows how many are queued.
  No migration.

---

## v0.41.0 — the Stop hooks process each turn once, and feedback counts only verified references

Claude Code runs the Stop hooks after every response, and through v0.40.3 each run started over.
`decision-extractor` re-read the last 200 transcript entries and ran the observer on all of them,
`handoff-generator` summarised the same window again, and `feedback-loop` credited every note the
session had surfaced that the assistant mentioned anywhere in that window. A turn was therefore
extracted, summarised and counted once per later response:

- `access_count` grew with every Stop, not with every reference (up to 13,213 on one document on
  the host where this was measured), and co-activation counts and `usage` relations grew with it.
  Relation weights were summed without a bound (the largest was 8,948), so one relation recorded
  again at every Stop outweighed every other edge wherever relations are ranked by weight.
- Recall events were matched to turns by position, so a skipped or deduplicated prompt moved every
  later turn's attribution onto the wrong context.
- The session's decision document was rewritten from the last window whenever its decisions
  changed, so a turn's decisions left it once the turn left the window. A new decision document was
  not written at all when a vector search found any `_clawmem` document at least 0.92 similar.
- The antipattern writer replaced the body of the most recent antipattern document of the last 7
  days, whichever session wrote it, so one session's list overwrote another's. On the measured host
  that document had 4,253 revisions, and 1,912 of 1,923 earlier bodies were held by no document.
- A failed summary replaced the session's handoff with a regex fallback.

From v0.41.0 `decision-extractor` and `handoff-generator` keep a cursor per transcript and process
only what they have not processed yet, and `feedback-loop` decides each surfaced turn once, so every
turn is extracted, digested and credited once. Pre-upgrade history is not replayed: a transcript's
first Stop starts at its current turn (a Hermes transcript begun after the upgrade, at its first
line).

### What changed

- **decision-extractor** reads the complete turns after its cursor and sends them to the observer in
  batches that fit its bounds. The two turns before a batch and this session's recorded observation
  titles go with it as context, marked as already recorded. A batch goes to the model only when its
  new section holds an assistant message of at least 40 characters or a tool call, which replaces
  the "at least 4 messages" rule. A batch whose model call fails or times out is quarantined instead
  of committed empty, and so is a Stop's first batch when too little budget is left to start it
  (later batches wait for the next Stop). The cursor moves past a quarantined range, and later Stops
  and the watcher retry it after 1 minute, 5 minutes, 30 minutes, 2 hours, then every 12 hours. A
  quarantined range whose bytes changed in the meantime is marked unavailable and never guessed at.
- **Per-session documents, rendered from items.** Decisions and antipatterns are stored as items
  (`stop_items`), one row per item, deduplicated only when the same item comes again with identical
  content. Each session's decision, antipattern and handoff documents are rendered from its own items
  at a path fixed when the document is first written: `_clawmem/decisions/<date>-<sid8>.md`, and
  the same under `antipatterns/` and `handoffs/`, where `<date>` is the first render's date. A second
  transcript of the same session id gets `-<tk6>` after that, and so does a session whose path is
  already held by a document this pipeline did not write (a pre-upgrade document stays as it is). The
  merge policies (`dedup_check`, `merge_recent`, `update_existing`) are gone. A session document is
  never merged with, skipped for, or overwritten by another session's, and the 30-minute hash window
  of `saveMemory` no longer applies to it. A forgotten or archived session document is not
  rewritten; its items stay, and a restore renders them again.
- **The contradiction judge remembers the pairs it decided**, and a pair whose older document changed
  after the call is re-judged against the current content (`judge_deferred`) rather than applied.
- **The causal step** (`CLAWMEM_CAUSAL_WRITER=shadow|on`; the default is still `off`) runs at most
  once per committed range, under a run key derived from that range. A range committed while the
  writer is on waits in a queue when the writer is later turned off, and `clawmem doctor` counts it.
- **handoff-generator** records a digest of every new turn at each Stop, without a model call: the
  request (at most 200 characters), the last paragraph of the final answer (at most 300), and the
  files its Edit, Write, MultiEdit and NotebookEdit calls touched. The summary step then runs when at
  least 3 new digests wait, 30 minutes after the last summary, or when the session has none yet. It
  is incremental: the previous summary, the new digests and the text of the latest turns that fit.
  A failed summary changes nothing but its audit, and the digests wait for the next attempt. The
  regex fallback is gone; without a model, the handoff shows the digests. As before, a transcript
  gets a handoff once it holds four messages.
- **SessionEnd flush.** `clawmem setup hooks` now also installs `handoff-generator` under
  SessionEnd, timeout 2 s. At session end it renders the summary and the latest 20 digests past it
  (a line counts any earlier ones) into the handoff document, and records that the session ended.
  It reads no transcript and calls no model, and stops itself after 1 s. Claude Code allows
  SessionEnd hooks 1.5 s. The OpenClaw plugin's `session_end` waits for the same flush (at most 5 s)
  before it clears the session's state.
- **feedback-loop credits each turn once, by verified reference.** When `context-surfacing` injects
  context, the bookkeeping drainer records the turn's manifest: every document injected, from every
  vault, with its title as rendered. Each document counts as surfaced once there. A turn is paired
  with its surfacing row by the prompt's hash and the host's own ordering of events, never by
  position; zero or several candidates leave the row unattributed. The reference test runs once per
  turn over the whole manifest: a display path, a path of at least two segments, a file name as a
  whole token (a generic one such as `SKILL.md` only with its parent directory), or a displayed title
  of at least 12 characters and two words. Each must name exactly one entry of the manifest. A
  verified reference then applies once: `access_count` + 1, `last_accessed_at`, the utility signal,
  the recall event, and co-activation and `usage` relations between the documents that turn
  referenced. Named vaults apply their own slice of that verdict.
- **A verdict is final when the turn is over:** a later prompt, a Stop, the session's end, or, on
  Claude Code, the summary entry Claude Code writes after each Stop (`stop_hook_summary` without a
  hook label, or `turn_duration`). Where no later entry can change a turn's pairing (OpenClaw,
  Hermes), the watcher credits a quiet transcript's trailing turn provisionally and makes the verdict
  final at the next of those. Age alone never makes a verdict final.
- **Counters recomputed once from verified references.** The first `clawmem watch` start on
  v0.41.0 (or `clawmem repair counters --apply`) recomputes, for the general vault and every named
  vault: `access_count` = verified references, `last_accessed_at` = the newest verified reference
  (else `modified_at`), the utility signals, and the co-activation counts and `usage` relations,
  whose historical rows are deleted and rebuilt from verified same-turn references (weight 1.0). Right
  after the upgrade almost nothing is verified yet, so these start near zero. Usage rows written
  before the upgrade are frozen (`pre-upgrade`) and never credited. Every value the recompute
  changes or deletes is kept in `counter_repair_log`, and `clawmem repair counters --restore <op>`
  puts it back while the value still equals what the recompute wrote.
- **Archive grace.** A document whose old last access fell inside its archive window gets
  `access_grace_until` = recompute time + 30 days + (document id mod 60) days, and the lifecycle
  sweep does not treat it as unaccessed before that. The grace ends are spread over 60 days, so the
  recompute does not make every such document archivable at once. `clawmem doctor` shows how many
  grace periods end in each coming week.
- **Injection no longer records co-activations**, for any hook: through v0.40.3, `session-bootstrap`
  and `staleness-check` still recorded one for every pair of documents they injected.
- **Relation weights are clamped to [0, 1]**, both when a relation is written and wherever a weight
  is read: graph traversal, A-MEM evolution neighbours, deductive guardrails, and the surfacing
  hook's relation snippets.
- **The fence.** An older ClawMem that still runs against a migrated vault cannot write feedback
  counters, co-activations, `usage` relations, utility signals, or documents under `_clawmem/`
  `decisions/`, `antipatterns/`, `handoffs/` or `observations/`. Each such write is skipped and
  counted in `legacy_writer_log`. Its surfacing hook's usage-row insert fails instead, so that hook
  injects nothing. `clawmem doctor` fails while the last such write is less than 24 h old. Upgrade
  every process that shares the vault.
- **The watcher runs the stop pipeline.** `clawmem watch` runs a worker every 60 s that does the work
  no later Stop will: feedback of transcripts that have been quiet for 10 minutes or have ended,
  named-vault slices, handoff digests after a final Stop that never ran, handoff renders,
  quarantined ranges, deferred judge pairs and queued causal steps. At its first start it preserves
  the overwritten antipattern bodies, then runs the recompute. It runs even when no collection is
  configured, where `clawmem watch` used to exit with an error. Without the watcher, each Stop
  attributes its own transcript and retries at most one due range of its session, deferred judge
  pairs wait, and `clawmem repair stop-queue --run` drains every queue by hand.
- **New commands:** `clawmem repair counters [--apply] [--restore <op>] [--remove-fence] [--force]`
  (a dry run without `--apply`), `clawmem repair stop-queue [--run] [--dismiss <id>]
  [--dismiss-causal]`, and `clawmem recover antipatterns [--apply] [--min-occurrences N]`, which lists
  the distinct `- **Avoid:**` lines of the overwritten bodies with counts and dates, and with
  `--apply` writes them to `_clawmem/antipatterns/recovered-<YYYY-MM>.md`.
- **`clawmem doctor`** gains a stop-pipeline section: the migration and fence, an older writer
  caught by the fence, the recompute, queue depths (warning past 24 h), provisional verdicts, causal
  steps waiting while the writer is off, preserved antipattern bodies and the grace projection. It
  also warns when the SessionEnd flush is not installed. `clawmem status` gains one line.
- **Hermes.** The plugin now runs the three Stop hooks after every synced turn, one pass at a time
  in the background, and at session end runs that transcript's final pass, the SessionEnd flush and
  a last feedback run. Under v0.41.0's cursors the old plugin, which ran them at session end only,
  would keep a session's last turn and write no handoff; a Hermes transcript begun after the upgrade
  is read from its first line, so a late first pass loses nothing. Hermes prefetches context after a
  turn for a later prompt (or none: trivial prompts skip it, late results are dropped), so
  `context-surfacing` now hands the plugin its usage row's id, and the plugin records what became of
  each row: it writes the id on the user line of the turn it handed the context to, or records the row
  dropped or unresolved. A transcript write that fails is kept and written later, from its next byte;
  a record is lost only in the cases the Hermes guide lists, and a row whose record is lost is never
  credited on it (complete lines already on disk are still read). A
  process holds its transcript locked while it writes it, so a second process on the same session
  writes a transcript of its own (`<session_id>.2.jsonl`). The feedback step reads each Hermes transcript once, every
  pass resuming where the last stopped. The row is credited in that turn only, or closed `not-delivered` (`host: "hermes"`). New transcripts open with a small timestamped header, and lines
  carry millisecond timestamps. **Copy the plugin again** when you upgrade — its contents, over the installed
  one (`cp -r src/hermes/. <plugin dir>/`, see [upgrading](docs/guides/upgrading.md)).
- **OpenClaw** passes the host, the session key and the resolved transcript path to the hooks it
  runs, and registers a short or empty prompt's transcript without running retrieval, so the watcher
  can reach every transcript OpenClaw resolved.
- **Schema.** A writable open adds, in one transaction: the stop-pipeline tables (`feedback_ledger`,
  `feedback_turns`, `stop_cursors`, `stop_retries`, `stop_items`, `session_docs`,
  `session_transcripts`, `hermes_scan`, `hermes_marks`, `causal_due`, `judge_deferred`, `judge_pair_verdicts`, `legacy_writer_log`,
  `counter_repair_log`, `recovered_antipattern_bodies`, and `utility_signals`, which only
  `feedback-loop` used to create), the stamp and identity columns, and the fence. If that transaction
  cannot commit, the store still opens, the Stop hooks skip their counter and cursor work, `clawmem
  doctor` fails, and the next writable open tries again.
- `CLAWMEM_STOP_BUDGET_MS` now bounds all three Stop hooks: the extractor's model phases, the
  handoff's summary step and the feedback read.
- Docs: `docs/guides/upgrading.md`, `docs/guides/setup-hooks.md`, `docs/guides/hermes-plugin.md`,
  `docs/guides/openclaw-plugin.md`, `docs/guides/systemd-services.md`,
  `docs/concepts/hooks-vs-mcp.md`, `docs/concepts/composite-scoring.md`,
  `docs/concepts/architecture.md`, `docs/troubleshooting.md`, `docs/reference/cli.md`,
  `docs/reference/configuration.md`, `docs/contributing.md`, `AGENTS.md`, `SKILL.md`, `README.md`.

### Upgrading

Stop every ClawMem process that shares the vault (the watcher, `clawmem serve`, MCP servers in open
sessions, the OpenClaw and Hermes plugins), upgrade them all, re-run `clawmem setup hooks` for the
SessionEnd flush, copy the Hermes plugin again if you use it, then start `clawmem watch`. Its first
start preserves the overwritten antipattern bodies and recomputes the counters; on a large vault
this takes minutes and writes one before-image per changed value (about 380,000 rows on the measured
vault). Details, the restore path and the downgrade path: [upgrading](docs/guides/upgrading.md).

### Verification

Seventeen new test files, `tests/unit/stop-*.test.ts`: 252 tests. They drive the real hooks —
`decision-extractor`, `handoff-generator`, `feedback-loop`, the bookkeeping drainer, the SessionEnd
flush through the real `clawmem hook` process, the OpenClaw engine, `clawmem watch` on a vault with
no collections, and the Hermes plugin under Python with a stub Hermes, a fake `clawmem` binary and
real partial writes (a file-size limit) — over transcripts in each host's shape, with a fake
observer, summarizer and judge. Each design test asserts a result v0.40.3 gets wrong; measured on
v0.40.3 with the same fixtures: two Stops with no new turn made two observer calls and two
summarizer calls; a turn credited at one Stop was credited again at the next (access, surfaced and
referenced counts 1 → 2); turn 1's decision was gone from the session document after 120 turns; a
failed summary replaced the handoff with the regex fallback; and two transcripts of one session id
shared one handoff. Every fix a review turn asked for has a test that fails with the fix reverted,
apart from one lock-ordering fix in the Hermes plugin, which rests on its ordering argument. The
SessionEnd flush took 162–173 ms through the real hook process on an idle vault and 431 ms with the
vault held by another writer. Full suite: 3340 pass / 0 fail; `tsc` reports the same 85 errors as
v0.40.3. Cross-model adversarial review (codex / GPT-6, one pinned session): the design took 22
turns and 83 findings before any code, two of them settled by maintainer rulings; the implementation
took five more turns and 22 findings (10 High); the docs, and the Hermes and doctor defects found
while writing them, took 10 more turns and 51 findings. It cleared at turn 37 with zero remaining
findings.

### What didn't change

- The observer, judge and causal-writer prompts and models; `CLAWMEM_CAUSAL_WRITER` still defaults
  to `off`, and contradiction analysis still needs a configured judge.
- What `context-surfacing` retrieves and injects. Its usage rows gain the prompt hash, transcript key,
  host and session key.
- The composite formula. Its access and co-activation inputs are recomputed as above, so rankings
  that leaned on inflated counts move once.
- Paraphrases are not recognised as duplicates: the same decision stated in other words is a second
  item, as before.
- Transcripts are read as append-only. A transcript that is replaced, truncated or rewritten starts a
  new generation at its current turn; a branch made with `/rewind` is read as the file's lines stand.
- Pre-upgrade turns are not re-extracted, and the stop pipeline reaches an OpenClaw transcript only
  once some invocation of its session has resolved the file.
- **Downgrading** needs `clawmem repair counters --remove-fence` first, or the older version's
  Stop-hook writes are ignored and its surfacing hook injects nothing. Any v0.41 writable open
  installs the fence again.

---

## v0.40.3 — the watcher watches directories made after it starts

`clawmem watch` walked each collection path once, when it started, and watched the directories it
found. Nothing added a watch later, so a directory made afterwards went unwatched until the watcher
restarted, and the `.md` files in it reached the vault only on a full pass (`clawmem update`). On a
Claude Code host a new project directory, and later its `memory/` directory, appears several times
a day, so the auto-memory collection missed the first memories of every new project. A watched
directory deleted and made again at the same path fared no better: its old watch received nothing
for the new directory, and on ext4 the new directory even gets the old inode number back.

The rescan every event schedules (v0.40.2) now also looks at the directory's subdirectories, with
the startup walk's rules: excluded names (`gits`, `node_modules`, …) and `.`-prefixed names are
skipped. A symlink is not followed, as the index pass does not follow one, unless it is a collection
path itself, which the pass scans from. A subdirectory nobody watches is watched from then on. It is
watched before it is listed, so a file made in between reaches the listing or the watch; each `.md`
file it already holds is re-indexed; and the directories under it are taken on the same way,
breadth-first, so a tree made in one go (`mkdir -p`, a copy, a move into the collection) is watched
to its depth. Each directory of such a tree is decided on its own, so a collection path nested
inside it is taken on for its own collection. A watched subdirectory that is gone stops being
watched, with the watched directories under it, and each file it held is re-indexed once more, so
the removal reaches the vault. A directory is known by its device, inode and birth time, so one
deleted and made again at the same path is watched anew instead of staying on its dead watch.

### What changed

- `src/watcher.ts`: the subdirectory pass in the rescan; `adopt` (watch, then list, breadth-first);
  `retire` (a gone or replaced directory and the watched directories under it); the directory
  identity; the rescan checks its own directory first, so a watched directory that is gone or was
  replaced is handled even when its parent is not watched. Each collection path counts the
  directories it watches, new ones included, against `CLAWMEM_WATCH_MAX_DIRS`. A new directory
  counts for every collection path that watches its parent other than through a symlink, and for
  one whose own path it is. When none of them has room, the directory is skipped with the tree under
  it, the log prints `WARNING: <path> is at its cap of <cap> watched dirs` once per collection path,
  and directories made while it stays at the cap go unwatched (a watched directory that is removed
  frees its place). A collection path whose startup walk was over the cap watches no new directory,
  so the directories the cap left out at the start never slip in later. Taking on a tree yields to
  the event loop every 256 entries, as a rescan does, so a large tree copied into a collection does
  not hold up the watcher's other work (the vector daemon among it). A new directory that cannot be
  watched yet (its permissions, the kernel's watch limit) is tried again at each rescan of its parent
  and reported once. A replaced directory is watched again, path by path, by the collection paths
  that watched it and the directories under it before; one over the cap at the start takes on nothing
  its walk left out. The log names each directory the watcher takes on
  (`[watcher] new directory <path>: watching N dirs`, or `replaced directory`).
- Docs: `docs/troubleshooting.md` (a new *Indexing* entry), `docs/reference/configuration.md` (the
  cap counts new directories), `docs/guides/upgrading.md`, `AGENTS.md`, `SKILL.md`.

### Verification

`tests/unit/watcher.test.ts` adds twenty-three tests that drive the real watcher: a directory made
after the start (a file written in it later is delivered), the files a new directory already holds
(once each), a new directory holding more files than one batch (each once), a tree made with
`mkdir -p` (watched to its depth), a new directory whose event Bun < 1.4.0 folds into a file's,
excluded and hidden directories (never watched), a new symlink to a directory (not followed), a
symlinked directory the startup walk watched (keeps its watch; a directory made inside it is not
taken on, since the index pass never reaches it; replaced by a real directory, it is watched as
one), a collection path made after the start as a symlink (watched through a parent another path
watches), a collection path nested in a new tree (taken on for its own collection, even with the
outer one at its cap, and when it is a symlink), a new directory that cannot be watched yet
(reported once, watched once it can be), a watched directory deleted and made again (the same inode
on ext4), one another directory is renamed over, a replaced directory holding another collection
path (re-watched for it, even when that path was over the cap at the start, but never the
directories its startup walk left out), a watched directory removed with its files (each delivered
once, and its path made again is watched as new), the cap (new directories past it stay unwatched,
with one warning), a collection path over the cap at the start (watches no new directory),
overlapping collection paths (one watch, one delivery) and `close()`. Seventeen of them fail against
the v0.40.2 watcher under both Bun 1.3.14 and 1.4.2; the other six guard behaviour v0.40.2 already
had.
`tests/integration/cmdwatch-new-dirs.integration.test.ts` runs the real `clawmem watch` with a
Claude Code auto-memory collection: a project and its `memory/` made in one go, a file written later
in that `memory/`, and a project made first with its `memory/` added later (then an atomic save in
it) all reach the index; against the v0.40.2 watcher the first step never indexes. Full suite: 3103
pass / 0 fail on Bun 1.3.14 and on Bun 1.4.2; tsc unchanged. Cross-model adversarial review (codex /
GPT-6, one pinned session) took seven turns and thirteen findings, ten Medium and three Low, all
fixed. They included a failed watch that was never tried again, an adoption that held the event loop
on a large tree, symlinked directories the index pass never reads (taken on, and able to shadow a
real path), collection paths nested in a new tree, and replacements that re-watched too little, or
too much for a collection path over the cap at the start. It cleared at turn 7 with zero remaining
findings.

### What didn't change

- What the watcher watches at start, the per-file debounce, the rescan's comparison of files, the
  pre-check and routing (`watchTargets`).
- Each delivered file still starts an index pass of its collection, so a new directory that holds
  N files costs N passes, as a burst of N changed files already did.
- New directories count against the cap. On a Claude Code host each session that saves tool results
  adds a directory or two under its project, so a watcher that runs for weeks on the default cap
  (500) can reach it; raise `CLAWMEM_WATCH_MAX_DIRS` when the at-cap warning appears.
- A collection path that does not exist when the watcher starts is watched once it appears only if
  its parent directory is watched under another collection path.
- The startup walk still follows a symlink to a directory and watches it, although the index pass
  does not look inside one. A symlink made after the start is taken on only when it is a collection
  path itself, and a directory made inside a symlinked one is not taken on.
- On a filesystem without birth times, a directory deleted and made again with the same inode number
  is not told apart from the old one, and keeps the old, dead watch until the watcher restarts.
- Nothing to migrate. Restart the watcher, then run `clawmem update` once to index what the old
  watcher missed in directories made while it ran.

---

## v0.40.2 — the watcher re-indexes files saved atomically and files changed together

`clawmem watch` acts on the file name each change event carries. Bun before 1.4.0 folds the events
that reach one watched directory together into one callback per event type, named after the first
file; Bun 1.4.0 reports each event under its own name. Three common changes lost their name on the
way:

- an atomic save — a temp file written beside the target and renamed over it, which is how many
  editors, atomic-write libraries and agent tools save (Claude Code's Write and Edit tools among
  them) — arrived under the temp file's name (`notes.md.tmp.4242.9f3c`), and the watcher's `.md`
  filter dropped it;
- a rename inside one directory (`draft.md` → `notes.md`) arrived under the old name only;
- of two files written or deleted back-to-back in one directory, only the first arrived.

Those changes reached the vault only when something ran a full pass (`clawmem update`, the
`reindex` tool). For a Claude Code auto-memory collection that was nearly every memory file the
agent wrote.

The watcher no longer relies on the name alone. It keeps a listing of each watched directory: every
file it acts on, with its inode, size, mtime and ctime. Every event, whatever name it carries,
schedules one rescan of its directory `debounceMs` (2 s) later; a later event does not push a pending
rescan back, so a busy directory cannot starve it. The rescan compares each file with the listing as
it stands at that moment and hands each one that appeared, changed or disappeared to the same
per-file debounce and routing an event goes through. A file whose own timer is already pending is
left to that timer, and every delivery records the file's state in the listing, so a rescan never
re-delivers a state that was already delivered, whether an event or an earlier rescan delivered it.

### What changed

- `src/watcher.ts`: the listing and the rescan. Each directory is listed before its watch starts and
  again right after; a change between the two listings is delivered, so a save that lands while the
  watch starts is not lost. Collection paths that overlap, or name one directory in two spellings
  (`/notes` and `/./notes`), share one listing and one rescan per directory. A rescan reads the
  directory asynchronously, then looks at 256 entries at a time and yields between batches, including
  when it checks the files it no longer finds. For a directory of 10,000 `.md` files, the event loop
  (which also serves the vector daemon) stalled at most about 3 ms during a rescan, against about
  32 ms for one synchronous pass. On a host watching 15,274 directories holding 17,977 `.md` files,
  the two startup listings took about 0.3 s, next to a directory walk of 7 s or more. `close()` also
  cancels pending rescans, and no watch callback schedules work after it.
- Docs: `docs/troubleshooting.md` (a new *Indexing* entry; the editor-autosave note),
  `docs/guides/upgrading.md`, `AGENTS.md`, `SKILL.md`.

### Verification

`tests/unit/watcher.test.ts` adds fourteen tests. Eleven drive the real watcher. Six check delivery,
each exactly once under the file's own name: an atomic save that replaces a file and one that
creates it, a rename inside a directory (both names), two files written back-to-back, two files
deleted together, and an atomic save in a subdirectory. Three check that nothing extra is delivered:
a change the event stream reports by name is delivered once; files the watcher ignores, hidden files
and untouched files are not delivered; `close()` cancels a pending rescan. Under Bun 1.3.14 the six
delivery tests fail against the v0.40.1 watcher and the other three pass; under Bun 1.4.2 all nine
pass against both. Two more check that an atomic save in a directory two collection paths share
(overlapping, or one spelled with `/./`) is delivered once. Three pin the startup listing: which
files it holds; appeared, changed and removed files; a directory that is gone.
`tests/integration/cmdwatch-atomic-save.integration.test.ts` runs the real `clawmem watch` with a
Claude Code auto-memory collection: a file created by an atomic save, the same file replaced by one,
and two files rewritten back-to-back all reach the index with their new titles; against the v0.40.1
watcher under Bun 1.3.14 the first step never indexes. Full suite: 3079 pass / 0 fail; tsc unchanged.
Cross-model adversarial review (codex / GPT-6, one pinned session) took four turns and eleven findings,
nine Medium and two Low, all fixed. They included a rescan that held the event loop on a large
directory, a save missed in the moment a watch starts, a timer firing mid-rescan and overlapping
collection paths each re-delivering a file, mass removals that skipped the batching, and a claim
that a same-size rewrite inside one timestamp tick was covered (it is now a stated limit). It cleared
at turn 4 with zero remaining findings.

### What didn't change

- On Bun 1.4.0 and later the events already carry the right names: rescans find nothing more, and
  each change is still indexed once.
- The per-file debounce, the pre-check and routing (`watchTargets`), the directory cap and which
  directories are watched. Directories created after the watcher starts are still not watched until
  it restarts.
- Each file a rescan delivers starts an index pass of its collection, as each delivered event always
  has: a burst of N changed files costs N passes, the count Bun 1.4.0 and later already produced. On
  older Bun, where the fold hid most of a burst, that is new load after a large checkout or copy
  into a watched directory.
- A rewrite that keeps a file's size and lands within one filesystem timestamp tick of the watcher's
  last look at it leaves inode, size, mtime and ctime all unchanged, so no rescan can see it. On Bun
  before 1.4.0 such a write, if its event is folded away, waits for the file's next change or a full
  pass.
- Nothing to migrate. Restart the watcher, then run `clawmem update` once to index anything the old
  watcher missed. Upgrading Bun to 1.4.0 or later also fixes the event names for earlier ClawMem
  versions.

---

## v0.40.1 — the watcher re-indexes every collection it watches, and its directory cap is a setting

`clawmem watch` checks each changed `.md` file against its collection's pattern before it opens
the database, so a broad collection path with a narrow pattern does not start an index pass on
every edit under the tree. That pre-check read the directory part of a pattern as literal text
(`relativePath.startsWith("*/memory/**/")`) and split a brace list by stripping only a leading
`{` and a trailing `}`. Two pattern shapes could never pass it:

- a wildcard in a directory part, such as `*/memory/**/*.md` (a Claude Code auto-memory
  collection rooted at `~/.claude/projects`);
- a brace list followed by a suffix, such as `{README,guide}.md`, which split into `README`
  and `guide}.md`.

The watcher dropped every change event for those collections without a log line, so edits and
deletions reached the vault only when something ran a full pass (`clawmem update`, the `reindex`
tool). On the host where this was found, 774 indexed documents in five collections were never
re-indexed on change.

Routing had a gap of its own. An event went only to the collection with the longest matching
path, found by a string-prefix test. An overlapping outer collection (`**/*.md` around an inner
`notes.md` collection) therefore missed every file the inner pattern rejected, a sibling that
shares a name prefix (`notes-archive/` beside `notes/`) was routed to the wrong collection, a
collection rooted at `/` lost the first character of every path, and a collection whose configured
path was not normalised (`/notes/./x`) received no events at all.

The pre-check now matches the way an index pass scans: `matchesCollectionPattern` in
`src/indexer.ts` uses the indexer's own brace expansion and `Bun.Glob`, so the watcher never skips
a file `indexCollection` would take. Files the pattern cannot match are still skipped before any
database access. An event now reaches every collection whose path contains the file and whose
pattern can match it (`watchTargets`), with each relative path computed by `path.relative`.

The release also documents the watcher's directory cap and makes it a setting. At startup the
watcher walks each collection path and watches every non-excluded directory, one OS watch each,
up to 500 per collection path. The cap was a constant that only a startup warning mentioned, and
the warning blamed file-descriptor exhaustion. On Linux, Bun keeps every watch on one inotify
descriptor; the limit that matters is the kernel's per-user `fs.inotify.max_user_watches`, which
every process shares. `CLAWMEM_WATCH_MAX_DIRS` now sets the cap. The default stays 500, so nothing
changes unless you set it. Past the cap the warning says how many directories it watches, that
changes in the others wait for the next full index pass, and which setting raises the cap.

### What changed

- `src/indexer.ts`: `matchesCollectionPattern(pattern, relativePath)`, built from the indexer's
  `expandBraces` and `Bun.Glob` (each alternative is normalised, so `./` and `//` segments and a
  trailing `/` match like the normal form; a pattern that is not relative to the collection root defers to the index pass);
  `pathWithin(root, fullPath)`; and `watchTargets(collections, fullPath)`.
- `src/clawmem.ts`: `cmdWatch` re-indexes each collection `watchTargets` returns; no string-prefix
  gate runs before it, and the beads branch finds its collection with `pathWithin`. A pattern naming a single file
  (`notes.md`) now passes only that file at the collection root, as the index pass does; the old
  check also passed a same-named file in any subdirectory, which started a pass that indexed
  nothing.
- `src/watcher.ts`: `DEFAULT_MAX_WATCH_DIRS` (500) and `resolveMaxWatchDirs()` read
  `CLAWMEM_WATCH_MAX_DIRS`. Unset or empty means 500; any other value that is not a positive
  integer falls back to 500 with a warning line. The cap warning names the setting.
- Docs: `docs/reference/configuration.md` (a new File watcher section), `docs/troubleshooting.md`
  (the pre-check and directory-cap entries), `docs/guides/systemd-services.md` (a drop-in example),
  `docs/guides/upgrading.md`, `AGENTS.md`, `SKILL.md`.

### Verification

`tests/unit/watcher.test.ts` (16 tests) covers the pre-check (both broken shapes, unnormalised and
out-of-root patterns, non-matching paths still skipped, the shapes that already worked), the routing
(an overlapping outer collection, a name-prefix sibling, a `/` root, unnormalised collection paths,
a collection without a pattern) and the cap
setting (the default, valid, empty and invalid values, and a watcher capped at 3 that names the
setting in its warning). Against the v0.40.0 pre-check logic, the two broken-shape tests fail and
the others pass. `tests/integration/cmdwatch-precheck.integration.test.ts` runs the real
`clawmem watch` against a temp vault with the three collection shapes (one configured with an
unnormalised path) and checks the log lines and the indexed rows; against the v0.40.0 `cmdWatch` it
fails. On the host where the
bug was found, the new pre-check passes every indexed document; the old one dropped 774. Full suite:
3064 pass / 0 fail; tsc unchanged.
Cross-model adversarial review (codex / GPT-6, one pinned session) took five turns and fourteen
findings, seven Medium and seven Low, all fixed. They included the untested call site, an event
reaching only the longest matching collection path, a string-prefix gate ahead of the routing,
unnormalised patterns and collection paths that still lost events, and a file-descriptor diagnosis
that could miss watch exhaustion. It cleared at turn 5 with zero remaining findings.

### What didn't change

- The default cap (500), and which directories the watcher walks and excludes.
- Index passes: a collection indexes the same files as before. Only which change events reach a
  pass is different.
- Nothing to migrate. Restart the watcher to pick up the fix; one `clawmem update` indexes anything
  the old pre-check skipped.

---

## v0.40.0 — after a compaction, a session gets back its own pre-compaction state and nobody else's

Through v0.39.1 the pre-compaction state was one file per project directory. `precompact-extract`
wrote `precompact-state.md` into Claude Code's auto-memory directory
(`~/.claude/projects/<project>/memory/`), and `postcompact-inject` read it back on every session
start in that directory, with no session key, no age check and no check of why the session
started. So:

- a session received the last compaction of whichever session in the same project directory had
  compacted most recently, including one that ran concurrently in another terminal;
- a fresh start, a resume or a `/clear` received it too, because the installer put
  `postcompact-inject` under SessionStart matcher `""`;
- a PreCompact that extracted nothing left the older file in place, to be replayed at the next
  compaction;
- the block was injected unfiltered, under the heading "authoritative", which told the model to
  prefer it over its own summary.

The extraction itself was also wrong. The "last user request" was the last entry with the user
role, which in an agentic session is almost always a tool result, and decisions were mined from
tool input and output as well as prose. And PreCompact re-indexed a collection from inside the
hook, so the state files were indexed and surfaced in search as ordinary memories.

What changed:

- **The state belongs to one session.** PreCompact stores it as that session's row in a new vault
  table, `compaction_state`. The SessionStart that follows the compaction (source `compact`)
  takes it once: reads and deletes it in one statement. A state older than 15 minutes is never
  injected, and a start for any other reason injects nothing. The block's recent decisions,
  antipatterns and vault context still come from the whole vault, as before; only the
  pre-compaction state is per session.
- **A failed PreCompact leaves nothing to replay.** Before it opens the vault, PreCompact registers
  its attempt in a small database beside the vault (`<vault>-compaction.sqlite`), and the SessionStart takes
  only the row carrying the registered attempt. A PreCompact that fails after registering, with a
  busy vault, an unreadable transcript, nothing to extract or the host's timeout, leaves no
  snapshot to inject, and an older PreCompact that finishes after a newer one started stores
  nothing, whether it resumes before or after the newer one stored its state. A SessionStart that
  runs while its PreCompact is still extracting retires that attempt, and one whose read of the vault
  waited while a newer PreCompact of the session registered injects nothing.
- **The block is data.** It is framed as notes extracted by pattern matching, to be checked before
  acting on them, and every field (captured text, vault titles, paths, snippets) is filtered for
  injection, flattened to one line, bounded, and cannot open or close a tag.
- **The request is what the user typed.** A classifier separates typed prompts from tool results,
  harness records (command wrappers, local command output, task notifications, system reminders)
  and meta entries, and it looks back up to 2000 entries for the last one. Decisions and open
  questions come from prose only. `readTranscript`'s output is unchanged.
- **No re-index from PreCompact.** The hook writes nothing into Claude Code's memory directory and
  indexes nothing.
- **`clawmem setup hooks`** installs `postcompact-inject` in its own SessionStart group, matcher
  `compact`, and removes ClawMem's hooks handler by handler, so another tool's hook in the same
  group survives an install or a `--remove`. The manual JSON in the setup guide now has the
  `{matcher, hooks}` shape Claude Code expects, and the transcript-path example uses
  `.transcript_path`.
- **The old files stay out of retrieval and enrichment.** Search and retrieval never return an
  indexed copy of the old `precompact-state.md` (recognised by the header the old versions always
  wrote, never by name alone), whoever indexed it, including an older ClawMem still running against
  the vault. The check runs inside every query that finds documents nobody named: the keyword,
  vector, graph, entity and causal routes, timeline neighbours, review reminders, evolution
  history, a glob or path-suffix match in `get` / `multi_get` / the `clawmem://` resource, the
  did-you-mean list, the target search of `memory_pin` / `memory_snooze` / `memory_forget`, and the
  REST export. No automatic enrichment or embedding reads a copy either: A-MEM notes, links and
  evolution, entity extraction, graph building, consolidation, deduction, conversation synthesis,
  `clawmem embed` and the doctor's vector sampling all skip it. So there is nothing to migrate first
  and no window while one runs. A get (or a lifecycle tool) by its exact path or docid still reaches
  it. The indexer skips the files and deactivates each indexed copy it finds. A file with that name
  and your own content is an ordinary document.
- **Notes a copy shaped are rebuilt.** Older versions let a copy feed A-MEM evolution, so another
  session's text could end up in a note's A-MEM summary and be carried forward. The first writable
  open clears each such note, the light-lane backfill (`CLAWMEM_ENABLE_CONSOLIDATION=true`) rebuilds
  it from the note's own text, and `memory_evolution_status` shows a `reset:` entry where the tainted
  entries were. A note indexed from a file is also rebuilt when the file changes or by `clawmem
  reindex --enrich`; one that hooks or the API wrote stays without an A-MEM note until the light
  lane runs (search and injection never use one). No prompt reads such a note meanwhile. A
  note an older ClawMem still running evolves after the upgrade gets the same treatment, whether or
  not a copy ever touched it, since an older process reads notes unguarded: this version stamps
  every evolution entry it writes, and an older one cannot.
- **REST `/export`** leaves the copies out by default and says how many
  (`legacy_snapshots_excluded`); `?full=true` includes them (every active document).
- **`get` and `multi_get` resolve `collection/path` exactly** before they try the text as a path
  suffix, so a display path no longer depends on the suffix fallback's first match.
- **`clawmem doctor`** flags `postcompact-inject` under any matcher but `compact`, lists the old
  files (red when one was written after the upgrade, which means an older ClawMem process is
  still running against the vault), and lists indexed copies that are still active.
- **OpenClaw** takes its fallback session id from the transcript file's stem, and skips a stem it
  cannot split with certainty (one containing `-topic-`).

All of this describes an upgraded process. An older ClawMem still running against the vault keeps
its own behaviour, the leak included, until it is upgraded or stopped: upgrade every process that
shares the vault.

The state still depends on Claude Code sending the same `session_id` to PreCompact and to the
SessionStart that follows it, which is what the field means on both events. One case stays
open by nature: a PreCompact whose disk refuses both the registration and the vault write cannot
mark anything stale, so an earlier state of that session that nothing took can still be injected
within its 15 minutes.

### Verification

Nine test files, `tests/unit/compaction-*.ts`: 120 tests. `compaction-cli.test.ts` runs the two
hooks through the real `clawmem hook` dispatcher, one process per hook, as the host does;
`compaction-mcp.test.ts` drives the real MCP server, resource and REST routes;
`compaction-enrichment.test.ts` runs the enrichment pipelines with a model stub that records every
prompt; and `compaction-embed.test.ts` runs `clawmem embed` against an embedding server that records
every input. Of the tests that drive public entry points (the hook dispatcher, `setup hooks`,
`doctor`, the OpenClaw engine, the MCP server and REST routes, and `clawmem embed`), 34 of 38 fail on
the v0.39.1 code as each defect predicts; the 4 that pass there are controls. The unit tests of the
new state store, registration, transcript classifier and A-MEM repair need modules v0.39.1 does not
have, so they cannot run there. Across the release, 66 targeted reversions of its behaviour each
make a test fail.
Full suite: 3047 pass / 0 fail; `tsc` reports the same 85 errors as v0.39.1. Cross-model
adversarial review (codex / GPT-6, one pinned session) took fifteen turns and 75 findings, 22 of
them High, all resolved before release; three were questions of scope that the maintainer decided.
It cleared at turn 15 with zero remaining findings.

---

## v0.39.1 — collection and context edits keep the comments in config.yaml

Every command that writes `~/.config/clawmem/config.yaml` re-serialised the parsed config with
`YAML.stringify`: `clawmem collection add` and `clawmem collection remove`, and the rename and
context writers behind the store's collection-rename and context-delete paths. Each write
silently dropped every comment, blank line and quoting choice in the file, with exit 0 and no
warning. Those comments are often the only record of why an entry looks the way it does. The
config has no exclude key, so a collection whose pattern lists its subtrees instead of `**/*.md`,
to keep vendored clones out of the vault, is explained in a comment or not at all — and a later
tidy-up that cannot see the reason widens the glob.

The writers now edit the parsed YAML document in place. An edit rewrites only its own lines;
comments, blank lines, quoting and key order everywhere else come back as they were. Removing a
collection removes the comment lines directly above it; a comment that a blank line separates
from the entry, such as a section header, stays where it was, and so does a comment at the end
of the `collections:` line. Collection names that YAML reads as numbers (`2024:`) are matched as
the names they are. YAML aliases keep their values: when an edit changes or removes what an alias
names, that alias becomes a copy of it first, and aliases an edit does not reach are written as
they were. Several aliases to one mapping or list share one copy, so they stay one value. An alias
inside the node it names (an entry that refers to itself) is not copied; it goes on naming that
node, edit included.

Before it writes, each edit reads back the text it is about to write and checks that the effective
config changed only where the edit names, and as asked. Where the file uses a YAML feature an
in-place edit cannot keep, such as a collection that only a merge key (`!!merge <<:`) provides, the
command stops with an error naming what would have changed, and the file is left untouched.

Two smaller changes come with it:

- `clawmem collection add` with a name that already exists updates that collection's path and
  pattern in place and keeps its `update` command. It used to rebuild the entry from path,
  pattern and context and drop `update` without a word.
- A write no longer copies the lifecycle defaults into the file. `lifecycle` stays as you wrote
  it; ClawMem still applies the defaults when it reads the file, so the effective policy is
  unchanged.

A few cosmetic limits remain, all from the YAML library's printer, and none of them loses data or
a comment. Indentation is normalised to two spaces, as before. A comment on the last line of the
file gains a blank line above it on the first write. An anchored block whose first comment
follows a blank line has its anchor moved onto a line of its own. Flow collections (`[a, b]`) are
all written with the spacing most of the file's flow collections use.

### Verification

`tests/unit/collections-config-comments.test.ts` (59 tests) states the exact file each writer
must produce from a commented config: add, re-add, remove (first, middle, last and only entry,
with and without a blank-line header), rename, a numeric-looking name, an empty `{}`, a missing
file, an end-of-file comment, a parse error, and the three context writers; then anchors, aliases,
tags, alias and list keys, flow spacing, merge keys, self-references, and `!!set` and `!!omap`
values. On the v0.39.0 code 47 of the 59 fail; the 12 that pass cover behaviour this release
keeps. Full suite: 2927 pass / 0 fail. Cross-model adversarial review (codex / GPT-6, one pinned
session) took ten turns and twenty findings, five of them High, all fixed except one Low accepted
as the flow-spacing limit above. They included aliases an edit changed or left dangling, explicit
tags kept on new values, key aliases and list keys renamed, a self-referencing alias copied
without end, and a collection that only a merge key provides written half-made, which led to the
read-back check. The last two rounds found that check refusing correct edits, of self-referencing
files and of `!!omap` and `!!set` values. It cleared at turn 10 with zero remaining findings.

---

## v0.39.0 — the OpenClaw plugin installs and runs on current OpenClaw, and `forgotten` counts only forget

OpenClaw added three checks between April and May 2026 that each switched off part of the
ClawMem plugin without an error at install time, and the plugin had no time budget of its own
for the context-surfacing hook. This release answers the three GitHub reports that followed
([#26](https://github.com/yoloshii/ClawMem/issues/26), [#27](https://github.com/yoloshii/ClawMem/pull/27), [#28](https://github.com/yoloshii/ClawMem/issues/28)) and carries one
reporting-contract fix for the lifecycle counts.

### OpenClaw plugin: installs, registers and keeps its hooks on OpenClaw 2026.5+ (#27)

- The manifest declares the five agent tools under `contracts.tools`. From OpenClaw 2026.5.2 the
  registry rejects `registerTool` for any undeclared name, and the plugin kept running hook-only.
  Thanks @cleverark ([PR #27](https://github.com/yoloshii/ClawMem/pull/27)) for the manifest change and the docs section this
  release builds on.
- `clawmem setup openclaw` installs a compiled copy. From OpenClaw 2026.5.3,
  `openclaw plugins install --force` refuses a package whose entry is `index.ts`, so setup
  bundles a Node-target `dist/index.js`, points `openclaw.extensions` at it, and installs that
  staged copy. Nothing generated is committed.
- Capability consent. OpenClaw 2026.5 asks for consent to a plugin's declared capabilities on
  every local install. Setup prints what ClawMem declares and passes `--accept-capabilities`
  only after an interactive yes or with `clawmem setup openclaw --accept-capabilities` (alias
  `--yes` / `-y`); a non-interactive run without it stops and says so.
- Setup writes the config a working install needs and reads each value back: the absolute
  `clawmemBin`; `plugins.entries.clawmem.hooks.allowConversationAccess=true` (from OpenClaw
  2026.4.23 a plugin OpenClaw did not bundle may not register `before_prompt_build` or
  `agent_end` without it); and `plugins.slots.memory=clawmem` (since the September 2026 main
  branch an unselected memory plugin still loads but loses its memory runtime). A write that does
  not read back fails setup with a non-zero exit. Setup also warns on `allowPromptInjection=false`
  and on an operator hook-timeout policy below the plugin's own timeout.
- `--gateway-user <name>` for system-service installs: setup checks that the installed files are
  owned by that user or root and not world-writable, that the user can read them through every
  directory on the way (symlink targets included), and that it can run the `clawmem` binary, all
  judged from its uid and supplementary groups. A missing manifest or `package.json` fails the
  check too. Setup exits non-zero when any check fails.
- `OPENCLAW_PROFILE` reaches OpenClaw: setup passes it to every `openclaw` command as
  `--profile <name>` (the variable alone selects nothing in OpenClaw) and checks it against
  OpenClaw's profile-name grammar before deriving any path from it, `--remove` included.
- The installed root is read from `openclaw plugins inspect clawmem --json`; an inferred root is
  used for diagnostics only.
- A replaced install is parked first and put back if the replacement fails, on the delegated,
  CLI-absent and `--link` paths. A failed restore names the parked copy (`clawmem.old-<pid>`) and
  the `mv` that brings it back.
- Setup records `clawmemBin` only as an absolute path to a regular file the installing user can
  execute (a bare `clawmem` is resolved through `PATH` first) and stops otherwise; the plugin
  refuses a configured `clawmemBin` that is missing, not a regular file, or not executable.

### OpenClaw plugin: one time budget for the context-surfacing hook (#28)

The new plugin config `hookBudgetMs` (default 6000 ms, 1000 to 25000) is the hook's wall-clock
budget. The plugin passes it to the hook as `CLAWMEM_HOOK_BUDGET_MS`, which the v0.38 hook
schedules its legs against; kills the hook 2 s after it; and registers `before_prompt_build` with
OpenClaw 2 s after that, so the three limits stay in that order. An operator hook-timeout policy
below the registration value still fires first, and setup warns when it finds one. 25000 is the
hook's own ceiling (`MAX_LEG_BUDGET_MS`): the hook refuses to run above it, so the plugin clamps
to it rather than pass a value the hook would refuse. Timeout messages name the hook, the profile
and the budget. At `profile: deep` without an LLM or reranker endpoint, the plugin logs one
warning at registration that names the missing legs.

### node-llama-cpp ^3.20.0 (#26)

`node-llama-cpp` moved to ^3.20.0 (llama.cpp b10361) and `bun.lock` was regenerated. A source
checkout on macOS 26.6 with an M5 Pro no longer fails with
`ggml_metal_library_init_from_source: error compiling source`. In-process Qwen3 reranker scores
are now the model's probability; 3.15.1 applied a second sigmoid that squeezed every score into
about 0.50–0.73. The local rerank cache is namespaced by a new score revision, so scores cached
under 3.15.1 are never reused. Remote rerank caches go cold once as well: until this release the
in-process fallback wrote its scores under the remote endpoint's namespace whenever the endpoint
failed, so a v0.38 remote cache can hold local, squeezed-scale scores labelled as the endpoint's.
The fallback now caches only in local mode, and remote namespaces carry a revision that makes
those entries unreachable. The first reranked queries after upgrading re-score cold. On CUDA the
first in-process embedding after the upgrade compiles its kernels once (about ten seconds on a
GTX 1080 Ti); run `clawmem embed` once after upgrading to pay that outside a prompt.

### Changed — `forgotten` counts only forget (a reporting-contract change)

- `clawmem lifecycle status`, the `lifecycle_status` MCP tool, `GET /lifecycle/status` and `clawmem curate` report
  `forgotten` as the number of documents deactivated by forget (`deactivated_reason = 'forget'`). It used to count
  every inactive document without `archived_at`, which also took in documents whose file disappeared and documents
  deactivated before v0.31.0 recorded a reason — so on an existing vault the number usually drops. Nothing in the
  vault changes; the old count was mislabelled.
- New: every inactive document broken down by deactivation reason — `absent`, `forget`, `archive`, `unknown_legacy`
  (no recognised reason and no `archived_at`; in practice deactivated before v0.31.0, cause unrecoverable, so not
  guessed). Exhaustive and disjoint. CLI and MCP print `Deactivation reasons: absent N, forget N, archive N,
  unknown-legacy N`; `GET /lifecycle/status` adds `deactivation_reasons`; the curator report adds
  `health.deactivationReasons`. No migration.

### Docs

- Upgrading guide: a hook that starts while an upgrade is still replacing files can load a mix of old and new modules
  and fail; the failure is non-blocking, so that one prompt runs without ClawMem context (or that turn-end extraction
  is skipped), and the next invocation loads the new code.
- The CLI reference documents the new `setup openclaw` flags and `OPENCLAW_PROFILE`;
  troubleshooting adds the Apple Silicon Metal compile error, the hook timeout message and the
  conversation grant.

### Verification

- Live, on the pre-rebase branch (2026-09-09): `clawmem setup openclaw --accept-capabilities
  --gateway-user <user>` against a real OpenClaw 2026.9.2 in an isolated state directory. The
  compiled stage was accepted, the memory slot moved from memory-core, all three config values
  read back, `openclaw plugins inspect clawmem --json` reported the plugin loaded and activated,
  and the gateway logged the registration (`kind=memory`, `hookBudgetMs=6000`), the five agent
  tools and the REST service.
- Full suite: 2868 pass / 0 fail · the five OpenClaw suites: 200/200 · `tsc --noEmit`: 85 errors, all
  pre-existing (the same set as v0.38.1 with the two handed-over commits), none new.
- New locks: the plugin's default, minimum and maximum budget equal the hook's, the hook's parser
  accepts every value the plugin can pass unchanged, and the manifest carries the same range
  (four of these fail against the former 60000 cap); the local rerank namespace carries the score
  revision (fails against the v0.38 key); an attested endpoint that fails leaves nothing under its
  key and the next healthy call scores live (fails against the v0.38 write rule); read and
  traverse access for the gateway identity is judged from mode bits along the kernel's own walk,
  symlinks included, and an installed copy missing its manifest fails `--gateway-user`; a
  `clawmemBin` without an execute bit is refused at setup and at plugin start.
- Cross-model adversarial review (codex): the OpenClaw work cleared after seven turns; this
  release's rebase, budget ceiling and rerank-cache changes took four more turns on the same session
  and seven findings, all fixed (local fallback scores cached under a remote namespace; the gateway
  user's read access, including symlinked and slash-terminated paths; the recorded `clawmemBin`; two
  overstated release-note sentences), and cleared at turn 11. The lifecycle change
  cleared its own review in the first round, and its O1 clock and seam audits found nothing.

### What didn't change

No schema change and no migration. Hooks, MCP tools and the REST API behave as in v0.38.1 apart
from the lifecycle counts and the one-time cold rerank caches above.

---

## v0.38.1 — the watcher now logs the version skew it refuses

v0.38.0's vector wire refuses mixed builds in both directions, but only one direction was
visible. A v0.38 hook talking to an older watcher prints a once-per-process warning naming the
socket. A pre-v0.38 hook talking to a v0.38 watcher is refused as `version_skew`, and that old
hook maps the error to its generic FTS fallback — silent by default; even its opt-in
`CLAWMEM_VEC_TIMING` trace shows only `path=error`. The watcher said nothing either. A hook and a watcher running from different installs therefore lost every vector leg
with no trace on either side — surfacing kept working on keyword matches, so it read as weaker
recall rather than as a fault.

The watcher's vector daemon now logs the first refusal:

```
[vec-daemon] refused a request from a pre-v0.38 client on <socket> (absolute deadlineMs → version_skew) — its vector legs degrade to FTS until it runs this build (usually the hook, from another install); further refusals are not logged
```

It logs once per daemon (the watcher hosts one per run), never per request: an old hook sends a
refused request on every prompt. `journalctl --user -u clawmem-watcher.service | grep
version_skew` finds it; the fix is to run the hook from the same install as `clawmem watch` and
restart the watcher ([troubleshooting](docs/troubleshooting.md)). The daemon runs inside the
watcher, so the line appears only once the watcher itself runs v0.38.1.

### Verification

A new unit lock sends three pre-v0.38 requests through a live daemon socket and asserts exactly
one log line, naming the socket; a ping and a served request add none; a restarted daemon logs
its own first refusal. A second lock makes the log sink throw on the first refusal: the daemon's
entire reply is still the single refusal frame, and the line is written on the next refusal
instead, so a line the sink refused does not count. Each of these mutants fails a lock: the
once-guard dropped, the log call dropped, the flag hoisted to module scope, the flag set before
the line is written. Full suite: 2787 pass / 0 fail. Cross-model adversarial review (codex /
GPT-6, the arc's pinned session) caught the log-sink failure path in its first round and cleared
the second with zero remaining findings.

The release's suite run also caught a pre-existing test flake. A hydrated-projection test capped
a leg's recorded 400 ms budget at exactly 400, but the budget is the difference of two
`performance.now()` instants: when a leg starts within 400 ms of a power-of-two millisecond of
process uptime, the deadline's addition rounds and the budget reads 400.0000000000582. The bound
now allows float rounding, as the wall-jump lock's already did; the recorded evidence is
unchanged.

### What didn't change

The wire contract is byte-identical: a refused request still receives exactly
`{"error":"version_skew"}`, decided by field presence before anything is decoded, and nothing is
scanned. The hook is unchanged, including its once-per-process warning for the opposite
direction. No schema, configuration or CLI change.

---

## v0.38.0 — the context-surfacing hook ranks, admits, and bookkeeps on one honest key

The hook's ranking pipeline had accumulated incomparable signals: raw cosine and BM25
scores sorted against each other, composite-score admission that rejected on-topic
documents while admitting junk, a topic boost and metadata reorders layered on top of
the sort, and post-injection SQLite bookkeeping riding the prompt-latency path. This
release rebuilds the pipeline around a single ordering authority, measured end to end
by a judged evaluation (labeled gold cases replayed through the real handler) that
ships as part of the release.

### One channel-aware ordering key

Every retrieval leg — BM25, vector, file-aware, the gated prior-turn leg, and deep
expansion variants — contributes a ranked **lane**; weighted reciprocal-rank fusion
produces one key per candidate: a **band** (0 = supported by the current turn's own
lanes, 1 = discounted-lane-only survivor) and a scale-free fused **mass**. That key
decides pool membership (under an expansion mass cap + protected current-class slots,
so recall hints can never outvote the user's actual question), the final injected
order, and — new in this release — admission. Discounted-only candidates order
strictly below every current-supported one. No mixed raw-score sorts remain, and no
metadata reorders: the spreading-activation and memory-type-diversification stages
are deleted, and pins/recency/quality multipliers can no longer change hook membership or ordering — composite retains tier sizing, so they still influence snippet depth (HOT/WARM/COLD). Co-activation is absent from the hook entirely. (All of it still acts on the composite MCP surfaces.)

### Relevance admission, with honest abstention

Keep/drop is judged on the same key that orders: a relative floor (≥ 50% of the top
candidate's fused mass) inside band 0, and query-level abstention when there is
nothing defensible to inject — `no-current-support` (band 0 empty, unless the
anaphora gate certified the prior turn as the only signal) and `degenerate-basis`
(FTS agreed on nothing — the vector-only junk signature of gibberish prompts). The
pre-existing composite gate survives solely as the eval control arm behind
`CLAWMEM_ADMISSION_POLICY=composite`.

### The deep rerank lane earns its influence

An applied rerank needs full candidate coverage (a partially-covered pool is never
partially reordered) AND a discriminating score set — the per-request **degeneracy
gate** (`CLAWMEM_RERANK_DEGENERACY_GATE`, default on) discards collapsed or near-constant score sets instead of trusting their arbitrary order (the 0.05 spread floor is calibrated from the zerank baseline and validated by the judged eval; another provider may need its own calibration). A passing rerank
joins the final order as one more rank-fused lane (`CLAWMEM_RERANK_LANE_WEIGHT`,
default 1.5) — mass within the bands, never a band elevation. Remote rerank scores
are now cached only under an **attested provider identity**: `clawmem rerank-health`
fingerprints what the endpoint actually serves (7-day expiry, failed probes revoke),
so cached scores are namespaced to the attested provider. A same-URL swap nobody re-probes is honored until the next `rerank-health` refresh or the 7-day expiry — which is exactly why attestations expire instead of being trusted indefinitely. The rerank
request revision bumped (`RERANK_REQUEST_REV=2`), invalidating prior cache entries
once.

### Deadlines that hold

`CLAWMEM_HOOK_BUDGET_MS` (default 6000) is the hook's authoritative internal budget;
every in-handler deadline derives from it, with a 500ms finalization reserve — a measured, invariant-audited margin for payload assembly, not an unconditional guarantee (the write path that could stall left the handler entirely, below). Expansion carries a real transport abort (an abandoned
promise no longer holds the process past its budget), and `clawmem setup hooks`
derives the host timeout from the budget (≥ 1.5s startup + budget, never reducing a
larger existing value) while `clawmem doctor` checks the inequality.

**Scope of the vector deadline — daemon-backed deployments.** The one deadline the handler
cannot enforce by itself is the vector leg's: the sqlite-vec MATCH is synchronous, and a
`Promise.race` timer on the same event loop cannot fire while it runs. The profile's vector
timeout (900ms balanced, 2000ms deep) is therefore authoritative **when the watcher's vector
daemon serves the vault** (`clawmem watch` — the scan runs off the hook's loop and the timer
can actually fire); without the watcher the hook still works, but a cold multi-GB scan blocks
the handler for the scan's full duration and the budget is a target, not a bound. The
release's latency evidence was gathered under exactly that daemon-backed topology: the hook
replay-eval spawns a dedicated vector-daemon child on its working copy (the watcher's
steady-state prewarm performed before readiness, every vector leg daemon-required, daemon
loss refuses the run) and records the protocol in the run identity (`vector_exec`), where it
is strict across baseline, pair and replicated comparisons; an in-process replay is recorded
as such and its latency axes are unmeasured. Making the vector path structurally bounded
without a watcher is future work, not a claim of this release. **Fixed alongside:** a stale
daemon socket left by a crashed watcher silently prevented the next watcher from ever binding
its daemon (the liveness probe threw on a missing socket handler and the bind was skipped) —
the hook then ran in-process, unbounded, with no diagnostic; the probe is fixed and the
stale-socket bind is regression-tested. Because the contract is scoped to daemon-backed
deployments, the prerequisite is checkable: `clawmem doctor` now verifies the vault's
daemon by a real round trip, and `clawmem vec-daemon-health` (exit 0 only for an attested `live` daemon on the vault's
socket; `live-raw` and `live-legacy` prove a listener but not the contract, and exit 1) is
the scriptable gate the shipping preflight uses.
In the replay-eval, daemon ownership is re-verified before and after every rep, a
`steady-state` prewarm that had no vector payload to warm refuses vector-exercising runs,
and an in-process replay's budget gate is reported as unmeasured (raw timing kept as a
diagnostic) rather than as a pass or an overrun.

**Deadlines are monotonic now (O1).** Every deadline in the hook used to be an absolute
wall-clock instant compared against `Date.now()`, so an NTP step moved every deadline at once
and silently falsified the timing evidence the trust gate scores (measured on the release
host: a time daemon stepping +3.6 s every ~36 s produced four refused draws with multi-second
"overruns" that never happened). The handler now derives every deadline from ONE monotonic
anchor at entry; the daemon wire carries a **relative remaining budget** (`remainingBudgetMs`,
sampled immediately before the write) instead of an absolute deadline, and the daemon's own
deadline is advisory (check-before / check-after each synchronous phase — never cancellation);
expansion and rerank transports are cut by monotonic signals; the Stop hook's phase floors are
monotonic too. A pre-O1 request carrying `deadlineMs` is refused as version skew by field
presence, and a pre-O1 daemon that ignores the budget is classified `skew` — the leg degrades
to FTS with a once-per-process warning naming the socket (restart `clawmem watch`). The
mismatch runs both ways, so **upgrade the hook and the watcher in the same step**: a pre-v0.38
hook talking to a v0.38 watcher loses its vector legs to FTS silently. Only the
clock module samples a platform clock; two static audits (a raw-clock ratchet and a typed seam
audit over branded `MonoDeadline` / `DurationMs` / `EpochMs` values, both at zero debt) keep it
that way. The timing evidence changed with it: every rep's per-leg record is persisted
(`vector_leg_records`: monotonic `over_ms`, the span on both clocks with `clock_skew_ms`
exposing a realtime step, an orthogonal terminal kind × execution path, and a timing class
against the **frozen** 150 ms tolerance — never re-fitted). The contract is identity: the run
records `deadline_protocol: "monotonic-relative-v1"`, the daemon advertises `deadline-rel-v1`
beside `hydrated-v1`, `clawmem doctor` / `clawmem vec-daemon-health` require both for the
authoritative `live` tier, and every comparison surface (baseline, pair, replicated members)
fails closed on a report without it. `CLAWMEM_HOOK_BUDGET_MS` gained a **maximum of 25000**
(the wire ceiling): larger values are refused by the hook, by `clawmem setup hooks` and are
reported by `clawmem doctor`; the fallback and clamp behaviours below the maximum are unchanged.

### Bookkeeping left the hook

After the payload is assembled the hook does zero SQLite/filesystem work in normal production mode (the one disclosed exception: the diagnostic `CLAWMEM_SURFACING_TRACE=1` trace persist). Turn
alignment became a single early **fail-closed** `context_usage` row at retrieval
commit — no row, no injection, so injected context is never untracked and prompt
history survives deadline skips. Recall events, injected-paths fill-in, and
secondary-vault mirrors are handed to a detached `clawmem spool-ingest` child over a
bounded pipe (250ms flush race; losing the race costs only that turn's optional
learning data) and applied by a claim-by-rename drainer with per-row idempotency
keys — crash-and-retry can never double-count. `clawmem spool-drain` applies pending
jobs manually.

### Session focus narrowed to presentation

A focus topic now steers snippet selection only. The 1.4×/0.75× post-composite topic
boost and the expansion/rerank intent threading are removed: a session preference
must not change what surfaces or in what order, only which sentences of a surfaced
doc are shown.

### The judged hook eval harness

`clawmem eval hook-run` replays labeled UserPromptSubmit cases through the real
handler against a corpus snapshot: graded nDCG over the injected order, must-include
recall, must-not damage rate, abstention accuracy, prior-leg accuracy, latency, and a
hermetic invariant audit — with run-identity fingerprints (corpus, code, inference
topology, served-model probes), holdout-only acceptance gates, paired counterfactuals
(frozen expansion draws + per-case pre-treatment audits), registered treatments, an
experiment-pinned clock, and `eval hook-aggregate` for replicated-draw distributional
verdicts. `CLAWMEM_SURFACING_TRACE=1` captures the same per-stage trace envelope
live into `surfacing_diagnostics` for post-hoc diagnosis.

### Verification

Judged replicated A/B on a frozen corpus snapshot: 31 labeled cases (22 tuning, 9 holdout),
five frozen expansion draws, each captured on the control arm (the pre-v0.38 composite
admission) and replayed into the candidate (relevance admission), every candidate pair-gated
at 31 valid pairs. Relevance admission raised graded nDCG from 0.528 to 0.830 and
must-include recall from 0.50 to 1.00 in every draw (direction-stable across all five), with
abstention and prior-leg accuracy at 1.00, no must-not hits and no timeouts; latency moved
within noise (p50 ≈ 57 ms, p95 ≈ 1.8 s). Every run's trust gate passed under the
daemon-backed protocol and the monotonic deadline contract: across 1,065 vector legs the
worst overrun past its own deadline was 1.7 ms (tolerance 150 ms), and the slowest handler
finished in 4.1 s of its 6 s budget. Two draw slots were redrawn under the pre-registered
protocol after pair-gate refusals caused by transient host load (a control-arm vector leg
cut at its deadline); the refused draws are kept as evidence, never reused.

Cross-model adversarial review (codex / GPT-5.x and GPT-6), pinned sessions: the ranking,
admission, bookkeeping and hydrated-v1 work was reviewed turn by turn through the arc; the
monotonic-deadline design went through thirteen revisions before implementation, and its
migration cleared a four-round review to zero remaining findings (10→7→1→0). Wall-clock
steps of ±5 s, injected in the hook process and independently in a daemon child, leave every
client and daemon deadline decision unchanged; a mutation that makes the control clock
follow wall time fails all six of those locks. Full suite at clearance: 2785 tests,
0 failures.

### What didn't change

The MCP retrieval tools keep composite ranking — pins, recency, quality and co-activation
still act there; only the hook stopped ordering and admitting on it. Without a watcher the
hook still runs its vector leg in-process: it works, but that leg's timeout is a target, not
a bound. Defaults are unchanged: `CLAWMEM_HOOK_BUDGET_MS` 6000 and the profiles' token
budgets and vector timeouts; below the new 25000 maximum the budget's fallback and clamp
behave as before. Wall time still drives what is genuinely wall-clock — document ages,
cooldowns, leases, identifiers and timestamps — now read through the clock module instead of
`Date.now()`. Schema migrations are additive; no reindex, re-embed or graph rebuild.

Upgrade notes (schema auto-migrations, the one-time rerank-cache cold start, the
recommended `setup hooks` re-run, restarting the watcher together with the hook): [docs/guides/upgrading.md](docs/guides/upgrading.md#v0380-channel-aware-hook-ranking-relevance-admission-off-process-bookkeeping).

---

## v0.37.0 — a reachable-but-wrong inference endpoint now degrades instead of silently dying

Issue #24: when `CLAWMEM_LLM_URL` pointed at a port where an *unrelated* service answered
HTTP (a file browser squatting `:8089`), every `generate()` call failed **silently and
permanently**. HTTP errors deliberately never tripped the transport down-cache ("the
server IS reachable"), so the local in-process fallback never engaged — A-MEM enrichment
produced nothing for months while indexing kept reporting success. A *dead* port degraded
gracefully; a *squatted* one failed forever.

### HTTP-shape down-cache

The single-error rule is unchanged — one 400/500 from a real server having a bad moment
never costs it the GPU lane, and 429 (a healthy-but-limited endpoint) is never counted.
What changed is the pathological tail:

- **405 / 501 trip the 60s cooldown immediately** — a correctly-routed
  OpenAI-compatible route cannot return these; they are the signature of another service
  listening on the port. **404 is deliberately streak-based, not instant**: cloud and
  gateway endpoints return 404 for an unknown model or deployment while the route itself
  is fine, so a mis-set `CLAWMEM_LLM_MODEL` must not instantly cost the lane. A genuinely
  squatted port 404s every call and still trips within three.
- **Any other non-2xx trips after 3 consecutive failures.** A success resets the streak.
- The trip emits **one loud, actionable line** naming the URL, the observed status, and
  the env var to fix — then the existing cooldown + fallback + notify-once machinery
  takes over. The transition is idempotent under concurrency: in-flight requests that
  return errors after the lane is already down are swallowed, so the line really is one
  line. The cooldown self-heals: a recovered server gets its lane back on the first
  attempt after expiry.
- With local fallback **permitted** (the default), enrichment and query expansion degrade
  to the in-process model during the cooldown instead of dying. Under
  `CLAWMEM_NO_LOCAL_MODELS=true` there is still no fallback by policy — those
  deployments keep getting nulls, now with the trip line and the run-summary counter
  below instead of silence.
- The same trip protects the **self-hosted embedding lane** (`CLAWMEM_EMBED_URL`, single
  and batch). **Cloud embedding (API key set) is deliberately exempt**: those lanes never
  fall back by design, and an auth/quota HTTP error must stay a per-call error rather
  than flip the vault onto a different local model mid-run.
- The **judge lane is untouched**: `generateJudgeChat` keeps returning typed `http`
  failures to its caller and never trips the shared cache (judge-scoped instances are
  separate objects anyway). The reranker needs no HTTP trip — it already has shape-level
  protection (discrimination probe + degenerate-score fallback to RRF).
- Known limit, stated: a squatter answering **200 with a non-JSON body** is not counted —
  the parse failure still surfaces as a logged per-call error. Non-2xx is the observed
  squatted-port signature and the conservative trigger.

### Index-run summaries count note productivity

`clawmem update`, `reindex`, `mine`, the watcher, the MCP `reindex` and `vault_sync`
tools, and the REST `/reindex` response now report `✎stored/attempted notes` whenever
A-MEM enrichment ran, and call out a gap explicitly (`N produced nothing (LLM endpoint
problem? run 'clawmem doctor')`). This is the reporter's third suggestion: a run whose
every enrichment produced nothing must not end in an unqualified success summary, and
per-doc `[amem]` lines are too easy to read past. The metric is deliberately the NOTE
WRITE — the one phase every enrichment attempt runs — not whole-pipeline success: a
stored note whose later link phase failed still counts as stored (the failure keeps its
own log line), and an empty note whose entity phase happened to succeed still counts as
producing nothing.

### `clawmem doctor` probes the LLM endpoint's shape

Reachability is not the same as serving chat completions. Doctor now POSTs a minimal
completion to `CLAWMEM_LLM_URL` and validates the response deeply (a non-empty `choices`
array whose first message content is a string — `{"choices":[]}` proves nothing),
honoring the same `CLAWMEM_LLM_MODEL` / `CLAWMEM_LLM_NO_THINK` normalization the runtime
uses. This closes the same "liveness ≠ correctness" gap the reranker discrimination probe
and the embedding geometry canary already close for the other two inference services. A
squatted port shows as `✗ LLM endpoint: … reachable but NOT serving chat completions`; an
unset URL is a yellow note (the in-process fallback is a supported configuration).

No schema change, no migration, no new configuration. Behavior change: deployments whose
LLM endpoint persistently answers HTTP errors will now see the local fallback engage in
60s windows (with one explanatory line per trip) where they previously saw permanent
silent nulls — where local fallback is permitted; under `CLAWMEM_NO_LOCAL_MODELS=true`
the outcome stays null by policy and the trip line plus the note counters are the
improvement. `IndexStats` gains `enrichAttempted`/`enrichStored` (additive), and the
REST `/reindex` response carries the same two fields.

### Verification

Cross-model adversarial pass (codex / GPT-5.x), one pinned session: four turns to zero
remaining findings (5→4→1→0). Review-driven hardening along the way: 404 demoted from
instant-trip to streak-based (cloud gateways legitimately 404 on an unknown model), the
trip transition made idempotent under concurrent in-flight requests, the doctor probe
extracted into a directly-testable function honoring the runtime's no-think/model
normalization, and the counters re-keyed to the note write with the remaining public
surfaces (REST `/reindex`, MCP `vault_sync`) brought into line. Production-boundary
tests drive real fixture HTTP servers through the probe taxonomy, the real
`clawmem doctor` CLI as a subprocess, and the real REST and MCP handlers for the
counters. Full suite at clearance: 2231 tests, 0 failures.

### What didn't change

A *single* HTTP error still never costs the lane — the streak resets on success, 429
never counts, and AbortError/transport classification are untouched. Cloud embedding
keeps its no-fallback contract. The judge lane keeps returning typed `http` failures and
never touches the shared down-cache. The reranker keeps its existing shape-level
protection (discrimination probe + degenerate-score RRF fallback). The stdio MCP
transport is untouched. No new environment variables; the trip thresholds are design
constants.

## v0.36.0 — the ranking pipeline and vault lifecycle become inspectable

Two read-only diagnostic MCP tools. Composite ranking and lifecycle state were
previously observable only from the outside: you saw the final ordering and the final
counts, and answering "why did this doc outrank that one" or "how do this collection's
rows distribute across origin, activity, and age" meant re-deriving scorer behaviour by
hand.

### memory_stats — lifecycle + ranking-metadata aggregates

Deterministic SQL aggregates per collection: counts by active state, origin×active
cross-tabs (`fs` / `api` / legacy-`NULL` rows from the v0.34.0 ownership model), pinned
counts, accrual (7d/30d) and created-at span, deactivation reasons, and
mean/median/min/max distributions over `access_count`, `confidence`, `quality_score`,
and effective-time age (`authored_at ?? modified_at` — the same axis recency ranking
decays on since v0.27.0). Counts and cross-tabs cover all rows; distributions cover
ACTIVE rows only, since ranking never sees inactive rows. Complements `index_stats`
(embedding coverage / content types); nothing is filtered — system collections
included. Fail-loud by contract: a stats tool that silently dropped a section would
report a smaller vault as if it were the whole truth.

### memory_rank — composite ranking explanation

Runs the real FTS + composite pipeline for a query and returns each result's
per-factor breakdown — weights applied (`default` | `query` profile, with the
recency-intent override behaving exactly as in production), recency and
blended-confidence inputs, quality/length/frequency/canonical multipliers, signed pin
delta, co-activation — plus raw-vs-composite rank shifts.

The details that matter:

- **The breakdown is captured inside the scorer, never recomputed.** The recorded
  factors reproduce `compositeScore` exactly, and `explain` changes no score and no
  ordering — the diagnostic cannot drift from the thing it explains.
- **Raw ordering is production's** — `search`'s non-recency regime including its
  pin → legacy-composite → path tie contract — not a re-sort of the composite-ordered
  array, which would let exact raw ties inherit composite order and make the
  diagnostic circular.
- **Output is the union of the composite top-N and the raw top-N.** A raw winner the
  composite ordering demoted below the cutoff stays visible (`demotedRawWinner`,
  `⚠ demoted raw winner` marker) with its true composite rank — the exact signature a
  ranking investigation looks for, and the one a composite-only view would hide.
- **The pin cap is reported truthfully.** On composite surfaces the pin boost is
  `min(1.0, score + 0.3)` — and quality (×1.3), frequency (×1.10), and canonical
  (×1.14) multipliers can push a pre-pin composite above 1.0, so the cap can CLAMP a
  pinned doc below its unpinned twin. `memory_rank` renders that as a negative `pinΔ`
  rather than hiding it. Known defect, queued behind a judged golden set; scoring
  behaviour is deliberately unchanged in this release.
- Ranks are keyed by filepath — docids are content-hash prefixes, so identical-content
  documents at different paths share a docid and would otherwise overwrite each
  other's rank.
- Both tools return structured errors carrying the available list on unknown
  `collection` or `vault` names. `memory_rank` joins the default-`_clawmem`-filtered
  tools (`includeInternal: true` reaches system memory); `memory_stats` filters
  nothing.
- `memory_rank` candidates are FTS-only — no vector or LLM stage; deterministic and
  cheap enough to run casually.
- No schema change, no migration, no reindex, no re-embed.

## v0.35.0 — secondary-vault surfacing is now opt-in

Multi-vault deployments: the `context-surfacing` hook used to merge results from a
configured secondary vault into every prompt's injected context, unconditionally. Anything
indexed into that vault could surface in any session — vault separation held for explicit
queries but not for the automatic feed, and there was no switch.

Automatic cross-vault surfacing is now a config gate, **default OFF**: out of the box the
hook reads only the general vault, and a configured secondary vault stays isolated unless
deliberately queried (a `vault`-parameter MCP call) or deliberately opted back in:

```yaml
# ~/.config/clawmem/config.yaml            # or env, which wins:
retrieval:                                 # CLAWMEM_SURFACE_SECONDARY_VAULTS=true
  surface_secondary_vaults: true
```

The details that matter:

- The automatic secondary lane is the configured named `skill` vault (the same one the
  recall mirror attributes usage to); the knob does not fan out across every named vault.
- The gate governs the automatic hook feed only. Explicit `vault` MCP calls, `list_vaults`,
  `vault_sync`, and Stop-hook usage attribution are unchanged.
- Opted in, behaviour is exactly the old one — including best-effort fail-open when the
  secondary vault is unavailable.
- One gate, one producer: every downstream secondary-vault path in the hook keys off the
  tag the gated block sets, so OFF starves them all — including the recall mirror, which
  then writes nothing into the secondary vault.
- Config is process-cached: restart long-lived processes (watcher, MCP server) after
  changing it; hooks are per-event processes and pick it up on their next run.
- If secondary-vault content *also* reaches the general vault as an ordinary indexed
  collection, that is a separate route this gate does not touch — remove the collection
  from the general config if full isolation is the goal.
- No schema migration, no reindex, no re-embed. Only the literal `true` (env) / boolean
  `true` (yaml) enables.

## v0.34.0 — origin-aware reconciliation: DB-born memories survive filesystem indexing

The filesystem absence reconciler treated every active row in a collection as
filesystem-owned: any stored path missing from disk was deactivated `absent` on every pass.
Rows created directly in the database — hook observations, `saveMemory` output, beads sync,
REST writes — have no backing file BY DESIGN, so sharing a collection with indexed files
destroyed them wholesale (measured in one production vault: 2,430 of 2,437 DB-born rows
inactive). Every document row now records its lifecycle owner, and reconciliation only ever
touches rows the indexer actually owns.

### The ownership model

A new `documents.origin` column: `fs` (created/maintained by the filesystem indexer;
reconciled against disk), `api` (DB-born; absence on disk means nothing), `NULL` (ambiguous
legacy row — exempt). Ownership is DECLARED by writers or ADOPTED on first touch, never
inferred: the indexer stamps `fs` on every path it takes — insert, update, reactivation, and
the unchanged short-circuit — while `saveMemory` and `insertDocument` default-stamp `api`.
There is deliberately no migration backfill: `content_hash` proves nothing about ownership
(mined imports write it through the same pipeline), so legacy rows heal only when a writer
touches them. On a pre-migration schema the reconciler enumerates nothing at all —
fail-closed, reported by an open-time warning — and any other enumeration error propagates
instead of widening the enumeration.

### Ownership boundaries, both directions

A path collision across origins is rejected visibly, never resolved by silent takeover.
`saveMemory` preflights the requested path before ANY write: an active filesystem-owned path
throws, and an inactive row at the path throws too — lifecycle decisions are not overwritten,
per the v0.31.0 rules. Its write phase is transactional, so a mid-flight indexer claim rolls
the whole write back rather than leaking orphaned content, and dedup only counts against
API-claimable candidates through an ownership-conditional atomic update, so a concurrent
claim is never overwritten. Symmetrically, the indexer skips (and warns about) a file
appearing at an API-owned path — active or inactive — instead of adopting it.

### `clawmem mine` is additive now

Mine imports run in a new `importMode`: rows are stamped `api` on every write path, and
absence reconciliation is skipped entirely — the staging snapshot is transient, so a later
mine into the same collection no longer deactivates earlier batches.

### Upgrading

The `origin` column is added automatically on first open; no action is required. Two
behaviour changes to know about: a row whose file was already deleted BEFORE upgrading is no
longer auto-deactivated (nothing proves the indexer owned it — retire it with `memory_forget`
or a lifecycle sweep if unwanted), and a `saveMemory` write to a path occupied by a
filesystem-owned or inactive document now fails loudly instead of silently overwriting.

## v0.33.0 — the causal writer returns, evidence-first

v0.32.0 rebuilt causal *reading* and noted that restoring causal *inference* was a separate,
future piece of work. This is that piece. A new causal witness writer runs inside the
`decision-extractor` Stop hook — off by default, shadow-first — and the causal graph it builds
is evidence-preserving end to end: documents are the nodes, and every edge carries the specific
fact pair that justified it.

### The causal witness writer

When enabled (`CLAWMEM_CAUSAL_WRITER=shadow|on`), each Stop-hook invocation considers this
session's new observation documents against a small temporal window of recent ones
(`CLAWMEM_CAUSAL_WINDOW`, default 5, effective-time ordered) and makes ONE strict single-shot
model call proposing causal pairs. Admission is unforgiving: every proposed pair must cite fact
ordinals that exist in the *persisted* documents (caller arrays are never trusted), must include
at least one endpoint from this invocation (history is never re-inferred), and self-pairs,
duplicates, out-of-range ordinals, and sub-threshold confidences are each rejected with their own
audit event. What survives is written append-only as **fact-pair witness sightings** — repeat
observations of the same causal claim accumulate instead of being dropped — and the edge weight
is derived (`MAX` of witness confidences) in the same transaction. Placeholder reasoning is
rejected, so every edge a reader sees can show *why* it exists.

Every invocation in shadow/on mode writes a durable run record (`causal_runs` /
`causal_run_events`) — including early exits, skipped phases, and invalid configuration — with
retention mirroring the judge audit (90 days / 10k runs; sightings survive pruning). Inspect it
with the new `clawmem causal-audit` CLI. Shadow mode runs the full pipeline and audits everything
while writing zero graph state: run it for a while and read the audit before arming `on`.

### Pre-cut edges: preflight, resolve, restore

Causal edges written by the pre-v0.30 writer carry old-format metadata. The reader synthesizes
witness evidence from the valid ones in memory for display (nothing is written on read); the
armed writer materializes that evidence durably the first time it touches such an edge; edges
whose metadata cannot yield a valid witness make the writer fail closed rather than guess. `clawmem migrate causal-witnesses --preflight` reports a
census and emits a binding manifest; `--resolve-unmaterializable keep-weight|retire-edge` acts
only on explicitly selected edges whose full row image still matches the manifest fingerprint;
retirement is archive-style and reversible (`--restore-edge`, fail-closed: a restore never
overwrites an occupied key). CLI audit rows are born terminal-pessimistic — a crash mid-operation
can leave an honest `cli_error`, never a stranded `in_progress` or a fabricated success.

### The Stop hook now runs to a deadline

`CLAWMEM_STOP_BUDGET_MS` (default 25000) is a whole-handler deadline captured at entry. Every
model-bearing phase — observation extraction, contradiction candidate retrieval *including its
embedding call*, the contradiction judge, dedup embeddings, and the causal step — checks
remaining budget before starting and is skipped (audited, loudly logged) rather than started
unbounded. Previously a slow inference server could push the hook past the host's timeout, losing
the entire extraction; now the hook degrades phase by phase and always reaches persistence.

### Security: document-id lookups are structurally validated

Found by this release's boundary tests: docid resolution used its input in a SQL `LIKE` pattern
without escaping, so the wildcards `_` and `%` matched **arbitrary documents** through every
docid surface — including the destructive REST `/documents/{docid}/forget`, where a single `_`
deactivated whichever document the pattern happened to match first. Docids are now validated
against `^[0-9a-fA-F]{6,64}$` (after `#` strip) before any query; wildcards, non-hex, and
undersized prefixes return not-found everywhere. Oversized docids no longer throw. If you expose
the REST API beyond localhost, upgrade for this alone.

### `find_causal_links` returns evidence, not just links

The tool (MCP + REST `/causal-links`) now returns directed **edge records**: invariant
source/target, traversal provenance (predecessor, depth, direction), and up to 3 fact-pair
witnesses per edge with reasoning, confidence, and sighting counts — projected in SQL, capped by
a byte ceiling (64 KiB) that drops whole edges from the tail rather than truncating mid-record.
Traversal is level-synchronous and returns the globally strongest 50 edges under a total order,
not the first 50 found. Depth > 1 remains per-edge evidence, not a verified chain.

### Migration

Automatic on first open, additive only: four new tables (`causal_runs`, `causal_run_events`,
`causal_witness_sightings`, `retired_causal_edges`) with their indexes. No data backfill, no
manual step. The writer defaults to `off`, so nothing changes in write behavior until you arm it
— and before setting `on`, run the preflight (above).

### Verification

Cross-model adversarial pass (codex / GPT-5.x), both gates in one pinned session: the design was
reviewed to zero remaining findings across seven turns (13→9→9→8→3→2→0), then the implementation
against that contract across seven more (13→5→4→6→3→1→0). Production-boundary tests drive the
real CLI subprocesses (conflict, whole-run lock, rejected finalization), the real MCP handlers,
and the real REST server (docid injection attempts, byte-ceiling overflow, destructive-route
validation). Full suite at clearance: 1977 tests, 0 failures.

### What didn't change

The v0.32.0 reader pipeline (shared causal retrieval, observation lane, one-hop traversal) is
untouched. `includeInternal` semantics are unchanged. With `CLAWMEM_CAUSAL_WRITER=off` (the
default) the Stop hook makes no causal model call and writes no causal rows — the only new
default-on behaviors are the budget deadline and the docid validation.

---

## v0.32.0 — causal answers reach their reasoning

Three defects found while reviewing the causal layer's foundations: the recommended causal
retrieval route could not reach the documents causal edges actually connect; the four causal
surfaces had drifted into four different pipelines; and the SPO knowledge graph wrote evidence it
never showed while silently dropping repeat sightings.

### One causal pipeline behind every causal surface

`memory_retrieve`'s causal mode, `intent_search`, `query_plan`'s graph clauses, and REST
`/retrieve`'s causal mode were four independent implementations of "intent-classified retrieval
plus graph expansion", each missing different stages — the documented claim that causal queries
route to `intent_search`'s pipeline was true of none of them. They now share one implementation
and differ only in declared stages and visibility policy, so parity holds by construction. REST's
causal route gains graph traversal (it was anchor-only RRF), and the REST classifier now
recognizes the same causal phrasings as MCP — "why were" and "because we" never routed causal
over REST before. `intent_search` keeps its documented unfiltered contract verbatim, and its
`enable_graph_traversal: false` now disables every graph stage, including the new one-hop step.

### WHY queries reach observation documents — and can walk a causal edge backward

The default-filtered routes excluded the `_clawmem` collection categorically, and every causal
edge endpoint lives there — so causal graph structure was reachable by nobody through the
recommended default route. Independently, neither traversal engine could follow a causal edge
backward (inbound edges were restricted to semantic/entity), so "why did B happen?" anchored at B
could never reach cause A.

WHY-classified queries on the filtered routes now anchor into `_clawmem` **observation documents
specifically** — never handoffs or deductions — and follow causal edges one bounded hop in both
directions (at most 3 per anchor, 10 total), with each hit labeled `cause` or `effect` relative
to its anchor. Candidate eligibility (active, non-invalidated, inside any effective-time window,
collection policy) is now enforced inside every anchor, traversal, and MPFP query — previously an
inactive or invalidated document could still consume beam slots and steer expansion even though it
was hidden from output. Entity co-occurrence expansion cannot honor row-level eligibility (its
aggregates carry no source-document provenance) and is therefore confined to direct
`intent_search`, its only shipped home, with the limitation documented.

### The knowledge graph shows its evidence

`entity_triples` recorded `source_doc_id` and `source_fact` on first sighting, but no query
surfaced either — and a repeat sighting of a known fact was dropped entirely, so corroboration
accumulated nowhere. A new `entity_triple_provenance` table now accumulates unique evidence
sources per fact, written in the same transaction as the fact itself. `kg_query` reports
`evidenceCount` plus up to 5 most-recent sources per fact (evidence with no source document
renders as `unattributed`). Provenance in `queryEntityTriples` is opt-in, so the prompt-hook path
pays nothing new.

**Migration** (automatic, on first open): one evidence row is backfilled per existing triple that
carries inline evidence. The backfill is idempotent and read-guarded — steady-state opens perform
no writes.

### Verification

Cross-model adversarial pass (codex / GPT-5.x): the remediation design was reviewed to zero
remaining findings across five turns before implementation, and the implementation reviewed to
zero remaining findings against it. Production-boundary tests drive the real MCP handlers and the
real REST server: backward one-hop retrieval, decision-typed observation endpoints, lane
exclusions for handoffs/deductions, breadth caps, the graph master switch, REST classifier parity,
evidence dedup/ordering/atomicity, and migration idempotence across reopen.

### What didn't change

The causal *writer* — batching, edge schema, per-edge witnesses — is untouched; restoring causal
inference itself is a separate, future piece of work. Direct `intent_search` remains unfiltered by
design; REST remains unfiltered in every mode; `includeInternal` semantics are unchanged;
`confidence` does not move on repeat sightings; hooks issue no new queries.

### Upgrading

No manual migration step — the provenance backfill runs on first open, idempotent and
read-guarded. The v0.31.0 mixed-version caution applies unchanged: when long-lived writers run
concurrently, restart daemons and reconnect open agent sessions together, so no old-code process
keeps writing after the vault has migrated. A stale writer inserts facts without evidence rows —
repaired by a later open's backfill — and keeps dropping repeat sightings outright, which is not
recoverable: the evidence row is simply never written.

---

## v0.31.0 — forget stays forgotten

Three defects on the indexing boundary, all of which destroyed or reversed memory silently. Each
was found by observing the database rather than by reading call sites, and each is fixed by making
the affected write refuse rather than by adding a confirmation step.

### `memory_forget` was undone by the next reindex

Forgetting a document that has a file behind it did not stick. The indexer reactivated **any**
inactive row it found at a path present on disk, without asking why that row was inactive — and
`active` is written by three unrelated owners: absence reconciliation, `memory_forget`, and
lifecycle archival. On a machine running `clawmem watch`, a forget therefore survived only until
the next `.md` change anywhere in that collection. Archived documents came back too, still carrying
`archived_at`, leaving them simultaneously active and archived.

Documents now record **why** they were deactivated (`deactivated_reason`), and only what was
deactivated for absence can be revived automatically. A forgotten or archived document stays that
way, and its file is skipped rather than re-inserted — re-inserting would have left the row
forgotten while making its content live again under a new id. The generic reactivation helper
enforces the same rule, so automatic profile regeneration during `clawmem update` no longer revives
a forgotten profile either. Restoring an archived document remains `lifecycle_restore`'s job.

**Migration** (automatic, on first open): existing archived rows are backfilled as `'archive'`, and
any row a previous version left in the inconsistent active-and-archived state is restored to
archived, with a count reported on stderr. Use `lifecycle_restore` to bring any of those back.
Legacy rows deactivated by forget before this release are indistinguishable from absence and remain
reactivatable once; from this release forward, forget is durable.

### `clawmem reindex --force` orphaned every database-created memory

`--force` began with a blanket `UPDATE documents SET active = 0` across the entire vault, then
rebuilt only the *configured* collections. Observations, handoffs, and deductions live in
`_clawmem` and have no file behind them, so nothing ever brought them back. The deactivation set no
`archived_at`, which meant `lifecycle_restore` could not see them either — they were invisible to
the only supported restore path.

`--force` now does what its name implies: it re-reads and rewrites every file, bypassing the
content-hash short-circuit that normally skips unchanged documents. It no longer deactivates
anything up front; documents still absent from disk are deactivated by the ordinary reconciliation
pass, one collection at a time, exactly as they are without the flag. Separately, `_clawmem` is now refused by the indexer outright — database-created
memory has no filesystem source and cannot be reconciled against one, by any caller.

### A failed enrichment blanked learned A-MEM notes

`constructMemoryNote` fails open to an empty note when the inference endpoint is unavailable, and
the note was then stored unconditionally. A transient outage during a routine reindex therefore
blanked `amem_keywords`, `amem_tags`, and `amem_context` on every document it touched. Writing an
empty note over a *never-enriched* row was quieter but no better: it made a failure
indistinguishable from completed enrichment, so backfill never retried that document.

An empty note is now never written, whatever the row holds — including a note whose entries are
only whitespace, which carries no information but would still have masked the row from backfill.
The store reports whether the note actually landed, and both callers honour that: the enrichment
log distinguishes a refused write from a completed one, and the consolidation backfill skips the
link pass and leaves the document eligible for a later retry. `NULL` is preserved as the retryable
"not enriched yet" state.

### Upgrading

No manual migration step. The migration runs on open, is idempotent, and performs its count and
repair in one transaction so concurrent opens cannot double-report. If it cannot run — a locked
database, for instance — it says so on stderr and is retried on the next open rather than failing
silently. If it reports repaired documents, those were archived rows a previous version had
incorrectly reactivated.

One operational requirement when long-lived writers run concurrently — the watcher,
`clawmem serve`, or an MCP server in an agent session that stays open across the upgrade:
restart them together (daemons restarted; open sessions reconnected via `/mcp` or closed), so no
old-code process keeps writing after the first new-code open has migrated the vault. An old-code
writer records no deactivation reason, and the new indexer deliberately treats reason-less
deactivation as legacy absence — a forget issued through a stale session can be reactivated by
the next re-index, which is this release's bug reintroduced by the stale process. A
single-session setup with no daemons needs nothing.

---

## v0.30.0 — ClawMem stops deleting rows

ClawMem's governing rule for agent-mediated memory mutation is that nothing an agent does should be unrecoverable. Every mutation surface honored that except one: `purgeArchivedDocuments` physically `DELETE`d rows. This release removes physical deletion from the package entirely rather than gating it, because a gate cannot work here — see below.

### Why removal rather than an administrator gate

The obvious fix is to keep purge and require administrator authority for it. That fix does not hold, and the reasoning is worth stating because it generalizes: **ClawMem's primary consumer is a coding agent with shell access.** Any credential expressible in-process or on the command line — an env var, a confirmation flag, an interactive prompt — is equally available to that agent, which can type an opt-in env var and a `--purge` flag as readily as a human can. A gate like that only relabels the operation; it does not remove it from agent authority. (No such flag or variable exists in this release — that design was built, reviewed, and rejected for this reason.) A longer confirmation boundary also satisfies neither "immutable prior revision" nor "supported restore": once the row is gone there is nothing left to restore.

So the capability is not offered. Reclaiming disk space is an out-of-band operator action on the SQLite file, explicitly outside ClawMem's mutation contract. A supported retention design — reversible quarantine with a protected window — is planned separately.

### What was removed (`src/store.ts`)

- **`purgeArchivedDocuments`** — ran `DELETE FROM documents WHERE active = 0 AND archived_at <= ?`. Reachable from three call sites, below.
- **`deleteInactiveDocuments`** — ran `DELETE FROM documents WHERE active = 0`: strictly broader, destroying every inactive row (archived *and* forgotten) with no age bound and no authorization. It had no callers but sat on the public `Store` interface.
- **the store-level `removeCollection`** — ran `DELETE FROM documents WHERE collection = ?`, an unauthorized hard delete of an entire collection. Also callerless; `clawmem collection remove` goes through `collections.ts` (YAML config only), which remains the reversible path.

No code path now issues a `DELETE` against `documents`.

### The three purge call sites, and the one that mattered most

- **`lifecycle_sweep` (MCP)** — a non-dry-run sweep archived, then deleted every archived row past `purge_after_days`. That set was **never previewed**: the dry-run branch reported `Would archive N document(s)` and said nothing about deletion, and the deleted population was different from the previewed candidates entirely. The preview was not weakly binding — it was silent.
- **`staleness-check` (SessionStart hook)** — the worst host of the three: unattended, no model and no operator in the loop, the purge count discarded, all of it inside a `catch {}` documented as "lifecycle errors never block the hook", so a failed delete was silent too. Auto-**archival** here is unchanged and remains reversible.
- **`clawmem lifecycle sweep` (CLI)** — archives only, and says so when it sees `purge_after_days` set.

### Count reporting was wrong (`src/store.ts`)

`archiveDocuments` and `restoreArchivedDocuments` returned SQLite's `changes`, which counts the `documents_fts` trigger writes as well — archiving 3 documents reported **16**. Every "archived N" / "restored N" ClawMem has printed was inflated. Both now count the affected documents explicitly inside the same transaction. The mutations were always correct; only the reported numbers were wrong. Found by writing the first behavioral test of this path.

### Behavior changes to expect

- `purge_after_days` is **inert**. It is still parsed so existing configs load, but only a positive finite value is accepted — a negative value previously produced a *future* cutoff that deleted every archived row, including ones archived moments earlier.
- `lifecycle_sweep` reports `archived N document(s). Nothing was deleted.` The tool description no longer advertises purge.
- Archive/restore counts are now accurate, and smaller than before.

Test coverage: `tests/unit/no-hard-delete.test.ts` — the invariant that no path destroys a row, the real SessionStart hook exercised end to end, and the count regression. There was previously **no test of the purge path at all**, which is part of why this survived.

---

## v0.29.0 — the contradiction judge: opt-in model override, judge-gated analysis, durable audit

v0.28.0 repaired the contradiction write path; this release faces the model behind it. A live contract probe at the production seam showed the prescribed stock expansion model cannot meet the judge contract at all — it returns an object where the contract requires an array, echoes the schema's enum text back as a value, and fabricates confident relations between unrelated facts, deterministically. The same weak model sat in a *fail-open* position at the merge-time gate, where a parseable answer bypassed the deterministic heuristic and a missing confidence defaulted to exactly the actionable threshold. This release routes every contradiction decision through an explicitly configured **judge**, disables the analysis when none is configured, fixes the fail-open surfaces, and makes every evaluation durably auditable.

### Judge-gated analysis — a behavior change (`src/judge.ts`, `src/hooks/decision-extractor.ts`)

- **No judge configured ⇒ contradiction analysis is DISABLED**, as an audited no-op with one loud line per run — never a silent attempt on the stock model. This honors opt-in strictly: the reshaped prompt (below) could have made the stock model start clearing admission, activating erosion for users who never chose it.
- **Migration note:** the evidence that "no verdict ever applied" holds for stock deployments. If you had pointed the *global* `CLAWMEM_LLM_URL`/`CLAWMEM_LLM_MODEL` at a larger or cloud model, real verdicts may have been applying — the judge no longer rides the global vars, so set `CLAWMEM_JUDGE_*` to keep that behavior. ClawMem deliberately never auto-adopts the global endpoint as a judge: the judge vars are also the data-egress consent (new decisions + retrieved snippets go to the judge you configure). `clawmem doctor` warns when it can detect this situation; [docs/guides/upgrading.md](docs/guides/upgrading.md) is the authoritative notice.
- **Three lanes**, one strict contract: any OpenAI-compatible endpoint (`CLAWMEM_JUDGE_URL` + `_MODEL` + `_API_KEY`), the Anthropic Messages API (`CLAWMEM_JUDGE_PROVIDER=anthropic`, default model `claude-haiku-4-5` — the recommended default), or a sandboxed headless `claude -p` on a Claude Code subscription (`claude-cli`: `--safe-mode`, no tools, no MCP, no session persistence, untrusted payload over stdin only, recursion-guarded). The judge never runs local inference and never auto-downloads a model. The Haiku recommendation is backed by a shipped, passing capability-evaluation artifact; `claude-sonnet-5` is an **unverified** upgrade candidate — its preserved CLI-lane artifact shows zero fabrication with contradiction recall 3/4 and long-input 0/2 (borderline label + spawn-budget timeouts), and no API-lane artifact exists yet.

### The merge-time gate had two fail-opens (`src/merge-guards.ts`, `src/consolidation.ts`)

- **The LLM layer bypassed the heuristic whenever its answer parsed**, and a missing `confidence` defaulted to `0.5` — the exact actionable threshold. With a fabricating model that could block valid merges or, under `supersede`, deactivate rows. The legacy object contract, permissive extraction, and confidence-defaulting are all removed: the gate now speaks the same strict relation-array contract as the hook judge, and a missing confidence is an invalid entry, never a default.
- **The deterministic heuristic scores a disjoint-number pair at exactly the default threshold** ("supports protocol version 1" vs "version 2" is actionable). Heuristic-only operation is therefore constrained to the non-deactivating `link` policy: **`supersede` requires a configured judge.** A configured-but-blocked `supersede` is loud — a runtime warning, a `merge_supersede_blocked` audit event per occurrence, and a `clawmem doctor` report that the policy is presently inactive. The effective policy is resolved once upstream and passed into the mutation helper as a parameter; mutation code no longer reads the policy env at all.
- Phase-2 `link` sets the old consolidated row's `invalidated_by` **backlink** — it never inserted a `contradicts` edge; three docs that claimed otherwise are corrected (Phase 3 deductive synthesis is the edge writer).

### Strict judge extraction (`src/judge.ts`)

- The shared LLM-JSON extractor repairs a truncated array by keeping the complete elements — fine for enrichment, **fail-open for a mutation consumer**: token truncation silently applied a partial verdict batch. The judge path uses its own extractor: fence- and prose-tolerant, but a truncated JSON value is a typed reject, never a repair. Provider-reported truncation (`stop_reason`/`finish_reason`) is rejected before extraction even runs.

### Prompt reshape + injection fencing (`src/judge.ts`)

- The old prompt's example row was **invalid JSON** (`"confidence": 0.0-1.0`, `"relation": "update|contradiction|same"`) — placeholder-echo bait for weak models, noise for strong ones. The reshaped prompt states the schema in prose, shows a *valid* example, and instructs that unrelated pairs — the common case — return exactly `[]`.
- Instructions and data are role-separated. Vault-derived content travels JSON-encoded inside per-request CSPRNG-nonce markers and is declared data-under-analysis, never instructions. Fencing is a mitigation with tests (collision, marker imitation, nested instructions), not a proof — the strict admission pipeline, thresholds, bounded erosion, and the audit below remain the backstops.
- Consumer-specific thresholds: the decision-erosion prompt states `0.7` (its mutation threshold); merge prompts state your resolved `CLAWMEM_CONTRADICTION_MIN_CONFIDENCE` — the prompt never overrides an operator setting.

### Durable audit: `judge_runs` / `judge_events` (`src/judge-audit.ts`, `src/store.ts`)

- Interactive hosts do not persist successful hook stderr, which made the previous release's shadow output unreachable exactly where calibration needed it. Every judge evaluation now writes durable rows: a run (consumer, lane, model, endpoint, prompt version, response hash, outcome, admission counts) plus per-verdict / per-reject / per-error events with scores, namespaced targets, and reason codes mirroring the real validator verdicts.
- **Mutation-authorizing evaluations commit audit and mutation in one transaction** — an audit failure rolls the mutation back (Phase-3 deductive checks commit a precondition audit first; non-mutating outcomes write standalone best-effort rows). That is a deliberate fail-closed trade: an unauditable erosion is this feature's original defect, and audit coupling intentionally expands the set of errors that fail the feature closed — same-store transactions keep that trade cheap, not free. A judge failure that falls back to the deterministic heuristic records BOTH runs, linked, so neither the failed lane's identity nor the actually-deciding classifier is ever lost. Caller cancellation (`aborted`) is terminal: audited, no heuristic, no mutation.
- **Calibration is now audit-based on every host** — including hosts that discard hook stderr. The previous guidance that shadow calibration was impossible under OpenClaw is reversed; query the audit rows instead.

### `clawmem doctor` (`src/clawmem.ts`, `bin/clawmem`)

- New judge check: a three-scenario **smoke test** against the configured judge — a designed contradiction must yield exactly one `(0,0,"contradiction")` verdict at ≥ 0.7, an unrelated control must come back exactly empty (any verdict there is fabrication), and the merge single-pair contract must be actionable. An installation check, never capability certification. Unconfigured ⇒ the capability-floor note, the migration warning (provenance-aware — the wrapper marks its own stock default URL so stock installs never false-positive), and the inactive-`supersede` report. Plus audit row counts.

Full suite 1,821/0 (92 new tests, including the truncation-repair regression, the audit-rollback fail-closed pin, the argv-content invariant for the subscription lane, pair-linkage retention, and a production-boundary integration suite driving the real Phase-2 gate with live judge lanes). The design went through a nine-turn cross-model adversarial DESIGN review (codex / GPT-5.x) to verbatim "Zero remaining findings." before implementation — thirty-three findings absorbed across the turns, including the merge-gate fail-open, the truncation-repair fail-open, and the accidental-activation hazard that forced the symmetric disable — and the implementation went through further adversarial CODE review rounds whose findings (among them: a failed-over heuristic could authorize `supersede`; a dirty response wrapping one valid verdict could decide) are all folded and regression-pinned.

---

## v0.28.0 — hook write-path contracts: extraction guards, honest counters

Two Stop-hook write paths — A-MEM causal inference and contradiction detection — reported success while persisting nothing. Instrumentation counted *attempts* against `INSERT OR IGNORE`, so a total write failure was indistinguishable from a healthy run. This release makes the reporting truthful, hardens the validation ahead of every mutation, and repairs the two contract defects that left contradiction detection unable to apply a classification at all. The terminal mutation that repair unblocks — invalidation — ships **shadowed behind an opt-in flag**, not armed.

### Counters report outcomes, not attempts (`src/amem.ts`, `src/store.ts`, `src/mcp.ts`, `src/server.ts`)

- **`inferCausalLinks` sums `.changes`** from each insert instead of incrementing per candidate, and warns when candidates clear every filter but no row lands (the signature of silent `INSERT OR IGNORE` suppression). The summary line now reports proposed / passed-filters / placeholder-rejected / range-rejected rather than a single fabricated success count.
- **Both graph builders** (`buildTemporalBackbone`, `buildSemanticGraph`) count inserted rows the same way — the two feed one response and previously reported in different units.
- **`build_graphs` reports standing totals** alongside the delta, on the MCP tool *and* the REST endpoint: `N new edge(s), M total`. An idempotent rebuild legitimately writes 0 new edges, which read as "the graph is empty" without the total. **Response-shape change** — see below.
- **Totals count the ACTIVE graph.** Only edges whose *both* endpoints are active are counted, matching the population the builders operate on; a raw count reported edges the live graph no longer contained. Shared via `store.countActiveRelations()` so the two surfaces cannot drift.

### Validation ahead of every mutation (`src/hooks/decision-extractor.ts`, `src/schema-placeholder.ts`)

- **`validateContradictionEntry`** is a pure, exported, typed-verdict validator applied to every classifier entry before any document is mutated: exact relation-enum membership, strict `typeof reasoning === "string"` (coercion was a fail-open on every JSON-valid non-string), finite `[0,1]` confidence, and *both* index bounds.
- **Array-level admission** (`admitContradictionEntries`, exported and pure). Only repeats identical across the fields that can drive a mutation (relation, confidence, reasoning) are collapsed; a pair the classifier answered more than one way — differing label, confidence, or reasoning — is dropped whole. Repeats compounded the confidence penalty on a single document and could cross the invalidation floor a single classification never reaches, and a first-wins collapse would have made the outcome depend on array order. Whether several *distinct* new facts may penalize one old document repeatedly is a separate open question, unchanged here.
- **The shared anti-parrot guard normalizes before matching.** Residue comparison folds NFKC, drops `Default_Ignorable_Code_Point` characters, lowercases, collapses whitespace runs, and strips outer punctuation — so a doubled space, a newline, fullwidth text, a trailing period, or an invisible zero-width character inside a word no longer walks past the guard. Internal punctuation is deliberately *not* normalized: doing so mapped plausible identifiers like `canonical_entity_name` onto blocklist entries. Marker detection folds NFKC, drops invisibles, removes every template marker, and asks whether any letter or digit remains — so arbitrary punctuation envelopes (`**{{x}}**`, `- {{x}}`, `|{{x}}|`, `【{{x}}】`, fullwidth `｛｛x｝｝`) and multi-line markers are all caught without enumerating wrapper characters. A value whose every letter and digit sits inside a marker is filtered as carrying no assertable content, whether it is echoed residue or a bare code fragment; content that merely *contains* a marker, like `"${HOME} is the user home directory"`, is untouched. **That applies to claim fields only.** Identifier fields — conversation-synthesis aliases and link targets, SPO subjects and objects — are names, not assertions, so no marker shape is rejected there on shape alone (`${HOME}` is a legitimate object of `uses`; `{{user.name}}` is a Handlebars path). Their residue is caught by consumer-scoped sets naming the exact skeleton that field's own prompt emits. Link targets were previously unguarded entirely despite their prompt carrying a copyable skeleton. Residue sets stay consumer-scoped — a memory *about* this defect is legitimate content, not residue.
- **The contradiction parse gate reports instead of returning silently**, emitting response shape, length, content hash and served model identity. Raw model text stays opt-in behind `CLAWMEM_DEBUG_LLM_RAW` — the prompt carries transcript-derived material, so logging it by default would be a content-exposure path.
- **`/no_think` is applied idempotently** — six prompts already carry the token inline for the local fallback and were being sent a doubled control token.

### Contradiction detection could never apply a classification (`src/hooks/decision-extractor.ts`)

Two independent defects sat between a valid classification and any effect on the vault. Both are model-independent, and both failed silently.

- **The document lookup was handed a URI where it expected a path.** `SearchResult.filepath` is a *virtual* path — `clawmem://<collection>/<path>`, assembled in the store's projection — while `findActiveDocument` matches the bare `documents.path` column. The hook passed the URI straight through, so no candidate could ever resolve to a row, and the miss exited through a bare `continue`. Every classification that survived the parse gate and every validation above it died there without mutating anything. The path is now resolved with `parseVirtualPath` before lookup, and a target that still fails to resolve increments a counter and warns rather than disappearing.
- **The parse gate rejected the deployed model's response shape.** The model wraps its array in an object (`{"result": [...]}`). `parseLinkGenerationFromLLM` in `amem.ts` has unwrapped that form since it was written; this path never did, so structurally valid responses were counted as malformed. Both forms are accepted now.

Taken together these are why contradiction detection had no observable effect on any vault regardless of what its logs reported. Precisely: the hook ran, called the model, and parsed a verdict — but no verdict could ever be *applied*, and no document was mutated, in any version shipping this implementation. Read it as newly-effective, not as newly-fixed.

### Invalidation ships shadowed — `CLAWMEM_CONTRADICTION_INVALIDATE`

Repairing the lookup made the soft-invalidation branch reachable for the first time, so it is gated rather than simply switched on. The two mutations behind a contradiction are not symmetrical:

- **Confidence erosion** (`-0.25`, floored at `0.2`) is a ranking signal — 25% of the default composite. A degraded document ranks lower and stays fully retrievable. **Live.**
- **Invalidation** sets `invalidated_at`, which is a hard predicate on the FTS join and both vector joins. An invalidated document leaves retrieval entirely, with no query-time signal that anything was suppressed. **Off unless `CLAWMEM_CONTRADICTION_INVALIDATE=true`.**

Unarmed, the hook logs `WOULD invalidate "<collection>/<path>"` per suppressed write plus per-session summaries, so precision can be adjudicated against real traffic before anything is removed.

**Shadow mode reports exactly what arming would remove — no more.** Candidates are selected by *pathname* (`decisions/`, `observations/`), but the armed writer only touches `content_type='observation'`: on the reference vault, roughly three times as many candidates as eligible rows. Eligibility is now asked once and gates the shadow log and the armed write identically, so calibration cannot be aimed at a population two thirds of which could never have been invalidated. Documents that reach the floor while ineligible are reported separately, and the armed write checks `.changes` rather than discarding its result — a swallowed outcome is how the original defect stayed invisible.

Exposure is vault-specific along five axes: the eligible population's confidence distribution (`(0.95, 1.0]` needs four classifications to reach the floor, `(0.70, 0.95]` three, `(0.45, 0.70]` two, `<= 0.45` one), content-type mix, the classifier model, corpus semantics, and classification opportunity (only the top 5 search results per session are ever classified, from a pool that changes when the vector leg falls back to FTS). The [contradiction invalidation guide](docs/guides/contradiction-invalidation.md) has the measurement queries, the adjudication procedure, and the restore statements.

**Eligibility is `content_type='observation'` only.** A superseded *decision* is eroded but never retired — decision records are outside the writer's reach by design. **Shadow output is not reachable under OpenClaw**, where the plugin surfaces hook stderr only on a non-zero exit and a successful shadow run exits zero; this flag should not be armed on that host, and calibrating under Claude Code is not an equivalent substitute because exposure is host-dependent. No shipped systemd unit runs this hook — `clawmem-watcher.service` is the indexer.

### Upgrade note — `build_graphs` response shape

Additive, but a contract change. Both surfaces gain `temporalTotal` / `semanticTotal`, and the MCP text line changes from `Temporal graph: N edges` to `Temporal graph: N new edge(s), M total`. Anything parsing that text should be updated. The REST endpoint continues to emit all four keys unconditionally (its pre-existing shape); the MCP tool continues to include only the graph types requested.

### Quality gates

Full suite 1,775/0. Cross-model adversarial passes (codex / GPT-5.6) throughout — seventeen turns, including successive fail-opens in the same validator, a duplicate-entry defect that compounded mutations on one document, and a round in which the newly-added regression tests were shown not to exercise the guard they were written for.

## v0.27.0 — authorship time: memories rank by when they were written

Fixes a confirmed recency-contamination defect: ClawMem had exactly one time axis per document (filing/update time), so a 2025 conversation mined today ranked — and filtered, and injected — as if written today. Worst under recency intent, where recency carries 70% of the composite weight. Documents now carry a second, nullable axis: `authored_at`, when the content was originally written.

### Authorship capture end-to-end (`src/normalize.ts`, `src/clawmem.ts`, `src/indexer.ts`, `src/store.ts`)

- **Mining extracts message timestamps** from all supported formats through strict per-format adapters — RFC3339-with-explicit-offset for Claude Code / codex / Claude.ai (timezone-less values are rejected, never host-interpreted; impossible dates are rejected, not normalized), epoch-seconds for ChatGPT / Slack with range guards. Each exchange chunk is stamped with the max timestamp *within that exchange only* — never a transcript-level fallback (privacy exports flatten multiple conversations into one stream, so a transcript max would cross conversation boundaries).
- **Synthesized facts inherit** their source conversation's authorship; the shared `saveMemory` API advances `authored_at` monotonically (a newer repeated assertion moves it forward; reprocessing older evidence never regresses it; NULL-safe).
- **Any vault file can declare `authored_at:` in frontmatter** — full timestamp or date-only `YYYY-MM-DD` (UTC midnight), quoted or unquoted. Frontmatter is authoritative: removing the line clears the stored date on the next content change.
- **Re-mining an existing vault dates documents without churn**: a body-identical re-index whose only change is `authored_at` takes a metadata-only "dated" transition — `modified_at` preserved, stored confidence untouched, no re-enrichment queued.
- **`clawmem mine <dir> -c <collection> --backfill-dates [--apply]`**: recoverable-only backfill for already-mined vaults. Dry-run report by default; the apply phase is transactional and re-asserts the validated content hash on every row, so a concurrent change can never receive a mismatched date; documents whose content no longer matches the source are skipped, never guessed.
- **Colliding transcript names no longer overwrite each other**: sources that sanitize to the same staging name (`a/b.jsonl` vs `a_b.jsonl`) previously clobbered each other silently; they now mine under distinct hash-suffixed identities, decided once per source and stable across re-runs (non-colliding sources keep their existing names — zero path churn).

### Effective time in ranking and retrieval (`src/memory.ts`, `src/mcp.ts`, callers)

- **Composite recency ages documents by `authored_at ?? modified_at`**, and the confidence signal's internal recency uses the same effective date (the access-pattern sentinel stays on filing time). Documents without authorship behave exactly as before.
- **Temporal filters and the temporal-proximity channel** ("what did we plan in March") select, order, and score by effective time on both the FTS and vector legs.
- **Recent-content windows** — postcompact recent decisions/antipatterns, session-bootstrap current focus, `clawmem reflect`, directory context, profile — apply their cutoffs and display their dates on effective time, so a freshly-mined historical decision no longer masquerades as this week's work. Operational clocks (the dedup window, lifecycle sweeps, staleness review, session log) intentionally keep filing/update time.
- **Result metadata**: compact search results now carry `authored_at` (null = unknown).

### Entity-edge IDF population fix (`src/entity.ts`)

Completes the v0.25.0 hub-bias fix: the enrichment/edge-creation path computed IDF with an active-only numerator over an all-documents denominator, letting archived history deflate specificity (below zero in the extreme) and suppress edges for entities that are specific among the live corpus — and could create edges toward archived documents. Both populations are now active-only and archived candidates are excluded, matching the neighbor path. Bug-first tests demonstrate the pre-fix failure.

### Quality gates

Full suite 1,681/0 (62 new tests, including direct caller-level pins for every recency window and a live CLI backfill lane). The authorship design was adversarially design-reviewed before any code (6 turns, 29 findings absorbed — including the two-axes consumer classification, the confidence-lane uniformity rule, and set-independent mine identity), then the implementation was reviewed to verbatim "Zero remaining findings — ship as is." in 3 turns (7 findings, among them a year-0000–0099 date-construction bug and a backfill validation race); the entity fix cleared in 1 turn. Cross-model adversarial passes (codex / GPT-5.6) throughout.

## v0.26.0 — offline eval harness (evidence-overlap replay) + short memory-query gate fix

Retrieval quality becomes measurable: a gold-labeled replay harness scores the real `query` pipeline against hand-labeled evidence, ending the era of ranking/extraction changes shipping un-measured. Plus a gate-ordering bug fix that was dropping short explicit memory questions.

### Offline eval harness (`src/eval/`, `clawmem eval run`)

An offline, CLI-only evaluation subsystem (pattern extracted from the HORMA paper's evidence-grounded reward, re-authored for ClawMem's deterministic on-device substrate):

- **Replays the real pipeline, never a mirror.** `clawmem eval run --gold <file.jsonl>` drives the actual registered `query` MCP tool handler over an in-memory transport — expansion, RRF fusion, rerank blending, composite scoring, and MMR diversity at their tool defaults — so the number measures the product, not a copy that drifts.
- **Doc-level evidence-overlap metrics**: Jaccard `|C∩E|/|C∪E|` between retrieved and gold document sets, plus precision@k, recall@k, hit@k, and MRR; per-tag slices; p95 latency. Artifacts: `run.json` (machine) + `report.md` (hand-audit companion).
- **Gold sets are strict, hand-labeled JSONL** (any path via `--gold`, so private labels can live outside the repo): unknown fields, malformed lines, and duplicate ids are hard errors; an example with any evidence ref that doesn't resolve to an active document is excluded from scoring — regardless of its replay mode — and fails the run's trust gate, so partial or stale gold can never inflate recall.
- **Trust gate, machine-visible**: enough scored examples (`--min-examples`, default 30), zero unresolved refs, and an explicit `--audited` attestation that a 10–20% hand-audit of the labels passed. A completed run with a failing gate exits `1` (artifacts still written) so automation can't mistake an untrusted number for a trusted one.
- **Identity integrity**: retrieved results map back to document ids by inverting the `collection/path` display path; zero or multiple matches (a collection name containing `/` colliding with a sibling) hard-fail the run instead of guessing or silently dropping — either would corrupt the metric.
- **State-safe**: the replay writes no retrieval, lifecycle, or telemetry state (`context_usage` / `recall_events` / `memory_relations` untouched, regression-pinned); normal inference caches may populate as in any live query. `--db <snapshot>` points the whole run at a `VACUUM INTO` copy for corpus-frozen A/B comparisons between checkouts.
- First build ships the `query` replay profile; `intent`/`context` replay, benchmark adapters, and provenance are follow-on phases. Guide: [docs/guides/eval-harness.md](docs/guides/eval-harness.md).

### Short memory-intent queries now reach retrieval (`src/hooks/context-surfacing.ts`, `src/retrieval-gate.ts`)

The retrieval gate's `FORCE_RETRIEVE_PATTERNS` (memory verbs, temporal refs, personal-data queries) carry the explicit contract "(checked before skip)" — but the context-surfacing hook returned on `prompt.length < 20` before the gate ever ran, so short explicit memory questions ("what did I say?", 15 chars) got an empty `<vault-context>` in violation of the gate's own contract. The force check is now consulted before the length early-return (new `hasForceRetrieveIntent` export, shared with `shouldSkipRetrieval` so there is one source of truth). Empty prompts, short non-memory prompts, slash commands, heartbeat suppression, duplicate dedupe, and the query-text privacy split (pre-retrieval skips never persist prompt text) are all unchanged.

### Quality gates

Full suite 1,619/0 (42 new tests). Each item independently reviewed by a cross-model adversarial pass (codex / GPT-5.6) to verbatim "Zero remaining findings — ship as is.": the eval harness in 3 turns, the gate-ordering fix in 1.

### What didn't change

No schema changes, no migrations, no re-embed. All runtime retrieval surfaces (hooks beyond the gate ordering, `query`, `intent_search`, `search`, `vsearch`, `memory_retrieve`, REST) score and rank exactly as in v0.25.0. No MCP tool was added — the eval harness is CLI-only.

---

## v0.25.0 — extraction retry-with-error-feedback + decision half-life + entity-neighbor hub-bias fix

Three independently reviewed items from the strategic queue (§13.1, §36.11, BL-001) — the first queue burndown since the ranking was locked. Three files, three pipelines, no shared invariants.

### §13.1 — retry-with-error-feedback on every LLM extraction path (`src/llm-retry.ts`)

ClawMem's extraction surfaces were single-shot: one `generate()` attempt, and any malformed/empty response failed open to `[]`/`null` with no signal to the model about what went wrong — invisible data loss on every transient formatting miss. All eight extraction call sites now ride `withRetryAndFeedback` (pattern re-authored from Volt's llm-map validation loop):

- **Stateless corrective retries** (default 3 attempts): each retry is a fresh `generate()` call with a reconstructed prompt — original prompt + the parse error + a 500-char excerpt of the previous response — never a conversation continuation.
- **Hard wall-clock deadline** shared across all attempts: no attempt starts past the deadline, and an in-flight `generate()` is raced against it — a backend that ignores the abort signal cannot hold the helper past the budget.
- **Fail-open on exhaustion** (null → the same `[]`/`null` callers already handled), now with a terminal `[llm-retry] <label>: exhausted…` warning naming the call site.
- Call sites: observer `extractObservations`/`extractSummary`, conversation-synthesis `extractFactsFromConversation`, A-MEM `constructMemoryNote`/`generateMemoryLinks`/`evolveMemories`/`inferCausalLinks`, entity `extractEntities`. Parse closures own whole-response STRUCTURAL validation (so a malformed payload triggers a corrective retry instead of a silent post-loop drop — including integer-validated causal-link indexes, closing a partial-write path); semantic/domain filtering stays outside the loop.
- Accounting change: a transient failure that recovers on retry no longer counts as an LLM failure in `mine --synthesize` stats; only terminal exhaustion does.

### §36.11 — decision ranking half-life: ∞ → 180 days (`src/memory.ts`)

`HALF_LIVES.decision = Infinity` pinned recency at 1.0 forever, so a silently-abandoned decision ("we'll use X" → quietly moved to Y, with no contradictory write to trigger supersession) kept winning ranking indefinitely. Decisions now decay on a 180-day half-life. **Ranking durability only:** `decision` keeps its attention-decay exemption, nothing is deleted or archived (lifecycle policy is separate), the access-frequency extension still stretches frequently-resurfaced decisions toward 3×, and `deductive`/`preference`/`hub`/`antipattern` stay infinite. An unaccessed 180-day-old decision drops to recency 0.5 — still fully searchable, just no longer permanently ahead of fresher material.

### BL-001 — `getEntityGraphNeighbors` hub-bias fix (`src/entity.ts`)

The entity-neighbor path ranked by raw co-occurrence count — reintroducing exactly the hub bias the edge-creation path's IDF suppression exists to prevent (one path suppressed hubs, the other reinforced them). Neighbor ranking now blends count with IDF specificity (`min(1, log1p(count)/5) × clamp(idf/3.0)`, sharing the edge path's 3.0 threshold via `ENTITY_IDF_SPECIFICITY_THRESHOLD`):

- **Score-before-limit:** every co-occurring candidate is scored, THEN the pool is capped at 30 — a specific neighbor at raw-count rank 31+ can now surface (the old SQL `ORDER BY count DESC LIMIT 30` excluded it before scoring).
- **Best-path-per-doc:** candidates are traversed in blended-score order, so a document reachable via both a hub and a specific entity keeps the specific path's score and `viaEntity`.
- **Active-only IDF + hydration:** IDF populations are active-documents-only (archived mentions can no longer distort specificity), archived-only candidates are dropped from the pool, and hydration excludes archived documents before its per-entity LIMIT. One grouped CTE query supplies counts and active doc-frequency together (no N+1).

### Quality gates

Full suite 1,577/0. Each item independently reviewed by a cross-model adversarial pass (codex / GPT-5.6) to verbatim "Zero remaining findings — ship as is.": §13.1 in 3 turns, §36.11 in 2, BL-001 in 3 (bug-first — the failing hub-bias test predates the fix).

---

## v0.24.0 — raw-BM25-primary ranking for `search` (judged keyword eval) + bypass A/B toolkit

v0.23.0 made the FTS relevance signal real and deliberately deferred any ranking-contract change to a judged eval. That eval ran: 43 judged keyword targets (23 discovery + 20 family-disjoint held-out) with objectively-labeled fairness shapes (14 raw-favorable "exact-old", 22 composite-favorable "fresh-among-many"), frozen floors and decision rules pre-registered before any comparison was computed. **Raw-BM25-primary beat the shipping composite decisively**: combined MRR 0.848 vs 0.415, hit@1 33 vs 6; held-out 0.875/16-at-#1 vs 0.335/zero-at-#1 (the composite missed the absolute floors outright); composite lost even on its OWN favorable shape (fresh-among-many 0.348 vs 0.801) — the recency/quality/co-activation multipliers bury keyword relevance rather than refine it. One paired regression (one position) in 43 cases; controls clean in both arms.

### Behavior changes

- **`search` ranks non-recency queries by the RAW BM25 transform** (`|bm25|/(1+|bm25|)`), mirroring the v0.22.0 vector-route pattern. Metadata — including pin — participates only inside groups of exactly-equal raw scores (deterministic tie order: pinned, then legacy composite, then path). `structuredContent` carries `scoreBasis: "fts-bm25"`. FTS-transform values and vector cosines remain independent, non-comparable channels.
- **`minScore` on `search`** now filters the raw score for non-recency queries and has NO default — omitted means no filter, an explicit `0` is honored. Recency-intent queries ("latest…", "recent…") keep the composite regime with the previous default-0 floor and report `scoreBasis: "composite"`.
- **Unchanged surfaces:** hooks/context-surfacing, `query`, `query_plan`, `intent_search`, `memory_retrieve`'s composite modes, the CLI `search` command, and the REST API keep their existing scoring. The change is scoped to the MCP `search` tool, exactly as evaluated.
- **Bypass ops escape hatch:** `CLAWMEM_DISABLE_FTS_BYPASS=true` forces the full expansion path at both strong-signal-bypass consumers (MCP `query` pipeline + CLI `query`) — built for the 49.3 A/B harness, kept as an operational kill switch.
- **`expandQueryCacheKey` exported** — the exact `llm_cache` key `expandQuery` reads/writes, so eval harnesses can delete/verify expansion cache rows without replicating private key construction.
- **Bypass characterization (49.3, frozen census):** on a frozen 127-query census (51 judged keyword cases + 76 firing-hunt probes) over the frozen production snapshot, the strong-signal bypass fired on THREE — 3/51 on the judged set, 0/76 among the probes — all lone-or-near-lone pools, all with the correct top document. Frozen-corpus characterization only: the probes were selected to hunt firings, so these rates say nothing about production firing prevalence (unmeasured), and the firing set is snapshot-relative — one probe term began firing on the live index hours later as new documents mentioned it. On this frozen snapshot/census the gap ≥ 0.15 condition fired rarely — sibling documents suppress the gap on this corpus. Eval tooling: `scripts/eval-keyword-acceptance.ts` (freeze/run, FTS-only) and `scripts/eval-bypass-ab.ts` (freeze/run, live-service A/B with a verified expansion-cache freeze and census integrity re-execution).
- **Bypass A/B verdict (49.3):** on the frozen census's complete fired population (3 natural cases; pre-registered zero-allowance gates; run gated on frozen service identity + an embed-geometry canary drift-check + rerank health), the bypass lost nothing — zero dropouts, zero hard regressions, bypass-arm MRR +0.038 higher — and saves ~56% wall time where it fires (1.9 s vs 4.3 s with a warm expansion cache). Verdict: `SAFE ON FROZEN CENSUS (n=3 fired; zero-allowance gates); population risk unvalidated` — thresholds 0.85/0.15 stand on this census; no tuning proposed.

---

## v0.23.0 — monotonic BM25 exposed score (the FTS relevance signal was a constant)

The v0.22.0 design gate discovered that `searchFTS`'s exposed score was computed as `1 / (1 + Math.max(0, bm25))` — but FTS5's `bm25()` is negative-is-better and ≤ 0 for every match (0/4,962 positive rows measured on a production vault), so **every FTS result carried the identical score 1.0**. SQL ordering was correct; everything downstream of the exposed score was not: composite ranking on FTS surfaces (`search`, REST keyword, CLI, `memory_retrieve` keyword and its semantic-mode FTS fallback, hook FTS lanes) was effectively metadata-only, the `query` pipeline's strong-signal bypass could never fire on multi-hit queries yet always fired on single-hit ones, hook injection systematically preferred FTS-sourced docs over vector-sourced ones (1.0 vs cosine), and every score-threshold gate was vacuous.

### Behavior changes

- **Exposed FTS score is now `|bm25|/(1+|bm25|)`** (`ftsScoreFromBm25`, exported): monotonic in match strength, bounded [0,1), per-row stable, clamps a hypothetical positive input to 0.
- **`search` keeps the composite regime** (a regime change is gated on the 49.2 judged keyword eval) — but its searchScore input is now real, so keyword relevance finally contributes ordering. Observed `score`/`compositeScore` values shift accordingly; `minScore` semantics are unchanged. Compact results report the composite; non-compact carry both `score` (raw transform) and `compositeScore`.
- **Strong-signal bypass is functional**: fires only on a strong (≥ 0.85 ⇔ |bm25| ≥ 5.67), clearly separated (gap ≥ 0.15) top hit; a lone weak match no longer triggers it. One shared helper (`hasStrongFtsSignal`) now backs both the MCP `query` pipeline and the CLI `query` command (previously a drifted duplicate).
- **`memory_forget` targeting is stricter and safer**: the confidence gate (`score ≥ 0.7`, or a ≥ 0.2 gap when 2+ candidates exist) is live — previously every FTS candidate scored 1.0 and was auto-selected, including a lone garbage match. Weak matches now return the candidate list for disambiguation. Non-destructive pin/snooze behavior is unchanged.
- **`query_plan`'s graph clause now carries RRF-fused scores into graph traversal** (parity with the causal and `intent_search` paths, via a shared `attachRrfScores` helper) — traversal seed mass was previously anchored on raw single-channel scores.
- **Consolidation dup-gate and curator BM25 probe are live**: the `score ≥ 0.7` duplicate filter and the `> 0.3` retrieval probe actually discriminate now. A near-empty vault may honestly report a degraded BM25 probe where it previously passed vacuously.
- **Scale honesty**: FTS-transform scores and vector cosines are independent monotonic signals, not a calibrated common scale. Mixed-channel merge points (REST hybrid max-merge, hook dedup) are no longer degenerate, but cross-channel calibration remains future, eval-gated work.

Follow-on work: BACKLOG 49.2 (judged keyword eval → `search` regime recommendation; reports bypass firings) and 49.3 (query-pipeline A/B before any bypass-threshold tuning).

---

## v0.22.0 — raw-similarity-primary ranking for the direct vector routes

v0.21.0 removed the system-internal junk from the direct tools' results; the direct-pipeline eval it mandated then showed the composite scoring layer itself was the remaining defect on those routes: on a judged set against the live vault, pure raw cosine ranked 16/19 targets #1 (MRR 0.912) while the shipping composite ranked 1/19 (MRR 0.307), filtered 14/19 correct answers below the old `minScore` floor, and got WORSE with deeper candidate pools. Attribution was measured per stage: length normalization caused the floor kills; the pin +0.3 additive made one pinned, heavily-accessed hub document top-1 for nearly every query including nonsense controls; re-mixing the weights could not help because every multiplier is larger than the 0.03–0.10 raw margins that separate right answers from wrong ones in the compressed-high band of modern embedding models.

### Behavior change: raw ordering on the evidenced vector routes

- **`vsearch` and `memory_retrieve` semantic/discovery modes** rank non-recency queries by RAW vector cosine. Document metadata — including pin — participates only inside groups of exactly-equal raw scores (deterministic tie order: pinned, then legacy composite, then path). `structuredContent` carries `scoreBasis: "vector-cosine"`; raw cosine is embedding-model-specific and not comparable to composite values.
- **`minScore` on `vsearch`** now filters the raw score for non-recency queries and has NO default — omitted means no filter, an explicit `0` is honored (nullish handling). Recency-intent queries keep the composite regime with its 0.3 default floor and report `scoreBasis: "composite"`.
- **Recency-intent queries are unchanged everywhere** (RECENCY_WEIGHTS composite, newest-first behavior, contentType priority sort), selected through one centralized regime function. The semantic/discovery FTS *fallback* (vector leg unavailable) also keeps composite — its scores are not cosine.
- **Unchanged routes:** `search` (BM25), `query`, `query_plan`, `intent_search`, hooks/context-surfacing, and `memory_retrieve` keyword/hybrid/causal/complex. `find_similar` was already raw-ranked and is untouched (docs now say so). A BM25 ranking eval is backlogged separately — its exposed score is currently non-monotonic (`Math.max(0, bm25)` flattens FTS5's negative-is-better scores), a pre-existing issue this release documents but does not change.
- **Pin re-documented:** pin = lifecycle retention + prioritization among relevance-equivalent results. On composite surfaces it keeps the +0.3 boost; on the raw routes it breaks exact ties only. "Persistent surfacing" — a pinned document floating above more relevant ones on every query — was the measured hub defect, not a feature.
- **`retrieval.mcp_direct_tuned_weights` is superseded and has no effect.** Its own gate evidence (the direct-pipeline eval) measured tuned weights at 1/19 hit@1. The key is still parsed; setting it logs a once-per-process warning.

### Verification

`bun test` → 1504 pass / 0 fail (new: constructed-tie units — pin wins inside an exact-score tie group and never crosses a boundary; regime selection; no-default-floor + explicit-zero `minScore` handling; route-level raw-ordering regressions including the incident fixture, which now proves the inversion cannot recur even with `includeInternal: true`). A frozen, deterministic acceptance gate (`scripts/eval-acceptance.ts`: vault snapshot + frozen `asOf` clock + per-case frozen query vectors through the guarded precomputed-vector path) passed all predeclared criteria: pin-invariance rank identity on non-recency cases; exact match to the frozen composite baseline on recency cases; no control-query hub dominance and no pinned top-1; discovery set 23/23 in-pool, hit@1 18/23, MRR 0.870; held-out family-disjoint set hit@1 17/20, hit@5 19/20, MRR 0.879 against floors of 12/20, 17/20, and 0.75 declared before the set was authored. Design and implementation adversarially reviewed cross-model to explicit clearance (5-turn DESIGN gate, 14 findings folded).

## v0.21.0 — vsearch trust hardening: internal-collection exclusion, geometry canary, embed survivability

A live incident exposed a stacked failure: an embedding server silently producing non-discriminating vectors for the vault's dominant register (a last-token model whose GGUF conversion lost its EOS-append flag), amplified by composite scoring floating system-internal docs over true matches — while every existing health check passed. The server-side cause is an operator fix; this release closes the client-side amplification and the detection gaps, and hardens the embed run that the remediation itself crashed.

### Behavior change: `_clawmem` excluded from MCP retrieval by default

`search`, `vsearch`, `query`, `query_plan`, `memory_retrieve`, and `find_similar` no longer return the system-internal `_clawmem` collection (observations/deductions/handoffs) unless asked: pass `includeInternal: true`, or name `_clawmem` in an explicit `collection` filter. `find_similar` auto-includes internal neighbors when the reference document is itself internal. `intent_search` / `find_causal_links` / `kg_query` / `session_log` / `timeline` are unfiltered by design — system memory is their substrate. Exclusion happens at the store layer (SQL predicate for BM25; escalating MATCH depth for vectors) and inside graph traversal (excluded nodes are pruned before beam selection and score normalization), so internal docs neither appear NOR consume candidate/beam budget.

Vector-side contract: under exclusion the scan escalates depth until `limit` allowed documents hydrate, capped at 4,096 fragments. Cap-limited under-fills carry an explicit `degraded: true` + `degradedReason` (`excluded-dominant` when distinct excluded docs account for the shortfall, `cap-truncation` when fragment dedup drives it); multi-leg routes aggregate `any(leg)` with per-leg reasons in `structuredContent.degradedLegs`. Plain small-vault exhaustion returns a normal short list with no marker.

### Embedding-geometry canary (preflight + doctor)

- `clawmem embed` now runs a pair-separation probe battery BEFORE any destructive step — a broken-geometry server aborts the run before `--force` clears anything (override: `--force-geometry`). The battery uses the production embed templates and includes terminus + truncation controls that catch unanchored last-token readouts; self-similarity alone cannot (stored-vs-fresh stayed 0.999 through the entire incident).
- Baselines are stored per (probe-version, model, dimension) profile in a new `embed_canary` table as **first-healthy calibrations** — healthy runs never roll the reference; `clawmem embed --force --recalibrate-canary` is the explicit replacement operation (intrinsic sanity floors govern its gate, since the old baseline is exactly what it replaces). Margins alert relative to the calibrated baseline (< 50%) with an absolute backstop, and drift (stored-vs-fresh probe cos < 0.98) flags a changed serving stack behind an unchanged model name. Mixed dimensions/models across one battery (a flapping endpoint) are a hard failure, and a `--force` clear never proceeds on an UNVALIDATED endpoint. Mid-run drift, an unverifiable run end, or a no-preflight override persists a durable `embed_geometry_taint` flag (lease-fenced) that keeps `doctor` nonzero until a verified full rebuild clears it.
- `clawmem doctor` gains the canary (section 10) and a sampled persisted-vs-fresh check on real index rows (section 11): fragments are reconstructed through the production parse/split/format pipeline and compared to their stored vectors. New vectors persist an `embed_input_fp` (SHA-256 of the exact embed input) enabling full validation; pre-0.21.0 rows validate structurally with title provenance flagged unavailable until their next re-embed. Definitive failures (fingerprint mismatch = stale input; fingerprint match + low cosine = corruption) exit nonzero immediately — sampling coverage can never mask them.

### Embed-run survivability

The incident's remediation run died on a transient `SQLITE_BUSY`: the failure-marker write itself crashed a `--force` rebuild at doc 344/4,995 with the index already cleared. Now: the embed connection runs a 10s busy timeout (set on the ACTIVE connection, covering `update --embed`'s cached store; kept short so synchronous waits cannot starve the 30s lease heartbeat), retries are asynchronous and bounded with a lease-loss abort between attempts, `markEmbedStart/Synced/Failed` are lease-fenced in-transaction, a marker that still fails logs-and-continues instead of killing the run, and `--force` skips the post-clear stale-embedding cleanup (a no-op that could only add a die-after-clear window).

### Also

- `latest` now routes to recency intent (`RECENCY_PATTERNS`) — "latest decisions" was scoring under non-recency weights.
- Config knob `retrieval.mcp_direct_tuned_weights` (default **false**; env `CLAWMEM_MCP_DIRECT_TUNED_WEIGHTS`): opt-in to score the MCP direct tools' non-recency queries with the retrieval-tuned `query`-tool weights. The default flip is gated on a direct-pipeline eval — the existing n=199 evidence covered only the hybrid `query` pipeline.
- Read-only template A/B evaluator (`scripts/eval-query-template.ts`): ranks known-target queries under query-template / doc-template / raw formatting against the live index through the same model+dimension guards as production, writing nothing. Measured post-incident: a doc-templated query ranked the true target #1 where the query template ranked it #383 — a query-side-only template change needs no re-embed.
- Production vector search now runs an explicit pre-MATCH dimension check via a shared query-vector compatibility guard (previously model-consistency only).
- Docs: the zembed-1 launch line ships with `--pooling last --override-kv tokenizer.ggml.add_eos_token=bool:true` (the missing flags seeded the incident); troubleshooting's claim that a re-embed is "not required" after a pooling fix is corrected (it IS required — same-dimension geometries are incompatible); the missing-EOS-anchor signature, shared-suffix diagnostic confound, compressed-high similarity bands, and watcher/`tee` operational notes are documented.

### Verification

`bun test` → 1492 pass / 0 fail (45 new regressions: escalation fill / cap-exhaustion markers / dedup-collapse / mixed-cause truthfulness / small-vault no-marker; traversal beam parity; shared-guard model+dimension; canary healthy/collapsed/drift/unavailable/mixed-endpoint; fail-closed preflight gate matrix; first-healthy baseline calibration; sampled-validation tiers incl. definitive-failure non-maskability, canonical-alias dedup, and hard attempt caps; busy-retry semantics; lease-fenced markers; `latest` routing; route-level MCP tests over an in-memory transport for all six retrieval tools incl. the incident composite-ranking fixture). Design adversarially reviewed to explicit clearance in a 7-turn cross-model DESIGN gate (34 findings folded); implementation review findings (fail-open canary gate, unbounded sampling, canonical-identity blindness, rolling baselines, taint persistence, and route coverage) folded before ship.

## v0.20.2 — Beads sync hardening: argument-safe exec, telemetry-off spawns

`runBd` assembled a shell string and ran it through `execSync`, leaving argument interpolation to the shell, and bd v1.1.0 upstream turned on anonymous usage metrics by default with a remote reporting endpoint and a spawned flush sender — so every bd invocation ClawMem makes during a sync would have phoned home on upgraded installs.

- **`execFileSync` replaces the shell string** (`src/beads.ts`): arguments pass as an array with no shell interpolation; same timeout, cwd, and error handling.
- **Telemetry is disabled for ClawMem-spawned bd calls only.** The spawn env forces `BD_DISABLE_METRICS=1` and `BD_DISABLE_EVENT_FLUSH=1`. Older bd releases ignore the unknown variables (verified on v0.58.0); a user's own interactive bd keeps whatever metrics preference they chose — automated sync calls would only have skewed it.

### Verification

`bun test` → 1447 pass / 0 fail. Empirical matrix on both ends of the supported bd range: v0.58.0 and v1.1.0 return identical rows with and without the env pair. The exec seam was flagged in an independent cross-model adversarial review (codex / GPT-5.5).

### What didn't change

The parse schema, sync semantics, dep-type bridging, and document shape are untouched. v0.20.2 is byte-identical in behavior to v0.20.1 except for the exec mechanism and the spawned-call env.

## v0.20.1 — Beads sync against bd v1.1.0: full-backlog list, dead field dropped, claim leases surfaced

An upstream delta survey of beads v1.0.5 → v1.1.0 (`gastownhall/beads`, formerly `steveyegge/beads`) found three drift points in the sync:

- **The 50-issue silent truncation is gone.** `queryBeadsList` inherited `bd list`'s default cap, so backlogs past 50 issues silently synced a prefix. The query now passes `--limit 0` (unlimited) — verified live against bd v0.58.0 and v1.1.0, so the fix does not raise the version floor.
- **`quality_score` dropped from the parse** (`src/beads.ts` interface, normalizer, and formatter). Upstream removed the field at v0.62.0; it was `omitempty` even before, so real `bd list --json` output stopped carrying it long ago. This is bd's per-issue field — ClawMem's own indexing-time quality scoring is a different mechanism and is untouched.
- **Claim leases surfaced.** bd v1.1.0 issues can carry `lease_expires_at` / `heartbeat_at`; the sync now parses both and renders a `**Claim Lease**: expires …` line when present, so agent-claimed work is visible in indexed memory. Absent on older bd → the line is skipped.

### Verification

`bun test` → 1447 pass / 0 fail. No ClawMem consumer references the dropped field (`store.ts` / `mcp.ts` / CLI checked). `--limit 0` and field behavior exercised against live databases on bd v0.58.0 and v1.1.0.

### What didn't change

Dependency-type bridging is untouched — the new upstream dep types (`tracks`, `until`, `authored-by`, `assigned-to`, `approved-by`, `attests`) fall to the existing `semantic` default exactly as unmapped types always have. Watcher behavior, `.beads/` discovery, and document format are unchanged apart from the two field-level items above.

## v0.20.0 — Vector-query daemon: a hard cap on the cold synchronous MATCH

v0.16.0 and v0.17.0 bounded the `context-surfacing` hook's vector leg with wall-clock deadlines and kept the sqlite-vec payload warm with a watcher prewarm, but those are probability reductions: a synchronous `bun:sqlite` MATCH exposes no interrupt, so once a cold scan on a large vault is in flight it blocks the hook's event loop past the 8-15s budget and the in-thread `Promise.race` timer cannot fire. v0.17.0 tracked the true hard cap — moving the scan off the hook's event loop — as deferred. This release ships it.

- **Vector-query daemon, hosted by the watcher (opt-in, a pure optimization layer).** `clawmem watch` now runs a per-vault unix-domain socket daemon. The `context-surfacing` hook sends only the query string; the daemon runs Step 1 — the embed plus the blocking sqlite-vec MATCH — in its own process and returns the raw `{hash_seq, distance}` matches, which the hook hydrates locally (Step 2). With the blocking scan off the hook's event loop, the hook's real `setTimeout` finally fires: a cold scan that would have blocked the turn now times out fast and falls back to FTS with bounded latency. `searchVec` is split into `searchVecMatch` (Step 1) and `hydrateVecResults` (Step 2); the in-process `searchVec` composes them, so its contract is unchanged, and both hook vector legs — primary and deep-escalation — are bounded, not just the first.
- **Strict graceful degradation — never a dependency.** When the watcher isn't running the socket is absent and the hook uses the in-process path exactly as before. When the daemon is busy or misbehaving the hook drops to FTS rather than re-running the scan in-process (which would reintroduce the block). A read-path model mismatch still surfaces as `VecReadModelMismatchError` (warned once) across the socket, preserving the v0.18.0 contract.
- **Single-flight, deadline-on-receipt, and a private socket.** At most one scan runs per vault; a request arriving mid-scan gets an immediate `busy` (→ FTS) rather than queuing, and a request whose deadline already elapsed is dropped without scanning — so cold-scan pileups cannot starve the watcher. The socket lives under `$XDG_RUNTIME_DIR/clawmem/` (0700 dir, 0600 socket), is keyed per vault DB path, refuses to clobber a live daemon from another watcher, and is unlinked on shutdown. `CLAWMEM_VEC_TIMING=1` logs per-leg outcome and elapsed for attribution.

### Verification

`bun test` → 1447 pass / 0 fail — the project's release gate. New bug-first tests in `tests/unit/vector-daemon.test.ts` (16, deterministic under `--rerun-each 3`) cover the socket protocol (serve, malformed, oversized, teardown), single-flight and deadline-on-receipt, the per-vault socket derivation, and the client's full fail-open matrix (absent → in-process, busy/error → FTS, model-mismatch → typed rethrow); the Step-1 scan is dependency-injected so they run without an embedding server. A bare `tsc --noEmit` remains a non-gate for the reasons noted under v0.18.0; the new `src/vector-daemon.ts` and the split `src/store.ts` add no new type errors over that baseline. Reviewed by an independent cross-model adversarial pass (codex / GPT-5.5-high): a fresh DESIGN gate on the spec at build time, then code review to zero remaining findings.

### What didn't change

Retrieval quality, scoring, ranking, and the vault format are untouched — the daemon returns the same Step-1 matches the in-process path would, hydrated by the same Step-2 query. A deployment that does not run `clawmem watch` gets byte-identical behavior to v0.19.0. The daemon hosts the general vault only; skill-vault vector queries stay in-process (a far smaller surface, not the ~2 GB risk).

## v0.19.0 — Priority-based transcript formatting for session extraction

The `decision-extractor` and session-summary Stop hooks prepared their LLM input by walking the last N messages and truncating each to a per-role character cap until a flat budget ran out. Under that scheme a long run of mid-conversation tool output could exhaust the budget before the final assistant message (the actual outcome) was reached, and the original user request — the single most important anchor for extraction — carried the same weight as any other message. Extraction quality degraded on exactly the long, tool-heavy sessions where good observations matter most.

- **Priority-based transcript assembly.** `prepareTranscript` now classifies each message before budgeting: P0 the first user message (the original request), P1 the last real assistant message (the final response, skipping trailing tool calls), P2 tool activity, P3 the remaining conversation, P4 system messages. The critical P0/P1 pair is always included (at a doubled per-role cap); tool activity and then conversation fill the remaining budget and are *truncated to fit* rather than dropped wholesale; the result is reassembled in chronological order so the LLM still sees a coherent sequence. Tool detection keys off the generic `[tool_use` / `[tool_result` markers, so a transcript that ends on a tool call correctly keeps the preceding assistant text as the final response instead of mislabeling the tool call as the outcome.

### Verification

`bun test` → 1431 pass / 0 fail — the project's release gate. New bug-first tests in `tests/unit/observer.test.ts` cover `classifyMessages` (P0–P4 assignment, plus the end-on-tool and all-tool edge cases where no P1 exists) and `prepareTranscript` (P0/P1 always present, chronological order preserved, tight-budget prioritization, and tool messages truncated-to-fit rather than dropped). A bare `tsc --noEmit` remains a non-gate for the reasons noted under v0.18.0; the changed `src/observer.ts` adds no new type errors over that baseline. Reviewed by an independent cross-model adversarial pass (codex / GPT-5.5-high) to zero remaining findings.

### What didn't change

Retrieval quality, scoring, the vault format, and every public API are untouched. The formatter keeps the same `TranscriptMessage[] → string` contract; only the selection and ordering of what survives truncation changed. A session short enough to fit the budget is formatted with the same content as before, now in guaranteed-chronological order.

## v0.18.0 — Read-path embedding-model guard, extraction parrot-hardening, remote LLM/rerank auth

Three independent hardenings gathered from a QMD-upstream survey. The first is a behavior change on the query path (a new fatal that replaces silently-wrong results) and drives the minor bump; the other two are additive.

- **Read-path embedding-model consistency guard (contract change).** A vault embedded with one model and then queried after the active embedding endpoint switched to a *different model at the same dimension* silently matched the new query vector against the old stored vectors — cosine-meaningless results that `VecDimensionMismatchError` cannot catch (the dimension is unchanged). `searchVec` now compares the endpoint-returned model against the vault's stored model(s) after the query embed and throws `VecReadModelMismatchError` unless the vault holds exactly one model equal to the active one — a heterogeneous vault (more than one stored model) is rejected too, since the extra model's vectors still pollute the space. The comparison uses the endpoint's own reported model, not the caller's model alias, and is cached per connection keyed on SQLite's `data_version` so a cross-process `clawmem embed --force` invalidates a stale verdict. Explicit query paths (MCP tools, the REST server, the CLI) surface the error; the fail-open hooks (`context-surfacing`, the Stop-hook `decision-extractor`) warn once per process and degrade to BM25 rather than dropping the turn. Remedy: `clawmem embed --force`.
- **Extraction prompts hardened against parroting.** The conversation-synthesis and deductive-synthesis prompts carried copyable few-shot examples with concrete, real-looking content; a weak local extraction model run out of distribution echoed them verbatim instead of extracting. Both examples are replaced with structure-only `{{...}}` skeletons, and a shared residue guard — extracted from the observer path into `src/schema-placeholder.ts` and now imported by all three extraction paths — rejects any output that echoes a schema placeholder or template marker. A new `placeholderRejects` counter surfaces echoed drafts in the deductive-synthesis stats. The guard deliberately does not blocklist the removed example text (plausible real facts like an OAuth decision would false-positive); it keys off the skeleton markers instead.
- **Remote LLM + reranker authentication.** `generateRemote` (the remote LLM path) and the remote reranker path sent no `Authorization` header, so neither could point at an authenticated cloud endpoint. New independent env vars `CLAWMEM_LLM_API_KEY` and `CLAWMEM_RERANK_API_KEY` add a `Bearer` header when set, mirroring the existing `CLAWMEM_EMBED_API_KEY`. The three keys are independent (the services may sit behind different hosts). Additive and backward-compatible — no header is sent when a key is unset.

### Verification

`bun test` → 1228 unit + 131 integration + 35 hooks = 1394 pass / 0 fail — the project's release gate. (A bare `tsc --noEmit` is not a gate here: the root tsconfig pulls in a vendored example app whose deps aren't installed, and the tree carries pre-existing type-loose test idioms; the changed W1/W2/W3 source adds no new type errors over that baseline.) New and expanded bug-first tests: `tests/unit/embed-dimension-safety.test.ts` (read-path model mismatch, endpoint-model-vs-caller-arg discrimination, heterogeneous-vault rejection, cross-connection `data_version` invalidation, and the fatal-rethrow helper), `tests/unit/schema-placeholder.test.ts` (residue detection with an explicit false-positive boundary), `tests/unit/conversation-synthesis.test.ts` and `tests/integration/deductive-guardrails.integration.test.ts` (skeleton echoes rejected, residue filtered), and `tests/unit/llm-remote-config.test.ts` + `tests/unit/rerank-health.test.ts` (auth headers present when configured, absent when not, keys independent). Reviewed across all three workstreams by an independent cross-model adversarial pass (codex / GPT-5.5-high) to zero remaining findings.

### What didn't change

Retrieval quality, scoring, and the vault format are untouched. The read-path guard fires only on an actual model divergence — a correctly-embedded vault behaves exactly as in v0.17.0. When no auth keys are set, the LLM and reranker requests are byte-identical to before.

## v0.17.0 — Harden the `context-surfacing` hook budget + cancellable embeds (follow-up to v0.16.0)

v0.16.0 fixed the dominant `context-surfacing` hook-timeout causes (the unbounded synchronous vector leg and the init-backfill write lock). This release closes the residual write-contention and embed-cancellation gaps on the same hook path, and keeps the warm-cache guarantee alive on long-running hosts.

- **Best-effort hook writes fail fast under contention.** The hook's own writes (the dedup UPSERT, `context_usage`, recall events, co-activations) are all best-effort, but the dedup UPSERT ran early and unguarded — a contended `SQLITE_BUSY` there aborted the whole hook before it could return context. It is now fail-open, and the `context-surfacing` hook process caps its own `busy_timeout` (1500ms) so a contended best-effort write fails fast instead of stalling the budget. The cap is scoped to that process only (the Stop hooks keep the 5000ms default), and the skill-vault opens on the hook path inherit the same cap.
- **Cancellable embeds.** `embed()` now honors an `AbortSignal` end to end: the underlying fetch is cancellable, the 429 retry backoff aborts mid-sleep instead of sleeping through every retry, and an aborted embed is classified as cancellation — not a transport failure — so it no longer trips the 60s remote-down cooldown. `searchVec`/`getEmbedding` derive the signal from their wall-clock deadline, and a deadline also suppresses the unbounded local-model fallback so a hook embed cannot start a model load past its budget. The indexing batch-embed path is unchanged.
- **Periodic vector prewarm.** The watcher's one-shot prewarm warms the OS page cache once; on a long-running host under memory pressure the kernel can evict the vector payload between hook calls, letting a cold synchronous scan creep back onto the hook path. The watcher now re-runs the embed-independent prewarm on an interval — `CLAWMEM_PREWARM_INTERVAL_MS`, default 10 minutes, `0` disables, values below a 60s floor are clamped up — to keep the payload resident. This is a probability reduction, not a hard cap: a true bound on the uninterruptible synchronous scan needs process isolation and is tracked as deferred.
- **Two test-methodology fixes (source proven correct, not adjusted).** A pre-existing topic-boost fail-open test conflated the focus-topic variable with sequential recall-feedback state and read the real skill vault; it now uses two identically-seeded stores plus hermetic vault isolation, and the zero-match fail-open contract is proven byte-identical. A pre-existing watcher heavy-lane test set a `0..23` quiet-window believing it meant "any hour," but the window is end-exclusive, so the test failed during the 23:00 local hour; it now omits the window (always-open) and a hermetic unit guard pins the end-exclusive boundary.

### Verification

`bun test` → 1390 pass / 0 fail. New and expanded bug-first tests: `tests/unit/hook-timeout-fix.test.ts` (dedup fail-open under a held write lock, the named-vault `busy_timeout` cap, periodic prewarm firing + clean teardown, and the interval resolver's strict parse + floor) and `tests/unit/llm-fallback.test.ts` (embed `AbortSignal` across the fetch, the 429 backoff, the cooldown classification, and the local-fallback suppression). Each was guard-verified — it fails on the pre-fix source and passes after. Reviewed by an independent cross-model adversarial pass (GPT-5.5 high) to zero remaining findings.

### What didn't change

Retrieval quality, scoring, and the vault format are untouched. The `busy_timeout` cap is scoped to the `context-surfacing` hook process, so the Stop hooks and every other command keep the operational default. On any host that does not run the watcher, behavior is exactly as in v0.16.0 (the periodic prewarm lives only in the watcher).

## v0.16.0 — Fix: `context-surfacing` UserPromptSubmit hook intermittently times out

The `context-surfacing` hook could intermittently exceed its UserPromptSubmit budget ("hook timed out — output discarded"), especially on the first prompt after a fresh boot and across concurrent sessions. The dominant cause was **not** inference or host memory: the vector leg ran a *synchronous* `sqlite-vec` scan that the `Promise.race(vectorTimeout)` guard could not bound (a synchronous call blocks the event loop, so the timer never fires), and every writable hook open ran an unconditional backfill `UPDATE` that could wait out `busy_timeout` under writer contention.

- **Bounded vector search on the hook path.** `searchVec` now takes a wall-clock deadline and self-aborts before the blocking `MATCH` if the budget elapsed during the async embed. Both the balanced and deep-escalation vector legs race the embed against the remaining budget and clear their timers, so a pending timer no longer keeps the hook process alive after results are in hand.
- **No write lock on a healthy init.** The `last_accessed_at` backfill is read-guarded (skipped when nothing needs it) and `initializeDatabase`'s `busy_timeout` is capped to the caller's value, so a writable hook open no longer waits out the init `busy_timeout` under contention.
- **Watcher-side vector prewarm.** A single embed-independent prewarm (a zero-vector `MATCH`) warms the sqlite-vec payload into the OS page cache on watcher startup so the first post-boot hook call isn't cold. It runs only in the watcher process (never per-session), reports success only when a scan actually ran, and never blocks startup.

Cross-model reviewed (GPT-5.5, five rounds to zero findings). New tests: `tests/unit/hook-timeout-fix.test.ts`.

## v0.15.1 — Fix: macOS bootstrap fails to load the sqlite-vec extension (Issue #20)

On macOS, `clawmem bootstrap` (and `clawmem doctor`) failed at the database step with `This build of sqlite3 does not support dynamic extension loading`. Apple's built-in SQLite — which Bun uses by default — is compiled without extension-loading support, so the `sqlite-vec` vector extension cannot load. The prior macOS handling probed only the Apple-Silicon Homebrew path and swallowed the failure silently, so a fresh macOS install with no `brew install sqlite` (and Intel Macs, whose Homebrew prefix differs) hit the bare extension-loading error with no guidance. Yoloshii/ClawMem#20.

What changed:

- **Broader extension-capable SQLite detection** (`src/store.ts`): `setCustomSQLite()` now probes the Apple-Silicon (`/opt/homebrew`) *and* Intel (`/usr/local`) Homebrew prefixes, falling back to `brew --prefix sqlite` for non-standard prefixes (only when the standard paths are absent, so the common case pays no subprocess cost). Every candidate is existence-checked before use — `setCustomSQLite()` with an invalid path hard-crashes Bun (oven-sh/bun#18811), so the existence guard is load-bearing, not cosmetic.
- **Actionable error instead of the cryptic one** (`src/store.ts`): both `sqlite-vec` load sites now route through a helper that, on macOS, rewrites the "does not support dynamic extension loading" failure into guidance to run `brew install sqlite` (naming the detected SQLite path, or noting none was found). `clawmem bootstrap` and `clawmem doctor` surface this message directly instead of the bare extension error.
- **Troubleshooting entry** (`docs/troubleshooting.md` → "Bun runtime"): documents the symptom, the `brew install sqlite` fix, and the auto-detection behavior.

### Verification

`bun test tests/unit/` → 1183 pass / 0 fail. A new bug-first test (`tests/unit/store.macos-sqlite.test.ts`, 5 cases) asserts the error mapping: macOS + no Homebrew SQLite → `brew install sqlite` guidance; macOS + a detected-but-failing SQLite → `brew reinstall` + the path; non-macOS and unrelated errors pass through untouched. It fails on the pre-fix source (no mapping existed) and passes after.

### What didn't change

- No change to retrieval, scoring, the vault format, or any non-macOS code path — on Linux/Windows the macOS detection block is skipped entirely and `sqlite-vec` loads exactly as before. This is a macOS-only install fix.

## v0.15.0 — Agent-instruction refactor (AGENTS.md as lean SSOT) + antipattern durability fix

The agent-facing instruction surface was three overlapping copies — `CLAUDE.md` and `AGENTS.md` were byte-identical 72 KB / 800-line twins (2.2× over Codex's 32 KiB `AGENTS.md` cap, which truncates silently), and `SKILL.md` was an 830-line third copy. All three duplicated each other and the existing `docs/` tree. This release aligns to the convention — `AGENTS.md` is the lean root SSOT, `CLAUDE.md` imports it, `SKILL.md` is on-demand operational guidance, and the deep reference lives in `docs/`. It also fixes a latent scoring bug found during review: `antipattern` memories were decaying despite being documented and intended as durable.

What changed:

- **`AGENTS.md` is now a lean root SSOT** (72,637 → ~17.7 KB, under the 32 KiB cap). Keeps the agent-facing essentials — inference-at-a-glance, install, the 90/10 retrieval model + Tier-2 hook table, the 3-rule escalation gate, Tier-3 tool routing + MCP tool table, query-optimization levers, composite-scoring summary, indexing rules, lifecycle, anti-patterns, integrations — and points into `docs/` for everything deep, with a reference index at the foot.
- **`CLAUDE.md` is now an `@AGENTS.md` import** (72,637 → 379 bytes), ending the byte-identical twin and its dual-maintenance drift. Claude Code reads `CLAUDE.md` natively, so the import bridges to the single SSOT.
- **`SKILL.md` trimmed to an on-demand operational reference** (830 → ~267 lines, `version` 2.0.0): escalation gate, tool routing, the 4 query-optimization levers, pipeline behavior, composite scoring, lifecycle, gotchas — with repo-relative pointers. Setup / inference / config / internals deliberately live in `AGENTS.md` + `docs/`.
- **New `docs/guides/inference-services.md`** consolidates the inference / model / server-setup content that was triplicated across `AGENTS.md`, the README "GPU Services" wall, and `cloud-embedding.md`, with a stack-decision matrix (QMD-native vs SOTA z-stack vs cloud embedding) up front.
- **New `docs/reference/configuration.md`** — a complete environment-variable reference (every `CLAWMEM_*` var except the internal, process-set `CLAWMEM_STDIO_MODE`).
- **README**: the "GPU Services" setup wall collapsed to a ~20-line decision callout linking the new guide (81.5 → 71.5 KB); the "Agent Instructions" file-roles table updated; `docs/guides/systemd-services.md` gained the scheduled `clawmem-rerank-health` unit (previously documented only in the old AGENTS.md).
- **`package.json` `files[]` now includes `docs/`** so the relative `docs/` pointers in the shipped `AGENTS.md` / `CLAUDE.md` / `SKILL.md` resolve for npm consumers, not just git clones.
- **Fix — `antipattern` memories are now durable** (`src/memory.ts`): `antipattern` was in `DECAY_EXEMPT_TYPES` and mapped to a `semantic` relation, but was **omitted from `HALF_LIVES` and `TYPE_BASELINES`**, so it fell through to the 60-day half-life / 0.5 baseline defaults — i.e. it decayed despite being documented as ∞ half-life / 0.75 baseline. Added `antipattern: Infinity` to `HALF_LIVES` and `antipattern: 0.75` to `TYPE_BASELINES` (matching the documented values). Accumulated negative patterns now persist as intended and rank with a durable baseline.

### Verification

`bun test tests/unit/` → 1178 pass / 0 fail. A new bug-first test (`tests/unit/memory.scoring.test.ts`) asserts `antipattern` durability — `recencyScore` returns 1.0 at one year old, `antipattern` confidence outranks `note` (exercising the 0.75 baseline), and the attention-decay exemption holds; it fails on the pre-fix source and passes after. Every relative link in the refactored files was resolved; `AGENTS.md` confirmed under 32 KiB; `CLAUDE.md` confirmed no longer a byte-twin. Reviewed by an independent cross-model adversarial pass (codex / GPT-5.5-high) across the refactor and the source fix to zero remaining findings.

### What didn't change

- **No retrieval-pipeline, scoring-formula, or vault-format change** beyond the `antipattern` durability fix. Documented facts, tool routing, hook behavior, and scoring weights are preserved — moved, condensed, or consolidated, not altered.
- The only runtime behavior change is `antipattern` memories no longer decaying (and getting a 0.75 vs 0.5 baseline); every other content type's half-life and baseline is unchanged.

## v0.14.0 — Reranker health guard: detect a silently-degenerate reranker (doctor + scheduled check + runtime emit)

v0.11.3 deprecated the broken zerank-2 GGUF and shipped a faithful sidecar; v0.12.0 made the reranker the dominant ranking signal. Together they raised the stakes of a *silent* reranker failure: the broken GGUF returned HTTP 200 + valid JSON + finite positive ~1e-11 scores — passing every liveness check — yet contributed nothing at weight 0.9 and silently collapsed the final ranking to RRF. `blendRerank`'s usability check was `score > 0`, which those ~1e-11 scores passed, and `clawmem doctor` had no reranker probe at all. This release makes that failure mode impossible to miss.

What changed:

- **`blendRerank` degenerate-floor trip + visible fallback** (`src/search-utils.ts`): the usability check widened from `> 0` to `> RERANK_DEGENERATE_FLOOR` (1e-4) — above the broken regime's 8e-7 ceiling, far below the weakest working score (~0.1) — so a near-zero collapse now routes to the RRF fallback instead of blending in ~nothing. The 3rd arg accepts an options object `{ rerankWeight, degenerateFloor, onFallback }` (numeric back-compat preserved); the `query` caller (`src/mcp.ts`) passes an `onFallback` that emits a rate-limited (≤1/min) stderr warning + running count, so the previously-silent degrade is surfaced.
- **`clawmem doctor` section 9 — reranker discrimination** (`src/clawmem.ts`): an active probe that asserts the reranker *discriminates*, not just responds. Runs a shipped golden set of same-topic (query, relevant, hard-negative) pairs (`src/health/rerank-golden.json`) through the live reranker, cache-bypassed, and checks coverage + a calibration band + a per-pair discrimination margin.
- **`clawmem rerank-health` command + scheduled unit** (`src/clawmem.ts`; `CLAUDE.md`/`AGENTS.md`): the same probe as a standalone command that exits non-zero on degeneracy, for a systemd `OnFailure=` alert (`clawmem-rerank-health.{service,timer}`, documented) — proactive detection of an endpoint reverted to the broken GGUF, independent of query traffic.
- **`store.rerank` probe seam** (`src/store.ts`): an additive `{ noCache, requireLiveCoverage, signal, timeoutMs }` options param. `noCache` bypasses the rerank cache (so a probe always exercises the live endpoint); `signal`/`timeoutMs` bounds the remote fetch; `requireLiveCoverage` enforces the full coverage contract — exactly `batch.length` results, unique in-range integer indices, finite numeric scores, a valid JSON object body — **before** the score-apply zero-fill (after which an omitted score and a true 0 are indistinguishable), throwing `RerankCoverageError` / `RerankMalformedResponseError`. A defensive skip in the apply loop also hardens the production path against an out-of-range index or non-array body (previously a latent crash).

### Verification

Thresholds were calibrated from a live `zerank-2-seq` baseline (8-pair golden set): relevant scores 0.92–0.97, hard-negative ≤ 0.31, minimum margin 0.64, 0/8 inverted — vs the broken GGUF regime's max-ever 8.03e-7 (a 5–6 order-of-magnitude separation). Locked: `CALIB_FLOOR 0.05`, `DISCRIM_MARGIN 0.25` (2.5× below the live minimum margin), `RERANK_DEGENERATE_FLOOR 1e-4`. 24 new unit tests (`tests/unit/rerank-health.test.ts`) pin the load-bearing contracts: the degenerate-floor trip + `onFallback`, the options-object overload + 2-arg back-compat, coverage-before-zero-fill, the malformed-response contract (duplicate / out-of-range / wrong-count / non-numeric / invalid-JSON / null-body), the defensive non-probe skip, and the calibration-band-passes-but-margin-fails (constant-output) case. Full suite: 1363 pass / 1 pre-existing unrelated failure; `tsc --noEmit` clean. Reviewed across the design and the implementation by an independent cross-model adversarial pass (codex / GPT-5.5-high) to zero remaining findings.

### What didn't change

- **The healthy hot path is untouched.** A working reranker scores ≫ 1e-4, so `blendRerank` behaves exactly as in v0.12.0; the degenerate floor only changes behavior when the reranker has already collapsed (where the old code silently produced RRF order anyway — now it is explicit and surfaced). `store.rerank`'s no-options path (the `query`, `intent_search`, and context-surfacing callers) is byte-identical to before.
- No schema migration, no config/env-var change, no breaking API change — the `store.rerank` options param and the `blendRerank` options object are additive, and the new CLI command, `doctor` section, golden set, and systemd recipe are all additive. The default reranker stays qwen3-reranker-0.6B.

## v0.13.0 — Query composite re-weight: search 0.70 for the `query` tool (the deferred lever from v0.12.0)

v0.12.0 fixed the rerank blend but flagged a larger deferred lever: composite scoring's default `{search:0.50, recency:0.25, confidence:0.25}` puts half the weight on non-search signals, which caps how much the improved blend reaches the surfaced top-k. v0.12.0 deferred acting on it "pending a judged-relevance / recency-aware eval." This release runs that eval and acts on it — scoped to the `query` tool only.

What changed:

- **The `query` tool now scores with `QUERY_WEIGHTS = {search:0.70, recency:0.15, confidence:0.15}`** (`src/memory.ts`), replacing the 0.50/0.25/0.25 default for non-recency `query` calls. Implemented via an additive `{ weights, now, forceWeights }` options seam on `applyCompositeScoring`; the `query` call passes `{ weights: QUERY_WEIGHTS }` **without** `forceWeights`, so a recency-phrased query still switches to `RECENCY_WEIGHTS` (0.10/0.70/0.20) by construction. Scoped to the `query` tool — `search`, `vsearch`, `memory_retrieve`'s routed modes, `intent_search`, and the context-surfacing hook keep the 0.50/0.25/0.25 default (their pipelines weren't part of this eval).

### Verification

A held-out, judged-relevance eval — the recency-aware eval v0.12.0 asked for. Real `query`-shaped prompts (held-out n=279 → 199 usable after oracle-drop) were graded 0–3 by an LLM judge (GLM-5.2) over the full ~30-doc candidate pool per query, blind / order-shuffled / freeze-time-framed. The judge was calibrated against an independent annotator (quadratic-weighted κ=0.681) plus an order-perturbation self-consistency check (κ=0.77). A dev pilot (n=84) picked the candidate weight; a **pre-registered decision rule** (locked before the held-out judging) then chose between 0.70 and 0.80. Result: graded NDCG@10 vs the 0.50 control — **w_search 0.70 +0.064 (paired permutation p<1e-4)**, 0.80 +0.104, robust across precision / exploratory / temporal families. A dedicated **freshness guard** (does raising search weight demote the newest-correct version of an evolving doc?) was the tiebreaker: at 0.70 the newest-correct doc is never demoted (mean rank improves); at 0.80 it falls out of the top-10 in 2/19 supersession cases. So **0.70 captures the bulk of the gain with zero freshness regression**, while 0.80's extra NDCG came at a freshness cost in a work-memory vault full of evolving docs. Pinned- and revision-rank-stability guards are non-regressive at 0.70. Reviewed across design, dev results, hardening, and implementation by an independent cross-model adversarial pass (codex / GPT-5.5-high) to zero remaining findings.

### What didn't change

- **`RECENCY_WEIGHTS` and the recency-intent switch** — a recency-phrased query ("latest", "recent", "last session", …) is scored exactly as before. The freshness guarantee the eval relied on holds by construction (`forceWeights` is never set).
- `search`, `vsearch`, `memory_retrieve` routed modes, `intent_search`, and the context-surfacing hook — all keep the 0.50/0.25/0.25 default. The seam's no-options path is byte-identical to prior behavior.
- No schema migration, no config/env-var change, no API-shape change. **`query` result ordering shifts**, and the **composite-score distribution** shifts upward for search-dominated hits — threshold consumers of the returned `compositeScore` (e.g. `minScore`) may see changed inclusion near the boundary. Scores remain `[0,1]`-scaled.

## v0.12.0 — Query reranking: blend the cross-encoder as the dominant signal (fixes the immovable RRF #1)

The `query` tool fused the cross-encoder reranker into the final ranking with a position-aware blend — `rrfWeight·(1/rrfRank) + (1-rrfWeight)·rerankScore`, with `rrfWeight` 0.75 / 0.60 / 0.40 by RRF rank. Because reranker scores are in `[0,1]`, RRF rank-1's floor (`0.75·(1/1)` = 0.750) exceeds RRF rank-2's ceiling (`0.75·(1/2) + 0.25·1` = 0.625): **RRF #1 was mathematically immovable by the reranker.** A strong reranker could reorder the tail but could never promote the best document to the top. With the now-faithful zerank-2 seq-cls reranker (v0.11.3), that ceiling was discarding the reranker's single largest win.

What changed:

- **New `blendRerank` blend** (`src/search-utils.ts`): `0.1·normalizedRRF + 0.9·rerank`. The cross-encoder is the dominant relevance signal; normalized RRF is a thin tiebreaker — so a strong rerank score *can* promote a document over RRF #1. It maps over the candidate set (so partial rerank coverage can never drop a candidate) and **falls back to pure RRF order** when the reranker is unavailable or returns no usable signal (empty / all-zero — e.g. a total remote+local failure, now also caught by a try/catch around the rerank call). Scoped to the `query` tool; `intent_search` is unchanged (its blend uses actual upstream scores, a different shape, measured separately).

### Verification

Harness-validated against known-item recall over two eval sets (NL n=45, KW n=50) on a frozen 3,743-doc snapshot with the live reranker, faithfully replicating the production query path (the harness's pre-rerank ranking reproduces the prior pipeline's exactly). At the blend stage the reranker lifts recall@1 from 0.22 (RRF alone) to 0.62 — and the old blend discarded all of it (blend@1 equalled RRF@1 to three decimals). The shipped 0.1/0.9 blend improves final recall@1–5 and MRR@10 on both eval sets with no material pooled recall@10 regression (NL @10 +0.044, KW @10 −0.04, pooled tie). New unit tests (`tests/unit/search-utils.blend.test.ts`) pin the two load-bearing contracts: a strong rerank score promotes above RRF #1, and empty/all-zero rerank preserves RRF order. Reviewed across design, results, and implementation by an independent cross-model adversarial pass (codex / GPT-5.5-high) to zero remaining findings.

### What didn't change

- `intent_search`, `search`, `vsearch`, the context-surfacing hook's deep-profile rerank blend, composite scoring, and MMR are unchanged — only the `query` tool's rerank/RRF blend. No schema migration, no config/env-var change, no API-shape change (result ordering for `query` shifts; scores remain `[0,1]`-scaled as before).
- A separate, larger lever surfaced by this work — composite scoring's 50% non-search weighting, which caps how much the improved blend reaches the surfaced top-k — is **deferred** to a future release pending a judged-relevance / recency-aware eval (known-item recall alone can't adjudicate it). MMR was measured to be a near-no-op here and is left untouched.

## v0.11.3 — Reranker: deprecate the broken zerank-2 GGUF; ship the zerank-2 seq-cls sidecar (SOTA, non-commercial)

The "SOTA upgrade" reranker — `zerank-2-Q4_K_M.gguf` served under `llama-server --reranking` — was silently broken. This release deprecates it across the docs and ships a working replacement as an opt-in recipe.

Root cause: zerank-2 is a `Qwen3ForCausalLM` that scores a (query, document) pair on the logit of a single relevance token ("Yes", id 9454) via a sentence-transformers `LogitScore` head. llama.cpp's `convert_hf_to_gguf.py` only synthesizes a rerank head when the model card contains the literal string `# Qwen3-Reranker`; zerank-2's card lacks it, so the previously-recommended GGUF — and any built by the current/standard llama.cpp converter — is a **headless causal LM**. Served with `--reranking` it returns near-zero, uninformative scores → reranking degrades to an inert RRF-dominated passthrough, with no error.

What changed:

- **New opt-in recipe** at `extras/rerankers/zerank-2-seq/` — converts `zeroentropy/zerank-2-reranker` to a `Qwen3ForSequenceClassification` (`num_labels=1`) whose score head is the tied-embedding row 9454, so the relevance logit is **identical by construction** to the native causal score. Served as a small transformers sidecar (`/v1/rerank`, `batch=1`, applies zerank's chat template, returns `sigmoid(logit/5)`) behind the existing `CLAWMEM_RERANK_URL` contract — drop-in, no ClawMem code change.
- **Reproducible correctness gate** (`build_and_verify.py`) — the convert step refuses to finish unless it proves: fp32 score-head weight-equality (bf16 preserved, no fp16 downcast); served-tokenizer == source-tokenizer (including the truncation path); the assistant-generation prefix survives near-`MAXLEN` inputs; and the seq-cls logit equals the causal token-9454 logit bit-exactly over the real served path (including batched right-padded pooling and empty/whitespace-doc edges).
- **Docs corrected** — `README.md`, `CLAUDE.md`/`AGENTS.md`, `SKILL.md`, `docs/quickstart.md`, `docs/introduction.md`, and `docs/guides/cloud-embedding.md` now point the SOTA reranker at the sidecar and explain the GGUF deprecation; `docs/guides/upgrading.md` gains a migration section. Full-SOTA-stack VRAM guidance moves 12GB → 16GB (the bf16 reranker is ~9GB).

### Verification

The conversion's correctness is enforced by `build_and_verify.py`, which the convert step runs before serving and which exits non-zero unless every gate passes: fp32 score-head weight-equality (bf16 preserved, no fp16 downcast); served-tokenizer == source-tokenizer identity (including the truncation path); assistant-prefix preservation under near-`MAXLEN` inputs; and seq-cls-vs-causal token-9454 logit equivalence over the real served path (batched right-padded pooling + empty/whitespace-doc edges). Verified live after deploy: relevant vs. irrelevant scores 0.96 / 0.08, matching the gate.

### What didn't change

- **zembed-1** (SOTA embedding) and **qwen3-reranker-0.6B** (default reranker) are unchanged — only the zerank-2 *reranker GGUF* is deprecated.
- No `src/` change, no schema migration, no config/env-var change, no public API change. ClawMem's default reranker stays the permissively-licensed qwen3-reranker-0.6B; the sidecar is an opt-in upgrade. zerank-2 weights are **CC-BY-NC-4.0** (non-commercial) and are never bundled — the recipe downloads them for your own use.

## v0.11.2 — Packaging: `bin` path so `npm install -g` registers the `clawmem` command on npm 11

v0.11.2 is a packaging-only fix. The `bin` map declared `"clawmem": "./bin/clawmem"`; npm 11's publish path rejects the `./`-prefixed form and **drops the bin entry from the tarball** (older npm silently rewrote it — the live v0.11.0 ships `bin/clawmem`), so a global install would land the files but expose no `clawmem` command. Changed to `"clawmem": "bin/clawmem"`, verified with `npm publish --dry-run` (no warning; the bin survives in the packed `package.json`).

No source change from v0.11.1. **v0.11.1 was git-tagged but never reached npm** (the publish that surfaced this packaging issue also failed on an expired npm token), so on npm v0.11.2 supersedes v0.11.0 directly and carries the full v0.11.1 query-expansion fix documented below.

## v0.11.1 — Query expansion: typed lex/vec/hyde routing + terse qmd prompt (fixes garbage / mis-routed expansions)

v0.11.1 fixes the LLM query-expansion stage, which had two compounding bugs that quietly degraded `query` / `intent_search` recall: the expansion model produced **garbage variants**, and the variants that were usable got **routed to the wrong search backend**.

Root cause — two layers:

- **Prompt was out-of-distribution for the finetune.** `expandQueryRemote` (`src/llm.ts`) sent a verbose prose instruction with no format constraint. The shipped expansion model (`qmd-query-expansion-1.7B`, a Qwen3-1.7B finetune) was trained on QMD's terse `/no_think Expand this search query: <q>` form. The mismatch produced bare question-stem "lex" terms ("What are the", "How do the"), literal template echoes, and `</think>` leakage — roughly a third of queries returned pure template noise.
- **Variant type was erased at the routing layer.** The expander emits typed `lex` (keyword), `vec` (semantic), and `hyde` (hypothetical-answer) variants, but every consumer dropped the type and searched **each variant on both backends** — so keyword expansions were vector-searched and hypothetical-answer passages were BM25-searched, each leg fed the input it handles worst. The CLI (`clawmem query`) was worse: it re-parsed already-stripped `lex:` / `vec:` prefixes, collapsing every variant into a single mis-typed list.

What changed:

- **Terse, in-distribution prompt.** `expandQueryRemote` now sends `/no_think Expand this search query: <q>` (plus the intent line when provided), matching the finetune's training form. Clean lex/vec/hyde verified end-to-end against the live server.
- **Typed `ExpandedQuery` contract end-to-end.** `store.expandQuery` returns `{ type, query }[]` instead of erasing the type, and every consumer routes by it: `lex → BM25`, `vec` / `hyde → vector`, original query → both backends (the only leg that fans out to both, keeping its 2× RRF anchor). Fixes the MCP `query` tool (`src/mcp.ts`), the CLI (`src/clawmem.ts`), and the deep-escalation path in `context-surfacing` (`src/hooks/context-surfacing.ts`). The MCP tool now also counts the original query's actual contributed list count for the 2× positional weight, fixing a latent mis-weight when the original's BM25 or vector leg came back empty.
- **Shared sanitize guards.** A single `sanitizeExpandedQueries` (`src/llm.ts`) runs in both the remote parser and the store wrapper: strips stray control tokens (`/no_think`, `/think`, word-boundary-safe), rejects template-residue / `<think>` / empty lines, dedups, and echo-filters variants equal to the original. A typed `expansionFallback` covers expansion failure or all-junk output, and `isFallbackExpansion` detects a leaked llm-level fallback so the store returns expansions-only and does not cache it.
- **Versioned expansion cache.** Cache key bumped to `expandQuery:v3-qmd-terse-typed` with a provider fingerprint and typed-JSON value; the old newline-delimited cache ages out via LRU (no manual purge). A malformed v3 entry is rejected and re-expanded instead of partially accepted.

### Verification

`tsc` clean on the touched files; full unit suite green (187 pass). Live end-to-end against the running expansion server: typed shape, zero echo, zero template-junk, correct per-type routing, cache round-trip. Validated under a fresh GPT-5.5 high-reasoning adversarial review via `codex exec` (a separate impl-review session from the design session): Turn 1 surfaced three real findings — a leaked llm-level fallback being cached, partial acceptance of a malformed typed-cache entry, and CLI expansion-only candidates dropped after RRF — each fixed and re-verified to verbatim "zero remaining findings."

### What didn't change

- Composite scoring, MMR diversity, cross-encoder reranking, RRF fusion weights, vault format, hook set, and the agent tool surface are unchanged.
- No schema migration, no config or env-var change, no public API change; the expansion model and the three inference services are the same. **One behavior change:** query expansion now routes each variant to a single backend by type instead of searching every variant on both — recall improves on the same vault the moment you upgrade. Pure `bun add -g clawmem` upgrade.

Docs `docs/internals/query-pipeline.md`, `AGENTS.md`, and `CLAUDE.md` updated to describe typed routing (`AGENTS.md` / `CLAUDE.md` also carry a pending correction: MPFP meta-path fusion is max-score, not RRF).

## v0.11.0 — Embedding dimension-migration safety + lease-fenced, atomic vector writes

v0.11.0 hardens the embedding write path against a class of **silent vector loss** surfaced by a real incident: a re-embed reported success, but pure-vector retrieval (`vsearch` / `find_similar`) returned nothing for the affected docs. Root-cause analysis found two layers — a model-serving quality issue (operator-side; see Troubleshooting → "weak or irrelevant results") and, in ClawMem itself, an **unsafe dimension migration**: when the embedding model's output dimension changed, `ensureVecTable` dropped the `vectors_vec` table while the metadata-based worklist (`getHashesNeedingFragments`) skipped the now-vectorless documents (their `content_vectors` rows still existed). The result was a vault whose vectors were silently wiped while `embed` reported "all done."

What changed in the embedding write path:

- **`ensureVecTable` never drops an existing table.** A dimension/schema mismatch now throws a fatal `VecDimensionMismatchError` and aborts the run instead of dropping. The only path that clears vectors is the explicit `clearAllEmbeddings`, reached only via `embed --force`.
- **`embed` detects dimension AND model drift non-destructively.** An implicit (non-`--force`) run that sees a changed dimension — or a *different model at the same dimension*, which mixes a heterogeneous, similarity-meaningless vector space — aborts with instructions to run `--force`, never mutating. `embed --force` probes the endpoint **first** and aborts without clearing if it's unreachable, so a force rebuild against a dead server cannot wipe the vault. The whole run is bound to one `(dimension, model)`; every embedding is validated before it is stored.
- **All vector mutations are atomic and lease-fenced.** `insertEmbedding`, `clearAllEmbeddings`, `cleanStaleEmbeddings`, and table creation each run in a single immediate-write-lock transaction that verifies a renewable, token-fenced **embedding lease** (`worker_leases`, name `embedding`, heartbeat-renewed) before mutating — so two concurrent embeds, or a process that lost its lease mid-run, cannot interleave a clear with an insert or mix two models into one index. A second concurrent `embed` skips cleanly.
- **Crash-safe retry budget.** `embed_attempts` increments exactly once per attempt (at start), resets on a successful embed, and resets whenever a document's content changes (new hash) via a new `reset_embed_on_hash_change` trigger that covers *every* hash-changing path. A document can no longer be permanently excluded by stale failures from old content. Partial embeds are retried in full.
- **`doctor` now reports content_vectors ↔ vectors_vec consistency** (a set-difference check, including the worst case where `vectors_vec` is absent but metadata rows remain), and flags a vault that contains mixed embedding models.
- **`embed` exits non-zero** when a run aborts (dimension/model mismatch or lost lease), so the embed timer / `update --embed` can detect an incomplete run.

### Verification

Validated across a 9-turn GPT-5.5 high-reasoning adversarial review under `codex exec`: a diagnosis pass, four design passes (which overturned an initial "defer the concurrency lease" decision by demonstrating that two same-dimension models can silently build a heterogeneous index), and four code-review passes that drove findings 6 → 4 → 3 → 2 → **0** ("vector-table mutations are now atomic, lease-fenced, and dimension/model consistent"). Ships with new unit tests covering throw-on-mismatch, `getVecTableDim` states, the lease fence on insert/clear, the hash-change trigger, attempt-budget resets, and `getVecModels` heterogeneity detection; full suite green except one pre-existing unrelated integration test.

### What didn't change

- Retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, and OpenClaw/Hermes plugin registration are unchanged.
- No public API change. **One behavior change:** `embed` now **aborts** on a dimension/model change instead of silently re-embedding into a dropped table — run `clawmem embed --force` to migrate. The only schema addition is the `reset_embed_on_hash_change` trigger, created automatically on store open (no manual migration).

## v0.10.7 — Hermes plugin: refresh session-derived state on `on_session_switch`

v0.10.7 implements the `MemoryProvider.on_session_switch` hook in the Hermes plugin (`src/hermes/__init__.py`). Hermes Agent (v2026.5.16) wired this lifecycle hook to fire on `/new` (reset=True), `/resume`, `/branch`, and context compression — any mid-process `session_id` rotation that does not tear the provider down. ClawMem previously did not override it (the ABC default is a no-op), so after a switch the plugin kept using the `session_id` it cached at `initialize()`: extraction and handoff metadata carried the stale id, and the session-keyed transcript file (`{session_id}.jsonl`) kept collecting the new session's turns under the old name.

The override repoints the cached `_session_id`, rebuilds `_transcript_path` for the new session, and **unconditionally** invalidates the prior session's prefetch + bootstrap caches so a recall queued under the old session cannot surface in the new one. To stay race-free with the background prefetch worker, `queue_prefetch` now snapshots the session id and transcript path under the prefetch lock at queue time (the worker uses the snapshot, never live state), and the switch bumps the prefetch generation monotonically so an in-flight worker discards its result instead of writing it into the new session. Retrieval is unaffected — the vault is path-keyed, not session-keyed — so this is metadata/transcript correctness, not a recall change.

### Verification

Validated across three turns of GPT-5.5 high-reasoning adversarial review under `codex exec`. Turn 1 (design) returned no-ship-as-written and caught two real bugs in the initial design — a reset-gated prefetch leak (stale recall crossing into `/resume` and `/branch` sessions) and an ABA race from resetting the prefetch generation to zero — and prescribed the snapshot-at-queue-time fix. Turn 2 verified the implemented design against a standalone behavioral test covering the switch / reset / compression / prefetch-race paths → verbatim "zero remaining design findings — can ship." Turn 3 re-cleared a final added assertion.

### What didn't change

- Retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, OpenClaw plugin registration, and the Claude Code hook path are all unchanged from v0.10.6.
- No reindex, no schema migration, no public API change, no config or env-var change. Pure `bun add -g clawmem` upgrade.

## v0.10.6 — FTS keyword-search tokenization: split separators instead of stripping them

v0.10.6 fixes an internally-found bug in the BM25 keyword-search path: the query builder silently returned **zero rows for any compound / path / snake_case / dotted / hyphenated query** — exactly the config-name, hook-name, filename, and identifier searches the system is meant to serve.

`src/store.ts:sanitizeFTS5Term()` removed every non-alphanumeric character from each whitespace token, which **concatenated** separator-delimited word-parts into a token that was never indexed. The FTS index (`documents_fts`, `tokenize='porter unicode61'`) does the opposite — it **splits** stored text on `_ - . / '` and all punctuation. So query and index tokenization disagreed:

- `before_compaction` → `beforecompaction` → `MATCH "beforecompaction"*` → **0 rows** (the index holds `before` and `compaction` as separate tokens)
- `src/store.ts` → `srcstorets` → **0 rows**; `q4_k_m`/`v0.8.2` → `q4km`/`v082` → **0 rows**

Vector recall partially masked this in the hybrid `query` path, but pure `search` (BM25-only) and the raw file-path supplemental lookup in `context-surfacing` returned nothing. CLAUDE.md, AGENTS.md, and SKILL.md already documented "code identifiers work" — this release makes the implementation match that promise.

Vault on disk is unchanged. **No reindex required** — a query-build change only, so it fixes every existing vault the moment you upgrade. No schema migration, no env-var change, no public API change. Pure `bun add -g clawmem` upgrade.

### The fix — split, don't strip

`sanitizeFTS5Term` is replaced by `tokenizeForFTS5`, which splits on the same boundaries the index tokenizer uses:

```ts
export function tokenizeForFTS5(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 0);
}
```

`buildFTS5Query` keeps the existing AND-of-prefixes semantics (`"before"* AND "compaction"*`). One-character tokens are kept (needed for `q4_k_m`, `v0.8.2`, `a/b`); AND makes them a precision constraint, not noise. The split regex consumes every FTS5 syntax character, so each surviving token is alphanumeric and quoted — at least as injection-safe as the prior strip approach.

### Entity FTS — exact-first candidate gathering

The same `tokenizeForFTS5` is shared with the two `entities_fts` MATCH builders (`src/entity.ts`). Adversarial review surfaced that a naïve prefix query there starves short exact names: `entities_fts` applies its `LIMIT` **before** the Levenshtein / mention-count ranking, so a broad prefix (`"go"*` matching 30 `Golang*` rows, or `"c"*` for `C++`) fills the candidate pool and drops the exact row before it can be ranked. `resolveEntityCanonical` and `searchEntities` now gather **exact-token matches first**, then top up with deduped prefix matches only while under the limit (`gatherEntityFTSCandidates`). The exact row is always present for ranking; multi-char prefix recall (`clawme`* → `clawmem`) is preserved as a supplement.

### Verification

Validated across four turns of GPT-5.5 high-reasoning adversarial review under `codex exec`. Turn 1 cleared the approach; Turn 2 confirmed the `documents_fts` fix correct + injection-safe but **caught the entity prefix-starvation regression**; Turn 3 rejected a 1-char-only band-aid (the same starvation hit short multi-char names like `Go`); Turn 4 cleared the exact-first fix verbatim "**zero remaining findings**" after re-running the repros (`C++` resolves, `Go` resolves, `clawme`→`ClawMem` recall holds).

Test coverage: 8 new bug-first tests in `tests/integration/store-search.test.ts` (compound, non-adjacent AND, slash-path via the filepath column, 1-char tokens, apostrophe behavior-lock, FTS5-specials no-throw, punctuation-only → empty) + 4 entity starvation regression tests in `tests/unit/entity.test.ts` (`C++` and `Go`, each across `resolveEntityCanonical` and `searchEntities`). Five of the store tests fail on the pre-fix code; all pass after. Full suite: 1298 pass / 0 fail. `tsc --noEmit` clean for the changed files.

### What didn't change

- Retrieval pipeline shape, composite scoring, vault format, hook set, agent tool surface, OpenClaw plugin registration (`kind: memory`), and the Hermes plugin contract are all unchanged from v0.10.5.
- No reindex, no schema migration, no public API change, no config or env-var change.
- The `store ⇄ entity` import added for the shared tokenizer is runtime-safe (hoisted `function` declaration, called only at runtime).

### Cross-references

- Codex review: 4 turns (T2 caught the entity regression, T4 zero remaining findings)
- Primary surfaces: `src/store.ts` (`tokenizeForFTS5`, `buildFTS5Query`), `src/entity.ts` (`gatherEntityFTSCandidates`, both `entities_fts` sites)

---

## v0.10.5 — Issue #13: SQLite PRAGMA ordering race fix + openclaw doc-comment line-ref bump

v0.10.5 fixes [yoloshii/ClawMem#13](https://github.com/yoloshii/ClawMem/issues/13). One bug reported by @jcgau (first-time contributor):

`src/store.ts:initializeDatabase()` set `PRAGMA busy_timeout = 15000` AFTER `PRAGMA journal_mode = WAL`. Because `busy_timeout` is a connection-level setting that only governs *subsequent* statements (default busy callback is NULL → `SQLITE_BUSY` returns immediately), the busy handler was not active when the first contending statement ran. When concurrent Stop-hook subprocesses (`decision-extractor`, `handoff-generator`, `feedback-loop`) opened the same SQLite file in parallel — both from OpenClaw's `agent_end` plugin-hook fan-out (`src/openclaw/engine.ts:449`) and from `before_reset` (`src/openclaw/engine.ts:576`), plus the Hermes `MemoryProvider.on_session_end` thread fan-out (`src/hermes/__init__.py:518`) — the first subprocess to acquire the journal-mode write lock succeeded and the rest returned `SQLITE_BUSY` immediately. Under the reporter's typical load (~48 heartbeat turns/day in their OpenClaw setup), two of three hooks failed per turn, silently dropping decision-extraction / handoff-generation / feedback-loop work for the losing subprocesses.

Vault on disk is byte-identical to v0.10.4. No schema migration. No env-var change. No public API change. Pure `bun add -g clawmem` upgrade.

### The fix — one-line ordering swap, applied to two sites

`src/store.ts:initializeDatabase()` (writable init path) and `src/store.ts:createStore()` readonly branch both now set `busy_timeout` as the **first** statement on the connection, before `sqliteVec.load()`, `PRAGMA journal_mode = WAL`, and any DDL. The writable path uses 15000ms during DDL (well within the 30s Stop hook timeout); the terminal `createStore()` statement resets to operational 5000ms (or `opts.busyTimeout`) after DDL completes. The readonly branch is also hardened against the same race — public-API hardening, since no in-tree production caller currently passes `readonly: true`, but the ordering invariant should hold regardless.

The docstring in `initializeDatabase()` carries the rationale durably so a future refactor can't quietly re-introduce the race:

> "busy_timeout is a connection-level setting that only governs *subsequent* statements (default busy handler is NULL → SQLITE_BUSY returns immediately), so it must precede the contending PRAGMAs. 15s is well within the 30s Stop hook timeout. createStore() resets to operational value (5000ms or opts.busyTimeout) after DDL completes."

### Verification

The change set was validated against two turns of GPT-5.5 high-reasoning adversarial code review (cumulative ~401K tokens) under `codex exec`. Turn 1 verdict was APPROVED WITH MODIFICATIONS — zero High, one Medium (soften the readonly-branch comment from "takes a brief write lock" to "can contend when switching/initializing WAL state"), one Low (mention BOTH `agent_end` AND `before_reset` parallel Stop-hook fan-outs). Both modifications applied. Turn 2 cleared verbatim "**Zero remaining findings on the Issue #13 fix. Ship as is. Ready to tag v0.10.5.**" Turn 2 also independently verified the skill-forge mirror byte-identical via `cmp -s` on all four changed files.

Test coverage: 3 new tests in `tests/integration/store-concurrent-init.test.ts` (NEW) + supporting `tests/helpers/concurrent-init-worker.ts` (NEW). Two source-text assertion gates (deterministic — catch the exact regression an accidental re-swap would introduce, anchored on the function body for `initializeDatabase` and on the `// Readonly:` comment marker for the readonly branch) plus one subprocess concurrent-init test (spawns 3 `bun run` worker processes against the same on-disk DB in `mkdtempSync(tmpdir())`, 60s timeout, asserts all 3 exit 0 without `SQLITE_BUSY` or "database is locked" in stderr).

The subprocess test mirrors the actual production scenario more faithfully than an in-process `Promise.all` could — `bun:sqlite` `db.exec` is synchronous, so in-process "concurrent" calls serialize on the JS event loop and do not contend on the SQLite file lock. `:memory:` stores have no file-system lock at all and cannot reproduce this bug — that's why the pre-existing `tests/integration/store.test.ts` (which uses `:memory:` exclusively) missed the regression.

Local run: `bun test tests/integration/store-concurrent-init.test.ts` reports 3 pass / 0 fail (18 expect() calls, 3.01s). `bun test tests/integration/store.test.ts` reports 33 pass / 0 fail (57 expect() calls, 496ms). No regressions.

### Companion housekeeping — `src/openclaw/index.ts` doc-comment line-ref bump

Bundled with the v0.10.5 ship is a doc-only update to `src/openclaw/index.ts` carrying line-ref drift from the OpenClaw upstream-delta survey run on 2026-05-14 (`upstream-delta-survey` skill, main HEAD `5bb23c2f95` → `25eef1203a`, 7091 commits in that window, non-breaking for ClawMem v0.10.x). Four doc-comment occurrences updated:

- `attempt.ts:2610` → `attempt.ts:2973` — `before_prompt_build` await site (twice: backtick docstring at `:41`, inline comment at `:164`)
- `attempt.ts:3379-3402` → `attempt.ts:3870-3892` — `agent_end` fire-and-forget block (twice: backtick docstring at `:40`, inline comment at `:178`)

No runtime change. Standing "doc-line-refs ride the next release" pattern from prior cycles.

### What didn't change

- Retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, OpenClaw plugin registration shape (`kind: memory`), and Hermes plugin contract are all unchanged from v0.10.4.
- §14.3 contextEngine→memory migration block in `CLAUDE.md` / `AGENTS.md` preserved verbatim.
- No public API change; no config change; no env-var change; no schema migration.
- The terminal `PRAGMA busy_timeout = ${opts?.busyTimeout ?? 5000}` at the bottom of `createStore()` is preserved — for the writable branch it resets 15000 → 5000 after DDL; for the readonly branch it's a no-op rewrite to the same value (harmless, intentional simplicity).

### Cross-references

- Issue: https://github.com/yoloshii/ClawMem/issues/13 (@jcgau, first-time contributor)
- Codex review: Turn 1 APPROVED WITH MODIFICATIONS, Turn 2 zero remaining findings
- Parallel Stop-hook fan-out sites covered by this fix: `src/openclaw/engine.ts:449` (`handleAgentEnd`), `src/openclaw/engine.ts:576` (`handleBeforeReset`), `src/hermes/__init__.py:518` (Python thread fan-out)
- Companion 2026-05-14 OpenClaw upstream-survey driving the doc-comment line-ref bump: a local memory note (`memory/openclaw-v2026.4.x-analysis.md`)

---

## v0.10.4 — Profile-aware `setup openclaw` + `--help` short-circuit (issue #11)

v0.10.4 fixes [yoloshii/ClawMem#11](https://github.com/yoloshii/ClawMem/issues/11). Two bugs reported by @elquercarlos:

1. **`clawmem setup openclaw` ignored `OPENCLAW_STATE_DIR` and OpenClaw's `--profile` flag.** Pre-v0.10.4 hardcoded `~/.openclaw/extensions/clawmem` and never consulted env vars or OpenClaw's own destination-resolution logic. Users running OpenClaw with a non-default profile (e.g. `~/.openclaw-dev`) got the plugin installed in the wrong directory, where their active profile couldn't see it.
2. **`clawmem setup openclaw --help` ran setup instead of printing help.** The handler had no argv short-circuit for `--help` / `-h`.

Both bugs close on this release. Vault on disk is byte-identical to v0.10.3. No schema changes, no env-var changes for default-profile users, no retrieval-pipeline or hook changes. Pure `bun update -g clawmem` upgrade.

### `cmdSetupOpenClaw` — three-path install (§28.1)

The setup command now picks one of three paths at runtime:

- **Delegated copy mode (default, OpenClaw CLI on `PATH`).** Spawns `openclaw plugins install <pluginDir> --force`. OpenClaw owns destination resolution (which respects `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and the `--profile` flag), runs manifest validation + security scans, persists install records, applies slot selection, and refreshes the registry. The plugin is **auto-enabled** by the install — the post-install "Next steps" output no longer prints `openclaw plugins enable clawmem`. `--force` makes the install idempotent across re-runs (OpenClaw's default install mode rejects existing targets).
- **Delegated link mode (`--link` flag, OpenClaw CLI on `PATH`).** Spawns `openclaw plugins install <pluginDir> -l`, which records the source in `plugins.load.paths` — a load-path entry, **not a filesystem symlink**. Discovery uses the recorded load-path entry directly, so the v2026.4.11 symlink-discovery skip does NOT apply here. ClawMem does manual stale-install cleanup before delegating because OpenClaw rejects `--force` with `--link`.
- **Direct-copy fallback (CLI absent).** Falls back to recursive `cpSync` (or filesystem symlink with `--link`) at a destination resolved by a faithful mirror of OpenClaw's `resolveConfigDir`: `OPENCLAW_STATE_DIR` → `OPENCLAW_CONFIG_PATH` (config root = `dirname(file)`) → `OPENCLAW_HOME`/`HOME`/`USERPROFILE`/`os.homedir()`/`cwd` → `~/.openclaw`. The user gets a warning surfacing reduced capability (no manifest validation, no security scan, no install records). Filesystem symlink in the fallback's `--link` path is still subject to OpenClaw v2026.4.11+'s discovery skip — install OpenClaw to get the cleaner delegated behavior.

The faithful-mirror resolver matches OpenClaw exactly, including the asymmetry where `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` apply only `.trim()` (so `OPENCLAW_STATE_DIR="undefined"` is a literal directory name) while home-resolution env vars filter the literal strings `"undefined"` / `"null"` (matching OpenClaw's `home-dir.ts:normalize`). Diverging here would mean the delegated path and the fallback path install into different locations for the same env, which is exactly the bug class §28.1 set out to fix.

### `--remove` — legacy-compatible uninstall

`clawmem setup openclaw --remove` now tries `openclaw plugins uninstall clawmem --force` first (when the CLI is available) and falls back to manual cleanup at the resolved extensions path. The fallback runs in two cases:

1. CLI uninstall fails (typically because the install was a legacy unmanaged direct-copy from pre-v0.10.4 ClawMem and isn't tracked in OpenClaw's plugin install records). On failure, ClawMem **warns the user** that OpenClaw config and install records may still need manual repair, then runs the manual cleanup. We do not silently mask managed-uninstall failures.
2. CLI uninstall succeeds (managed install). Even on success, ClawMem then checks the exact `extensions/clawmem` path and removes any remaining symlink or directory — a "constrained stale cleanup" that handles the side-by-side case of a managed-link install plus a leftover unmanaged-copy directory from an earlier ClawMem version.

### `--help` / `-h` short-circuit (§28.2)

`cmdSetupOpenClaw` short-circuits `--help` / `-h` at the top of the handler before any spawn or filesystem work and prints the full flag + env-var reference. Documents: `--link` (with separate behavior in delegated load-path mode vs filesystem-symlink fallback), `--remove`, env vars consulted (`OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_HOME`, `HOME`, `USERPROFILE`), and example invocations including the headline `OPENCLAW_STATE_DIR=~/.openclaw-dev clawmem setup openclaw`.

### Verification

The change set was validated against four turns of GPT-5.5 high-reasoning adversarial code review (cumulative ~292K tokens) under `codex exec`. All findings — three HIGH (delegated-install auto-enable messaging, idempotence-via-`--force`, legacy-compatible `--remove`), two MEDIUM (resolver fidelity, real-stub-binary integration tests), two LOW (assertion tightening, main `--help` line) — were addressed before final clearance. The Turn 4 verdict was an explicit "zero remaining concerns, ready to ship v0.10.4."

Test coverage: 8 unit tests (`tests/unit/openclaw-paths.test.ts`) on the resolver helpers, including precedence (`OPENCLAW_STATE_DIR` over `OPENCLAW_CONFIG_PATH`), tilde expansion, `OPENCLAW_HOME` priority, `os.homedir()` failure → cwd fallback, and the asymmetric `"undefined"` / `"null"` literal handling that mirrors OpenClaw exactly. 6 integration tests (`tests/integration/setup-openclaw.integration.test.ts`) exercise the real subprocess boundary via a per-command shell stub on a sandboxed `PATH`: copy mode passes `--force` and not `-l`; link mode passes `-l` and not `--force`; install failure aborts (no silent fallback to direct copy); `--remove` with a managed install runs CLI uninstall AND constrained stale cleanup; `--remove` with a legacy install falls back to manual cleanup with the user-visible warning; CLI absent honors `OPENCLAW_STATE_DIR` in direct-copy mode. Two further integration tests prove the dual next-steps messaging differs between paths and that `--help` short-circuits before the `openclaw --version` probe.

### What didn't change

- Retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, OpenClaw plugin registration shape (`kind: memory`), and Hermes plugin contract are all unchanged.
- The §14.3 contextEngine→memory upgrade migration block is preserved verbatim.
- Plugin source files (`src/openclaw/`) are unchanged. The change is entirely in `cmdSetupOpenClaw` and a new `src/openclaw-paths.ts` helper module.
- Existing regression-gate tests in `tests/unit/openclaw-plugin.test.ts` (84 source-text assertions) all still pass — the Path 3 fallback branch preserves the original next-steps output verbatim.

### Cross-references

- Issue: https://github.com/yoloshii/ClawMem/issues/11 (@elquercarlos)
- BACKLOG: `BACKLOG.md` Source 28 — full scope including the codex-validated implementation plan
- OpenClaw delegation surfaces: `openclaw/src/cli/plugins-install-command.ts:669` (linked-path branch), `openclaw/src/cli/plugins-install-persist.ts:182` (auto-enable + slot selection), `openclaw/src/utils.ts:119` (`resolveConfigDir`)
- Helper module: `src/openclaw-paths.ts` (mirrors OpenClaw's path-resolution semantics for the fallback path)

---

## v0.10.3 — A-MEM parser hardening for noisy llama-server output (PR #7) + batched doc maintenance

v0.10.3 is a small patch release. The retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, OpenClaw plugin registration shape, and Hermes plugin contract are all unchanged from v0.10.2. The release hardens the A-MEM JSON parser against a class of noisy llama-server outputs that v0.10.2 mishandled (parser silently picked an example/schema literal over the real payload, link-generation batches got zeroed when the LLM under-delivered), and bundles four sitting-in-tree doc updates that were waiting for the next release.

Vaults from v0.10.2 are byte-identical at rest. No schema migration. **Default behavior is byte-identical for users whose llama-server outputs were already parsing cleanly** — the parser only changes what it returns on inputs that previously fell through to repair paths or to zeroed link batches. Pure `bun add -g clawmem` upgrade.

### A-MEM parser hardening (PR #7 by @cymkd / Veljko Simakovic)

The pre-PR parser had two real-world failure modes when the llama-server LLM emitted prompt-shaped prose alongside the real payload:

1. **Prose-balanced literal won over the real payload.** When the model echoed phrases like `Return empty array [] if no structured facts found.` before the real fenced JSON answer, the parser locked onto the prose `[]` and returned it as the result. Conversation-synthesis runs that included the actual prompt wording in the assistant context exhibited this regularly. After the fix, the later real payload wins via a precedence order that walks all parseable balanced JSON candidates in source order, prefers payload-cued candidates (`Actual:`, `Result:`, `Final answer:`, `Answer:`), then avoids example-cued (`example`, `e.g.`, `schema`) and inline-prose literals, then falls back to the first candidate. `parseJsonCandidate` now searches forward for a later line-start `[`/`{` when the first balanced candidate sits behind an example cue or at a non-line-start position with no payload cue. `extractJsonFromLLM` tightens its precedence so that outside-of-fences JSON before a preferred `json` fence requires a payload cue rather than winning by virtue of position.
2. **Link-generation under-delivery zeroed the batch.** The pre-PR `generateMemoryLinks` enforced an all-or-nothing completeness gate: if the LLM returned 4 valid links for a 5-neighbor prompt, or repeated a `target_idx`, or referenced an out-of-range index, the entire batch was discarded and `0` links were created. After the fix, partial-valid insertion semantics are restored: a 5-neighbor prompt with 4 valid returned links inserts 4 rows. Duplicate `target_idx` entries are logged (`Skipping duplicate link target N`) and skipped after the first valid link for that neighbor. Out-of-range entries are logged (`Skipping out-of-range link target N`) and skipped instead of aborting already-valid links. The commit message includes the directive "Do not reintroduce all-or-nothing link generation without corpus measurements" to lock the contract.

Item-shape validation in `parseLinkGenerationFromLLM` (`src/amem.ts:55,99`) is unchanged and continues to reject malformed items strictly (missing fields, wrong types, non-finite confidence, bad relation type, non-positive/non-integer `target_idx`) before they reach the insert loop.

The PR went through three adversarial review rounds: Turn 1 surfaced 3 findings (1 HIGH on the prose-precedence behavior + 2 Medium on the under-delivery zeroing path and a sanitization edge), Turn 2 confirmed Findings 2-3 fixed and surfaced 1 HIGH on a regressed prose-fence ordering case + 1 MEDIUM on an un-flagged completeness gate that wasn't parser-level. Turn 3 verified both Turn 2 findings fixed (cymkd ran an independent GPT-5.5 high-reasoning pass before pushing the Turn 2 follow-up commit) and surfaced 2 LOW findings deferred to a future release (see below).

### Two known LOW limitations deferred to v0.10.4+

Both LOWs were surfaced by the Turn 3 GPT-5.5 high-reasoning review pass and are explicit-acceptance candidates per the contributor's own "intentionally broad for this repro; can be tightened later" framing:

1. **Outside-JSON-before-`json`-fence precedence change.** The new `outsidePrecedesPreferredJsonFence` gate causes raw line-start JSON before a non-example `json` fence to lose to the fence. Repro: `[{"key":"real"}]\n` followed by a `json` fence containing `[]` parses as `[]`. Real behavior change from "first raw JSON wins," but the affected pattern is narrow — well-formed raw payload immediately followed by a non-example `json` fence is uncommon in observed llama-server output, and the broader fix the gate enables (the prose-before-fence repro above) is the more frequent failure mode.
2. **`schema` cue breadth.** `hasExampleCueBefore` recognizes `schema` alongside `example` and `e.g.` to fix the reported `Schema: {...}\n[{...real...}]` repro, but the substring match is broad enough to suppress real fenced payloads following phrases like `Schema validation result:`. A tighter `schema:` / `json schema:` boundary regex would close the false-positive without losing the original repro coverage.

Both will be addressed in the next release with measurement-backed fixes — either tightening the heuristics with a corpus-measurement pass over real llama-server output, or accepting them with regression tests locking in the new contract. That decision belongs with the data, not this PR.

### Batched doc maintenance (rides this release per option-(a) standing direction)

Four user-facing doc updates that accumulated in the working tree across the v0.10.2 → v0.10.3 window, all from in-session OpenClaw delta surveys:

- **`src/openclaw/index.ts` line-ref drift** (cosmetic, no behavior change). OpenClaw advanced from v2026.4.21 to HEAD `1f724bc50b` (2026-05-04, post-v2026.4.26 untagged) across two consecutive surveys. `attempt.ts` was reorganized under `src/agents/pi-embedded-runner/run/` as part of a runner refactor; line refs in our doc-comment correctness contracts shifted twice: `before_prompt_build` await context `attempt.ts:1873` → `:2294` → `:2610`; `agent_end` fire-and-forget block `attempt.ts:2470-2496` → `:3023-3048` → `:3379-3402`. Both await/fire-and-forget contracts hold across both bumps; only line numbers shifted. 4 occurrences updated in the file header docstring and the `before_prompt_build` / `agent_end` handler comments.
- **`README.md`, `CLAUDE.md`, `AGENTS.md`, `SKILL.md` — 30s `agent_end` void-hook timeout disclosure.** OpenClaw v2026.4.26 (commit `4d4c7c8ab3`) introduced `DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK = { agent_end: 30_000 }` in `src/plugins/hooks.ts`. A timed-out handler is logged ("timed out after 30000ms") and the runner continues, but the plugin's underlying work is not cancelled. ClawMem's `agent_end` runs decision-extractor + handoff-generator + feedback-loop; warm-cache postrun is well under 30s, but cold-start indexing or LLM stalls could approach this. The disclosure is operational, not behavioral — it doesn't change what ClawMem does, only adds a log warning above the 30s threshold for users with cold-start scenarios that exceed it. Single-sentence insertion in each doc, adapted to surrounding tone, fail-open framing emphasized. CLAUDE.md and AGENTS.md remain byte-identical post-edit.

Per the option-(a) standing direction these doc updates do not justify a release on their own; they ride PR #7 which is the next real-functionality release.

### External credit

- **Veljko Simakovic / @cymkd** — opened yoloshii/ClawMem#7 with the four-commit progressive parser hardening (initial parse robustness, object-wrapped result handling, prose-vs-payload preservation, and the Turn 2 follow-up that fixed the regressed prose-fence ordering and removed the un-flagged completeness gate). The PR went through three adversarial review rounds (gpt-5.4 high reasoning Turns 1-2, gpt-5.5 high reasoning Turn 3); the contributor independently ran a gpt-5.5 high-reasoning pass on his own diff before pushing the Turn 2 follow-up, which surfaced and fixed several edge cases before they hit our review queue. Cross-validated against `tests/unit/amem.test.ts` + `tests/unit/conversation-synthesis.test.ts` + `tests/integration/conversation-synthesis-two-pass.integration.test.ts` (107 pass / 0 fail / 220 expect() calls, was 102 pre-PR; +5 new regression tests). Two Turn 3 LOW findings were explicitly deferred to the next release rather than chasing a fifth round, in line with cymkd's own forward-looking framing on the schema cue breadth.

### Test coverage

PR #7 adds five new regression tests in `tests/unit/amem.test.ts` covering: prose `[]` before a fenced real payload, the actual conversation-synthesis prompt wording echoed before a fenced payload, prose schema object before a later real raw array, `parseLinkGenerationFromLLM` parsing the later real link array instead of the schema object, and `generateMemoryLinks` inserting a valid partial batch while skipping duplicate/out-of-range targets.

Targeted suite: **107 pass / 0 fail / 220 expect() calls** across the three test files (was 102 pre-PR; +5 new tests).

---

## v0.10.2 — Configurable remote LLM endpoints + doc maintenance

v0.10.2 is a small patch release. The retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, and OpenClaw plugin registration shape are all unchanged from v0.10.0/v0.10.1. The release adds three opt-in env vars for users running ClawMem against OpenAI-compatible remote LLM proxies, fixes a `/v1` URL-doubling edge case in the remote LLM transport, and applies two small doc updates that were sitting in the working tree.

Vaults from v0.10.1 are byte-identical at rest. No schema migration. **Default behavior is byte-identical for users with no new env vars set** — same hard-coded `qwen3` model, same `/no_think` suffix, same request body field order, same `http://localhost:8089/v1/chat/completions` URL. Pure `git pull` upgrade.

### Configurable remote LLM endpoints (PR #8 by @DrJsPBs)

The remote LLM transport in `src/llm.ts` previously hard-coded `model: "qwen3"` and the `/no_think` prompt suffix in the `/v1/chat/completions` request body. That worked for the QMD native combo (qmd-query-expansion-1.7B on `:8089` via `llama-server`) but blocked anyone wanting to point ClawMem at an OpenAI-compatible proxy with a different model name or at a non-Qwen endpoint that treats `/no_think` as literal prompt text. v0.10.2 adds three opt-in env vars to make all three knobs user-configurable while preserving the existing defaults exactly:

| Env var | Default | Effect |
|---|---|---|
| `CLAWMEM_LLM_MODEL` | `qwen3` | Model name sent in the request body. Override for OpenAI-compatible proxies (e.g. `gpt-5.4-mini`). |
| `CLAWMEM_LLM_REASONING_EFFORT` | (unset, field omitted) | Optional top-level `reasoning_effort` field for Chat Completions endpoints that support it. Validated against the enum `none / minimal / low / medium / high / xhigh`; unsupported values log a warning and are ignored. Leave unset for llama-server / vLLM unless your serving stack explicitly accepts the field. |
| `CLAWMEM_LLM_NO_THINK` | `true` | Append `/no_think` to remote prompts. Set `false` for standard OpenAI models and other endpoints that reject or treat the Qwen-style suffix as literal prompt text. |

The settings are threaded through both plugin layers:

- **OpenClaw plugin** — `src/openclaw/openclaw.plugin.json` exposes `gpuLlmModel`, `gpuLlmReasoningEffort` (with the same enum constraint), and `gpuLlmNoThink` config keys. `src/openclaw/index.ts` maps each to the corresponding `CLAWMEM_LLM_*` env var only when the user explicitly set it (so unset config falls through to the runtime default rather than overriding it with an empty string).
- **Hermes plugin** — `src/hermes/__init__.py` adds the three keys to its `get_config_schema()` (all `secret: False`) and to the env-passthrough tuple in `initialize()`. The module docstring lists them alongside the existing `CLAWMEM_LLM_URL`.

#### `/v1` URL doubling fix

The pre-PR transport posted to `${remoteLlmUrl}/v1/chat/completions` unconditionally. If a user set `CLAWMEM_LLM_URL=https://api.example.com/v1` (a common shape for OpenAI-compatible proxies that document their base URL with `/v1` already included), the request went to `https://api.example.com/v1/v1/chat/completions` and 404'd. v0.10.2 introduces `buildRemoteChatCompletionsUrl()` which strips trailing slashes, detects an existing `/v1` suffix, and only appends `/chat/completions` in that case. All four shapes now resolve correctly: `http://host`, `http://host/`, `http://host/v1`, `http://host/v1/`.

#### Validation centralization

`normalizeRemoteLlmReasoningEffort()` is now the single normalization point for the reasoning-effort value. Previously the env-bootstrap path did its own `.trim().toLowerCase() + Set check` and the constructor did nothing — so a direct caller passing `LlamaCpp({remoteLlmReasoningEffort: "  HIGH  "})` would have posted `"reasoning_effort":"  HIGH  "` to the endpoint while the env path correctly normalized it to `"high"`. The constructor now calls the helper for both paths, so env and direct config behave identically. `CLAWMEM_LLM_MODEL` is also trimmed at both surfaces (defense-in-depth — whitespace-padded values from `.env`-style configs no longer post `"model":" gpt-5.4-mini "`).

### Doc maintenance

Two small doc changes that were sitting in the working tree from the v2026.4.18 / v2026.4.16-920 changelog surveys ride this release:

- **`docs/guides/hermes-plugin.md`** — preventive warning added to the Install section: do NOT add `clawmem` to `plugins.enabled` in `~/.hermes/config.yaml`. Hermes #11xxx onwards made all general plugins opt-in by default; `plugins.enabled` is the general-plugin opt-in roster, not the memory-provider activation channel. Memory providers are activated via `memory.provider: clawmem`, completely separate from the general plugin loader. Adding `clawmem` to `plugins.enabled` would cause the general loader to import it as a `kind: standalone` plugin and call `register(ctx)` against the general `PluginContext` — which doesn't expose `register_memory_provider`, so the import errors and a warning gets logged. Harmless but noisy. The warning heads off the easy mistake for users reading the install path docs literally and conflating the two settings.
- **`src/openclaw/index.ts`** — cosmetic line-ref drift fix in the file-header docstring and correctness-contract comments. OpenClaw's `before_prompt_build` is still awaited at `attempt.ts:1873` (was `:1642` at v2026.4.18 cutoff); `agent_end` is still fire-and-forget at `attempt.ts:2470-2496` (was `:2198-2224`). No semantic change — the await/fire-and-forget contracts hold; only the line numbers in our reference comments shifted.

### External credit

- **@DrJsPBs / @DrJLabs** — opened yoloshii/ClawMem#8 with the configurable remote LLM env vars, the OpenClaw + Hermes plumbing, the `/v1` URL doubling fix, the validation centralization, and 5 new contract tests covering whitespace handling, URL normalization, env-vs-direct config consistency, and the byte-identical default-preservation contract. The PR went through two adversarial review rounds (gpt-5.4 high reasoning each side); the contributor independently identified and folded in fork-review extras (the `/v1` fix being the standout) within the same PR scope. Cross-validated in their downstream `DrJLabs/ClawMem` fork before opening upstream — exactly the integration discipline the v0.7.x community-contributor track has been rewarding.

### Test coverage

PR #8 adds three new test files:

- `tests/unit/llm-remote-config.test.ts` (new) — the contract tests for the new env vars and the `/v1` URL builder
- `tests/unit/hermes-plugin.test.ts` (new) — covers the schema additions
- `tests/unit/openclaw-plugin.test.ts` extended — covers the env-mapping consistency

Targeted suite: **97 pass / 0 fail / 171 expect() calls** across the three files (was 92 pre-PR; +5 new tests).

---

## v0.10.1 — Hermes agent_context isolation + OpenClaw v2026.4.18 / Hermes v2026.4.16+ doc maintenance

v0.10.1 is a small patch release. The retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, and OpenClaw plugin registration shape are all unchanged from v0.10.0. The release covers two upstream changelog reviews against the OpenClaw and Hermes runtimes ClawMem integrates with — neither produced any breaking changes — plus one correctness fix in the Hermes plugin and a small set of doc updates that keep the public-facing surfaces aligned with the runtimes users are actually running.

Vaults from v0.10.0 are byte-identical at rest. No schema migration, no new env vars, no new dependencies. Pure `git pull` upgrade for Claude Code users; `clawmem setup openclaw` re-run is optional (no plugin code changes that affect runtime behavior); Hermes users on a non-primary `agent_context` (subagent, cron, flush) get a quiet correctness improvement.

### Hermes Agent — `agent_context` isolation in `src/hermes/__init__.py`

Hermes's `MemoryProvider` ABC docstring is explicit: *"Providers should skip writes for non-primary contexts (cron system prompts would corrupt user representations)."* Hermes's `run_agent.py` passes an `agent_context` kwarg to every `MemoryProvider.initialize()` call with one of `"primary"`, `"subagent"`, `"cron"`, or `"flush"`. Pre-v0.10.1 the ClawMem plugin absorbed the kwarg via `**kwargs` and ran the full lifecycle for every context — including writing transcript turns and running decision-extractor / handoff-generator / feedback-loop / precompact-extract on cron and subagent passes. The vault's `saveMemory` dedup limited the blast radius, but the cleaner answer is the one the ABC asks for.

v0.10.1 honours the contract. The plugin now reads `agent_context` in `initialize()` and gates only the **write-side** surfaces; the **read-side** surfaces still run for every context so non-primary agents continue to benefit from retrieval:

| Surface | Direction | `agent_context != "primary"` |
|---|---|---|
| `session-bootstrap` (in `initialize`) | Read | Runs |
| `prefetch()` / `queue_prefetch()` (`context-surfacing`) | Read | Runs |
| `system_prompt_block()` | Read | Runs |
| Agent tools (REST: `clawmem_retrieve` etc.) | Read | Runs |
| `sync_turn()` (transcript append) | Write | **Suppressed** |
| `on_session_end()` (extraction trio) | Write | **Suppressed** |
| `on_pre_compress()` (precompact-extract) | Write | **Suppressed** |

When the active context is non-primary, `initialize()` logs a single info-level line for operator visibility:

```
clawmem: agent_context=cron — reads enabled, writes suppressed
```

Net effect: subagents and cron agents read the vault as before; they no longer write back into it. For installs that run only `agent_context="primary"` (the default for interactive CLI / Telegram / Discord platforms), behavior is unchanged.

### Hermes Agent — preferred install path now `$HERMES_HOME/plugins/clawmem/`

Hermes #10529 (in v2026.4.13+) added user-plugin discovery: `plugins/memory/__init__.py` now scans `$HERMES_HOME/plugins/<name>/` in addition to the bundled `hermes-agent/plugins/memory/<name>/`. Both paths still work; the user-plugin path is preferred because it survives `git pull` of hermes-agent and avoids the dual-registration trap that previously caused duplicate tool names with strict providers. Discovery heuristic = grep `__init__.py` for `register_memory_provider` or `MemoryProvider`; both already present in `src/hermes/__init__.py`. `README.md` Install + Setup blocks, `docs/guides/hermes-plugin.md`, `CLAUDE.md`, `AGENTS.md`, and `SKILL.md` now lead with the user-plugin path and document the bundled path as a still-supported alternative.

### OpenClaw v2026.4.18 — three relevant changes (all compatible)

A v2026.4.11 → v2026.4.18 changelog survey (1,794 commits) ran against ClawMem v0.10.0's plugin. Verdict: no breaking changes. Three changes touch surfaces ClawMem consumes; all are documented in this release:

- **Synchronous `register()` enforcement (`2a283e87a7`, in `v2026.4.19-beta.1`).** OpenClaw now throws `"plugin register must be synchronous"` if a plugin's `register()` returns a Promise. ClawMem's `register(api)` in `src/openclaw/index.ts` is and always has been synchronous (no `async`, no top-level `await`, returns void) — every `await` lives inside per-event handlers, never in registration itself. Companion change: register failures now atomically roll back side effects, so any future throw inside `register()` will leave OpenClaw in a clean state. The constraint is now documented as a load-bearing invariant in `CLAUDE.md` / `AGENTS.md`.
- **`memory-core` dreaming sidecar coexistence (`5fde14b844`, #65411, in v2026.4.18).** When ClawMem owns the `memory` slot AND `plugins.entries.memory-core.config.dreaming.enabled = true`, OpenClaw now loads `memory-core`'s dreaming engine alongside ClawMem instead of unloading it entirely. Two valid configurations: ClawMem-only (default after `openclaw plugins enable clawmem`, with `dreaming.enabled = false`) or ClawMem + dreaming sidecar (opt-in, set `dreaming.enabled = true`). Documented in `docs/guides/openclaw-plugin.md` (new "Coexistence with memory-core dreaming sidecar" section), `README.md`, `CLAUDE.md`, `AGENTS.md`, `SKILL.md`.
- **`attempt.ts` line drift.** OpenClaw's `before_prompt_build` is still awaited; `agent_end` is still fire-and-forget. Their line numbers shifted between v2026.4.11 and v2026.4.18 (`:1661 → :1642` and `:2226-2249 → :2198-2224`). The four references in `src/openclaw/index.ts` (file docstring + correctness-contract comments) were updated accordingly. No semantic change.

### `on_memory_write` deliberately not opted into

Hermes #10507 added an `on_memory_write` bridge to the sequential tool execution path; the commit message names ClawMem as a beneficiary. v0.10.1 deliberately stays opted out. ClawMem's filesystem watcher already indexes Hermes's `MEMORY.md` / `USER.md` if those files live under a configured collection — layering an `on_memory_write` shell-out on top duplicates filesystem watching and introduces a remove-semantics mismatch (a hook event saying "this entry was removed" cannot be cleanly translated into ClawMem's content-addressed vault). The `docs/guides/hermes-plugin.md` lifecycle table now documents this rationale instead of the prior "future" framing.

### v0.8.4 retroactive credit

`### External credit` subsection added to v0.8.4 in this file naming `@saschabuehrle` (Lemony.ai founder) for PR #6 (`fix/issue-5`). The PR was closed-as-superseded on 2026-04-11 because v0.8.4 ended up shipping the broader auto-install fix, but the gateway-restart-before-slot-assignment insight is preserved verbatim in v0.8.4's printed next-steps and the code comment that documents the constraint. Matches the v0.10.0 `### External credit` precedent set for `@withx`. The credit landed in the working tree before the v0.10.1 cut and rides this release.

### Test coverage

No new tests in v0.10.1 — the `agent_context` guard's behavior is observable only against a live Hermes runtime, and the rest of the release is documentation. Full v0.10.0 baseline holds: 1204 pass / 0 fail, 2339 expect() calls across 66 test files.

---

## v0.10.0 — OpenClaw Pure-Memory Migration (§14.3) + v2026.4.11 Packaging Fix

v0.10.0 is the OpenClaw pure-memory migration. ClawMem's OpenClaw plugin is no longer a `kind: context-engine` plugin wrapping a `ClawMemContextEngine` class. It is a `kind: memory` plugin that wires every lifecycle event (`before_prompt_build`, `agent_end`, `before_compaction`, `session_start`) through OpenClaw's plugin-hook bus directly. This matches the direction OpenClaw's own `context-engine` slot has taken since v2026.4.x (narrowed to runtime compaction) and moves ClawMem to the slot it was always logically targeting: the exclusive `memory` slot, alongside `memory-core` and `memory-lancedb` (which it automatically displaces when enabled).

### Why this matters — dual plugin surfaces across OpenClaw and Hermes

Over the last year, the OpenClaw and Hermes maintainers independently converged on the same architectural split: agent runtimes expose **two** distinct plugin surfaces, one for **memory** (persistent, cross-session, retrieval-first) and one for **context engines** (in-session, lossless or lossy compression, compaction-first). Hermes shipped its `MemoryProvider` ABC from the start, and ClawMem has always been plugged in there correctly — as a memory provider. OpenClaw's plugin kind vocabulary took longer to stabilize, with `context-engine` originally broad enough to accommodate both roles, then narrowing through v2026.4.x to what it is today: runtime compaction / compression specifically.

Under the stabilized definition, **ClawMem is a memory layer, not a context engine.** A memory layer maintains a durable index of prior sessions, decisions, and knowledge and serves them back into new conversations via retrieval. A context engine reshapes the live session window: compressing old turns, summarizing transcripts, handing off between models. These are different jobs on different time axes. Calling ClawMem a "context engine" was accurate for the ClawMem-as-OpenClaw-plugin wiring pre-v0.10.0 only because no other slot existed yet. Post-v0.10.0 it is misleading in both directions: it mislabels what ClawMem does, and it **blocks OpenClaw users from pairing ClawMem with a genuine context-engine plugin** (e.g. an LCM-compression plugin like `lossless-claw`) because the two would fight over the same slot.

On v0.10.0, OpenClaw users get the same composability Hermes users have had all along:

- **Memory slot:** `clawmem` — cross-session retrieval, knowledge graph, decision extraction, the 5 agent tools
- **Context-engine slot:** free for an LCM/compression plugin that runs inside the live session window (e.g. `lossless-claw`)

Both can be enabled at the same time. They do not overlap. The memory slot is about what you knew yesterday; the context-engine slot is about what fits in today's prompt. This is the end state the OpenClaw maintainers have been steering toward for several releases, and v0.10.0 is ClawMem moving to the seat that was prepared for it. For Hermes users nothing changes — ClawMem has always been correctly integrated as a memory provider there.

### What is unchanged

The retrieval pipeline, composite scoring, profiles, vault format, hook set, `<vault-context>` output, and the 5 registered agent tools are **unchanged**. No schema migration, no new env vars, no new dependencies. The vault on disk is byte-identical to v0.9.0. Claude Code users who do not run OpenClaw can upgrade with no action beyond `git pull`.

v0.10.0 also fixes a packaging bug that surfaced when OpenClaw shipped v2026.4.11. The new discovery path (`readdirSync({ withFileTypes: true })` + `dirent.isDirectory()`) started silently skipping ClawMem's symlinked plugin directory. Diagnosis, confirmation via an external user on yoloshii/ClawMem#5, and the complete fix (discovery manifest + copy-not-symlink install) are all in this release.

### §14.3 — Pure-memory plugin registration

- **Plugin kind changes from `context-engine` to `memory`.** The adapter in `src/openclaw/` registers as `kind: memory`. OpenClaw's exclusive `memory` slot now holds `clawmem` (via `openclaw plugins enable clawmem`, which also disables any competing memory plugin in the same step). The older `plugins.slots.contextEngine: "clawmem"` pattern no longer applies — v0.10.0 does not occupy that slot.
- **`ClawMemContextEngine` class removed.** Every lifecycle surface the plugin needs — prompt injection, post-turn extraction, pre-compaction state capture, session bootstrap — is now a plain `PluginHookName` handler on the plugin-hook bus. `before_prompt_build` is the **load-bearing** path: it runs prompt-aware retrieval (context-surfacing every turn + cached bootstrap context on first turn) AND runs `precompact-extract` synchronously when token usage approaches the compaction threshold, so state is captured before the LLM call that could trigger compaction on this turn (no race with the compactor). `agent_end` runs decision-extractor + handoff-generator + feedback-loop in parallel (fire-and-forget at OpenClaw's call site). `before_compaction` is a **defense-in-depth fallback only** — fire-and-forget, races the compactor, exists solely to catch the rare case where `before_prompt_build`'s proximity heuristic missed a sudden token-count jump; it forces the precompact regardless of proximity since by the time it runs compaction is already in motion. `session_start` registers the session and caches the bootstrap context for first-turn injection. This is a strict improvement over v0.3.0's shape, where the pre-emptive extraction happened inside `ContextEngine.compact()` via `delegateCompactionToRuntime()` — the v0.10.0 wiring moves the extraction up the stack into `before_prompt_build` where it has a real pre-LLM hook to await on.
- **Behavior is identical from the agent's point of view.** The `<vault-context>` block is byte-equivalent to v0.9.0 on the same vault with the same prompt. This is a packaging and registration change, not a behavioral one. The pure-memory shape is the architecturally correct home for what ClawMem has always done — the old `context-engine` shape was load-bearing on an OpenClaw version that narrowed out from under us.

### v2026.4.11 packaging fix (external report → yoloshii/ClawMem#5)

The packaging fix is co-resident with §14.3 because they are both in the same file and both required for v0.10.0 to run on the current OpenClaw release. The symptom was reported externally by @withx on a fresh install of OpenClaw v2026.4.11 + ClawMem — the plugin looked installed to every CLI command but never registered at runtime.

- **`src/openclaw/package.json` is the new discovery manifest.** OpenClaw v2026.4.11's `discoverInDirectory` reads `package.json` and checks for the `openclaw.extensions: ["./index.ts"]` field before descending into a candidate plugin directory. Pre-v0.10.0 ClawMem shipped `openclaw.plugin.json` as the only manifest. That file is still shipped and still parsed at runtime, but it is not enough on its own for discovery on v2026.4.11+ — the plugin directory is silently skipped. v0.10.0 adds `package.json` to the plugin source tree and `clawmem setup openclaw` now verifies it is present before copying.
- **`clawmem setup openclaw` defaults to recursive copy, not symlink.** OpenClaw v2026.4.11's discoverer walks the extensions directory with `readdirSync({ withFileTypes: true })` and uses `dirent.isDirectory()` to decide which entries to descend into. Symlinks to directories report `isDirectory() === false` on that API shape, so a symlinked plugin is silently skipped during discovery and never registers. Every ClawMem release since the OpenClaw plugin was introduced shipped a symlinked install — it worked on OpenClaw v2026.3.x but stopped working on v2026.4.11. `cmdSetupOpenClaw` now runs `cpSync(..., { recursive: true, dereference: true })` to install the plugin as a real directory. A new `--link` opt-in flag preserves the old symlink behavior for local dev workflows and for older OpenClaw versions, with a warning that v2026.4.11+ discovery will skip the symlink.
- **Next-steps output uses `openclaw plugins enable clawmem`.** The setup command now prints `openclaw plugins enable clawmem` instead of `openclaw config set plugins.slots.memory clawmem`. The `enable` verb pre-validates that the plugin is in the discovered registry (so it only runs on a successful copy), switches the exclusive `memory` slot, and disables the previous occupant (`memory-core`, `memory-lancedb`) in a single command. The older `config set` pattern failed silently on v2026.4.11 because the slot validator rejected a plugin id that had not been discovered first.
- **Multi-user ownership gotcha is documented.** OpenClaw v2026.4.11 enforces that plugin directories be owned by the current runtime user or root, rejecting foreign-owned directories with `suspicious ownership (uid=X, expected uid=Y or root)`. This is a security feature (it prevents a gateway running as a privileged system user from loading code a less-privileged user dropped into its extensions directory). On single-user installs where the gateway runs as your own user account, the ownership check passes automatically. On deployments where the gateway runs as a dedicated system user (e.g. `openclaw`) different from the installer user (e.g. `deploy-user`), you must `sudo chown -R <gateway-user>:<gateway-group> ~/.openclaw/extensions/clawmem` after running setup. Documented in `docs/guides/openclaw-plugin.md` Install section and `docs/troubleshooting.md` OpenClaw section.

### Test coverage

+2 regression gates on top of the v0.9.0 test baseline, locking in the v2026.4.11 packaging fix:

- `tests/unit/openclaw-plugin.test.ts::cmdSetupOpenClaw defaults to copy mode (v2026.4.11+ compat)` — asserts the `cpSync(pluginDir, linkPath, ...)` call exists in `cmdSetupOpenClaw` and the `--link` opt-in is parsed via `args.includes("--link")`. If a future edit flips the default back to symlink without also updating the assertion, the test fails loudly.
- `tests/unit/openclaw-plugin.test.ts::src/openclaw/package.json declares openclaw.extensions (v2026.4.11+ discovery gate)` — reads `src/openclaw/package.json`, asserts `type === "module"` and `openclaw.extensions` is an array containing `"./index.ts"`. If the manifest is ever deleted or reshaped without updating this test, the suite fails before the change reaches release.

Public test suite: **1105 → 1107, zero regressions.** The one pre-existing assertion in the `Shipping Condition 2 — setup-time migration text is present` suite was updated from `"plugins.slots.memory clawmem"` to `"openclaw plugins enable clawmem"` to match the new next-steps output shape.

### Multi-user end-to-end validation

Captured on a representative multi-user install (OpenClaw gateway runs as system user `openclaw`, ClawMem installed by a separate admin user):

```
[plugins] clawmem: plugin registered (kind=memory, bin=/home/<user>/clawmem/bin/clawmem, profile=balanced, budget=800)
[plugins] clawmem: registered 5 agent tools
[gateway] ready (7 plugins: acpx, browser, clawmem, device-pair, phone-control, talk-voice, telegram; 11.3s)
```

The runtime registration log line explicitly emits `kind=memory`, which is the §14.3 change proving the new registration path is live. The `clawmem` entry appears in the gateway ready line alongside the stock plugins, proving the packaging fix clears v2026.4.11's discovery gate. The multi-user ownership check (`suspicious ownership (uid=1001, expected uid=997 or root)`) reproduced and cleared after `sudo chown -R openclaw:openclaw ~/.openclaw/extensions/clawmem`, which is now a documented step in `docs/guides/openclaw-plugin.md` for multi-user deployments.

### Codex review

GPT 5.4 High, session `019d72d5` (continues the session chain used from v0.7.1 through v0.9.0, now cumulative across 20+ turns). The §14.3 implementation reached zero remaining findings before the v2026.4.11 packaging gap was discovered. Codex was re-engaged with the packaging compat delta (new `package.json`, copy-default `cmdSetupOpenClaw`, next-steps rewrite, +2 regression gates, multi-user e2e evidence) for a final pre-ship pass, same session.

### External credit

- **@withx** — reported the OpenClaw v2026.4.11 incompatibility on yoloshii/ClawMem#5 and confirmed the runtime symptom on a fresh install that did not share any state with the development machines. The external reproduction is what made it clear this was a clean packaging gap, not a machine-specific config drift.

### Upgrading from v0.9.0

v0.10.0 is **drop-in safe for Claude Code users**: `cd ~/clawmem && git pull && systemctl --user restart clawmem-watcher.service`. Nothing on the retrieval path changed.

**OpenClaw users** must also re-run `clawmem setup openclaw` (to switch the extensions dir from symlink to recursive copy), chown the new directory to the gateway user on multi-user installs, and restart the gateway. The full step-by-step is in [docs/guides/upgrading.md](docs/guides/upgrading.md#v090--v0100). **Upgrade OpenClaw to v2026.4.11+ first** — v0.10.0's setup and discovery behavior depend on v2026.4.11's new plugin discovery contract.

---

## v0.9.0 — `<vault-facts>` KG Injection + Session-Scoped Focus Topic Boost

Two context-surfacing upgrades. §11.1 adds a `<vault-facts>` SPO-triple injection block inside `<vault-context>` so the model gets structured "what is currently true about the entities in this prompt" alongside the existing `<facts>` (surfaced documents) and `<relationships>` (memory-graph edges) blocks. §11.4 adds a per-session topic steering lever (`clawmem focus set "<topic>" --session-id <id>`) that biases retrieval toward a declared topic for the duration of a working session without mutating any persisted state. Both changes live exclusively on the read path and are fail-open — the baseline pre-v0.9.0 `<vault-context>` shape is byte-identical when the new stages don't fire, and every downstream stage (threshold, diversification, token budget, injection) is unchanged. v0.8.5 was the last feature release; v0.9.0 is **drop-in safe**: one idempotent expression-index migration, no breaking API changes, no required reindex/embed, no schema rewrites.

### §11.1 — `<vault-facts>` knowledge-graph injection

- **Three-path prompt-only entity extraction** — the seed set for `<vault-facts>` comes from the raw prompt ONLY, via three independent paths: (a) a canonical `vault:type:slug` regex (e.g. `default:project:clawmem`), (b) proper-noun extraction validated via exact-match `resolveEntityTypeExact` that skips ambiguous names resolving to multiple types, and (c) a longer-first n-gram scan (3-gram > 2-gram > 1-gram, cased + lowercased) for technical vocabulary like `vector-store`, `oauth2`, `gpu node`. Prompt-only is a HARD CONSTRAINT — entity seeds never come from `surfacedDocs[i].body` or any retrieval-phase field, so a topic-boosted off-topic doc from §11.4 cannot pollute the facts block with facts about unrelated entities.
- **Validate-then-count candidate ordering (Codex §11.1 Turn 5 invariant)** — per-path, candidates are validated against the entity index BEFORE counting against the 100-candidate cap. Without this ordering, a long prompt dominated by unvalidated capitalized noise (path b raw extraction) would starve the lowercase/hyphenated n-gram lane (path c) and the technical-vocabulary recall would silently drop. The cap also preserves prompt order as a tiebreaker so the first mentioned entities win under pressure.
- **Cross-path entity-id dedup + longer-n-gram tie-breaker** — if the same entity resolves via multiple paths (e.g. "ClawMem" as a proper noun AND "clawmem" as a 1-gram), the cross-path dedup collapses it to one `entity_id` and the sourcePath from the first-matching path wins. For n-gram ties, longer n-grams outrank shorter ones (`vector-store` as a 1-gram compound beats `vector` + `store` as separate tokens).
- **Cross-entity triple dedup (Codex §11.1 Turn 1 fix)** — when both endpoints of a triple are seeded from the prompt (e.g. the prompt mentions both `ClawMem` and `Bun`, and the graph has `ClawMem depends_on Bun`), `store.queryEntityTriples` returns the triple from both sides (outgoing from ClawMem, incoming to Bun). `buildVaultFactsBlock` now dedupes by a stable `${subject}\u0000${predicate}\u0000${object}` key before budgeting so the same fact isn't emitted twice and budget isn't spent twice. Per-entity `maxTriplesPerEntity` cap still applies BEFORE dedup (anti-monopoly is enforced per entity first, then dedup collapses cross-entity duplicates).
- **Profile-gated `factsTokens` sub-budget** — a new `ProfileConfig.factsTokens` field gives `<vault-facts>` a dedicated token allowance that cannot steal from the existing `<facts>` / `<relationships>` budget. `speed`=0 disables the stage entirely (zero overhead on the fast profile). `balanced`=200 tokens (~50 triples at default 4-char/token estimate). `deep`=250 tokens. Truncation always at the triple boundary, never mid-triple, never emits an empty block. If `OVERHEAD >= budgetTokens` the block is dropped — established blocks take priority.
- **Schema migration — `idx_entity_nodes_lower_name`** — `store.ts` adds `CREATE INDEX IF NOT EXISTS idx_entity_nodes_lower_name ON entity_nodes(LOWER(name), vault)` on first open. This expression index backs the new `batchLookupNames` query (`WHERE LOWER(name) IN (...) AND vault = ?`) which would otherwise degenerate to a full scan on large vaults. Idempotent, runs once, harmless if the binary is later rolled back to v0.8.5 (SQLite ignores the unused index).
- **Fail-open at every stage** — empty entity set → skip the stage (caller gets unchanged `vaultInner`). Per-entity `queryTriples` throw → skip that entity and continue. Budget too small for even one triple → drop the whole block. Any exception inside the `if (profile.factsTokens > 0) { try { ... } catch {} }` wrapper → degraded vault behaves identically to pre-§11.1. The baseline `<vault-context>` is always recoverable.

### §11.4 — Session-scoped focus topic boost

- **`clawmem focus set / show / clear` CLI** — three new subcommands write/read/delete a per-session focus file at `~/.cache/clawmem/sessions/<session_id>.focus` (1024-byte cap, UTF-8, plain text). Session ID is resolved from `--session-id <id>`, then `CLAUDE_SESSION_ID` (Claude Code exposes this natively), then `CLAWMEM_SESSION_ID`. The focus file IS the primary signal read by `context-surfacing` — `CLAWMEM_SESSION_FOCUS` env var is a debug-only override that is NOT session-scoped and should not be used in multi-session deployments. `CLAWMEM_FOCUS_ROOT` env override is supported for hermetic testing.
- **Intent-threaded retrieval** — when a focus topic is resolved, `context-surfacing` threads it as the `intent` parameter to `expandQuery` + `rerank` + `extractSnippet`. This is the existing query-time intent lever (already Codex-approved in the query pipeline), so the topic steers query expansion variants, reranker priority, and snippet-extraction sentence selection along the same code paths as a manually-provided `intent` on an MCP `query()` call.
- **Post-composite-score topic boost** — after `applyCompositeScoring` and BEFORE the adaptive threshold filter + memory-type diversification stages, docs matching ALL tokens of the focus topic (bag-of-words against title/path/body[:800], case-insensitive) get a 1.4× multiplier on `compositeScore`. Non-matching docs get a 0.75× demote (clamped at a 0.5 floor via `Math.max(demoteFactor, 0.5)`). The boost fires per-result and re-sorts the scored set, so matching docs rise and non-matching docs drop but stay eligible if they would have made the threshold without the demote.
- **Zero-match NO-OP fail-open contract (Codex §11.4 Turn 1 fix)** — if zero docs in the scored result set match the topic, `applyTopicBoost(...)` early-returns without mutating `compositeScore`. Without this short-circuit, uniformly demoting every non-matching doc would push borderline docs below the downstream adaptive threshold and silently shrink the result set compared to the no-topic baseline — a direct regression against the approved §11.4 spec ("topic set + zero matching docs → proceed with the normal results"). The fix pre-computes a per-result match flag array in a single pass, checks `if (!anyMatch) return scored`, and only enters the mutation loop when at least one match exists.
- **Session isolation — no SQLite writes** — the focus file is scoped by `sessionId`, never writes to SQLite, never mutates `confidence` / `status` / `snoozed_until` / `archived_at` / any lifecycle column. Concurrent sessions on the same host cannot cross-contaminate each other's topic biasing. This is load-bearing for multi-session deployments (OpenClaw daemon, mission-control concurrent chats) — a global `memory_snooze` would not have worked for session-scoped noise suppression without polluting other sessions' retrieval state.
- **Hook-level integration test lock-in** — three new tests in `tests/integration/context-surfacing-topic-boost.integration.test.ts` drive the real `contextSurfacing(store, input)` handler end-to-end against a hermetic in-memory SQLite store with redirected `CLAWMEM_FOCUS_ROOT`: (1) no-topic vs non-matching-topic produces byte-identical `<vault-context>` output, (2) the byte-equality invariant holds even on a 3-doc result set exercising the full threshold + diversification pass, (3) matching topic produces observably different output from the no-topic baseline (positive control for the boost being active). The byte-equality check is what Codex specifically asked for in Turn 1 — it is the only test shape that proves the fail-open contract survives the full hook pipeline and not just the isolated `applyTopicBoost` unit.

### Codex review

GPT 5.4 High, session `019d72d5` (continues the session chain used from v0.7.1 through v0.8.5, cumulative ~7.5M tokens across 16+ turns). Design review cleared after 6 turns across both §11.4 and §11.1 together. Implementation reviews ran sequentially:

- **§11.4 implementation** — cleared in 2 turns. **Turn 1** raised 1 High finding: the zero-match fail-open contract was violated because `applyTopicBoost` demoted every non-matching doc uniformly even when ZERO docs matched the topic, which under the adaptive threshold filter downstream would push borderline docs below the threshold and silently shrink the result set. Fixed with pre-computed match array + early-return no-op + hook-level integration test asserting byte-equality between the no-topic baseline and a non-matching-topic run. **Turn 2** zero findings.
- **§11.1 implementation** — cleared in 2 turns. **Turn 1** raised 1 Medium finding: `<vault-facts>` could duplicate the same fact when the prompt resolves both endpoints of one triple, because `store.queryEntityTriples(entityId)` defaults to `direction='both'` and the block had no cross-entity dedupe — the same line would appear twice and spend budget twice. Fixed with cross-entity `(subject, predicate, object)` dedup Set applied before budgeting + 2 new unit tests (same triple from both endpoints → one line; distinct triples sharing one endpoint → both lines preserved). **Turn 2** zero findings, verbatim: *"No remaining findings on §11.1. Yes, §11.1 is now cleared to ship."*

All nine design approvals from the design-phase review survived implementation unchanged (three-path extraction, validate-then-count ordering, cross-path entity-id dedup, longer-n-gram tie-breaker, stage placement after `vaultInner`, index migration safety, the four accepted design deviations).

### Test coverage

**+96 tests** across the unit + integration layers on top of the v0.8.5 baseline:

- `tests/unit/session-focus.test.ts` (51 tests) — focus file round-trip, `resolveSessionTopic` env-var-precedence, `applyTopicBoost` boost/demote math, demote floor clamp, zero-match NO-OP, empty-array early return, Unicode topic handling, file-size overflow guard.
- `tests/unit/vault-facts.test.ts` (49 tests) — `extractCanonicalIds` regex boundary cases (interior hyphens, trailing hyphens, word boundaries), `extractProperNouns` title-case sequences, `generateNgramCandidates` longer-first ordering + length tagging + dedup, `batchLookupNames` vault isolation, `extractPromptEntities` three-path orchestration + path-(a/b/c) happy paths + validate-first invariant against long capitalized noise + exact-100 boundary + cross-path dedup + ambiguity skip, `buildVaultFactsBlock` budget handling + truncation at triple boundary + empty-block drop + per-entity max cap + fail-open on DB throw + cross-entity dedup + distinct-triples-sharing-endpoint preservation + schema migration `PRAGMA index_list` assertion.
- `tests/integration/context-surfacing-topic-boost.integration.test.ts` (3 tests) — zero-match fail-open byte-equality × 2 variants (single-result + multi-result), matching topic observably changes output vs the no-topic baseline.

Public test suite: **1025 → 1105, zero regressions.** Skill-forge clawmem backport test suite: **1022 pass, zero regressions** (53 files, smaller baseline because skill-forge has fewer test files overall).

### Upgrading from a pre-v0.9.0 vault

v0.9.0 is **safe to drop in** — the only behavior change on existing code paths is the additive `<vault-facts>` block and the session-scoped topic boost, both gated on new state (entity seeds from the prompt and a per-session focus file). Everything else is unchanged:

- **Schema** — the only migration is a single `CREATE INDEX IF NOT EXISTS idx_entity_nodes_lower_name` statement that runs idempotently on first open. No column additions, no data rewrites, no downtime.
- **API** — zero breaking changes. New `clawmem focus` subcommand is additive. Existing CLI commands and MCP tools are signature-compatible.
- **Config / env vars** — optional: `CLAWMEM_FOCUS_ROOT` (override for the focus file root, primarily for hermetic testing) and `CLAWMEM_SESSION_FOCUS` (debug-only override, NOT session-scoped). The new `factsTokens` profile field defaults to 0 / 200 / 250 for speed/balanced/deep — existing custom profiles that don't set it will receive `factsTokens: 0` from the type default (stage disabled) unless you add it explicitly.
- **Hooks** — no `clawmem setup hooks` re-run needed. Claude Code invokes `${binPath} hook ${name}` at runtime, so upgrading the ClawMem binary alone propagates the new context-surfacing behavior.
- **Reindex / embed** — not required. `<vault-facts>` reads from existing `entity_triples` rows populated by the v0.8.5 SPO extraction pipeline, and §11.4 reads from existing `documents` rows. No re-enrichment needed to see the new blocks.

**Confirming the features are live:**

- `clawmem focus set "authentication" --session-id test1 && clawmem focus show --session-id test1` should print the topic and the expected file path at `~/.cache/clawmem/sessions/test1.focus`.
- After a user prompt that mentions a known entity (e.g., one that appears in `sqlite3 ~/.cache/clawmem/index.sqlite "SELECT name FROM entity_nodes LIMIT 5"`), the hook should append a `<vault-facts>` block inside `<vault-context>` on `balanced`/`deep` profiles. Check by running `echo "tell me about <entity>" | clawmem surface --context --stdin`.

---

## v0.8.5 — SPO Triple Extraction Fix: KG Actually Populates Now

Fixes a bug cluster (BACKLOG.md §1.6) where `entity_triples` was stuck at zero rows on production vaults regardless of activity, making `kg_query` return empty for every entity and silently hollowing out the WHY / ENTITY graph-traversal paths in `intent_search`. Nine bugs across the decision-extractor → observer → entity-resolution → triple-storage pipeline were traced and fixed across four Codex review turns. The fix is entirely additive and strictly improves pre-v0.8.5 behavior — no schema changes, no API breaks, no required migration steps.

- **LLM-based SPO extraction replaces the old regex path** — the observer LLM now emits structured `<triples>` blocks alongside `<facts>`, parsed and validated in `parseObservationXml` against a fixed predicate vocabulary. The pre-v0.8.5 regex-based `extractTripleFromFact` required `subject verb object` sentence shape, which rejected the majority of real observation facts (descriptive phrases like "ClawMem now deploys via systemd user units on a remote host"). The LLM path extracts relational claims without sentence-shape constraints. `VALID_PREDICATES` is a tight 13-predicate set — `adopted`, `migrated_to`, `deployed_to`, `runs_on`, `replaced`, `depends_on`, `integrates_with`, `uses`, `prefers`, `avoids`, `caused_by`, `resolved_by`, `owned_by` — and the parser rejects anything outside it. `LITERAL_PREDICATES` marks `prefers`/`avoids` as literal-object predicates (object is stored as a string, not resolved to an entity).
- **Canonical A-MEM entity IDs end-to-end via `ensureEntityCanonical`** — the old path minted `entity_nodes` rows with `entity_type='auto'` (not a valid compatibility bucket, so those entities never resolved via `kg_query` — a major root cause of the empty KG). The new helper in `src/entity.ts` resolves to a canonical `vault:type:slug` entity ID shared with the rest of A-MEM, never writes `'auto'`, and — unlike `upsertEntity` — does NOT bump `mention_count`, so SPO triple references don't inflate A-MEM's doc-mention counter. `INSERT OR IGNORE` + deterministic `makeEntityId` handles concurrent-insert races correctly.
- **Ambiguity-safe type inheritance via `resolveEntityTypeExact`** — when the observer emits a bare entity name, the helper inherits its `entity_type` from `entity_nodes` only if exactly one entity in the vault matches. Zero matches return null (caller defaults to `concept`); multiple matches across buckets (e.g., "Alice" as `person` AND as `project`) also return null instead of arbitrarily picking. `SELECT DISTINCT entity_type ... WHERE LOWER(name) = LOWER(?)` — exact-match-only, no fuzzy fallback, fails closed on ambiguity.
- **Observation type gate widened to `{decision, preference, milestone, problem, discovery, feature}`** — the pre-v0.8.5 gate rejected roughly 77% of real observations in production vaults because it only accepted `decision`/`preference`/`milestone`/`problem` while the majority of observer output was `discovery`. The new `SPO_ELIGIBLE_OBSERVATION_TYPES` set includes `discovery` and `feature` (the two most common types for product-development work) while still excluding `refactor`/`bugfix`/`change` (noisy types that would dilute the KG).
- **Observation path collision fix** — the persistence path was previously `observations/${date}-${session8}-${type}.md`, which collided on `UNIQUE(collection, path)` whenever two observations of the same type appeared in one session (common for `discovery` during deep coding sessions). The second `insertDocument` threw, was silently caught, and the observation + its triples were dropped. The new path bakes an 8-char SHA256 `obsHash` slice into the filename — deterministic (identical bodies still collide → idempotent reruns), collision-safe under a birthday bound for realistic session sizes. Persistence logic is now in an exported `persistObservationDoc` helper so regressions are unit-testable.
- **Placeholder leak defense at both prompt and parser** — the pre-v0.8.5 `OBSERVATION_SYSTEM_PROMPT` placed literal example text (`<fact>Individual atomic fact</fact>`) inside tags the parser later extracted, and a weak 1.7B model occasionally echoed that text verbatim into production `entity_triples` rows. The new prompt uses ellipsis placeholders outside data tags, prose field rules below the XML block, and two parser defenses: an exact-string blocklist (`SCHEMA_PLACEHOLDER_STRINGS`) + a narrow shape-only regex (`{{...}}`, `<!--...-->`, `${...}`). Applied to `title`, every `<fact>`, and every triple `<subject>`/`<object>`.
- **`kg_query` canonical-ID fallback** — previously, a callerside canonical ID like `default:project:clawmem` was run through `searchEntities`, failed to match as free text, then fed through a slugification fallback (`entity.toLowerCase().replace(/[^a-z0-9]+/g, "_")`) that fabricated invalid IDs and returned misleading "no facts found for X" responses. The fallback now regex-tests for the canonical shape (`/^[a-z][a-z0-9-]*:[a-z_]+:[a-z0-9_]+$/`) and round-trips the ID verbatim if it matches, otherwise returns an explicit "no entity found" message with a format hint. The tool description + parameter description updated to advertise canonical-ID acceptance. `kg_query` is a pure superset — entity-name callers see no behavior change.
- **`source_doc_id` provenance on every triple** — `addTriple` callsites now pass `sourceDocId: wit.docId` from the persisted observation, enabling downstream provenance queries and joining triples back to their originating observation document. Previously dropped silently. `source_fact` is the reconstructed `subject predicate object` string (not `JSON.stringify`) so human inspection is readable.
- **Deleted false-comfort test + new real coverage** — the pre-existing `tests/unit/triple-extraction.test.ts` was a copy-paste of the (now deleted) regex helper, not testing production code. Replaced with `tests/unit/spo-extraction.test.ts` covering the full new pipeline: parser triple extraction (canonical predicates, unknown predicate rejection, missing-field rejection, oversize rejection, placeholder rejection, 5-triple cap, case normalization), placeholder filtering (exact strings + template shapes + legitimate `Example:` false-positive preservation), `VALID_PREDICATES`/`LITERAL_PREDICATES` sanity, `ensureEntityCanonical` (canonical creation, zero mention_count bump, reuse, vault scoping, no `'auto'` leak), `resolveEntityTypeExact` (single match, ambiguity rejection, vault isolation), end-to-end triple insertion via canonical IDs with real `source_doc_id`, and `persistObservationDoc` collision-free + idempotent + fact-less behavior.
- **Codex review** — GPT 5.4 High, session `019d72d5` (same session used for v0.7.1 through v0.8.4), 4 turns of review-and-fix. Turn 1 raised 3 categories of bugs and a design direction. Turn 2 raised 3 High findings on the Turn 1 fix plan (`upsertEntity` bumping mention_count, `resolveEntityType` ambiguity unsafety, docId-threading path assumption) plus tighter predicate vocabulary recommendation. Turn 3 raised 1 High (observation path collision, a pre-existing blocker that the new pipeline surfaced) + 1 Low (placeholder regex false-positive on `Example:` prefix) plus a recommended integration test. Turn 4: zero remaining findings, clear to ship.

Adds +34 tests (`tests/unit/spo-extraction.test.ts`, 31 Turn-3 parser/entity/provenance + 3 Turn-4 collision-free persistence) on top of the v0.8.4 baseline. Public test suite: 1006 → 1025, zero regressions.

### Upgrading from a pre-v0.8.5 vault

v0.8.5 is **safe to drop in** — the fix is additive across the board and nothing existing breaks:

- **Schema** — zero changes. No SQL migration runs on first open.
- **API** — zero breaking changes. `kg_query` gained canonical-ID acceptance but continues to accept entity names; every other MCP tool signature is identical.
- **Config / env vars** — zero changes.
- **Hooks** — no `clawmem setup hooks` re-run needed. Claude Code invokes `${binPath} hook ${name}` at runtime, so upgrading the ClawMem binary alone propagates the new decision-extractor behavior.
- **Data cleanup** — *optional*. Dead `entity_nodes.entity_type='auto'` rows and placeholder `source_fact` strings from pre-v0.8.5 runs are harmless (they never resolve via `kg_query`), but can be deleted if you want a clean slate. See the "kg_query returns empty for every entity" entry in `docs/troubleshooting.md` for the exact `sqlite3` cleanup commands and diagnostic symptoms.
- **Retroactive re-enrichment** — *optional*. v0.8.5 does not introduce new enrichment stages, so `clawmem reindex --enrich` is NOT required. Only run it if you specifically want triple extraction to re-fire across your existing observation history — but note that past observation transcripts are gone, so re-enrichment on already-persisted `_clawmem/observations/*.md` files will not recover lost same-type-collision observations. New Stop-hook activity from v0.8.5 onward is the cleanest source of triples.

**Confirming the fix is live** — after a real Claude Code Stop-hook-firing session, `sqlite3 ~/.cache/clawmem/index.sqlite "SELECT source_fact FROM entity_triples ORDER BY created_at DESC LIMIT 5"` should show human-readable `subject predicate object` strings (e.g. `"ClawMem depends_on Bun"`), not JSON blobs or schema-placeholder echoes.

---

## v0.8.4 — OpenClaw Setup Auto-Install + Active Memory Coexistence Docs

Fixes the OpenClaw plugin setup workflow that caused issue #5 ("plugin not found: clawmem"). Patch release — no schema changes, no migration required.

- **`clawmem setup openclaw` now auto-installs** — previously only printed manual instructions (symlink + manifest copy + config set), which users frequently skipped or misconfigured. Now auto-creates `~/.openclaw/extensions/clawmem` as a symlink to the plugin source, verifies the manifest exists, and prints only the remaining steps that require a gateway restart first (slot assignment, GPU endpoints, REST API). Handles stale symlinks (detects via `readlink` compare, replaces automatically after npm updates), existing directories (removes and re-symlinks), and regular file conflicts (aborts with clear message). Idempotent on re-run.
- **`clawmem setup openclaw --remove` now auto-uninstalls** — previously only printed removal instructions. Now removes the symlink/directory and resets the context engine slot to `legacy` via `openclaw config set` (if the OpenClaw CLI is available). Falls back to printing the manual command when the CLI is absent.
- **Manifest renamed to `openclaw.plugin.json`** — the plugin manifest shipped as `plugin.json` but OpenClaw expects `openclaw.plugin.json`. The old setup workflow worked around this with a copy step that wrote into the symlinked source tree (bad for protected npm prefixes and source checkouts). Now ships with the correct filename, eliminating the copy step entirely.
- **OpenClaw v2026.4.10+ version warning** — setup prints a warning about the config normalization bug (openclaw/openclaw#64192) where `plugins.slots.contextEngine` was silently dropped on earlier versions. The warning is informational, not fatal.
- **Active Memory coexistence documented** — new section in the OpenClaw plugin guide explaining that ClawMem and OpenClaw's Active Memory plugin (v2026.4.10+) are fully compatible: different plugin kinds, different injection targets (user prompt vs system prompt), different memory backends. Both can run simultaneously.
- **Codex review** — GPT 5.4 High, session `019d72d5`, turns 25-27 (~4.32M cumulative tokens). Turn 25 raised 1 High (manifest copy into source tree) + 2 Medium (auto-install gap, version warning). Turn 26 raised 1 High (config set before gateway restart) + 1 Low (regular file conflict unhandled). Turn 27: zero remaining findings.

No breaking changes. Existing users who previously ran the manual symlink steps are unaffected — `setup openclaw` detects the existing correct symlink and skips re-creation.

### External credit

- **@saschabuehrle** — opened yoloshii/ClawMem#6 with the gateway-restart-before-slot-assignment fix and the correct diagnosis of the `Context engine "clawmem" is not registered` failure path. The PR was closed as superseded because v0.8.4 ended up shipping a broader auto-install fix, but the restart-ordering insight is preserved verbatim in v0.8.4's printed next-steps and the code comment that documents the constraint.

---

## v0.8.3 — Content-Type-Aware Entity Cap + Self-Loop Guard + Docs Restructure

Two small safety/correctness fixes land alongside a major documentation restructure. Patch release — no schema changes, no migration required, no new env vars.

- **Content-type-aware entity cap** — A-MEM entity extraction used a flat `.slice(0, 10)` cap that silently dropped legitimate entities on long-form content (research dumps, conversation synthesis, hub/index documents). The new `ENTITY_CAP_BY_TYPE` mapping in `src/entity.ts` scales the cap by `content_type`: research documents keep up to 15, hub and conversation documents keep up to 12, short types (decision, deductive, note, handoff, progress) stay at 8, and anything else — including untyped documents and unknown types — keeps the pre-v0.8.3 default of 10. `extractEntities` gained an optional `contentType` parameter and `enrichDocumentEntities` threads the column through from the document row. The LLM extraction prompt also advertises the dynamic cap directly (`0-${cap} entities` instead of the old hardcoded `0-10`) so a compliant model no longer stops early on long-form documents. Input is trimmed and lowercased before lookup, so hand-authored frontmatter values like `"Research"` or `" conversation "` resolve cleanly.
- **Self-loop guard in `insertRelation`** — the primary `memory_relations` write API (`store.ts:1545`) now rejects relations where `fromDoc === toDoc` at the API boundary. A self-loop has no informational value for graph traversal and would pollute `intent_search` / `find_similar` neighborhoods. A mirror guard was added to the beads dependency bridge inside `syncBeadsIssues` (`store.ts:~4228`) because that path inserts directly into `memory_relations` without going through the wrapper. `buildTemporalBackbone` and `buildSemanticGraph` were left alone — both are structurally safe via their loop shape or SQL filter. An extended audit surfaced six additional INSERT sites (in `amem.ts`, `entity.ts`, `consolidation.ts`, `conversation-synthesis.ts`) that each already have their own structural or explicit self-loop protection; none required new guards.
- **Documentation restructure** — All version history was moved out of `README.md` (removed 7 inline subsections, ~75 lines) into a new chronological `RELEASE_NOTES.md` with every release from v0.1.1 through v0.8.3. `README.md` now reads as setup + usage + architecture, not changelog, and points to the new file. Upgrade action guidance for existing vaults continues to live in `docs/guides/upgrading.md`. This is the document you are reading.
- **Tests** — added 28 new tests across `tests/unit/entity.test.ts` (14 unit tests for `entityCapForContentType` covering all content types, defaults, unknown fallback, case/whitespace normalization; 11 integration tests for `extractEntities` covering per-type caps, untyped backward compat, and prompt-shape verification) and `tests/unit/openviking-enhancements.test.ts` (3 tests for the self-loop guard: plain rejection, mixed-valid-and-self-loop regression, and upsert weight-accumulation invariance). Public test suite: 978 → 1006, zero regressions.

No breaking changes. Existing callers that don't pass `contentType` get the default cap of 10, matching pre-v0.8.3 behavior exactly.

---

## v0.8.2 — Dual-Host Worker Architecture

Both maintenance lanes can now be hosted by the long-lived `clawmem watch` watcher service in addition to the existing per-session `clawmem mcp` host. This makes the systemd-managed watcher the canonical 24/7 home for the v0.8.0 heavy maintenance lane — its quiet-window logic finally sees a live worker at the configured hours regardless of whether any Claude Code session is open. The light consolidation lane (Phase 1 backfill + Phase 2 merge + Phase 3 deductive synthesis + Phase 4 recall stats) now also acquires its own DB-backed `worker_leases` row before each tick, symmetric with the heavy lane's existing exclusivity, so multiple host processes against the same vault cannot race on Phase 2 merges or Phase 3 deductive writes.

- **Light-lane worker lease** — `runConsolidationTick` wraps every tick (Phase 1 → 4) in `withWorkerLease` against a new `light-consolidation` worker name with a 10-minute TTL. Two host processes (e.g. one watcher service + one per-session stdio MCP) cannot both consolidate the same near-duplicate observations or both INSERT a duplicate row into `consolidated_observations`. Phase 1 enrichment is also serialized — overkill for cost but cleaner for symmetry. The in-process `isRunning` reentrancy guard remains the cheap first defense before the SQLite lease round-trip.
- **`cmdWatch` hosts both workers** — `clawmem watch` honors the same `CLAWMEM_ENABLE_CONSOLIDATION` and `CLAWMEM_HEAVY_LANE` env-var gates as `cmdMcp`. Off by default. Mirror the existing systemd unit (or your wrapper `.env`) to opt in. The recommended deployment for v0.8.2+ is to set both env vars on `clawmem-watcher.service` and leave `cmdMcp` unset, so the heavy lane has a continuously available host independent of Claude Code session lifecycle.
- **`cmdMcp` is now a fallback host with a heavy-lane warning** — `cmdMcp` retains the same env-var gates so non-watcher deployments (e.g. macOS users running everything via Claude Code launchd) keep working unchanged. When `CLAWMEM_HEAVY_LANE=true` is set on a stdio MCP host, `cmdMcp` emits a one-line warning to stderr advising operators to move heavy-lane hosting to `clawmem watch` instead.
- **Async drain on shutdown** — both worker stop helpers (`stopConsolidationWorker` and the closure returned by `startHeavyMaintenanceWorker`) are now `async`, clearing their `setInterval` AND polling their in-flight running flag until any mid-tick worker drains. This guarantees the worker's `withWorkerLease` finally block runs against a still-open store, so the lease is released cleanly instead of leaking until TTL expiry. Bounded waits (15s light, 30s heavy) prevent a stuck tick from wedging shutdown indefinitely; the next process reclaims any stranded lease atomically.
- **Signal handlers registered before worker startup** — both `cmdWatch` and `cmdMcp` now register their `SIGINT`/`SIGTERM` handlers BEFORE any worker initialization. A signal arriving in the brief window between worker startup and handler registration would otherwise terminate the host via the default signal action (exit 143) and skip the async drain entirely.
- **Subprocess smoke test** — new `tests/integration/cmdwatch-workers.integration.test.ts` spawns `bun src/clawmem.ts watch` against a temp vault with short worker intervals, exercises the env-var gates, exercises a real heavy-lane tick (slow path, ~35s), and asserts the lease is released cleanly on `SIGTERM`.
- **Bug fix: removed dead skill-vault watcher block from `clawmem.ts cmdWatch()`** — a try/catch wrapped block had been silently destructuring `getSkillContentRoot` from `./config.ts`, but that helper is forge-internal and was never exported in public ClawMem. The runtime catch swallowed the failure so it had no observable effect, but TypeScript flagged a static `TS2339` error on the destructure. v0.8.2 removes the dead code path. No behavior change for public users.

Adds +15 tests (9 light-lane lease unit + 5 cmdWatch fast subprocess + 1 cmdWatch slow subprocess) on top of the v0.8.1 baseline.

For operational guidance — enabling the workers via systemd drop-in, tuning intervals to your usage pattern, monitoring queries, and rollback steps — see [docs/guides/systemd-services.md](docs/guides/systemd-services.md#background-maintenance-workers-v082).

---

## v0.8.1 — Multi-Turn Prior-Query Lookback

`context-surfacing` now builds its retrieval query from the current prompt plus up to two recent same-session prior prompts, so a short follow-up turn ("do the same for X", "explain the rationale") can still inherit the vocabulary of earlier turns. The raw prompt is persisted in a new nullable `context_usage.query_text` column so future hook ticks can reconstitute the multi-turn query from the DB. See [multi-turn lookback](docs/concepts/architecture.md#multi-turn-prior-query-lookback-v081) for the full walkthrough.

- **Additive schema migration** — new nullable `query_text TEXT` column on `context_usage`, guarded by `PRAGMA table_info`. Pre-v0.8.1 stores get the column added on first open; ad-hoc stores that skip the migration path degrade transparently via a feature-detect WeakMap so `insertUsageFn` never writes a column that doesn't exist.
- **Discovery path only** — the multi-turn query feeds vector search, BM25, and query expansion. Cross-encoder reranking continues to use the RAW current prompt so relevance scoring is not diluted by older turns, and composite scoring / snippet extraction / dedupe / routing-hint detection all remain on the raw prompt as well.
- **Privacy-conscious persistence split** — gated skip paths (slash commands, `MIN_PROMPT_LENGTH`, `shouldSkipRetrieval`, heartbeat dedupe) do NOT persist their raw text because those turns are not meaningful user questions and carry a higher sensitivity profile. Post-retrieval empty paths (empty result set, threshold blocked, budget blocked) DO persist so a follow-up turn can still inherit the intent even when the current turn surfaced nothing.
- **Current-first truncation** — the combined query is clamped to 2000 chars with the current prompt preserved verbatim at the head. Older priors are dropped first when the budget runs out. If the current prompt alone already exceeds the cap, priors are omitted entirely and the current prompt is truncated.
- **SQL-level self-match guard** — duplicate submits of the same prompt are filtered out of the lookback SELECT via `AND query_text != ?` so a retry burst cannot eat into the 2-prior budget and leave the lookback window underfilled.
- **10-minute max age, session-scoped** — priors older than 10 minutes or from a different `session_id` are invisible to the lookback. All fallback paths (missing column, DB error, no matching rows) return the current prompt unchanged — the hook never throws on lookback failures.

Adds +27 tests (22 unit + 5 integration) on top of the v0.8.0 baseline.

---

## v0.8.0 — Quiet-Window Heavy Maintenance Lane

A second, longer-interval consolidation worker that keeps Phase 2 + Phase 3 running on large vaults without starving interactive sessions. Off by default — set `CLAWMEM_HEAVY_LANE=true` to enable. The existing 5-minute light-lane worker is unchanged. See [heavy maintenance lane](docs/concepts/architecture.md#heavy-maintenance-lane-v080) for the architectural walkthrough.

- **Quiet-window gating** — the heavy lane only runs inside the hours set by `CLAWMEM_HEAVY_LANE_WINDOW_START` / `CLAWMEM_HEAVY_LANE_WINDOW_END` (0-23). Supports midnight wraparound (e.g., 22→6). Null on either bound means "always in window".
- **Query-rate gating via `context_usage`** — counts hook injections in the last 10 minutes and skips the tick when the rate exceeds `CLAWMEM_HEAVY_LANE_MAX_USAGES` (default 30). No new `query_activity` table; reuses v0.7.0 telemetry.
- **DB-backed worker leases** — exclusivity enforced via a new `worker_leases` table with atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= ?` acquisition, random 16-byte fencing tokens, and TTL reclaim. Safe under multi-process contention; any SQLite error translates to a `lease_unavailable` skip rather than a thrown exception.
- **Stale-first selection** — Phase 2 and Phase 3 reorder their candidate sets by `COALESCE(recall_stats.last_recalled_at, documents.last_accessed_at, documents.modified_at) ASC` so long-unseen docs bubble up first. Empty `recall_stats` falls through to access-time without erroring.
- **Optional surprisal selector** — `CLAWMEM_HEAVY_LANE_SURPRISAL=true` plumbs k-NN anomaly-ranked doc ids (via the existing `computeSurprisalScores`) into Phase 2 as an explicit `candidateIds` filter. Degrades to stale-first on vaults without embeddings and logs `selector: 'surprisal-fallback-stale'` in the journal.
- **`maintenance_runs` journal** — every scheduled attempt writes a row: `status` (`started`/`completed`/`failed`/`skipped`), `reason` for skips, selected/processed/created/null_call counts, and a `metrics_json` payload with selector type and full `DeductiveSynthesisStats` breakdown. Operators can reconstruct any lane decision without reading worker logs.
- **Force-enforce merge gate** — the heavy lane passes `guarded: true` to `consolidateObservations`, which overrides `CLAWMEM_MERGE_GUARD_DRY_RUN` inside `findSimilarConsolidation` so experimenting operators cannot weaken heavy-lane enforcement via env flag.

Adds +56 tests (13 worker-lease + 35 maintenance unit + 8 maintenance integration) on top of the v0.7.2 baseline.

---

## v0.7.2 — Post-Import Conversation Synthesis

Opt-in LLM pass that runs **after** `clawmem mine` finishes indexing an imported collection. Operates on the freshly imported `content_type='conversation'` documents and extracts structured knowledge facts (decisions / preferences / milestones / problems) plus cross-fact relations, writing each fact as a first-class searchable document alongside the raw conversation exchanges. See [post-import synthesis](docs/concepts/architecture.md#post-import-conversation-synthesis-v072) for the architectural walkthrough.

- **New CLI flag** — `clawmem mine <dir> --synthesize [--synthesis-max-docs N]`. Off by default. When omitted, existing mine behaviour is byte-identical to v0.7.1.
- **Two-pass pipeline** — Pass 1 extracts facts per conversation via the existing LLM, saves each via dedup-aware `saveMemory`, and populates a local alias map. Pass 2 resolves cross-fact links against the local map first, falling back to collection-scoped SQL lookup. Forward references (link to a fact extracted later in the same run) are resolved correctly.
- **Idempotent reruns** — synthesized fact paths are a pure function of `(sourceDocId, slug(title), short sha256(normalizedTitle))`, so reruns over the same conversation batch hit the `saveMemory` update branch instead of creating parallel rows. Same-slug collisions are disambiguated by the stable hash suffix, not encounter order.
- **Fail-closed link resolution** — when two different facts claim the same normalized title or alias, the resolver treats the link as ambiguous and counts it unresolved. Pre-existing docs with duplicate titles in the collection do not silently bind either.
- **Weight-monotonic relation upsert** — `memory_relations` insert uses `ON CONFLICT DO UPDATE SET weight = MAX(weight, excluded.weight)`, which is idempotent on equal-weight reruns but still accepts stronger later evidence without double-counting.
- **Non-fatal failure model** — any LLM failure, JSON parse error, saveMemory collision, or relation insert error is counted and logged, never re-thrown. Synthesis failure after `indexCollection` commits does not roll back the mine import.
- **Split operator counters** — `llmFailures` counts actual LLM path failures (null, thrown, non-array JSON), while `docsWithNoFacts` counts docs where the LLM responded validly but returned zero structured facts. Previously these were conflated as `nullCalls`.

Adds +63 tests (46 unit + 5 integration + 12 regression) on top of the v0.7.1 baseline.

---

## v0.7.1 — Safety Release

Five independent safety gates around the consolidation pipeline and context surfacing, aimed at preventing contamination, cross-entity merges, and unchecked contradictions from landing in the vault. Every extraction ships with full unit + integration test coverage (+158 tests on top of the v0.7.0 baseline). See [consolidation safety](docs/concepts/architecture.md#consolidation-safety-v071) for the architectural walkthrough.

- **Taxonomy cleanup** — standardized on the A-MEM `contradicts` (plural) convention across the entire codebase, eliminating silent query misses on the legacy singular form
- **Name-aware merge safety** — the Phase 2 consolidation worker gate extracts entity anchors (via `entity_mentions`, with lexical proper-noun fallback) and runs dual-threshold normalized 3-gram cosine similarity before merging similar observations. Cross-entity merges are hard-rejected when anchor sets differ materially, preventing context bleed where "Alice decided X" merges into "Bob decided X". Thresholds are env-overridable (`CLAWMEM_MERGE_SCORE_NORMAL`=0.93, `_STRICT`=0.98). Dry-run mode via `CLAWMEM_MERGE_GUARD_DRY_RUN` for calibration.
- **Contradiction-aware merge gate** — after the name-aware gate passes, a deterministic heuristic (negation asymmetry, number/date mismatch) plus an LLM check detect contradictory merges. Blocked merges route to `link` policy (insert new row + `contradicts` edge, default) or `supersede` policy (mark old row `status='inactive'`). Configurable via `CLAWMEM_CONTRADICTION_POLICY` and `CLAWMEM_CONTRADICTION_MIN_CONFIDENCE`. Phase 3 deductive synthesis applies the same gate to deductive dedupe matches.
- **Anti-contamination deductive synthesis** — every Phase 3 draft runs through a three-layer validator: deterministic pre-checks (empty conclusion, invalid source_indices, pool-only entity contamination via `entity_mentions`) + LLM validator (fail-open with `validatorFallbackAccepts` counter) + dedupe. Per-reason rejection stats exposed via `DeductiveSynthesisStats` so Phase 3 yield can be diagnosed without enabling extra logging.
- **Context instruction + relationship snippets** — `context-surfacing` now always prepends an `<instruction>` block framing the surfaced facts as background knowledge the model already holds, and appends an optional `<relationships>` block listing memory-graph edges where BOTH endpoints are in the surfaced doc set. The relationships block is the first thing dropped when the payload would overflow `CLAWMEM_PROFILE`'s token budget, preserving facts-first behaviour while giving the model graph-level reasoning hooks directly in-prompt.

---

## v0.7.0 — Recall Tracking with Per-Turn Attribution

Extracts recall tracking patterns from OpenClaw's dreaming memory consolidation system. Tracks which documents are surfaced by retrieval, which queries surfaced them, and whether the assistant cited them — per-turn, not per-session. Validated by GPT 5.4 High across 8 review turns (2.6M tokens).

- **New schema** — `recall_events` (append-only event log), `recall_stats` (derived summary with diversity / spacing / negative counts), `turn_index` column on `context_usage` + `recall_events`, `contradict_confidence` column on `memory_relations`.
- **Direct SQLite write in context-surfacing** — recall events are written directly from the hook process, not through an in-memory buffer. Claude Code hooks are separate short-lived processes, so in-memory buffering would drop events on every session boundary.
- **Per-turn attribution** — `feedback-loop` segments the transcript into turns and zips with `context_usage` rows by `turn_index`, checking references per-turn rather than session-globally. Eliminates cross-turn attribution noise where a document surfaced in turn 3 gets credited by a reference in turn 8.
- **Cross-vault support** — all 31 MCP tools accept an optional `vault` parameter. `context_usage` writes are mirrored into the named vault without cross-DB foreign keys. New `list_vaults()` and `vault_sync()` tools for vault management. Configured in `config.yaml` under `vaults:` or via `CLAWMEM_VAULTS` env var.
- **Budget-only recording** — only docs that actually made it into the injected context are tracked. Budget-clipped docs are excluded, preventing negative signal inflation from entries the model never saw.
- **Lifecycle integration** — `lifecycle_status` and `lifecycle_sweep` now surface pin candidates (high diversity + spacing) and snooze candidates (high noise ratio), scoped to active docs with collection/path in output.
- **SQLite contention fix** — `busy_timeout=15s` during DDL init (was 0ms, causing SQLITE_BUSY on concurrent Stop hooks), reset to 5s for normal operations.

New files: `src/recall-buffer.ts`, `src/recall-attribution.ts`. Adds +36 recall tracking tests; 659 total passing.

---

## v0.6.0 — Deductive Observations, Surprisal Scoring & LLM Remote Fallback

Consolidation worker gains a Phase 3 that synthesizes higher-order deductive observations from recent related facts. Introduces k-NN surprisal scoring for curator triage, embed-state tracking with retries, and a cooldown-based LLM remote fallback. Honcho deep analysis informed the deductive synthesis and surprisal patterns. GPT 5.4 Codex reviewed across 4 turns, 5.2M tokens. 623 tests passing.

- **Deductive observation synthesis** — the consolidation worker Phase 3 combines related recent observations (`decision` / `preference` / `milestone` / `problem`, last 7 days) into first-class `content_type='deductive'` documents with `source_doc_ids` provenance and supporting edges in `memory_relations`. Infinite half-life, 0.85 baseline, decay-exempt — deductions compound over time rather than fading.
- **Retrieval separation** — `session-bootstrap` `getCurrentFocus()` surfaces deductive insights in a dedicated "Derived Insights" section. `context-surfacing` tags them as `(deductive)` so the agent knows they are synthesized rather than directly observed.
- **Surprisal scoring** — `computeSurprisalScores()` uses k-NN average-neighbor-distance over `sqlite-vec` embeddings to identify anomalous observations for curator triage. High surprisal = outlier relative to its semantic neighborhood.
- **Embed-state tracking** — documents track `embed_state` (`pending` / `synced` / `failed`), `embed_error`, and `embed_attempts`. Failed docs retried up to 3 attempts. `clearAllEmbeddings()` resets state. `getHashesNeedingFragments()` catches missing `seq=0` primary embeddings on resume.
- **LLM remote fallback** — `generate()` and `expandQuery()` fall back to local `node-llama-cpp` on transport failures. Structured failure classification: transport errors trigger a 60s cooldown; HTTP errors and `AbortError` do not. Concurrent race guard via pre-fetch cooldown re-check.

---

## v0.5.1 — Documentation Update

Clarified the LLM fallback description in README — transport vs HTTP error distinction, cooldown semantics, "silently falls back" language replaced with explicit cooldown mechanism description. No behavior changes.

---

## v0.5.0 — Conversation Import & Broadened Observation Taxonomy

New `clawmem mine` CLI imports conversation exports from six different chat formats. Observation taxonomy expanded from a single "observation" type into four first-class subtypes. GPT 5.4 reviewed across 3 turns, 6 issues found and fixed (consecutive-assistant loss, unawaited writes, permissive plain-text detection, Slack multi-party handling, preference decay exemption, YAML escaping).

- **`clawmem mine <dir>`** — imports conversation exports from Claude Code, ChatGPT, Claude.ai, Slack, and plain text into the indexing pipeline. New `src/normalize.ts` format normalizer supports all six formats with per-format robustness fixes.
- **New `conversation` content type** — 45-day half-life, 0.55 baseline, optimized for chat-log characteristics (shorter-lived relevance than decisions or docs, but longer than handoffs).
- **Three new first-class observation types** — `preference` (decay-exempt, `Infinity` half-life: user preferences persist indefinitely), `milestone` (60-day half-life), `problem` (60-day half-life).
- **Observer prompt updated** — the local GGUF observer model now extracts preferences, milestones, and problems explicitly, rather than flattening everything into generic observations.
- **Decision-extractor dedicated routing** — each subtype gets dedicated `content_type` treatment instead of the pre-v0.5.0 flattening into a single "observation" bucket.

---

## v0.4.2 — Gray-Matter Frontmatter Sanitization

**Bug fix release.** Resolves `clawmem update` crashes on Obsidian vaults with bare YAML dates or booleans in frontmatter.

`gray-matter` auto-coerces YAML values — `title: 2023-09-27` becomes a `Date` object, `title: true` becomes a boolean. Bun's SQLite driver rejects these as bind parameters with "Binding expected string, TypedArray, boolean, number, bigint or null", crashing the indexer mid-run.

- **Runtime `str()` helper** in `parseDocument()` checks all frontmatter fields and coerces to string.
- **Defense-in-depth `safeTitle` guards** in `insertDocument` / `updateDocument` / `reactivateDocument` catch any Date/boolean leakage past the parse layer.
- Closes [#3](https://github.com/yoloshii/ClawMem/issues/3).

Affected frontmatter fields: `title`, `domain`, `workstream`, `content_type`, `review_by` — any field gray-matter can coerce.

---

## v0.4.0 / v0.4.1 — Version Alignment

Version-number bumps only. No user-visible changes. Kept for npm release continuity between v0.3.4 and v0.4.2.

---

## v0.3.1 — Native Hook Timeout

**Bug fix release.** Shell `timeout` wrappers killed hook processes with exit 124 (no stderr), producing `Failed with non-blocking status code` errors in Claude Code on every hook event.

- **Native `timeout` property** — `clawmem setup hooks` now generates the native Claude Code hook `timeout` field instead of wrapping commands in shell `timeout`.
- **Stop hooks raised from 10s to 30s** — LLM inference in `decision-extractor` / `handoff-generator` / `feedback-loop` regularly exceeds 10s on CPU or under load.
- **All hooks: `timeout` removed from command strings** — only the new native field carries timeout semantics.
- Setup documentation updated with new examples. Troubleshooting entry added.

v0.3.2 / v0.3.3 / v0.3.4 are version-number bumps only with no user-visible changes.

---

## v0.3.0 — OpenClaw Compaction Delegation

**OpenClaw compatibility release.** Reviewed by GPT 5.4 High across 3 turns, 797K tokens.

OpenClaw v2026.3.28+ removed the legacy compaction fallback that `compact()` implementations with `ownsCompaction=false` were relying on. ClawMem's OpenClaw plugin needed to delegate compaction to the runtime directly instead of returning `compacted: false` and expecting OpenClaw to fall back.

- **`compact()` delegates to runtime** — uses `delegateCompactionToRuntime()` from `openclaw/plugin-sdk/core`. `precompact-extract` still runs first as a side-effect so pre-compaction state is captured regardless of who performs the compaction.
- **Bootstrap duplication fix** — `bootstrap()` caches context, `before_prompt_build` consumes it once. Previous behavior invoked bootstrap twice per session.
- **Removed duplicate `before_compaction` hook** — `precompact-extract` now runs once per compaction, not twice.
- **Bootstrap parsing fix** — uses `extractContext()` instead of the legacy `systemMessage` field.
- **New `clearSession()`** for per-session cleanup.
- **Removed unused `bootstrappedSessions` / `isBootstrapped()`** helpers.

Without this fix, OpenClaw sessions never compact on v2026.3.28+.

---

## v0.2.9 — Stop Hook JSON Output Requirement

Documentation-only release. Custom Stop hooks that exit 0 with no stdout cause Claude Code to report `Failed with non-blocking status code: No stderr output`. Documented the root cause and fix pattern in `troubleshooting.md` and `setup-hooks.md`.

---

## v0.2.8 — Stop Hooks on Large Transcripts

**Bug fix release.** Stop hooks were hanging or OOM-ing on transcripts larger than ~10MB because `readTranscript()` loaded the entire file.

- **Backward chunked reader** — up to 5× 2MB chunks read backwards with early exit when the target line count is reached. Raw `Buffer` accumulation with a single UTF-8 decode at the end prevents multi-byte character corruption at chunk boundaries.
- **Single `fd` with `try/finally`** — no descriptor leak.
- **`validateTranscriptPath()` limit raised from 50MB to 1GB** — Claude Code sessions can genuinely produce very large transcripts.

---

## v0.2.7 — Patch Release

Minor fixes. No substantive feature changes beyond v0.2.6.

---

## v0.2.6 — Resilient Lifecycle Tool Search

`memory_pin`, `memory_snooze`, and `memory_forget` now use a 4-stage search cascade instead of BM25-only, preventing `No matching memory found` failures when the document exists but BM25 fails on multi-term queries.

- **`findMemoryCandidates()` cascade** — exact path match → BM25 → title-token overlap → vector similarity. Async pipeline with path detection, stopword filtering, minimum match rule (`max(2, ceil(n/2))` terms), vector fallback on cascade exhaustion.
- **`selectLifecycleTarget()` confidence gate** — ambiguous matches return a candidate list for `memory_forget` (destructive, requires confirmation), top hit for `pin` / `snooze` (non-destructive, single choice).
- `docs/reference/mcp-tools.md` updated with the new search behavior.

---

## v0.2.5 — Hook SQLITE_BUSY Fix

**Bug fix release.** Hook SQLite `busy_timeout` was 500ms while watcher/MCP used 5000ms. During A-MEM enrichment or heavy indexing, watcher write locks exceeded 500ms, causing the hook's DB open to fail with `SQLITE_BUSY` — surfaced as `UserPromptSubmit hook error` in Claude Code.

- **Hook `busy_timeout` raised from 500ms to 5000ms** — matches MCP server.
- Hook still completes within its 8s outer timeout — the raise does not extend user-visible latency, only the patience window.
- Troubleshooting docs appended with new entry (existing context preserved).

---

## v0.2.4 — Watcher Inotify FD Exhaustion Fix

**Bug fix release.** The watcher used `fs.watch(recursive: true)` which registered inotify watches on every subdirectory, including excluded dirs (`gits/`, `node_modules/`, `.git/`). Broad collection paths like `~/Projects` caused 200K+ file descriptors, hanging WSL and triggering inotify limit errors on Linux.

- **Walk directory trees at startup** — skip excluded subtrees using the shared `EXCLUDED_DIRS` from `indexer.ts`.
- **Watch each non-excluded dir individually** (non-recursive) — exact scope instead of blanket recursion.
- **Safety cap: 500 dirs per collection path** — logs a warning if exceeded.
- Exported `EXCLUDED_DIRS` from `indexer.ts` for watcher to share.
- Documented in `troubleshooting.md`, `CLAUDE.md`, `AGENTS.md`, `SKILL.md`.

Diagnosis command added: `ls /proc/$(pgrep -f "clawmem.*watch")/fd | wc -l` — healthy watchers stay under 15K FDs.

---

## v0.2.3 — Entity Extraction Quality Overhaul

Entity resolution pipeline rewritten with quality filters, type-agnostic canonical resolution, and IDF-based entity edge scoring. Addresses the v0.2.0 entity extraction quality issues flagged during a spot audit — prompts were producing title-as-entity extractions at 67% rate because the LLM echoed named examples from the prompt.

- **`isLowQualityEntity()` filter** — rejects title-as-entity (Levenshtein > 0.85), names longer than 60 chars, template placeholders, trailing colons, and invalid locations.
- **Type-agnostic canonical resolution within compatibility buckets** — `person` / `org` / `location` are isolated; `project` / `service` / `tool` / `concept` merge freely within a shared `tech` bucket, capturing the common LLM confusion between them.
- **IDF-based entity edge scoring** — rare entities create edges, ubiquitous entities alone cannot. Shared-count bonus for multi-entity overlap across documents.
- **Prompt rewrite** — `0-10 entities` (was `3-15` — upper bound too high invited hallucination), generic placeholder (was named examples the LLM echoed at 67% rate), negative instructions for titles and headings.
- **`isValidLocation()`** — positive-signal only (IP addresses, `VM \d+` pattern). No length fallback; the old fallback was accepting FQDN-looking heading fragments.
- **`clearDocEntityState` guard** — handles externally-wiped enrichment state without crashing.
- **`LlamaCpp` → `LLM` interface** refactor for `entity.ts` and `intent.ts` function signatures.
- New `docs/internals/entity-resolution.md` with the bucket system and model quality guidance.

---

## v0.2.2 — Entity Enrichment Idempotency

**Bug fix release.** Entity enrichment could double-count mentions or leave partial state on mid-run failures.

- **`entity_enrichment_state` table** with SHA256(`title+body`) input hash — tracks which documents have been enriched and against what content.
- **Transactional writes** — partial failure rolls back; state is only persisted on full success.
- **Full derived state cleanup on content change** — mentions, counts, edges, co-occurrences all cleared when a document's content hash changes.
- **Concurrent enrichment race protection** — re-reads state inside the transaction to catch a racing second enrichment attempt.
- **Canonical alias dedup before counter mutation** — prevents `mention_count` inflation when the same entity appears under multiple aliases in one document.
- **Watcher race protection** — rechecks input hash after LLM call in case the file changed mid-enrichment.
- **Zero-entity docs marked enriched** — prevents infinite retry on documents the LLM finds no entities in.

---

## v0.2.1 — v0.2.0 Follow-up Fixes

- **`--enrich` flag fix** — `clawmem reindex --enrich` now queues unchanged documents for entity backfill. Previously it only queued changed documents, which meant existing vaults couldn't backfill entities after upgrading.
- **47 new tests** for entity resolution, MPFP graph retrieval, temporal UTC boundary handling, observation invalidation, and memory nudge.
- **Troubleshooting entries** for `--enrich` vs `--force` distinction and the wrapper bypass trap (scripts running `bun run src/clawmem.ts` directly miss GPU env var defaults from the `bin/clawmem` wrapper).

---

## v0.2.0 — Hindsight Pattern Integration

Seven patterns extracted from the [Hindsight](https://github.com/vectorize-io/hindsight) memory engine plus a memory nudge pattern from [Hermes Agent](https://github.com/NousResearch/hermes-agent), reviewed by GPT 5.4 High across three rounds. Introduces entity resolution, multi-path graph retrieval, temporal query extraction, 3-tier consolidation, observation invalidation, and memory nudges.

> ⚠ **Migration required:** Existing vaults upgrading from v0.1.x must run `clawmem reindex --enrich` to populate the new entity tables and trigger A-MEM enrichment on existing documents. `reindex --force` alone is NOT sufficient — the A-MEM pipeline skips entity extraction for update-path documents to avoid churn, so the `--enrich` flag is required to backfill. See [docs/guides/upgrading.md](docs/guides/upgrading.md) and the troubleshooting entry on `reindex --force after v0.2.0 upgrade shows no entity extraction` for details.

- **Entity resolution + co-occurrence graph** — LLM entity extraction with quality filters, type-agnostic canonical resolution within [compatibility buckets](docs/internals/entity-resolution.md) (extensible type vocabulary), IDF-based entity edge scoring, co-occurrence tracking, entity graph traversal for ENTITY intent queries
- **MPFP graph retrieval** — Multi-Path Fact Propagation with meta-path patterns per intent, hop-synchronized edge cache, Forward Push with α=0.15 teleport probability. Replaces single-beam traversal for causal/entity/temporal queries.
- **Temporal query extraction** — regex-based date range extraction from natural language queries ("last week", "March 2026"), wired as WHERE filters into BM25 and vector search
- **4-way parallel retrieval** — temporal proximity and entity graph channels added as parallel RRF legs in `query` tool (Tier 3 only), alongside existing BM25 + vector channels
- **3-tier consolidation** — facts to observations (auto-generated, with proof_count and trend enum) to mental models. Background worker synthesizes clusters of related observations into consolidated patterns.
- **Observation invalidation** — soft invalidation (invalidated_at/invalidated_by/superseded_by columns). Observations with confidence ≤ 0.2 after contradiction are filtered from search results.
- **Memory nudge** — periodic ephemeral `<vault-nudge>` injection prompting lifecycle tool use after N turns of inactivity. Configurable via `CLAWMEM_NUDGE_INTERVAL`.

---

## v0.1.8 — Curator-Nudge Backport + Auto-Archive Lifecycle Hook

- **Curator-nudge event map entry** — `HOOK_EVENT_MAP` was missing the curator-nudge hook; it existed only in skill-forge. Backported so public users get the curator-nudge hook wired correctly.
- **Auto-archive lifecycle hook** — `staleness-check` now runs `getArchiveCandidates` + `archiveDocuments` on session start when lifecycle policy is configured. Fail-open: any error logs and continues, never blocks session startup.

---

## v0.1.6 — Watcher Session Transcript Exclusion

**Bug fix release.** The watcher was processing Claude Code session transcript `.jsonl` files as if they were memory documents, causing SQLite write lock contention that triggered `UserPromptSubmit hook error` on the context-surfacing hook. Watcher now excludes session transcripts explicitly (only `.beads/*.jsonl` is still processed).

v0.1.4 / v0.1.5 / v0.1.7 are version-number bumps with minor doc fixes (tool count correction 25 → 28, hook count fixes, manual hook config reference in `setup-hooks.md`, hook cold start latency notes, stale troubleshooting cleanup).

---

## v0.1.3 — Adaptive Thresholds & Deep Profile Escalation

Context-surfacing moves from absolute score thresholds to ratio-based adaptive thresholds (Tier 1 of the adaptive threshold roadmap). Introduces budget-aware deep-profile escalation that spends remaining hook time budget on query expansion and cross-encoder reranking.

- **Adaptive ratio-based thresholds** — three-layer filtering: activation floor (bail if best result is too weak) + score ratio (keep results within X% of best) + absolute floor (never surface below this). Per profile: `speed` 0.65/0.24/0.18, `balanced` 0.55/0.20/0.15, `deep` 0.45/0.16/0.12. MCP tools remain on fixed absolute thresholds (agents control their own limits).
- **Deep profile budget-aware escalation** — when `CLAWMEM_PROFILE=deep` and the fast path (BM25+vector) finishes under 4s, the remaining time budget is spent on (1) query expansion via LLM to discover candidates keyword+vector missed, and (2) cross-encoder reranking of the top 15 candidates for a deeper relevance signal. Hard stop at 6s; fail-open to fast-path results on GPU failure or timeout. Only fires on `deep`; `speed` and `balanced` unchanged.
- **`deep` profile `minScore` lowered from 0.35 to 0.25** — composite scoring with recency/confidence decay was filtering out all results at 0.35 for vaults with older documents. Validated end-to-end: deep profile returns results in ~2s, well within the 8s hook timeout.
- **Sort results by score before reranking slice** — insertion-order slicing was missing expansion-discovered candidates that ranked highly but arrived later in the pipeline (Codex review finding).
- **Expanded troubleshooting docs** — new entries for snap Bun stdin incompatibility, vector dimension mismatch on fallback model, and balanced vs speed profile retrieval differences.
- README + quickstart warnings against snap Bun installation (snap Bun cannot read stdin, breaks hooks).

---

## v0.1.1 / v0.1.2 — Initial Public Releases

First public releases to npm. Baseline feature set:

- **Hooks + MCP integration** for Claude Code — `session-bootstrap`, `context-surfacing`, `staleness-check`, `decision-extractor`, `handoff-generator`, `feedback-loop`, `precompact-extract`, `postcompact-inject`, `curator-nudge`
- **A-MEM pipeline** — automatic memory note generation, link generation, evolution on document updates
- **QMD retrieval** — BM25 + vector + query expansion + RRF + cross-encoder reranking
- **MAGMA intent classification + graph traversal** — WHY / WHEN / ENTITY / WHAT routing with multi-hop beam search
- **Composite scoring** — half-life decay per content type, attention decay, pin/snooze/forget lifecycle
- **Watcher + embed timer** — systemd user services for continuous vault freshness
- **Curator agent** — 6-phase maintenance workflow for Tier 3 operations agents typically neglect
