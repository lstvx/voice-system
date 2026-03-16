-- Place this Script in ServerScriptService.
-- This script is the ONLY place in the game that uses HttpService.
-- LocalScripts -> RemoteEvent -> this script -> HTTP batch to the external voice backend.

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local RAILWAY = "https://credent.up.railway.app"

-- Must match backend env ROBLOX_SERVER_KEY
local ROBLOX_SERVER_KEY = "EFPKCqLjCP1ynbKvAI1rZUj4O8iNVFMufvm4BJCQL9WwY4ZC/v7hQRQy9vL6+TKo"

local function getOrCreate(parent, className, name)
	local existing = parent:FindFirstChild(name)
	if existing and existing.ClassName == className then
		return existing
	end
	local inst = Instance.new(className)
	inst.Name = name
	inst.Parent = parent
	return inst
end

local VoiceSystemEvents = getOrCreate(ReplicatedStorage, "Folder", "VoiceSystemEvents")
local UpdatePosition = getOrCreate(VoiceSystemEvents, "RemoteEvent", "UpdatePosition")
local SpeakingUpdated = getOrCreate(VoiceSystemEvents, "RemoteEvent", "SpeakingUpdated")

print("[VoiceSystem] ServerScript ready | backend:", RAILWAY, "| jobId:", game.JobId)

-- Latest state received from each player (server memory)
-- playerStates[userIdStr] = {x,y,z,lx,ly,lz,mode}
local playerStates = {}
local resolvedIdByPlayer = {}

local function resolveStableUserId(player)
	-- In Studio test sessions, Player.UserId can be 0 / negative for test players.
	-- Try resolving the real account UserId from the username so it matches OAuth userId.
	if player.UserId and player.UserId > 0 then
		return tostring(player.UserId)
	end

	if resolvedIdByPlayer[player] then
		return resolvedIdByPlayer[player]
	end

	local ok, uid = pcall(function()
		return Players:GetUserIdFromNameAsync(player.Name)
	end)

	if ok and typeof(uid) == "number" and uid > 0 then
		resolvedIdByPlayer[player] = tostring(uid)
		return resolvedIdByPlayer[player]
	end

	-- Studio fallback: stable synthetic id shared between Roblox and the web dev session.
	resolvedIdByPlayer[player] = "studio:" .. player.Name
	return resolvedIdByPlayer[player]
end

local function setPlayerState(userIdStr, x, y, z, lx, ly, lz, mode)
	playerStates[userIdStr] = {
		x = x,
		y = y,
		z = z,
		lx = lx,
		ly = ly,
		lz = lz,
		mode = mode
	}
end

UpdatePosition.OnServerEvent:Connect(function(player, x, y, z, lx, ly, lz, mode)
	-- Minimal sanity checks to reduce garbage in the batch payload
	if typeof(x) ~= "number" or typeof(y) ~= "number" or typeof(z) ~= "number" then return end
	if typeof(lx) ~= "number" or typeof(ly) ~= "number" or typeof(lz) ~= "number" then return end
	if typeof(mode) ~= "string" then mode = "Talk" end
	local uid = resolveStableUserId(player)
	setPlayerState(uid, x, y, z, lx, ly, lz, mode)
end)

Players.PlayerRemoving:Connect(function(player)
	local uid = resolvedIdByPlayer[player] or tostring(player.UserId)
	playerStates[uid] = nil
	resolvedIdByPlayer[player] = nil
end)

-- 1 HTTP request per server tick (batch), not per player.
-- Keep under HttpService limits: 0.25s => 4 req/s => 240 req/min total.
local BATCH_INTERVAL = 0.25

task.spawn(function()
	while true do
		task.wait(BATCH_INTERVAL)

		-- Build a minimal payload
		local payload = {
			jobId = game.JobId,
			placeId = game.PlaceId,
			players = playerStates
		}

		local ok, res = pcall(function()
			return HttpService:RequestAsync({
				Url = RAILWAY .. "/roblox/batch",
				Method = "POST",
				Headers = {
					["Content-Type"] = "application/json",
					["Authorization"] = "Bearer " .. ROBLOX_SERVER_KEY
				},
				Body = HttpService:JSONEncode(payload)
			})
		end)

		if not ok or not res or not res.Success then
			-- Avoid log spam
			continue
		end

		local body = res.Body
		if not body or body == "" then continue end

		local ok2, data = pcall(function()
			return HttpService:JSONDecode(body)
		end)

		if not ok2 or not data or typeof(data.speaking) ~= "table" then continue end

		-- Update only each player's own speaking UI
		for _, player in Players:GetPlayers() do
			local uid = resolvedIdByPlayer[player] or resolveStableUserId(player)
			local s = data.speaking[uid]
			SpeakingUpdated:FireClient(player, s == true)
		end
	end
end)
