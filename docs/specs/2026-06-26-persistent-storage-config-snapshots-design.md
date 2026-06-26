# Specification: Persistent Storage for config-sync-mcp Snapshots

**Issue:** akurinnoy/agentic-workspaces#172

## 1. Problem

`FileStorageBackend` writes config snapshots to the pod's ephemeral filesystem. Pod restarts and redeployments destroy all stored versions. On workspace start, auto-pull finds no snapshots, breaking the core product guarantee: cross-workspace config continuity for the same user.

## 2. Design

### PVC

| Field | Value | Rationale |
|-------|-------|-----------|
| Name | `config-sync-storage` | Matches the volume name used in the Deployment |
| Size | `1Gi` | Generous for versioned JSON/YAML config files |
| Access mode | `ReadWriteOnce` | Single-replica deployment, no concurrent writers |
| storageClassName | omitted | Uses cluster default for portability across environments |

### Volume Mount

Mount path: `/data/config-sync-storage`

A fixed, purpose-built path under `/data/`. Not the user home directory. Not configurable at the Kubernetes level (mounts are static).

### Environment Variable

Set `CONFIG_SYNC_STORAGE_DIR=/data/config-sync-storage` in the container spec. This is the correct approach because:

- The application already supports this env var (`src/index.ts`)
- The default path depends on `homedir()`, which varies by container user
- An explicit env var makes the PVC-to-application coupling visible in one manifest

### Security Context

Add `securityContext.fsGroup` to the pod spec, set to the GID of the container's runtime user. Without this, the PVC mounts as `root:root` and the non-root MCP process will fail with `EACCES` on the first write.

### No Code Changes

`src/storage/file-backend.ts` and `src/index.ts` require zero modifications. The env var support already exists.

## 3. Files to Create/Modify

**Create:** `deploy/pvc.yaml`
- PersistentVolumeClaim: `config-sync-storage`, 1Gi, ReadWriteOnce, no storageClassName.

**Modify:** `deploy/deployment.yaml`
- Add `volumes` entry referencing PVC `config-sync-storage`.
- Add `volumeMounts` on the container: `mountPath: /data/config-sync-storage`, `name: config-sync-storage`.
- Add env var `CONFIG_SYNC_STORAGE_DIR` with value `/data/config-sync-storage`.
- Add `securityContext.fsGroup` at the pod spec level.

**No changes:** `src/index.ts`, `src/storage/file-backend.ts`, `deploy/service.yaml`, `deploy/role.yaml`, `deploy/role-binding.yaml`, `deploy/service-account.yaml`.

### Deploy workflow note

Ensure `deploy/pvc.yaml` is included in the apply order before `deploy/deployment.yaml`. The PVC must exist before the Deployment references it.

## 4. Design Notes

- **Single-replica assumption:** This design uses ReadWriteOnce. If the deployment ever scales beyond one replica, this access mode will cause scheduling failures. The current architecture (single MCP pod) does not require ReadWriteMany.
- **No data migration:** Users upgrading from the ephemeral setup will start with an empty PVC. Any snapshots in the current pod's overlay filesystem are not preserved. This is acceptable because the ephemeral storage was already unreliable by definition.
- **PVC failure mode:** If the PVC fails to bind (e.g., no default StorageClass, insufficient capacity), the pod will stay in `Pending`. This is standard Kubernetes behavior and does not require application-level handling.

## 5. Validation

1. Apply `deploy/pvc.yaml`, then the updated `deploy/deployment.yaml`. Verify the PVC status is `Bound` and the pod reaches `Running`.
2. Inside the pod, run `df -h /data/config-sync-storage` to confirm it is a mounted volume (not the overlay filesystem).
3. Push a config snapshot via the MCP API. Confirm the file exists under `/data/config-sync-storage/` inside the pod.
4. Delete the pod (`kubectl delete pod ...`). Wait for the replacement pod to reach `Running`.
5. Pull the config snapshot from the new pod. Confirm it returns the previously pushed data.
6. Redeploy the Deployment (e.g., change the image tag). Repeat the pull check against the new pod.
