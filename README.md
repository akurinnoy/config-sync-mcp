# Dev Tool Config Sync MCP Server

An MCP server that syncs dev tool configurations to/from a storage backend with snapshot history and rollback. Tool-agnostic — declarative YAML profiles define what to sync for each tool (Claude Code, Gemini CLI, opencode, etc.).

Designed to run as a sidecar container in Eclipse Che workspaces, but works standalone.

## Quick start

```bash
npm install
npm run build
npm start
```

The server listens on port **8089** (configurable via `CONFIG_SYNC_PORT`) and exposes MCP tools over streamable HTTP at `/mcp`. Health endpoint at `/healthz`.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_SYNC_PORT` | `8089` | HTTP port |
| `CONFIG_SYNC_STORAGE_DIR` | `~/.config-sync-storage` | File-based storage directory |
| `CONFIG_SYNC_PROFILES_DIR` | `./profiles` | Directory containing tool profile YAML files |
| `CONFIG_SYNC_USER_ID` | `CHE_USER_ID` or `default` | User identifier for storage key namespacing |
| `FILE_ACCESS_MODE` | `local` | File access mode: `local` (direct filesystem) or `remote` (exec into workspace pods) |
| `POD_NAMESPACE` | auto-detected | Kubernetes namespace for pod discovery (auto-detected from `/var/run/secrets/kubernetes.io/serviceaccount/namespace`) |
| `TARGET_WORKSPACE` | none | Optional default workspace name for remote mode |
| `WORKSPACE_HOME_DIR` | `~` | Home directory path inside workspace pods |

## MCP tools

| Tool | Description |
|------|-------------|
| `sync_from_storage` | Pull latest config from storage backend (all tools or a specific tool) |
| `sync_to_storage` | Push current workspace config to storage backend (all tools or a specific tool) |
| `list_config_versions` | List available config snapshots/versions for a tool |
| `rollback_config` | Restore config from a previous version for a tool |
| `diff_config` | Show differences between local and stored config for a tool |
| `get_sync_status` | Check last sync time and pending changes (all tools or a specific tool) |
| `list_tools` | List all registered tool profiles and their sync status |

## Tool profiles

Each supported tool has a YAML profile in `profiles/` defining its sync rules:

```yaml
tool: claude-code
name: Claude Code
paths:
  sync:
    - "~/.claude/settings.json"
    - "~/.claude/settings.local.json"
    - "~/.claude/CLAUDE.md"
    - "~/.claude/agents/**"
    - "~/.claude/hooks/**"
    - "~/.claude/plugins/**"
    - "~/.claude.json"
  skip:
    - "~/.claude/plugins/cache/**"
  sensitive:
    - "**/*credentials*"
    - "**/*token*"
    - "**/*.key"
```

**Built-in profiles:** `claude-code`, `gemini-cli`, `opencode`. Add new tools by dropping a YAML file in the profiles directory — no code changes needed.

### Profile schema

| Field | Required | Description |
|-------|----------|-------------|
| `tool` | yes | Unique identifier (`^[a-z][a-z0-9-]*$`), used as storage key |
| `name` | yes | Human-readable display name |
| `paths.sync` | yes (≥1) | Glob patterns relative to `$HOME` to sync |
| `paths.skip` | no | Glob patterns to exclude from sync |
| `paths.sensitive` | no | Glob patterns for files that must never be synced (credentials, tokens) |

All paths must start with `~/`. Symlinks pointing outside `$HOME` are rejected. Max file size: 1 MB (configurable).

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Workspace Pod                                       │
│                                                      │
│  ┌──────────────┐                                    │
│  │ Claude Code   │─MCP─┐                             │
│  └──────────────┘      │  ┌───────────────────────┐  │
│  ┌──────────────┐      ├──│ Config Sync Server    │  │
│  │ Gemini CLI    │─MCP─┤  │ (sidecar, port 8089)  │  │
│  └──────────────┘      │  │                       │  │
│  ┌──────────────┐      │  │ profiles/             │  │
│  │ other tools   │─MCP─┘  │  claude-code.yaml     │  │
│  └──────────────┘         │  gemini-cli.yaml      │  │
│                           │  opencode.yaml        │  │
│                           └──────────┬────────────┘  │
│                                      │               │
└──────────────────────────────────────┼───────────────┘
                                       │
                             ┌─────────▼─────────┐
                             │  Storage Backend   │
                             │  (file-based)      │
                             └───────────────────┘
```

### Storage

Each push creates an immutable snapshot at `{storageDir}/{userId}/{tool}/{version}/`, containing a `manifest.json` (checksums, sizes, permissions) and the raw files. Snapshots are append-only. Storage key uses `userId` + `tool` — configs follow the user across workspaces, stored within the user namespace on the cluster.

**Conflict strategy:** Last-write-wins. Use `diff_config` to inspect drift before overwriting.

### What gets synced vs skipped

- **Sync**: user-edited configuration, preferences, custom extensions (agents, hooks, plugins)
- **Skip**: session state, history/transcripts, caches, analytics, anything regeneratable or workspace-local

## Docker

```bash
npm run build
docker build -t config-sync-mcp .
docker run -p 8089:8089 config-sync-mcp
```

Base image: `registry.access.redhat.com/ubi10/nodejs-24-minimal`

## Cluster deployment

Deploy the centralized config-sync-mcp server to a Kubernetes/OpenShift namespace where DevWorkspaces run.

### Prerequisites

- `oc` or `kubectl` configured for the target cluster
- Namespace where DevWorkspaces run (e.g., `kubeadmin-devspaces`)

### Apply manifests

```bash
oc project <namespace>
oc apply -f deploy/
```

This creates:
- **ServiceAccount** `config-sync-mcp` — identity for the server pod
- **Role** — permissions to list pods, exec into workspace pods, and watch DevWorkspaces
- **RoleBinding** — binds the role to the service account
- **Deployment** — the server running in remote mode (`FILE_ACCESS_MODE=remote`)
- **Service** — exposes the MCP endpoint at `config-sync-mcp:8089`

### Verify

```bash
# Check pod is running
oc get pods -l app=config-sync-mcp

# Check health
oc exec deployment/config-sync-mcp -- curl -s http://localhost:8089/healthz

# Test MCP handshake
oc exec deployment/config-sync-mcp -- curl -s -X POST http://localhost:8089/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}},"id":1}'
```

## Development

```bash
npm install
npm run build        # compile TypeScript + copy profiles to dist/
npm test             # run all tests (vitest)
npm run test:watch   # watch mode
```

### Project structure

```
src/
  index.ts                    entrypoint
  server.ts                   HTTP server + MCP transport
  types.ts                    shared types and interfaces
  tools/                      MCP tool handlers (one per tool)
  storage/                    storage backend interface + file implementation
  profiles/                   YAML profile loader + glob resolver
  sync/                       sync engine + SHA-256 checksums
profiles/                     built-in tool profile YAML files
tests/                        unit + integration tests
```

## Next steps

- [ ] Auto-sync on workspace start/stop via lifecycle hooks
- [ ] Test concurrent workspace scenarios
- [ ] Admin-pushed baseline profiles
- [ ] Add opencode built-in profile
