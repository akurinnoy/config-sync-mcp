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

  it('returns 400 on malformed JSON', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.end('{ invalid json }');
    });
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe(-32700);
    expect(parsed.error.message).toBe('Parse error');
  });

  it('returns 404 when session not found', async () => {
    const res = await mcpRequest(
      jsonRpc('tools/call', { name: 'list_tools', arguments: {} }),
      'non-existent-session-id',
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(-32000);
    expect(res.body.error.message).toContain('Session not found');
  });

  it('normalizes null arguments in tools/call', async () => {
    const initRes = await mcpRequest(jsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    const sid = initRes.sessionId;

    // Send request with null arguments - should be normalized to {}
    const res = await mcpRequest(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_tools', arguments: null },
        id: 2,
      }),
      sid,
    );

    expect(res.status).toBe(200);
    const content = res.body.result?.content?.[0]?.text;
    const parsed = JSON.parse(content);
    expect(parsed.tools).toHaveLength(1);
  });

  it('get_sync_status returns status', async () => {
    writeFileSync(join(HOME, '.gitconfig'), '[user]\n  name = Status');

    const initRes = await mcpRequest(jsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    const sid = initRes.sessionId;

    await mcpRequest(
      jsonRpc('tools/call', {
        name: 'sync_to_storage',
        arguments: { workspace: 'test-workspace', tool: 'git', message: 'status-test' },
      }, 2),
      sid,
    );

    const statusRes = await mcpRequest(
      jsonRpc('tools/call', {
        name: 'get_sync_status',
        arguments: { workspace: 'test-workspace', tool: 'git' },
      }, 3),
      sid,
    );
    expect(statusRes.status).toBe(200);
    const statusData = JSON.parse(statusRes.body.result.content[0].text);
    expect(statusData).toHaveProperty('tools');
    expect(statusData.tools).toHaveLength(1);
    expect(statusData.tools[0].tool).toBe('git');
  });

  it('diff_config shows differences', async () => {
    writeFileSync(join(HOME, '.gitconfig'), '[user]\n  name = Diff');

    const initRes = await mcpRequest(jsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    const sid = initRes.sessionId;

    await mcpRequest(
      jsonRpc('tools/call', {
        name: 'sync_to_storage',
        arguments: { workspace: 'test-workspace', tool: 'git', message: 'diff-test' },
      }, 2),
      sid,
    );

    writeFileSync(join(HOME, '.gitconfig'), '[user]\n  name = Modified');

    const diffRes = await mcpRequest(
      jsonRpc('tools/call', {
        name: 'diff_config',
        arguments: { workspace: 'test-workspace', tool: 'git' },
      }, 3),
      sid,
    );
    expect(diffRes.status).toBe(200);
    const diffData = JSON.parse(diffRes.body.result.content[0].text);
    expect(diffData).toHaveProperty('diffs');
    expect(Array.isArray(diffData.diffs)).toBe(true);
  });

  it('list_config_versions returns versions', async () => {
    writeFileSync(join(HOME, '.gitconfig'), '[user]\n  name = Version1');

    const initRes = await mcpRequest(jsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    const sid = initRes.sessionId;

    await mcpRequest(
      jsonRpc('tools/call', {
        name: 'sync_to_storage',
        arguments: { workspace: 'test-workspace', tool: 'git', message: 'v1' },
      }, 2),
      sid,
    );

    writeFileSync(join(HOME, '.gitconfig'), '[user]\n  name = Version2');

    await mcpRequest(
      jsonRpc('tools/call', {
        name: 'sync_to_storage',
        arguments: { workspace: 'test-workspace', tool: 'git', message: 'v2' },
      }, 3),
      sid,
    );

    const versionsRes = await mcpRequest(
      jsonRpc('tools/call', {
        name: 'list_config_versions',
        arguments: { tool: 'git', limit: 10 },
      }, 4),
      sid,
    );
    expect(versionsRes.status).toBe(200);
    const versionsData = JSON.parse(versionsRes.body.result.content[0].text);
    expect(versionsData.versions.length).toBeGreaterThanOrEqual(2);
  });

  it('rollback_config restores previous version', async () => {
    writeFileSync(join(HOME, '.gitconfig'), '[user]\n  name = Original');

    const initRes = await mcpRequest(jsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    const sid = initRes.sessionId;

    const pushRes1 = await mcpRequest(
      jsonRpc('tools/call', {
        name: 'sync_to_storage',
        arguments: { workspace: 'test-workspace', tool: 'git', message: 'original' },
      }, 2),
      sid,
    );
    const version1 = JSON.parse(pushRes1.body.result.content[0].text).pushed[0].version;

    writeFileSync(join(HOME, '.gitconfig'), '[user]\n  name = Modified');

    await mcpRequest(
      jsonRpc('tools/call', {
        name: 'sync_to_storage',
        arguments: { workspace: 'test-workspace', tool: 'git', message: 'modified' },
      }, 3),
      sid,
    );

    const rollbackRes = await mcpRequest(
      jsonRpc('tools/call', {
        name: 'rollback_config',
        arguments: { workspace: 'test-workspace', tool: 'git', version: version1 },
      }, 4),
      sid,
    );
    expect(rollbackRes.status).toBe(200);
    const rollbackData = JSON.parse(rollbackRes.body.result.content[0].text);
    expect(rollbackData.restored).toBeTruthy();

    const content = readFileSync(join(HOME, '.gitconfig'), 'utf-8');
    expect(content).toBe('[user]\n  name = Original');
  });

  it('returns 405 for unsupported HTTP method on /mcp', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/mcp', method: 'PUT' },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve({ status: res.statusCode! }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(405);
  });

  it('returns 404 for unknown path', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/unknown`, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode! }));
      }).on('error', reject);
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when no session ID provided for non-initialize request', async () => {
    const res = await mcpRequest(
      jsonRpc('tools/call', { name: 'list_tools', arguments: {} }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32000);
    expect(res.body.error.message).toContain('No valid session ID provided');
  });

  it('sync_from_storage handles per-tool errors gracefully', async () => {
    const initRes = await mcpRequest(jsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    const sid = initRes.sessionId;

    // Try to pull with an invalid tool name to trigger error handling
    const pullRes = await mcpRequest(
      jsonRpc('tools/call', {
        name: 'sync_from_storage',
        arguments: { workspace: 'test-workspace', tool: 'unknown-tool' },
      }, 2),
      sid,
    );

    expect(pullRes.status).toBe(200);
    const pullData = JSON.parse(pullRes.body.result.content[0].text);
    expect(pullData.warnings).toHaveLength(1);
    expect(pullData.warnings[0]).toContain('unknown-tool:');
    expect(pullData.warnings[0]).toContain('Unknown tool');
  });

  it('tool catch blocks fire when resolver throws', async () => {
    const failingResolver = {
      resolve: () => { throw new Error('resolver exploded'); },
    };
    const failConfig: McpServerConfig = {
      profiles: [{ tool: 'git', name: 'Git', paths: { sync: ['~/.gitconfig'], skip: [], sensitive: [] } }],
      storage: new FileBackend(STORAGE, 'test-user-fail'),
      homeDir: HOME,
      resolver: failingResolver,
      defaultWorkspace: 'fail-ws',
    };
    await failConfig.storage.initialize();
    const failServer = await startHttpServer(0, failConfig);
    const failAddr = failServer.address();
    const failPort = typeof failAddr === 'object' && failAddr ? failAddr.port : 0;

    try {
      const initRes = await new Promise<{ status: number; body: any; sessionId?: string }>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port: failPort, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString();
              let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
              resolve({ status: res.statusCode!, body: parsed, sessionId: res.headers['mcp-session-id'] as string | undefined });
            });
          },
        );
        req.on('error', reject);
        req.end(jsonRpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.1.0' } }));
      });
      const sid = initRes.sessionId;

      const toolCalls = [
        { name: 'sync_from_storage', arguments: { tool: 'git' } },
        { name: 'sync_to_storage', arguments: { tool: 'git', message: 'test' } },
        { name: 'diff_config', arguments: { tool: 'git' } },
        { name: 'get_sync_status', arguments: { tool: 'git' } },
        { name: 'rollback_config', arguments: { tool: 'git', version: 'v1' } },
      ];

      for (const call of toolCalls) {
        const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
          const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
          if (sid) headers['mcp-session-id'] = sid;
          const req = http.request(
            { hostname: '127.0.0.1', port: failPort, path: '/mcp', method: 'POST', headers },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                let parsed; try { parsed = JSON.parse(raw); } catch {
                  const match = raw.match(/^event: message\ndata: (.+)$/m);
                  if (match) { try { parsed = JSON.parse(match[1]); } catch { parsed = raw; } } else { parsed = raw; }
                }
                resolve({ status: res.statusCode!, body: parsed });
              });
            },
          );
          req.on('error', reject);
          req.end(jsonRpc('tools/call', { name: call.name, arguments: call.arguments }, 2));
        });
        expect(res.status).toBe(200);
        const text = res.body.result?.content?.[0]?.text;
        expect(text).toContain('Error:');
        expect(text).toContain('resolver exploded');
      }
    } finally {
      await shutdownHttpServer(failServer);
    }
  });

  it('sync_to_storage handles per-tool errors gracefully', async () => {
    const initRes = await mcpRequest(jsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    const sid = initRes.sessionId;

    // Try to push for an unknown tool to trigger error handling
    const pushRes = await mcpRequest(
      jsonRpc('tools/call', {
        name: 'sync_to_storage',
        arguments: { workspace: 'test-workspace', tool: 'unknown-tool', message: 'test' },
      }, 2),
      sid,
    );

    expect(pushRes.status).toBe(200);
    const pushData = JSON.parse(pushRes.body.result.content[0].text);
    expect(pushData.warnings).toHaveLength(1);
    expect(pushData.warnings[0]).toContain('unknown-tool:');
    expect(pushData.warnings[0]).toContain('Unknown tool');
  });
});
