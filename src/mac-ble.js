const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

function namedError(message, name = "NetworkError") {
  return Object.assign(new Error(message), { name });
}

class MacBLE {
  constructor(executable, onEvent, args = []) {
    this.executable = executable;
    this.onEvent = onEvent;
    this.args = args;
    this.nextId = 1;
    this.child = null;
    this.pending = new Map();
  }

  start() {
    const child = spawn(this.executable, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-500); });
    lines.on("line", (line) => {
      if (this.child !== child) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg?.event) {
        this.onEvent(msg);
        return;
      }
      const req = this.pending.get(msg?.id);
      if (!req) return;
      this.pending.delete(msg.id);
      if (msg.ok) req.resolve(msg.result);
      else req.reject(namedError(msg.error, msg.name));
    });
    const fail = (message) => {
      if (this.child !== child) return;
      this.stop(message);
      this.onEvent({ event: "helper-exited", message });
    };
    child.on("error", (error) => fail(`Could not launch Core Bluetooth: ${error.message}`));
    child.stdin.on("error", (error) => fail(`Core Bluetooth communication ended: ${error.message}`));
    child.on("close", (code, signal) => {
      fail(`Core Bluetooth helper exited (${signal || code}).${stderr.trim() ? " " + stderr.trim() : ""}`);
    });
  }

  request(op, fields = {}) {
    if (!this.child) {
      if (op === "stop" || op === "disconnect") return Promise.resolve({});
      if (op === "write") return Promise.reject(namedError("Core Bluetooth is disconnected."));
      this.start();
    }
    const id = this.nextId++;
    const line = JSON.stringify({ ...fields, op, id }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(line);
    });
  }

  stop(message = "Core Bluetooth helper stopped.") {
    const child = this.child;
    this.child = null;
    child?.kill();
    for (const req of this.pending.values()) req.reject(namedError(message));
    this.pending.clear();
  }
}

module.exports = { MacBLE };
