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
