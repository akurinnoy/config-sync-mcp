import type { StorageBackend } from '../types.js';
import { DEFAULT_VERSIONS_LIMIT } from '../types.js';

export async function handleListConfigVersions(
  storage: StorageBackend,
  tool: string,
  limit?: number,
) {
  const versions = await storage.listVersions(tool, limit ?? DEFAULT_VERSIONS_LIMIT);
  return { versions };
}
