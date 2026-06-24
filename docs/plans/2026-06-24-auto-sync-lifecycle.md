# Auto-Sync on Workspace Lifecycle Events — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically sync dev tool configs on workspace start (pull) and stop (push) by watching DevWorkspace CRD phase transitions.

**Architecture:** Two separated components — `DevWorkspaceWatcher` manages the k8s watch stream and detects phase transitions, `SyncOrchestrator` receives transition events and executes syncs with debouncing, concurrency control, and circuit breaker. The watch loop never blocks on sync execution. Only active when `FILE_ACCESS_MODE=remote`.

**Tech Stack:** `@kubernetes/client-node` (Watch, CustomObjectsApi), existing SyncEngine + WorkspaceResolver patterns

## Global Constraints

- ESM with `.js` extensions on all imports, Node16 module resolution
- Only active when `FILE_ACCESS_MODE=remote` — no lifecycle code loaded or started in local mode
- Watch target: `/apis/workspace.devfile.io/v1alpha2/namespaces/{ns}/devworkspaces`
- Trigger rules: `Starting→Running` = pullConfig, `Running→Stopping` = pushConfig, `Running→Failing` = best-effort pushConfig
- Debounce: 3 seconds, per-workspace per-direction
- Circuit breaker: 3 consecutive failures per workspace+direction, reset on new transition cycle
- Graceful shutdown: 30s drain timeout for in-flight syncs
- All git commits must use `-s` flag (signoff)
- Spec: `docs/specs/2026-06-24-auto-sync-lifecycle-design.md`
- Issue: akurinnoy/agentic-workspaces#152

---

### Task 1: Lifecycle types, KubeWorkspaceClient extension, and DevWorkspaceWatcher

**Files:**
- Create: `src/lifecycle/types.ts`
- Create: `src/lifecycle/devworkspace-watcher.ts`
- Modify: `src/k8s/client.ts`
- Create: `tests/lifecycle/devworkspace-watcher.test.ts`

**Interfaces:**
- Consumes: `KubeWorkspaceClient` from `src/k8s/client.ts` (will add `getKubeConfig()`, `getCustomObjectsApi()` methods)
- Produces: `WorkspacePhase` type, `TransitionEvent` interface, `TransitionCallback` type, `DevWorkspaceWatcher` class with `start(): Promise<void>`, `stop(): Promise<void>`, `getPhaseMap(): Map<string, WorkspacePhase>`

- [ ] **Step 1: Create src/lifecycle/types.ts**

```typescript
export type WorkspacePhase = 'Starting' | 'Running' | 'Stopping' | 'Stopped' | 'Failing' | 'Failed';

export interface TransitionEvent {
  workspace: string;
  previousPhase: WorkspacePhase;
  newPhase: WorkspacePhase;
  timestamp: string;
}

export type TransitionCallback = (event: TransitionEvent) => void;

export interface WatcherConfig {
  namespace: string;
  onTransition: TransitionCallback;
  debounceWindowMs?: number;
}
```

- [ ] **Step 2: Modify src/k8s/client.ts — add Watch and CustomObjectsApi**

Add to the `KubeWorkspaceClient` class:

```typescript
// New private fields (add alongside existing ones):
private customObjectsApi!: k8s.CustomObjectsApi;

// In initialize(), after the coreV1Api line:
this.customObjectsApi = this.kubeConfig.makeApiClient(k8s.CustomObjectsApi);

// New public methods:
getKubeConfig(): k8s.KubeConfig {
  return this.kubeConfig;
}

getCustomObjectsApi(): k8s.CustomObjectsApi {
  return this.customObjectsApi;
}
```

- [ ] **Step 3: Write failing tests for DevWorkspaceWatcher**

