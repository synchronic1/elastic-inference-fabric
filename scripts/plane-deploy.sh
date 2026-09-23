#!/usr/bin/env bash
# plane-deploy.sh — build and deploy the plane-heurchain overlay (Plane v1.3.1)
#
# Usage:
#   plane-deploy.sh              — build + deploy the main web app (default)
#   plane-deploy.sh web          — same
#   plane-deploy.sh admin        — build + deploy the god-mode admin app
#   plane-deploy.sh api          — apply API overlays and restart api/worker/beat-worker
#   plane-deploy.sh all          — all three
#   plane-deploy.sh check        — report overlay drift (host vs container, mount coverage)
#   plane-deploy.sh verify       — health-check the running stack
#   plane-deploy.sh rollback-web — restore the newest pre-build web bundle backup
#
# See RUNBOOK.md for the full model. The short version:
#
#   * api / worker / beat-worker read /code/plane/... through READ-ONLY bind mounts
#     of ~/plane-selfhost/plane-app/overlays/**. Editing the file on the host changes
#     it inside the container immediately, but gunicorn and celery do NOT auto-reload,
#     so a container restart is what actually applies an overlay edit.
#     `docker cp` into a mounted path FAILS ("Read-only file system"); copying is only
#     needed for overlay files that are NOT in docker-compose.override.yaml — and those
#     live in the container's writable layer, so they DISAPPEAR on container recreation.
#   * web and admin have NO bind mounts. Every UI change is a full pnpm build copied
#     into the nginx container. `docker cp` never deletes, so stale hashed chunks
#     accumulate unless pruned (see deploy_web).

set -euo pipefail

TARGET="${1:-web}"
PLANE_SRC="${PLANE_SRC:-$HOME/plane-source}"
PLANE_APP="${PLANE_APP:-$HOME/plane-selfhost/plane-app}"
BACKUP_DIR="$HOME/overlay-backups"
WEB_CONTAINER=plane-app-web-1
ADMIN_CONTAINER=plane-app-admin-1
API_CONTAINER=plane-app-api-1
WORKER_CONTAINER=plane-app-worker-1
BEAT_CONTAINER=plane-app-beat-worker-1
LISTEN_PORT=8090

die() { echo "[error] $*" >&2; exit 1; }
info() { echo "[$(date +%H:%M:%S)] $*"; }

# ── overlay ↔ mount mapping ──────────────────────────────────────────────────
# Overlay files under a path listed in docker-compose.override.yaml are already
# live in the container (read-only bind mount). Anything else must be copied in,
# and is lost when the container is recreated.
#
# override entries look like:  - ./overlays/plane/app/services_package:/code/plane/app/services:ro
# Note the source and destination basenames can DIFFER (services_package → services),
# which is why a naive "$rel" → "/code/$rel" copy targets the wrong path.
load_mounts() {
  MOUNT_SRC=(); MOUNT_DST=()
  local line src dst
  while IFS= read -r line; do
    src="${line%%:*}"; dst="${line##*:/code/}"
    src="${src#./overlays/}"
    MOUNT_SRC+=("$src"); MOUNT_DST+=("$dst")
  done < <(grep -oE '\./overlays/[^:]+:/code/[^:]+' "$PLANE_APP/docker-compose.override.yaml" || true)
}

