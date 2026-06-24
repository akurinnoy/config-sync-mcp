# Specification: Add `workspace` Parameter to MCP Tools

> Council synthesis from Claude Opus 4.6, Gemini 3 Pro, GPT-5.3 Codex.
> Issue: akurinnoy/agentic-workspaces#150

## 1. Problem

The config-sync-mcp server binds all filesystem operations to a single workspace at startup via `TARGET_WORKSPACE`. One `KubeFileAccess` and one `SyncEngine` are constructed at process initialization and shared across all tool calls. This makes centralized deployment impossible: a single server instance cannot serve multiple workspaces because every tool call is hardwired to the same pod.

## 2. Design

### Workspace Resolution

Introduce a `WorkspaceResolver` interface:

```typescript
interface WorkspaceResolver {
  resolve(workspace: string): Promise<FileAccess>;
}
```

Two implementations:

- **`KubeWorkspaceResolver`** (remote mode): Calls `KubeWorkspaceClient.findWorkspacePod(workspace)` to obtain `{podName, containerName}`, then constructs and returns a `KubeFileAccess(client, podName, containerName)`.

- **`LocalWorkspaceResolver`** (local mode): Accepts the `workspace` parameter for API consistency but returns a shared `LocalFileAccess` instance regardless of the value.

### Engine Lifecycle

A new `SyncEngine` is created per tool call that requires filesystem access. The resolver produces a `FileAccess`; the tool handler constructs `new SyncEngine(profiles, storage, homeDir, fileAccess)` and executes the operation. Shared dependencies (`profiles`, `storage`, `homeDir`) are initialized once at startup and passed to `createMcpServer`.

Rationale: the `SyncEngine` constructor is lightweight (stores references), so per-call construction is trivially cheap and avoids changing every public method signature on the engine.

### Server Initialization

`createMcpServer` signature changes to:

```typescript
createMcpServer(config: {
  profiles: ToolProfile[];
  storage: StorageBackend;
  homeDir: string;
  resolver: WorkspaceResolver;
})
```

### Tool Call Flow (workspace-requiring tools)

```
Tool call → extract workspace param → resolver.resolve(workspace) → FileAccess
  → new SyncEngine(profiles, storage, homeDir, fileAccess) → execute operation → return result
```

### Error Contract

When workspace resolution fails, return an MCP error with:
- Message: `Workspace "<workspace>" not found: no running pod matches`
- The workspace name must always appear in the error message.

### `TARGET_WORKSPACE` Deprecation

`TARGET_WORKSPACE` becomes optional. If set, it serves as the default workspace when the parameter is missing from a tool call (backward compatibility). If not set and no `workspace` parameter is provided, the tool returns an error requesting the parameter.

## 3. Files to Modify

| File | Change |
|------|--------|
| `src/index.ts` | Remove single-workspace FileAccess and SyncEngine creation. Initialize shared deps. Construct WorkspaceResolver. Pass config object to createMcpServer. |
| `src/server.ts` | Change createMcpServer signature to accept config object with resolver. Update 5 tool handlers to extract workspace, call resolver.resolve(), construct per-call engine. |
| `src/sync/engine.ts` | No API changes required. Constructor remains (profiles, storage, homeDir, fileAccess). |
| **New:** `src/workspace-resolver.ts` | WorkspaceResolver interface, KubeWorkspaceResolver, LocalWorkspaceResolver. |
| `tests/integration/server.test.ts` | Update to new createMcpServer signature. Mock WorkspaceResolver. |
| `tests/sync/engine.test.ts` | Verify engine still works with per-call construction pattern. |

## 4. MCP Tool Schema Changes

**Tools gaining `workspace` parameter** (required, or optional if `TARGET_WORKSPACE` is set):
- `sync_from_storage`
- `sync_to_storage`
- `diff_config`
- `rollback_config`
- `get_sync_status`

**Unchanged tools (no `workspace` parameter):**
- `list_tools`
- `list_config_versions`

## 5. Validation

| Scenario | Verification |
|----------|-------------|
| Multi-workspace routing | Call sync_to_storage targeting workspace-a and workspace-b sequentially. Verify distinct pod resolution. |
| Local mode passthrough | In local mode, call tools with varying workspace values. All succeed using LocalFileAccess. |
| Nonexistent workspace | Call any workspace-requiring tool with invalid workspace. Verify error contains workspace name. |
| TARGET_WORKSPACE fallback | Set env var, omit workspace from tool call. Verify it uses env var value. |
| Missing workspace, no default | Unset env var, omit workspace. Verify error requesting parameter. |
| Existing tests pass | All tests pass after refactoring with mocked resolver. |
