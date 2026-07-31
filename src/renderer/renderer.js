/* micro:bit BLE <-> cables bridge, renderer side.
 *
 * Web Bluetooth only exists in the renderer, and the WebSocket server only
 * exists in main, so this file owns the radio and forwards over IPC.
 *
 * The micro:bit UART service reuses Nordic's UUIDs, whose TX/RX names are
 * relative to whichever end you stand at and are a reliable source of wiring
 * bugs. Named by direction here instead.
 */
const UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";

// The micro:bit profile and the Nordic UART spec assign these two UUIDs to
// OPPOSITE directions, and third-party docs repeat both versions. Rather than
// pick a side, attachGatt() asks the characteristics which one notifies and
// which one accepts writes.
const UART_CHARS = [
  "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
  "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
];

const MAX_WRITE_BYTES = 20; // UART characteristic payload limit
const WRITE_QUEUE_LIMIT = 20;

// Writes per second, adjustable from the UI while running. ~20 is about all the
// link will comfortably take; the ceiling is deliberately reachable so the
// failure mode can be demonstrated rather than only warned about.
const WRITE_RATE_DEFAULT = 20;
const WRITE_RATE_MIN = 1;
const WRITE_RATE_MAX = 50;
let writeIntervalMs = 1000 / WRITE_RATE_DEFAULT;
const PARTIAL_FLUSH_MS = 150; // emit an unterminated frame rather than stall

const el = (id) => document.getElementById(id);

const ui = {
  status: el("status"),
  banner: el("banner"),
  deviceName: el("deviceName"),
  connectBtn: el("connectBtn"),
  wsUrl: el("wsUrl"),
  serverState: el("serverState"),
  clientCount: el("clientCount"),
  retryBtn: el("retryBtn"),
  rate: el("rate"),
  lastRaw: el("lastRaw"),
  lastValues: el("lastValues"),
  log: el("log"),
  writeRate: el("writeRate"),
  picker: el("picker"),
  deviceList: el("deviceList"),
  cancelBtn: el("cancelBtn")
};

let device = null;
let charWrite = null;
let shouldReconnect = false;
let reconnectDelay = 1000;
let connecting = false;

let rxBuffer = "";
let partialTimer = null;
let framesThisWindow = 0;

const writeQueue = [];
let writeTimer = null;

/* ---------------------------------------------------------------- logging */

function log(message, kind) {
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString([], { hour12: false });
  line.textContent = `${time}  ${message}`;
  if (kind) line.className = `log--${kind}`;
  ui.log.append(line);
  while (ui.log.childElementCount > 60) ui.log.firstElementChild.remove();
  ui.log.scrollTop = ui.log.scrollHeight;
}

function setStatus(text, variant) {
  ui.status.textContent = text;
  ui.status.className = `pill pill--${variant}`;
}

function showBanner(message) {
  ui.banner.textContent = message;
  ui.banner.hidden = false;
}

function clearBanner() {
  ui.banner.hidden = true;
}

/* ------------------------------------------------------- receive from BLE */

function emitFrame(raw) {
  const text = raw.trim();
  if (!text) return;

  const values = text.split(",").map((part) => {
    const n = Number(part.trim());
    return Number.isFinite(n) ? n : null;
  });

  window.bridge.sendData({ raw: text, values, t: Date.now() });

  framesThisWindow += 1;
  ui.lastRaw.textContent = text;
  ui.lastValues.replaceChildren(
    ...values.map((v, i) => {
      const span = document.createElement("span");
      span.textContent = `${i}: ${v === null ? "—" : v}`;
      return span;
    })
  );
}

function handleNotification(event) {
  rxBuffer += new TextDecoder().decode(event.target.value);

  let newline;
  while ((newline = rxBuffer.indexOf("\n")) !== -1) {
    emitFrame(rxBuffer.slice(0, newline));
    rxBuffer = rxBuffer.slice(newline + 1);
  }

  // Students who use "uart write string" instead of "uart write line" never
  // send a terminator. Flush what we have rather than buffering forever.
  clearTimeout(partialTimer);
  if (rxBuffer.length > 0) {
    partialTimer = setTimeout(() => {
      emitFrame(rxBuffer);
      rxBuffer = "";
    }, PARTIAL_FLUSH_MS);
  }
}

/* ---------------------------------------------------------- send over BLE */

