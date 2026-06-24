import type { ToolProfile } from '../types.js';

export function handleListTools(profiles: ToolProfile[]) {
  return {
    tools: profiles.map((p) => ({
      tool: p.tool,
      name: p.name,
      syncPathCount: p.paths.sync.length,
      skipPathCount: p.paths.skip.length,
    })),
  };
}
