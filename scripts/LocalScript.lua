local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer
local RAILWAY = "https://voice-system-production.up.railway.app"

print("[VoiceSystem] LocalScript loaded for player:", player.Name, "| UserId:", player.UserId)
print("[VoiceSystem] Server URL:", RAILWAY)

local modeLabel = script.Parent.ModeLabel
local speakingIndicator = script.Parent.SpeakingIndicator
local bar = script.Parent.ProximityBarBG.ProximityBar

local MODES = {"Whisper", "Talk", "Shout"}
local current = 2
local mode = MODES[current]

modeLabel.Text = "Mode: " .. mode
print("[VoiceSystem] Initial mode:", mode)

UserInputService.InputBegan:Connect(function(input, gp)
	if gp then return end
	if input.KeyCode == Enum.KeyCode.V then
		current += 1
		if current > #MODES then current = 1 end
		mode = MODES[current]
		modeLabel.Text = "Mode: " .. mode
		print("[VoiceSystem] Mode changed to:", mode)
	end
end)

-- Envoi position
task.spawn(function()
	local positionSentCount = 0
	local positionErrorCount = 0
	while true do
		task.wait(0.1)
		if player.Character and player.Character.PrimaryPart then
			local pos = player.Character.PrimaryPart.Position
			local ok, err = pcall(function()
				HttpService:PostAsync(
					RAILWAY .. "/position",
					HttpService:JSONEncode({
						userId = player.UserId,
						x = pos.X,
						y = pos.Y,
						z = pos.Z,
						mode = mode
					}),
					Enum.HttpContentType.ApplicationJson
				)
			end)
			if ok then
				positionSentCount += 1
				if positionSentCount % 100 == 0 then
					print("[VoiceSystem] Position sent", positionSentCount, "times | pos:", pos, "| mode:", mode)
				end
			else
				positionErrorCount += 1
				print("[VoiceSystem] ERROR sending position:", err, "| total errors:", positionErrorCount)
			end
		else
			if positionSentCount == 0 and positionErrorCount == 0 then
				print("[VoiceSystem] Waiting for character to load...")
			end
		end
	end
end)

-- Speaking WebRTC
task.spawn(function()
	local lastSpeaking = nil
	local errorCount = 0
	while true do
		task.wait(0.2)
		local ok, res = pcall(function()
			return HttpService:GetAsync(RAILWAY .. "/speaking/" .. player.UserId)
		end)
		if ok and res then
			local data = HttpService:JSONDecode(res)
			if data.speaking ~= lastSpeaking then
				lastSpeaking = data.speaking
				print("[VoiceSystem] Speaking state changed:", data.speaking)
			end
			if data.speaking then
				speakingIndicator.BackgroundColor3 = Color3.fromRGB(0, 255, 0)
			else
				speakingIndicator.BackgroundColor3 = Color3.fromRGB(80, 80, 80)
			end
		else
			errorCount += 1
			print("[VoiceSystem] ERROR fetching speaking state:", res, "| total errors:", errorCount)
		end
	end
end)

-- Proximity
task.spawn(function()
	local errorCount = 0
	while true do
		task.wait(0.2)
		local ok, res = pcall(function()
			return HttpService:GetAsync(RAILWAY .. "/volumes/" .. player.UserId)
		end)
		if ok and res then
			local volumes = HttpService:JSONDecode(res)
			local maxVol = 0
			local playerCount = 0
			for id, v in pairs(volumes) do
				playerCount += 1
				if v > maxVol then maxVol = v end
			end
			if playerCount > 0 then
				print("[VoiceSystem] Volumes fetched | nearby players:", playerCount, "| maxVol:", maxVol)
			end
			bar.Size = UDim2.new(maxVol, 0, 1, 0)
		else
			errorCount += 1
			print("[VoiceSystem] ERROR fetching volumes:", res, "| total errors:", errorCount)
		end
	end
end)