Create `tests/lifecycle/devworkspace-watcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DevWorkspaceWatcher } from '../../src/lifecycle/devworkspace-watcher.js';
import type { TransitionEvent, TransitionCallback } from '../../src/lifecycle/types.js';

// Mock k8s Watch to emit synthetic events
function createMockKubeClient() {
  const watchCallbacks: {
    eventCb?: (type: string, obj: any) => void;
    doneCb?: (err: any) => void;
  } = {};

  const listResult = {
    metadata: { resourceVersion: '100' },
    items: [],
  };

  return {
    watchCallbacks,
    listResult,
    getKubeConfig: () => ({
      // mock KubeConfig — Watch constructor accepts it
    }),
    getCustomObjectsApi: () => ({
      listNamespacedCustomObject: vi.fn().mockResolvedValue(listResult),
    }),
    getNamespace: () => 'test-ns',
    // Provide a mock Watch factory
    createWatch: vi.fn().mockImplementation(() => ({
      watch: vi.fn().mockImplementation(
        (_path: string, _opts: any, eventCb: any, doneCb: any) => {
          watchCallbacks.eventCb = eventCb;
          watchCallbacks.doneCb = doneCb;
          return Promise.resolve({ abort: vi.fn() });
        },
      ),
    })),
  };
}

describe('DevWorkspaceWatcher', () => {
  let transitions: TransitionEvent[];
  let onTransition: TransitionCallback;

  beforeEach(() => {
    transitions = [];
    onTransition = (event) => transitions.push(event);
  });

  it('detects Starting → Running transition', async () => {
    const mock = createMockKubeClient();
    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });
    await watcher.start();

    // Simulate ADDED with Starting phase
    mock.watchCallbacks.eventCb!('ADDED', {
      metadata: { name: 'ws1', resourceVersion: '101' },
      status: { phase: 'Starting' },
    });

    // Simulate MODIFIED to Running
    mock.watchCallbacks.eventCb!('MODIFIED', {
      metadata: { name: 'ws1', resourceVersion: '102' },
      status: { phase: 'Running' },
    });

    expect(transitions).toHaveLength(1);
    expect(transitions[0].workspace).toBe('ws1');
    expect(transitions[0].previousPhase).toBe('Starting');
    expect(transitions[0].newPhase).toBe('Running');
  });

  it('detects Running → Stopping transition', async () => {
    const mock = createMockKubeClient();
    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });
    await watcher.start();

    mock.watchCallbacks.eventCb!('ADDED', {
      metadata: { name: 'ws1', resourceVersion: '101' },
      status: { phase: 'Running' },
    });
    mock.watchCallbacks.eventCb!('MODIFIED', {
      metadata: { name: 'ws1', resourceVersion: '102' },
      status: { phase: 'Stopping' },
    });

    expect(transitions).toHaveLength(1);
    expect(transitions[0].previousPhase).toBe('Running');
    expect(transitions[0].newPhase).toBe('Stopping');
  });

  it('detects Running → Failing transition', async () => {
    const mock = createMockKubeClient();
    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });
    await watcher.start();

    mock.watchCallbacks.eventCb!('ADDED', {
      metadata: { name: 'ws1', resourceVersion: '101' },
      status: { phase: 'Running' },
    });
    mock.watchCallbacks.eventCb!('MODIFIED', {
      metadata: { name: 'ws1', resourceVersion: '102' },
      status: { phase: 'Failing' },
    });

    expect(transitions).toHaveLength(1);
    expect(transitions[0].newPhase).toBe('Failing');
  });

  it('ignores MODIFIED events without phase change', async () => {
    const mock = createMockKubeClient();
    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });
    await watcher.start();

    mock.watchCallbacks.eventCb!('ADDED', {
      metadata: { name: 'ws1', resourceVersion: '101' },
      status: { phase: 'Running' },
    });
    // Same phase — should be ignored
    mock.watchCallbacks.eventCb!('MODIFIED', {
      metadata: { name: 'ws1', resourceVersion: '102' },
      status: { phase: 'Running' },
    });

    expect(transitions).toHaveLength(0);
  });

  it('removes workspace on DELETED event', async () => {
    const mock = createMockKubeClient();
    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });
    await watcher.start();

    mock.watchCallbacks.eventCb!('ADDED', {
      metadata: { name: 'ws1', resourceVersion: '101' },
      status: { phase: 'Running' },
    });
    mock.watchCallbacks.eventCb!('DELETED', {
      metadata: { name: 'ws1', resourceVersion: '103' },
      status: { phase: 'Stopped' },
    });

    expect(watcher.getPhaseMap().has('ws1')).toBe(false);
  });

  it('performs cold-start reconciliation for Running workspaces', async () => {
    const mock = createMockKubeClient();
    mock.listResult.items = [
      { metadata: { name: 'ws-running' }, status: { phase: 'Running' } },
      { metadata: { name: 'ws-stopped' }, status: { phase: 'Stopped' } },
    ] as any;

    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });
    await watcher.start();

    // Only Running workspace should trigger a pull transition
    const runningTransitions = transitions.filter((t) => t.workspace === 'ws-running');
    expect(runningTransitions).toHaveLength(1);
    expect(runningTransitions[0].previousPhase).toBe('Starting');
    expect(runningTransitions[0].newPhase).toBe('Running');

    // Stopped workspace should not trigger
    const stoppedTransitions = transitions.filter((t) => t.workspace === 'ws-stopped');
    expect(stoppedTransitions).toHaveLength(0);
  });

  it('does not fire duplicate transitions for same phase', async () => {
    const mock = createMockKubeClient();
    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });
    await watcher.start();

    mock.watchCallbacks.eventCb!('ADDED', {
      metadata: { name: 'ws1', resourceVersion: '101' },
      status: { phase: 'Starting' },
    });
    mock.watchCallbacks.eventCb!('MODIFIED', {
      metadata: { name: 'ws1', resourceVersion: '102' },
      status: { phase: 'Running' },
    });
    // Same transition again (reconnect replay)
    mock.watchCallbacks.eventCb!('MODIFIED', {
      metadata: { name: 'ws1', resourceVersion: '102' },
      status: { phase: 'Running' },
    });

    expect(transitions).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/lifecycle/devworkspace-watcher.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 5: Implement DevWorkspaceWatcher**

Create `src/lifecycle/devworkspace-watcher.ts`:

```typescript
import * as k8s from '@kubernetes/client-node';
import type { KubeWorkspaceClient } from '../k8s/client.js';
import type { WorkspacePhase, TransitionEvent, WatcherConfig } from './types.js';

