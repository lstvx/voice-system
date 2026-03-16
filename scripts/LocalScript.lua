local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer

-- RemoteEvents
local VoiceSystemEvents = ReplicatedStorage:WaitForChild("VoiceSystemEvents")
local UpdatePosition    = VoiceSystemEvents:WaitForChild("UpdatePosition")
local SpeakingUpdated   = VoiceSystemEvents:WaitForChild("SpeakingUpdated")

--========================
-- UI REFERENCES
--========================

local gui = player.PlayerGui:WaitForChild("Main"):WaitForChild("Hud"):WaitForChild("Voice")

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
-- V KEY (SHORT / LONG PRESS)
--========================

local HOLD_TIME = 0.5
local holding = false
local holdStart = 0

UserInputService.InputBegan:Connect(function(input, gp)
	if gp then return end
	if input.KeyCode ~= Enum.KeyCode.V then return end

	holding = true
	holdStart = tick()
end)

UserInputService.InputEnded:Connect(function(input, gp)
	if gp then return end
	if input.KeyCode ~= Enum.KeyCode.V then return end

	if not holding then return end
	holding = false

	local duration = tick() - holdStart

	-- 🎯 LONG PRESS = CHANGE MODE
	if duration >= HOLD_TIME then
		current += 1
		if current > #MODES then current = 1 end
		mode = MODES[current]
		updateUI()

	else
		-- 🎯 SHORT PRESS = TOGGLE MUTE

		if mode == "Mute" then
			mode = MODES[current ~= 4 and current or 2]
		else
			mode = "Mute"
		end

		updateUI()
	end
end)

--========================
-- SEND POSITION
--========================

local SEND_INTERVAL = 0.20 -- 5 Hz (robust enough for proximity without spamming)
local MIN_MOVE_STUDS = 1.0
local MIN_LOOK_DOT = 0.985 -- ~10 degrees
local FORCE_HEARTBEAT = 1.0 -- always send at least once per second

task.spawn(function()
	local lastPos = nil
	local lastLook = nil
	local lastMode = nil
	local lastSent = 0

	while true do
		task.wait(SEND_INTERVAL)

		if not (player.Character and player.Character.PrimaryPart) then
			continue
		end

		local root = player.Character.PrimaryPart
		local pos = root.Position
		local look = root.CFrame.LookVector

		local changed = false
		if lastPos == nil then
			changed = true
		else
			if (pos - lastPos).Magnitude >= MIN_MOVE_STUDS then
				changed = true
			end
		end

		if not changed and lastLook ~= nil then
			if look:Dot(lastLook) <= MIN_LOOK_DOT then
				changed = true
			end
		end

		if lastMode ~= mode then
			changed = true
		end

		if not changed and (tick() - lastSent) >= FORCE_HEARTBEAT then
			changed = true
		end

		if changed then
			UpdatePosition:FireServer(pos.X, pos.Y, pos.Z, look.X, look.Y, look.Z, mode)
			lastPos = pos
			lastLook = look
			lastMode = mode
			lastSent = tick()
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
			updateUI()
		end
	end
end)
