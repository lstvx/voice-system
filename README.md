# Roblox Voice System

Proximity-based voice chat for Roblox using LiveKit WebRTC.

## Architecture

```
Roblox
   ↕ HTTPS
Railway Backend
   ↕
LiveKit Cloud
   ↕
Browser WebRTC
```

## Setup

### 1. Roblox Open Cloud API Key

1. Go to [https://create.roblox.com](https://create.roblox.com)
2. Open Cloud → API Keys → Create API Key
3. Name: `VoiceSystemKey`, Permissions: Users API (Read)
4. Copy the key → `ROBLOX_API_KEY`

### 2. LiveKit

1. Go to [https://livekit.io](https://livekit.io) and create a project
2. Settings → API Keys → copy `LIVEKIT_API_KEY`, `LIVEKIT_SECRET`, `LIVEKIT_URL`

### 3. Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_SECRET=your_livekit_secret
LIVEKIT_URL=wss://your-project.livekit.cloud
ROBLOX_API_KEY=your_roblox_open_cloud_api_key
PORT=3000
```

⚠️ **Never commit `.env` to source control.**

### 4. Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project from the repo
3. In Project → Variables, add all environment variables from above
4. Railway will auto-deploy on push

### 5. Roblox Script

1. Open `scripts/LocalScript.lua`
2. Replace `https://TON_PROJET.up.railway.app` with your Railway URL
3. Add the script as a LocalScript inside a ScreenGui in StarterGui
4. Create child UI elements: `ModeLabel` (TextLabel), `SpeakingIndicator` (Frame), `ProximityBarBG` (Frame) → `ProximityBar` (Frame)

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth` | Authenticate Roblox user, return LiveKit token |
| POST | `/position` | Update player position and voice mode |
| POST | `/speaking` | Update speaking state |
| GET | `/volumes/:userId` | Get proximity-based volumes for nearby players |
| GET | `/speaking/:userId` | Get speaking state of a player |

## Voice Modes (press V to cycle)

| Mode | Max Distance |
|------|-------------|
| Whisper | 10 studs |
| Talk | 25 studs |
| Shout | 60 studs |
