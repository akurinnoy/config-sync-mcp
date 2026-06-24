# Add Workspace Parameter to MCP Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `workspace` parameter to 5 MCP tools so the centralized server can target different workspace pods per tool call, using a `WorkspaceResolver` to create per-call `FileAccess` and `SyncEngine` instances.

**Architecture:** Introduce a `WorkspaceResolver` interface with `resolve(workspace: string): Promise<FileAccess>`. Two implementations: `LocalWorkspaceResolver` (ignores workspace, returns shared `LocalFileAccess`) and `KubeWorkspaceResolver` (calls `KubeWorkspaceClient.findWorkspacePod()`, returns `KubeFileAccess`). Each workspace-requiring tool call creates a fresh `SyncEngine` with the resolved `FileAccess`. `TARGET_WORKSPACE` becomes an optional default fallback.

**Tech Stack:** TypeScript, ESM, `@modelcontextprotocol/sdk`, `zod`, `vitest`

## Global Constraints

- ESM with `.js` extensions on all imports (Node16 module resolution)
- Tool names use `snake_case`
- All git commits use `-s` (signoff)
- Spec: `docs/specs/2026-06-23-add-workspace-param-design.md`
- `SyncEngine` constructor stays unchanged: `(profiles, storage, homeDir, fileAccess)`
- Engine is created per tool call (lightweight — stores references only)
- `list_tools` and `list_config_versions` remain workspace-independent
- Error messages must include workspace name when pod is not found
- `TARGET_WORKSPACE` env var becomes optional default, not removed

---

### Task 1: WorkspaceResolver interface and implementations

**Files:**
- Create: `src/workspace-resolver.ts`
- Modify: `src/tools/list-tools.ts`
- Create: `tests/workspace-resolver.test.ts`

**Interfaces:**
- Consumes: `FileAccess` from `src/file-access/interface.js`, `LocalFileAccess` from `src/file-access/local.js`, `KubeFileAccess` from `src/file-access/remote.js`, `KubeWorkspaceClient` from `src/k8s/client.js`, `ToolProfile` from `src/types.js`
- Produces: `WorkspaceResolver` interface (`resolve(workspace: string): Promise<FileAccess>`), `LocalWorkspaceResolver` class, `KubeWorkspaceResolver` class

- [ ] **Step 1: Write failing tests for WorkspaceResolver**

Create `tests/workspace-resolver.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { LocalWorkspaceResolver, KubeWorkspaceResolver } from '../src/workspace-resolver.js';
import { LocalFileAccess } from '../src/file-access/local.js';

describe('LocalWorkspaceResolver', () => {
  it('returns a LocalFileAccess regardless of workspace name', async () => {
    const resolver = new LocalWorkspaceResolver();
    const fa1 = await resolver.resolve('workspace-a');
    const fa2 = await resolver.resolve('workspace-b');
    expect(fa1).toBeInstanceOf(LocalFileAccess);
    expect(fa1).toBe(fa2);
  });
});

describe('KubeWorkspaceResolver', () => {
  it('calls findWorkspacePod and returns KubeFileAccess', async () => {
    const mockClient = {
      findWorkspacePod: vi.fn().mockResolvedValue({
        podName: 'ws-pod-abc',
        containerName: 'dev',
      }),
    };
    const resolver = new KubeWorkspaceResolver(mockClient as any);
    const fa = await resolver.resolve('my-workspace');

    expect(mockClient.findWorkspacePod).toHaveBeenCalledWith('my-workspace');
    expect(fa).toBeDefined();
  });

  it('throws with workspace name in error when pod not found', async () => {
    const mockClient = {
      findWorkspacePod: vi.fn().mockRejectedValue(new Error('no running pod')),
    };
    const resolver = new KubeWorkspaceResolver(mockClient as any);
    await expect(resolver.resolve('bad-workspace')).rejects.toThrow('bad-workspace');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workspace-resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement WorkspaceResolver**

Create `src/workspace-resolver.ts`:

```typescript
import type { FileAccess } from './file-access/interface.js';
import { LocalFileAccess } from './file-access/local.js';
import { KubeFileAccess } from './file-access/remote.js';
import type { KubeWorkspaceClient } from './k8s/client.js';

