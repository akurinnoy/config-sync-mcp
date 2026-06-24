import { resolve } from 'node:path';
import type { FileAccess } from '../file-access/interface.js';
import type { ToolProfile, ResolvedFile } from '../types.js';

export async function resolveFiles(
  profile: ToolProfile,
  homeDir: string,
  fileAccess: FileAccess,
): Promise<ResolvedFile[]> {
  const syncPatterns = profile.paths.sync.map((p) => p.replace(/^~\//, ''));
  const skipPatterns = profile.paths.skip.map((p) => p.replace(/^~\//, ''));
  const sensitivePatterns = profile.paths.sensitive.map((p) => p.replace(/^~\//, ''));

  const allIgnore = [...skipPatterns, ...sensitivePatterns];

  const matched = await fileAccess.glob(syncPatterns, {
    cwd: homeDir,
    dot: true,
    ignore: allIgnore,
  });

  const resolved: ResolvedFile[] = [];

  for (const rel of matched) {
    const abs = resolve(homeDir, rel);

    const s = await fileAccess.lstat(abs);
    if (s.isSymbolicLink) {
      const target = await fileAccess.realpath(abs);
      if (!target.startsWith(homeDir)) {
        continue;
      }
    }

    resolved.push({ absolutePath: abs, relativePath: rel });
  }

  return resolved;
}
