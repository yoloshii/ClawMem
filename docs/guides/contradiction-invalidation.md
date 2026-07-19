# Contradiction invalidation — calibrating before you arm it

The `decision-extractor` Stop hook classifies each session's new facts against the memories they
resemble. When it labels a pair a **contradiction**, two things can happen to the older document:

| Stage | Effect | Reversible | Default |
|---|---|---|---|
| **Confidence erosion** | `confidence -= 0.25`, floored at `0.2` | Yes — one `UPDATE` restores it | **Live** |
| **Invalidation** | `invalidated_at` is set, removing the document from FTS *and* vector retrieval | Yes by SQL, but nothing tells you it happened | **Shadowed** (opt-in) |

Confidence is a ranking signal — 25% of the default composite score, 15% under `query`, 20% under
recency intent. A degraded document ranks lower; it is still retrievable, still returned by an
exact match, still visible in `get` and `multi_get`.

Invalidation is not a ranking signal. `invalidated_at IS NULL` is a hard predicate on both
retrieval legs, so an invalidated document stops existing as far as search is concerned. There is
no warning at query time, no "1 result suppressed" line, and nothing in the normal retrieval path
that would lead you to look.

That asymmetry is why the second stage ships unarmed. Set
`CLAWMEM_CONTRADICTION_INVALIDATE=true` to arm it — but measure your own vault first, because the
exposure is not the same for every vault.

> **Version note.** Before v0.28.0 no classification could be *applied*. The hook ran, called the
> model, and parsed a verdict — but it then looked the target document up by a
> `clawmem://collection/path` URI against a column storing the bare path, so the lookup could
> never match and the verdict was discarded. Classification happened; mutation did not. If you are
> upgrading, treat contradiction handling as newly-effective rather than newly-fixed.

## Two populations, and why the difference matters

Candidates are selected by **pathname** — anything under `decisions/` or `observations/`. But the
armed writer only ever touches rows whose **`content_type` is `observation`**. Those are very
different sets — on the vault this was developed against, roughly three times as many candidates
as eligible rows. Do not lift that ratio; run the queries below, which are the authority for your
own vault.

Both numbers matter, and they answer different questions:

- The **candidate** population is what can have its confidence eroded. That is every document the
  classifier can reach.
- The **eligible** population is what can be invalidated. Arming the flag cannot affect anything
  outside it, whatever its confidence.

Since v0.28.0 the hook holds these apart in its own logging, so shadow mode reports only what
arming would actually remove. A document that reaches the floor but is ineligible is counted and
reported separately — it tells you erosion has bottomed out there, not that arming would do
anything.

Measure both:

Every query below applies the same candidate test the hook does, so the numbers describe the real
population rather than an approximation of it:

```sql
instr(collection||'/'||path, 'observations/') > 0
  OR instr(collection||'/'||path, 'decisions/')  > 0
```

Three details matter, and getting any of them wrong changes the answer. The hook matches
**anywhere** in `collection/path`, not as a prefix on the path alone — a prefix test undercounts a
vault holding `notes/observations/…`. It matches **case-sensitively**, which `LIKE` does not:
`LIKE '%observations/%'` also matches `notes/Observations/a.md`, where the hook does not, so `LIKE`
overcounts. And every query excludes **already-invalidated** rows, which are no longer retrievable
and are not exposure.

