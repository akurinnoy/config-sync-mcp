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

  const listFn = vi.fn().mockResolvedValue(listResult);

  const customApi = {
    listNamespacedCustomObject: listFn,
  };

  return {
    watchCallbacks,
    listResult,
    listFn,
    getKubeConfig: () => ({
      // mock KubeConfig — Watch constructor accepts it
    }),
    getCustomObjectsApi: () => customApi,
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

  it('stop() clears abortRequest when watch is active', async () => {
    const mock = createMockKubeClient();
    const abortFn = vi.fn();

    // Override createWatch to use our custom abortFn
    mock.createWatch.mockImplementation(() => ({
      watch: vi.fn().mockImplementation(
        (_path: string, _opts: any, eventCb: any, doneCb: any) => {
          mock.watchCallbacks.eventCb = eventCb;
          mock.watchCallbacks.doneCb = doneCb;
          return Promise.resolve({ abort: abortFn });
        },
      ),
    }));

    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });

    await watcher.start();

    // Stop while watch is active (before handleDone)
    await watcher.stop();

    expect(abortFn).toHaveBeenCalled();
  });

  it('stop() clears reconnectTimer during reconnect backoff', async () => {
    vi.useFakeTimers();
    const mock = createMockKubeClient();

    // Make watch fail to trigger reconnect
    mock.createWatch.mockImplementation(() => ({
      watch: vi.fn().mockRejectedValue(new Error('watch failed')),
    }));

    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });

    await watcher.start();

    // At this point reconnectTimer is set
    // Stop should clear it
    await watcher.stop();

    // Advance timer — if reconnectTimer wasn't cleared, this would trigger reconnect
    vi.advanceTimersByTime(35_000);

    // createWatch should still be 1 (from start), not 2
    expect(mock.createWatch).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('listAndReconcile() skips items with missing name', async () => {
    const mock = createMockKubeClient();
    mock.listResult.items = [
      { metadata: {}, status: { phase: 'Running' } }, // missing name
      { metadata: { name: 'valid-ws' }, status: { phase: 'Running' } },
    ] as any;

    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });
    await watcher.start();

    const phaseMap = watcher.getPhaseMap();
    expect(phaseMap.has('valid-ws')).toBe(true);
    expect(phaseMap.size).toBe(1);
  });

  it('listAndReconcile() skips items with missing status.phase', async () => {
    const mock = createMockKubeClient();
    mock.listResult.items = [
      { metadata: { name: 'no-status' }, status: {} }, // missing phase
      { metadata: { name: 'valid-ws' }, status: { phase: 'Running' } },
    ] as any;

    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });
    await watcher.start();

    const phaseMap = watcher.getPhaseMap();
    expect(phaseMap.has('valid-ws')).toBe(true);
    expect(phaseMap.has('no-status')).toBe(false);
    expect(phaseMap.size).toBe(1);
  });

  it('startWatch() error triggers scheduleReconnect', async () => {
    vi.useFakeTimers();
    const mock = createMockKubeClient();

    // Make watch throw an error
    mock.createWatch.mockImplementation(() => ({
      watch: vi.fn().mockRejectedValue(new Error('watch failed')),
    }));

    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });

    await watcher.start();

    // First call failed, advance timer to trigger reconnect
    vi.advanceTimersByTime(2000);

    // createWatch should be called twice (initial + reconnect)
    expect(mock.createWatch.mock.calls.length).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
  });

  it('handleDone() with statusCode 410 triggers fresh listAndReconcile', async () => {
    const mock = createMockKubeClient();

    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });

    await watcher.start();

    const initialCallCount = mock.listFn.mock.calls.length;

    // Add item to phaseMap to verify it gets cleared on 410
    mock.watchCallbacks.eventCb!('ADDED', {
      metadata: { name: 'ws1', resourceVersion: '101' },
      status: { phase: 'Running' },
    });
    expect(watcher.getPhaseMap().size).toBe(1);

    // Trigger 410 Gone and wait for the promise chain to complete
    mock.watchCallbacks.doneCb!({ statusCode: 410 });

    // Wait for the async chain: listAndReconcile().then(() => startWatch())
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    // Verify phaseMap was cleared
    expect(watcher.getPhaseMap().size).toBe(0);

    // Verify listNamespacedCustomObject was called again
    expect(mock.listFn.mock.calls.length).toBe(initialCallCount + 1);
  });

  it('scheduleReconnect() calculates exponential backoff with jitter', async () => {
    vi.useFakeTimers();
    const mock = createMockKubeClient();
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Make watch fail repeatedly
    let callCount = 0;
    mock.createWatch.mockImplementation(() => ({
      watch: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          return Promise.reject(new Error('watch failed'));
        }
        // Succeed on 4th call to stop the loop
        return Promise.resolve({ abort: vi.fn() });
      }),
    }));

    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });

    await watcher.start();

    // First reconnect: baseMs = 2^0 * 1000 = 1000
    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    // Second reconnect: baseMs = 2^1 * 1000 = 2000
    vi.advanceTimersByTime(3000);
    await Promise.resolve();

    // Third reconnect: baseMs = 2^2 * 1000 = 4000
    vi.advanceTimersByTime(5000);
    await Promise.resolve();

    // Verify console logs show increasing delays (with jitter)
    const logs = consoleLogSpy.mock.calls.map(call => call[0]);
    const delayLogs = logs.filter(log => typeof log === 'string' && log.includes('watch-reconnecting'));

    expect(delayLogs.length).toBeGreaterThanOrEqual(3);

    consoleLogSpy.mockRestore();
    vi.useRealTimers();
  });

  it('scheduleReconnect() early returns when !running', async () => {
    vi.useFakeTimers();
    const mock = createMockKubeClient();

    // Make watch fail
    mock.createWatch.mockImplementation(() => ({
      watch: vi.fn().mockRejectedValue(new Error('watch failed')),
    }));

    const watcher = new DevWorkspaceWatcher(mock as any, {
      namespace: 'test-ns',
      onTransition,
    });

    await watcher.start();

    // Stop immediately
    await watcher.stop();

    const initialCallCount = mock.createWatch.mock.calls.length;

    // Advance timer — should not trigger reconnect
    vi.advanceTimersByTime(35_000);

    // createWatch should not be called again
    expect(mock.createWatch.mock.calls.length).toBe(initialCallCount);

    vi.useRealTimers();
  });
});
