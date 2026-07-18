# GHOSTLINE broker

The app needs a **handshake broker** — a small always-on server that only helps two
peers find each other for the initial connection. It never sees your messages or
calls (those stay end-to-end encrypted, peer-to-peer). The public `0.peerjs.com`
broker the app ships with is a free shared service that is **frequently down** — if
you get *"cannot reach handshake broker"*, run your own. It takes ~5 minutes and is free.

After it's running, open the app → **⚙ Settings → broker** and enter:

| Field | Value |
|-------|-------|
| HOST  | your broker's hostname (no `https://`), e.g. `ghostline-broker.onrender.com` |
| PORT  | `443` for a hosted (https) broker · `9000` for local http |
| PATH  | `/ghostline` |
| KEY   | `peerjs` |

Then **Save & reload** and sign in. Everyone who chats together must use the **same broker**.

---

## What this broker does

Besides PeerJS signaling (`/ghostline`, key `peerjs` — unchanged), it now runs two small
opt-in services under `/gl`, which is why it depends on **express** (installed by `npm install`):

- **Username reservation** (`/gl/claim`, `/gl/lookup`) — binds a username to your identity
  key so nobody can take it while you're offline. The broker stores only `username → public key`.
- **Offline mailbox** (`/gl/outbox`, `/gl/inbox`) — holds **end-to-end-encrypted** messages for
  a recipient until they reconnect. The broker **cannot read them** — it only stores/forwards
  opaque ciphertext, and clears each mailbox the moment its owner fetches it.

By default state lives in `gl-data.json` next to the server. These services need no client setup —
the app uses them automatically when the broker supports them, and silently skips them when it doesn't.

---

## Keeping it reliable on Render's free plan

The free plan has two quirks. Both are optional to fix; messaging and pairing work regardless.

### 1. Durable state (survive restarts) — Upstash Redis

Render's free plan has **no persistent disk**, so `gl-data.json` (reservations + offline mail) is
wiped on every redeploy/restart. Point the broker at a free Upstash Redis instead and it persists:

1. Create a free database at **upstash.com** → Redis → Create Database (any region).
2. On its page, copy **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN**.
3. In Render → your service → **Environment** → add those two env vars → save (it redeploys).

The broker auto-detects them (`state: Upstash Redis (durable)` in the logs) and falls back to the
file when they're absent — so local runs need nothing. Mailbox entries expire after 14 days.

### 2. No cold starts — keep-warm ping

The free plan sleeps the service after ~15 min idle (~50s to wake). The included GitHub Action
(`.github/workflows/keep-warm.yml`) pings `/gl/health` every 10 minutes to keep it awake — free,
no extra account. It activates once the broker repo is on GitHub with Actions enabled. Alternatively
a free scheduler like **cron-job.org** hitting the same URL works too.

---

## Option A — Local (test on one machine / same Wi‑Fi)

```sh
cd broker
npm install
npm start        # → GHOSTLINE broker listening on :9000
```

App settings: HOST `localhost`, PORT `9000`, PATH `/ghostline`, KEY `peerjs`.
(Same Wi‑Fi: use your computer's LAN IP instead of `localhost`, e.g. `192.168.1.20`.)

## Option B — Render.com (free, reachable from anywhere) ✅ recommended

1. Put this `broker/` folder in a GitHub repo (or use "Deploy from a public repo").
2. On [render.com](https://render.com) → **New → Web Service**.
3. Root directory: `broker` · Build command: `npm install` · Start command: `npm start`.
4. Render gives you a URL like `https://ghostline-broker.onrender.com`.

App settings: HOST `ghostline-broker.onrender.com`, PORT `443`, PATH `/ghostline`, KEY `peerjs`.

> Render's free tier sleeps after 15 min idle; the first connection may take ~30s to wake it.

## Option C — Railway / Fly.io / Glitch

Any Node host works. Set the start command to `npm start`; the server reads `PORT` from
the environment automatically. Use the host they give you, PORT `443`, PATH `/ghostline`, KEY `peerjs`.

## Option D — Your own VPS (fully self-owned, no third party at all)

```sh
npm install
PORT=9000 npm start
# put nginx/caddy in front for TLS on 443, or run behind a reverse proxy
```

---

### Why do I need this at all?
Browsers can't accept incoming connections, so two peers can't find each other
unaided — they need one reachable rendezvous point for the *handshake only*. Once
connected, all traffic is direct and encrypted. This is the single unavoidable
server, and running your own means **no third party is ever involved**.
