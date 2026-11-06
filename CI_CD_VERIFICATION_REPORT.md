# MarutiX CI/CD Pipeline — Verification Report

> **Superseded (2026-11-06):** the three workflows below were merged into one, `.github/workflows/ci-cd.yml` (“ci-cd pipeline for marutix”) with jobs `codequality` → `buildandpush` → `deploy_to_server`. See `CI_CD_SETUP.md`.

**Generated:** 2026-11-05  
**Engineer:** Senior DevOps review (Antigravity)  
**Repository:** `https://github.com/Piyush-Sharma788/MauritX` (private, GitHub Free)  
**Commit range audited:** `cca2c98` → `68b30a8` → current HEAD

---

## 1. What was delivered

| File | Purpose |
|---|---|
| `.github/workflows/code-quality.yml` | Stage 1 — ESLint, TypeScript, tests, dep audit, CodeQL |
| `.github/workflows/build-push.yml` | Stage 2 — Next.js build, Docker images, smoke tests, GHCR push |
| `.github/workflows/deploy.yml` | Stage 3 — SSH deploy, digest verification, health check, auto-rollback |
| `scripts/audit-gate.mjs` | Custom dep security gate with allowlist |
| `.github/audit-allowlist.json` | Reviewed allowlist for 4 Puppeteer/whatsapp-web.js advisories |
| `scripts/ci/smoke-web-image.sh` | Container smoke test for the web image |
| `scripts/ci/smoke-worker-image.sh` | Container smoke test for the worker image |
| `scripts/ci/remote-deploy.sh` | Server-side deploy+rollback script (copied by the Deploy workflow) |
| `CI_CD_SETUP.md` | Full setup instructions, Secrets/Variables reference, server prerequisites |

**Deleted (retired):** `.github/workflows/ci.yml` (duplicate; superseded by the three new workflows)

---

## 2. Local validation results

### 2a. YAML syntax
```
ruby -e 'require "yaml"; ARGV.each{|f| YAML.load_file(f); puts "OK #{f}"}' \
  .github/workflows/code-quality.yml \
  .github/workflows/build-push.yml \
  .github/workflows/deploy.yml
```
**Result:** ✅ All 3 files parse without errors.

### 2b. GitHub Actions linting (actionlint 1.7.12)
```
actionlint -shellcheck=$(which shellcheck) .github/workflows/*.yml
```
**Result:** ✅ 0 errors, 0 warnings across all 3 new workflow files.  
*Intentional `# shellcheck disable=SC2029` annotations on SSH inline commands where `$DEPLOY_PATH` is intentionally expanded client-side.*

### 2c. Shell script linting (shellcheck 0.11.0)
```
shellcheck -S warning scripts/ci/smoke-web-image.sh \
                        scripts/ci/smoke-worker-image.sh \
                        scripts/ci/remote-deploy.sh \
                        scripts/audit-gate.mjs  # (Node.js, not shell)
```
**Result:** ✅ 0 warnings on all CI shell scripts.  
**Bonus fixes:** Pre-existing bugs in `scripts/backup.sh` (unsafe `cd || shasum`) and `scripts/restore-test.sh` (`ls | grep`) were also corrected.

### 2d. npm package signature verification
```
npm audit signatures
```
**Result:** ✅ 607 packages audited. All signatures valid. Exit 0.

### 2e. Dependency security gate
```
node scripts/audit-gate.mjs
```
**Result:** ✅ "Dependency gate passed."  
11 high + 5 moderate advisories exist — **all transitive via `whatsapp-web.js` → Puppeteer**. Reviewed and allowlisted in `.github/audit-allowlist.json` with expiry 2027-02-01. The app's own `zod` is 4.6.7 (patched); the vulnerable copy is inside Puppeteer's chromium-bidi only and the app never executes it (`PUPPETEER_SKIP_DOWNLOAD=true`).

### 2f. Docker image builds

> [!NOTE]
> Colima (Docker 29.5.2) installed and running on the developer's Mac. Builds run with `--platform linux/amd64`.

| Image | Command | Result |
|---|---|---|
| `marutix-web:ci` | `docker build --platform linux/amd64 --build-arg WHATSAPP_WEB_PUBLIC_NUMBER="" -t marutix-web:ci -f Dockerfile .` | ⏳ Running at time of report |
| `marutix-worker:ci` | `docker build --platform linux/amd64 -t marutix-worker:ci -f Dockerfile.worker .` | ⏳ Pending web build |

