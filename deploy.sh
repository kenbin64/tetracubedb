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
DO_INGEST=true

for arg in "$@"; do
  [[ "$arg" == "--no-restart" ]] && DO_RESTART=false
  [[ "$arg" == "--no-ingest"  ]] && DO_INGEST=false
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

# Sync public web assets to web root
PUBLIC_SRC="$(cd "$(dirname "$0")/public" && pwd)"
WEB_ROOT="/var/www/tetracubedb.com/public"
if [[ -d "$PUBLIC_SRC" ]] && [[ -d "$WEB_ROOT" ]]; then
  cp -f "$PUBLIC_SRC/index.html" "$WEB_ROOT/index.html"
  echo -e "${G}  ✓ landing page synced${NC}"
  if [[ -f "$PUBLIC_SRC/manifold.app.json" ]]; then
    cp -f "$PUBLIC_SRC/manifold.app.json" "$WEB_ROOT/manifold.app.json"
    echo -e "${G}  ✓ manifold.app.json synced${NC}"
  fi
  for sub in entities substrate js; do
    if [[ -d "$PUBLIC_SRC/$sub" ]]; then
      mkdir -p "$WEB_ROOT/$sub"
      rsync -a --delete "$PUBLIC_SRC/$sub/" "$WEB_ROOT/$sub/"
      echo -e "${G}  ✓ $sub/ synced${NC}"
    fi
  done
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

# ── Self-ingest: POST each entity manifest into the local /v1/cell API ────
# Reads TETRACUBE_CLIENT_ID / TETRACUBE_API_KEY / TETRACUBE_NS from server/.env.
# Skips with a warning if creds are not configured.
if $DO_INGEST; then
  ENV_FILE="$APP_DIR/.env"
  if [[ -f "$ENV_FILE" ]]; then
    set -a; . "$ENV_FILE"; set +a
  fi
  PORT_LOCAL="${PORT:-4747}"
  TETRA_CID="${TETRACUBE_CLIENT_ID:-}"
  TETRA_KEY="${TETRACUBE_API_KEY:-}"
  TETRA_NS="${TETRACUBE_NS:-tetracubedb}"
  TETRA_TABLE="${TETRACUBE_TABLE:-entity.registry}"
  BASE="http://127.0.0.1:${PORT_LOCAL}"

  if [[ -z "$TETRA_CID" || -z "$TETRA_KEY" ]]; then
    echo -e "${Y}  ! TETRACUBE_CLIENT_ID / TETRACUBE_API_KEY not set — skipping self-ingest${NC}"
  elif ! command -v curl >/dev/null 2>&1; then
    echo -e "${Y}  ! curl missing — skipping self-ingest${NC}"
  else
    # Wait briefly for the server to be ready after restart
    for i in 1 2 3 4 5; do
      curl -sf "$BASE/health" >/dev/null 2>&1 && break
      sleep 1
    done

    AUTH="Authorization: Bearer ${TETRA_CID}:${TETRA_KEY}"
    OK_N=0; FAIL_N=0

    post_cell() {
      local row="$1" col="$2" file="$3"
      local url="${BASE}/v1/cell/${TETRA_NS}/${TETRA_TABLE}/${row}/${col}"
      local body; body="$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({value:JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}))' "$file" 2>/dev/null)"
      [[ -z "$body" ]] && { FAIL_N=$((FAIL_N+1)); echo -e "    ${Y}✗ $row/$col — could not read $file${NC}"; return; }
      local code; code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H "$AUTH" -H "Content-Type: application/json" \
        --data "$body" "$url")
      if [[ "$code" =~ ^2 ]]; then
        echo -e "    ${G}✓ ${TETRA_TABLE}/${row}/${col}${NC}"
        OK_N=$((OK_N+1))
      else
        echo -e "    ${Y}✗ ${row}/${col} → HTTP ${code}${NC}"
        FAIL_N=$((FAIL_N+1))
      fi
    }

    echo -e "${Y}Self-ingesting entity manifests → ${BASE} (ns=${TETRA_NS})${NC}"
    for dir in "$PUBLIC_SRC/entities/"*/; do
      [[ -d "$dir" ]] || continue
      id="$(basename "$dir")"
      manifest="$dir/manifold.entity.json"
      [[ -f "$manifest" ]] && post_cell "$id" "manifest" "$manifest"
    done
    if [[ -f "$PUBLIC_SRC/manifold.app.json" ]]; then
      post_cell "tetracubedb" "app" "$PUBLIC_SRC/manifold.app.json"
    fi
    echo -e "${G}  ✓ ingest complete — ${OK_N} registered${NC}$([[ $FAIL_N -gt 0 ]] && echo -e " ${Y}· ${FAIL_N} failed${NC}" || true)"
  fi
fi

echo ""
echo -e "${G}  Data:    /var/lib/tetracubedb/tetracube.db  (untouched)${NC}"
echo -e "${G}  Logs:    pm2 logs $PM2_NAME${NC}"
echo -e "${G}  Status:  pm2 status${NC}"
echo ""
