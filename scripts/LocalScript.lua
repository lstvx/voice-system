local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer

-- RemoteEvents
local VoiceSystemEvents = ReplicatedStorage:WaitForChild("VoiceSystemEvents")
local UpdatePosition    = VoiceSystemEvents:WaitForChild("UpdatePosition")
local SpeakingUpdated   = VoiceSystemEvents:WaitForChild("SpeakingUpdated")
local VolumesUpdated    = VoiceSystemEvents:WaitForChild("VolumesUpdated")
local SpatialUpdated    = VoiceSystemEvents:WaitForChild("SpatialUpdated")

--========================
-- UI REFERENCES
--========================

local gui = player.PlayerGui:WaitForChild("VoiceGui")

local btnWhisper = gui:WaitForChild("Chuchoter")
local btnTalk    = gui:WaitForChild("Parler")
local btnShout   = gui:WaitForChild("Crier")
local btnMute    = gui:WaitForChild("Mute")
local status     = gui:WaitForChild("Status")

local TweenService = game:GetService("TweenService")

local tweenInfo = TweenInfo.new(
	0.2,
	Enum.EasingStyle.Quad,
	Enum.EasingDirection.Out
)

--========================
-- MODES
--========================

local MODES = {"Whisper","Talk","Shout","Mute"}
local current = 2
local mode = MODES[current]

local function tweenTransparency(obj, value)
	TweenService:Create(obj, tweenInfo, {
		ImageTransparency = value
	}):Play()
end
local function tweenTextTransparency(obj, value)
	TweenService:Create(obj, tweenInfo, {
		TextTransparency = value
	}):Play()
end

local function updateUI()

	local active

	if mode == "Whisper" then
		active = btnWhisper
	elseif mode == "Talk" then
		active = btnTalk
	elseif mode == "Shout" then
		active = btnShout
	elseif mode == "Mute" then
		active = btnMute
	end

	for _,btn in pairs({btnWhisper, btnTalk, btnShout, btnMute}) do
		btn.Visible = true

		if btn == active then
			tweenTransparency(btn, 0.7)
			tweenTextTransparency(btn.TextLabel, 0)
		else
			tweenTransparency(btn, 1)
			tweenTextTransparency(btn.TextLabel, 1)
		end
	end
end

local function IsPlayerTalkingUI()

	local active

	if mode == "Whisper" then
		active = btnWhisper
	elseif mode == "Talk" then
		active = btnTalk
	elseif mode == "Shout" then
		active = btnShout
	elseif mode == "Mute" then
		active = btnMute
	end

	if active then
		tweenTransparency(active, 0)
	end
end

updateUI()

--========================
-- MODE SWITCH (V)
--========================

UserInputService.InputBegan:Connect(function(input, gp)
	if gp then return end
	if input.KeyCode == Enum.KeyCode.V then
		current += 1
		if current > #MODES then current = 1 end
		mode = MODES[current]
		updateUI()
	end
end)

--========================
-- SEND POSITION
--========================

task.spawn(function()
	while true do
		task.wait(1)
		if player.Character and player.Character.PrimaryPart then
			local root = player.Character.PrimaryPart
			local pos  = root.Position
			local look = root.CFrame.LookVector
			UpdatePosition:FireServer(pos.X, pos.Y, pos.Z, look.X, look.Y, look.Z, mode)
		end
	end
end)

--========================
-- STATUS ANIMATION
--========================

local speaking = false

SpeakingUpdated.OnClientEvent:Connect(function(isSpeaking)
	speaking = isSpeaking
end)

VolumesUpdated.OnClientEvent:Connect(function(Volumes)
	warn(Volumes)
end)

-- Receive spatial position data from the server (forwarded by ServerScript)
SpatialUpdated.OnClientEvent:Connect(function(position)
	-- position contains {x, y, z, lx, ly, lz} of the local player as known by the server
	-- Spatial audio rendering is handled by the LiveKit web client using this data
end)

task.spawn(function()
	local dots = 0

	while true do
		task.wait(0.4)

		if speaking and mode ~= "Mute" then
			dots += 1
			if dots > 3 then
				dots = 1
			end

			status.Text = "Vous parlez" .. string.rep(".", dots)
			IsPlayerTalkingUI()
		else
			status.Text = ""
			dots = 0
		end
	end
end)