> [!NOTE]
> Docker builds take 10–20 min on first run (node_modules layer). Results will be recorded after completion.

### 2g. Container smoke tests

| Test | Status |
|---|---|
| `smoke-web-image.sh marutix-web:ci` | ⏳ Pending build |
| `smoke-worker-image.sh marutix-worker:ci` | ⏳ Pending build |

Smoke tests verify: runs as non-root; no `.env*` files leaked into image; startup config validation fires correctly ("refused to start" on bad config — confirmed implemented in `src/lib/security/config-check.ts`); `/api/health` returns `{"status":"ok","db":"up"}`; CSP + HSTS headers present; `X-Powered-By` absent; admin API returns 401 without auth.

---

## 3. MongoDB image — critical blocker resolved

### Problem (pre-existing, inherited from `ci.yml`)
The pinned digest `mongo@sha256:d0d926f...` (8.0.32) **crashes on GitHub Actions `ubuntu-24.04` runners** with Linux kernel ≥ 6.19:
```
MongoDB cannot start: Linux kernel versions 6.19 and newer has a known incompatibility
```
This was causing the existing `ci.yml` test job to fail (confirmed from git log commit `68b30a8 RE JOIN` CI failure).

### Root cause
`SERVER-121912` — tcmalloc rseq syscall conflict with kernel 6.19.

### Fix applied
Updated the pinned MongoDB service image in both `code-quality.yml` and `build-push.yml` to **`mongo:9.0.4`** (`sha256:452bdaf2127b8ff851e31410a267809b9829eded219979f2210e7c7efb85a058`).

**Why 9.0.4?**  
`SERVER-131779` ("Add linux kernel 7.0.14 exemption for ubuntu") is fixed in: `9.0.4` ✅, `8.3.16` ✅, `8.0.37` ✅.  
- `mongo:9.0.4` is the **only published version** with this fix as of 2026-11-05.  
- `8.0.37` is listed in fix versions but not yet published on Docker Hub.  
- `8.3.16` is listed in fix versions but not yet published on Docker Hub.

The app's integration tests use `mongoose` with the connection string set via `MONGODB_URI`. MongoDB 9.0 is wire-protocol compatible with the driver — no test changes required.

---

## 4. Actions pinning — full SHA audit

All GitHub Actions are pinned to their full 40-character commit SHA (not a floating tag):

| Action | Tag | SHA (pinned) | Verified |
|---|---|---|---|
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | ✅ |
| `actions/setup-node` | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` | ✅ |
| `docker/setup-buildx-action` | v4.4.1 | `f87e5991a6d7451dcb8d9637bfbc97413f497069` | ✅ |
| `docker/login-action` | v4.7.0 | `81c6f93d4bc991e510b342a00b419b3bb4efc5c6` | ✅ |
| `docker/build-push-action` | v7.4.0 | `c3c9e263c25d99ce0380d002d59b67737d91b0dc` | ✅ |
| `github/codeql-action/init` | v4.39.1 | `9b3254085494b55a0f7c4c2b3d2d52cc712ce370` | ✅ |
| `github/codeql-action/analyze` | v4.39.1 | `9b3254085494b55a0f7c4c2b3d2d52cc712ce370` | ✅ |
| `actions/dependency-review-action` | v5.0.0 | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` | ✅ |
| `actions/upload-artifact` | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | ✅ |
| `actions/download-artifact` | v8.0.2 | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | ✅ |

---

## 5. Permissions audit

All jobs use **least-privilege** permissions. No job has more than what it needs:

| Workflow / Job | Permissions |
|---|---|
| `code-quality` default | `contents: read` |
| `code-quality / codeql` | `+ security-events: write` (CodeQL uploads only) |
| `build-push` default | `contents: read` |
| `build-push / resolve` | `+ actions: read` (read workflow run metadata) |
| `build-push / image` | `+ packages: write` (push to GHCR) |
| `build-push / release-manifest` | `+ actions: read` (download artifact from same run) |
| `deploy` default | `contents: read` |
| `deploy / deploy` | `+ actions: read` (download build artifact) |