export interface WorkspaceResolver {
  resolve(workspace: string): Promise<FileAccess>;
}

export class LocalWorkspaceResolver implements WorkspaceResolver {
  private readonly fileAccess = new LocalFileAccess();

  async resolve(_workspace: string): Promise<FileAccess> {
    return this.fileAccess;
  }
}

export class KubeWorkspaceResolver implements WorkspaceResolver {
  constructor(private readonly client: KubeWorkspaceClient) {}

  async resolve(workspace: string): Promise<FileAccess> {
    let pod: { podName: string; containerName: string };
    try {
      pod = await this.client.findWorkspacePod(workspace);
    } catch (err) {
      throw new Error(
        `Workspace "${workspace}" not found: ${(err as Error).message}`,
      );
    }
    return new KubeFileAccess(this.client, pod.podName, pod.containerName);
  }
}
```

- [ ] **Step 4: Run resolver tests**

Run: `npx vitest run tests/workspace-resolver.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Update list-tools to accept profiles directly**

The current `handleListTools(engine)` calls `engine.getProfiles()` and `engine.getSyncStatus()`. Since `list_tools` is workspace-independent, it should take profiles directly. Replace `src/tools/list-tools.ts`:

```typescript
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
```

- [ ] **Step 6: Run all tests and commit**

Run: `npx vitest run`
Expected: Some tests may fail due to `handleListTools` signature change — that's expected, they'll be fixed in Task 2. The workspace-resolver tests and all non-integration tests should pass.

```bash
git add src/workspace-resolver.ts src/tools/list-tools.ts tests/workspace-resolver.test.ts
git commit -s -m "feat: add WorkspaceResolver interface and implementations"
```

---

### Task 2: Refactor server, index, and integration tests for per-call engine

**Files:**
- Modify: `src/server.ts`
- Modify: `src/index.ts`
- Modify: `tests/integration/server.test.ts`

**Interfaces:**
- Consumes: `WorkspaceResolver`, `LocalWorkspaceResolver`, `KubeWorkspaceResolver` from `src/workspace-resolver.js`; `SyncEngine` from `src/sync/engine.js`; `ToolProfile` from `src/types.js`; `handleListTools(profiles)` from `src/tools/list-tools.js`; all other tool handlers unchanged
- Produces: `createMcpServer(config: McpServerConfig)`, `startHttpServer(port, config)` with new signatures

- [ ] **Step 1: Rewrite server.ts with workspace-aware tool registration**

Replace `src/server.ts`. Key changes:
- `createMcpServer` takes a config object: `{ profiles, storage, homeDir, resolver, defaultWorkspace? }`
- 5 tools gain a `workspace` parameter (optional if `defaultWorkspace` is set, required otherwise)
- Each workspace-requiring handler: resolve workspace → create `SyncEngine` → call handler
- `list_tools` passes `config.profiles` directly
- `list_config_versions` passes `config.storage` directly (unchanged)

