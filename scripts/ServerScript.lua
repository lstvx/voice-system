-- Place this Script in ServerScriptService.
-- It is the only place in the game that uses HttpService.
-- LocalScripts communicate via RemoteEvents (LocalScript → RemoteEvent → ServerScript → HTTP).

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local RAILWAY = "https://voice-system-production.up.railway.app"

-- Create the shared RemoteEvents folder in ReplicatedStorage
local VoiceSystemEvents = Instance.new("Folder")
VoiceSystemEvents.Name = "VoiceSystemEvents"
VoiceSystemEvents.Parent = ReplicatedStorage

local UpdatePosition  = Instance.new("RemoteEvent")
UpdatePosition.Name   = "UpdatePosition"
UpdatePosition.Parent = VoiceSystemEvents

local SpeakingUpdated  = Instance.new("RemoteEvent")
SpeakingUpdated.Name   = "SpeakingUpdated"
SpeakingUpdated.Parent = VoiceSystemEvents

local VolumesUpdated  = Instance.new("RemoteEvent")
VolumesUpdated.Name   = "VolumesUpdated"
VolumesUpdated.Parent = VoiceSystemEvents

print("[VoiceSystem] ServerScript loaded | RAILWAY:", RAILWAY)

-- Receive position from LocalScript and forward to backend via HTTP
UpdatePosition.OnServerEvent:Connect(function(player, x, y, z, mode)
	local ok, err = pcall(function()
		HttpService:PostAsync(
			RAILWAY .. "/position",
			HttpService:JSONEncode({
				userId = player.UserId,
				x = x,
				y = y,
				z = z,
				mode = mode
			}),
			Enum.HttpContentType.ApplicationJson
		)
	end)
	if not ok then
		warn("[VoiceSystem] ERROR sending position for", player.Name, ":", err)
	end
end)

-- Poll combined state (speaking + volumes) for each player, then push to LocalScript via RemoteEvent.
-- Polling at 0.5 s (2 req/s) halves speaking-detection latency vs 1 s.
-- Each player: 1 req/s (position) + 2 req/s (state at 0.5 s) = 3 req/s.
-- Safe for up to 2 players (6 req/s = 360 req/min) within Roblox's 500 req/min HttpService limit.
task.spawn(function()
	while true do
		task.wait(0.5)
		for _, player in Players:GetPlayers() do
			local userId = player.UserId

			-- Fetch speaking state + volumes in a single request
			local ok, res = pcall(function()
				return HttpService:GetAsync(RAILWAY .. "/state/" .. userId)
			end)
			if ok and res then
				local ok2, data = pcall(function()
					return HttpService:JSONDecode(res)
				end)
				if ok2 and data then
					SpeakingUpdated:FireClient(player, data.speaking or false)
					if data.volumes then
						VolumesUpdated:FireClient(player, data.volumes)
					end
				end
			else
				warn("[VoiceSystem] ERROR fetching state for", player.Name, "- pcall error:", tostring(res))
			end
		end
	end
end)
