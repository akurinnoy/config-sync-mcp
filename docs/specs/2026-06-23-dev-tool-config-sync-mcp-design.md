# Specification: Dev Tool Config Sync MCP Server

> Council synthesis from Claude Opus 4.6, Gemini 3 Pro, GPT-5.3 Codex.
> Issue: akurinnoy/agentic-workspaces#148

## 1. Problem

Eclipse Che workspaces are ephemeral. Developer tool configurations -- Claude Code settings, git identity, Gemini CLI preferences, custom extensions -- are destroyed on workspace stop. Existing persistence mechanisms (PVC mounts, manual backups) are cluster-scoped, fragile under concurrency, and demand user discipline. There is no cross-cluster, versioned, tool-agnostic config persistence layer that LLM agents can drive programmatically.

This MCP server provides deterministic, profile-driven config portability with version history and rollback, explicitly excluding volatile artifacts (session state, caches, history).

## 2. Design

### Runtime Model

A sidecar container in the workspace pod, following the `che-mcp-server` deployment pattern. Streamable HTTP on **port 8089** (avoids collision with `che-mcp-server` on 8080) at `/mcp`. Health endpoint at `/healthz`. Node.js 24, TypeScript, UBI10 base image.

### Core Modules

- **MCP Tool Handlers** -- one handler per tool, registered via `@modelcontextprotocol/sdk`
- **Profile Registry** -- loads, validates, and resolves YAML tool profiles from `/profiles/`
- **Sync Engine** -- orchestrates file collection, checksum computation, and transfer
- **Diff Engine** -- compares local filesystem state against stored snapshots
- **Storage Adapter** -- pluggable backend behind an abstract interface

### Data Flow

**`sync-to-storage`:**
1. Resolve profile for requested tool (or all tools)
2. Expand `paths.sync` globs against `$HOME`, subtract `paths.skip` matches
3. For each resolved file: read contents, compute SHA-256 checksum, record size and relative path
4. Filter out files matching `paths.sensitive` patterns (see Security below)
5. Skip files unchanged since last sync (compare checksums against last-known manifest held in memory)
6. Create immutable versioned snapshot in storage backend with manifest + file contents
7. On multi-tool sync: isolate failures per tool -- partial success is valid

**`sync-from-storage`:**
1. Fetch snapshot from storage backend (latest or specified version)
2. Validate manifest integrity (checksum verification)
3. Write files atomically: write to temp path, then rename (prevents partial writes on crash)
4. Preserve file permissions from manifest metadata

**Conflict Strategy (prototype):** Last-write-wins. The server maintains per-file checksums in the manifest. `diff-config` exposes drift so the user or agent can inspect before overwriting. No locking or merge logic in the prototype.

**Storage Key:** `{userId}/{tool}/{version}`. Configs follow the user across workspaces -- `workspaceId` is deliberately excluded from the storage path.

## 3. Files to Create

```
src/
  index.ts                    -- entrypoint: config parsing, signal handling, startup
  server.ts                   -- HTTP server with /mcp and /healthz
  tools/
    sync-from-storage.ts      -- pull config from storage
    sync-to-storage.ts        -- push config to storage
    list-config-versions.ts   -- list available snapshots
    rollback-config.ts        -- restore from previous version
    diff-config.ts            -- compare local vs stored
    get-sync-status.ts        -- check sync state
    list-tools.ts             -- list registered profiles
  storage/
    backend.ts                -- StorageBackend interface
    file-backend.ts           -- filesystem implementation
  profiles/
    loader.ts                 -- YAML parser + Zod validator
    resolver.ts               -- glob expansion, skip/sensitive filtering
  sync/
    engine.ts                 -- orchestration: collect, checksum, transfer
    checksums.ts              -- SHA-256 computation utilities
  types.ts                    -- shared types and DTOs
profiles/
  claude-code.yaml            -- Claude Code config profile
  gemini-cli.yaml             -- Gemini CLI config profile
  git.yaml                    -- git config profile
Dockerfile                    -- UBI10 + Node.js 24 (mirrors che-mcp-server)
package.json
tsconfig.json
```

## 4. MCP Tool Specifications

### `sync_from_storage`

**Input:** `{ tool?: string }`
**Output:** `{ synced: [{ tool: string, filesWritten: number, bytesWritten: number, version: string }], warnings: string[] }`
Omit `tool` to sync all registered profiles. Partial failures are isolated per tool and reported in `warnings`. Read-only hint: false.

### `sync_to_storage`

**Input:** `{ tool?: string, message?: string }`
**Output:** `{ pushed: [{ tool: string, version: string, filesStored: number, bytesStored: number, checksum: string }], warnings: string[] }`
`message` is an optional human-readable label for the version. Skips files unchanged since last sync. Read-only hint: false.

### `list_config_versions`

**Input:** `{ tool: string, limit?: number }`
**Output:** `{ versions: [{ version: string, timestamp: string, message?: string, fileCount: number, totalBytes: number, checksum: string }] }`
Returns versions in reverse chronological order. Default limit: 20. Read-only hint: true.

### `rollback_config`

**Input:** `{ tool: string, version: string }`
**Output:** `{ restored: { tool: string, version: string, filesWritten: number, bytesWritten: number } }`
Writes the specified version's files to the local filesystem. Destructive hint: true.

