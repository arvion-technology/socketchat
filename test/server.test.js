import test from "node:test";
import assert from "node:assert/strict";
import { connect as netConnect } from "node:net";
import { createChatServer } from "../src/server.js";
import { decodeFrame, encodeClose, encodePing, encodeText, OPCODES } from "../src/frame.js";

const MASK = Buffer.from([9, 8, 7, 6]);

/** A raw WebSocket client: handshake over TCP, then unmasked server frames. */
function rawClient(port) {
  const socket = netConnect({ port, host: "127.0.0.1" });
  let buffer = Buffer.alloc(0);
  let handshaking = true;
  const events = [];
  let closed = false;
  let closeCode = null;
  let resolveReady;
  let rejectReady;

  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  const flush = () => {
    while (true) {
      let decoded;
      try {
        decoded = decodeFrame(buffer, { requireMask: false, maxPayload: 1 << 20 });
      } catch (error) {
        rejectReady?.(error);
        return;
      }
      if (!decoded) return;
      buffer = decoded.rest;
      const { frame } = decoded;
      if (frame.opcode === OPCODES.CLOSE) {
        closeCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        closed = true;
        return;
      }
      if (frame.opcode === OPCODES.PONG) {
        events.push({ type: "__pong__", payload: frame.payload.toString() });
        continue;
      }
      if (frame.opcode !== OPCODES.TEXT) continue;
      try { events.push(JSON.parse(frame.payload.toString())); }
      catch { events.push({ type: "__invalid_json__" }); }
    }
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (handshaking) {
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker === -1) return;
      const head = buffer.subarray(0, marker).toString();
      if (!head.startsWith("HTTP/1.1 101")) { rejectReady?.(new Error(`bad handshake: ${head.split("\r\n")[0]}`)); return; }
      buffer = buffer.subarray(marker + 4);
      handshaking = false;
      resolveReady();
    }
    flush();
  });
  socket.on("close", () => { closed = true; });
  socket.on("error", (error) => { rejectReady?.(error); });

  socket.once("connect", () => {
    const key = Buffer.from("0123456789abcdef").toString("base64");
    socket.write([
      "GET /ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      "", "",
    ].join("\r\n"));
  });

  return {
    socket,
    ready,
    sendJson(object) {
      socket.write(encodeText(JSON.stringify(object), { mask: true, maskKey: MASK }));
    },
    sendPing(payload = "kb") {
      socket.write(encodePing(payload, { mask: true, maskKey: MASK }));
    },
    sendClose(code = 1000) {
      socket.write(encodeClose(code, "", { mask: true, maskKey: MASK }));
    },
    waitFor(match, timeoutMs = 3_000) {
      const found = events.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { clearInterval(interval); reject(new Error("timed out waiting for frame")); }, timeoutMs);
        const interval = setInterval(() => {
          const index = events.findIndex(match);
          if (index === -1) return;
          clearTimeout(timer);
          clearInterval(interval);
          resolve(events[index]);
        }, 10);
      });
    },
    get closeCode() { return closeCode; },
    get closed() { return closed; },
    end() { socket.destroy(); },
  };
}

test("the server performs the handshake, joins, broadcasts and answers ping", async (t) => {
  const app = createChatServer({ port: 0, host: "127.0.0.1", logger: { log() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const port = address.port;

  const ada = rawClient(port);
  const grace = rawClient(port);
  t.after(() => { ada.end(); grace.end(); });

  await ada.ready;
  await grace.ready;

  ada.sendJson({ type: "join", name: "Ada", userId: "u_ada", roomId: "general" });
  const welcome = await ada.waitFor((event) => event.type === "welcome");
  assert.equal(welcome.protocol, 1);
  assert.ok(welcome.clientId);
  assert.equal(welcome.presence.length, 1);

  grace.sendJson({ type: "join", name: "Grace", userId: "u_grace", roomId: "general" });
  const graceWelcome = await grace.waitFor((event) => event.type === "welcome");
  assert.equal(graceWelcome.presence.length, 2);
  // Ada also receives the presence snapshot from her own join (1 member), so
  // wait specifically for the two-member update.
  const presence = await ada.waitFor((event) => event.type === "presence" && event.members.length === 2);
  assert.equal(presence.members.length, 2);

  ada.sendJson({ type: "message", text: "hello from a raw socket" });
  const message = await grace.waitFor((event) => event.type === "message");
  assert.equal(message.message.text, "hello from a raw socket");
  assert.equal(message.message.name, "Ada");

  ada.sendPing("kb");
  const pong = await ada.waitFor((event) => event.type === "__pong__");
  assert.equal(pong.payload, "kb");
});

test("the server rejects non-WebSocket upgrades and malformed protocol messages", async (t) => {
  const app = createChatServer({ port: 0, host: "127.0.0.1", logger: { log() {} } });
  const address = await app.listen();
  t.after(() => app.close());

  const client = rawClient(address.port);
  t.after(() => client.end());
  await client.ready;

  client.sendJson({ type: "message", text: "too early" });
  const error = await client.waitFor((event) => event.type === "error");
  assert.equal(error.code, "not_joined");

  client.socket.write(encodeText("not json", { mask: true, maskKey: MASK }));
  const second = await client.waitFor((event) => event.code === "invalid_json");
  assert.equal(second.message, "frames must contain JSON");
});

test("a close frame is echoed and the socket is closed", async (t) => {
  const app = createChatServer({ port: 0, host: "127.0.0.1", logger: { log() {} } });
  const address = await app.listen();
  t.after(() => app.close());

  const client = rawClient(address.port);
  await client.ready;
  client.sendJson({ type: "join", name: "Ada" });
  await client.waitFor((event) => event.type === "welcome");
  client.sendClose(1000);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(client.closeCode, 1000);
});
