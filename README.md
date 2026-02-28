# AOT:Avenir Lointain — Voice System

Proximity-based voice chat for Roblox using LiveKit WebRTC.

## Setup

### 1. Roblox OAuth2 App

1. Go to [https://create.roblox.com/dashboard/credentials](https://create.roblox.com/dashboard/credentials)
2. Create an OAuth2 app
3. Set the redirect URI to `https://credent.up.railway.app/oauth/callback`
4. Set the Privacy Policy URL to `https://credent.up.railway.app/privacy-policy`
5. Set the Terms of Service URL to `https://credent.up.railway.app/terms-of-service`
6. Copy `ROBLOX_CLIENT_ID` and `ROBLOX_CLIENT_SECRET`

### 2. LiveKit

1. Go to [https://livekit.io](https://livekit.io) and create a project
2. Settings → API Keys → copy `LIVEKIT_API_KEY`, `LIVEKIT_SECRET`, `LIVEKIT_URL`

### 3. Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_SECRET=your_livekit_secret
LIVEKIT_URL=wss://your-project.livekit.cloud
ROBLOX_CLIENT_ID=your_roblox_oauth_client_id
ROBLOX_CLIENT_SECRET=your_roblox_oauth_client_secret
ROBLOX_REDIRECT_URI=https://credent.up.railway.app/oauth/callback
PORT=3000
```

⚠️ **Never commit `.env` to source control.**

### 4. Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project from the repo
3. In Project → Variables, add all environment variables from above
4. Railway will auto-deploy on push
5. Open `https://credent.up.railway.app/` — the voice UI is served at the root

### 5. Roblox Script

1. Open `scripts/ServerScript.lua`
2. The script already uses the production URL `https://credent.up.railway.app`. Update it if you deploy to a different Railway URL.
3. Add the script as a ServerScript inside ServerScriptService

## Auth Flow

```
User → /login
→ Roblox OAuth (browser login)
→ /oauth/callback
→ LiveKit token generated
→ Redirect to / (voice UI auto-connects)
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/login` | Redirect user to Roblox OAuth authorization page |
| GET | `/oauth/callback` | Exchange OAuth code for LiveKit token, redirect to UI |
| POST | `/position` | Update player position and voice mode |
| POST | `/speaking` | Update speaking state |
| GET | `/speaking/:userId` | Get speaking state of a player |
| GET | `/state-all` | Get speaking state, volumes and positions for all players |
| GET | `/connected` | Get number of voice-connected users |

## Voice Modes (press V to cycle)

| Mode | Max Distance |
|------|-------------|
| Whisper | 10 studs |
| Talk | 25 studs |
| Shout | 60 studs |