function queueWrite(text) {
  const line = text.endsWith("\n") ? text : `${text}\n`;
  writeQueue.push(line);
  // Drop oldest rather than let a frame-rate sender grow this without bound.
  while (writeQueue.length > WRITE_QUEUE_LIMIT) writeQueue.shift();
}

function applyWriteRate(perSecond, persist = true) {
  const clamped = Math.min(
    WRITE_RATE_MAX,
    Math.max(WRITE_RATE_MIN, Math.round(perSecond) || WRITE_RATE_DEFAULT)
  );
  writeIntervalMs = 1000 / clamped;
  ui.writeRate.value = String(clamped);

  if (persist) {
    try {
      localStorage.setItem("writeRate", String(clamped));
    } catch {
      // Storage unavailable; the rate still applies for this session.
    }
  }

  // Restart the timer so the change lands mid-stream, with no reconnection.
  if (writeTimer) {
    clearInterval(writeTimer);
    writeTimer = setInterval(flushWrites, writeIntervalMs);
  }
  return clamped;
}

async function flushWrites() {
  if (!charWrite || writeQueue.length === 0) return;

  const bytes = new TextEncoder().encode(writeQueue.shift());
  try {
    for (let offset = 0; offset < bytes.length; offset += MAX_WRITE_BYTES) {
      const chunk = bytes.slice(offset, offset + MAX_WRITE_BYTES);
      if (charWrite.writeValueWithoutResponse) {
        await charWrite.writeValueWithoutResponse(chunk);
      } else {
        await charWrite.writeValue(chunk);
      }
    }
  } catch (err) {
    log(`Write failed: ${err.message}`, "err");
  }
}

/* ------------------------------------------------------------- connection */

async function attachGatt() {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(UART_SERVICE);

  const candidates = await Promise.all(
    UART_CHARS.map((uuid) => service.getCharacteristic(uuid))
  );

  // Ground truth for the log: the profile docs disagree with each other, and the
  // declared property flags have not proven reliable on this stack either.
  for (const c of candidates) {
    const flags = ["read", "write", "writeWithoutResponse", "notify", "indicate"].filter(
      (k) => c.properties[k]
    );
    log(`…${c.uuid.slice(4, 8)}: ${flags.length ? flags.join(", ") : "no properties reported"}`);
  }

  // Don't trust the flags — just try to subscribe to each and keep whichever
  // one accepts it. The other end of the pair is the write characteristic.
  let notify = null;
  for (const c of candidates) {
    c.addEventListener("characteristicvaluechanged", handleNotification);
    try {
      await c.startNotifications();
      notify = c;
      break;
    } catch {
      c.removeEventListener("characteristicvaluechanged", handleNotification);
    }
  }

  if (!notify) throw new Error("Neither UART characteristic would accept notifications");

  charWrite = candidates.find((c) => c !== notify) || null;
  log(
    `Data in: …${notify.uuid.slice(4, 8)}` +
      (charWrite ? `, data out: …${charWrite.uuid.slice(4, 8)}` : ", no write channel")
  );

  clearInterval(writeTimer);
  writeTimer = setInterval(flushWrites, writeIntervalMs);

  reconnectDelay = 1000;
  setStatus(`Connected · ${device.name}`, "ok");
  ui.connectBtn.textContent = "Disconnect";
  ui.connectBtn.disabled = false;
  log(`Connected to ${device.name}`, "ok");
}

function onDisconnected() {
  charWrite = null;
  clearInterval(writeTimer);
  writeTimer = null;

  if (!shouldReconnect) {
    setStatus("Not connected", "idle");
    return;
  }

  setStatus("Reconnecting…", "busy");
  log(`Lost ${device.name}, retrying in ${reconnectDelay / 1000}s`, "err");

  setTimeout(async () => {
    if (!shouldReconnect) return;
    try {
      await attachGatt();
    } catch (err) {
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
      onDisconnected();
    }
  }, reconnectDelay);
}

