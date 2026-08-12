import test from "node:test";
import assert from "node:assert/strict";
import {
  OPCODES, FrameError, FrameAssembler, applyMask, decodeFrame, encodeClose,
  encodeFrame, encodePing, encodePong, encodeText, parseClosePayload, isValidCloseCode,
} from "../src/frame.js";

const hex = (buffer) => buffer.toString("hex");

test("unmasked text frame matches the RFC layout", () => {
  const frame = encodeText("Hello");
  assert.equal(hex(frame), "810548656c6c6f");
  const decoded = decodeFrame(frame, { requireMask: false });
  assert.equal(decoded.frame.opcode, OPCODES.TEXT);
  assert.equal(decoded.frame.payload.toString(), "Hello");
  assert.equal(decoded.rest.length, 0);
});

test("the RFC 6455 masked example decodes to Hello", () => {
  const wire = Buffer.from("818537fa213d7f9f4d5158", "hex");
  const { frame } = decodeFrame(wire);
  assert.equal(frame.fin, true);
  assert.equal(frame.opcode, OPCODES.TEXT);
  assert.equal(frame.payload.toString(), "Hello");
  const reencoded = encodeFrame({ payload: "Hello", mask: true, maskKey: Buffer.from("37fa213d", "hex") });
  assert.equal(hex(reencoded), "818537fa213d7f9f4d5158");
});

test("masking is symmetric", () => {
  const payload = Buffer.from("mask me twice");
  const key = Buffer.from([1, 2, 3, 4]);
  assert.deepEqual(applyMask(applyMask(payload, key), key), payload);
});

test("ping, pong and close frames are encoded as control frames", () => {
  assert.equal(hex(encodePing("hi")), "89026869");
  assert.equal(hex(encodePong("hi")), "8a026869");
  assert.equal(hex(encodeClose(1000)), "880203e8");
  const close = decodeFrame(encodeClose(1001, "going away"), { requireMask: false });
  assert.equal(close.frame.opcode, OPCODES.CLOSE);
  assert.deepEqual(parseClosePayload(close.frame.payload), { code: 1001, reason: "going away" });
});

test("16-bit and 64-bit payload lengths round-trip", () => {
  const medium = Buffer.alloc(300, 0x61);
  const mediumFrame = encodeText(medium);
  assert.equal(mediumFrame[1] & 0x7f, 126);
  assert.equal(decodeFrame(mediumFrame, { requireMask: false }).frame.payload.length, 300);

  const large = Buffer.alloc(70_000, 0x62);
  const largeFrame = encodeText(large);
  assert.equal(largeFrame[1] & 0x7f, 127);
  assert.equal(decodeFrame(largeFrame, { requireMask: false }).frame.payload.length, 70_000);
});

test("a partial frame returns null instead of guessing", () => {
  const frame = encodeText("hello world");
  assert.equal(decodeFrame(frame.subarray(0, 1), { requireMask: false }), null);
  assert.equal(decodeFrame(frame.subarray(0, 5), { requireMask: false }), null);
  assert.equal(decodeFrame(frame.subarray(0, 8), { requireMask: false }), null);
});

test("protocol violations are rejected", () => {
  // Unmasked client frame.
  assert.throws(() => decodeFrame(encodeText("x"), { requireMask: true }), FrameError);
  // RSV1 set.
  const rsv = encodeText("x");
  rsv[0] |= 0x40;
  assert.throws(() => decodeFrame(rsv, { requireMask: false }), /RSV/);
  // Unknown opcode.
  const bad = encodeText("x");
  bad[0] = (bad[0] & 0xf0) | 0x3;
  assert.throws(() => decodeFrame(bad, { requireMask: false }), /opcode/);
  // Fragmented control frame.
  assert.throws(() => encodeFrame({ opcode: OPCODES.PING, fin: false }), /fragmented/);
  // Oversized control frame.
  assert.throws(() => encodePing(Buffer.alloc(126)), /125/);
  // Oversized data frame relative to the configured limit.
  assert.throws(() => decodeFrame(encodeText(Buffer.alloc(200)), { requireMask: false, maxPayload: 100 }), /exceeds/);
});

test("close payloads and codes are validated", () => {
  assert.equal(parseClosePayload(Buffer.alloc(0)).code, 1005);
  assert.throws(() => parseClosePayload(Buffer.from([0x03])), /at least 2/);
  assert.throws(() => parseClosePayload(Buffer.from([0x03, 0xed])), /invalid close code/); // 1005 on the wire
  assert.throws(() => encodeClose(1005), /invalid close code/);
  assert.throws(() => encodeClose(9000), /invalid close code/);
  assert.equal(isValidCloseCode(1000), true);
  assert.equal(isValidCloseCode(3000), true);
  assert.equal(isValidCloseCode(999), false);
});

test("fragmentation reassembles in order and allows interleaved control frames", () => {
  const assembler = new FrameAssembler();
  assert.equal(assembler.push({ fin: false, opcode: OPCODES.TEXT, payload: Buffer.from("Hel") }), null);
  const control = assembler.push({ fin: true, opcode: OPCODES.PING, payload: Buffer.alloc(0) });
  assert.equal(control.control.opcode, OPCODES.PING);
  assert.equal(assembler.push({ fin: false, opcode: OPCODES.CONTINUATION, payload: Buffer.from("lo ") }), null);
  const final = assembler.push({ fin: true, opcode: OPCODES.CONTINUATION, payload: Buffer.from("world") });
  assert.equal(final.message.payload.toString(), "Hello world");
  assert.equal(final.message.fragmented, true);
  assert.equal(final.message.opcode, OPCODES.TEXT);

  assert.throws(() => new FrameAssembler().push({ fin: true, opcode: OPCODES.CONTINUATION, payload: Buffer.alloc(0) }), /without a start/);
  const open = new FrameAssembler();
  open.push({ fin: false, opcode: OPCODES.TEXT, payload: Buffer.from("a") });
  assert.throws(() => open.push({ fin: true, opcode: OPCODES.TEXT, payload: Buffer.from("b") }), /while a fragmented/);
});
