import * as k8s from '@kubernetes/client-node';
import type { KubeWorkspaceClient } from '../k8s/client.js';
import type { WorkspacePhase, TransitionEvent, WatcherConfig } from './types.js';

const TRIGGER_TRANSITIONS: Record<string, string[]> = {
  'Starting': ['Running'],
  'Running': ['Stopping', 'Failing'],
};

export class DevWorkspaceWatcher {
  private phaseMap = new Map<string, WorkspacePhase>();
  private lastResourceVersion = '';
  private abortRequest: (() => void) | null = null;
  private running = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: KubeWorkspaceClient,
    private readonly config: WatcherConfig,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    await this.listAndReconcile();
    await this.startWatch();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortRequest) {
      this.abortRequest();
      this.abortRequest = null;
    }
  }

  getPhaseMap(): Map<string, WorkspacePhase> {
    return new Map(this.phaseMap);
  }

  private async listAndReconcile(): Promise<void> {
    const customApi = this.client.getCustomObjectsApi();
    const result = await customApi.listNamespacedCustomObject({
      group: 'workspace.devfile.io',
      version: 'v1alpha2',
      namespace: this.config.namespace,
      plural: 'devworkspaces',
    });

    const response = result as any;
    this.lastResourceVersion = response.metadata?.resourceVersion ?? '';
    const items: any[] = response.items ?? [];

    for (const item of items) {
      const name = item.metadata?.name;
      const phase = item.status?.phase as WorkspacePhase | undefined;
      if (!name || !phase) continue;

      this.phaseMap.set(name, phase);

      if (phase === 'Running') {
        this.emitTransition(name, 'Starting', 'Running');
      }
    }
  }

  private async startWatch(): Promise<void> {
    if (!this.running) return;

    const kubeConfig = this.client.getKubeConfig();
    // Use createWatch() if available (for testing), otherwise create directly
    const watch = (this.client as any).createWatch?.() ?? new k8s.Watch(kubeConfig);
    const path = `/apis/workspace.devfile.io/v1alpha2/namespaces/${this.config.namespace}/devworkspaces`;

    try {
      const req = await watch.watch(
        path,
        { resourceVersion: this.lastResourceVersion },
        (type: string, obj: any) => this.handleEvent(type, obj),
        (err: any) => this.handleDone(err),
      );

      this.abortRequest = () => req.abort();
      this.reconnectAttempts = 0;
    } catch (err) {
      this.scheduleReconnect();
    }
  }

  private handleEvent(type: string, obj: any): void {
    const name = obj.metadata?.name;
    const phase = obj.status?.phase as WorkspacePhase | undefined;
    const resourceVersion = obj.metadata?.resourceVersion;

    if (!name) return;
    if (resourceVersion) this.lastResourceVersion = resourceVersion;

    if (type === 'DELETED') {
      this.phaseMap.delete(name);
      return;
    }

    if (!phase) return;

    const previousPhase = this.phaseMap.get(name);
    this.phaseMap.set(name, phase);

    // Only track ADDED events, don't emit transitions (those come from MODIFIED)
    if (type === 'ADDED') {
      return;
    }

    if (type === 'MODIFIED' && previousPhase && previousPhase !== phase) {
      const validTargets = TRIGGER_TRANSITIONS[previousPhase];
      if (validTargets?.includes(phase)) {
        this.emitTransition(name, previousPhase, phase);
      }
    }
  }

  private handleDone(err: any): void {
    this.abortRequest = null;
    if (!this.running) return;

    if (err?.statusCode === 410) {
      this.phaseMap.clear();
      this.listAndReconcile().then(() => this.startWatch()).catch(() => this.scheduleReconnect());
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    const baseMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    const jitter = Math.floor(Math.random() * 500);
    const delay = baseMs + jitter;

    this.reconnectAttempts++;
    console.log(`[lifecycle-sync] watch-reconnecting delay=${delay}ms attempt=${this.reconnectAttempts}`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startWatch();
    }, delay);
  }

  private emitTransition(workspace: string, previousPhase: WorkspacePhase, newPhase: WorkspacePhase): void {
    this.config.onTransition({
      workspace,
      previousPhase,
      newPhase,
      timestamp: new Date().toISOString(),
    });
  }
}
