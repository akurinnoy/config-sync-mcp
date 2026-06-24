import type { SyncEngine } from '../sync/engine.js';

export async function handleDiffConfig(engine: SyncEngine, tool: string, version?: string) {
  const diffs = await engine.diffConfig(tool, version);
  return { diffs };
}
