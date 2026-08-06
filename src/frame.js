// RFC 6455 frame codec. No dependencies: Buffer is enough.
//
// Frame layout:
//   0                   1                   2                   3
//   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//  +-+-+-+-+-------+-+-------------+-------------------------------+
//  |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
//  |I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
//  |N|V|V|V|       |S|             |   (if payload len == 126/127) |
//  +-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
//  |     Extended payload length continued, if payload len == 127  |
//  + - - - - - - - - - - - - - - - +-------------------------------+
//  |                               |Masking-key, if MASK set to 1  |
//  +-------------------------------+-------------------------------+
//  | Masking-key (continued)       |          Payload Data         |
//  +-------------------------------- - - - - - - - - - - - - - - - +

export const OPCODES = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export const CLOSE_CODES = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  NO_STATUS: 1005,
  ABNORMAL: 1006,
  INVALID_PAYLOAD: 1007,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
  MANDATORY_EXTENSION: 1010,
  INTERNAL_ERROR: 1011,
});

export class FrameError extends Error {
  constructor(message, code = CLOSE_CODES.PROTOCOL_ERROR) {
    super(message);
    this.name = "FrameError";
    this.closeCode = code;
  }
}

const CONTROL_OPCODES = new Set([OPCODES.CLOSE, OPCODES.PING, OPCODES.PONG]);

export function isControlOpcode(opcode) {
  return CONTROL_OPCODES.has(opcode);
}

export function isValidCloseCode(code) {
  if (!Number.isInteger(code)) return false;
  if (code < 1000 || code > 4999) return false;
  if (code >= 1004 && code <= 1006) return false;
  if (code >= 1015 && code <= 1016) return false;
  return true;
}

/** XOR-mask in place. WebSocket masking is symmetric, so decode == encode. */
export function applyMask(payload, maskKey) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i & 3];
  return out;
}

/**
 * Build a frame.
 * @param {object} options
 * @param {number} [options.opcode=OPCODES.TEXT]
 * @param {Buffer|string} [options.payload]
 * @param {boolean} [options.fin=true]
 * @param {boolean} [options.mask=false] client frames must be masked
 * @param {Buffer} [options.maskKey] 4 bytes; generated when omitted
 */
export function encodeFrame({ opcode = OPCODES.TEXT, payload = "", fin = true, mask = false, maskKey = null } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  if (isControlOpcode(opcode)) {
    if (!fin) throw new FrameError("control frames cannot be fragmented");
    if (data.length > 125) throw new FrameError("control frame payload must be <= 125 bytes");
  }
  if (!Number.isInteger(opcode) || ![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) {
    throw new FrameError(`unknown opcode ${opcode}`);
  }

  const header = [];
  header.push((fin ? 0x80 : 0x00) | opcode);
  const length = data.length;
  let lengthByte = mask ? 0x80 : 0x00;
  if (length <= 125) {
    header.push(lengthByte | length);
  } else if (length <= 0xffff) {
    header.push(lengthByte | 126);
    header.push((length >> 8) & 0xff, length & 0xff);
  } else {
    header.push(lengthByte | 127);
    const big = BigInt(length);
    for (let shift = 56n; shift >= 0n; shift -= 8n) header.push(Number((big >> shift) & 0xffn));
  }

  if (!mask) return Buffer.concat([Buffer.from(header), data]);

  const key = maskKey ?? Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  if (key.length !== 4) throw new FrameError("mask key must be 4 bytes");
  return Buffer.concat([Buffer.from(header), key, applyMask(data, key)]);
}

/**
 * Decode one frame from the front of `buffer`.
 * Returns `{ frame, rest }`, or `null` when the buffer does not contain a full
 * frame yet (the caller keeps reading). Throws FrameError on protocol violations.
 */
export function decodeFrame(buffer, { requireMask = true, maxPayload = 1 << 20 } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("decodeFrame needs a Buffer");
  if (buffer.length < 2) return null;

  const b0 = buffer[0];
  const b1 = buffer[1];
  const fin = (b0 & 0x80) !== 0;
  const rsv = (b0 & 0x70) >> 4;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let length = b1 & 0x7f;
  let offset = 2;

  if (rsv !== 0) throw new FrameError("RSV bits must be zero (no extensions negotiated)");
  if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) throw new FrameError(`unknown opcode ${opcode}`);
  if (requireMask && !masked) throw new FrameError("client frames must be masked", CLOSE_CODES.PROTOCOL_ERROR);
  if (!requireMask && masked) throw new FrameError("server frames must not be masked", CLOSE_CODES.PROTOCOL_ERROR);

  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new FrameError("payload length exceeds safe integer", CLOSE_CODES.MESSAGE_TOO_BIG);
    length = Number(big);
    offset = 10;
  }

  if (length > maxPayload) throw new FrameError(`payload exceeds ${maxPayload} bytes`, CLOSE_CODES.MESSAGE_TOO_BIG);
  if (isControlOpcode(opcode)) {
    if (!fin) throw new FrameError("control frames cannot be fragmented");
    if (length > 125) throw new FrameError("control frame payload must be <= 125 bytes");
  }

  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;

  let payload = buffer.subarray(offset, offset + length);
  if (maskKey) payload = applyMask(payload, maskKey);

  return {
    frame: { fin, opcode, masked, payload: Buffer.from(payload) },
    rest: buffer.subarray(offset + length),
  };
}

