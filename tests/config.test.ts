import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('loadAuthConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CONFIG_SYNC_AUTH_ENABLED;
    delete process.env.POD_NAMESPACE;
  });

  it('defaults authEnabled to true', async () => {
    const { loadAuthConfig } = await import('../src/config.js');
    const config = loadAuthConfig();
    expect(config.authEnabled).toBe(true);
  });

  it('reads CONFIG_SYNC_AUTH_ENABLED=false', async () => {
    process.env.CONFIG_SYNC_AUTH_ENABLED = 'false';
    const { loadAuthConfig } = await import('../src/config.js');
    const config = loadAuthConfig();
    expect(config.authEnabled).toBe(false);
  });

  it('reads POD_NAMESPACE from env', async () => {
    process.env.POD_NAMESPACE = 'my-ns';
    const { loadAuthConfig } = await import('../src/config.js');
    const config = loadAuthConfig();
    expect(config.namespace).toBe('my-ns');
  });

  it('namespace is empty string when not set', async () => {
    const { loadAuthConfig } = await import('../src/config.js');
    const config = loadAuthConfig();
    expect(config.namespace).toBe('');
  });

  it('CONFIG_SYNC_AUTH_ENABLED=true explicitly', async () => {
    process.env.CONFIG_SYNC_AUTH_ENABLED = 'true';
    const { loadAuthConfig } = await import('../src/config.js');
    const config = loadAuthConfig();
    expect(config.authEnabled).toBe(true);
  });
});
