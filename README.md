# AOT:Avenir Lointain — Voice System

Proximity-based voice chat for Roblox using LiveKit WebRTC.

## Setup

### 1. Roblox Open Cloud API Key

1. Go to [https://create.roblox.com](https://create.roblox.com)
2. Open Cloud → API Keys → Create API Key
3. Name: `VoiceSystemKey`, Permissions: Users API (Read)
4. Copy the key → `ROBLOX_API_KEY`

### 2. Roblox OAuth2 App

1. Go to [https://create.roblox.com/dashboard/credentials](https://create.roblox.com/dashboard/credentials)
2. Create an OAuth2 app
3. Set the redirect URI to `https://credent.up.railway.app/oauth/callback`
4. Copy `ROBLOX_CLIENT_ID` and `ROBLOX_CLIENT_SECRET`

### 3. LiveKit

1. Go to [https://livekit.io](https://livekit.io) and create a project
2. Settings → API Keys → copy `LIVEKIT_API_KEY`, `LIVEKIT_SECRET`, `LIVEKIT_URL`

### 4. Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_SECRET=your_livekit_secret
LIVEKIT_URL=wss://your-project.livekit.cloud
ROBLOX_API_KEY=your_roblox_open_cloud_api_key
ROBLOX_CLIENT_ID=your_roblox_oauth_client_id
ROBLOX_CLIENT_SECRET=your_roblox_oauth_client_secret
ROBLOX_REDIRECT_URI=https://credent.up.railway.app/oauth/callback
PORT=3000
```

⚠️ **Never commit `.env` to source control.**

### 5. Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project from the repo
3. In Project → Variables, add all environment variables from above
4. Railway will auto-deploy on push
5. Open `https://voice-system-production.up.railway.app/` — the voice UI is served at the root

### 6. Roblox Script

1. Open `scripts/LocalScript.lua`
2. The script already uses the production URL `https://voice-system-production.up.railway.app`. Update it if you deploy to a different Railway URL.
3. Add the script as a LocalScript inside a ScreenGui in StarterGui
4. Create child UI elements: `ModeLabel` (TextLabel), `SpeakingIndicator` (Frame), `ProximityBarBG` (Frame) → `ProximityBar` (Frame)

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth` | Authenticate Roblox user, return LiveKit token |
| GET | `/oauth/callback` | OAuth2 callback — exchange code for LiveKit token |
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