```bash
# Candidate population — everything erosion can reach
sqlite3 ~/.cache/clawmem/index.sqlite "
  SELECT COUNT(*) FROM documents
  WHERE active=1 AND invalidated_at IS NULL
    AND (instr(collection||'/'||path, 'observations/') > 0
      OR instr(collection||'/'||path, 'decisions/') > 0);"

# Eligible population — everything arming can remove
sqlite3 ~/.cache/clawmem/index.sqlite "
  SELECT COUNT(*) FROM documents
  WHERE active=1 AND invalidated_at IS NULL AND content_type='observation'
    AND (instr(collection||'/'||path, 'observations/') > 0
      OR instr(collection||'/'||path, 'decisions/') > 0);"

# The breakdown, if the gap is large and you want to know what is in it
sqlite3 -header ~/.cache/clawmem/index.sqlite "
  SELECT content_type, COUNT(*) AS docs FROM documents
  WHERE active=1 AND invalidated_at IS NULL
    AND (instr(collection||'/'||path, 'observations/') > 0
      OR instr(collection||'/'||path, 'decisions/') > 0)
  GROUP BY 1 ORDER BY docs DESC;"
```

## Why calibration is vault-specific

Five properties decide what arming this costs you, and all five vary between vaults.

### 1. Confidence distribution — how many hits to reach the floor

Invalidation fires only when erosion lands the document at `<= 0.2`. Erosion is `-0.25` per
contradiction, so the number of *independent* classifications a document must attract before it
disappears is set entirely by where it started:

| Starting confidence | Contradictions to reach the floor |
|---|---|
| `(0.95, 1.0]` | **4** |
| `(0.70, 0.95]` (the hook writes new observations at 0.80) | **3** |
| `(0.45, 0.70]` | **2** |
| `<= 0.45` | **1** |

The `update` relation erodes on a separate schedule (`-0.15`, floor `0.3`) and can pre-degrade a
document into one-hit range: a document sitting at `0.3` from repeated `update` classifications
reaches `0.2` on its next contradiction.

Measure yours — banded the same way, over the **eligible** population:

```bash
sqlite3 -header ~/.cache/clawmem/index.sqlite "
  SELECT CASE WHEN confidence <= 0.45 THEN '1 hit'
              WHEN confidence <= 0.70 THEN '2 hits'
              WHEN confidence <= 0.95 THEN '3 hits'
              ELSE '4 hits' END AS hits_to_floor,
         COUNT(*) AS docs
  FROM documents
  WHERE active=1 AND invalidated_at IS NULL AND content_type='observation'
    AND (instr(collection||'/'||path, 'observations/') > 0
      OR instr(collection||'/'||path, 'decisions/') > 0)
  GROUP BY 1 ORDER BY 1;"
```

A vault whose eligible documents sit entirely in the `3+` band has the widest margin. Anything in
the `1 hit` band is a single classification away from vanishing once armed, and should be the
first thing you look at.

### 2. Content-type mix — how much of the vault is even eligible

Covered above. If the eligible count is zero — a vault indexed from files with no Stop-hook
history — arming changes nothing at all.

### 3. The classifier model

Precision is a property of whatever `CLAWMEM_LLM_URL` / `CLAWMEM_LLM_MODEL` is serving, not of
ClawMem. Smaller local models tend to echo the prompt skeleton back as output, and the schema
guards catch that shape rather than judging whether the classification is *correct*. Two vaults
running identical code against different endpoints will not have the same false-positive rate.

If you change the model, the calibration you did under the old one no longer holds.

### 4. What your corpus is made of

Contradiction is a semantic judgement, and the base rate of genuine contradiction differs by
corpus. A vault of decision records — where later decisions really do supersede earlier ones — has
real contradictions to find. A vault of reference material mostly has documents that describe
*different* things, which a classifier can easily read as disagreement.

### 5. Classification opportunity — how often a document is even looked at

Exposure is bounded by how many chances a document gets to be classified at all, which is a
property of your retrieval stack, not your corpus:

- Only the **top 5** search results per session enter classification.
- The candidate pool comes from **vector** search, falling back to **FTS** when the vector leg
  throws — a different pool, so embedding coverage and endpoint health change what gets seen.
- Path filtering narrows it further, so corpus layout matters.
- And it scales with **hook traffic** — sessions per day.

A vault with weak embedding coverage and heavy hook traffic has a very different exposure profile
from one with good vectors and occasional use, at identical confidence distributions.

