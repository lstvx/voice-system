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

-- Poll speaking state and volumes for each player, then push to LocalScript via RemoteEvent
task.spawn(function()
	while true do
		task.wait(0.2)
		for _, player in Players:GetPlayers() do
			local userId = player.UserId

			-- Fetch speaking state
			local okS, resS = pcall(function()
				return HttpService:GetAsync(RAILWAY .. "/speaking/" .. userId)
			end)
			if okS and resS then
				local ok2, data = pcall(function()
					return HttpService:JSONDecode(resS)
				end)
				if ok2 and data then
					SpeakingUpdated:FireClient(player, data.speaking or false)
				end
			else
				warn("[VoiceSystem] ERROR fetching speaking state for", player.Name, "- pcall error:", tostring(resS))
			end

			-- Fetch volume data
			local okV, resV = pcall(function()
				return HttpService:GetAsync(RAILWAY .. "/volumes/" .. userId)
			end)
			if okV and resV then
				local ok3, volumes = pcall(function()
					return HttpService:JSONDecode(resV)
				end)
				if ok3 and volumes then
					VolumesUpdated:FireClient(player, volumes)
				end
			else
				warn("[VoiceSystem] ERROR fetching volumes for", player.Name, "- pcall error:", tostring(resV))
			end
		end
	end
end)
