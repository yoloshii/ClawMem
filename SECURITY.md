# Security Policy

## Supported Versions

| Version  | Supported          |
|----------|--------------------|
| 0.43.6+  | :white_check_mark: |
| < 0.43.6 | :x: — upgrade; see v0.43.6 below |

Only the latest release on `main` receives security fixes.

## Architecture Context

ClawMem is a **local-first** tool. All data stays on your machine:

- SQLite database stored locally (no cloud sync)
- GPU inference runs on local `llama-server` instances
- No API keys required for core functionality
- No telemetry, no phone-home, no remote data collection

Optional cloud embedding providers (OpenAI, Voyage, Jina, Cohere) require user-provided API keys and are not enabled by default.

## Threat Model

Given the local-first architecture, the primary security concerns are:

1. **SQLite injection** -- Malicious content in indexed markdown files could exploit SQL queries. All queries use parameterized statements, but novel injection vectors in content that passes through query expansion or FTS5 should be reported.

2. **Prompt injection via surfaced content** -- Indexed documents are surfaced to AI agents via hooks and MCP tools. Adversarial content in indexed files could manipulate agent behavior. If you discover a way to inject instructions through indexed content that bypasses existing sanitization, report it.

3. **Dependency vulnerabilities** -- Third-party packages (`node-llama-cpp`, `sqlite-vec`, `@modelcontextprotocol/sdk`, etc.) may have their own vulnerabilities.

4. **Local file access** -- ClawMem reads markdown files from configured collection paths. Symlink traversal or path manipulation that reads files outside configured collections should be reported.

5. **MCP tool abuse** -- The MCP server exposes tools that read/search the local vault. If a tool can be coerced into returning or modifying data outside its intended scope, report it.

6. **Indexed Markdown as code-execution or memory-exhaustion input** -- Every indexed file's frontmatter is parsed by the indexing process (`clawmem update`, the watcher, the MCP `reindex`/`vault_sync` tools, `clawmem embed`, the canary). Before v0.43.6 a file whose first line was `---js` ran its frontmatter as JavaScript in that process, and crafted YAML (aliases, merge keys, `!!omap`) could expand to an object many orders of magnitude larger than the file. **Fixed in v0.43.6:** the eval engine is refused, the language is allow-listed, the YAML engine is ClawMem's own bounded one (no anchors, no merge, no omap, depth 32, 4,096 nodes, 64 KiB, 1,024 lines) and it checks its own contracts at first use, failing closed. A way to run code or exhaust memory through frontmatter, or through any other field of an indexed file, is a vulnerability: report it.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Email **sciros@lazyvibecoder.com** with:

- Description of the vulnerability
- Steps to reproduce
- Impact assessment (what can an attacker do?)
- Suggested fix if you have one

You should receive an acknowledgment within 72 hours. For critical issues (data exfiltration, arbitrary code execution), expect a fix within 7 days. For lower severity issues, fixes will ship in the next release.

## Security Best Practices for Users

- Keep Bun and dependencies up to date (`bun update`)
- Only index trusted content into your vault. Since v0.43.6 an untrusted file cannot run code through its frontmatter, but its text still reaches the agent (threat 2 above)
- After upgrading to v0.43.6 or later, restart `clawmem watch`, every `clawmem mcp` server and `clawmem serve`: they load the parser once at start. Run `clawmem doctor` once; a ✗ `Frontmatter guard` line means the installed YAML parser does not honour the contracts the guard relies on and YAML frontmatter is being read as plain text until the pinned dependencies are reinstalled
- If using cloud embedding providers, treat your API key like a password
- Run `llama-server` bound to `localhost` unless you need LAN access
- Review collection paths in `config.yaml` -- don't index sensitive directories
