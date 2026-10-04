# ClawMem REST API reference

HTTP REST API for non-MCP clients, web dashboards, cross-machine access, and **OpenClaw agent tools**. Required for OpenClaw integration — the memory plugin serves 5 agent tools (search, get, session_log, timeline, similar) via this API. See the [OpenClaw plugin guide](../guides/openclaw-plugin.md) for details.

## Start the server

```bash
./bin/clawmem serve                                 # localhost:7438; every request needs the token (below)
./bin/clawmem serve --port 8080                     # custom port
CLAWMEM_API_TOKEN=<32+ chars> ./bin/clawmem serve   # your own token instead of the generated one
./bin/clawmem serve-token                           # print the token serve uses
```

## Authentication (v0.42.0)

Every request, `/health` included, needs `Authorization: Bearer <token>`; without it the server answers `401`. The
token is `CLAWMEM_API_TOKEN` when that is set and non-empty, and otherwise the token file `serve-token` in the config
directory (`CLAWMEM_CONFIG_DIR`, default `~/.config/clawmem`), which `serve` generates on its first start: 43 random
characters, mode `0600`. A token must be 32–4096 characters of `A–Z a–z 0–9 - . _ ~ + /` with optional trailing `=`
(`openssl rand -base64 32` makes one); `serve` refuses to start on a shorter or malformed one, on a token file that
other users can read or that is a symlink, and on a config directory that is not yours or is group- or world-writable.
An empty `CLAWMEM_API_TOKEN` means unset, never "no auth".

`clawmem serve-token` prints the token `serve` would use under the current environment, creating the file if needed:

```bash
TOKEN=$(clawmem serve-token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:7438/health
```

The token stops web pages, which cannot read it. It is not a permission system: any program running as your user can
read the file or the environment.

- **Rotation.** Stop every `serve` that uses the token file, delete the file, and start them again: the first start
  writes a new token and the others read it. The Hermes plugin in external mode (its default) reads the file on each
  call and picks the new token up. A plugin that starts its own `serve` resolves the token once, when it starts — the
  Hermes plugin in managed mode, and the OpenClaw plugin always (its gateway starts a `serve` even when another one
  holds the port) — so restart that agent or gateway too, and give remote clients the new value. With
  `CLAWMEM_API_TOKEN`, change it for `serve` and every client, then restart them.
- **`--no-token`** serves without a token, on a loopback bind only (it is refused on any other bind), with a warning at
  every start. The browser checks below still refuse pages from other origins, but a page served from a loopback
  origin (a local development server, for example) or from an entry of `CLAWMEM_ALLOWED_ORIGINS` can call the server,
  and so can any local program.

## Browser protection (v0.42.0)

`serve` binds `127.0.0.1` by default, yet a web page in your browser can still reach a loopback port. Before routing,
every request is checked:

- **Origin.** A request whose `Origin` names anything but a loopback host (`localhost`, `*.localhost`, `127.0.0.0/8`,
  `[::1]`) or an entry of `CLAWMEM_ALLOWED_ORIGINS` gets `403`, and so does `Origin: null`. Requests without an
  `Origin` (curl, scripts, the plugins) pass.
- **Host.** A `Host` that is not a loopback host, the bind address itself (on a named bind), or an entry of
  `CLAWMEM_ALLOWED_HOSTS` gets `403`, which stops DNS rebinding. On a wildcard bind (`--host 0.0.0.0`) with no
  `CLAWMEM_ALLOWED_HOSTS` the legitimate Host cannot be known, so it is not checked — the startup log says so — and
  the token alone stops a rebound page.
- **JSON bodies.** Every `POST`, bodyless or not, needs `Content-Type: application/json` (parameters such as
  `; charset=utf-8` are fine); anything else gets `415`. A page on another origin can send such a request only after
  a CORS preflight, which is refused for foreign origins.

