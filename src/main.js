const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { WebSocketServer } = require("ws");

// Fixed port on purpose. Every student's bridge listens here, so the same
// cables patch works on every laptop with no per-machine editing. If the port
// is taken we surface an error and let them retry rather than silently moving
// to another port and breaking that guarantee.
const PORT = 8080;

// This window spends its whole life behind the cables patch, which is precisely
// when Chromium clamps timers in backgrounded, occluded or minimised renderers.
// That throttles the BLE write loop to a crawl, so switch it off: being in the
// background is the normal operating state here, not an idle one.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

let mainWindow = null;
let wss = null;

/**
 * Electron hands us a fresh callback every time it discovers another device
 * during a single requestDevice() call. We keep only the newest one and invoke
 * it once the student picks from the list in the renderer.
 */
let pendingBluetoothCallback = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function broadcastClientCount() {
  send("ws:clients", wss ? wss.clients.size : 0);
}

function startServer() {
  if (wss) return;

  wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });

  wss.on("listening", () => {
    send("ws:status", { listening: true, port: PORT, error: null });
    broadcastClientCount();
  });

  wss.on("connection", (socket) => {
    broadcastClientCount();

    // cables -> micro:bit. Accept either a bare string or an object with a
    // `tx` field, since WebSocketSend serialises objects.
    socket.on("message", (data) => {
      const text = data.toString();
      let out = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          out = parsed.tx ?? parsed.text ?? parsed.value ?? text;
        }
      } catch {
        // Not JSON; treat the whole payload as the string to send.
      }
      if (out !== null && out !== undefined && String(out).length > 0) {
        send("ble:tx", String(out));
      }
    });

    socket.on("close", broadcastClientCount);
    socket.on("error", broadcastClientCount);
  });

  wss.on("error", (err) => {
    const inUse = err && err.code === "EADDRINUSE";
    send("ws:status", {
      listening: false,
      port: PORT,
      error: inUse
        ? `Port ${PORT} is already in use. Close any other copy of this app (or whatever else is using ${PORT}) and press Retry.`
        : String(err && err.message ? err.message : err)
    });
    try {
      wss.close();
    } catch {
      /* already closing */
    }
    wss = null;
  });
}

function broadcast(payload) {
  if (!wss) return;
  const text = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(text);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    title: "micro:bit → cables bridge",
    backgroundColor: "#14161a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Web Bluetooth in Electron has no native chooser: Chromium fires this in the
  // main process and expects us to render the device list ourselves, then call
  // back with the chosen id. Calling preventDefault without ever invoking the
  // callback would hang requestDevice() forever, so every path must resolve it.
  mainWindow.webContents.on("select-bluetooth-device", (event, deviceList, callback) => {
    event.preventDefault();
    pendingBluetoothCallback = callback;
    send(
      "ble:devices",
      deviceList.map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName || "(unnamed)"
      }))
    );
  });

  // With a "No Pairing Required" hex this never fires. If it does, the micro:bit
  // was flashed with pairing on, which is worth saying out loud.
  mainWindow.webContents.session.setBluetoothPairingHandler((details, callback) => {
    send(
      "ble:pairing-required",
      "This micro:bit is asking to pair. Re-flash it with Project Settings → " +
        '"No Pairing Required: Anyone can connect via Bluetooth" enabled.'
    );
    callback({ confirmed: false });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Two copies would fight over port 8080 and over the Bluetooth adapter.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    startServer();
  });

  // This is a single-purpose tool: closing the window means "stop bridging",
  // including on macOS.
  app.on("window-all-closed", () => app.quit());
}

ipcMain.on("ble:select-device", (_event, deviceId) => {
  if (pendingBluetoothCallback) {
    pendingBluetoothCallback(deviceId);
    pendingBluetoothCallback = null;
  }
});

ipcMain.on("ble:cancel-scan", () => {
  if (pendingBluetoothCallback) {
    pendingBluetoothCallback("");
    pendingBluetoothCallback = null;
  }
});

ipcMain.on("bridge:data", (_event, payload) => broadcast(payload));

ipcMain.on("ws:retry", () => startServer());

ipcMain.handle("ws:info", () => ({
  listening: Boolean(wss),
  port: PORT,
  clients: wss ? wss.clients.size : 0
}));
