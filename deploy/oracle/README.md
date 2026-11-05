# Running the MarutiX workers on Oracle Cloud (Always Free)

The web app runs on Vercel and the database on MongoDB Atlas. This VM runs only the two
background workers, around the clock:

- **worker**: the WhatsApp bot. Sends alerts, bot replies and sign-in codes, and reads incoming messages.
- **jobs**: donor notification waves, request coordination, institution discovery and outreach email.

They reach Vercel only through Atlas, so the VM needs **no open ports** beyond SSH.

## 1. Create the VM (about 10 minutes)

1. Sign up at <https://www.oracle.com/cloud/free/>. A card is used to verify your identity; Always Free resources aren't charged.
2. Go to **Compute → Instances → Create instance**:
   - **Image:** Canonical Ubuntu 24.04
   - **Shape:** Ampere → `VM.Standard.A1.Flex`, **1 OCPU, 6 GB RAM**
   - **SSH keys:** upload your public key (`~/.ssh/id_ed25519.pub`), or download the generated one
   - Leave networking at the defaults (public IP, SSH only).
3. If you get **"Out of capacity"**, try another availability domain, or retry later. A1 capacity comes and goes.

## 2. Prepare the server

```bash
ssh ubuntu@<VM_IP>
# copy deploy/oracle/setup.sh to the VM first, e.g. from your Mac:
#   scp deploy/oracle/setup.sh ubuntu@<VM_IP>:~
bash setup.sh
```

The first run prints a **deploy key**. Add it in GitHub → `Piyush-Sharma788/MauritX` → Settings →
Deploy keys → *Add deploy key* (leave "Allow write access" **off**), then run `bash setup.sh` again.
When it finishes, log out and back in.

## 3. Add the settings

From your Mac, copy your `.env` to the server:

```bash
scp .env ubuntu@<VM_IP>:~/MauritX/deploy/oracle/.env.production
```

Then on the server, switch it to production values:

```bash
cd ~/MauritX/deploy/oracle
sed -i 's#^APP_BASE_URL=.*#APP_BASE_URL=https://maurit-x.vercel.app#' .env.production
grep -q '^OTP_ALLOW_WHATSAPP_WEB_IN_PROD=' .env.production || echo 'OTP_ALLOW_WHATSAPP_WEB_IN_PROD=true' >> .env.production
chmod 600 .env.production
```

`MONGODB_URI`, `PII_ENCRYPTION_KEY`, `AUTH_JWT_SECRET` and `OTP_HASH_SECRET` **must be identical to
Vercel's**. The workers decrypt phone numbers that the website encrypted.

## 4. Move the bot from your Mac to the VM

Only one WhatsApp worker may run at a time.

1. On your Mac, stop both workers (Ctrl+C in their terminals) and wait about 30 seconds.
2. On the VM:

   ```bash
   cd ~/MauritX/deploy/oracle
   docker compose up -d --build        # first build takes a few minutes
   docker compose logs -f worker       # a QR code appears here
   ```

3. On the bot phone, go to WhatsApp → **Linked devices → Link a device**, and scan the QR code.
   Wait for `whatsapp.ready` in the logs, then press Ctrl+C. The worker keeps running.
4. In **Linked devices**, log out the old entry for your Mac.

The session is stored in a Docker volume, so restarts and rebuilds don't need a new QR code.

## Everyday commands

| What | Command (in `~/MauritX/deploy/oracle`) |
|---|---|
| Status | `docker compose ps` |
| Live logs | `docker compose logs -f worker` / `docker compose logs -f jobs` |
| Deploy new code | `git -C ~/MauritX pull && docker compose up -d --build` |
| Restart | `docker compose restart` |
| Stop | `docker compose down` (keeps the WhatsApp session) |

Containers restart on their own after a crash or a VM reboot.

## Keeping it free

- Stay within Always Free: A1 Flex up to 4 OCPU / 24 GB total, and 200 GB of block storage.
- Oracle may reclaim Always Free instances that sit idle for a long time. These workers keep the CPU
  lightly busy, but if you'd like extra safety, upgrading to Pay-As-You-Go still costs nothing while you stay within the free limits.