`CLAWMEM_ALLOWED_HOSTS` takes comma-separated host names or IP literals without ports (a proxy's name, for example).
`CLAWMEM_ALLOWED_ORIGINS` takes comma-separated origins (`https://dash.example`). `serve` refuses to start on an entry
it cannot parse and on an empty entry (a stray or doubled comma); only an empty value means unset.

## Endpoints

The examples assume `TOKEN=$(clawmem serve-token)`.

### Health & stats

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness probe — returns status, version, doc count |
| GET | `/stats` | Full index statistics with collection list |

### Search & retrieval

| Method | Path | Description |
|--------|------|-------------|
| POST | `/search` | Direct search with mode selection |
| POST | `/retrieve` | Smart retrieve with auto-routing |

**POST /search**

```json
{
  "query": "authentication decisions",
  "mode": "hybrid",
  "collection": "notes",
  "compact": true,
  "limit": 10
}
```

Modes: `auto`, `keyword`, `semantic`, `hybrid`.

**POST /retrieve**

```json
{
  "query": "why did we choose JWT",
  "mode": "auto",
  "compact": true,
  "limit": 10
}
```

Modes: `auto`, `keyword`, `semantic`, `causal`, `timeline`, `hybrid`.

Auto-routing classifies the query (shared signal set with the MCP classifier since v0.32.0 — phrasings like "why were" and "because we" route causal on both surfaces):
- Causal queries → the shared intent-aware causal pipeline: intent-weighted RRF anchors, a bounded one-hop causal traversal in both directions, adaptive graph traversal, MPFP, and reranking (through v0.31.0 this route was anchor-only RRF)
- Timeline queries → session history
- Short keyword queries → BM25
- Conceptual queries → vector
- Everything else → hybrid

The REST surface filters nothing internally: `/retrieve` returns `_clawmem` system documents in every mode, including graph-discovered ones on the causal route. Entity co-occurrence expansion does not run on REST (its only home is the MCP `intent_search` tool). A REST-wide visibility option may arrive in a later release.

```bash
# Example: causal query
curl -X POST http://localhost:7438/retrieve \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query": "why did we switch to JWT", "compact": true}'

# Example: keyword search
curl -X POST http://localhost:7438/search \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query": "CLAWMEM_EMBED_URL", "mode": "keyword"}'
```

### Documents

| Method | Path | Description |
|--------|------|-------------|
| GET | `/documents/:docid` | Single document by 6-char hash prefix |
| GET | `/documents?pattern=...` | Multi-get by glob pattern |

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:7438/documents/a1b2c3
curl -H "Authorization: Bearer $TOKEN" 'http://localhost:7438/documents?pattern=notes/*.md'
```

### Timeline & sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/timeline/:docid` | Temporal neighborhood (before/after) |
| GET | `/sessions` | Recent session history |

```bash
curl -H "Authorization: Bearer $TOKEN" 'http://localhost:7438/timeline/a1b2c3?before=3&after=3'
curl -H "Authorization: Bearer $TOKEN" 'http://localhost:7438/sessions?limit=5'
```

### Graph traversal

| Method | Path | Description |
|--------|------|-------------|
| GET | `/graph/causal/:docid` | Directed causal edge records with fact-pair witnesses |
| GET | `/graph/similar/:docid` | k-NN semantic neighbors |
| GET | `/graph/evolution/:docid` | Document evolution timeline |
| POST | `/graphs/build` | Build temporal backbone and/or semantic graph |

```bash
curl -H "Authorization: Bearer $TOKEN" 'http://localhost:7438/graph/causal/a1b2c3?direction=both&depth=3'
curl -H "Authorization: Bearer $TOKEN" 'http://localhost:7438/graph/similar/a1b2c3?limit=5'
```

**GET /graph/causal/:docid** returns `{ docid, direction, depth, count, truncated,
links }` where each link is a directed edge record: invariant
`sourceDocId`/`targetDocId`, separate traversal provenance
(`predecessorDocId`/`depth`/`direction`), `weight`, `evidenceCount`, and up to 3
fact-pair `witnesses` (ordinals, fact snapshots, reasoning, confidence,
`strongestAt`/`lastSeenAt`, `legacy`). One combined 50-edge budget spans both
directions, and the complete JSON body is capped at 64 KiB with whole-edge
truncation (`truncated: true`). Multi-hop chain quality is experimental — depth
> 1 records are per-edge evidence, not a verified chain.

**POST /graphs/build**

```json
{ "graph_types": ["all"], "semantic_threshold": 0.7 }
```

Response (v0.28.0+):

```json
{ "temporal": 12, "semantic": 43, "temporalTotal": 541, "semanticTotal": 3878 }
```

`temporal` / `semantic` are edges **newly written by this call** — inserts are idempotent, so a
rebuild over an unchanged corpus correctly returns `0`. `temporalTotal` / `semanticTotal` are
edges of that type **currently in the active graph** (both endpoints active). `0 new` does not
mean the graph is empty; read the total.

Unlike the MCP `build_graphs` tool, which returns only the graph types you requested, this
endpoint always emits all four keys — that is its pre-existing shape, kept so existing callers
do not break.

### Lifecycle

| Method | Path | Description |
|--------|------|-------------|
| GET | `/lifecycle/status` | Active/archived/forgotten/pinned/snoozed counts + `deactivation_reasons` (`absent`/`forget`/`archive`/`unknown_legacy`) |
| POST | `/lifecycle/sweep` | Archive stale docs (dry_run default). Archives only — never deletes |
| POST | `/lifecycle/restore` | Restore archived docs |

### Document mutations

| Method | Path | Description |
|--------|------|-------------|
| POST | `/documents/:docid/pin` | Pin/unpin a document |
| POST | `/documents/:docid/snooze` | Snooze until a date |
| POST | `/documents/:docid/forget` | Deactivate a document |

### Maintenance

| Method | Path | Description |
|--------|------|-------------|
| GET | `/collections` | List all collections |
| GET | `/profile` | Get user profile |
| POST | `/reindex` | Trigger re-scan. Response includes `enrichAttempted`/`enrichStored` note counters (v0.37.0) — a run whose enrichment produced nothing is visible, not an unqualified success |
| POST | `/graphs/build` | Rebuild temporal + semantic graphs |
| GET | `/export` | Vault export as JSON: every active document except copies of the `precompact-state.md` snapshot ClawMem ≤ v0.39.x left in Claude Code memory dirs, counted in `legacy_snapshots_excluded`. `?full=true` includes them: every active document. Inactive documents and the vault's other tables are not exported; back up the SQLite file itself for that |

## Response format

All responses are JSON. Search/retrieve responses include:

```json
{
  "query": "authentication",
  "mode": "hybrid",
  "count": 3,
  "results": [
    {
      "docid": "a1b2c3",
      "path": "notes/auth.md",
      "title": "Authentication Decision",
      "score": 0.847,
      "contentType": "decision",
      "snippet": "We chose JWT for authentication because..."
    }
  ]
}
```

When `compact=false`, results include `modifiedAt`, `confidence`, and full `body` instead of `snippet`.

## Running as a systemd service

For production deployments (especially OpenClaw), run the REST API as a persistent service instead of relying on the plugin's `spawnBackground()`:

```bash
cat > ~/.config/systemd/user/clawmem-serve.service << 'EOF'
[Unit]
Description=ClawMem REST API server
After=default.target

[Service]
Type=simple
ExecStart=%h/clawmem/bin/clawmem serve --port 7438
Restart=on-failure
RestartSec=5
# Optional: your own token (32+ random characters). Without it serve uses ~/.config/clawmem/serve-token.
# Environment=CLAWMEM_API_TOKEN=...

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now clawmem-serve.service
```

When running as a systemd service, set `enableTools: true` and `servePort: 7438` in the OpenClaw plugin manifest. The plugin still starts its own `serve` when the gateway starts; that child exits at once because the port is taken, and the tools call the systemd server with the token `clawmem serve-token` printed at gateway start. Run the service as the agent's user so both read the same token file; if the unit sets `CLAWMEM_API_TOKEN`, give the gateway's environment the same value. After a token rotation, restart the gateway too.

For remote GPU setups, add environment overrides (same pattern as the [watcher service](../guides/systemd-services.md#remote-gpu)):

```ini
Environment=CLAWMEM_EMBED_URL=http://gpu-host:8088
Environment=CLAWMEM_LLM_URL=http://gpu-host:8089
Environment=CLAWMEM_LLM_MODEL=qwen3
Environment=CLAWMEM_RERANK_URL=http://gpu-host:8090
```

## CORS

A preflight from an allowed origin (loopback, or an entry of `CLAWMEM_ALLOWED_ORIGINS`) is answered with that exact
origin — `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`, methods `GET, POST`, headers
`Content-Type, Authorization` — and responses to that origin carry the same `Access-Control-Allow-Origin`. Other origins
get `403` and no CORS headers. A browser frontend still needs the token: put it in the frontend's configuration.
(Through v0.41.x every preflight answered `*`, and responses carried `http://localhost:*`, which no browser matches.)

## Cross-machine access

Bind a named interface (`--host 192.0.2.5`), whose address is then an allowed Host, or a wildcard
(`--host 0.0.0.0`) with `CLAWMEM_ALLOWED_HOSTS` naming the host names clients use. Give each remote HTTP client the token
(its `CLAWMEM_API_TOKEN`). The Hermes and OpenClaw plugins only call `127.0.0.1`: a token does not give them a remote
server.
