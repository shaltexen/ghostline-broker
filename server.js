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
const INBOX_TTL = 14 * 24 * 3600e3; // drop undelivered mail after 14 days

let db = { names: {}, inbox: {} };
try { db = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch {}
if (!db.names) db.names = {};
if (!db.inbox) db.inbox = {};
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(DATA, JSON.stringify(db)); } catch (e) { console.error("save failed", e.message); } }, 400); }

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
app.use(express.json({ limit: "600kb" }));
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
  const cur = db.names[username];
  if (cur && cur.fp !== fp) return res.status(409).json({ error: "taken", takenBy: "another key" });
  db.names[username] = { fp, jwk, ecdh: ecdh || (cur && cur.ecdh) || null, ts: Date.now() };
  save();
  res.json({ ok: true, reserved: username });
});

// look up a user's public keys (to encrypt offline mail to them)
app.get("/gl/lookup", (req, res) => {
  const rec = db.names[req.query.u];
  if (!rec) return res.status(404).json({ error: "not found" });
  res.json({ username: req.query.u, jwk: rec.jwk, ecdh: rec.ecdh });
});

/* ---- offline mailbox (store-and-forward of E2E-encrypted blobs) ----
   send: anyone may drop a blob addressed to <to> (recipients verify the sender
   cryptographically on their end). The broker never sees plaintext. */
app.post("/gl/outbox", (req, res) => {
  const { to, env } = req.body || {};
  if (!to || !env || typeof env !== "object") return res.status(400).json({ error: "bad request" });
  if (JSON.stringify(env).length > MAX_BLOB) return res.status(413).json({ error: "too large" });
  if (!db.inbox[to]) db.inbox[to] = [];
  if (db.inbox[to].length >= MAX_INBOX) db.inbox[to].shift();
  db.inbox[to].push({ env, ts: Date.now() });
  save();
  res.json({ ok: true });
});

// fetch (and clear) your mailbox — authenticated by signing "inbox|<username>|<ts>"
app.post("/gl/inbox", async (req, res) => {
  const { username, sig, ts } = req.body || {};
  if (!username || !sig || !freshTs(ts)) return res.status(400).json({ error: "bad request" });
  const rec = db.names[username];
  if (!rec) return res.json({ messages: [] }); // no reservation → nothing addressed here
  if (!await verifySig(rec.jwk, sig, "inbox|" + username + "|" + ts)) return res.status(403).json({ error: "bad signature" });
  const now = Date.now();
  const msgs = (db.inbox[username] || []).filter((m) => now - m.ts < INBOX_TTL);
  delete db.inbox[username];
  save();
  res.json({ messages: msgs });
});

app.get("/gl/health", (_req, res) => res.json({ ok: true, names: Object.keys(db.names).length }));

process.on("SIGINT", () => { try { fs.writeFileSync(DATA, JSON.stringify(db)); } catch {} process.exit(0); });