```typescript
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SyncEngine } from './sync/engine.js';
import type { StorageBackend, ToolProfile } from './types.js';
import type { WorkspaceResolver } from './workspace-resolver.js';
import { handleListTools } from './tools/list-tools.js';
import { handleGetSyncStatus } from './tools/get-sync-status.js';
import { handleSyncToStorage } from './tools/sync-to-storage.js';
import { handleSyncFromStorage } from './tools/sync-from-storage.js';
import { handleDiffConfig } from './tools/diff-config.js';
import { handleListConfigVersions } from './tools/list-config-versions.js';
import { handleRollbackConfig } from './tools/rollback-config.js';

export interface McpServerConfig {
  profiles: ToolProfile[];
  storage: StorageBackend;
  homeDir: string;
  resolver: WorkspaceResolver;
  defaultWorkspace?: string;
}

const transports = new Map<string, StreamableHTTPServerTransport>();

async function resolveEngine(config: McpServerConfig, workspace?: string): Promise<SyncEngine> {
  const ws = workspace ?? config.defaultWorkspace;
  if (!ws) {
    throw new Error('workspace parameter is required (no TARGET_WORKSPACE default configured)');
  }
  const fileAccess = await config.resolver.resolve(ws);
  return new SyncEngine(config.profiles, config.storage, config.homeDir, fileAccess);
}

function createMcpServer(config: McpServerConfig): McpServer {
  const server = new McpServer({
    name: 'config-sync-mcp',
    version: '0.1.0',
  });

  const workspaceParam = config.defaultWorkspace
    ? z.string().optional().describe('Target workspace name (defaults to TARGET_WORKSPACE)')
    : z.string().describe('Target workspace name');

  server.tool(
    'list_tools',
    'List all registered tool profiles',
    {},
    async () => {
      try {
        const result = handleListTools(config.profiles);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'get_sync_status',
    'Check last sync time and pending changes for a workspace',
    {
      workspace: workspaceParam,
      tool: z.string().optional().describe('Tool name (omit for all tools)'),
    },
    async ({ workspace, tool }) => {
      try {
        const engine = await resolveEngine(config, workspace);
        const result = handleGetSyncStatus(engine, tool);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'sync_to_storage',
    'Push workspace config to storage backend',
    {
      workspace: workspaceParam,
      tool: z.string().optional().describe('Tool name (omit for all tools)'),
      message: z.string().optional().describe('Version label'),
    },
    async ({ workspace, tool, message }) => {
      try {
        const engine = await resolveEngine(config, workspace);
        const result = await handleSyncToStorage(engine, tool, message);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'sync_from_storage',
    'Pull latest config from storage backend into a workspace',
    {
      workspace: workspaceParam,
      tool: z.string().optional().describe('Tool name (omit for all tools)'),
    },
    async ({ workspace, tool }) => {
      try {
        const engine = await resolveEngine(config, workspace);
        const result = await handleSyncFromStorage(engine, tool);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'diff_config',
    'Show differences between workspace config and stored config for a tool',
    {
      workspace: workspaceParam,
      tool: z.string().describe('Tool name'),
      version: z.string().optional().describe('Version to diff against (omit for latest)'),
    },
    async ({ workspace, tool, version }) => {
      try {
        const engine = await resolveEngine(config, workspace);
        const result = await handleDiffConfig(engine, tool, version);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'list_config_versions',
    'List available config snapshots/versions for a tool',
    {
      tool: z.string().describe('Tool name'),
      limit: z.number().int().min(1).max(100).optional().describe('Max versions to return (default: 20)'),
    },
    async ({ tool, limit }) => {
      try {
        const result = await handleListConfigVersions(config.storage, tool, limit);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'rollback_config',
    'Restore config from a previous version for a tool in a workspace',
    {
      workspace: workspaceParam,
      tool: z.string().describe('Tool name'),
      version: z.string().describe('Version to restore'),
    },
    async ({ workspace, tool, version }) => {
      try {
        const engine = await resolveEngine(config, workspace);
        const result = await handleRollbackConfig(engine, tool, version);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function normalizeToolCallArguments(body: unknown): void {
  const messages = Array.isArray(body) ? body : [body];
  for (const msg of messages) {
    if (
      msg &&
      typeof msg === 'object' &&
      'method' in msg &&
      (msg as any).method === 'tools/call' &&
      'params' in msg &&
      (msg as any).params &&
      (msg as any).params.arguments === null
    ) {
      (msg as any).params.arguments = {};
    }
  }
}

export async function startHttpServer(
  port: number,
  config: McpServerConfig,
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname === '/healthz' && req.method === 'GET') {
      const health = await config.storage.healthCheck();
      res.writeHead(health.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }

    if (url.pathname === '/mcp') {
      if (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE') {
        await handleMcpRequest(req, res, config);
      } else {
        res.writeHead(405).end('Method Not Allowed');
      }
      return;
    }

    res.writeHead(404).end('Not Found');
  });

  return new Promise((resolve, reject) => {
    server.listen(port, () => resolve(server));
    server.on('error', reject);
  });
}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: McpServerConfig,
): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  let parsedBody: unknown;
  if (req.method === 'POST') {
    const body = await readBody(req);
    try {
      parsedBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }
    normalizeToolCallArguments(parsedBody);
  }

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, parsedBody);
    return;
  }

  if (req.method === 'POST') {
    if (!sessionId && isInitializeRequest(parsedBody)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };

      const mcpServer = createMcpServer(config);
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }
  }

  if (sessionId) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Session not found. Please re-initialize.' },
      id: null,
    }));
    return;
  }

  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
    id: null,
  }));
}

export async function shutdownHttpServer(server: http.Server): Promise<void> {
  for (const [sid, transport] of transports) {
    await transport.close();
    transports.delete(sid);
  }
  return new Promise((resolve) => server.close(() => resolve()));
}
```