async function connect() {
  if (connecting) return;
  connecting = true;
  clearBanner();
  setStatus("Scanning…", "busy");
  ui.connectBtn.disabled = true;
  ui.deviceList.replaceChildren(emptyDeviceRow("Searching…"));
  ui.picker.hidden = false;

  // requestDevice() throws NotFoundError when the user cancels, and
  // getPrimaryService() throws the same name when the service is absent.
  // Without tracking the phase, a real GATT failure reads as "cancelled".
  let inPicker = true;

  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "BBC micro:bit" }],
      // Without this the service stays invisible even after connecting.
      optionalServices: [UART_SERVICE]
    });

    inPicker = false;
    ui.picker.hidden = true;
    ui.deviceName.textContent = device.name;
    ui.deviceName.className = "value";
    setStatus("Connecting…", "busy");

    device.addEventListener("gattserverdisconnected", onDisconnected);
    shouldReconnect = true;
    await attachGatt();
  } catch (err) {
    ui.picker.hidden = true;
    shouldReconnect = false;
    device = null;
    setStatus("Not connected", "idle");
    ui.connectBtn.textContent = "Connect";
    ui.connectBtn.disabled = false;

    if (inPicker && err.name === "NotFoundError") {
      log("Cancelled — no micro:bit chosen.");
    } else if (err.name === "NotFoundError") {
      // Connected, but the UART service isn't being offered.
      const message =
        "Connected, but this micro:bit is not offering the UART service. " +
        "Either it is in pairing mode (press reset and let it boot normally — " +
        "you want the blinking corner pixel), or the program it is running does " +
        "not call bluetooth.startUartService().";
      log(message, "err");
      showBanner(message);
    } else {
      log(`Connection failed: ${err.name} — ${err.message}`, "err");
      showBanner(`Could not connect: ${err.name} — ${err.message}`);
    }
  } finally {
    connecting = false;
  }
}

function disconnect() {
  shouldReconnect = false;
  clearInterval(writeTimer);
  writeTimer = null;
  if (device && device.gatt.connected) device.gatt.disconnect();
  charWrite = null;
  setStatus("Not connected", "idle");
  ui.connectBtn.textContent = "Connect";
  log("Disconnected.");
}

function emptyDeviceRow(text) {
  const li = document.createElement("li");
  li.className = "device-list__empty";
  li.textContent = text;
  return li;
}

/* ------------------------------------------------------------------- wire */

ui.connectBtn.addEventListener("click", () => {
  if (shouldReconnect) disconnect();
  else connect();
});

ui.cancelBtn.addEventListener("click", () => {
  window.bridge.cancelScan();
  ui.picker.hidden = true;
});

ui.retryBtn.addEventListener("click", () => window.bridge.retryServer());

ui.writeRate.addEventListener("change", () => {
  const applied = applyWriteRate(Number(ui.writeRate.value));
  log(`Write cap set to ${applied}/s`);
});

window.bridge.onDevices((list) => {
  if (list.length === 0) {
    ui.deviceList.replaceChildren(emptyDeviceRow("Searching…"));
    return;
  }
  ui.deviceList.replaceChildren(
    ...list.map((d) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.textContent = d.deviceName;
      button.addEventListener("click", () => window.bridge.selectDevice(d.deviceId));
      li.append(button);
      return li;
    })
  );
});

window.bridge.onTx((text) => queueWrite(text));

window.bridge.onPairingRequired((message) => {
  showBanner(message);
  log(message, "err");
});

function renderServerStatus(status) {
  if (status.listening) {
    ui.serverState.textContent = "listening";
    ui.serverState.className = "tag";
    ui.retryBtn.hidden = true;
    clearBanner();
  } else {
    ui.serverState.textContent = "not running";
    ui.serverState.className = "tag tag--dim";
    ui.retryBtn.hidden = false;
    if (status.error) showBanner(status.error);
  }
}

function renderClientCount(n) {
  ui.clientCount.textContent = `${n} patch${n === 1 ? "" : "es"} connected`;
  ui.clientCount.className = n > 0 ? "tag" : "tag tag--dim";
}

window.bridge.onServerStatus((status) => {
  renderServerStatus(status);
  if (status.listening) log(`WebSocket server listening on port ${status.port}`, "ok");
  else log(status.error, "err");
});

window.bridge.onClientCount(renderClientCount);

setInterval(() => {
  ui.rate.textContent = `${framesThisWindow} /s`;
  framesThisWindow = 0;
}, 1000);

let savedRate = WRITE_RATE_DEFAULT;
try {
  savedRate = Number(localStorage.getItem("writeRate")) || WRITE_RATE_DEFAULT;
} catch {
  // Storage unavailable; fall back to the default.
}
applyWriteRate(savedRate, false);

// The server starts before this script subscribes, so its "listening" event is
// already gone by now. Pull the current state instead of waiting for the next one.
window.bridge.serverInfo().then((info) => {
  ui.wsUrl.textContent = `ws://localhost:${info.port}`;
  renderServerStatus(info);
  renderClientCount(info.clients);
});
