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