export function encodeText(text, options = {}) {
  return encodeFrame({ opcode: OPCODES.TEXT, payload: text, ...options });
}

export function encodePong(payload = Buffer.alloc(0), options = {}) {
  return encodeFrame({ opcode: OPCODES.PONG, payload, ...options });
}

export function encodePing(payload = Buffer.alloc(0), options = {}) {
  return encodeFrame({ opcode: OPCODES.PING, payload, ...options });
}

export function encodeClose(code = CLOSE_CODES.NORMAL, reason = "", options = {}) {
  if (!isValidCloseCode(code)) throw new FrameError(`invalid close code ${code}`);
  const reasonBytes = Buffer.from(reason, "utf8");
  if (reasonBytes.length > 123) throw new FrameError("close reason must be <= 123 bytes");
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return encodeFrame({ opcode: OPCODES.CLOSE, payload, ...options });
}

export function parseClosePayload(payload) {
  if (!payload || payload.length === 0) return { code: CLOSE_CODES.NO_STATUS, reason: "" };
  if (payload.length === 1) throw new FrameError("close payload with a status code must be at least 2 bytes");
  const code = payload.readUInt16BE(0);
  if (!isValidCloseCode(code)) throw new FrameError(`invalid close code ${code}`);
  const reason = payload.subarray(2).toString("utf8");
  return { code, reason };
}

/**
 * Reassembles fragmented data frames and enforces the interleaving rules:
 * control frames may appear between fragments and are dispatched immediately.
 */
export class FrameAssembler {
  constructor({ maxMessageBytes = 1 << 20 } = {}) {
    this.maxMessageBytes = maxMessageBytes;
    this.opcode = null;
    this.chunks = [];
    this.size = 0;
  }

  push(frame) {
    if (frame.opcode === OPCODES.PING || frame.opcode === OPCODES.PONG) {
      return { control: frame };
    }
    if (frame.opcode === OPCODES.CLOSE) return { control: frame };

    if (frame.opcode === OPCODES.CONTINUATION) {
      if (this.opcode === null) throw new FrameError("continuation without a start frame");
    } else {
      if (this.opcode !== null) throw new FrameError("new data frame while a fragmented message is open");
      this.opcode = frame.opcode;
    }

    this.chunks.push(frame.payload);
    this.size += frame.payload.length;
    if (this.size > this.maxMessageBytes) throw new FrameError("fragmented message too large", CLOSE_CODES.MESSAGE_TOO_BIG);
    if (!frame.fin) return null;

    const message = {
      opcode: this.opcode,
      payload: Buffer.concat(this.chunks, this.size),
      fragmented: this.chunks.length > 1,
    };
    this.opcode = null;
    this.chunks = [];
    this.size = 0;
    return { message };
  }
}
