// MakeCode starter program for the cables bridge.
//
// To use: open https://makecode.microbit.org, start a new project, switch the
// editor from Blocks to JavaScript, and replace everything with this file.
//
// TWO SETTINGS MUST BE CHANGED FIRST (gear icon -> Project Settings):
//   1. Add the "Bluetooth" extension (this removes the Radio extension).
//   2. Turn ON "No Pairing Required: Anyone can connect via Bluetooth".
// Without #2 the micro:bit stays invisible to every scanner while appearing to
// run perfectly, which is a miserable thing to debug in front of a class.

let connected = false
let showingName = false

// The five-letter name the bridge lists this board under, derived from its
// serial number. Scrolled at startup and on button A, so a student can tell
// their micro:bit from the twenty-nine others in the room.
function showName() {
    showingName = true
    basic.showString(control.deviceName())
    basic.clearScreen()
    showingName = false
}

bluetooth.startUartService()

input.onButtonPressed(Button.A, function () {
    // Only while disconnected: once connected, A is a data input.
    if (!connected) {
        showName()
    }
})

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

// cables -> micro:bit. Send a number 0-100 and it draws as a bar graph.
bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    const message = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    const n = parseFloat(message)
    if (!isNaN(n)) {
        // plotBarGraph draws immediately. showNumber would block for about a
        // second per digit, so a patch sending continuously would back up the
        // event queue and the micro:bit would look frozen.
        led.plotBarGraph(n, 100)
    } else {
        // Text still scrolls, and still blocks. Fine for the odd message.
        basic.showString(message)
    }
})

// micro:bit -> cables, at 20 Hz. The bridge splits this on commas, so in cables
// you get values[0] = x, values[1] = y, and so on.
basic.forever(function () {
    if (connected) {
        bluetooth.uartWriteLine(
            "" + input.acceleration(Dimension.X) + "," +
            input.acceleration(Dimension.Y) + "," +
            input.acceleration(Dimension.Z) + "," +
            (input.buttonIsPressed(Button.A) ? 1 : 0) + "," +
            (input.buttonIsPressed(Button.B) ? 1 : 0) + "," +
            input.lightLevel()
        )
    }
    basic.pause(50)
})

// Last, so every handler above is registered before this blocks for a few
// seconds scrolling the name.
showName()
