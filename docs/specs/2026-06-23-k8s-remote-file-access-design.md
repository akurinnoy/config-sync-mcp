# Specification: K8s Client for Remote File Access via Pod Exec

> Council synthesis from Claude Opus 4.6, Gemini 3 Pro, GPT-5.3 Codex.
> Issue: akurinnoy/agentic-workspaces#149

## 1. Problem

`config-sync-mcp` assumes server and workspace share a filesystem. In centralized deployment, the server runs in its own pod while workspace files live inside separate workspace pods. Node.js `fs` and `fast-glob` calls reach only the server's local disk, making multi-workspace sync impossible. File operations must be remoted into target pods via the Kubernetes exec API while preserving local-mode behavior for development and testing.

## 2. Design

### 2.1 FileAccess Interface

A single abstraction consumed by `SyncEngine` and `resolveFiles`. Two implementations selected by runtime configuration.

```typescript
interface FileAccess {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  stat(path: string): Promise<{
    isFile: boolean;
    isDirectory: boolean;
    mtimeMs: number;
  }>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  glob(patterns: string[], cwd: string): Promise<string[]>;
  realpath(path: string): Promise<string>;
}
```

Design constraints on all implementations:
- Binary-safe: `readFile`/`writeFile` must handle arbitrary byte content without corruption.
- Consistent error model: throw typed `FileAccessError` with `code` (ENOENT, EACCES, EXEC_FAILED, TIMEOUT), `path`, and `message`.
- Path handling: all paths are absolute within the target filesystem.

### 2.2 LocalFileAccess

Wraps existing `node:fs/promises` (`readFile`, `writeFile`, `stat`, `mkdir`, `realpath`) and `fast-glob`. This is a mechanical extraction of the current code into the interface shape. Existing test coverage carries over.

### 2.3 KubeFileAccess

Wraps a `KubeWorkspaceClient` (see 2.4). Translates each interface method to a shell command exec'd into the target pod:

| Method | Command | Notes |
|--------|---------|-------|
| `readFile` | `base64 <path>` | Decode stdout from base64 to prevent binary corruption over WebSocket |
| `writeFile` | `base64 -d > <path>` | Pipe base64-encoded content via stdin |
| `stat` | `stat -c '%F %Y' <path>` | Parse file type and mtime from output |
| `mkdir` | `mkdir -p <path>` | Direct |
| `glob` | `bash -c 'shopt -s globstar nullglob; for f in <escaped-patterns>; do [ -f "$f" ] && echo "$f"; done'` | See section 5 |
| `realpath` | `realpath <path>` | Direct |

All commands wrapped in `bash -lc '...'`. Non-zero exit codes produce typed `FileAccessError`. All path arguments must be shell-escaped before interpolation (no raw user input in command strings).

### 2.4 KubeWorkspaceClient (separate module)

Responsibilities: kube config initialization, namespace detection, pod discovery, and raw exec execution. Separated from FileAccess because it manages connection lifecycle and RBAC concerns that are orthogonal to filesystem semantics.

- **Init**: `KubeConfig.loadFromDefault()` — works in-cluster (ServiceAccount) and locally (kubeconfig).
- **Namespace detection**: `POD_NAMESPACE` env var, then `/var/run/secrets/kubernetes.io/serviceaccount/namespace`, then kubeconfig current context.
- **Pod discovery**: `coreV1Api.listNamespacedPod({ labelSelector })` where the label selector identifies workspace pods (e.g., `controller.devfile.io/devworkspace_id=<id>`). The label selector pattern must be configurable.
- **Exec**: `new k8s.Exec(kubeConfig).exec(namespace, podName, containerName, command, ...)` returning `{ stdout: Buffer, stderr: string, exitCode: number }`.
- **Timeouts**: every exec call must enforce a configurable timeout (default 30s). WebSocket connections that exceed the timeout are terminated.
- **RBAC requirement**: the server's ServiceAccount needs `pods/exec` and `pods` (get, list) permissions in workspace namespaces.

### 2.5 Workspace Targeting

