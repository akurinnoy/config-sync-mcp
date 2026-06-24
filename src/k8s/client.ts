import * as k8s from '@kubernetes/client-node';
import { readFileSync } from 'node:fs';
import stream from 'node:stream';

const SA_NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
const CHE_GATEWAY_CONTAINER = 'che-gateway';
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export class KubeWorkspaceClient {
  private kubeConfig!: k8s.KubeConfig;
  private coreV1Api!: k8s.CoreV1Api;
  private customObjectsApi!: k8s.CustomObjectsApi;
  private namespace = '';
  private execTimeoutMs: number;

  constructor(opts?: { execTimeoutMs?: number }) {
    this.execTimeoutMs = opts?.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  }

  async initialize(): Promise<void> {
    this.kubeConfig = new k8s.KubeConfig();
    this.kubeConfig.loadFromDefault();
    this.coreV1Api = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
    this.customObjectsApi = this.kubeConfig.makeApiClient(k8s.CustomObjectsApi);

    this.namespace =
      process.env.POD_NAMESPACE ??
      process.env.CHE_MCP_NAMESPACE ??
      '';

    if (!this.namespace) {
      try {
        this.namespace = readFileSync(SA_NAMESPACE_PATH, 'utf-8').trim();
      } catch {
        // not in-cluster
      }
    }

    if (!this.namespace) {
      const ctx = this.kubeConfig.getContextObject(this.kubeConfig.getCurrentContext());
      this.namespace = ctx?.namespace ?? '';
    }

    if (!this.namespace) {
      throw new Error('Cannot determine namespace. Set POD_NAMESPACE env var.');
    }
  }

  getNamespace(): string {
    return this.namespace;
  }

  getKubeConfig(): k8s.KubeConfig {
    return this.kubeConfig;
  }

  getCustomObjectsApi(): k8s.CustomObjectsApi {
    return this.customObjectsApi;
  }

  async findWorkspacePod(workspace: string): Promise<{
    podName: string;
    containerName: string;
  }> {
    const response = await this.coreV1Api.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `controller.devfile.io/devworkspace_name=${workspace}`,
    });

    const items = (response as any).items ?? response.items ?? [];
    const alivePod = items.find(
      (p: any) => p.status?.phase === 'Running' || p.status?.phase === 'Pending',
    ) ?? items.find((p: any) => p.metadata?.deletionTimestamp && p.status?.phase);

    if (!alivePod) {
      throw new Error(
        `No running pod found for workspace "${workspace}" in namespace "${this.namespace}"`,
      );
    }

    const containers: string[] = (alivePod.spec?.containers ?? []).map(
      (c: any) => c.name,
    );
    const devContainer = containers.find((n) => n !== CHE_GATEWAY_CONTAINER);

    if (!devContainer) {
      throw new Error(`No dev container found in pod for workspace "${workspace}"`);
    }

    return {
      podName: alivePod.metadata!.name!,
      containerName: devContainer,
    };
  }

  async exec(
    podName: string,
    containerName: string,
    command: string[],
    stdin?: Buffer,
  ): Promise<ExecResult> {
    const kubeExec = new k8s.Exec(this.kubeConfig);
    const stdoutChunks: Buffer[] = [];
    let stderr = '';

    const stdoutStream = new stream.PassThrough();
    const stderrStream = new stream.PassThrough();

    stdoutStream.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    stderrStream.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    let stdinStream: stream.PassThrough | null = null;
    if (stdin) {
      stdinStream = new stream.PassThrough();
      stdinStream.end(stdin);
    }

    return new Promise<ExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Exec timed out after ${this.execTimeoutMs}ms`));
      }, this.execTimeoutMs);

      kubeExec
        .exec(
          this.namespace,
          podName,
          containerName,
          ['bash', '-lc', command.join(' ')],
          stdoutStream,
          stderrStream,
          stdinStream,
          false,
          (status) => {
            clearTimeout(timer);
            const exitCode =
              status.status === 'Success'
                ? 0
                : parseInt(
                    status.details?.causes?.find(
                      (c: any) => c.reason === 'ExitCode',
                    )?.message ?? '1',
                    10,
                  );
            resolve({
              stdout: Buffer.concat(stdoutChunks),
              stderr,
              exitCode,
            });
          },
        )
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}
