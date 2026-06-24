# Specification: Auto-Sync on Workspace Lifecycle Events

> Council synthesis from Claude Opus 4.6, Gemini 3 Pro, GPT-5.3 Codex.
> Issue: akurinnoy/agentic-workspaces#152

## 1. Problem

Users must manually invoke `sync_from_storage` and `sync_to_storage` MCP tools at the right moments. This has three failure modes:

- **Missed restore**: A workspace starts without pulling configs. The user works with stale or missing configurations.
- **Missed backup**: A workspace stops before the user pushes. Config changes are lost.
- **Race with shutdown**: The user remembers to push but the workspace terminates before the sync completes.

Manual sync is opt-in and timing-dependent. Lifecycle-driven sync is deterministic: restore on start, backup on stop, zero user action required.

## 2. Design

A lifecycle sync subsystem runs only when `FILE_ACCESS_MODE=remote`. It consists of two components:

- **DevWorkspaceWatcher**: manages the Kubernetes watch stream, tracks per-workspace phase state, detects transitions, and emits transition events.
- **SyncOrchestrator**: receives transition events, applies debouncing, resolves workspaces through `WorkspaceResolver`, constructs `SyncEngine` instances, and executes sync operations asynchronously.

Separation is mandatory: the watch loop must never block on sync execution.

### Trigger Rules

| Previous Phase | New Phase | Action | Method |
|---|---|---|---|
| `Starting` | `Running` | Pull configs into workspace | `SyncEngine.pullConfig()` for all configured profiles |
| `Running` | `Stopping` | Push configs from workspace | `SyncEngine.pushConfig()` for all configured profiles |
| `Running` | `Failing` | Best-effort push | `SyncEngine.pushConfig()` for all configured profiles |

All other transitions are logged at debug level but do not trigger sync.

**Transition validation**: The watcher must track `lastSeenPhase` per workspace and only fire triggers when an actual phase *change* occurs. A `MODIFIED` event where the phase has not changed from the last-seen value is ignored.

### Cold-Start Reconciliation

On startup, the watcher performs a `List` operation before starting the `Watch` stream. For each workspace currently in `Running` phase, it triggers `pullConfig()`. The `resourceVersion` from the `List` response is used as the starting point for the `Watch` stream.

### Sync Execution Model

Each sync operation runs as an independent async task. The orchestrator:
1. Resolves the workspace via `WorkspaceResolver` to obtain `FileAccess`
2. Constructs a new `SyncEngine(profiles, storage, homeDir, fileAccess)`
3. Executes `pullConfig()` or `pushConfig()` for all configured profiles
4. Logs the result

## 3. Files to Create/Modify

| File | Action | Purpose |
|---|---|---|
| `src/lifecycle/types.ts` | Create | `WorkspacePhase` enum, `TransitionEvent` interface, `WatcherConfig` interface |
| `src/lifecycle/devworkspace-watcher.ts` | Create | Watch stream management, phase tracking, transition detection, reconnect logic |
| `src/lifecycle/sync-orchestrator.ts` | Create | Debounce registry, concurrency control, sync dispatch, circuit breaker |
| `src/k8s/client.ts` | Modify | Add `Watch` client and `CustomObjectsApi` initialization |
| `src/index.ts` | Modify | Instantiate watcher and orchestrator in remote mode; wire shutdown handler |

## 4. DevWorkspace Watch

### Watch Target

```
Group:    workspace.devfile.io
Version:  v1alpha2
Resource: devworkspaces
Path:     /apis/workspace.devfile.io/v1alpha2/namespaces/{namespace}/devworkspaces
```

### Event Processing

Process `ADDED`, `MODIFIED`, and `DELETED` events. Extract `metadata.name` and `status.phase`.

- `ADDED`: record phase in state map. If phase is `Running` and not cold-start replay, treat as `Starting -> Running`.
- `MODIFIED`: compare `status.phase` against `lastSeenPhase`. If changed, evaluate trigger table. Update `lastSeenPhase`.
- `DELETED`: remove from state map, cancel pending debounced actions.

### Reconnect Strategy

- **Stream `end`**: reconnect immediately using last `resourceVersion`.
- **Stream `error`**: exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s. Add jitter (0-500ms).
- **`410 Gone`**: fresh `List` to get current state and new `resourceVersion`, restart `Watch`.

### Idempotency Guard

Per-workspace record of last acted transition (type + timestamp). Reconnect replays within 60s dedup window are skipped.

## 5. Debouncing Strategy

Per-workspace, per-direction debounce keys: `{workspaceName}:{direction}` where direction is `pull` or `push`.

- **Window**: 3 seconds (configurable).
- **Directional independence**: pull and push debounces operate independently.
- **Concurrency limit**: at most one in-flight sync per workspace per direction.

### Pull vs. Push Race

If `pullConfig` is in-flight when `Running -> Stopping` fires:
1. Let pull complete (or cancel if possible)
2. Queue push to execute after
3. Log warning — push takes priority for data preservation

## 6. Error Handling

### Sync Failures

- Wrap every sync in try/catch. Never propagate to watch stream.
- Log with structured fields: timestamp, workspace, previousPhase, newPhase, action, error, duration.
- **Circuit breaker**: 3 consecutive failures per workspace+direction suppresses until new transition cycle. Log suppression.

### Graceful Shutdown

1. Stop watch stream
2. Cancel pending debounce timers
3. Wait for in-flight syncs with 30s drain timeout
4. Log warning if drain timeout exceeded

## 7. Validation

### Unit Tests

- Transition detection with synthetic event sequences
- Debounce: rapid transitions produce exactly one sync call
- Directional independence
- Reconnect: stream end, error, 410 scenarios
- Circuit breaker: suppression and reset
- Cold-start: List returning various phases
- Idempotency guard: dedup within window
- Concurrency race: pull in-flight when Stopping fires

### Integration Tests

- Mock WorkspaceResolver and SyncEngine
- Verify full pipeline: watch event -> transition -> debounce -> resolve -> sync
