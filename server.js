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

const authLimiter = rateLimit({
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

// 🔐 Vérification Roblox via Open Cloud
async function verifyUser(userId) {
  try {
    const res = await axios.get(
      `https://apis.roblox.com/cloud/v2/users/${userId}`,
      {
        headers: {
          "x-api-key": process.env.ROBLOX_API_KEY
        }
      }
    )
    return res.data
  } catch {
    return null
  }
}

// 🔐 Auth + Token LiveKit
app.post("/auth", authLimiter, async (req, res) => {
  const { userId } = req.body

  if (!userId) return res.status(400).json({ error: "userId is required" })

  const user = await verifyUser(userId)
  if (!user) return res.status(401).json({ error: "Invalid Roblox user" })

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_SECRET,
    {
      identity: userId.toString(),
      name: user.name || "RobloxUser"
    }
  )

  at.addGrant({
    roomJoin: true,
    room: "roblox-room",
    canPublish: true,
    canSubscribe: true
  })

  const token = await at.toJwt()

  res.json({
    token,
    url: process.env.LIVEKIT_URL,
    username: user.name || "RobloxUser"
  })
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

// 📊 Volume proximity
app.get("/volumes/:userId", (req, res) => {
  const me = positions[req.params.userId]
  if (!me) return res.json({})

  let volumes = {}

  for (let id in positions) {
    if (id === req.params.userId) continue
    const other = positions[id]

    const dx = me.x - other.x
    const dy = me.y - other.y
    const dz = me.z - other.z

    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const maxDist = DISTANCES[me.mode] || 25

    let volume = 0
    if (dist <= maxDist) {
      volume = 1 - dist / maxDist
    }

    volumes[id] = volume
  }

  res.json(volumes)
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

  for (let id in positions) {
    players[id] = {
      speaking: speakingStates[id] || false,
      volumes: {},
      position: positions[id]
    }
  }

  for (let id in positions) {
    const me = positions[id]

    for (let otherId in positions) {
      if (id === otherId) continue

      const other = positions[otherId]

      // Muted or silent speakers contribute 0 volume
      if (!speakingStates[otherId] || other.mode === "Mute") {
        players[id].volumes[otherId] = 0
        continue
      }

      const dx = me.x - other.x
      const dy = me.y - other.y
      const dz = me.z - other.z

      const distSq = dx * dx + dy * dy + dz * dz
      const maxDist = DISTANCES[other.mode] || 25
      const maxDistSq = maxDist * maxDist

      if (distSq > maxDistSq) {
        players[id].volumes[otherId] = 0
        continue
      }

      const dist = Math.sqrt(distSq)
      // Quadratic natural falloff curve
      const volume = Math.pow(1 - dist / maxDist, 2)

      players[id].volumes[otherId] = volume
    }
  }

  res.json({ players })
})

// 📦 Combined state endpoint (speaking + volumes) — reduces Roblox HTTP request count
// Supports ~4 players at 1 req/s each (≈480 req/min) within Roblox's 500 req/min HttpService limit.
app.get("/state/:userId", (req, res) => {
  const userId = req.params.userId
  if (!userId || !/^\d+$/.test(userId)) {
    return res.status(400).json({ error: "Invalid userId" })
  }

  const me = positions[userId]
  let volumes = {}

  if (me) {
    for (let id in positions) {
      if (id === userId) continue
      const other = positions[id]

      const dx = me.x - other.x
      const dy = me.y - other.y
      const dz = me.z - other.z

      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const maxDist = DISTANCES[me.mode] || 25

      let volume = 0
      if (dist <= maxDist) {
        volume = 1 - dist / maxDist
      }

      volumes[id] = volume
    }
  }

  res.json({
    speaking: speakingStates[userId] || false,
    volumes
  })
})

const port = process.env.PORT || 3000
httpServer.listen(port, () => {
  console.log(`Voice server running on port ${port}`)
})
