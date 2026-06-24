import type { SyncEngine } from '../sync/engine.js';

export async function handleSyncToStorage(
  engine: SyncEngine,
  tool?: string,
  message?: string,
) {
  const profiles = tool ? [tool] : engine.getProfiles().map((p) => p.tool);
  const pushed: any[] = [];
  const warnings: string[] = [];

  for (const t of profiles) {
    try {
      const result = await engine.pushConfig(t, message);
      pushed.push({
        tool: result.tool,
        version: result.version,
        filesStored: result.filesStored,
        bytesStored: result.bytesStored,
        checksum: result.checksum,
      });
      warnings.push(...result.warnings);
    } catch (err) {
      warnings.push(`${t}: ${(err as Error).message}`);
    }
  }

  return { pushed, warnings };
}
