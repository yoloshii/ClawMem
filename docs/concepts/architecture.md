# Architecture

## Vaults

A vault is a single SQLite database file containing all of ClawMem's data: documents, content, vectors, relations, sessions, and usage tracking. The default vault lives at `~/.cache/clawmem/index.sqlite`.

SQLite is used in WAL (Write-Ahead Logging) mode with `busy_timeout=5000ms`, allowing concurrent reads from multiple processes (e.g., Claude Code and OpenClaw sharing the same vault).

## Collections

Collections are named groups of documents sourced from a directory. Each collection has:

- **Name** — identifier (e.g., `notes`, `research`, `memory`)
- **Path** — absolute directory path to scan
- **Pattern** — glob pattern for files to index (default: `**/*.md`)

Collections are defined in `~/.config/clawmem/config.yaml` (symlinked as `index.yml` in the vault directory).

```yaml
collections:
  notes:
    path: ~/notes
    pattern: "**/*.md"
  research:
    path: ~/research
    pattern: "**/*.md"
```

Only markdown files are indexed. Binary files, code, and credentials are never indexed.

### Excluded directories

These directories are always skipped during indexing:

`_PRIVATE`, `.clawmem`, `.git`, `.obsidian`, `.logseq`, `.foam`, `.dendron`, `.trash`, `.stversions`, `node_modules`, `.cache`, `vendor`, `dist`, `build`, `gits`, `scraped`

## Documents

Each indexed file becomes a document with:

| Field | Description |
|-------|-------------|
| `collection` | Which collection it belongs to |
| `path` | Relative path within the collection |
| `title` | Extracted from first heading or filename |
| `hash` | SHA-256 of content (canonical identity) |
| `docid` | First 6 hex chars of hash (for human reference) |
| `content_type` | Auto-detected: decision, note, handoff, progress, research, hub, antipattern, project |
| `quality_score` | 0.0-1.0 based on length, structure, headings, lists, decision keywords, frontmatter |
| `confidence` | Starts at 0.5, adjusted by contradiction detection and feedback |
| `pinned` | Manual boost flag (+0.3 composite score) |
| `snoozed_until` | Temporarily hidden from context surfacing |

## Fragments

Each document is split into fragments for embedding:

- **full** — entire document (if under size limit)
- **section** — content under each heading
- **list** — list items grouped together
- **code** — code blocks

Fragments are embedded independently. The full-document fragment catches broad queries; section/list/code fragments provide precision.

## Search backends

| Backend | Signal | GPU cost | Use case |
|---------|--------|----------|----------|
| BM25 (FTS5) | Keyword exact match | 0 | Known terms, spot checks |
| Vector (vec0) | Semantic similarity | 1 call | Conceptual queries, fuzzy recall |
| Hybrid (RRF) | BM25 + Vector fused | 1+ calls | General recall (default) |

BM25 uses SQLite's FTS5 extension with prefix matching. Vector search uses the `vec0` extension with cosine similarity. Embedding dimensions depend on the model: 768 for the default EmbeddingGemma-300M, 2560 for the SOTA zembed-1, or provider-determined for cloud embedding.

## Retrieval tiers

| Tier | Mechanism | Agent effort | Coverage |
|------|-----------|-------------|----------|
| Tier 1 | Infrastructure (watcher + embed timer) | None | Keeps vault fresh |
| Tier 2 | Hooks (automatic) | None | ~90% of retrieval |
| Tier 3 | MCP tools (agent-initiated) | 1 tool call | ~10% — escalation only |

See [Hooks vs MCP](hooks-vs-mcp.md) for details.
