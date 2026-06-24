import type { SyncEngine } from '../sync/engine.js';

export async function handleRollbackConfig(engine: SyncEngine, tool: string, version: string) {
  const result = await engine.pullConfig(tool, version);
  return {
    restored: {
      tool: result.tool,
      version: result.version,
      filesWritten: result.filesWritten,
      bytesWritten: result.bytesWritten,
    },
  };
}
