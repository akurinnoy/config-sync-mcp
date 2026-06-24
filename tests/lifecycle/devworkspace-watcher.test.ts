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
