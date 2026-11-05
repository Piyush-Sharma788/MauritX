# MarutiX CI/CD Setup Guide

> [!IMPORTANT]
> Complete every step in order before pushing to `main` or creating a release tag.
> The Deploy workflow will refuse to run on a machine that has no `.env.production`.

---

## Architecture overview

```
push to main / release tag
        │
        ▼
┌─────────────────┐    fails → ✗ blocked
│  Code Quality   │─────────────────────────────────
│  (code-quality) │                                 │
│  ESLint         │                                 │
│  TypeScript     │   succeeds                      │
│  Tests (Mongo)  │───────────────────┐             │
│  Dep audit      │                   │             │
│  CodeQL         │                   ▼             │
└─────────────────┘      ┌──────────────────────┐  │
                         │   Build & Push       │  │
                         │   (build-push)       │  │
                         │   Next.js build      │  │
                         │   Docker web image   │  │
                         │   Docker worker img  │  │
                         │   Smoke tests        │  │
                         │   Push to GHCR       │  │
                         │   Deploy manifest    │  │
                         └──────────┬───────────┘  │
                                    │ succeeds      │
                                    ▼               │
                         ┌──────────────────────┐  │
                         │   Deploy             │  │
                         │   (deploy)           │  │
                         │   staging: auto      │  │
                         │   production: tag    │  │
                         │   Digest verify      │  │
                         │   docker compose up  │  │
                         │   Health check       │  │
                         │   Auto-rollback      │  │
                         └──────────────────────┘  │
```

---

## 1. GitHub Environments

Go to **GitHub → Settings → Environments** and create two environments:

| Environment | Purpose |
|---|---|
| `staging` | Automatic deploy on every push to `main` |
| `production` | Deploy only on release tags (`v*.*.*`), with optional manual approval |

For **production**, optionally add **Required reviewers** (your GitHub username) so every production deploy needs manual sign-off.

---

## 2. Required GitHub Secrets

### Repository-level Secrets  
*(Settings → Secrets and variables → Actions → Secrets)*

| Secret name | Description | How to generate |
|---|---|---|
| *(none required at repo level)* | — | — |

### Environment-level Secrets  
*(Settings → Environments → `staging` / `production` → Environment secrets)*

Add all of these to **both** environments (with values appropriate to each):

| Secret name | Description | How to get it |
|---|---|---|
| `SSH_PRIVATE_KEY` | Ed25519 private key that the workflow uses to SSH into the server | `ssh-keygen -t ed25519 -f deploy_key -C "marutix-deploy"` — do **not** passphrase-protect it |
| `SSH_KNOWN_HOSTS` | Server host fingerprints (prevents MITM) | `ssh-keyscan -H your-server-hostname` |
| `GHCR_READ_TOKEN` | GitHub Classic PAT with **`read:packages`** scope (for the server to pull images) | GitHub → Settings → Developer settings → Personal access tokens → Classic → scopes: `read:packages` |

> [!TIP]
> After generating `deploy_key`, append `deploy_key.pub` to `~/.ssh/authorized_keys` on the server for the deploy user. Keep `deploy_key` (private) only in GitHub Secrets — never commit it.

---

## 3. Required GitHub Variables

### Repository-level Variables  
*(Settings → Secrets and variables → Actions → Variables)*

| Variable name | Description | Example |
|---|---|---|
| `WHATSAPP_WEB_PUBLIC_NUMBER` | WhatsApp number baked into the web Docker image at build time (the number users see) | `+919876543210` |
| `STAGING_DEPLOY_ENABLED` | Set to `true` to enable automatic staging deploys on push to `main`. Leave blank or `false` to disable. | `true` |
| `PRODUCTION_DEPLOY_ENABLED` | Set to `true` to enable automatic production deploys on release tags. Leave blank or `false` to disable. | `true` |
| `GHCR_READ_USER` | GitHub username that owns the `GHCR_READ_TOKEN` | `Piyush-Sharma788` |

### Environment-level Variables  
*(Settings → Environments → `staging` / `production` → Environment variables)*

| Variable name | Description | Example (staging) | Example (production) |
|---|---|---|---|
| `DEPLOY_HOST` | Hostname or IP of the server | `staging.marutix.example.com` | `marutix.example.com` |
| `DEPLOY_USER` | SSH user (must be in the `docker` group on the server) | `deploy` | `deploy` |
| `DEPLOY_PATH` | Absolute path on the server where compose files and `.env.production` live | `/opt/marutix-staging` | `/opt/marutix` |
| `APP_URL` | Public HTTPS base URL (used for post-deploy health checks) | `https://staging.marutix.example.com` | `https://marutix.example.com` |

