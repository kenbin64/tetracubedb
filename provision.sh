#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# TETRACUBEDB — Provisioning Script
# ═══════════════════════════════════════════════════════════════════════════════
# Run once on the server to:
#   1. Install dependencies
#   2. Create persistent data directory at /var/lib/tetracubedb
#   3. Install nginx config
#   4. Obtain Let's Encrypt SSL certificate
#   5. Register tetracubedb PM2 process
#   6. Create kensgames API client and print credentials
#
# Usage:  sudo bash provision.sh
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
APP_DIR="/home/butterfly/apps/tetracubedb/server"
DATA_DIR="/var/lib/tetracubedb"
WEB_ROOT="/var/www/tetracubedb.com/public"
NGINX_CONF="/etc/nginx/sites-available/tetracubedb.com"
NGINX_ENABLED="/etc/nginx/sites-enabled/tetracubedb.com"
NGINX_SRC="$(cd "$(dirname "$0")/nginx" && pwd)/tetracubedb.com.conf"
PM2_NAME="tetracubedb"
DOMAIN="tetracubedb.com"
EMAIL="admin@kensgames.com"   # change for certbot registration

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; NC='\033[0m'

[[ $EUID -ne 0 ]] && { echo -e "${R}Run as root: sudo bash provision.sh${NC}"; exit 1; }

echo -e "${Y}════════════════════════════════════════════════════${NC}"
echo -e "${Y}  TetracubeDB — Provision & Deploy${NC}"
echo -e "${Y}════════════════════════════════════════════════════${NC}"

# ── [1] Data directory (survives all deploys) ─────────────────────────────────
echo -e "\n${Y}[1] Persistent data directory${NC}"
mkdir -p "$DATA_DIR"
chown butterfly:butterfly "$DATA_DIR"
chmod 750 "$DATA_DIR"
echo -e "${G}  ✓ $DATA_DIR${NC}"

# ── [2] Web root for nginx static ─────────────────────────────────────────────
echo -e "\n${Y}[2] Web root${NC}"
mkdir -p "$WEB_ROOT"
# Copy full landing page from repo
LANDING_SRC="$(cd "$(dirname "$0")/public" && pwd)/index.html"
if [[ -f "$LANDING_SRC" ]]; then
  cp -f "$LANDING_SRC" "$WEB_ROOT/index.html"
  echo -e "${G}  ✓ Landing page deployed to $WEB_ROOT${NC}"
else
  echo -e "${Y}  ⚠ No public/index.html found — web root left empty${NC}"
fi
echo -e "${G}  ✓ $WEB_ROOT${NC}"

# ── [3] Install npm dependencies ──────────────────────────────────────────────
echo -e "\n${Y}[3] npm install${NC}"
cd "$APP_DIR"
sudo -u butterfly npm install --production --ignore-scripts
# better-sqlite3 binding: reuse compiled binary from kensgames (same machine, same Node)
BINDING_SRC="/home/butterfly/apps/kensgames-portal/manifold/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
BINDING_DST="$APP_DIR/node_modules/better-sqlite3/build/Release"
mkdir -p "$BINDING_DST"
[[ -f "$BINDING_SRC" ]] && cp -f "$BINDING_SRC" "$BINDING_DST/" && echo -e "${G}  ✓ better-sqlite3 binding copied${NC}"
echo -e "${G}  ✓ dependencies installed${NC}"

# ── [4] .env file ─────────────────────────────────────────────────────────────
echo -e "\n${Y}[4] Environment config${NC}"
if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "DATA_DIR=$DATA_DIR" >> "$APP_DIR/.env"
  echo -e "${G}  ✓ .env created from .env.example — review and fill in secrets${NC}"
else
  echo "  .env already exists — skipping"
fi

# ── [5] nginx config ──────────────────────────────────────────────────────────
echo -e "\n${Y}[5] nginx config${NC}"
cp "$NGINX_SRC" "$NGINX_CONF"
if [[ ! -L "$NGINX_ENABLED" ]]; then
  ln -s "$NGINX_CONF" "$NGINX_ENABLED"
fi
nginx -t && systemctl reload nginx
echo -e "${G}  ✓ nginx config installed and reloaded${NC}"

# ── [6] SSL certificate ───────────────────────────────────────────────────────
echo -e "\n${Y}[6] SSL certificate (Let's Encrypt)${NC}"
if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  # Temporarily serve HTTP only for certbot challenge
  certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" \
    --non-interactive --agree-tos -m "$EMAIL" \
    --redirect
  echo -e "${G}  ✓ SSL certificate obtained${NC}"
else
  echo "  Certificate already exists — run: certbot renew"
fi

# ── [7] PM2 process ───────────────────────────────────────────────────────────
echo -e "\n${Y}[7] PM2 — register $PM2_NAME${NC}"
# Check if pm2 is available
if ! command -v pm2 &>/dev/null; then
  echo -e "${R}  pm2 not found — install with: npm install -g pm2${NC}"
else
  # Stop existing if running
  pm2 describe "$PM2_NAME" &>/dev/null && pm2 delete "$PM2_NAME" || true
  # Start from persistent data dir perspective
  sudo -u butterfly pm2 start "$APP_DIR/index.js" \
    --name "$PM2_NAME" \
    --cwd "$APP_DIR" \
    --env production \
    --log "/var/log/tetracubedb.log" \
    --time
  sudo -u butterfly pm2 save
  echo -e "${G}  ✓ pm2 process started: $PM2_NAME${NC}"
fi

# ── [8] Create kensgames API client ───────────────────────────────────────────
echo -e "\n${Y}[8] kensgames API client${NC}"
echo "  Waiting for TetracubeDB to start..."
sleep 3

# Read bootstrap admin credentials from first boot output or prompt
echo ""
echo -e "${Y}  To create the kensgames client, use the bootstrap admin credentials${NC}"
echo -e "${Y}  that were printed when TetracubeDB first started.${NC}"
echo ""
echo "  Run this command with the bootstrap credentials:"
echo ""
echo "  curl -s -X POST https://$DOMAIN/admin/clients \\"
echo "    -H 'Authorization: Bearer <client_id>:<api_key>' \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"name\":\"kensgames\",\"namespaces\":[\"kensgames\"],\"is_admin\":false}'"
echo ""
echo "  Then add the returned client_id and api_key to:"
echo "  /home/butterfly/apps/kensgames-portal/manifold/server/.env"
echo "    TETRACUBE_URL=https://$DOMAIN"
echo "    TETRACUBE_CLIENT_ID=<client_id>"
echo "    TETRACUBE_API_KEY=<api_key>"
echo "    TETRACUBE_NS=kensgames"
echo ""

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${G}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${G}║  TETRACUBEDB PROVISION COMPLETE                   ║${NC}"
echo -e "${G}╠═══════════════════════════════════════════════════╣${NC}"
echo -e "${G}║  API:       https://$DOMAIN            ║${NC}"
echo -e "${G}║  WebSocket: wss://$DOMAIN/ws           ║${NC}"
echo -e "${G}║  Health:    https://$DOMAIN/health     ║${NC}"
echo -e "${G}║  Data:      $DATA_DIR                   ║${NC}"
echo -e "${G}║  Logs:      pm2 logs $PM2_NAME                   ║${NC}"
echo -e "${G}╚═══════════════════════════════════════════════════╝${NC}"
echo ""
