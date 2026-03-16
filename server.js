import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import axios from "axios"
import rateLimit from "express-rate-limit"
import { AccessToken } from "livekit-server-sdk"
import { createServer } from "http"
import { Server as SocketIOServer } from "socket.io"
import crypto from "crypto"

dotenv.config()

const app = express()
const httpServer = createServer(app)
const io = new SocketIOServer(httpServer, {
  cors: { origin: process.env.CORS_ORIGIN || true, credentials: true }
})

app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }))
app.use(express.json({ limit: "1mb" }))
app.use(express.static("public"))

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
})

const SESSION_COOKIE = "vs_session"
const SESSION_SECRET = process.env.SESSION_SECRET || null
const ROBLOX_SERVER_KEY = process.env.ROBLOX_SERVER_KEY || null
const DEV_LOGIN_KEY = process.env.DEV_LOGIN_KEY || null
const ROBLOX_REDIRECT_URI =
  process.env.ROBLOX_REDIRECT_URI || "https://credent.up.railway.app/oauth/callback"

function nowMs() {
  return Date.now()
}

function b64urlEncodeString(s) {
  return Buffer.from(String(s), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function b64urlDecodeToString(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(b64, "base64").toString("utf8")
}

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(";")) {
    const idx = part.indexOf("=")
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    out[k] = decodeURIComponent(v)
  }
  return out
}

function signSession(payloadObj) {
  if (!SESSION_SECRET) throw new Error("SESSION_SECRET not configured")
  const payload = b64urlEncodeString(JSON.stringify(payloadObj))
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url")
  return `${payload}.${sig}`
}

function verifySession(token) {
  if (!SESSION_SECRET) return null
  if (!token || typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url")
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  } catch {
    return null
  }

  let obj
  try {
    obj = JSON.parse(b64urlDecodeToString(payload))
  } catch {
    return null
  }
  if (!obj || !obj.uid || !obj.exp) return null
  if (nowMs() > obj.exp) return null
  return obj
}

function sanitizeLiveKitRoomName(placeId, jobId) {
  const pj = String(placeId || "0").replace(/[^0-9]/g, "")
  const jj = String(jobId || "").replace(/[^a-zA-Z0-9_-]/g, "")
  return `rbx_${pj}_${jj}`.slice(0, 180)
}

function modeRadius(mode) {
  if (mode === "Whisper") return 10
  if (mode === "Talk") return 25
  if (mode === "Shout") return 60
  return 0
}

// In-memory state (single instance). For multi-instance: move to Redis + pub/sub.
// jobKey = `${placeId}:${jobId}`
const jobs = new Map() // jobKey -> { placeId, jobId, players: Map(uid->pos), lastSeen: Map(uid->ts), lastMode: Map(uid->mode) }
const userToJob = new Map() // uid -> { jobKey, ts }
const speakingByUser = new Map() // uid -> { speaking, ts }

const userSockets = new Map() // uid -> Set(socket)
const connectedUsers = new Set() // uid

function broadcastConnectedCount() {
  io.emit("connectedCount", connectedUsers.size)
}

function getRecentJobForUser(uid, maxAgeMs = 15_000) {
  const entry = userToJob.get(String(uid))
  if (!entry) return null
  if (nowMs() - entry.ts > maxAgeMs) return null
  return entry.jobKey
}

function cleanupJob(jobKey, ttlMs = 15_000) {
  const job = jobs.get(jobKey)
  if (!job) return
  const cutoff = nowMs() - ttlMs
  for (const [uid, ts] of job.lastSeen.entries()) {
    if (ts < cutoff) {
      job.lastSeen.delete(uid)
      job.players.delete(uid)
      job.lastMode.delete(uid)
    }
  }
}

function computeAudibleState(job, meUid) {
  const me = job.players.get(meUid) || null
  if (!me) return { me: null, others: [] }

  const out = []
  for (const [uid, pos] of job.players.entries()) {
    if (uid === meUid) continue
    if (!pos) continue
    const r = modeRadius(pos.mode)
    if (r <= 0) continue
    const dx = (pos.x || 0) - (me.x || 0)
    const dy = (pos.y || 0) - (me.y || 0)
    const dz = (pos.z || 0) - (me.z || 0)
    if (dx * dx + dy * dy + dz * dz <= r * r) {
      const s = speakingByUser.get(uid)?.speaking || false
      out.push({
        id: uid,
        x: pos.x || 0,
        y: pos.y || 0,
        z: pos.z || 0,
        mode: pos.mode || "Talk",
        speaking: s
      })
    }
  }

  return { me, others: out }
}

