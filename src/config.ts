import { readFileSync } from 'node:fs';

export interface AuthConfig {
  authEnabled: boolean;
  namespace: string;
}

const SA_NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

export function loadAuthConfig(): AuthConfig {
  const authEnv = process.env.CONFIG_SYNC_AUTH_ENABLED;
  const authEnabled = authEnv !== undefined ? authEnv === 'true' : true;

  let namespace = process.env.POD_NAMESPACE ?? '';
  if (!namespace) {
    try {
      namespace = readFileSync(SA_NAMESPACE_PATH, 'utf-8').trim();
    } catch {
      // not in-cluster, leave empty
    }
  }

  return { authEnabled, namespace };
}