---

## 4. Server prerequisites

Run the following once on each server (staging and production):

```bash
# 1. Install Docker + Compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $DEPLOY_USER   # or your deploy user name

# 2. Create the deployment directory
sudo mkdir -p /opt/marutix
sudo chown $DEPLOY_USER:$DEPLOY_USER /opt/marutix

# 3. Create .env.production  (fill in real values)
cat > /opt/marutix/.env.production <<'EOF'
NODE_ENV=production
APP_BASE_URL=https://marutix.example.com

# MongoDB Atlas (external)
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/marutix?retryWrites=true

# Auth
AUTH_JWT_SECRET=<openssl rand -hex 64>
OTP_HASH_SECRET=<openssl rand -hex 32>
PII_ENCRYPTION_KEY=<openssl rand -base64 32>

# WhatsApp Cloud (or leave blank and set MESSAGING_PROVIDER=whatsapp_web)
MESSAGING_PROVIDER=whatsapp_cloud
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<openssl rand -hex 32>

# WhatsApp Web pilot (only needed when MESSAGING_PROVIDER=whatsapp_web)
WHATSAPP_WEB_WORKER_SECRET=<openssl rand -hex 32>

# Email (Resend)
EMAIL_PROVIDER=resend
RESEND_API_KEY=
EMAIL_FROM=noreply@marutix.example.com

# AI
OPENAI_API_KEY=
EOF
chmod 600 /opt/marutix/.env.production

# 4. Log Docker into GHCR so the server can pull images
# (The deploy script does this automatically using GHCR_READ_TOKEN,
#  but log in manually now to verify access)
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u "$GHCR_READ_USER" --password-stdin
```

---

## 5. First deployment (manual trigger)

After setting up Secrets/Variables and the server:

1. Go to **GitHub → Actions → Build & Push**
2. Click **Run workflow** → select `main` branch → Run
3. Once Build & Push succeeds, go to **Deploy → Run workflow** → select environment → Run

The Deploy workflow:
1. Downloads the deploy manifest created by Build & Push
2. SSH-es into the server as `$DEPLOY_USER`
3. Copies `deploy/docker-compose.prod.yml` and `scripts/ci/remote-deploy.sh` to `$DEPLOY_PATH`
4. Verifies pulled image digests match what GHCR published (tamper-proof)
5. Runs `docker compose up -d` with the new tag
6. Waits for containers to become healthy
7. Hits `$APP_URL/api/health` and asserts `{"status":"ok","db":"up"}`
8. **Auto-rolls back** if health check fails within 90 s

---

## 6. Release process

```bash
# Tag the commit you want to promote to production
git tag v1.0.0
git push origin v1.0.0
```

This triggers:
1. **Code Quality** runs for the tagged commit
2. **Build & Push** publishes images tagged `v1.0.0`, `1.0`, and `sha-<commit>`  
3. **Deploy** deploys to production automatically (if `PRODUCTION_DEPLOY_ENABLED=true`)

---

## 7. Manual rollback

```bash
# On the server, roll back to the previous tag
cd /opt/marutix
PREV=$(cat .previous-tag 2>/dev/null) || { echo "No previous tag"; exit 1; }
MARUTIX_IMAGE_PREFIX=ghcr.io/piyush-sharma788 \
MARUTIX_IMAGE_TAG="$PREV" \
docker compose -f docker-compose.yml up -d
```

The Deploy workflow performs this rollback automatically on health-check failure.

---

## 8. GitHub Actions known limitations

| Limitation | Detail |
|---|---|
| **CodeQL on private repos** | The `codeql` job in `code-quality.yml` requires GitHub Advanced Security (GHAS), which is not included in GitHub Free for private repos. The job will fail with a permissions error. Either make the repo public, or disable the `codeql` job until you upgrade. |
| **dependency-review-action on private repos** | Same restriction — requires GHAS. The `dependency-review` job runs only on PRs; it will silently succeed or error depending on your repo visibility. |
| **No branch protection** | GitHub Free private repos cannot enforce required status checks via API. Merge discipline is manual. |
| **`GITHUB_TOKEN` package write** | The `Build & Push` workflow uses `secrets.GITHUB_TOKEN` to push images. This works automatically as long as the `packages: write` permission is set (it is). |

---

## 9. Disabling automatic deploys

| To disable... | Action |
|---|---|
| Automatic staging deploys | Delete or set `STAGING_DEPLOY_ENABLED` variable to anything other than `true` |
| Automatic production deploys | Delete or set `PRODUCTION_DEPLOY_ENABLED` variable to anything other than `true` |
| All deploys | Remove the `Deploy` environment secrets — the SSH step will fail safely |

