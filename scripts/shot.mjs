#!/usr/bin/env node
// Screenshot the demo with headless Chromium.
//
//   node scripts/shot.mjs [width] [height] [output] [hash]
//
// Uses a random port per run: parallel builds in this workspace used to collide
// on one fixed port, which silently captured whichever project had bound it
// first. The server is now health-checked before Chromium navigates.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";

const width = Number(process.argv[2] || 1440);
const height = Number(process.argv[3] || 900);
const out = process.argv[4] || "docs/screenshot.png";
const hash = process.argv[5] || "";
const port = 4300 + Math.floor(Math.random() * 900);
mkdirSync("docs", { recursive: true });

const chromium = ["chromium", "chromium-browser", "google-chrome"].find((bin) =>
  spawnSync("which", [bin], { stdio: "ignore" }).status === 0);
if (!chromium) { console.error("chromium not found"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ["scripts/serve.mjs", ".", String(port)], { stdio: "ignore" });

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/demo/index.html`);
      if (res.ok) return true;
    } catch { /* starting */ }
    await sleep(100);
  }
  return false;
}

let ok = false;
try {
  if (!(await waitForServer())) { console.error("static server did not start"); process.exitCode = 1; }
  else {
    const args = [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      "--force-device-scale-factor=1", `--window-size=${width},${height}`,
      `--screenshot=${out}`, "--virtual-time-budget=6000",
      `--user-data-dir=/tmp/arvion-chrome-${process.pid}-${Date.now()}`,
      `http://127.0.0.1:${port}/demo/index.html?shot=1${hash}`,
    ];
    const code = spawnSync(chromium, args, { stdio: "inherit" }).status;
    if (code !== 0) { console.error("screenshot failed"); process.exitCode = 1; }
    else if (!existsSync(out)) { console.error("no screenshot written"); process.exitCode = 1; }
    else {
      console.log(`wrote ${out} (${statSync(out).size} bytes)`);
      ok = true;
    }
  }
} finally {
  server.kill();
}
if (!ok) process.exit(1);
