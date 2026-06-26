import { SyncEngine } from '../sync/engine.js';
import type { TransitionEvent } from './types.js';
import type { WorkspaceResolver } from '../workspace-resolver.js';
import type { ToolProfile, StorageBackend } from '../types.js';

type SyncDirection = 'pull' | 'push';

interface OrchestratorConfig {
  profiles: ToolProfile[];
  storage: StorageBackend;
  homeDir: string;
  resolver: WorkspaceResolver;
  debounceWindowMs?: number;
  periodicPushIntervalMs?: number;
  initialPushDelayMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 3000;
const CIRCUIT_BREAKER_THRESHOLD = 3;

const TRANSITION_TO_DIRECTION: Record<string, SyncDirection | undefined> = {
  'Starting:Running': 'pull',
  'Running:Stopping': 'push',
  'Running:Failing': 'push',
};

export class SyncOrchestrator {
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private readonly failureCounts = new Map<string, number>();
  private readonly inflightPromises = new Set<Promise<void>>();
  private readonly debounceWindowMs: number;
  private stopped = false;
  private readonly runningWorkspaces = new Set<string>();
  private readonly periodicTimers = new Map<string, { initial: ReturnType<typeof setTimeout> | null; interval: ReturnType<typeof setInterval> | null }>();
  private readonly periodicPushIntervalMs: number;
  private readonly initialPushDelayMs: number;

  constructor(private readonly config: OrchestratorConfig) {
    this.debounceWindowMs = config.debounceWindowMs ?? DEFAULT_DEBOUNCE_MS;
    this.periodicPushIntervalMs = config.periodicPushIntervalMs ?? 300_000;
    this.initialPushDelayMs = config.initialPushDelayMs ?? 30_000;
  }

  handleTransition(event: TransitionEvent): void {
    if (this.stopped) return;

    const direction = TRANSITION_TO_DIRECTION[`${event.previousPhase}:${event.newPhase}`];
    if (!direction) {
      // Periodic push timer management (even when no sync direction)
      if (event.previousPhase === 'Starting' && event.newPhase === 'Running') {
        this.startPeriodicPush(event.workspace);
      } else if (this.runningWorkspaces.has(event.workspace) && event.newPhase !== 'Running') {
        this.cancelPeriodicPush(event.workspace);
      }
      return;
    }

    const key = `${event.workspace}:${direction}`;

    if (direction === 'push') {
      // Stop-time push bypasses circuit breaker (last-chance fallback)
      this.executeSync(event.workspace, direction, true);
      // Cancel periodic timer if workspace is stopping
      if (this.runningWorkspaces.has(event.workspace)) {
        this.cancelPeriodicPush(event.workspace);
      }
      return;
    }

    // Debounce pull events only — push must be immediate (pod terminates fast)
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.executeSync(event.workspace, direction);
    }, this.debounceWindowMs);

    this.debounceTimers.set(key, timer);

    // Start periodic timer when workspace reaches Running
    if (event.previousPhase === 'Starting' && event.newPhase === 'Running') {
      this.startPeriodicPush(event.workspace);
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;

    // Cancel all periodic timers
    for (const workspace of this.runningWorkspaces) {
      this.cancelPeriodicPush(workspace);
    }
    this.runningWorkspaces.clear();

    // Cancel all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Wait for in-flight syncs with drain timeout
    if (this.inflightPromises.size > 0) {
      console.log(`[lifecycle-sync] draining ${this.inflightPromises.size} in-flight syncs`);
      const drain = Promise.all([...this.inflightPromises]);
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
      await Promise.race([drain, timeout]);
    }
  }

  private executeSync(workspace: string, direction: SyncDirection, bypassBreaker = false): void {
    const key = `${workspace}:${direction}`;

    if (!bypassBreaker && this.isCircuitOpen(key)) {
      console.log(`[lifecycle-sync] periodic-push-skipped workspace=${workspace} reason=circuit-breaker-open`);
      return;
    }

    // Concurrency: skip if already in-flight for this key
    if (this.inFlight.has(key)) {
      console.log(`[lifecycle-sync] periodic-push-skipped workspace=${workspace} reason=in-flight`);
      return;
    }

    this.inFlight.add(key);
    const action = direction === 'pull' ? 'pull' : 'push';
    console.log(`[lifecycle-sync] sync-started workspace=${workspace} action=${action}`);
    const startTime = Date.now();

    const promise = this.doSync(workspace, direction)
      .then(() => {
        const duration = Date.now() - startTime;
        console.log(`[lifecycle-sync] sync-completed workspace=${workspace} action=${action} duration=${duration}ms`);
        this.failureCounts.delete(key);
      })
      .catch((err) => {
        const duration = Date.now() - startTime;
        console.error(`[lifecycle-sync] sync-failed workspace=${workspace} action=${action} duration=${duration}ms error=${(err as Error).message}`);
        const count = (this.failureCounts.get(key) ?? 0) + 1;
        this.failureCounts.set(key, count);
      })
      .finally(() => {
        this.inFlight.delete(key);
        this.inflightPromises.delete(promise);
      });

    this.inflightPromises.add(promise);
  }

  private async doSync(workspace: string, direction: SyncDirection): Promise<void> {
    const fileAccess = await this.config.resolver.resolve(workspace);
    const engine = new SyncEngine(
      this.config.profiles,
      this.config.storage,
      this.config.homeDir,
      fileAccess,
    );

    for (const profile of this.config.profiles) {
      try {
        if (direction === 'pull') {
          await engine.pullConfig(profile.tool);
        } else {
          await engine.pushConfig(profile.tool, `auto-sync on workspace ${direction}`);
        }
      } catch (err) {
        console.error(`[lifecycle-sync] sync-failed workspace=${workspace} tool=${profile.tool} action=${direction} error=${(err as Error).message}`);
      }
    }
  }

  private startPeriodicPush(workspace: string): void {
    // Cancel any existing timer (idempotent for cold-start reconciliation)
    const timers = this.periodicTimers.get(workspace);
    if (timers) {
      if (timers.initial) clearTimeout(timers.initial);
      if (timers.interval) clearInterval(timers.interval);
      this.periodicTimers.delete(workspace);
    }

    this.runningWorkspaces.add(workspace);

    const jitter = 1 + (Math.random() * 0.3 - 0.15); // +/-15%
    const interval = Math.round(this.periodicPushIntervalMs * jitter);

    console.log(`[lifecycle-sync] periodic-push-scheduled workspace=${workspace} initialDelayMs=${this.initialPushDelayMs} intervalMs=${interval}`);

    const initial = setTimeout(() => {
      if (!this.runningWorkspaces.has(workspace)) return;
      this.executeSync(workspace, 'push');
    }, this.initialPushDelayMs);

    const periodic = setInterval(() => {
      if (!this.runningWorkspaces.has(workspace)) {
        this.cancelPeriodicPush(workspace);
        return;
      }
      this.executeSync(workspace, 'push');
    }, interval);

    this.periodicTimers.set(workspace, { initial, interval: periodic });
  }

  private cancelPeriodicPush(workspace: string): void {
    this.runningWorkspaces.delete(workspace);
    const timers = this.periodicTimers.get(workspace);
    if (timers) {
      if (timers.initial) clearTimeout(timers.initial);
      if (timers.interval) clearInterval(timers.interval);
      this.periodicTimers.delete(workspace);
      console.log(`[lifecycle-sync] periodic-timer-cancelled workspace=${workspace}`);
    }
  }

  private isCircuitOpen(key: string): boolean {
    return (this.failureCounts.get(key) ?? 0) >= CIRCUIT_BREAKER_THRESHOLD;
  }
}
