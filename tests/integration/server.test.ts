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
