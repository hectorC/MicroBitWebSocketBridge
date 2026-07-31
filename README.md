# micro:bit → cables bridge

Connects a micro:bit to a cables.gl **standalone** patch over Bluetooth LE.

The app talks to the micro:bit over BLE and exposes the data as a WebSocket
server on `ws://localhost:8080`. Because the port is the same on every machine,
**one patch file works on every student's laptop with no editing.**

Data flows both ways: micro:bit sensors into the patch, and messages from the
patch back to the micro:bit.

```
micro:bit  ──BLE UART──▶  this app  ──ws://localhost:8080──▶  cables standalone
           ◀───────────────────────────────────────────────
```

---

## Student setup

**1. Flash the micro:bit.** Open [makecode.microbit.org](https://makecode.microbit.org),
new project, switch the editor to JavaScript, paste in
[`microbit/starter.js`](microbit/starter.js). Then, before downloading, open
**Project Settings** (gear icon) and:

- add the **Bluetooth** extension, and
- turn on **"No Pairing Required: Anyone can connect via Bluetooth"**.

That second setting is not optional. Skip it and you land in Windows pairing
dialogs, which is where classroom time goes to die.

**2. Run the bridge.** Open the app. It shows `listening` next to the server
address once it is ready.

**3. Connect.** Click **Connect** and pick your micro:bit from the list. Devices
are named `BBC micro:bit [vatav]` — the five letters match what your board shows
when it starts up. This matters in a room of 30 identical devices.

**4. Open the cables patch.** The app's *patches connected* counter goes to 1
when cables attaches.

The micro:bit shows a tick when connected and a cross when it drops.

---

## Wiring it up in cables

Add an **`Ops.Net.WebSocket.WebSocket_v2`** op and set its URL to:

```
ws://localhost:8080
```

Useful ports on that op:

| Port | Use |
| --- | --- |
| `Result` | the parsed message as an object — this is the one you want |
| `Raw Data` | the same thing as a string, handy while debugging |
| `Received Data` | trigger, fires once per micro:bit frame |
| `Connected` | wire this to something visible so students can see the link is live |

Each message looks like this:

```json
{ "raw": "24,-112,-1032,0,1,148", "values": [24, -112, -1032, 0, 1, 148], "t": 1753000000000 }
```

`values` is the incoming line split on commas and converted to numbers, so with
the starter program you get `values[0]` = accel X, `[1]` = Y, `[2]` = Z,
`[3]` = button A, `[4]` = button B, `[5]` = light level. Anything that isn't a
number becomes `null` rather than breaking the frame. Use cables' object/array
accessor ops to pull fields off `Result`.

Students who change what the micro:bit sends just get a different `values`
array — no change needed here or in the bridge.

### Sending back to the micro:bit

Feed the `Connection` output of `WebSocket_v2` into an
**`Ops.Net.WebSocket.WebSocketSend`** op and send:

```json
{ "tx": "5" }
```

A bare string works too. The starter program draws a number it receives as a bar
graph on the LED display, scaled 0–100. Anything non-numeric scrolls as text.

Writes are deliberately rate-limited to ~20/sec and chunked to 20 bytes, because
the UART characteristic will not take frame-rate traffic and flooding it drops
the connection. If you send faster than that, the oldest queued messages are
discarded rather than backing up.

---

## Developing

```bash
npm install
npm start
```

## Building installers

```bash
npm run dist
```

`electron-builder` can only build a macOS target on macOS, so for both platforms
push a tag and let CI do it:

```bash
git tag v0.1.0 && git push --tags
```

[`.github/workflows/build.yml`](.github/workflows/build.yml) builds on
`windows-latest` and `macos-latest`, then attaches both installers to a
**GitHub Release** for that tag. That gives you a permanent download link per
platform that works without a GitHub account — paste those two URLs into your
handout. (Build *artifacts* would require students to sign in, find the
workflow run, and unzip.)

Keep the tag and the `version` in `package.json` in step; electron-builder takes
the filename from `package.json`, not the tag.

The Windows installer is per-user, so students don't need admin rights. The
macOS dmg is universal — one download for both Intel and Apple Silicon.

Both builds are **unsigned**. On macOS the first launch is blocked and the
student has to go to **System Settings → Privacy & Security → Open Anyway**
once — the old right-click → Open trick no longer works on current macOS. Put
that in your handout. Windows shows a SmartScreen warning: *More info → Run
anyway*.

---

## Troubleshooting

**Nothing in the device list — but the board appears if you hold A+B and press
reset.** *No Pairing Required* is not set in the hex. With MakeCode's default
JustWorks pairing the micro:bit stays invisible to anything it hasn't already
bonded with, so it looks completely dead to every scanner while running
perfectly. This is the failure that will strand students. Fix it in Project
Settings and **re-download** — the setting is compiled in, so changing it
without re-flashing does nothing.

Note that pairing mode is a diagnostic only: in that mode the board runs a
built-in pairing app rather than your program, so it has no UART service to
connect to.

**Nothing in the device list at all.** The micro:bit is not advertising. It only
advertises when it isn't already connected to something — check it isn't still
paired to a phone or another laptop. Re-flashing is the reliable reset. A
blinking top-left pixel confirms the program is running and waiting.

**"This micro:bit is asking to pair."** It was flashed without the *No Pairing
Required* setting. Re-flash it.

**Connects, then immediately drops.** Usually a low battery. This is the single
most common failure in a classroom set — it presents as a flaky connection
rather than a dead board.

**`Port 8080 is already in use`.** Another copy of the app is running (the app
allows only one, but a crashed instance can linger), or something else has the
port. The app deliberately does *not* fall back to another port, because that
would break the "one patch works everywhere" guarantee. Close the other process
and press Retry.

**Device list shows other students' micro:bits.** Expected — BLE advertising is
public. That's what the five-letter name is for.

**Data arrives but the patch shows nothing.** Check *patches connected* reads 1.
If it reads 0, cables never attached — check the URL. If it reads 1 and the
Activity log is scrolling, the problem is downstream in the patch.

**macOS: no devices ever appear, no permission prompt.** The Bluetooth usage
description is missing from the built app. It's set in
[`electron-builder.yml`](electron-builder.yml); this only bites if that config
gets changed.