const TRIGGER_TRANSITIONS: Record<string, string[]> = {
  'Starting': ['Running'],
  'Running': ['Stopping', 'Failing'],
};

export class DevWorkspaceWatcher {
  private phaseMap = new Map<string, WorkspacePhase>();
  private lastResourceVersion = '';
  private abortRequest: (() => void) | null = null;
  private running = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: KubeWorkspaceClient,
    private readonly config: WatcherConfig,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    await this.listAndReconcile();
    await this.startWatch();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortRequest) {
      this.abortRequest();
      this.abortRequest = null;
    }
  }

  getPhaseMap(): Map<string, WorkspacePhase> {
    return new Map(this.phaseMap);
  }

  private async listAndReconcile(): Promise<void> {
    const customApi = this.client.getCustomObjectsApi();
    const result = await customApi.listNamespacedCustomObject({
      group: 'workspace.devfile.io',
      version: 'v1alpha2',
      namespace: this.config.namespace,
      plural: 'devworkspaces',
    });

    const response = result as any;
    this.lastResourceVersion = response.metadata?.resourceVersion ?? '';
    const items: any[] = response.items ?? [];

    for (const item of items) {
      const name = item.metadata?.name;
      const phase = item.status?.phase as WorkspacePhase | undefined;
      if (!name || !phase) continue;

      this.phaseMap.set(name, phase);

      if (phase === 'Running') {
        this.emitTransition(name, 'Starting', 'Running');
      }
    }
  }

  private async startWatch(): Promise<void> {
    if (!this.running) return;

    const kubeConfig = this.client.getKubeConfig();
    const watch = new k8s.Watch(kubeConfig);
    const path = `/apis/workspace.devfile.io/v1alpha2/namespaces/${this.config.namespace}/devworkspaces`;

    try {
      const req = await watch.watch(
        path,
        { resourceVersion: this.lastResourceVersion },
        (type: string, obj: any) => this.handleEvent(type, obj),
        (err: any) => this.handleDone(err),
      );

      this.abortRequest = () => req.abort();
      this.reconnectAttempts = 0;
    } catch (err) {
      this.scheduleReconnect();
    }
  }

  private handleEvent(type: string, obj: any): void {
    const name = obj.metadata?.name;
    const phase = obj.status?.phase as WorkspacePhase | undefined;
    const resourceVersion = obj.metadata?.resourceVersion;

    if (!name) return;
    if (resourceVersion) this.lastResourceVersion = resourceVersion;

    if (type === 'DELETED') {
      this.phaseMap.delete(name);
      return;
    }

    if (!phase) return;

    const previousPhase = this.phaseMap.get(name);
    this.phaseMap.set(name, phase);

    if (type === 'ADDED' && phase === 'Running' && !previousPhase) {
      this.emitTransition(name, 'Starting', 'Running');
      return;
    }

    if (type === 'MODIFIED' && previousPhase && previousPhase !== phase) {
      const validTargets = TRIGGER_TRANSITIONS[previousPhase];
      if (validTargets?.includes(phase)) {
        this.emitTransition(name, previousPhase, phase);
      }
    }
  }

  private handleDone(err: any): void {
    this.abortRequest = null;
    if (!this.running) return;

    if (err?.statusCode === 410) {
      this.phaseMap.clear();
      this.listAndReconcile().then(() => this.startWatch()).catch(() => this.scheduleReconnect());
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    const baseMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    const jitter = Math.floor(Math.random() * 500);
    const delay = baseMs + jitter;

    this.reconnectAttempts++;
    console.log(`[lifecycle-sync] watch-reconnecting delay=${delay}ms attempt=${this.reconnectAttempts}`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startWatch();
    }, delay);
  }

  private emitTransition(workspace: string, previousPhase: WorkspacePhase, newPhase: WorkspacePhase): void {
    this.config.onTransition({
      workspace,
      previousPhase,
      newPhase,
      timestamp: new Date().toISOString(),
    });
  }
}
```

- [ ] **Step 6: Run watcher tests**

Run: `npx vitest run tests/lifecycle/devworkspace-watcher.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 7: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (existing + 7 new)

