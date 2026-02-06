# Ubuntu VM Docker Setup Guide

Step-by-step guide for deploying Inbox Zero on an Ubuntu VM using Docker Compose, with an external Supabase database.

## Prerequisites

- Ubuntu 22.04+ VM with at least 2GB RAM, 2 CPU cores, 20GB storage
- A domain name with DNS pointing to your VM's public IP
- SSH access to the VM
- An existing Supabase project (or other external PostgreSQL database)

## 1. Initial Server Setup

SSH into your VM and update the system:

```bash
sudo apt update && sudo apt upgrade -y
```

### Configure the Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 2. Install Docker

```bash
# Install dependencies
sudo apt install -y ca-certificates curl gnupg

# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add the Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Allow your user to run Docker without sudo
sudo usermod -aG docker $USER
newgrp docker
```

Verify the installation:

```bash
docker --version
docker compose version
```

## 3. Install Node.js

Node.js is needed for the setup CLI:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

## 4. Clone the Repository

```bash
git clone https://github.com/elie222/inbox-zero.git
cd inbox-zero
```

## 5. Configure Environment Variables

Run the setup CLI to auto-generate secrets:

```bash
npm install
npm run setup
```

Then edit `apps/web/.env` to configure your specific settings:

```bash
nano apps/web/.env
```

### Required Configuration

**Database (Supabase):**

Since you're using an existing Supabase database, set these to your Supabase connection strings (found in Supabase Dashboard > Settings > Database > Connection strings):

```
DATABASE_URL="postgresql://postgres.[project-ref]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.[project-ref]:[password]@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
```

**LLM Provider:**

Uncomment one provider block in `.env` and add your API key. For example, with Anthropic:

```
DEFAULT_LLM_PROVIDER=anthropic
DEFAULT_LLM_MODEL=claude-sonnet-4-5-20250929
ANTHROPIC_API_KEY=sk-ant-...
```

**Email Provider OAuth:**

Configure at least one email provider (Google, Microsoft, or Fastmail). See [Environment Variables Reference](./environment-variables.md) for details.

### Docker Compose Profile

Since you're using Supabase (external database), you only need local Redis. Use the `local-redis` profile when starting (shown in step 7).

If you're also using an external Redis service (e.g., Upstash), you don't need any profile — just set `UPSTASH_REDIS_URL` and `UPSTASH_REDIS_TOKEN` in your `.env`.

## 6. Set Up a Reverse Proxy with Caddy

Caddy provides automatic HTTPS with Let's Encrypt. This is required for OAuth callbacks and webhook endpoints.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Create the Caddy configuration:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
yourdomain.com {
    reverse_proxy localhost:3000
}
EOF
```

Replace `yourdomain.com` with your actual domain, then restart Caddy:

```bash
sudo systemctl restart caddy
sudo systemctl enable caddy
```

Caddy will automatically obtain and renew SSL certificates.

## 7. Start the Application

From the `inbox-zero` directory:

```bash
# Using external database (Supabase) + local Redis
NEXT_PUBLIC_BASE_URL=https://yourdomain.com docker compose --profile local-redis up -d

# Or, using external database AND external Redis (no profile needed)
NEXT_PUBLIC_BASE_URL=https://yourdomain.com docker compose up -d
```

The `NEXT_PUBLIC_BASE_URL` must be passed as a shell variable (not in `.env`) because `docker-compose.yml` overrides the `.env` value.

## 8. Verify the Deployment

```bash
# Check containers are running
docker ps

# Watch the web container logs (migrations run on first start)
docker logs inbox-zero-services-web-1 -f
```

You should see:
1. Database migrations running
2. "Starting server..." message
3. Your app accessible at `https://yourdomain.com`

## 9. Update OAuth Redirect URIs

After deployment, update your OAuth provider settings to use the new domain:

**Google Cloud Console:**
- Authorized redirect URIs: `https://yourdomain.com/api/auth/callback/google`
- Authorized JavaScript origins: `https://yourdomain.com`

**Microsoft Azure Portal (if using Outlook):**
- Redirect URI: `https://yourdomain.com/api/auth/callback/microsoft`

**Google Pub/Sub (for Gmail webhooks):**
- Push endpoint: `https://yourdomain.com/api/google/webhook`

## 10. Enable Auto-Start on Boot

Docker containers with `restart: always` (already set in docker-compose.yml) will restart automatically when Docker starts. Ensure Docker starts on boot:

```bash
sudo systemctl enable docker
```

## Updating

Pull the latest image and restart:

```bash
cd ~/inbox-zero
docker compose pull web
NEXT_PUBLIC_BASE_URL=https://yourdomain.com docker compose --profile local-redis up -d
```

## Monitoring

```bash
# View live logs
docker compose logs -f web

# Check resource usage
docker stats

# Check cron job status
docker compose logs -f cron
```

## Troubleshooting

### Migrations Fail on Startup

If migrations time out or fail, they may already be applied. Check the logs:

```bash
docker logs inbox-zero-services-web-1 | grep -i migrat
```

### Cannot Connect to Supabase

- Ensure your VM's IP is not blocked by Supabase network restrictions
- Verify connection strings are correct (pooled URL for `DATABASE_URL`, direct for `DIRECT_URL`)
- Test connectivity: `curl -v telnet://aws-0-us-east-1.pooler.supabase.com:6543`

### Caddy SSL Issues

```bash
# Check Caddy status
sudo systemctl status caddy

# View Caddy logs
sudo journalctl -u caddy --no-pager -n 50

# Ensure DNS is properly configured
dig yourdomain.com
```

### Out of Memory

If the VM runs out of memory, add swap:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

For more troubleshooting, see the [Self-Hosting Guide](./self-hosting.md#troubleshooting).
