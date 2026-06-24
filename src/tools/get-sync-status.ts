import type { SyncEngine } from '../sync/engine.js';

export function handleGetSyncStatus(engine: SyncEngine, tool?: string) {
  const statuses = engine.getSyncStatus(tool);
  return {
    tools: statuses.map((s) => ({
      tool: s.tool,
      lastSyncTime: s.lastSyncTime,
      lastSyncDirection: s.lastSyncDirection,
      pendingChanges: 0,
      status: (s as any).status ?? (s.lastSyncTime ? 'synced' : 'never_synced'),
    })),
  };
}
