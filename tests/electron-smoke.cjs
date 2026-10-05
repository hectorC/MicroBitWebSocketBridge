// Run with npm run test:electron. Uses the real preload, renderer and IPC in a
// hidden window, isolated settings, and a local UDP receiver. No board needed.
const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const dgram = require("node:dgram");
const { once } = require("node:events");

const root = path.resolve(__dirname, "..");
const temporaryPrefix = path.join(os.tmpdir(), "microbit-bridge-smoke-");
const userData = fs.mkdtempSync(temporaryPrefix);
const artifacts = path.join(root, "dist", "smoke");
const packaged = process.argv.includes("--packaged");
const restored = process.argv.includes("--restored");
const label = `${packaged ? "packaged" : "source"}${restored ? "-restored" : ""}`;
const receiver = dgram.createSocket("udp4");
const timer = setTimeout(() => finish(new Error("Electron smoke test timed out")), 20000);
app.setPath("userData", userData);
if (restored) {
  fs.writeFileSync(path.join(userData, "output.json"), JSON.stringify({ mode: "osc", host: "127.0.0.1", port: 9000 }));
}

function finish(error) {
  clearTimeout(timer);
  try { receiver.close(); } catch { /* Not bound yet. */ }
  if (error) console.error(error.stack);
  else console.log(`Electron ${label} smoke test passed: UI, IPC, UDP, validation and saved settings.`);
  // Keep the isolated profile until Electron has exited; Chromium can still
  // hold files open during shutdown. It is created under the OS temp folder.
  app.exit(error ? 1 : 0);
}

async function waitFor(win, expression) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`UI condition did not become true: ${expression}`);
}

async function capture(win, filename) {
  // A hidden window needs a compositor frame before capturePage can copy it.
  await new Promise(resolve => setTimeout(resolve, 200));
  const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  assert.equal(image.isEmpty(), false);
  fs.writeFileSync(path.join(artifacts, filename), image.toPNG());
}

app.on("browser-window-created", (_event, win) => {
  win.hide();
  win.webContents.once("did-finish-load", async () => {
    try {
      await waitFor(win, "!document.getElementById('outputMode').disabled");
      const initialMode = await win.webContents.executeJavaScript("document.getElementById('outputMode').value");
      assert.equal(initialMode, restored ? "osc" : "websocket");
      fs.mkdirSync(artifacts, { recursive: true });
      if (!restored) {
        await capture(win, `${label}-websocket.png`);
      }
      const { fromBuffer } = await import("osc-min");
      receiver.bind(0, "127.0.0.1");
      await once(receiver, "listening");
      if (!restored) {
        await win.webContents.executeJavaScript(`
          document.getElementById('outputMode').value = 'osc';
          document.getElementById('outputMode').dispatchEvent(new Event('change'));
        `);
        await waitFor(win, "!document.getElementById('outputMode').disabled && !document.getElementById('oscPanel').hidden");
      }
      const port = receiver.address().port;
      await win.webContents.executeJavaScript(`
        document.getElementById('oscPort').value = ${port};
        document.getElementById('oscForm').requestSubmit();
      `);
      await waitFor(win, `!document.getElementById('outputMode').disabled && document.getElementById('oscDestination').textContent === '127.0.0.1:${port}'`);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, "output.json"), "utf8")), {
        mode: "osc", host: "127.0.0.1", port
      });
      const packet = once(receiver, "message");
      await win.webContents.executeJavaScript("window.bridge.sendData({ raw: '24,-112,-1032,0,1,148', values: [24,-112,-1032,0,1,148], t: 123 })");
      assert.deepEqual(fromBuffer((await packet)[0]).elements.map(m => m.args[0].value), [24,-112,-1032,0,1,148]);
      await waitFor(win, "document.getElementById('oscCount').textContent === '1 packet sent'");
      assert.equal(await win.webContents.executeJavaScript("document.getElementById('writeCard').hidden"), true);
      assert.equal(await win.webContents.executeJavaScript("document.getElementById('lastRaw').closest('section').hidden"), false);
      await capture(win, `${label}-osc.png`);
      win.setSize(480, 820);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await win.webContents.executeJavaScript("document.documentElement.scrollWidth <= innerWidth"), true);
      await capture(win, `${label}-osc-small.png`);
      const rejected = await win.webContents.executeJavaScript("window.bridge.configureOutput({mode:'osc',host:'',port:0})");
      assert.equal(rejected.ok, false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "output.json"), "utf8")).port, port);
      await win.webContents.executeJavaScript(`
        document.getElementById('oscHost').value = 'ws://localhost';
        document.getElementById('oscForm').requestSubmit();
      `);
      await waitFor(win, "!document.getElementById('outputMode').disabled && !document.getElementById('outputError').hidden");
      assert.match(await win.webContents.executeJavaScript("document.getElementById('outputError').textContent"), /IP address or hostname/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "output.json"), "utf8")).host, "127.0.0.1");
      await win.webContents.executeJavaScript(`
        document.getElementById('outputMode').value = 'websocket';
        document.getElementById('outputMode').dispatchEvent(new Event('change'));
      `);
      await waitFor(win, "!document.getElementById('outputMode').disabled && !document.getElementById('websocketPanel').hidden");
      assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "output.json"), "utf8")).mode, "websocket");
      finish();
    } catch (err) { finish(err); }
  });
});

require(packaged
  ? path.join(root, "dist", "win-unpacked", "resources", "app.asar", "src", "main.js")
  : path.join(root, "src", "main.js"));
