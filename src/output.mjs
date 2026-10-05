import dgram from "node:dgram";
import net from "node:net";
import { EventEmitter } from "node:events";
import { toBuffer } from "osc-min";
import { WebSocketServer } from "ws";

export const DEFAULT_OUTPUT = Object.freeze({
  mode: "websocket",
  host: "127.0.0.1",
  port: 9000
});

export function validateOutput(settings) {
  if (!settings || !["websocket", "osc"].includes(settings.mode)) {
    throw new Error("Choose WebSocket or OSC output.");
  }
  const host = typeof settings.host === "string" ? settings.host.trim() : "";
  // Accept IP addresses and DNS hostnames, but not URLs or host:port strings.
  const hostname = host.length <= 253 && host.split(".").every(
    label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (!net.isIP(host) && (!hostname || /^\d+(\.\d+){3}$/.test(host))) {
    throw new Error("Enter a destination IP address or hostname, such as 127.0.0.1.");
  }
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
    throw new Error("OSC port must be a whole number from 1 to 65535.");
  }
  return { mode: settings.mode, host, port: settings.port };
}

export function encodeFrame(values) {
  if (!Array.isArray(values)) return null;
  const elements = [];
  values.forEach((value, index) => {
    // Preserve the array index when skipping text/null. A missing reading must
    // not turn into zero or shift every later channel's meaning.
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const integer = Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    if (!integer && !Number.isFinite(Math.fround(value))) return;
    elements.push({
      address: `/microbit/value/${index}`,
      args: [{ type: integer ? "integer" : "float", value }]
    });
  });
  if (!elements.length) return null;
  const packet = toBuffer({ oscType: "bundle", timetag: [0, 1], elements });
  return Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
}

export class OutputBridge extends EventEmitter {
  constructor(settings = DEFAULT_OUTPUT, wsPort = 8080) {
    super();
    this.settings = validateOutput(settings);
    this.wsPort = wsPort;
    this.wss = null;
    this.wsListening = false;
    this.wsError = null;
    this.udp = null;
    this.oscSent = 0;
    this.oscError = null;
    this.generation = 0;
  }

  info() {
    return {
      settings: { ...this.settings },
      ws: { listening: this.wsListening, port: this.wsPort, error: this.wsError },
      clients: this.wss ? this.wss.clients.size : 0,
      osc: { sent: this.oscSent, error: this.oscError }
    };
  }

  start() {
    if (this.settings.mode === "websocket") this.startServer();
  }

  async configure(settings) {
    const next = validateOutput(settings);
    if (this.settings.mode === "websocket" && next.mode === "websocket") {
      this.settings = next;
      this.start();
      return this.info();
    }
    await this.stop();
    this.settings = next;
    this.oscSent = 0;
    this.oscError = null;
    this.wsError = null;
    this.start();
    return this.info();
  }

  startServer() {
    if (this.wss || this.settings.mode !== "websocket") return;
    const server = new WebSocketServer({ port: this.wsPort, host: "127.0.0.1" });
    this.wss = server;
    server.on("listening", () => {
      if (this.wss !== server) return;
      this.wsListening = true;
      this.wsError = null;
      this.emit("ws-status", this.info().ws);
      this.emit("clients", server.clients.size);
    });
    server.on("connection", (socket) => {
      if (this.wss !== server) return socket.terminate();
      this.emit("clients", server.clients.size);
      socket.on("message", (data) => {
        if (this.wss !== server || this.settings.mode !== "websocket") return;
        const text = data.toString();
        let out = text;
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object") {
            out = parsed.tx ?? parsed.text ?? parsed.value ?? text;
          }
        } catch { /* Bare strings also work. */ }
        if (out !== null && out !== undefined && String(out).length > 0) {
          this.emit("tx", String(out));
        }
      });
      const count = () => {
        if (this.wss === server) this.emit("clients", server.clients.size);
      };
      socket.on("close", count);
      socket.on("error", count);
    });
    server.on("error", (err) => {
      if (this.wss !== server) return;
      this.wss = null;
      this.wsListening = false;
      this.wsError = err.code === "EADDRINUSE"
        ? `Port ${this.wsPort} is already in use. Close the other app using it and press Retry.`
        : err.message;
      server.close();
      this.emit("ws-status", this.info().ws);
      this.emit("clients", 0);
    });
  }

  sendFrame(payload) {
    if (this.settings.mode === "websocket") {
      if (!this.wss) return;
      const text = JSON.stringify(payload);
      for (const client of this.wss.clients) {
        if (client.readyState === 1) client.send(text);
      }
      return;
    }
    const packet = encodeFrame(payload?.values);
    if (!packet) return;
    // Sending lazily opens an ephemeral UDP source port. There is no listener
    // and no native dependency: dgram works on both Windows and macOS.
    const generation = this.generation;
    if (!this.udp) {
      this.udp = dgram.createSocket(net.isIP(this.settings.host) === 6 ? "udp6" : "udp4");
      this.udp.on("error", (err) => this.oscResult(err, generation));
    }
    try {
      this.udp.send(packet, this.settings.port, this.settings.host,
        (err) => this.oscResult(err, generation));
    } catch (err) {
      this.oscResult(err, generation);
    }
  }

  oscResult(err, generation) {
    if (generation !== this.generation) return;
    this.oscError = err ? err.message : null;
    if (!err) this.oscSent += 1;
    this.emit("osc-status", this.info().osc);
  }

  stop() {
    this.generation += 1;
    let closed = Promise.resolve();
    if (this.wss) {
      const server = this.wss;
      this.wss = null;
      for (const client of server.clients) client.terminate();
      closed = new Promise((resolve) => server.close(() => resolve()));
    }
    this.wsListening = false;
    if (this.udp) {
      try { this.udp.close(); } catch { /* Not bound yet. */ }
      this.udp = null;
    }
    return closed;
  }
}
