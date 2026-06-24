import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ToolProfile } from '../types.js';

const homePrefixPattern = /^~\//;

const profileSchema = z.object({
  tool: z.string().regex(/^[a-z][a-z0-9-]*$/, 'tool must match ^[a-z][a-z0-9-]*$'),
  name: z.string().min(1),
  paths: z.object({
    sync: z
      .array(z.string().refine((p) => homePrefixPattern.test(p), 'paths must start with ~/'))
      .min(1, 'sync must have at least one entry'),
    skip: z.array(z.string()),
    sensitive: z.array(z.string()),
  }),
});

export async function loadProfiles(dir: string): Promise<ToolProfile[]> {
  const entries = await readdir(dir);
  const yamlFiles = entries.filter(
    (f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('._'),
  );

  const profiles: ToolProfile[] = [];

  for (const file of yamlFiles) {
    const content = await readFile(join(dir, file), 'utf-8');
    const raw = parseYaml(content);
    const parsed = profileSchema.parse(raw);
    profiles.push(parsed);
  }

  return profiles;
}
