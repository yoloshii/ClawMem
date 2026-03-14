# Multi-Vault Configuration

Step-by-step guide for setting up multiple independent vaults.

## 1. Define vaults

Edit `~/.config/clawmem/config.yaml`:

```yaml
vaults:
  work: ~/.cache/clawmem/work.sqlite
  personal: ~/.cache/clawmem/personal.sqlite
  research: ~/data/research-vault.sqlite
```

Or use the environment variable:

```bash
export CLAWMEM_VAULTS='{"work":"~/.cache/clawmem/work.sqlite","personal":"~/.cache/clawmem/personal.sqlite"}'
```

Paths support `~` expansion. Environment variables override config file values.

## 2. Populate vaults

Use `vault_sync` via MCP or CLI:

```
vault_sync(vault="work", content_root="~/projects/work-notes")
vault_sync(vault="personal", content_root="~/notes/personal")
```

Or add collections to a vault manually:

```bash
INDEX_PATH=~/.cache/clawmem/work.sqlite ./bin/clawmem collection add ~/projects/work-notes --name work-notes
INDEX_PATH=~/.cache/clawmem/work.sqlite ./bin/clawmem update --embed
```

## 3. Embed vault content

Each vault needs its own embedding pass:

```bash
INDEX_PATH=~/.cache/clawmem/work.sqlite ./bin/clawmem embed
INDEX_PATH=~/.cache/clawmem/personal.sqlite ./bin/clawmem embed
```

## 4. Query vaults

All MCP tools accept `vault`:

```
# Search work vault
query("API authentication flow", vault="work", compact=true)

# Check personal vault lifecycle
lifecycle_status(vault="personal")

# Pin something in research vault
memory_pin("important finding", vault="research")
```

## 5. List configured vaults

```
list_vaults()
```

Returns:

```
Configured vaults (2):
  work: /home/user/.cache/clawmem/work.sqlite
  personal: /home/user/.cache/clawmem/personal.sqlite
```

## Notes

- The default (unnamed) vault at `~/.cache/clawmem/index.sqlite` always exists and is used when `vault` is omitted
- Hooks always operate on the default vault
- Named vault stores are cached in memory and reused across tool calls
- Each vault is fully independent — separate documents, embeddings, graphs, and sessions
- `vault_sync` validates paths against a deny-list (rejects `/etc/`, `.ssh`, `.env`, `credentials`, etc.)
