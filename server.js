import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import axios from "axios"
import rateLimit from "express-rate-limit"
import { AccessToken } from "livekit-server-sdk"
import { createServer } from "http"
import { Server as SocketIOServer } from "socket.io"
import { timingSafeEqual } from "crypto"

dotenv.config()

const app = express()
const httpServer = createServer(app)
const io = new SocketIOServer(httpServer, { cors: { origin: "*" } })

app.use(cors())
app.use(express.json())
app.use(express.static("public"))

// Simple cookie parser (avoids an extra dependency)
function parseCookies(req) {
  const cookies = {}
  const header = req.headers.cookie
  if (!header) return cookies
  header.split(";").forEach(part => {
    const [key, ...rest] = part.split("=")
    try {
      cookies[key.trim()] = decodeURIComponent(rest.join("=").trim())
    } catch (_) {
      // Skip malformed percent-encoded values
    }
  })
  return cookies
}

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
})

// Note: positions and speakingStates are stored in memory.
// Data is lost on restart and this does not scale across multiple instances.
let positions = {}
let speakingStates = {}

// Map userId (string) → socket for mute sync
const userSockets = new Map()

function buildStateAll() {
  const players = {}
  const allUserIds = new Set([
    ...Object.keys(positions),
    ...Object.keys(speakingStates)
  ])
  for (let id of allUserIds) {
    players[id] = {
      speaking: speakingStates[id] || false,
      position: positions[id] || null
    }
  }
  return { players }
}

const ROBLOX_REDIRECT_URI = process.env.ROBLOX_REDIRECT_URI || "https://credent.up.railway.app/oauth/callback"

// 🔑 OAuth2 login — redirect user to Roblox authorization page
app.get("/login", loginLimiter, (req, res) => {
  if (!process.env.ROBLOX_CLIENT_ID) {
    return res.status(500).send("ROBLOX_CLIENT_ID not configured")
  }
  const redirectUri = encodeURIComponent(ROBLOX_REDIRECT_URI)
  const url =
    "https://authorize.roblox.com/?" +
    `client_id=${process.env.ROBLOX_CLIENT_ID}` +
    "&response_type=code" +
    `&redirect_uri=${redirectUri}` +
    "&scope=openid%20profile"
  res.redirect(url)
})

// 🔑 OAuth2 callback — Roblox redirects here after user authorization
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

    const userRes = await axios.get(
      "https://apis.roblox.com/oauth/v1/userinfo",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )

    const userId = userRes.data.sub
    const username = userRes.data.name || userRes.data.preferred_username || "RobloxUser"

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_SECRET,
      { identity: userId, name: username }
    )
    at.addGrant({ roomJoin: true, room: "roblox-room", canPublish: true, canSubscribe: true })
    const token = await at.toJwt()

    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 5 * 60 * 1000 // 5 minutes — consumed by /auth/session on page load
    }
    res.cookie("lk_token", token, cookieOpts)
    res.cookie("lk_userId", userId, cookieOpts)
    res.cookie("lk_username", username, cookieOpts)
    res.cookie("lk_url", process.env.LIVEKIT_URL || "", cookieOpts)
    res.redirect("/")
  } catch (err) {
    const status = err.response?.status || 500
    const detail = err.response?.data?.error || err.message || "Unknown error"
    console.error(`[VoiceSystem] OAuth callback error: HTTP ${status} — ${detail}`)
    res.status(500).send("Authentication failed. Please try again.")
  }
})

// 🔐 Auth session — client fetches this on page load to retrieve LiveKit credentials
// stored as HttpOnly cookies by /oauth/callback
app.get("/auth/session", (req, res) => {
  const cookies = parseCookies(req)
  const token = cookies.lk_token
  const userId = cookies.lk_userId
  if (!token || !userId) {
    return res.status(401).json({ error: "No session" })
  }
  const username = cookies.lk_username || "RobloxUser"
  const livekitUrl = cookies.lk_url || ""
  // Clear the session cookies after delivering them once
  const clearOpts = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: 0 }
  res.clearCookie("lk_token", clearOpts)
  res.clearCookie("lk_userId", clearOpts)
  res.clearCookie("lk_username", clearOpts)
  res.clearCookie("lk_url", clearOpts)
  res.json({ token, userId, username, livekitUrl })
})

// 📡 Position update
app.post("/position", (req, res) => {
  // Require the shared secret that the Roblox server script must send
  const expectedSecret = process.env.POSITION_SECRET
  if (expectedSecret) {
    const provided = req.headers.authorization || ""
    let authorized = false
    try {
      authorized =
        provided.length === expectedSecret.length &&
        timingSafeEqual(Buffer.from(provided), Buffer.from(expectedSecret))
    } catch (_) {
      authorized = false
    }
    if (!authorized) {
      return res.status(403).json({ error: "Forbidden" })
    }
  }

  const { userId, x, y, z, lx, ly, lz, mode } = req.body
  if (!userId) return res.status(400).json({ error: "userId is required" })

  const prevMode = positions[userId]?.mode
  positions[userId] = { x, y, z, lx, ly, lz, mode }

  // Push mute state change to the user's browser socket
  if (mode !== prevMode) {
    const userSocket = userSockets.get(String(userId))
    if (userSocket) {
      userSocket.emit("muteState", { muted: mode === "Mute" })
    }
  }

  // Push full state update to all connected browser sockets
  io.emit("state-all", buildStateAll())

  res.json({ success: true })
})

// Track voice-connected users
const connectedUsers = new Set()

function broadcastConnectedCount() {
  io.emit("connectedCount", connectedUsers.size)
}

// 🔊 Speaking update via socket.io (real-time from browser)
io.on("connection", (socket) => {
  const userId = socket.handshake.auth?.userId
  if (userId) {
    connectedUsers.add(userId)
    userSockets.set(String(userId), socket)
    broadcastConnectedCount()
    // 🔥 Forcer mute par défaut au join pour éviter tout leak audio avant le premier sync Roblox
    socket.emit("muteState", { muted: true })
  } else {
    // Send current count to newly connected page-load sockets (no userId = counter-only)
    socket.emit("connectedCount", connectedUsers.size)
  }

  socket.on("speaking", ({ speaking }) => {
    if (userId) {
      speakingStates[userId] = speaking
    }
  })

  socket.on("disconnect", () => {
    if (userId) {
      connectedUsers.delete(userId)
      userSockets.delete(String(userId))
      delete speakingStates[userId]
      broadcastConnectedCount()
    }
  })
})

// 📊 Connected users count
app.get("/connected", (req, res) => {
  res.json({ count: connectedUsers.size })
})

// 🔊 Speaking update via HTTP POST (fallback / direct push from browser on state change)
app.post("/speaking", (req, res) => {
  const { userId, speaking } = req.body
  if (!userId) return res.status(400).json({ error: "userId is required" })
  speakingStates[userId] = !!speaking
  res.json({ success: true })
})

// 🔊 Get speaking state
app.get("/speaking/:userId", (req, res) => {
  res.json({
    speaking: speakingStates[req.params.userId] || false
  })
})

// 📦 State-all endpoint — positions, modes, and speaking states for all players.
// Volume attenuation is handled entirely by the browser's spatial audio engine.
app.get("/state-all", (req, res) => {
  res.json(buildStateAll())
})

const port = process.env.PORT || 3000
httpServer.listen(port, () => {
  console.log(`Voice server running on port ${port}`)
})
