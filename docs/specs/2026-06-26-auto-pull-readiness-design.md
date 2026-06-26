# Specification: Auto-Pull Readiness — Delayed Pull with Retry

**Issue:** akurinnoy/agentic-workspaces#176

## 1. Problem

The auto-pull on `Starting→Running` fires with a 3s debounce, but the workspace container isn't ready to accept `kubectl exec` at that point. The exec times out after 30s. The DevWorkspace CRD transitions to `Running` when the pod reaches Running phase, but the user container may still be initializing (shell, filesystem mounts, init scripts).

This means configs stored by periodic push (#173) are never restored into new workspaces, breaking the sync workflow.

## 2. Design

### Delayed initial pull

Change the pull delay from the generic 3s `debounceWindowMs` to a dedicated `initialPullDelayMs` config field (default 30000ms). This gives the container time to fully initialize before the first exec attempt. The `debounceWindowMs` remains for deduplicating rapid transitions — the pull delay is the minimum wait after `Starting→Running`.

### Retry with exponential backoff

When `doSync` for a pull direction fails, retry up to `pullRetryCount` times (default 2) with exponential backoff:
- First retry: 30s after failure
- Second retry: 60s after failure

Retry conditions:
- Only retries pull, not push
- Aborts immediately if the workspace is no longer in the `runningWorkspaces` set
- Aborts if the orchestrator is stopped (shutdown in progress)
- Each retry is a fresh `doSync` call (new resolver, new SyncEngine)

### Config

Two new fields on `OrchestratorConfig`:
- `initialPullDelayMs?: number` — default `30000` (30 seconds)
- `pullRetryCount?: number` — default `2`

### Observability

Log events:
- `pull-retry workspace=X attempt=N/M delay=Ns reason=<error>` — before each retry
- `pull-retry-success workspace=X attempt=N/M` — when a retry succeeds
- `pull-exhausted workspace=X attempts=N` — when all retries fail

### No changes needed

- `src/lifecycle/types.ts` — config is in `sync-orchestrator.ts`
- `src/k8s/client.ts` — exec timeout unchanged
- `src/sync/engine.ts` — no changes
- Watcher — no changes

## 3. Files to Modify

- **`src/lifecycle/sync-orchestrator.ts`** — Add `initialPullDelayMs` and `pullRetryCount` config fields. Use `initialPullDelayMs` instead of `debounceWindowMs` for pull delay in `handleTransition`. Add retry loop in `executeSync` or a new `executeSyncWithRetry` wrapper for pull direction.
- **`tests/lifecycle/sync-orchestrator.test.ts`** — Test delayed pull at 30s, retry on failure, abort when workspace stops, exhaust retries.

## 4. Validation

**Unit tests (fake timers):**
- Pull fires at 30s (not 3s) after `Starting→Running`
- Pull retries on failure with 30s then 60s backoff
- Retry aborts if workspace leaves Running set
- All retries exhausted logs `pull-exhausted`
- Retry succeeds on second attempt after initial failure
- Existing push behavior unchanged (immediate, no retry)
