/* ============ GHOSTLINE broker ============
   Signaling (PeerJS) + two small stateful services the app can opt into:
     • username reservation — ties a username to an identity key so nobody can
       take it while you're offline. The broker only stores name → public key.
     • offline mailbox — holds END-TO-END-ENCRYPTED messages for a recipient
       until they reconnect. The broker CANNOT read them (they're encrypted to
       the recipient's key); it only stores and forwards opaque blobs.

   Run locally:   npm install && npm start
   Deploy:        Render / Railway / Fly.io  (see README.md)

   The signaling endpoint is unchanged: path /ghostline, key peerjs. */
const express = require("express");
const { ExpressPeerServer } = require("peer");
const fs = require("fs");
const path = require("path");
const { subtle } = require("crypto").webcrypto;

const PORT = process.env.PORT || 9000;
const DATA = process.env.GL_DATA || path.join(__dirname, "gl-data.json");
const MAX_BLOB = 200 * 1024;        // max size of one offline message blob
const MAX_INBOX = 200;              // max queued messages per recipient
const INBOX_TTL = 14 * 24 * 3600e3; // drop undelivered mail after 14 days (ms)
const INBOX_TTL_S = 14 * 24 * 3600; // ...and in seconds (Redis EXPIRE)

/* ---- state store ----
   Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN and reservations + offline
   mail persist across restarts/redeploys (needed on hosts with no persistent disk,
   like Render's free plan). Without them it falls back to a local JSON file — fine
   for a VPS/local run. Nothing else in the app changes either way. */
let store;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const { Redis } = require("@upstash/redis");
  const redis = Redis.fromEnv();
  const IKEY = (u) => "gl:inbox:" + u;
  store = {
    kind: "redis",
    getName: (u) => redis.hget("gl:names", u),
    setName: (u, rec) => redis.hset("gl:names", { [u]: rec }),
    delName: (u) => redis.hdel("gl:names", u),
    nameCount: () => redis.hlen("gl:names"),
    async pushInbox(u, item) { const k = IKEY(u); await redis.rpush(k, item); await redis.ltrim(k, -MAX_INBOX, -1); await redis.expire(k, INBOX_TTL_S); },
    async fetchClearInbox(u) { const k = IKEY(u); const items = await redis.lrange(k, 0, -1); await redis.del(k); return items || []; },
  };
  console.log("state: Upstash Redis (durable)");
} else {
  let db = { names: {}, inbox: {} };
  try { db = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch {}
  if (!db.names) db.names = {};
  if (!db.inbox) db.inbox = {};
  let saveTimer = null;
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(DATA, JSON.stringify(db)); } catch (e) { console.error("save failed", e.message); } }, 400); };
  store = {
    kind: "file",
    async getName(u) { return db.names[u] || null; },
    async setName(u, rec) { db.names[u] = rec; save(); },
    async delName(u) { delete db.names[u]; save(); },
    async nameCount() { return Object.keys(db.names).length; },
    async pushInbox(u, item) { if (!db.inbox[u]) db.inbox[u] = []; if (db.inbox[u].length >= MAX_INBOX) db.inbox[u].shift(); db.inbox[u].push(item); save(); },
    async fetchClearInbox(u) { const now = Date.now(); const msgs = (db.inbox[u] || []).filter((m) => now - m.ts < INBOX_TTL); delete db.inbox[u]; save(); return msgs; },
  };
  console.log("state: local file " + DATA + "  (set UPSTASH_REDIS_REST_URL/TOKEN for durable storage)");
}

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

async function fpOf(jwk) {
  const d = await subtle.digest("SHA-256", new TextEncoder().encode((jwk.x || "") + "." + (jwk.y || "")));
  return b64(d);
}
async function verifySig(jwk, sigB64, msg) {
  try {
    const key = await subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64(sigB64), new TextEncoder().encode(msg));
  } catch { return false; }
}
// a signed request is only accepted within ±5 min to stop replay
function freshTs(ts) { return typeof ts === "number" && Math.abs(Date.now() - ts) < 5 * 60e3; }

const app = express();
// 8mb so device-pairing account bundles (E2E-encrypted, incl. avatars) fit;
// every route still validates/caps its own payload (outbox uses MAX_BLOB)
app.use(express.json({ limit: "8mb" }));
// the web app calls these cross-origin (through the tunnel), so allow CORS
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "content-type");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const server = app.listen(PORT, () => console.log(`GHOSTLINE broker listening on :${PORT}  (signaling /ghostline · services /gl)`));

/* ---- PeerJS signaling (unchanged endpoint: /ghostline, key peerjs) ---- */
const peerServer = ExpressPeerServer(server, { key: "peerjs", allow_discovery: true, proxied: true });
app.use("/ghostline", peerServer);
peerServer.on("connection", (c) => console.log("＋ peer:", c.getId()));
peerServer.on("disconnect", (c) => console.log("－ peer:", c.getId()));

/* ---- username reservation ----
   claim: prove you hold the key (sign "claim|<username>|<ts>") and the broker
   binds <username> to your key fingerprint. Re-claiming with the same key is
   fine (that's you signing in again); a different key is rejected. */