One open question sits here deliberately: several *distinct* new facts may penalize the same old
document within one response. Repeats of an identical verdict are collapsed, but distinct facts
are not, and whether they should be is unresolved in the source.

## Calibration procedure

### Step 1 — measure exposure

Run the queries above. Write down the candidate count, the eligible count, and the eligible
confidence bands. That is the worst case you are agreeing to.

### Step 2 — collect shadow evidence

Leave the default (unarmed) and use ClawMem normally. Every suppressed invalidation logs to
stderr:

```
[decision-extractor] contradiction: WOULD invalidate "<collection>/<path>" (confidence 0.45 -> 0.2)
  — shadow mode, nothing written. Set CLAWMEM_CONTRADICTION_INVALIDATE=true to arm.
```

plus per-session summaries for suppressed invalidations, floor-reached-but-ineligible documents,
and unresolvable targets.

**Where that output lands depends on your host, and one host cannot currently show it:**

| Host | Shadow output reachable? |
|---|---|
| **Claude Code** | **Yes.** Hook stderr is stored in the session transcript. `grep -r 'WOULD invalidate' ~/.claude/projects/<encoded-project-path>/` |
| **systemd** | **Not applicable.** No shipped unit runs this hook — `clawmem-watcher.service` runs `clawmem watch`, which is the indexer, not the Stop hook. Nothing will appear in its journal. |
| **OpenClaw** | **No.** The plugin captures hook stderr but only surfaces it when the hook exits non-zero, and a successful shadow run exits zero — so the `WOULD invalidate` lines are discarded. **Shadow calibration is not possible under OpenClaw, and this flag should not be armed there.** Running the calibration under Claude Code against the same vault is *not* an equivalent substitute: exposure depends on prompts, session traffic and candidate selection, all of which differ by host. |

Erosion runs during this period regardless of host, so the *effect* accumulates in the vault and
can be watched directly:

```bash
sqlite3 -header ~/.cache/clawmem/index.sqlite "
  SELECT content_type, ROUND(confidence,2) AS confidence, COUNT(*) AS docs
  FROM documents
  WHERE active=1 AND invalidated_at IS NULL
    AND (instr(collection||'/'||path, 'observations/') > 0
      OR instr(collection||'/'||path, 'decisions/') > 0)
  GROUP BY 1,2 ORDER BY 1,2;"
```

It must span the **candidate** set, not the eligible subset, or it misses eroded `decision` rows
entirely.

**Take it twice — once when you start shadowing, once at the end — and compare.** A single
snapshot cannot attribute anything to this hook, and an unchanged distribution does not mean the
classifier is idle:

- **Confidence has other writers.** Indexed documents derive an initial value from content type,
  age and access state, so there is no fixed set of "fresh" values to diff a single reading
  against. Only the delta between two readings is yours to interpret.
- **Erosion at the floor is invisible.** A document already at `0.2` that is contradicted again is
  written back to `0.2`; an `update` at its `0.3` floor behaves the same. The mutation boundary was
  reached and nothing moved.
- Verdicts can also be rejected upstream, and a `same` verdict mutates nothing by design.

The per-session summaries are the better evidence: they report validation rejections, unparseable
and missing targets, floor-reached-but-ineligible, shadow suppressions, writes, zero-row writes,
write failures, and collapsed or inconsistent duplicates. There is deliberately **no per-relation
counter** — they will not tell you how many `same` or `update` verdicts came back, so do not infer
classifier activity from their absence either. Attributing confidence changes to this hook with
certainty would need event telemetry or a durable erosion audit; neither exists today.

### Step 3 — adjudicate

For each `WOULD invalidate` line, read the document and decide whether removing it from retrieval
would have been correct:

```bash
clawmem get <path>
```

The question is not "are these two documents different" — it is "does the newer one make the older
one *wrong*". Two observations about unrelated parts of the same system are not contradictory,
however different they look.