- [ ] **Step 2: Rewrite index.ts to construct resolver instead of single engine**

Replace `src/index.ts`:

```typescript
#!/usr/bin/env node

import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadProfiles } from './profiles/loader.js';
import { FileBackend } from './storage/file-backend.js';
import { LocalWorkspaceResolver } from './workspace-resolver.js';
import { startHttpServer, shutdownHttpServer } from './server.js';
import { DEFAULT_PORT } from './types.js';
import type { WorkspaceResolver } from './workspace-resolver.js';
import type { McpServerConfig } from './server.js';

async function main(): Promise<void> {
  const port = parseInt(process.env.CONFIG_SYNC_PORT ?? String(DEFAULT_PORT), 10);
  const storageDir = process.env.CONFIG_SYNC_STORAGE_DIR ?? join(homedir(), '.config-sync-storage');
  const profilesDir = process.env.CONFIG_SYNC_PROFILES_DIR ?? join(import.meta.dirname, '..', 'profiles');
  const userId = process.env.CONFIG_SYNC_USER_ID ?? process.env.CHE_USER_ID ?? 'default';
  const mode = process.env.FILE_ACCESS_MODE ?? 'local';
  const home = process.env.WORKSPACE_HOME_DIR ?? homedir();
  const defaultWorkspace = process.env.TARGET_WORKSPACE;

  console.log(`Loading profiles from ${profilesDir}`);
  const profiles = await loadProfiles(profilesDir);
  console.log(`Loaded ${profiles.length} profiles: ${profiles.map((p) => p.tool).join(', ')}`);

  const storage = new FileBackend(storageDir, userId);
  await storage.initialize();

  let resolver: WorkspaceResolver;

  if (mode === 'remote') {
    const { KubeWorkspaceClient } = await import('./k8s/client.js');
    const { KubeWorkspaceResolver } = await import('./workspace-resolver.js');

    const kubeClient = new KubeWorkspaceClient();
    await kubeClient.initialize();
    console.log(`Kube client initialized in namespace: ${kubeClient.getNamespace()}`);

    resolver = new KubeWorkspaceResolver(kubeClient);
  } else {
    resolver = new LocalWorkspaceResolver();
  }

  console.log(`File access mode: ${mode}`);
  if (defaultWorkspace) {
    console.log(`Default workspace: ${defaultWorkspace}`);
  }

  const config: McpServerConfig = {
    profiles,
    storage,
    homeDir: home,
    resolver,
    defaultWorkspace,
  };

  const server = await startHttpServer(port, config);
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`config-sync-mcp listening on port ${actualPort}`);

  const shutdown = async () => {
    console.log('Shutting down...');
    await shutdownHttpServer(server);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start config-sync-mcp:', error);
  process.exit(1);
});
```

- [ ] **Step 3: Update integration tests**

