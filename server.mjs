#!/usr/bin/env node
// Run the chat server: serves the demo and accepts WebSocket connections on /ws.
//
//   node server.mjs            # http://localhost:4187
//   PORT=8080 node server.mjs
//
// Try `node client.mjs` in another terminal for a ten-line terminal client.

import { createChatServer } from "./src/server.js";

const port = Number(process.env.PORT || 4187);
const host = process.env.HOST || "0.0.0.0";
const app = createChatServer({ port, host, root: import.meta.dirname });

const address = await app.listen();
console.log(`open http://localhost:${address.port}/  ·  ws://localhost:${address.port}/ws`);
console.log("press ctrl-c to stop");

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
