import type { SyncEngine } from '../sync/engine.js';

export async function handleSyncFromStorage(engine: SyncEngine, tool?: string) {
  const profiles = tool ? [tool] : engine.getProfiles().map((p) => p.tool);
  const synced: any[] = [];
  const warnings: string[] = [];

  for (const t of profiles) {
    try {
      const result = await engine.pullConfig(t);
      synced.push({
        tool: result.tool,
        filesWritten: result.filesWritten,
        bytesWritten: result.bytesWritten,
        version: result.version,
      });
    } catch (err) {
      warnings.push(`${t}: ${(err as Error).message}`);
    }
  }

  return { synced, warnings };
}
