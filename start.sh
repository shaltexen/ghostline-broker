#!/usr/bin/env bash
# ============ GHOSTLINE broker + tunnel ============
# Starts the handshake broker, publishes it on a public Cloudflare tunnel, then
# patches the new tunnel URL into app.js as DEFAULT_BROKER, bumps the cache
# version so friends' browsers actually pick it up, and rebuilds the deploy zip.
#
#   ./start.sh          start everything and patch the app
#   ./start.sh stop     stop the broker and tunnel
#
# Quick-tunnel hostnames are random and change on every restart — that's why the
# patch + version bump has to happen on every run, not just the first.

set -euo pipefail
cd "$(dirname "$0")"
APP="../app.js"
SW="../sw.js"
PORT=9000

stop_all() {
  pkill -f "node server.js" 2>/dev/null || true
  pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null || true
  echo "stopped broker + tunnel"
}

if [ "${1:-}" = "stop" ]; then stop_all; exit 0; fi

command -v cloudflared >/dev/null || { echo "cloudflared missing → brew install cloudflared"; exit 1; }
[ -d node_modules ] || npm install --silent

stop_all >/dev/null 2>&1 || true
sleep 1

echo "▸ starting broker on :$PORT"
nohup node server.js > broker.log 2>&1 &
sleep 2
curl -sf -o /dev/null "http://localhost:$PORT/ghostline/peerjs/id" || { echo "broker failed to start — see broker.log"; exit 1; }

# Quick tunnels sometimes register a hostname that never enters DNS (only 1 of 4
# edge connections comes up). Polling can't fix that one — the tunnel has to be
# thrown away and a new hostname requested. So: up to 3 attempts.
HOST=""
for attempt in 1 2 3; do
  echo "▸ opening tunnel (attempt $attempt)"
  pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null || true
  sleep 2
  nohup cloudflared tunnel --url "http://localhost:$PORT" > tunnel.log 2>&1 &

  CAND=""
  for _ in $(seq 1 30); do
    CAND=$(grep -o '[a-z0-9-]*\.trycloudflare\.com' tunnel.log 2>/dev/null | head -1 || true)
    [ -n "$CAND" ] && break
    sleep 1
  done
  [ -n "$CAND" ] || continue

  # a good tunnel answers within ~30s; a bad registration never will
  for _ in $(seq 1 15); do
    if curl -sf -o /dev/null --max-time 10 "https://$CAND/ghostline/peerjs/id"; then HOST="$CAND"; break; fi
    sleep 2
  done
  [ -n "$HOST" ] && break
  # Cloudflare rate-limits rapid quick-tunnel creation, and a throttled tunnel
  # registers a hostname that never enters DNS. Retrying immediately just earns
  # more throttling, so back off before asking for another.
  echo "  tunnel $CAND never routed — backing off 90s before retry"
  [ "$attempt" -lt 3 ] && sleep 90
done
[ -n "$HOST" ] || { echo "could not get a working tunnel after 3 attempts — see tunnel.log"; exit 1; }

echo "▸ patching DEFAULT_BROKER → $HOST"
sed -i '' "s|^const DEFAULT_BROKER = .*|const DEFAULT_BROKER = { host: \"$HOST\", port: \"443\", path: \"/ghostline\", key: \"peerjs\" };|" "$APP"

# bump the cache version, or the service worker keeps serving the old broker URL
CUR=$(grep -o 'ghostline-v[0-9]*' "$SW" | head -1 | tr -d 'a-z-')
NEW=$((CUR + 1))
sed -i '' "s/ghostline-v$CUR/ghostline-v$NEW/; s/\"?v=$CUR\"/\"?v=$NEW\"/" "$SW"
sed -i '' "s/?v=$CUR/?v=$NEW/g" ../index.html ../messenger.html
echo "▸ cache version v$CUR → v$NEW"

( cd .. && rm -f GHOSTLINE-netlify.zip && zip -q -r GHOSTLINE-netlify.zip \
  index.html messenger.html style.css themes.css messenger.css app.js messenger.js \
  icons.js peerjs.min.js qrcode.min.js manifest.json sw.js icon.svg icon-512.png )

cat <<EOF

  ✓ broker + tunnel live
    public broker : https://$HOST
    deploy bundle : GHOSTLINE-netlify.zip  (rebuilt at v$NEW)

  Re-upload the zip to Netlify so your friends get the new broker URL.
  Keep this Mac awake — closing it takes the broker down.
  Stop with: ./start.sh stop
EOF
