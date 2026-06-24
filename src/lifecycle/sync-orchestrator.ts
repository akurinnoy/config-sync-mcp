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

  constructor(private readonly config: OrchestratorConfig) {
    this.debounceWindowMs = config.debounceWindowMs ?? DEFAULT_DEBOUNCE_MS;
  }

  handleTransition(event: TransitionEvent): void {
    if (this.stopped) return;

    const direction = TRANSITION_TO_DIRECTION[`${event.previousPhase}:${event.newPhase}`];
    if (!direction) return;

    const key = `${event.workspace}:${direction}`;

    if (this.isCircuitOpen(key)) {
      console.log(`[lifecycle-sync] circuit-breaker-open workspace=${event.workspace} direction=${direction}`);
      return;
    }

    if (direction === 'push') {
      this.executeSync(event.workspace, direction);
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
  }

  async shutdown(): Promise<void> {
    this.stopped = true;

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

  private executeSync(workspace: string, direction: SyncDirection): void {
    const key = `${workspace}:${direction}`;

    // Concurrency: skip if already in-flight for this key
    if (this.inFlight.has(key)) return;

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

  private isCircuitOpen(key: string): boolean {
    return (this.failureCounts.get(key) ?? 0) >= CIRCUIT_BREAKER_THRESHOLD;
  }
}
