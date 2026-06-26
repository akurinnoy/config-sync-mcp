# Specification: Periodic Push While Workspace is Running

**Issue:** akurinnoy/agentic-workspaces#173

## 1. Problem

The `Running→Stopping` push races against container shutdown. By the time the MCP pod attempts `kubectl exec`, workspace containers are often already terminated. The glob resolves empty (nullglob, exit 0), and an empty manifest silently overwrites valid stored configs. Cross-workspace sync is broken because configs are never actually persisted.

## 2. Design

### Periodic push owned by SyncOrchestrator

The orchestrator already owns sync execution, concurrency guards, and circuit breakers. The watcher remains a pure lifecycle event source with no API changes.

### Running-state tracking

The orchestrator maintains:
- `runningWorkspaces: Set<string>` — workspaces currently in Running phase
- `periodicTimers: Map<string, NodeJS.Timeout>` — per-workspace interval handles
- `lastSuccessfulPushAt: Map<string, Date>` — for observability/staleness detection

### Timer lifecycle by transition

| Transition | Action |
|---|---|
| `Starting→Running` | Add to running set. Schedule one-shot push at 30s (initial stabilization delay). Start `setInterval` at configured period with per-workspace jitter. |
| `Running→Stopping` | Cancel timer, remove from running set. Execute existing best-effort stop-time push (unchanged). |
| `Running→Failing` | Cancel timer, remove from running set. Execute existing best-effort push (unchanged). |
| `Stopping→Stopped`, `Failing→Failed` | Cleanup guard: cancel timer if still present, remove from running set. |

### Cold-start reconciliation

The watcher already synthesizes `Starting→Running` transitions for workspaces found Running at MCP pod boot. No special handling needed — periodic timers start correctly on restart.

### Interval and jitter

Default `periodicPushIntervalMs` of 300000 (5 minutes), configurable. Each workspace's interval is offset by +/-15% random jitter (calculated once at timer creation) to prevent synchronized push storms across concurrent workspaces. Initial push delay defaults to 30000ms (`initialPushDelayMs`), also configurable.

### Concurrency

Periodic push calls existing `executeSync(workspace, 'push')`. The existing concurrency guard (skip if in-flight for same workspace+direction) prevents overlap between periodic and transition-triggered pushes. No new locking needed.

### In-flight push at stop time

Do not cancel active syncs. Let them complete naturally. Only cancel future scheduling. The concurrency guard prevents the stop-time push from running simultaneously.

### Circuit breaker policy

- Real push execution failures (exec errors, write errors) increment the existing push breaker (3 consecutive failures).
- Preflight failures where the workspace is not accessible or not in the running set are classified as `skipped` — no breaker increment.
- The stop-time push (`Running→Stopping`) bypasses the circuit breaker. It is a last-chance best-effort attempt and must always be tried regardless of prior periodic failures.
- The timer continues ticking when the breaker is open. When the breaker resets (on any successful push), the next tick resumes pushing.

### Empty-manifest guard (defense-in-depth)

Before persisting a push result, the sync engine must check: if the new manifest is empty and a non-empty manifest already exists in storage for this workspace+profile, refuse to overwrite. Log a warning. This prevents the original failure mode (silent overwrite with empty data) regardless of whether the push is periodic, transition-triggered, or manual. This guard belongs in the push path of the sync engine, not in the orchestrator.

### Observability

Add structured log events:
- `periodic-push-scheduled` — workspace, interval, jitter offset
- `periodic-push-completed` — workspace, duration, profiles synced
- `periodic-push-skipped` — workspace, reason (concurrency, not running, circuit breaker)
- `periodic-push-failed` — workspace, error, breaker count
- `periodic-push-empty-blocked` — workspace, profile (empty-manifest guard triggered)
- `periodic-timer-cancelled` — workspace, reason (transition, shutdown)

### Shutdown

`shutdown()` clears all periodic timers and the running set before invoking existing in-flight drain logic.

## 3. Files to Modify

- **`src/lifecycle/sync-orchestrator.ts`** — Add `runningWorkspaces` set, `periodicTimers` map, `lastSuccessfulPushAt` map. Modify `handleTransition` to start/cancel timers. Add timer creation helper with jitter. Stop-time breaker bypass. Update `shutdown()`.
- **`src/lifecycle/types.ts`** — Add `periodicPushIntervalMs?: number` and `initialPushDelayMs?: number` to orchestrator config.
- **`src/sync/engine.ts`** — Add empty-manifest guard in `pushConfig()`.
- **`tests/lifecycle/sync-orchestrator.test.ts`** — Test periodic push scheduling, cancellation, circuit breaker bypass, empty-manifest guard.

## 4. Validation

**Unit tests (fake timers):**
- `Starting→Running` schedules initial 30s push + periodic interval with jitter
- `Running→Stopping` cancels timer, removes from running set, fires stop-time push
- Concurrent periodic + stop-time push: concurrency guard prevents double execution
- Periodic failures increment breaker; "not accessible" skips do not
- Breaker at 3 failures stops periodic pushes; stop-time push still fires (breaker bypass)
- `shutdown()` clears all timers and drains in-flight
- Empty-manifest guard: refuses to overwrite non-empty manifest with empty one
