local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer

print("[VoiceSystem] LocalScript loaded for player:", player.Name, "| UserId:", player.UserId)

-- Wait for RemoteEvents created by the ServerScript
local VoiceSystemEvents = ReplicatedStorage:WaitForChild("VoiceSystemEvents")
local UpdatePosition    = VoiceSystemEvents:WaitForChild("UpdatePosition")
local SpeakingUpdated   = VoiceSystemEvents:WaitForChild("SpeakingUpdated")
local VolumesUpdated    = VoiceSystemEvents:WaitForChild("VolumesUpdated")

local modeLabel = script.Parent.ModeLabel
local speakingIndicator = script.Parent.SpeakingIndicator
local bar = script.Parent.ProximityBarBG.ProximityBar

-- Build a "Je parle" popup that appears prominently when the player is speaking
local speakGui = Instance.new("ScreenGui")
speakGui.Name = "SpeakingPopupGui"
speakGui.ResetOnSpawn = false
speakGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
speakGui.Parent = player.PlayerGui

local popup = Instance.new("Frame")
popup.Name = "SpeakingPopup"
popup.Size = UDim2.new(0, 220, 0, 56)
popup.AnchorPoint = Vector2.new(0.5, 1)
popup.Position = UDim2.new(0.5, 0, 0.88, 0)
popup.BackgroundColor3 = Color3.fromRGB(34, 197, 94)
popup.BackgroundTransparency = 0.08
popup.BorderSizePixel = 0
popup.Visible = false
popup.ZIndex = 10
popup.Parent = speakGui

local popupCorner = Instance.new("UICorner")
popupCorner.CornerRadius = UDim.new(0, 14)
popupCorner.Parent = popup

local popupLabel = Instance.new("TextLabel")
popupLabel.Size = UDim2.new(1, 0, 1, 0)
popupLabel.BackgroundTransparency = 1
popupLabel.Text = "🎙️  Je parle"
popupLabel.TextColor3 = Color3.fromRGB(255, 255, 255)
popupLabel.Font = Enum.Font.GothamBold
popupLabel.TextSize = 20
popupLabel.ZIndex = 11
popupLabel.Parent = popup

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

-- Send position to ServerScript via RemoteEvent (ServerScript handles HTTP)
task.spawn(function()
	local positionSentCount = 0
	while true do
		task.wait(1)
		if player.Character and player.Character.PrimaryPart then
			local pos = player.Character.PrimaryPart.Position
			UpdatePosition:FireServer(pos.X, pos.Y, pos.Z, mode)
			positionSentCount += 1
			if positionSentCount % 10 == 0 then
				print("[VoiceSystem] Position sent", positionSentCount, "times | pos:", pos, "| mode:", mode)
			end
		else
			if positionSentCount == 0 then
				print("[VoiceSystem] Waiting for character to load...")
			end
		end
	end
end)

-- Receive speaking state updates from ServerScript
local lastSpeaking = nil
SpeakingUpdated.OnClientEvent:Connect(function(speaking)
	if speaking ~= lastSpeaking then
		lastSpeaking = speaking
		print("[VoiceSystem] Speaking state changed:", speaking)
	end
	if speaking then
		speakingIndicator.BackgroundColor3 = Color3.fromRGB(0, 255, 0)
		popup.Visible = true
	else
		speakingIndicator.BackgroundColor3 = Color3.fromRGB(80, 80, 80)
		popup.Visible = false
	end
end)

-- Receive volume data from ServerScript
VolumesUpdated.OnClientEvent:Connect(function(volumes)
	local maxVol = 0
	local playerCount = 0
	for id, v in pairs(volumes) do
		playerCount += 1
		if v > maxVol then maxVol = v end
	end
	if playerCount > 0 then
		print("[VoiceSystem] Volumes updated | nearby players:", playerCount, "| maxVol:", maxVol)
	end
	bar.Size = UDim2.new(maxVol, 0, 1, 0)
end)
