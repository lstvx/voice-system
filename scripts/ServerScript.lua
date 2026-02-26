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

local SpatialUpdated  = Instance.new("RemoteEvent")
SpatialUpdated.Name   = "SpatialUpdated"
SpatialUpdated.Parent = VoiceSystemEvents

print("[VoiceSystem] ServerScript loaded | RAILWAY:", RAILWAY)

-- Receive position (with LookVector direction) from LocalScript and forward to backend
UpdatePosition.OnServerEvent:Connect(function(player, x, y, z, lx, ly, lz, mode)
	local ok, err = pcall(function()
		HttpService:PostAsync(
			RAILWAY .. "/position",
			HttpService:JSONEncode({
				userId = player.UserId,
				x = x,
				y = y,
				z = z,
				lx = lx,
				ly = ly,
				lz = lz,
				mode = mode
			}),
			Enum.HttpContentType.ApplicationJson
		)
	end)
	if not ok then
		warn("[VoiceSystem] ERROR sending position for", player.Name, ":", err)
	end
end)

-- Raycast occlusion check — returns true if a wall is between posA and posB
local function isOccluded(posA, posB)
	local direction = posB - posA

	-- Skip raycast for very distant players (already volume 0)
	if direction.Magnitude > 30 then
		return false
	end

	local rayParams = RaycastParams.new()
	rayParams.FilterType = Enum.RaycastFilterType.Blacklist

	local result = workspace:Raycast(posA, direction, rayParams)

	return result ~= nil
end

-- Poll /state-all once per tick for all players — one request regardless of player count.
-- At 0.5 s interval: 2 req/s total, well within Roblox's 500 req/min HttpService limit
-- for up to 120 players.
task.spawn(function()
	while true do
		task.wait(0.5)

		local ok, res = pcall(function()
			return HttpService:GetAsync(RAILWAY .. "/state-all")
		end)

		if not ok or not res then
			warn("[VoiceSystem] ERROR fetching /state-all:", tostring(res))
			continue
		end

		local ok2, data = pcall(function()
			return HttpService:JSONDecode(res)
		end)

		if not ok2 or not data or not data.players then
			continue
		end

		for _, player in Players:GetPlayers() do
			local userData = data.players[tostring(player.UserId)]
			if not userData then continue end

			local finalVolumes = {}

			for otherId, volume in pairs(userData.volumes or {}) do
				if volume > 0 then
					local otherPlayer = Players:GetPlayerByUserId(tonumber(otherId))

					if otherPlayer
						and player.Character
						and otherPlayer.Character
						and player.Character.PrimaryPart
						and otherPlayer.Character.PrimaryPart then

						local posA = player.Character.PrimaryPart.Position
						local posB = otherPlayer.Character.PrimaryPart.Position

						if isOccluded(posA, posB) then
							volume = volume * 0.4
						end
					end
				end

				finalVolumes[otherId] = volume
			end

			SpeakingUpdated:FireClient(player, userData.speaking or false)
			VolumesUpdated:FireClient(player, finalVolumes)

			-- Forward other players' positions for client-side spatial awareness
			if userData.position then
				SpatialUpdated:FireClient(player, userData.position)
			end
		end
	end
end)
