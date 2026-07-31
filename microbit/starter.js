// MakeCode starter program for the cables bridge.
//
// To use: open https://makecode.microbit.org, start a new project, switch the
// editor from Blocks to JavaScript, and replace everything with this file.
//
// TWO SETTINGS MUST BE CHANGED FIRST (gear icon -> Project Settings):
//   1. Add the "Bluetooth" extension (this removes the Radio extension).
//   2. Turn ON "No Pairing Required: Anyone can connect via Bluetooth".
// Without #2 you will be stuck in Windows pairing dialogs.

let connected = false

bluetooth.startUartService()

bluetooth.onBluetoothConnected(function () {
    connected = true
    basic.showIcon(IconNames.Yes)
    basic.pause(300)
    basic.clearScreen()
})

bluetooth.onBluetoothDisconnected(function () {
    connected = false
    basic.showIcon(IconNames.No)
})

// cables -> micro:bit. Send a single digit and it appears on the display.
bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    const message = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    const n = parseFloat(message)
    if (!isNaN(n)) {
        basic.showNumber(Math.round(n))
    } else {
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
