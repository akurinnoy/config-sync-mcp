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

    // Advance past debounce (30s for pull)
    await vi.advanceTimersByTimeAsync(30100);

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

    await vi.advanceTimersByTimeAsync(30100);

    // Two calls: one pull + one periodic push (both fire at ~30s)
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
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

    // Push fires immediately
    await vi.advanceTimersByTimeAsync(100);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);

    // Pull timer was scheduled but workspace is no longer Running
    // executePullWithRetry checks runningWorkspaces.has() and returns early
    resolver.resolve.mockClear();
    await vi.advanceTimersByTimeAsync(30100);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('suppresses after 3 consecutive failures (circuit breaker)', async () => {
    resolver.resolve.mockRejectedValue(new Error('pod not found'));

    // Trigger 3 failures
    for (let i = 0; i < 3; i++) {
      orchestrator.handleTransition(makeTransition());
      await vi.advanceTimersByTimeAsync(30100);
      await vi.advanceTimersByTimeAsync(100); // let async settle
    }

    // 4th trigger should be suppressed
    resolver.resolve.mockClear();
    orchestrator.handleTransition(makeTransition());
    await vi.advanceTimersByTimeAsync(30100);

    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('resets circuit breaker on new transition cycle', async () => {
    resolver.resolve.mockRejectedValue(new Error('pod not found'));

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      orchestrator.handleTransition(makeTransition());
      await vi.advanceTimersByTimeAsync(30100);
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
    await vi.advanceTimersByTimeAsync(30100);

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
    await vi.advanceTimersByTimeAsync(35000);

    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('starts periodic push 30s after workspace reaches Running', async () => {
    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Starting',
      newPhase: 'Running',
    }));

    // At 30.1s: both pull and initial periodic push fire (both use 30s default)
    await vi.advanceTimersByTimeAsync(30100);
    expect(resolver.resolve).toHaveBeenCalledTimes(2); // pull + initial periodic push

    // Advance one full interval with jitter (300s * 1.15 max = 345s)
    resolver.resolve.mockClear();
    await vi.advanceTimersByTimeAsync(350000);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it('repeats periodic push at configured interval', async () => {
    const customOrchestrator = new SyncOrchestrator({
      profiles: testProfiles,
      storage,
      homeDir: '/home/user',
      resolver,
      debounceWindowMs: 3000,
      periodicPushIntervalMs: 60000,
      initialPushDelayMs: 10000,
      initialPullDelayMs: 5000, // shorter than initial push delay
    });

    customOrchestrator.handleTransition(makeTransition({
      previousPhase: 'Starting',
      newPhase: 'Running',
    }));

    // Advance past pull delay (5s) + periodic push delay (10s)
    await vi.advanceTimersByTimeAsync(10100);
    const callsAfterInitial = resolver.resolve.mock.calls.length;
    expect(callsAfterInitial).toBeGreaterThanOrEqual(2); // pull + initial push

    // Advance one full interval (60s) — should get another push
    resolver.resolve.mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(resolver.resolve).toHaveBeenCalled();

    await customOrchestrator.shutdown();
  });

  it('cancels periodic push timer when workspace stops', async () => {
    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Starting',
      newPhase: 'Running',
    }));

    // Advance past initial delay to confirm timer is active
    await vi.advanceTimersByTimeAsync(31000);
    const callsBeforeStop = resolver.resolve.mock.calls.length;
    expect(callsBeforeStop).toBeGreaterThanOrEqual(2); // pull + initial push

    // Stop the workspace
    resolver.resolve.mockClear();
    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Running',
      newPhase: 'Stopping',
    }));

    // The stop-time push fires immediately
    await vi.advanceTimersByTimeAsync(100);
    const stopPushCalls = resolver.resolve.mock.calls.length;

    // Advance past where the next periodic push would fire — should NOT trigger
    resolver.resolve.mockClear();
    await vi.advanceTimersByTimeAsync(300000);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('stop-time push bypasses circuit breaker', async () => {
    resolver.resolve.mockRejectedValue(new Error('pod not found'));

    // Trip the breaker with 3 failures via periodic pushes
    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Starting',
      newPhase: 'Running',
    }));

    // Advance past initial delay + settle for periodic pushes to fail
    await vi.advanceTimersByTimeAsync(31000);
    await vi.advanceTimersByTimeAsync(100);
    // Two more periodic intervals to trip the breaker (3 total failures)
    await vi.advanceTimersByTimeAsync(300000);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(300000);
    await vi.advanceTimersByTimeAsync(100);

    // Now stop — the stop-time push should still fire despite breaker
    resolver.resolve.mockClear();
    resolver.resolve.mockResolvedValue({
      readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn(), lstat: vi.fn(),
      mkdir: vi.fn(), glob: vi.fn().mockResolvedValue([]), realpath: vi.fn(),
    });

    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Running',
      newPhase: 'Stopping',
    }));

    await vi.advanceTimersByTimeAsync(100);
    expect(resolver.resolve).toHaveBeenCalled();
  });

  it('delays pull by initialPullDelayMs (default 30s) instead of debounce', async () => {
    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Starting',
      newPhase: 'Running',
    }));

    // At 3.1s: old debounce would have fired — should NOT fire
    await vi.advanceTimersByTimeAsync(3100);
    expect(resolver.resolve).not.toHaveBeenCalled();

    // At 30s: should fire now
    await vi.advanceTimersByTimeAsync(27000);
    expect(resolver.resolve).toHaveBeenCalledWith('ws1');
  });

  it('retries pull on failure with exponential backoff', async () => {
    let pullCount = 0;
    let pushCount = 0;
    resolver.resolve.mockImplementation(() => {
      // The periodic push fires at the same time as pull, so we need to track separately
      // We can't easily distinguish in the mock, so let's just count all calls
      const totalCalls = pullCount + pushCount + 1;
      // First call is pull (fails), second is periodic push (succeeds), third is retry (succeeds)
      if (totalCalls === 1) {
        pullCount++;
        return Promise.reject(new Error('Exec timed out'));
      }
      pushCount++;
      return Promise.resolve({
        readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn(), lstat: vi.fn(),
        mkdir: vi.fn(), glob: vi.fn().mockResolvedValue([]), realpath: vi.fn(),
      });
    });

    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Starting',
      newPhase: 'Running',
    }));

    // Initial pull at 30s — fails (periodic push also fires and succeeds)
    await vi.advanceTimersByTimeAsync(30100);
    await vi.advanceTimersByTimeAsync(100); // let async settle
    expect(resolver.resolve).toHaveBeenCalledTimes(2); // pull + periodic push

    // First retry at 30s after failure — succeeds
    await vi.advanceTimersByTimeAsync(30100);
    await vi.advanceTimersByTimeAsync(100);
    expect(resolver.resolve).toHaveBeenCalledTimes(3); // pull + periodic push + retry
  });

  it('aborts pull retry when workspace leaves Running', async () => {
    resolver.resolve.mockRejectedValue(new Error('Exec timed out'));

    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Starting',
      newPhase: 'Running',
    }));

    // Initial pull at 30s — fails (periodic push also fails)
    await vi.advanceTimersByTimeAsync(30100);
    await vi.advanceTimersByTimeAsync(100);
    expect(resolver.resolve).toHaveBeenCalledTimes(2); // pull + periodic push both fail

    // Workspace stops before retry fires
    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Running',
      newPhase: 'Stopping',
    }));

    // The stop-time push fires but also fails
    await vi.advanceTimersByTimeAsync(100);
    expect(resolver.resolve).toHaveBeenCalledTimes(3); // pull + periodic push + stop push

    // Advance past retry delay — should NOT retry because workspace is no longer Running
    resolver.resolve.mockClear();
    await vi.advanceTimersByTimeAsync(30100);
    await vi.advanceTimersByTimeAsync(100);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('retries pull when per-tool errors occur (doSync does not swallow all failures)', async () => {
    const failingStorage = createMockStorage();
    (failingStorage.retrieve as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('No versions found for tool "claude-code"'),
    );

    const retryOrchestrator = new SyncOrchestrator({
      profiles: testProfiles,
      storage: failingStorage,
      homeDir: '/home/user',
      resolver,
      initialPullDelayMs: 30000,
      pullRetryCount: 1,
    });

    const consoleSpy = vi.spyOn(console, 'log');

    retryOrchestrator.handleTransition(makeTransition({
      previousPhase: 'Starting',
      newPhase: 'Running',
    }));

    // Initial pull at 30s — all tools fail (retrieve rejects)
    await vi.advanceTimersByTimeAsync(30100);
    await vi.advanceTimersByTimeAsync(100);

    // Should schedule a retry since doSync should propagate failure
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('pull-retry'),
    );

    consoleSpy.mockRestore();
    await retryOrchestrator.shutdown();
  });

  it('logs pull-exhausted when all retries fail', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    resolver.resolve.mockRejectedValue(new Error('Exec timed out'));

    orchestrator.handleTransition(makeTransition({
      previousPhase: 'Starting',
      newPhase: 'Running',
    }));

    // Initial pull at 30s — fails
    await vi.advanceTimersByTimeAsync(30100);
    await vi.advanceTimersByTimeAsync(100);

    // Retry 1 at 30s — fails
    await vi.advanceTimersByTimeAsync(30100);
    await vi.advanceTimersByTimeAsync(100);

    // Retry 2 at 60s — fails
    await vi.advanceTimersByTimeAsync(60100);
    await vi.advanceTimersByTimeAsync(100);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('pull-exhausted'),
    );
    consoleSpy.mockRestore();
  });
});