app.post("/gl/claim", async (req, res) => {
  const { username, jwk, ecdh, sig, ts } = req.body || {};
  if (!username || !jwk || !sig || !freshTs(ts)) return res.status(400).json({ error: "bad request" });
  if (!await verifySig(jwk, sig, "claim|" + username + "|" + ts)) return res.status(403).json({ error: "bad signature" });
  const fp = await fpOf(jwk);
  const cur = await store.getName(username);
  if (cur && cur.fp !== fp) return res.status(409).json({ error: "taken", takenBy: "another key" });
  await store.setName(username, { fp, jwk, ecdh: ecdh || (cur && cur.ecdh) || null, ts: Date.now() });
  res.json({ ok: true, reserved: username });
});

// look up a user's public keys (to encrypt offline mail to them)
app.get("/gl/lookup", async (req, res) => {
  const rec = await store.getName(req.query.u);
  if (!rec) return res.status(404).json({ error: "not found" });
  res.json({ username: req.query.u, jwk: rec.jwk, ecdh: rec.ecdh });
});

/* release: give up a username you hold so someone else can claim it (the app
   calls this when you delete your account). Prove you hold the key by signing
   "release|<username>|<ts>". Idempotent — releasing a free name is a no-op.
   Also drops any undelivered mail addressed to that name (it'd be undecryptable
   once your keys are gone anyway). */
app.post("/gl/release", async (req, res) => {
  const { username, sig, ts } = req.body || {};
  if (!username || !sig || !freshTs(ts)) return res.status(400).json({ error: "bad request" });
  const rec = await store.getName(username);
  if (!rec) return res.json({ ok: true, released: username }); // already free
  if (!await verifySig(rec.jwk, sig, "release|" + username + "|" + ts)) return res.status(403).json({ error: "bad signature" });
  await store.delName(username);
  await store.fetchClearInbox(username); // discard any pending mail for the gone account
  res.json({ ok: true, released: username });
});

/* ---- offline mailbox (store-and-forward of E2E-encrypted blobs) ----
   send: anyone may drop a blob addressed to <to> (recipients verify the sender
   cryptographically on their end). The broker never sees plaintext. */
app.post("/gl/outbox", async (req, res) => {
  const { to, env } = req.body || {};
  if (!to || !env || typeof env !== "object") return res.status(400).json({ error: "bad request" });
  if (JSON.stringify(env).length > MAX_BLOB) return res.status(413).json({ error: "too large" });
  await store.pushInbox(to, { env, ts: Date.now() });
  res.json({ ok: true });
});

// fetch (and clear) your mailbox — authenticated by signing "inbox|<username>|<ts>"
app.post("/gl/inbox", async (req, res) => {
  const { username, sig, ts } = req.body || {};
  if (!username || !sig || !freshTs(ts)) return res.status(400).json({ error: "bad request" });
  const rec = await store.getName(username);
  if (!rec) return res.json({ messages: [] }); // no reservation → nothing addressed here
  if (!await verifySig(rec.jwk, sig, "inbox|" + username + "|" + ts)) return res.status(403).json({ error: "bad signature" });
  res.json({ messages: await store.fetchClearInbox(username) });
});

/* ---- device-pairing relay ----
   Plain HTTPS message drop between the two devices being linked — no WebRTC,
   no TURN, works through any NAT. The broker only ever sees ciphertext: the
   account bundle is AES-GCM-encrypted with the one-time key inside the QR,
   which never touches the server. Sessions are short-lived and in-memory. */
const pairSessions = new Map(); // sess -> { host: [], guest: [], ts }
const PAIR_TTL = 10 * 60e3;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pairSessions) if (now - v.ts > PAIR_TTL) pairSessions.delete(k);
}, 60e3).unref();

app.post("/gl/pair/send", (req, res) => {
  const { sess, to, msg } = req.body || {};
  if (typeof sess !== "string" || sess.length < 8 || sess.length > 64) return res.status(400).json({ error: "bad session" });
  if (!["host", "guest"].includes(to) || !msg || typeof msg !== "object") return res.status(400).json({ error: "bad request" });
  let s = pairSessions.get(sess);
  if (!s) {
    if (pairSessions.size > 500) return res.status(429).json({ error: "busy" });
    s = { host: [], guest: [], ts: Date.now() };
    pairSessions.set(sess, s);
  }
  if (s[to].length > 20) return res.status(429).json({ error: "flooded" });
  s.ts = Date.now();
  s[to].push(msg);
  res.json({ ok: true });
});
app.get("/gl/pair/recv", (req, res) => {
  const { sess, role } = req.query;
  if (!["host", "guest"].includes(role)) return res.status(400).json({ error: "bad role" });
  const s = pairSessions.get(sess);
  if (!s) return res.json({ ok: true, msgs: [] });
  s.ts = Date.now();
  res.json({ ok: true, msgs: s[role].splice(0) });
});

app.get("/gl/health", async (_req, res) => res.json({ ok: true, store: store.kind, names: await store.nameCount() }));
