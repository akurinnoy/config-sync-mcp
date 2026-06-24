# RBAC and Deployment Manifests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create Kubernetes RBAC resources and deployment manifests for the centralized config-sync-mcp server, and update the README with deployment instructions.

**Architecture:** A ServiceAccount with a Role granting `pods` (get, list), `pods/exec` (create), and `devworkspaces` (get, list, watch) permissions. A Deployment manifest referencing the ServiceAccount with proper env vars for remote mode. All manifests in `deploy/`.

**Tech Stack:** Kubernetes YAML manifests, OpenShift/CRC

## Global Constraints

- Namespace: manifests use a placeholder `NAMESPACE` that the user substitutes at apply time
- Image: `quay.io/akurinnoy/config-sync-mcp:next`
- Port: 8089
- `imagePullPolicy: Always` (required for `:next` tag iteration)
- `FILE_ACCESS_MODE=remote` for centralized deployment
- ServiceAccount name: `config-sync-mcp`
- Issue: akurinnoy/agentic-workspaces#151
- All git commits must use `-s` flag (signoff)

---

### Task 1: Create RBAC and deployment manifests in deploy/

**Files:**
- Create: `deploy/service-account.yaml`
- Create: `deploy/role.yaml`
- Create: `deploy/role-binding.yaml`
- Create: `deploy/deployment.yaml`
- Create: `deploy/service.yaml`

**Interfaces:**
- Consumes: nothing (standalone manifests)
- Produces: Complete set of k8s manifests that can be applied with `kubectl apply -f deploy/`

- [ ] **Step 1: Create deploy/service-account.yaml**

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: config-sync-mcp
  labels:
    app: config-sync-mcp
```

- [ ] **Step 2: Create deploy/role.yaml**

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: config-sync-mcp
  labels:
    app: config-sync-mcp
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
  - apiGroups: ["workspace.devfile.io"]
    resources: ["devworkspaces"]
    verbs: ["get", "list", "watch"]
```

- [ ] **Step 3: Create deploy/role-binding.yaml**

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: config-sync-mcp
  labels:
    app: config-sync-mcp
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: config-sync-mcp
subjects:
  - kind: ServiceAccount
    name: config-sync-mcp
```

- [ ] **Step 4: Create deploy/deployment.yaml**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: config-sync-mcp
  labels:
    app: config-sync-mcp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: config-sync-mcp
  template:
    metadata:
      labels:
        app: config-sync-mcp
    spec:
      serviceAccountName: config-sync-mcp
      containers:
        - name: config-sync-mcp
          image: quay.io/akurinnoy/config-sync-mcp:next
          imagePullPolicy: Always
          ports:
            - containerPort: 8089
              name: mcp
          env:
            - name: CONFIG_SYNC_PORT
              value: "8089"
            - name: FILE_ACCESS_MODE
              value: "remote"
            - name: CONFIG_SYNC_USER_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: WORKSPACE_HOME_DIR
              value: "/home/user"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8089
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8089
            initialDelaySeconds: 3
            periodSeconds: 5
          resources:
            requests:
              memory: "64Mi"
              cpu: "50m"
            limits:
              memory: "256Mi"
              cpu: "500m"
```

- [ ] **Step 5: Create deploy/service.yaml**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: config-sync-mcp
  labels:
    app: config-sync-mcp
spec:
  selector:
    app: config-sync-mcp
  ports:
    - port: 8089
      targetPort: 8089
      name: mcp
```

- [ ] **Step 6: Verify manifests are valid YAML**

Run: `cat deploy/*.yaml | python3 -c "import sys, yaml; list(yaml.safe_load_all(sys.stdin))"`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add deploy/
git commit -s -m "feat: add RBAC and deployment manifests for centralized mode"
```

---

### Task 2: Update README with deployment section

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: manifests from Task 1
- Produces: Updated README with deployment instructions

- [ ] **Step 1: Add deployment section to README**

After the "Docker" section and before "Development", add a "Cluster deployment" section:

```markdown
## Cluster deployment

Deploy the centralized config-sync-mcp server to a Kubernetes/OpenShift namespace where DevWorkspaces run.

### Prerequisites

- `oc` or `kubectl` configured for the target cluster
- Namespace where DevWorkspaces run (e.g., `kubeadmin-devspaces`)

### Apply manifests

```bash
oc project <namespace>
oc apply -f deploy/
```

This creates:
- **ServiceAccount** `config-sync-mcp` — identity for the server pod
- **Role** — permissions to list pods, exec into workspace pods, and watch DevWorkspaces
- **RoleBinding** — binds the role to the service account
- **Deployment** — the server running in remote mode (`FILE_ACCESS_MODE=remote`)
- **Service** — exposes the MCP endpoint at `config-sync-mcp:8089`

### Verify

```bash
# Check pod is running
oc get pods -l app=config-sync-mcp

# Check health
oc exec deployment/config-sync-mcp -- curl -s http://localhost:8089/healthz

# Test MCP handshake
oc exec deployment/config-sync-mcp -- curl -s -X POST http://localhost:8089/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}},"id":1}'
```
```

- [ ] **Step 2: Also add the new env vars to the env var table**

Add `FILE_ACCESS_MODE`, `POD_NAMESPACE`, `TARGET_WORKSPACE`, `WORKSPACE_HOME_DIR` to the existing env var table in the Quick start section.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -s -m "docs: add cluster deployment instructions and env vars"
```