**A superseded decision is not an invalidation target.** Persisted decisions carry
`content_type='decision'`, which is outside the eligible set, so the classifier can erode a
superseded decision's confidence but can never retire it. That is deliberate — decision records
are the most expensive thing in the vault to lose silently. When adjudicating, judge only the
`observation` rows named in `WOULD invalidate`; a decision that should be retired is a manual
`memory_forget`, not something arming this flag will do for you.

There is no universal pass mark; the trade is yours. A vault you query for current state wants
aggressive invalidation. A vault you query as a historical record wants none — the older document
being wrong *now* is the thing you are trying to retrieve.

### Step 4 — arm

> **Do not arm under OpenClaw.** Shadow output is not observable on that host (see the table
> above), so there is no way to adjudicate precision before arming — you would be enabling an
> irreversible-feeling writer with no evidence. Calibrating under Claude Code does not substitute:
> the same vault under a different host sees different prompts, sessions, and candidate exposure,
> which is exactly what axis 5 says determines your risk. Wait for shadow output to be reachable
> on your host.

```bash
export CLAWMEM_CONTRADICTION_INVALIDATE=true
```

Only the exact string `true` arms it; any other value leaves it shadowed. Set it wherever the hook
actually runs — for Claude Code, the `env` block of your hook configuration. A shell `export`
affects only processes started from that shell. (The OpenClaw plugin host is deliberately not
listed: arming is unsupported there per the callout above.)

### Step 5 — monitor, and know how to undo it

Armed invalidations announce themselves (`INVALIDATED n document(s)`), and are recorded on the
row, so this stays auditable after the fact. **Work from the numeric `id`** — the log prints
`collection/path` while the table stores the bare `path`, so pasting a logged value into a
`WHERE path=` clause will usually match nothing, and matching on bare path alone can hit
same-named documents in other collections.

```bash
sqlite3 -header ~/.cache/clawmem/index.sqlite "
  SELECT id, collection, path, invalidated_at, invalidated_by
  FROM documents WHERE invalidated_at IS NOT NULL
  ORDER BY invalidated_at DESC;"
```

Restore one document by `id`:

```bash
sqlite3 ~/.cache/clawmem/index.sqlite "
  UPDATE documents SET invalidated_at=NULL, invalidated_by=NULL WHERE id=<id>;"
```

Disarm and restore everything this path invalidated:

```bash
# remove the variable wherever you set it, then:
sqlite3 ~/.cache/clawmem/index.sqlite "
  UPDATE documents SET invalidated_at=NULL, invalidated_by=NULL
  WHERE invalidated_at IS NOT NULL AND content_type='observation';"
```

Retrieval resumes immediately — no re-index and no re-embed, since neither the body nor its
vectors were touched.

**Confidence is deliberately not restored by any of the above.** The document comes back at
whatever confidence erosion left it at, usually `0.2`, so it is retrievable but ranks low. Raising
it is a separate judgement about whether the erosion was itself wrong:

```bash
sqlite3 ~/.cache/clawmem/index.sqlite "UPDATE documents SET confidence=0.8 WHERE id=<id>;"
```

`0.8` is what the hook writes new observations at; use whatever value reflects your actual trust
in the document.

> **Do not confuse this with consolidation's `supersede`.** Grepping the source for
> `invalidated_at` returns two writers, but they target **different tables**: consolidation writes
> `consolidated_observations.invalidated_at` (paired with `status='inactive'`, filtered by a
> different mechanism), while this hook writes `documents.invalidated_at`. On the `documents`
> table the hook is currently the only writer, so the statements above cannot disturb
> consolidation's work.

## Related

- [Configuration reference](../reference/configuration.md) — `CLAWMEM_CONTRADICTION_INVALIDATE`
  and the rest of the hook environment
- [Setting up hooks](setup-hooks.md) — where `decision-extractor` runs and how to install it
- [Troubleshooting → Hooks](../troubleshooting.md#hooks) — symptoms and recovery