- [ ] **Step 8: Commit**

```bash
git add src/lifecycle/ src/k8s/client.ts tests/lifecycle/
git commit -s -m "feat: DevWorkspaceWatcher with phase tracking and cold-start reconciliation"
```

---

### Task 2: SyncOrchestrator with debouncing, circuit breaker, and index.ts wiring

**Files:**
- Create: `src/lifecycle/sync-orchestrator.ts`
- Modify: `src/index.ts`
- Create: `tests/lifecycle/sync-orchestrator.test.ts`

**Interfaces:**
- Consumes: `TransitionEvent` from `src/lifecycle/types.ts`; `WorkspaceResolver` from `src/workspace-resolver.ts`; `SyncEngine` from `src/sync/engine.ts`; `DevWorkspaceWatcher` from Task 1; `ToolProfile`, `StorageBackend` from `src/types.ts`
- Produces: `SyncOrchestrator` class with `handleTransition(event: TransitionEvent): void`, `shutdown(): Promise<void>`

- [ ] **Step 1: Write failing tests for SyncOrchestrator**

Create `tests/lifecycle/sync-orchestrator.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncOrchestrator } from '../../src/lifecycle/sync-orchestrator.js';
import type { TransitionEvent } from '../../src/lifecycle/types.js';
import type { ToolProfile, StorageBackend } from '../../src/types.js';

function createMockResolver() {
  return {
    resolve: vi.fn().mockResolvedValue({
      readFile: vi.fn(),
      writeFile: vi.fn(),
      stat: vi.fn(),
      lstat: vi.fn(),
      mkdir: vi.fn(),
      glob: vi.fn().mockResolvedValue([]),
      realpath: vi.fn(),
    }),
  };
}

function createMockStorage(): StorageBackend {
  return {
    initialize: vi.fn(),
    store: vi.fn().mockResolvedValue({ version: 'v1' }),
    retrieve: vi.fn().mockResolvedValue({
      tool: 'test',
      version: 'v1',
      timestamp: new Date().toISOString(),
      manifest: [],
      files: new Map(),
    }),
    listVersions: vi.fn().mockResolvedValue([]),
    deleteVersion: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
  };
}

const testProfiles: ToolProfile[] = [
  { tool: 'claude-code', name: 'Claude Code', paths: { sync: ['~/.claude/settings.json'], skip: [], sensitive: [] } },
];

function makeTransition(overrides: Partial<TransitionEvent> = {}): TransitionEvent {
  return {
    workspace: 'ws1',
    previousPhase: 'Starting',
    newPhase: 'Running',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('SyncOrchestrator', () => {
  let orchestrator: SyncOrchestrator;
  let resolver: ReturnType<typeof createMockResolver>;
  let storage: StorageBackend;

  beforeEach(() => {
    vi.useFakeTimers();
    resolver = createMockResolver();
    storage = createMockStorage();
    orchestrator = new SyncOrchestrator({
      profiles: testProfiles,
      storage,
      homeDir: '/home/user',
      resolver,
      debounceWindowMs: 3000,
    });
  });

  afterEach(async () => {
    await orchestrator.shutdown();
    vi.useRealTimers();
  });

  it('triggers pull on Starting → Running after debounce', async () => {
    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Starting',
      newPhase: 'Running',
    }));

    // Before debounce window — no sync yet
    expect(resolver.resolve).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(3100);

    expect(resolver.resolve).toHaveBeenCalledWith('ws1');
  });

  it('triggers push on Running → Stopping after debounce', async () => {
    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Running',
      newPhase: 'Stopping',
    }));

    await vi.advanceTimersByTimeAsync(3100);

    expect(resolver.resolve).toHaveBeenCalledWith('ws1');
  });

  it('triggers push on Running → Failing after debounce', async () => {
    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Running',
      newPhase: 'Failing',
    }));

    await vi.advanceTimersByTimeAsync(3100);

    expect(resolver.resolve).toHaveBeenCalledWith('ws1');
  });

  it('debounces rapid transitions for same workspace+direction', async () => {
    orchestrator.handleTransition(makeTransition());
    orchestrator.handleTransition(makeTransition());
    orchestrator.handleTransition(makeTransition());

    await vi.advanceTimersByTimeAsync(3100);

    // Only one resolve call despite 3 transitions
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it('pull and push debounce independently', async () => {
    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Starting',
      newPhase: 'Running',
    }));
    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Running',
      newPhase: 'Stopping',
    }));

    await vi.advanceTimersByTimeAsync(3100);

    // Two calls — one for pull, one for push
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
  });

  it('suppresses after 3 consecutive failures (circuit breaker)', async () => {
    resolver.resolve.mockRejectedValue(new Error('pod not found'));

    // Trigger 3 failures
    for (let i = 0; i < 3; i++) {
      orchestrator.handleTransition(makeTransition());
      await vi.advanceTimersByTimeAsync(3100);
      await vi.advanceTimersByTimeAsync(100); // let async settle
    }

    // 4th trigger should be suppressed
    resolver.resolve.mockClear();
    orchestrator.handleTransition(makeTransition());
    await vi.advanceTimersByTimeAsync(3100);

    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('resets circuit breaker on new transition cycle', async () => {
    resolver.resolve.mockRejectedValue(new Error('pod not found'));

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      orchestrator.handleTransition(makeTransition());
      await vi.advanceTimersByTimeAsync(3100);
      await vi.advanceTimersByTimeAsync(100);
    }

    // New transition cycle (different direction resets pull breaker)
    resolver.resolve.mockResolvedValue({
      readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn(), lstat: vi.fn(),
      mkdir: vi.fn(), glob: vi.fn().mockResolvedValue([]), realpath: vi.fn(),
    });

    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Running',
      newPhase: 'Stopping',
    }));
    await vi.advanceTimersByTimeAsync(3100);

    // Push direction should work (different direction, different breaker)
    expect(resolver.resolve).toHaveBeenCalled();
  });

  it('ignores non-trigger transitions', () => {
    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Stopping',
      newPhase: 'Stopped',
    }));

    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('shutdown cancels pending debounce timers', async () => {
    orchestrator.handleTransition(makeTransition());

    // Shutdown before debounce fires
    await orchestrator.shutdown();
    await vi.advanceTimersByTimeAsync(5000);

    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lifecycle/sync-orchestrator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SyncOrchestrator**

Create `src/lifecycle/sync-orchestrator.ts`:

```typescript
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

    // Cancel existing debounce for this key
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
```

- [ ] **Step 4: Run orchestrator tests**

Run: `npx vitest run tests/lifecycle/sync-orchestrator.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Modify src/index.ts — wire lifecycle in remote mode**

