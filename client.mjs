#!/usr/bin/env node
// A terminal chat client — and a second proof that the socket layer works
// without a browser or any dependency.
//
//   node server.mjs
//   node client.mjs "Ada" general
//
// Type a message and press enter. Ctrl-D leaves the room.

import { connect } from "node:net";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import {
  FrameAssembler, OPCODES, decodeFrame, encodeFrame, encodePong, encodeText,
} from "./src/frame.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4187);
const name = process.argv[2] || "Terminal";
const roomId = process.argv[3] || "general";

const socket = connect({ port, host }, () => {
  const key = randomBytes(16).toString("base64");
  socket.write([
    "GET /ws HTTP/1.1",
    `Host: ${host}:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Version: 13`,
    `Sec-WebSocket-Key: ${key}`,
    "", "",
  ].join("\r\n"));
});

let handshakeDone = false;
let buffer = Buffer.alloc(0);
const assembler = new FrameAssembler();

socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!handshakeDone) {
    const marker = buffer.indexOf("\r\n\r\n");
    if (marker === -1) return;
    const head = buffer.subarray(0, marker).toString();
    buffer = buffer.subarray(marker + 4);
    if (!head.startsWith("HTTP/1.1 101")) {
      console.error(`handshake failed:\n${head}`);
      process.exit(1);
    }
    handshakeDone = true;
    send({ type: "join", name, roomId });
    console.log(`connected as ${name} in #${roomId} — type a message, ctrl-d to leave`);
    prompt();
  }
  for (;;) {
    let decoded;
    try { decoded = decodeFrame(buffer, { requireMask: false }); }
    catch (error) { console.error("frame error:", error.message); process.exit(1); }
    if (!decoded) break;
    buffer = decoded.rest;
    handleFrame(decoded.frame);
  }
});

function handleFrame(frame) {
  if (frame.opcode === OPCODES.PING) {
    socket.write(encodePong(frame.payload, { mask: true, maskKey: randomBytes(4) }));
    return;
  }
  if (frame.opcode === OPCODES.CLOSE) {
    console.log("\nserver closed the connection");
    socket.end();
    process.exit(0);
  }
  if (frame.opcode !== OPCODES.TEXT) return;
  const assembled = assembler.push(frame);
  if (!assembled?.message) return;
  const event = JSON.parse(assembled.message.payload.toString());
  render(event);
}

function render(event) {
  switch (event.type) {
    case "welcome":
      console.log(`history: ${event.history.length} message(s), ${event.presence.length} member(s)`);
      for (const line of event.history.slice(-6)) console.log(`  ${line.name}: ${line.text}`);
      break;
    case "message":
      if (event.message.name !== name) process.stdout.write(`\r${event.message.name}: ${event.message.text}\n`);
      break;
    case "presence":
      console.log(`— room has ${event.members.length} member(s): ${event.members.map((member) => member.name).join(", ")}`);
      break;
    case "typing":
      if (event.name !== name && event.typing) process.stdout.write(`\r${event.name} is typing…\n`);
      break;
    case "error":
      console.error(`error (${event.code}): ${event.message}`);
      break;
    default:
      break;
  }
  prompt();
}

function send(object) {
  const payload = encodeText(JSON.stringify(object), { mask: true, maskKey: randomBytes(4) });
  socket.write(payload);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
let prompting = false;
function prompt() {
  if (prompting) return;
  prompting = true;
  process.stdout.write("> ");
  prompting = false;
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  send({ type: "message", text: line });
});

rl.on("close", () => {
  send({ type: "leave" });
  socket.end();
  process.exit(0);
});

socket.on("error", (error) => { console.error(error.message); process.exit(1); });
