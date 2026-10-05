import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";
import { once } from "node:events";
import WebSocket from "ws";
import { fromBuffer } from "osc-min";
import { DEFAULT_OUTPUT, OutputBridge, encodeFrame, validateOutput } from "../src/output.mjs";

const event = (emitter, name) => once(emitter, name, { signal: AbortSignal.timeout(5000) });

test("OSC packet conforms to the OSC 1.0 immediate bundle wire format", () => {
  const expected = Buffer.from(
    "2362756e646c6500" + "0000000000000001" + "0000001c" +
    "2f6d6963726f6269742f76616c75652f30000000" + "2c690000" + "00000001", "hex");
  assert.deepEqual(encodeFrame([1]), expected);
});

test("custom frames retain indices, negatives, zero and fractional readings", () => {
  const decoded = fromBuffer(encodeFrame([24, null, -112, 0, 0.125, "text", NaN, Infinity, 1e100, 148]));
  assert.deepEqual(decoded.elements.map(m => [m.address, m.args[0].value]), [
    ["/microbit/value/0", 24], ["/microbit/value/2", -112],
    ["/microbit/value/3", 0], ["/microbit/value/4", 0.125],
    ["/microbit/value/9", 148]
  ]);
  assert.equal(encodeFrame([null, "text"]), null);
  assert.equal(encodeFrame(undefined), null);
});

test("invalid destinations cannot replace the selected output", async () => {
  const bridge = new OutputBridge();
  for (const invalid of [
    { mode: "other" }, { host: "" }, { host: "ws://localhost:8080" },
    { host: "999.999.999.999" }, { host: "bad..host" }, { port: 0 }, { port: 65536 },
    { port: 9000.5 }, { port: "9000" }
  ]) {
    await assert.rejects(bridge.configure({ ...DEFAULT_OUTPUT, ...invalid }));
    assert.deepEqual(bridge.settings, DEFAULT_OUTPUT);
  }
  assert.equal(validateOutput({ mode: "osc", host: " localhost ", port: 9000 }).host, "localhost");
  assert.equal(validateOutput({ mode: "osc", host: "::1", port: 9000 }).host, "::1");
});

test("live routing switches WebSocket → OSC → WebSocket and preserves return messages", async (t) => {
  const bridge = new OutputBridge(DEFAULT_OUTPUT, 0);
  const receiver = dgram.createSocket("udp4");
  t.after(async () => { await bridge.stop(); receiver.close(); });
  const listening = event(bridge, "ws-status");
  bridge.start();
  assert.equal((await listening)[0].listening, true);
  const client = new WebSocket(`ws://127.0.0.1:${bridge.wss.address().port}`);
  t.after(() => client.terminate());
  await event(client, "open");
  const frame = { raw: "24,-112,-1032,0,1,148", values: [24, -112, -1032, 0, 1, 148], t: 123 };
  const message = event(client, "message");
  bridge.sendFrame(frame);
  assert.deepEqual(JSON.parse((await message)[0].toString()), frame);
  for (const [wire, expected] of [[JSON.stringify({ tx: "5" }), "5"], ["hello", "hello"], [JSON.stringify({ value: 0 }), "0"]]) {
    const tx = event(bridge, "tx");
    client.send(wire);
    assert.equal((await tx)[0], expected);
  }
  receiver.bind(0, "127.0.0.1");
  await event(receiver, "listening");
  const closed = event(client, "close");
  await bridge.configure({ mode: "osc", host: "127.0.0.1", port: receiver.address().port });
  await closed;
  assert.equal(bridge.wss, null);
  const packet = event(receiver, "message");
  const sent = event(bridge, "osc-status");
  bridge.sendFrame(frame);
  assert.deepEqual(fromBuffer((await packet)[0]).elements.map(m => m.args[0].value), frame.values);
  assert.equal((await sent)[0].sent, 1);
  assert.equal(bridge.info().ws.listening, false);
  const restarted = event(bridge, "ws-status");
  await bridge.configure(DEFAULT_OUTPUT);
  await restarted;
  const second = new WebSocket(`ws://127.0.0.1:${bridge.wss.address().port}`);
  t.after(() => second.terminate());
  await event(second, "open");
  const again = event(second, "message");
  bridge.sendFrame(frame);
  assert.deepEqual(JSON.parse((await again)[0].toString()), frame);
  assert.equal(bridge.udp, null);
});

test("a busy WebSocket port reports failure but does not prevent selecting OSC", async (t) => {
  const occupied = net.createServer();
  occupied.listen(0, "127.0.0.1");
  await event(occupied, "listening");
  const bridge = new OutputBridge(DEFAULT_OUTPUT, occupied.address().port);
  t.after(async () => { await bridge.stop(); occupied.close(); });
  const failure = event(bridge, "ws-status");
  bridge.start();
  assert.match((await failure)[0].error, /already in use/);
  assert.equal(bridge.info().ws.listening, false);
  await bridge.configure({ ...DEFAULT_OUTPUT, mode: "osc" });
  assert.equal(bridge.info().settings.mode, "osc");
  assert.equal(bridge.info().ws.error, null);
});

test("UDP errors are reported and changing the destination recovers", async (t) => {
  const bridge = new OutputBridge({ mode: "osc", host: "does-not-exist.invalid", port: 9000 });
  const receiver = dgram.createSocket("udp4");
  t.after(async () => { await bridge.stop(); receiver.close(); });
  const failure = event(bridge, "osc-status");
  bridge.sendFrame({ values: [1] });
  assert.ok((await failure)[0].error);
  assert.equal(bridge.info().osc.sent, 0);
  receiver.bind(0, "127.0.0.1");
  await event(receiver, "listening");
  await bridge.configure({ mode: "osc", host: "127.0.0.1", port: receiver.address().port });
  const received = event(receiver, "message");
  const status = event(bridge, "osc-status");
  bridge.sendFrame({ values: [2] });
  assert.equal(fromBuffer((await received)[0]).elements[0].args[0].value, 2);
  assert.deepEqual((await status)[0], { sent: 1, error: null });
});
