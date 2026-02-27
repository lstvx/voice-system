import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import axios from "axios"
import rateLimit from "express-rate-limit"
import { AccessToken } from "livekit-server-sdk"
import { createServer } from "http"
import { Server as SocketIOServer } from "socket.io"

dotenv.config()

const app = express()
const httpServer = createServer(app)
const io = new SocketIOServer(httpServer, { cors: { origin: "*" } })

app.use(cors())
app.use(express.json())
app.use(express.static("public"))

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

const DISTANCES = {
  Whisper: 10,
  Talk: 25,
  Shout: 60
}
console.log("CLIENT ID:", process.env.ROBLOX_CLIENT_ID)
const ROBLOX_REDIRECT_URI = "https://credent.up.railway.app/oauth/callback"

// 🔑 OAuth2 login — redirect user to Roblox authorization page
app.get("/login", loginLimiter, (req, res) => {
  if (!process.env.ROBLOX_CLIENT_ID) {
    return res.status(500).send("ROBLOX_CLIENT_ID not configured")
  }
  const redirectUri = encodeURIComponent(ROBLOX_REDIRECT_URI)
  const url =
    "https://apis.roblox.com/oauth/v1/authorize?" +
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

    res.redirect(
      `/?token=${encodeURIComponent(token)}&userId=${encodeURIComponent(userId)}&username=${encodeURIComponent(username)}&livekitUrl=${encodeURIComponent(process.env.LIVEKIT_URL)}`
    )
  } catch (err) {
    const status = err.response?.status || 500
    const detail = err.response?.data?.error || err.message || "Unknown error"
    console.error(`[VoiceSystem] OAuth callback error: HTTP ${status} — ${detail}`)
    res.status(500).send("Authentication failed. Please try again.")
  }
})

// 📡 Position update
app.post("/position", (req, res) => {
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

// 📦 State-all endpoint — single poll for all players (scalable for 70–120 players)
// Returns speaking state, per-listener volumes (speaker-based mode, quadratic curve), and positions.
app.get("/state-all", (req, res) => {
  const players = {}

  // 🔥 Initialiser tous les joueurs connus (même sans position)
  const allUserIds = new Set([
    ...Object.keys(positions),
    ...Object.keys(speakingStates)
  ])

  for (let id of allUserIds) {
    players[id] = {
      speaking: speakingStates[id] || false,
      volumes: {},
      position: positions[id] || null
    }
  }

  for (let listenerId of allUserIds) {
    const me = positions[listenerId]

    // 🔥 Si le listener n'a pas encore de position → tout volume = 0
    if (!me) {
      for (let otherId of allUserIds) {
        if (otherId !== listenerId) {
          players[listenerId].volumes[otherId] = 0
        }
      }
      continue
    }

    for (let speakerId of allUserIds) {
      if (listenerId === speakerId) continue

      const other = positions[speakerId]

      // 🔥 Si speaker n'a pas encore de position → volume 0
      if (!other) {
        players[listenerId].volumes[speakerId] = 0
        continue
      }

      // 🔥 Si ne parle pas ou mute
      if (!speakingStates[speakerId] || other.mode === "Mute") {
        players[listenerId].volumes[speakerId] = 0
        continue
      }

      const dx = me.x - other.x
      const dy = me.y - other.y
      const dz = me.z - other.z

      const distSq = dx * dx + dy * dy + dz * dz
      const maxDist = DISTANCES[other.mode] || 25
      const maxDistSq = maxDist * maxDist

      if (distSq > maxDistSq) {
        players[listenerId].volumes[speakerId] = 0
        continue
      }

      const dist = Math.sqrt(distSq)
      // Quadratic natural falloff curve
      const volume = Math.pow(1 - dist / maxDist, 2)

      players[listenerId].volumes[speakerId] = volume
    }
  }

  res.json({ players })
})

const port = process.env.PORT || 3000
httpServer.listen(port, () => {
  console.log(`Voice server running on port ${port}`)
})
