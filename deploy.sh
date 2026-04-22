#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# TETRACUBEDB — Deploy / Update Script
# ═══════════════════════════════════════════════════════════════════════════════
# Use this for subsequent deploys after initial provision.
# Data directory /var/lib/tetracubedb is NEVER touched — survives all deploys.
#
# Usage:  bash deploy.sh [--no-restart]
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

APP_DIR="/home/butterfly/apps/tetracubedb/server"
PM2_NAME="tetracubedb"
DO_RESTART=true

for arg in "$@"; do
  [[ "$arg" == "--no-restart" ]] && DO_RESTART=false
done

G='\033[0;32m'; Y='\033[1;33m'; NC='\033[0m'
echo -e "${Y}TetracubeDB — Deploy  $(date +%Y%m%d_%H%M%S)${NC}"

cd "$APP_DIR"
npm install --production --ignore-scripts
# better-sqlite3 native binding: compile once, copy on every deploy
BINDING_SRC="/home/butterfly/apps/kensgames-portal/manifold/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
BINDING_DST="$APP_DIR/node_modules/better-sqlite3/build/Release"
mkdir -p "$BINDING_DST"
[[ -f "$BINDING_SRC" ]] && cp -f "$BINDING_SRC" "$BINDING_DST/" && echo -e "${G}  ✓ better-sqlite3 binding restored${NC}"
echo -e "${G}  ✓ dependencies updated${NC}"

# Sync landing page to web root
LANDING_SRC="$(cd "$(dirname "$0")/public" && pwd)/index.html"
WEB_ROOT="/var/www/tetracubedb.com/public"
if [[ -f "$LANDING_SRC" ]] && [[ -d "$WEB_ROOT" ]]; then
  cp -f "$LANDING_SRC" "$WEB_ROOT/index.html"
  echo -e "${G}  ✓ landing page synced${NC}"
fi

if $DO_RESTART; then
  if pm2 describe "$PM2_NAME" &>/dev/null; then
    pm2 reload "$PM2_NAME" --update-env
    echo -e "${G}  ✓ pm2 reloaded — zero-downtime${NC}"
  else
    pm2 start "$APP_DIR/index.js" --name "$PM2_NAME" --cwd "$APP_DIR" --time
    pm2 save
    echo -e "${G}  ✓ pm2 started${NC}"
  fi
fi

echo ""
echo -e "${G}  Data:    /var/lib/tetracubedb/tetracube.db  (untouched)${NC}"
echo -e "${G}  Logs:    pm2 logs $PM2_NAME${NC}"
echo -e "${G}  Status:  pm2 status${NC}"
echo ""
