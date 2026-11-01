---
name: omniroute-deploy
description: Deploy OmniRoute to the operator's Kubernetes cluster (registry.celestium.life + 192.168.42.254). Use when asked to deploy, ship, roll out, or roll back OmniRoute to the k8s fleet. Covers image build/push, manifest update, apply, and verification.
---

# OmniRoute k8s deployment

Deploys the OmniRoute gateway to the operator's k8s cluster. Verified 2026-10-24 against live state.

## Topology (verified)

| Piece                 | Value                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Build + registry host | `celes@192.168.42.254` (host `esnixi`, 449G free on /home, 125G RAM, docker 29.8)                                    |
| Manifest dir on 254   | `~/sources/kube/omniroute`                                                                                           |
| Container registry    | `registry.celestium.life/library/omniroute`                                                                          |
| Namespace / deploy    | `omniroute` / deployment `omniroute` (single replica, `Recreate` strategy — brief downtime on every deploy)          |
| Image command         | `node dev/run-standalone.mjs`                                                                                        |
| Ports                 | `20128` (http), `20132` (livews)                                                                                     |
| Data                  | PVC `data` → `/app/data`; init container `fix-data-perms` chowns `1000:1000`                                         |
| DB                    | PostgreSQL (CNPG cluster `postgresql` in ns `postgres-service`); falls back silently to SQLite on connect failure    |
| Public URL            | `https://omniroute.celestium.life` (traefik ingress `omniroute-http`/`-https`/`-livews`; `307` root→login = healthy) |
| Kustomize             | `kustomization.yaml` (omniroute.yaml + omniroute-postgres-secret.yaml)                                               |
| One-shot scripts      | `runmefirst.sh` = `kubectl create namespace omniroute; kubectl apply -f .` · `runmelast.sh` = `kubectl delete -f .`  |

**Image tag convention:** `3.8.52-<feature>-<git-sha8>` — e.g. `3.8.52-ponytail-0b277cab5`.
The tag embeds the branch feature name plus the 8-char commit SHA it was built from.

## Deploy procedure

### 0. Preflight — do not skip

1. **Base line check.** The branch being deployed MUST contain the current release line tip,
   or the deploy silently rolls back work already running (incident: ponytail branch
   predating WP6 skills, 2026-10-24). From the repo worktree:
   ```bash
   git merge-base --is-ancestor origin/release/v3.8.52 HEAD || echo "NOT on release line — merge first"
   git log --oneline HEAD..origin/release/v3.8.52   # anything listed = work you would remove
   ```
2. **Registry reachability from the build host** (k8s pulls there, so the image MUST be pushed):
   ```bash
   ssh celes@192.168.42.254 "docker buildx ls >/dev/null 2>&1 && echo DOCKER_OK"
   ```
3. Note the currently running image (rollback target if the smoke fails):
   ```bash
   ssh celes@192.168.42.254 "kubectl -n omniroute get deploy omniroute -o jsonpath='{.spec.template.spec.containers[0].image}'; echo"
   ```

### 1. Stage the source on 254

Build dirs on 254 follow `~/sources/omniroute-deploy-<sha8>` (full repo copy; ~792 MB without
`node_modules`). Rsync from the git worktree:

```bash
SHA=$(git rev-parse --short HEAD)
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude .claude --exclude .next --exclude .turbo \
  --exclude '_tasks' --exclude '_artifacts' --exclude '_mono_repo' --exclude '_cache' \
  --exclude '_ideia' --exclude '_references' \
  -e "ssh -o BatchMode=yes" . celes@192.168.42.254:sources/omniroute-deploy-$SHA/
```

(`--exclude '_*'` form is fine too; the `_*` dirs are private workspaces, never deploy material.)

### 2. Build + push

On 254 (docker context is local; the Dockerfile runs `npm ci` + Next.js standalone build —
expect 10-30 min; log to file and poll the log, not the ssh session):

```bash
ssh celes@192.168.42.254 "cd sources/omniroute-deploy-$SHA && \
  nohup bash -c 'docker build -t registry.celestium.life/library/omniroute:3.8.52-<feature>-$SHA . \
    && docker push registry.celestium.life/library/omniroute:3.8.52-<feature>-$SHA' \
    > build.log 2>&1 &"
```

Success = `docker build` exit 0 **and** `docker push` exit 0 (check the tail of build.log).
If only the build succeeded, you can `docker push` separately.

### 3. Update the manifest + apply

Back up the manifest first (established pattern, timestamped):

```bash
ssh celes@192.168.42.254 "cd sources/kube/omniroute && \
  cp omniroute.yaml omniroute.yaml.bak-$(date +%Y%m%d)-pre-<feature> && \
  sed -i 's|image: registry.celestium.life/library/omniroute:.*|image: registry.celestium.life/library/omniroute:3.8.52-<feature>-$SHA|' omniroute.yaml && \
  ./runmefirst.sh"
```

`Recreate` strategy ⇒ old pod terminates before the new one starts (expected gap, ~1 min
plus image pull). Do NOT use `kubectl rollout restart` to "fix" the manifest — edit the
image line in the manifest so the source of truth stays correct.

### 4. Verify (do not skip)

```bash
ssh celes@192.168.42.254 "kubectl -n omniroute get pods -o wide; \
  kubectl -n omniroute get deploy omniroute -o jsonpath='{.spec.template.spec.containers[0].image}'; echo; \
  kubectl -n omniroute logs deploy/omniroute --tail=30"
```

Pod must be `1/1 Running`, 0 restarts, image = the new tag, and logs must show the server
listening on 20128 without crash loops (look for `COMBO` traces with `status:200` and
`[USAGE]` rows). Then probe the ingress — **NOT** the pod or ClusterIP directly; both time
out from anywhere in this network (NetworkPolicy), which is normal, not a failure:

```bash
curl -sk -m 10 -o /dev/null -w '%{http_code}\n' https://omniroute.celestium.life/
# 307 (root → login) or 200 = healthy · 502/504 = upstream down
```

### 5. Rollback (if smoke fails)

Set the image back to the pre-deploy tag from step 0.3 (or the matching
`omniroute.yaml.bak-<date>-pre-<feature>`) and re-run `runmefirst.sh`. The previous image
remains on the registry — `imagePullPolicy: IfNotPresent` makes rollback instant.

## Rules

- **Never deploy a branch that does not contain the release line tip** (step 0.1) — this
  host runs the operator's active fork work; rolling it back breaks live features.
- **Always take the pre-deploy manifest backup** before touching `omniroute.yaml`.
- Build on 254, not locally: the registry + docker daemon live there and the build is
  heavy (~3.5 GB image). Local → 254 ships source, 254 ships the image.
- Keep image tags unique per commit (sha suffix). Reusing a tag hides a rebuild from
  `IfNotPresent` and from anyone's rollback.
- The 192.168.0.x VPS/canary hosts in the upstream docs (`192.168.0.15`, `.17`) are a
  different (upstream-project) fleet and are NOT this deployment target.