Each FileAccess operation targets a specific workspace. The `KubeFileAccess` constructor takes `(client: KubeWorkspaceClient, namespace: string, podName: string, containerName: string)`. The caller (SyncEngine orchestration layer) resolves workspace identity to these coordinates before constructing the FileAccess instance.

## 3. Files to Create/Modify

**Create:**

| File | Purpose |
|------|---------|
| `src/file-access/interface.ts` | `FileAccess` interface and `FileAccessError` type |
| `src/file-access/local.ts` | `LocalFileAccess` — wraps `node:fs/promises` + `fast-glob` |
| `src/file-access/remote.ts` | `KubeFileAccess` — translates interface to exec commands |
| `src/file-access/index.ts` | Barrel export |
| `src/k8s/client.ts` | `KubeWorkspaceClient` — kube init, pod discovery, exec wrapper |

**Modify:**

| File | Change |
|------|--------|
| `src/sync/engine.ts` | Accept `FileAccess` via constructor; remove direct `fs` imports |
| `src/profiles/resolver.ts` | Accept `FileAccess` parameter; replace `fg()` with `fileAccess.glob()`, `realpath()` with `fileAccess.realpath()` |
| `src/types.ts` | Add `FileAccessError` type, workspace target types |
| `package.json` | Add `@kubernetes/client-node` dependency |
| `src/index.ts` | Mode selection, FileAccess factory |

## 4. Mode Selection and Backward Compatibility

Environment variable `FILE_ACCESS_MODE=local|remote` (default: `local`). When `remote`, the kube client initializes and `KubeFileAccess` is injected. When `local`, `LocalFileAccess` is injected. `SyncEngine` and `resolveFiles` are transport-agnostic — they only see `FileAccess`.

This preserves the current local development workflow unchanged. No kube dependency is loaded or initialized in local mode.

## 5. Glob Resolution via Exec

Remote glob resolution runs inside the pod's shell to avoid transferring directory listings:

```bash
bash -lc 'cd <cwd> && shopt -s globstar nullglob; for f in <patterns>; do [ -f "$f" ] && echo "$f"; done' | sort
```

Design constraints:
- **Shell escaping**: all pattern strings must be escaped before interpolation. No raw user input in the command.
- **nullglob**: prevents literal pattern strings from appearing in output when no files match.
- **Files only**: the `-f` test excludes directories from results (matching current `fast-glob` behavior).
- **Deterministic order**: pipe through `sort` for consistent output across runs.
- **Fallback**: for patterns that exceed bash globbing capabilities or produce errors, fall back to `find <cwd> -type f | grep -E <pattern>`.
- **Output limit**: if stdout exceeds a configurable threshold (default 1MB), truncate and return an error indicating too many matches.

## 6. Open Design Questions

Deferred to implementation or follow-up issues:

- **Batched file operations**: for sync operations touching many files, per-file exec calls may be prohibitively slow. A `tar`-based bulk read/write mechanism may be needed. This spec defines the per-file interface; batching is an optimization to layer on top.
- **Connection pooling**: concurrent access to multiple workspace pods may strain the kube API server. Whether to pool or limit concurrent exec connections is an operational concern for implementation.
- **Container image assumptions**: the exec commands assume `bash`, `base64`, `stat`, `realpath`, `sort`, and `find` are available in the target container. This should be validated against workspace container images.

## 7. Validation

- **Unit tests**: mock `FileAccess` interface for SyncEngine and resolver tests. No cluster or kube dependency needed.
- **Contract tests**: a shared test suite that runs against both `LocalFileAccess` and a mocked `KubeFileAccess` to verify behavioral parity (same inputs produce same outputs).
- **KubeWorkspaceClient tests**: mock `k8s.Exec` streams (stdout/stderr buffers, exit codes) to verify correct command construction, timeout enforcement, and error propagation.
- **Golden tests**: for glob resolution, capture current `fast-glob` output for a set of test patterns and verify remote glob produces identical results.
- **Local mode smoke test**: run the full sync flow in local mode to confirm backward compatibility is unbroken.