// OAuth2 login -> Roblox authorize
app.get("/login", loginLimiter, (req, res) => {
  if (!process.env.ROBLOX_CLIENT_ID) return res.status(500).send("ROBLOX_CLIENT_ID not configured")
  const redirectUri = encodeURIComponent(ROBLOX_REDIRECT_URI)
  const url =
    "https://authorize.roblox.com/?" +
    `client_id=${process.env.ROBLOX_CLIENT_ID}` +
    "&response_type=code" +
    `&redirect_uri=${redirectUri}` +
    "&scope=openid%20profile"
  res.redirect(url)
})

// OAuth2 callback -> sets a HttpOnly session cookie (no token in URL)
app.get("/oauth/callback", async (req, res) => {
  const { code } = req.query
  if (!code) return res.status(400).send("Missing authorization code")
  if (!process.env.ROBLOX_CLIENT_ID || !process.env.ROBLOX_CLIENT_SECRET) {
    return res.status(500).send("OAuth environment variables not configured")
  }

  try {
    const tokenRes = await axios.post(
      "https://apis.roblox.com/oauth/v1/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: ROBLOX_REDIRECT_URI,
        client_id: process.env.ROBLOX_CLIENT_ID,
        client_secret: process.env.ROBLOX_CLIENT_SECRET
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    )

    const accessToken = tokenRes.data.access_token
    const userRes = await axios.get("https://apis.roblox.com/oauth/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }
    })

    const userId = String(userRes.data.sub)
    const username =
      String(userRes.data.name || userRes.data.preferred_username || "RobloxUser").slice(0, 64)

    const session = signSession({
      uid: userId,
      name: username,
      iat: nowMs(),
      exp: nowMs() + 24 * 60 * 60 * 1000
    })

    res.cookie(SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/"
    })

    res.redirect("/")
  } catch (err) {
    const status = err.response?.status || 500
    const detail = err.response?.data?.error || err.message || "Unknown error"
    console.error(`[VoiceSystem] OAuth callback error: HTTP ${status} — ${detail}`)
    res.status(500).send("Authentication failed. Please try again.")
  }
})

// Dev-only: set a session cookie without OAuth (useful for Studio test users like "studio:Player1").
// Enable by setting DEV_LOGIN_KEY in environment variables and calling:
// /dev/login?key=...&uid=studio:Player1&name=Player1
app.get("/dev/login", (req, res) => {
  if (!DEV_LOGIN_KEY) return res.status(404).send("Not found")
  const key = String(req.query.key || "")
  if (key !== DEV_LOGIN_KEY) return res.status(403).send("Forbidden")
  const uid = String(req.query.uid || "").slice(0, 128)
  const name = String(req.query.name || uid || "DevUser").slice(0, 64)
  if (!uid) return res.status(400).send("Missing uid")

  try {
    const session = signSession({
      uid,
      name,
      iat: nowMs(),
      exp: nowMs() + 12 * 60 * 60 * 1000 // 12h
    })
    res.cookie(SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/"
    })
    res.json({ ok: true })
  } catch (e) {
    console.error("[VoiceSystem] dev/login failed:", e)
    res.status(500).json({ error: "dev_login_failed" })
  }
})

