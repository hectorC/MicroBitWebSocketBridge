const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// This window spends its whole life behind the cables patch, which is precisely
// when Chromium clamps timers in backgrounded, occluded or minimised renderers.
// That throttles the BLE write loop to a crawl, so switch it off: being in the
// background is the normal operating state here, not an idle one.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

let mainWindow = null;
let output = null;
let validateOutput = null;
let settingsPath = null;
let settingsWarning = null;

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 820,
    minWidth: 480,
    minHeight: 560,
    title: "micro:bit → WebSocket / OSC",
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

  app.whenReady().then(async () => {
    const transport = await import("./output.mjs");
    validateOutput = transport.validateOutput;
    settingsPath = path.join(app.getPath("userData"), "output.json");
    let settings = transport.DEFAULT_OUTPUT;
    try {
      settings = validateOutput(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
    } catch (err) {
      if (err.code !== "ENOENT") {
        settingsWarning = "Saved output settings could not be loaded. Using WebSocket defaults.";
      }
    }
    output = new transport.OutputBridge(settings);
    output.on("ws-status", (status) => send("ws:status", status));
    output.on("clients", (count) => send("ws:clients", count));
    output.on("osc-status", (status) => send("osc:status", status));
    output.on("tx", (text) => send("ble:tx", text));
    createWindow();
    output.start();
  });

  // This is a single-purpose tool: closing the window means "stop bridging",
  // including on macOS.
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => output?.stop());
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

ipcMain.on("bridge:data", (_event, payload) => output?.sendFrame(payload));

ipcMain.on("ws:retry", () => output?.startServer());

ipcMain.handle("output:info", () => ({ ...output.info(), warning: settingsWarning }));

ipcMain.handle("output:configure", async (_event, settings) => {
  try {
    const next = validateOutput(settings);
    // Save before changing the transport so a failed save leaves the active
    // output alone. userData resolves correctly on Windows and macOS.
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(`${settingsPath}.tmp`, JSON.stringify(next, null, 2));
    fs.renameSync(`${settingsPath}.tmp`, settingsPath);
    const info = await output.configure(next);
    settingsWarning = null;
    return { ok: true, ...info };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
