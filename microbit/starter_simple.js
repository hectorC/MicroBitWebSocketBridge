bluetooth.onBluetoothConnected(function () {
    connected = true
    basic.showIcon(IconNames.Yes)
    basic.pause(300)
    basic.clearScreen()
})
bluetooth.onBluetoothDisconnected(function () {
    connected = false
    basic.clearScreen()
})
input.onButtonPressed(Button.A, function () {
    // Only while disconnected: once connected, A is a data input.
    if (!(connected)) {
        showName()
    }
})
// cables -> micro:bit. Send a number 0-100 and it draws as a bar graph.
bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    message = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    receivedVals = message.split(",")
    value1 = parseFloat(receivedVals[0])
    if (value1 == 1) {
        music.play(music.createSoundExpression(WaveShape.Sine, 5000, 0, 255, 0, 500, SoundExpressionEffect.None, InterpolationCurve.Linear), music.PlaybackMode.InBackground)
    }
})
// The five-letter name the bridge lists this board under, derived from its
// serial number. Scrolled at startup and on button A, so a student can tell
// their micro:bit from the twenty-nine others in the room.
function showName () {
    showingName = true
    basic.showString(control.deviceName())
    basic.clearScreen()
    showingName = false
}
let buttonBstate = 0
let buttonAstate = 0
let showingName = false
let value1 = 0
let receivedVals: string[] = []
let message = ""
let connected = false
bluetooth.startUartService()
// Last, so every handler above is registered before this blocks for a few
// seconds scrolling the name.
showName()
// micro:bit -> cables, at 20 Hz. The bridge splits this on commas, so in cables
// you get values[0] = x, values[1] = y, and so on.
basic.forever(function () {
    if (connected) {
        if (input.buttonIsPressed(Button.A)) {
            buttonAstate = 1
        } else {
            buttonAstate = 0
        }
        if (input.buttonIsPressed(Button.B)) {
            buttonBstate = 1
        } else {
            buttonBstate = 0
        }
        bluetooth.uartWriteLine("" + input.acceleration(Dimension.X) + "," + input.acceleration(Dimension.Y) + "," + input.acceleration(Dimension.Z) + "," + buttonAstate + "," + buttonBstate + "," + input.lightLevel() + "," + input.temperature())
    }
    basic.pause(10)
})
// Heartbeat, so "running and advertising" looks different from "not running".
// Blinking top-left pixel = waiting for a connection. Blank = connected, which
// leaves the display free for messages arriving from cables.
basic.forever(function () {
    if (connected || showingName) {
        basic.pause(500)
    } else {
        led.plot(0, 0)
        basic.pause(250)
        led.unplot(0, 0)
        basic.pause(750)
    }
})
