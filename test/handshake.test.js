import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptKey, handshakeResponse, isWebSocketUpgrade, parseRequestHead, validateUpgrade, HandshakeError,
} from "../src/handshake.js";

test("the RFC 6455 sample key produces the documented accept hash", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  assert.throws(() => acceptKey(""), HandshakeError);
});

function fakeRequest(headers, { url = "/ws", method = "GET" } = {}) {
  return {
    method,
    url,
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...headers,
    },
  };
}

test("upgrade detection is case-insensitive and handles header lists", () => {
  assert.equal(isWebSocketUpgrade(fakeRequest()), true);
  assert.equal(isWebSocketUpgrade(fakeRequest({ connection: "keep-alive, Upgrade", upgrade: "WebSocket" })), true);
  assert.equal(isWebSocketUpgrade(fakeRequest({ upgrade: "h2c" })), false);
  assert.equal(isWebSocketUpgrade({ headers: {} }), false);
});

test("validateUpgrade accepts a well-formed request", () => {
  const parsed = validateUpgrade(fakeRequest());
  assert.equal(parsed.version, "13");
  assert.equal(parsed.path, "/ws");
  assert.equal(parsed.origin, null);
});

test("validateUpgrade rejects bad versions, paths, methods and keys", () => {
  assert.throws(() => validateUpgrade(fakeRequest({ "sec-websocket-version": "8" })), /version/);
  assert.throws(() => validateUpgrade(fakeRequest({}, { url: "/chat" })), /path/);
  assert.throws(() => validateUpgrade(fakeRequest({}, { method: "POST" })), /GET/);
  assert.throws(() => validateUpgrade(fakeRequest({ "sec-websocket-key": "" })), /Key/);
  assert.throws(() => validateUpgrade(fakeRequest({ "sec-websocket-key": "c2hvcnQ=" })), /16 bytes/);
  assert.throws(() => validateUpgrade(fakeRequest({ upgrade: "h2c" })), /not a WebSocket/);
});

test("the response has the exact 101 headers a browser expects", () => {
  const response = handshakeResponse("dGhlIHNhbXBsZSBub25jZQ==");
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(response, /Upgrade: websocket\r\n/);
  assert.match(response, /Connection: Upgrade\r\n/);
  assert.match(response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n\r\n$/);
});

test("parseRequestHead waits for the full head and splits headers", () => {
  assert.equal(parseRequestHead(Buffer.from("GET /ws HTTP/1.1\r\nHost: x")), null);
  const raw = Buffer.from(
    "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n" +
    "extra-bytes",
  );
  const parsed = parseRequestHead(raw);
  assert.equal(parsed.method, "GET");
  assert.equal(parsed.target, "/ws");
  assert.equal(parsed.headers["sec-websocket-key"], "dGhlIHNhbXBsZSBub25jZQ==");
  assert.equal(parsed.rest.toString(), "extra-bytes");
});
