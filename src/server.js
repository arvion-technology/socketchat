// RFC 6455 WebSocket server on node:http, plus the static demo host.
//
// Everything below the HTTP server is hand-rolled on purpose: the point of the
// project is the framing layer, so there is no `ws` dependency to hide it.

import { createServer as createHttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ChatHub } from "./hub.js";
import {
  FrameAssembler, FrameError, OPCODES, decodeFrame, encodeClose, encodeFrame, encodePong,
  parseClosePayload, CLOSE_CODES, OPEN, CLOSING, CLOSED,
} from "./frame.js";
import { handshakeResponse, isWebSocketUpgrade, validateUpgrade } from "./handshake.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

export function createChatServer({
  port = 4187,
  host = "0.0.0.0",
  root = process.cwd(),
  hub = new ChatHub(),
  heartbeatMs = 30_000,
  logger = console,
} = {}) {
  const sockets = new Map(); // clientId -> connection
  let heartbeat = null;

  const server = createHttpServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...hub.snapshot(), uptime: process.uptime() }));
      return;
    }
    if (isWebSocketUpgrade(req)) {
      // Upgrades are handled by the 'upgrade' event; answering with HTTP here
      // would desynchronise the client.
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("expected a WebSocket upgrade on /ws");
      return;
    }
    try {
      const url = new URL(req.url, "http://localhost");
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      if (path === "/" || path === "") path = "/demo/index.html";
      if (path.endsWith("/")) path += "index.html";
      const file = join(root, path);
      if (!file.startsWith(resolve(root))) throw Object.assign(new Error("forbidden"), { code: "EACCES" });
      const info = await stat(file);
      if (info.isDirectory()) {
        res.writeHead(302, { Location: url.pathname + "/index.html" });
        res.end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(body);
    } catch (error) {
      res.writeHead(error.code === "EACCES" ? 403 : 404, { "Content-Type": "text/plain" });
      res.end(error.code === "EACCES" ? "Forbidden" : "Not found");
    }
  });

  function send(clientId, event) {
    const connection = sockets.get(clientId);
    if (!connection || connection.state !== OPEN) return;
    try {
      connection.socket.write(encodeFrame({ opcode: OPCODES.TEXT, payload: JSON.stringify(event) }));
    } catch {
      connection.destroy();
    }
  }

  function broadcast(event, roomId) {
    for (const [clientId, connection] of sockets) {
      if (connection.state !== OPEN) continue;
      const client = hub.clients.get(clientId);
      if (roomId && client?.roomId !== roomId) continue;
      send(clientId, event);
    }
  }

  function route(result) {
    for (const event of result.direct) send(result.clientId, event);
    for (const event of result.broadcast) {
      const roomId = event.roomId ?? event.message?.roomId ?? null;
      broadcast(event, roomId);
    }
  }

  function handleProtocolMessage(connection, text) {
    let incoming;
    try {
      incoming = JSON.parse(text);
    } catch {
      send(connection.id, { type: "error", code: "invalid_json", message: "frames must contain JSON" });
      return;
    }
    if (!connection.joined && incoming.type !== "join") {
      send(connection.id, { type: "error", code: "not_joined", message: "send a join message first" });
      return;
    }
    const result = hub.dispatch(connection.id, incoming);
    result.clientId = connection.id;
    if (incoming.type === "join" && result.direct.some((event) => event.type === "welcome")) {
      connection.joined = true;
    }
    route(result);
    if (incoming.type === "leave") connection.destroy();
  }

  function handleFrame(connection, frame) {
    if (frame.opcode === OPCODES.CLOSE) {
      let parsed = { code: CLOSE_CODES.NO_STATUS, reason: "" };
      try { parsed = parseClosePayload(frame.payload); } catch { /* invalid close payload */ }
      connection.state = CLOSING;
      connection.socket.write(encodeClose(
        parsed.code === CLOSE_CODES.NO_STATUS ? CLOSE_CODES.NORMAL : parsed.code, "", { mask: false },
      ));
      connection.socket.end();
      connection.state = CLOSED;
      return;
    }
    if (frame.opcode === OPCODES.PING) {
      connection.lastSeen = Date.now();
      connection.socket.write(encodePong(frame.payload, { mask: false }));
      return;
    }
    if (frame.opcode === OPCODES.PONG) {
      connection.lastSeen = Date.now();
      connection.awaitingPong = false;
      return;
    }
    const assembled = connection.assembler.push(frame);
    if (!assembled || !assembled.message) return;
    const { message } = assembled;
    const text = message.payload.toString("utf8");
    if (message.opcode === OPCODES.TEXT) handleProtocolMessage(connection, text);
    else if (message.opcode === OPCODES.BINARY) {
      send(connection.id, { type: "error", code: "unsupported_binary", message: "this chat is text-only" });
    }
  }

  function acceptUpgrade(req, socket, head) {
    let handshake;
    try {
      handshake = validateUpgrade(req, { path: "/ws" });
    } catch (error) {
      socket.write(`HTTP/1.1 ${error.status ?? 400} Bad Request\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    socket.write(handshakeResponse(handshake.key));

    const connection = {
      id: `client_${randomUUID().slice(0, 8)}`,
      socket,
      state: OPEN,
      buffer: head?.length ? Buffer.from(head) : Buffer.alloc(0),
      assembler: new FrameAssembler({ maxMessageBytes: 64 * 1024 }),
      joined: false,
      lastSeen: Date.now(),
      awaitingPong: false,
      destroy() {
        this.state = CLOSED;
        try { socket.destroy(); } catch { /* already gone */ }
        if (this.joined) {
          const result = hub.leave(this.id, { reason: "disconnected" });
          result.clientId = this.id;
          route(result);
        }
        sockets.delete(this.id);
      },
    };
    sockets.set(connection.id, connection);

    const pump = () => {
      while (connection.state === OPEN) {
        let decoded;
        try {
          decoded = decodeFrame(connection.buffer, { requireMask: true, maxPayload: 64 * 1024 });
        } catch (error) {
          if (error instanceof FrameError) {
            try {
              socket.write(encodeClose(error.closeCode ?? CLOSE_CODES.PROTOCOL_ERROR, error.message.slice(0, 100), { mask: false }));
            } catch { /* ignore */ }
            connection.destroy();
            return;
          }
          throw error;
        }
        if (!decoded) return;
        connection.buffer = decoded.rest;
        try {
          handleFrame(connection, decoded.frame);
        } catch (error) {
          if (error instanceof FrameError) {
            socket.write(encodeClose(error.closeCode, error.message.slice(0, 100), { mask: false }));
            connection.destroy();
            return;
          }
          logger.error?.("socketchat frame handler failed", error);
          socket.write(encodeClose(CLOSE_CODES.INTERNAL_ERROR, "internal error", { mask: false }));
          connection.destroy();
          return;
        }
      }
    };

    socket.on("data", (chunk) => {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      pump();
    });
    socket.on("close", () => connection.destroy());
    socket.on("error", () => connection.destroy());
    pump();
  }

  server.on("upgrade", (req, socket, head) => {
    if (!isWebSocketUpgrade(req)) {
      socket.destroy();
      return;
    }
    acceptUpgrade(req, socket, head);
  });

  function startHeartbeat() {
    if (!heartbeatMs || heartbeat) return;
    heartbeat = setInterval(() => {
      const now = Date.now();
      for (const connection of sockets.values()) {
        if (connection.state !== OPEN) continue;
        if (connection.awaitingPong && now - connection.lastSeen > heartbeatMs * 2) {
          connection.destroy();
          continue;
        }
        connection.awaitingPong = true;
        connection.lastSeen = now;
        try { connection.socket.write(encodeFrame({ opcode: OPCODES.PING, payload: "", mask: false })); }
        catch { connection.destroy(); }
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  return {
    server,
    hub,
    sockets,
    listen() {
      return new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          startHeartbeat();
          const address = server.address();
          logger.log?.(`socketchat listening on http://${host}:${address.port}  (ws://${host}:${address.port}/ws)`);
          resolvePromise(address);
        });
      });
    },
    close() {
      if (heartbeat) clearInterval(heartbeat);
      for (const connection of sockets.values()) connection.destroy();
      return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}
