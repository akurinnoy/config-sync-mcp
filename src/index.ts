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
import type { DevWorkspaceWatcher } from './lifecycle/devworkspace-watcher.js';
import type { SyncOrchestrator as SyncOrchestratorType } from './lifecycle/sync-orchestrator.js';

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
  let kubeClient: any = null; // KubeWorkspaceClient | null

  if (mode === 'remote') {
    const { KubeWorkspaceClient } = await import('./k8s/client.js');
    const { KubeWorkspaceResolver } = await import('./workspace-resolver.js');

    kubeClient = new KubeWorkspaceClient();
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

  let watcher: DevWorkspaceWatcher | null = null;
  let orchestrator: SyncOrchestratorType | null = null;

  if (mode === 'remote') {
    const { DevWorkspaceWatcher: WatcherClass } = await import('./lifecycle/devworkspace-watcher.js');
    const { SyncOrchestrator } = await import('./lifecycle/sync-orchestrator.js');

    orchestrator = new SyncOrchestrator({
      profiles,
      storage,
      homeDir: home,
      resolver,
    });

    watcher = new WatcherClass(kubeClient!, {
      namespace: kubeClient!.getNamespace(),
      onTransition: (event) => orchestrator!.handleTransition(event),
    });

    await watcher.start();
    console.log('Lifecycle watcher started — auto-sync enabled');
  }

  const shutdown = async () => {
    console.log('Shutting down...');
    if (watcher) await watcher.stop();
    if (orchestrator) await orchestrator.shutdown();
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