### `diff_config`

**Input:** `{ tool: string, version?: string }`
**Output:** `{ diffs: [{ path: string, status: "added" | "modified" | "deleted", localChecksum?: string, storedChecksum?: string, sizeChange?: number }] }`
If `version` is omitted, diffs against the latest stored version. Returns structured objects, not unified diff strings. Read-only hint: true.

### `get_sync_status`

**Input:** `{ tool?: string }`
**Output:** `{ tools: [{ tool: string, lastSyncTime?: string, lastSyncDirection?: "push" | "pull", pendingChanges: number, status: "synced" | "dirty" | "never_synced" }] }`
Omit `tool` to get status for all registered profiles. Read-only hint: true.

### `list_tools`

**Input:** `{}`
**Output:** `{ tools: [{ tool: string, name: string, syncPathCount: number, skipPathCount: number, lastSync?: string, status: "synced" | "dirty" | "never_synced" }] }`
Read-only hint: true.

## 5. Storage Backend Interface

```typescript
interface FileEntry {
  path: string;          // relative to $HOME
  checksum: string;      // SHA-256
  sizeBytes: number;
  permissions?: string;  // e.g., "0600" for SSH keys
}

interface ConfigBundle {
  tool: string;
  version: string;       // ISO-8601 timestamp
  timestamp: string;
  message?: string;
  manifest: FileEntry[];
  files: Map<string, Buffer>;
}

interface VersionInfo {
  version: string;
  timestamp: string;
  message?: string;
  fileCount: number;
  totalBytes: number;
  checksum: string;      // aggregate checksum of manifest
}

interface StorageBackend {
  initialize(): Promise<void>;
  store(bundle: ConfigBundle): Promise<{ version: string }>;
  retrieve(tool: string, version?: string): Promise<ConfigBundle>;
  listVersions(tool: string, limit?: number): Promise<VersionInfo[]>;
  deleteVersion(tool: string, version: string): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}
```

**File-based implementation:** Stores at `<baseDir>/<userId>/<tool>/<version>/` with `manifest.json` plus raw files mirroring their relative paths. Versions are ISO-8601 timestamps. Snapshots are append-only (no in-place mutation). `userId` is resolved from the workspace environment (e.g., `CHE_USER_ID` or Kubernetes service account).

## 6. Tool Profile Schema

```yaml
tool: string              # unique identifier, storage key; must match ^[a-z][a-z0-9-]*$
name: string              # human-readable display name
paths:
  sync:                    # glob patterns relative to $HOME (required, at least one)
    - "~/.gitconfig"
    - "~/.config/git/*"
  skip:                    # glob patterns to exclude (applied after sync expansion)
    - "**/*.log"
    - "**/cache/**"
  sensitive:               # glob patterns for files that must never be synced
    - "**/*credentials*"
    - "**/*token*"
    - "**/*.key"
```

**Validation rules:**
- `tool` must match `^[a-z][a-z0-9-]*$`
- `paths.sync` must have at least one entry
- All paths must start with `~/` -- absolute paths outside `$HOME` are rejected
- Globs support `*`, `**`, `?`
- `skip` patterns are matched against the resolved file list from `sync`
- `sensitive` patterns cause matched files to be silently excluded with a warning in the response
- Symlinks are resolved to their targets; symlinks pointing outside `$HOME` are rejected (path traversal prevention)
- Maximum individual file size: 1 MB (configs should be small; large files indicate misconfigured profiles)

## 7. Validation

1. **Unit tests:** Profile loader parses valid YAML, rejects invalid (missing `tool`, empty `sync`, invalid characters). Glob resolver expands correctly and respects `skip` and `sensitive` filters. Checksum computation is deterministic. File backend stores and retrieves round-trip losslessly.

2. **Integration test:** Start the server. Call `list_tools` -- expect 3 built-in profiles. Seed `~/.gitconfig` with known content. Call `sync_to_storage({tool:"git"})`. Delete `~/.gitconfig`. Call `diff_config({tool:"git"})` -- expect one "deleted" entry. Call `sync_from_storage({tool:"git"})`. Verify file restored with identical content and permissions.

3. **Version and rollback test:** Push two versions of git config with different content. Call `list_config_versions({tool:"git"})` -- expect 2 entries. Call `rollback_config` to the first version. Verify local file matches original content.

4. **Security test:** Create a profile that includes `~/.config/tool/` and place a file named `credentials.json` inside. Verify `sync_to_storage` excludes it and reports a warning. Verify symlinks pointing outside `$HOME` are rejected.

5. **MCP client test:** Connect with `@modelcontextprotocol/sdk` client over streamable HTTP. Exercise all 7 tools. Verify JSON-RPC responses match the schemas defined in section 4.

6. **Container test:** Build Dockerfile. Run container with mounted home directory. Verify `/healthz` returns 200. Verify `/mcp` accepts MCP initialize handshake. Verify tool list returns 3 profiles.

7. **Partial failure test:** Configure two tools, make one profile point to a nonexistent path. Call `sync_to_storage()` (all tools). Verify the valid tool succeeds and the invalid tool appears in `warnings`, not as a server error.
