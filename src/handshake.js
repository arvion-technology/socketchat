// RFC 6455 opening handshake helpers. The server module (src/server.js) uses
// node:crypto; the browser demo never imports this file.

import { createHash } from "node:crypto";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const SUPPORTED_VERSION = "13";

/** Sec-WebSocket-Accept = base64(SHA1(key + GUID)). */
export function acceptKey(clientKey) {
  if (typeof clientKey !== "string" || !clientKey.trim()) {
    throw new HandshakeError("missing Sec-WebSocket-Key");
  }
  return createHash("sha1").update(clientKey.trim() + WS_GUID).digest("base64");
}

export class HandshakeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "HandshakeError";
    this.status = status;
  }
}

export function isWebSocketUpgrade(req) {
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  const connection = String(req.headers.connection ?? "").toLowerCase();
  return upgrade === "websocket" && connection.split(",").map((part) => part.trim()).includes("upgrade");
}

/**
 * Validate the request headers we require. Subprotocols and extensions are
 * deliberately not negotiated; the codec only implements what it implements.
 */
export function validateUpgrade(req, { path = "/ws" } = {}) {
  if (req.method !== "GET") throw new HandshakeError("WebSocket upgrade must be a GET", 405);
  if (!isWebSocketUpgrade(req)) throw new HandshakeError("not a WebSocket upgrade", 426);
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== path) throw new HandshakeError(`unknown WebSocket path ${url.pathname}`, 404);
  const version = req.headers["sec-websocket-version"];
  if (String(version) !== SUPPORTED_VERSION) throw new HandshakeError("unsupported WebSocket version", 426);
  const key = req.headers["sec-websocket-key"];
  if (!key) throw new HandshakeError("missing Sec-WebSocket-Key");
  // A 16-byte value, base64 encoded, is 24 characters including padding.
  const decoded = Buffer.from(String(key), "base64");
  if (decoded.length !== 16) throw new HandshakeError("Sec-WebSocket-Key must decode to 16 bytes");
  if (req.headers["sec-websocket-extensions"]) {
    // No extensions are negotiated. Ignoring them is allowed; claiming support
    // without implementing permessage-deflate would be worse.
  }
  return {
    key: String(key),
    version: String(version),
    origin: req.headers.origin ?? null,
    path: url.pathname,
  };
}

export function handshakeResponse(clientKey) {
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(clientKey)}`,
    "",
    "",
  ].join("\r\n");
}

/** Parse the HTTP head from a raw socket buffer; returns null until it is complete. */
export function parseRequestHead(buffer, { maxBytes = 16_384 } = {}) {
  const marker = buffer.indexOf("\r\n\r\n");
  if (marker === -1) {
    if (buffer.length > maxBytes) throw new HandshakeError("request head too large", 431);
    return null;
  }
  const head = buffer.subarray(0, marker).toString("utf8");
  const rest = buffer.subarray(marker + 4);
  const lines = head.split("\r\n");
  const [method, target, version] = lines[0].split(" ");
  const headers = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return { method, target, version, headers, rest, raw: head };
}
