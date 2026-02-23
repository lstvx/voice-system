local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer
local RAILWAY = "https://voice-system-production.up.railway.app"

local modeLabel = script.Parent.ModeLabel
local speakingIndicator = script.Parent.SpeakingIndicator
local bar = script.Parent.ProximityBarBG.ProximityBar

local MODES = {"Whisper", "Talk", "Shout"}
local current = 2
local mode = MODES[current]

modeLabel.Text = "Mode: " .. mode

UserInputService.InputBegan:Connect(function(input, gp)
	if gp then return end
	if input.KeyCode == Enum.KeyCode.V then
		current += 1
		if current > #MODES then current = 1 end
		mode = MODES[current]
		modeLabel.Text = "Mode: " .. mode
	end
end)

-- Envoi position
task.spawn(function()
	while true do
		task.wait(0.1)
		if player.Character and player.Character.PrimaryPart then
			local pos = player.Character.PrimaryPart.Position
			pcall(function()
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
		end
	end
end)

-- Speaking WebRTC
task.spawn(function()
	while true do
		task.wait(0.2)
		local ok, res = pcall(function()
			return HttpService:GetAsync(RAILWAY .. "/speaking/" .. player.UserId)
		end)
		if ok and res then
			local data = HttpService:JSONDecode(res)
			if data.speaking then
				speakingIndicator.BackgroundColor3 = Color3.fromRGB(0, 255, 0)
			else
				speakingIndicator.BackgroundColor3 = Color3.fromRGB(80, 80, 80)
			end
		end
	end
end)

-- Proximity
task.spawn(function()
	while true do
		task.wait(0.2)
		local ok, res = pcall(function()
			return HttpService:GetAsync(RAILWAY .. "/volumes/" .. player.UserId)
		end)
		if ok and res then
			local volumes = HttpService:JSONDecode(res)
			local maxVol = 0
			for _, v in pairs(volumes) do
				if v > maxVol then maxVol = v end
			end
			bar.Size = UDim2.new(maxVol, 0, 1, 0)
		end
	end
end)