# container_path <rel> — echo the container path for a mounted overlay file, else nothing
container_path() {
  local rel="$1" i m
  for i in "${!MOUNT_SRC[@]}"; do
    m="${MOUNT_SRC[$i]}"
    if [ "$rel" = "$m" ]; then echo "/code/${MOUNT_DST[$i]}"; return 0; fi
    case "$rel" in
      "$m"/*) echo "/code/${MOUNT_DST[$i]}/${rel#"$m"/}"; return 0 ;;
    esac
  done
  return 1
}

# ── web ──────────────────────────────────────────────────────────────────────
deploy_web() {
  local CLIENT="$PLANE_SRC/apps/web/build/client"

  # Back up the CURRENT build before rebuilding over it — taken after the build it
  # would just archive the new one, leaving nothing to roll back to.
  mkdir -p "$BACKUP_DIR"
  if [ -d "$CLIENT" ]; then
    tar czf "$BACKUP_DIR/web-build-$(date +%Y%m%d-%H%M%S).tgz" -C "$PLANE_SRC/apps/web/build" client 2>/dev/null || true
    info "[web] Backed up the previous build to $BACKUP_DIR"
  fi

  if [ -n "$(git -C "$PLANE_SRC" status --porcelain 2>/dev/null || true)" ]; then
    info "[web] NOTE: $PLANE_SRC has uncommitted changes — they WILL be included in this build:"
    git -C "$PLANE_SRC" status --short | sed 's/^/        /'
  fi

  info "[web] Building..."
  cd "$PLANE_SRC"
  # No VITE_WEB_BASE_PATH — the web app is served from the nginx root. Only the
  # admin app is mounted under /god-mode/ and needs VITE_ADMIN_BASE_PATH.
  pnpm --filter web build || die "web build failed"

  # Assert the artifact instead of grepping the build log — a log filter can
  # swallow a failure and let a stale index.html be "deployed".
  [ -f "$CLIENT/index.html" ] || die "build produced no $CLIENT/index.html"
  [ -d "$CLIENT/assets" ] || die "build produced no $CLIENT/assets"

  info "[web] Copying into $WEB_CONTAINER..."
  # Copy FIRST (old hashed chunks are still present, so the currently-served
  # index.html keeps resolving), then prune. Deleting first would leave the live
  # index.html pointing at files that no longer exist.
  docker cp "$CLIENT/." "$WEB_CONTAINER:/usr/share/nginx/html/"

  # Prune container assets the fresh build did not emit. The container had ~2386
  # files against ~647 in a current build; without this every deploy leaves another
  # generation of dead chunks behind (four coexisting email-inbox chunks at one point).
  # The container is BusyBox — plain POSIX only (`find -printf` does not exist there).
  list_assets() { (cd "$1" && for f in *; do [ -f "$f" ] && printf '%s\n' "$f"; done) | sort; }

  docker exec "$WEB_CONTAINER" sh -c 'cd /usr/share/nginx/html/assets && for f in *; do [ -f "$f" ] && echo "$f"; done' \
    | sort > /tmp/plane_container_assets.txt
  list_assets "$CLIENT/assets" > /tmp/plane_build_assets.txt
  comm -23 /tmp/plane_container_assets.txt /tmp/plane_build_assets.txt > /tmp/plane_stale_assets.txt
  local stale
  stale=$(grep -c . /tmp/plane_stale_assets.txt || true)
  if [ "${stale:-0}" -gt 0 ]; then
    info "[web] Pruning $stale stale asset(s)..."
    docker exec -i "$WEB_CONTAINER" sh -c 'cd /usr/share/nginx/html/assets && xargs -r rm -f' < /tmp/plane_stale_assets.txt
  fi

  local remaining
  remaining=$(docker exec "$WEB_CONTAINER" sh -c 'ls -1 /usr/share/nginx/html/assets | wc -l' | tr -d ' ')
  info "[web] Deployed: $remaining asset(s) in the container."
  # A stale service worker (sw.js) can keep serving the previous bundle until it
  # updates — hard-reload (Cmd/Ctrl+Shift+R) to be sure.
  info "[web] Hard-reload the browser to pick up the new bundle."
}

# ── admin ────────────────────────────────────────────────────────────────────
deploy_admin() {
  info "[admin] Building..."
  cd "$PLANE_SRC"
  VITE_ADMIN_BASE_PATH=/god-mode pnpm --filter admin build 2>&1 | grep -E 'built|error|Error' || true
  [ -d "$PLANE_SRC/apps/admin/build/client" ] || die "admin build produced no apps/admin/build/client"
  docker cp "$PLANE_SRC/apps/admin/build/client/." "$ADMIN_CONTAINER:/usr/share/nginx/html/god-mode/"
  info "[admin] Deployed → http://192.168.1.167:${LISTEN_PORT}/god-mode/"
}

# ── api ──────────────────────────────────────────────────────────────────────
deploy_api() {
  load_mounts
  local copied=0 skipped=0 unmounted=()

  info "[api] Checking overlay mount coverage..."
  while IFS= read -r f; do
    local rel dst
    rel="${f#"$PLANE_APP/overlays/"}"
    if dst="$(container_path "$rel")"; then
      skipped=$((skipped + 1))
    else
      unmounted+=("$rel")
    fi
  done < <(find "$PLANE_APP/overlays" -name '*.py' -not -path '*__pycache__*' | sort)

  # Files that are NOT bind-mounted live only in the container's writable layer.
  # Copy them so the change takes effect now, but say so loudly: a container
  # recreation (docker compose up -d, image update) silently reverts them.
  if [ "${#unmounted[@]}" -gt 0 ]; then
    for rel in "${unmounted[@]}"; do
      for c in "$API_CONTAINER" "$WORKER_CONTAINER" "$BEAT_CONTAINER"; do
        docker cp "$PLANE_APP/overlays/$rel" "$c:/code/$rel" 2>/dev/null || true
      done
      copied=$((copied + 1))
    done
    echo "[api] WARNING: ${copied} overlay file(s) are NOT bind-mounted and were copied"
    echo "      into the container instead. They will be LOST if the container is"
    echo "      recreated. Add them to docker-compose.override.yaml:"
    printf '        - %s\n' "${unmounted[@]}"
  fi

  info "[api] $skipped mounted file(s) are already live via bind mount; restarting to reload."
  cd "$PLANE_APP" && docker compose restart api worker beat-worker 2>&1 | grep -v '^$'
  info "[api] Restarted. Waiting for startup..."
  sleep 5
  local bad
  bad=$(docker ps --filter "name=plane-app-(api|worker|beat-worker)" --format '{{.Names}} {{.Status}}' | grep -cv 'Up' || true)
  [ "${bad:-0}" -eq 0 ] || die "one or more containers did not come back up — check: docker compose logs --tail=50 api"
  info "[api] Done."
}

# ── check ────────────────────────────────────────────────────────────────────
# Compares each overlay .py against what the api container actually has, and
# reports overlay files that are not covered by a bind mount.
check() {
  load_mounts
  local drift=0 unmounted=()
  echo "── overlay drift (host vs $API_CONTAINER) ──"
  while IFS= read -r f; do
    local rel dst host_md5 ctr_md5
    rel="${f#"$PLANE_APP/overlays/"}"
    host_md5=$(md5sum "$f" | awk '{print $1}')
    if dst="$(container_path "$rel")"; then :; else
      unmounted+=("$rel")
      dst="/code/$rel"
    fi
    ctr_md5=$(docker exec "$API_CONTAINER" md5sum "$dst" 2>/dev/null | awk '{print $1}' || true)
    if [ -z "$ctr_md5" ]; then
      echo "  MISSING in container: $rel  ($dst)"
      drift=$((drift + 1))
    elif [ "$host_md5" != "$ctr_md5" ]; then
      echo "  DRIFT: $rel"
      drift=$((drift + 1))
    fi
  done < <(find "$PLANE_APP/overlays" -name '*.py' -not -path '*__pycache__*' | sort)
  [ "$drift" -eq 0 ] && echo "  none — container matches the repo"

  echo
  echo "── not bind-mounted (lost on container recreation) ──"
  if [ "${#unmounted[@]}" -eq 0 ]; then echo "  none"; else printf '  %s\n' "${unmounted[@]}"; fi

  echo
  echo "── other containers that may have diverged ──"
  local w b
  for rel in $(find "$PLANE_APP/overlays" -name '*.py' -not -path '*__pycache__*' -printf '%P\n' | sort); do
    w=$(docker exec "$WORKER_CONTAINER" md5sum "/code/$rel" 2>/dev/null | awk '{print $1}' || true)
    b=$(docker exec "$BEAT_CONTAINER" md5sum "/code/$rel" 2>/dev/null | awk '{print $1}' || true)
    [ -n "$b" ] && [ -n "$w" ] && [ "$b" != "$w" ] && echo "  $rel differs between worker and beat-worker"
  done
}

# ── verify ───────────────────────────────────────────────────────────────────
verify() {
  echo "── containers ──"
  (cd "$PLANE_APP" && docker compose ps --format 'table {{.Name}}\t{{.Status}}')
  echo
  echo "── tunnel ──"
  echo "  cloudflared.service: $(systemctl is-active cloudflared 2>/dev/null || echo unknown)"
  echo
  echo "── HTTP through the origin proxy (:$LISTEN_PORT) ──"
  local code body
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "http://localhost:$LISTEN_PORT/" || echo "ERR")
  echo "  GET /  → $code"
  body=$(curl -s -m 15 "http://localhost:$LISTEN_PORT/api/instances/" || true)
  echo "  has_llm_configured → $(printf '%s' "$body" | tr ',' '\n' | grep -o '"has_llm_configured":[a-z]*' || echo 'unavailable')"
  echo
  echo "── web bundle ──"
  echo "  assets in container: $(docker exec "$WEB_CONTAINER" sh -c 'ls -1 /usr/share/nginx/html/assets | wc -l' | tr -d ' ')"
  echo
  echo "── email ingest (host cron, every 5 min) ──"
  if [ -f "$HOME/email-ingest.log" ]; then
    echo "  log last written: $(date -r "$HOME/email-ingest.log" '+%Y-%m-%d %H:%M')"
    echo "  last ERROR lines:"
    grep -o '"levelname": "ERROR".*"message": "[^"]*"' "$HOME/email-ingest.log" 2>/dev/null | tail -2 | cut -c1-160 | sed 's/^/    /' || true
  fi
}

# ── rollback ─────────────────────────────────────────────────────────────────
rollback_web() {
  local latest
  latest=$(ls -1t "$BACKUP_DIR"/web-build-*.tgz 2>/dev/null | head -1 || true)
  [ -n "$latest" ] || die "no web-build-*.tgz found in $BACKUP_DIR"
  info "[web] Restoring $latest"
  tar xzf "$latest" -C /tmp
  docker cp /tmp/client/. "$WEB_CONTAINER:/usr/share/nginx/html/"
  rm -rf /tmp/client
  info "[web] Restored. Hard-reload the browser."
}

case "$TARGET" in
  web)          deploy_web ;;
  admin)        deploy_admin ;;
  api)          deploy_api ;;
  all)          deploy_web; deploy_admin; deploy_api ;;
  check)        check ;;
  verify)       verify ;;
  rollback-web) rollback_web ;;
  -h|--help)    sed -n '2,26p' "$0" ;;
  *)            die "unknown target '$TARGET' (web|admin|api|all|check|verify|rollback-web)" ;;
esac
echo "Deploy complete."