// Roblox server -> batch position/mode updates (one request per server tick, not per player)
app.post("/roblox/batch", (req, res) => {
  if (!ROBLOX_SERVER_KEY) return res.status(500).json({ error: "ROBLOX_SERVER_KEY not configured" })
  const auth = req.headers.authorization || ""
  if (auth !== `Bearer ${ROBLOX_SERVER_KEY}`) return res.status(401).json({ error: "unauthorized" })

  const { jobId, placeId, players } = req.body || {}
  if (!jobId || !placeId || !players || typeof players !== "object") {
    return res.status(400).json({ error: "jobId, placeId, players are required" })
  }

  const jobKey = `${placeId}:${jobId}`
  const playerCount = Object.keys(players).length
  if (process.env.VS_DEBUG) {
    console.log(`[VoiceSystem] /roblox/batch job=${jobKey} players=${playerCount}`)
  }
  let job = jobs.get(jobKey)
  if (!job) {
    job = {
      placeId: String(placeId),
      jobId: String(jobId),
      players: new Map(),
      lastSeen: new Map(),
      lastMode: new Map()
    }
    jobs.set(jobKey, job)
  }

  const ts = nowMs()
  const speakingOut = {}

  for (const [uidRaw, pos] of Object.entries(players)) {
    const uid = String(uidRaw)
    if (!pos || typeof pos !== "object") continue

    const prevMode = job.lastMode.get(uid)
    const nextMode = typeof pos.mode === "string" ? pos.mode : "Talk"

    job.players.set(uid, {
      x: Number(pos.x) || 0,
      y: Number(pos.y) || 0,
      z: Number(pos.z) || 0,
      lx: Number(pos.lx) || 0,
      ly: Number(pos.ly) || 0,
      lz: Number(pos.lz) || 0,
      mode: nextMode
    })
    job.lastSeen.set(uid, ts)
    job.lastMode.set(uid, nextMode)
    const prevJob = userToJob.get(uid)?.jobKey
    userToJob.set(uid, { jobKey, ts })

    // If the user already has a socket connected (before Roblox sync), move it into the job room now.
    // This fixes "no one hears anyone" when /session initially returns 409 and sockets never join job:*.
    if (prevJob && prevJob !== jobKey) {
      io.to(`user:${uid}`).socketsLeave(`job:${prevJob}`)
    }
    io.to(`user:${uid}`).socketsJoin(`job:${jobKey}`)

    speakingOut[uid] = speakingByUser.get(uid)?.speaking || false

    if (prevMode !== undefined && prevMode !== nextMode && (prevMode === "Mute" || nextMode === "Mute")) {
      io.to(`user:${uid}`).emit("muteState", { muted: nextMode === "Mute" })
    }
  }

  cleanupJob(jobKey)

  // Push proximity-filtered state to each connected web client in the same Roblox server.
  const socketsInJob = io.sockets.adapter.rooms.get(`job:${jobKey}`)
  if (socketsInJob && socketsInJob.size > 0) {
    for (const socketId of socketsInJob) {
      const s = io.sockets.sockets.get(socketId)
      if (!s) continue
      const uid = s.data.uid
      if (!uid) continue
      const st = computeAudibleState(job, uid)
      s.emit("state", { t: ts, me: st.me, others: st.others })
    }
  }

  res.json({ ok: true, speaking: speakingOut })
})

// Web UI -> returns a LiveKit token for the *current Roblox server* (room per JobId)
app.get("/session", (req, res) => {
  if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_SECRET || !process.env.LIVEKIT_URL) {
    return res.status(500).json({ error: "LiveKit environment variables not configured" })
  }
  const cookies = parseCookies(req.headers.cookie || "")
  const sess = verifySession(cookies[SESSION_COOKIE])
  if (!sess) return res.status(401).json({ error: "unauthorized" })

  const uid = String(sess.uid)
  const username = String(sess.name || "RobloxUser")

  const jobKey = getRecentJobForUser(uid)
  if (!jobKey) return res.status(409).json({ error: "not_in_game" })
  const job = jobs.get(jobKey)
  if (!job) return res.status(409).json({ error: "not_in_game" })

  const roomName = sanitizeLiveKitRoomName(job.placeId, job.jobId)
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_SECRET, {
    identity: uid,
    name: username
  })
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true })

  res.json({
    userId: uid,
    username,
    jobKey,
    room: roomName,
    livekitUrl: process.env.LIVEKIT_URL,
    token: at.toJwt()
  })
})

// Socket.io: auth via HttpOnly session cookie
io.on("connection", (socket) => {
  const cookies = parseCookies(socket.request.headers.cookie || "")
  const sess = verifySession(cookies[SESSION_COOKIE])

  if (!sess) {
    socket.emit("connectedCount", connectedUsers.size)
    return
  }

  const uid = String(sess.uid)
  const jobKey = getRecentJobForUser(uid)
  socket.data.uid = uid
  socket.data.jobKey = jobKey

  if (!userSockets.has(uid)) userSockets.set(uid, new Set())
  userSockets.get(uid).add(socket)
  connectedUsers.add(uid)
  broadcastConnectedCount()

  socket.join(`user:${uid}`)
  if (jobKey) socket.join(`job:${jobKey}`)

  // Avoid audio leak before the first Roblox state sync is received
  socket.emit("muteState", { muted: true })

  socket.on("speaking", ({ speaking }) => {
    speakingByUser.set(uid, { speaking: !!speaking, ts: nowMs() })
  })

  socket.on("disconnect", () => {
    const set = userSockets.get(uid)
    if (set) {
      set.delete(socket)
      if (set.size === 0) userSockets.delete(uid)
    }
    if (!userSockets.has(uid)) connectedUsers.delete(uid)
    speakingByUser.delete(uid)
    broadcastConnectedCount()
  })
})

app.get("/connected", (req, res) => {
  res.json({ count: connectedUsers.size })
})

const port = process.env.PORT || 3000
httpServer.listen(port, () => {
  console.log(`Voice server running on port ${port}`)
})
