# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |

Only the latest release receives security fixes.

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
- Only index trusted content into your vault
- If using cloud embedding providers, treat your API key like a password
- Run `llama-server` bound to `localhost` unless you need LAN access
- Review collection paths in `config.yaml` -- don't index sensitive directories