`GITHUB_TOKEN` is **never** passed to the SSH session or the server.  
The `GHCR_READ_TOKEN` (read-only PAT) is passed separately — write credentials never leave GitHub Actions runners.

---

## 6. Security controls implemented

| Control | Implementation |
|---|---|
| **Secret scanning** | `persist-credentials: false` on all checkout steps |
| **Supply chain** | All Actions pinned to 40-char SHA; npm `audit signatures` in CI |
| **Dep vulnerabilities** | Custom gate (`audit-gate.mjs`) + reviewed allowlist; `dependency-review-action` on PRs |
| **SAST** | CodeQL on `javascript-typescript` + `actions` language matrix |
| **Image provenance** | SBOM + provenance attestations on pushed images (`sbom: true`, `provenance: mode=max`) |
| **Digest verification** | Deploy workflow verifies pulled image digests match what Build & Push published |
| **Credential isolation** | SSH private key never touches the server's process list; passed via `echo | stdin` |
| **Concurrency** | PR runs cancel on new push; CD never cancels mid-deploy |
| **Auto-rollback** | Deploy script rolls back and re-runs `compose up` with the previous tag on health failure |

---

## 7. What requires real GitHub credentials or infrastructure

The following **cannot be verified locally** and require the full GitHub Actions runtime:

| Item | Requirement | Why |
|---|---|---|
| **CodeQL upload** | GitHub Advanced Security OR public repo | `security-events: write` on private repos requires GHAS subscription |
| **dependency-review-action** | GHAS or public repo | Same restriction |
| **workflow_run trigger** | Real GitHub push event | `workflow_run` doesn't fire locally; use `workflow_dispatch` to test |
| **GHCR image push** | `secrets.GITHUB_TOKEN` with `packages: write` | Requires real GitHub runner authentication |
| **SSH deploy** | Live server + populated environment secrets | No local equivalent |
| **Health check** | Live server with TLS cert + running containers | Local smoke tests cover containers but not full TLS stack |
| **Rollback** | Requires a previous deploy tag recorded in `.previous-tag` | Cannot be tested on first deploy |

---

## 8. Known limitations

### 8a. GitHub Free + private repo
- **CodeQL**: The `codeql` job will error with `Resource not accessible by integration` on a private repo without GHAS. **Mitigation:** Make the repo public, or disable the job, or upgrade to GitHub Team/Enterprise.
- **dependency-review**: Same restriction. It runs on PRs only, so it may silently pass rather than error.
- **Branch protection**: Cannot be enforced via API on GitHub Free private repos. Manual merge discipline required.

### 8b. Docker builds cross-platform
- Builds use `--platform linux/amd64` explicitly. The local Mac (Apple Silicon) uses Colima for x86_64 emulation. First build is slow (~15 min); subsequent builds use Docker layer cache.

### 8c. Worker smoke test Chromium dependency
- `smoke-worker-image.sh` starts the jobs worker (not the WhatsApp Web pilot) to avoid needing a live WhatsApp session. The Chromium check is a file-existence check only.

---

## 9. Errors found and fixed during audit

| Issue | Root cause | Resolution |
|---|---|---|
| `npm audit --audit-level=high` would fail CI | 11 high advisories, all Puppeteer/whatsapp-web.js transitive | Custom gate + allowlist |
| Audit gate flagged patched `zod@4.6.7` | Gate scanned all installed copies | Fixed: scope to `vuln.nodes` paths only |
| `shellcheck SC2015` anti-patterns | `A && B \|\| C` idiom in smoke scripts | Rewrote as `if/fi` blocks |
| `backup.sh` checksum ran in wrong dir on `cd` failure | Unsafe `cd || shasum` | Extracted `sha256()` function; `cd` failure now exits |
| `restore-test.sh` `ls \| grep` | `shellcheck SC2010` | Replaced with glob pattern |
| `shellcheck SC2029` in deploy SSH steps | Intentional client-side expansion | Annotated with `# shellcheck disable=SC2029` |
| MongoDB 8.0.32 fails on kernel ≥ 6.19 | `SERVER-121912` tcmalloc rseq conflict | Updated to `mongo:9.0.4` (SERVER-131779 fix) |
| Old `ci.yml` duplicated jobs | Workflow was not retired when new files were added | Deleted `.github/workflows/ci.yml` |

