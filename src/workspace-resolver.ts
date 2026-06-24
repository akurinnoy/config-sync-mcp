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
