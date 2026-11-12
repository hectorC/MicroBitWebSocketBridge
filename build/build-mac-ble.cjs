const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
let built = false;

module.exports = function buildMacBLE(context) {
  if (context.electronPlatformName !== "darwin" || built) return;
  const generated = path.join(__dirname, "generated");
  const binary = path.join(generated, "microbit-ble");
  const source = path.join(__dirname, "mac-ble.swift");
  const info = path.join(__dirname, "mac-ble-info.plist");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "microbit-ble-"));
  const xcrun = (...args) => execFileSync("xcrun", args, { stdio: "inherit" });
  try {
    const slices = ["arm64", "x86_64"].map((arch) => {
      const slice = path.join(temp, arch);
      xcrun("swiftc", "-swift-version", "5", "-O", "-target", `${arch}-apple-macos12.0`, source,
        "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", info,
        "-o", slice);
      return slice;
    });
    fs.mkdirSync(generated, { recursive: true });
    xcrun("lipo", "-create", ...slices, "-output", binary);
    xcrun("lipo", binary, "-verify_arch", "arm64", "x86_64");
    execFileSync("codesign", ["--force", "--sign", "-", "--identifier", "gl.cables.microbit.bridge.ble", binary], { stdio: "inherit" });
    const result = execFileSync(binary, [], { input: '{"id":1,"op":"ping"}\n', encoding: "utf8", timeout: 5000 });
    if (JSON.parse(result).result?.backend !== "Core Bluetooth") throw new Error("Bluetooth helper did not respond to its build check.");
    built = true;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
};