After the `startHttpServer` call, add lifecycle startup (only in remote mode):

```typescript
// Add at the top, after existing imports:
import type { DevWorkspaceWatcher } from './lifecycle/devworkspace-watcher.js';
import type { SyncOrchestrator as SyncOrchestratorType } from './lifecycle/sync-orchestrator.js';

// After the startHttpServer call and before the shutdown handler:
let watcher: DevWorkspaceWatcher | null = null;
let orchestrator: SyncOrchestratorType | null = null;

if (mode === 'remote') {
  const { DevWorkspaceWatcher: WatcherClass } = await import('./lifecycle/devworkspace-watcher.js');
  const { SyncOrchestrator } = await import('./lifecycle/sync-orchestrator.js');

  orchestrator = new SyncOrchestrator({
    profiles,
    storage,
    homeDir: home,
    resolver,
  });

  watcher = new WatcherClass(kubeClient!, {
    namespace: kubeClient!.getNamespace(),
    onTransition: (event) => orchestrator!.handleTransition(event),
  });

  await watcher.start();
  console.log('Lifecycle watcher started — auto-sync enabled');
}

// Update the shutdown handler to include lifecycle cleanup:
const shutdown = async () => {
  console.log('Shutting down...');
  if (watcher) await watcher.stop();
  if (orchestrator) await orchestrator.shutdown();
  await shutdownHttpServer(server);
  process.exit(0);
};
```

Note: `kubeClient` is the `KubeWorkspaceClient` already created in the `if (mode === 'remote')` block above. You need to keep a reference to it outside the block. Move the `let kubeClient` declaration before the `if` block and assign inside.

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (existing + 7 watcher + 9 orchestrator)

- [ ] **Step 7: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/lifecycle/sync-orchestrator.ts src/index.ts tests/lifecycle/sync-orchestrator.test.ts
git commit -s -m "feat: SyncOrchestrator with debouncing and circuit breaker, wire lifecycle into index"
```