Replace `tests/integration/server.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { FileBackend } from '../../src/storage/file-backend.js';
import { LocalWorkspaceResolver } from '../../src/workspace-resolver.js';
import { loadProfiles } from '../../src/profiles/loader.js';
import { startHttpServer, shutdownHttpServer } from '../../src/server.js';
import type { McpServerConfig } from '../../src/server.js';

const TMP = join(import.meta.dirname, '..', '.tmp-integration');
const HOME = join(TMP, 'home');
const STORAGE = join(TMP, 'storage');
const PROFILES = join(TMP, 'profiles');

let server: http.Server;
let port: number;

function jsonRpc(method: string, params: any, id: number = 1) {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id });
}

async function mcpRequest(
  body: string,
  sessionId?: string,
): Promise<{ status: number; body: any; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            const match = raw.match(/^event: message\ndata: (.+)$/m);
            if (match) {
              try { parsed = JSON.parse(match[1]); } catch { parsed = raw; }
            } else {
              parsed = raw;
            }
          }
          resolve({
            status: res.statusCode!,
            body: parsed,
            sessionId: res.headers['mcp-session-id'] as string | undefined,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function healthCheck(): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) });
      });
    }).on('error', reject);
  });
}

beforeAll(async () => {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(STORAGE, { recursive: true });
  mkdirSync(PROFILES, { recursive: true });

  writeFileSync(join(PROFILES, 'git.yaml'), `
tool: git
name: Git
paths:
  sync: ["~/.gitconfig"]
  skip: []
  sensitive: []
`);

  const profiles = await loadProfiles(PROFILES);
  const backend = new FileBackend(STORAGE, 'test-user');
  await backend.initialize();

  const config: McpServerConfig = {
    profiles,
    storage: backend,
    homeDir: HOME,
    resolver: new LocalWorkspaceResolver(),
    defaultWorkspace: 'test-workspace',
  };

  server = await startHttpServer(0, config);
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await shutdownHttpServer(server);
  rmSync(TMP, { recursive: true, force: true });
});

describe('Integration', () => {
  it('healthz returns 200', async () => {
    const res = await healthCheck();
    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(true);
  });

  it('initializes MCP session and calls list_tools', async () => {
    const initRes = await mcpRequest(jsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    expect(initRes.status).toBe(200);

    const sid = initRes.sessionId;

    const listRes = await mcpRequest(
      jsonRpc('tools/call', { name: 'list_tools', arguments: {} }, 2),
      sid,
    );
    expect(listRes.status).toBe(200);
    const content = listRes.body.result?.content?.[0]?.text;
    const parsed = JSON.parse(content);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].tool).toBe('git');
  });

  it('roundtrip: push, delete, pull, verify (with workspace)', async () => {
    writeFileSync(join(HOME, '.gitconfig'), '[user]\n  name = Integration');

    const initRes = await mcpRequest(jsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    const sid = initRes.sessionId;

    const pushRes = await mcpRequest(
      jsonRpc('tools/call', {
        name: 'sync_to_storage',
        arguments: { workspace: 'test-workspace', tool: 'git', message: 'test' },
      }, 2),
      sid,
    );
    expect(pushRes.status).toBe(200);
    const pushData = JSON.parse(pushRes.body.result.content[0].text);
    expect(pushData.pushed).toHaveLength(1);

    rmSync(join(HOME, '.gitconfig'));
    expect(existsSync(join(HOME, '.gitconfig'))).toBe(false);

    const pullRes = await mcpRequest(
      jsonRpc('tools/call', {
        name: 'sync_from_storage',
        arguments: { workspace: 'test-workspace', tool: 'git' },
      }, 3),
      sid,
    );
    expect(pullRes.status).toBe(200);

    expect(readFileSync(join(HOME, '.gitconfig'), 'utf-8')).toBe('[user]\n  name = Integration');
  });

  it('uses default workspace when workspace param omitted', async () => {
    writeFileSync(join(HOME, '.gitconfig'), '[user]\n  name = Default');

    const initRes = await mcpRequest(jsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    const sid = initRes.sessionId;

    const pushRes = await mcpRequest(
      jsonRpc('tools/call', {
        name: 'sync_to_storage',
        arguments: { tool: 'git', message: 'default-ws-test' },
      }, 2),
      sid,
    );
    expect(pushRes.status).toBe(200);
    const pushData = JSON.parse(pushRes.body.result.content[0].text);
    expect(pushData.pushed).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/index.ts tests/integration/server.test.ts
git commit -s -m "feat: refactor server for per-call workspace resolution"
```
