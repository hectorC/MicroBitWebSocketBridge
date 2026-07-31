const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridge", {
  // Device chooser (driven by main's select-bluetooth-device handler)
  onDevices: (cb) => ipcRenderer.on("ble:devices", (_e, list) => cb(list)),
  selectDevice: (deviceId) => ipcRenderer.send("ble:select-device", deviceId),
  cancelScan: () => ipcRenderer.send("ble:cancel-scan"),
  onPairingRequired: (cb) => ipcRenderer.on("ble:pairing-required", (_e, msg) => cb(msg)),

  // micro:bit -> cables
  sendData: (payload) => ipcRenderer.send("bridge:data", payload),

  // cables -> micro:bit
  onTx: (cb) => ipcRenderer.on("ble:tx", (_e, text) => cb(text)),

  // Server state
  onServerStatus: (cb) => ipcRenderer.on("ws:status", (_e, status) => cb(status)),
  onClientCount: (cb) => ipcRenderer.on("ws:clients", (_e, n) => cb(n)),
  retryServer: () => ipcRenderer.send("ws:retry"),
  serverInfo: () => ipcRenderer.invoke("ws:info")
});
