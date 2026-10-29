// Room hub: presence, typing, history and message validation.
//
// Deliberately transport-free. The WebSocket server feeds parsed protocol
// messages in and broadcasts the returned events; the browser demo calls the
// exact same methods for its simulated peers. That is what keeps the demo honest
//, there is no second, simplified chat implementation in demo/app.js.

export const PROTOCOL_VERSION = 1;

export const LIMITS = Object.freeze({
  maxMessageLength: 2_000,
  maxNameLength: 32,
  maxHistoryPerRoom: 500,
  historyPageSize: 50,
  rateLimit: Object.freeze({ messages: 6, windowMs: 10_000 }),
});

export const DEFAULT_ROOMS = Object.freeze([
  { id: "general", name: "General", topic: "Anything that does not fit elsewhere" },
  { id: "engineering", name: "Engineering", topic: "Deploys, incidents, queue depth" },
  { id: "design", name: "Design", topic: "Critique, tokens, screenshots" },
]);

export class ChatError extends Error {
  constructor(message, code = "bad_request") {
    super(message);
    this.name = "ChatError";
    this.code = code;
  }
}

const COLORS = ["#f5c26b", "#3a7bff", "#34d399", "#a78bfa", "#f87171", "#fbbf24", "#22d3ee"];

export function createCounterIds(prefix = "msg") {
  let n = 0;
  return () => `${prefix}_${(++n).toString(36)}`;
}

export class ChatHub {
  constructor({
    rooms = DEFAULT_ROOMS,
    historyLimit = LIMITS.maxHistoryPerRoom,
    rateLimit = LIMITS.rateLimit,
    clock = () => Date.now(),
    idFactory = createCounterIds(),
    moderate = () => null,
    maxMessageLength = LIMITS.maxMessageLength,
  } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.moderate = moderate;
    this.historyLimit = historyLimit;
    this.rateLimit = rateLimit;
    this.maxMessageLength = maxMessageLength;
    this.rooms = new Map();
    this.clients = new Map();
    this.messages = [];
    this.stats = { joins: 0, messages: 0, edits: 0, deletes: 0, rejected: 0, rateLimited: 0 };
    for (const room of rooms) this.addRoom(room);
  }

  addRoom({ id, name, topic = "" }) {
    if (!id || typeof id !== "string") throw new ChatError("room id is required");
    if (this.rooms.has(id)) throw new ChatError(`room ${id} already exists`, "conflict");
    const room = { id, name: name || id, topic, createdAt: this.clock() };
    this.rooms.set(id, room);
    return room;
  }

  roomsList() {
    return [...this.rooms.values()].map((room) => ({
      ...room,
      members: this.presence(room.id).length,
      messageCount: this.messages.filter((message) => message.roomId === room.id).length,
    }));
  }

  join({ clientId, userId, name, roomId = "general" } = {}) {
    if (!clientId) throw new ChatError("join needs a clientId");
    if (!this.rooms.has(roomId)) throw new ChatError(`unknown room ${roomId}`, "unknown_room");
    const displayName = String(name ?? "").trim().slice(0, LIMITS.maxNameLength);
    if (!displayName) throw new ChatError("join needs a display name", "invalid_name");
    if (this.clients.has(clientId)) throw new ChatError(`client ${clientId} already joined`, "already_joined");

    const client = {
      id: clientId,
      userId: userId ?? clientId,
      name: displayName,
      color: COLORS[this.clients.size % COLORS.length],
      roomId,
      joinedAt: this.clock(),
      typingUntil: 0,
      rateWindowStart: 0,
      rateCount: 0,
      online: true,
    };
    this.clients.set(clientId, client);
    this.stats.joins++;

    return {
      direct: [{
        type: "welcome",
        protocol: PROTOCOL_VERSION,
        clientId,
        user: publicUser(client),
        rooms: this.roomsList(),
        presence: this.presence(roomId),
        history: this.history(roomId).messages,
        serverTime: this.clock(),
      }],
      broadcast: [{ type: "presence", roomId, members: this.presence(roomId) }],
    };
  }

  leave(clientId, { reason = "left" } = {}) {
    const client = this.clients.get(clientId);
    if (!client) return { direct: [], broadcast: [] };
    const roomId = client.roomId;
    this.clients.delete(clientId);
    return {
      direct: [],
      broadcast: [{ type: "presence", roomId, members: this.presence(roomId), reason }],
    };
  }

  presence(roomId) {
    return [...this.clients.values()]
      .filter((client) => client.roomId === roomId && client.online)
      .sort((a, b) => a.joinedAt - b.joinedAt || a.name.localeCompare(b.name))
      .map((client) => ({
        ...publicUser(client),
        typing: client.typingUntil > this.clock(),
      }));
  }

  setTyping(clientId, value) {
    const client = this.#requireClient(clientId);
    const typing = Boolean(value);
    client.typingUntil = typing ? this.clock() + 6_000 : 0;
    return {
      direct: [],
      broadcast: [{
        type: "typing",
        roomId: client.roomId,
        clientId,
        name: client.name,
        typing,
      }],
    };
  }

  history(roomId, { beforeId = null, limit = LIMITS.historyPageSize } = {}) {
    if (!this.rooms.has(roomId)) throw new ChatError(`unknown room ${roomId}`, "unknown_room");
    const all = this.messages.filter((message) => message.roomId === roomId);
    let end = all.length;
    if (beforeId) {
      const index = all.findIndex((message) => message.id === beforeId);
      end = index === -1 ? 0 : index;
    }
    const start = Math.max(0, end - Math.max(1, Math.min(limit, 200)));
    return {
      roomId,
      messages: all.slice(start, end).map((message) => ({ ...message })),
      hasMore: start > 0,
    };
  }

  #reject(error) {
    if (!error._counted) { error._counted = true; this.stats.rejected++; }
    return error;
  }

  #requireClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) throw new ChatError("client has not joined a room", "not_joined");
    return client;
  }

  #rateLimit(client) {
    const now = this.clock();
    if (now - client.rateWindowStart >= this.rateLimit.windowMs) {
      client.rateWindowStart = now;
      client.rateCount = 0;
    }
    client.rateCount++;
    if (client.rateCount > this.rateLimit.messages) {
      this.stats.rateLimited++;
      const retryIn = Math.max(0, this.rateLimit.windowMs - (now - client.rateWindowStart));
      throw new ChatError(`rate limit: retry in ${Math.ceil(retryIn / 1000)}s`, "rate_limited");
    }
  }

  #validateText(raw) {
    if (typeof raw !== "string") throw new ChatError("message text must be a string", "invalid_message");
    const text = raw.replace(/\s+$/g, "").trim();
    if (!text) throw new ChatError("message is empty", "empty_message");
    if (text.length > this.maxMessageLength) {
      throw new ChatError(`message exceeds ${this.maxMessageLength} characters`, "message_too_long");
    }
    return text;
  }

  sendMessage(clientId, rawText) {
    const client = this.#requireClient(clientId);
    try {
      this.#rateLimit(client);
      const text = this.#validateText(rawText);
      const moderation = this.moderate(text, publicUser(client));
      if (moderation) throw new ChatError(moderation, "blocked_by_moderation");

      const message = {
        id: this.idFactory(),
        roomId: client.roomId,
        userId: client.userId,
        name: client.name,
        color: client.color,
        text,
        ts: this.clock(),
        editedAt: null,
        deleted: false,
      };
      this.messages.push(message);
      if (this.messages.length > this.historyLimit) this.messages.shift();
      this.stats.messages++;
      client.typingUntil = 0;
      return { direct: [], broadcast: [{ type: "message", message: { ...message } }] };
    } catch (error) {
      if (error instanceof ChatError) this.#reject(error);
      throw error;
    }
  }

  editMessage(clientId, messageId, rawText) {
    const client = this.#requireClient(clientId);
    const message = this.messages.find((entry) => entry.id === messageId);
    if (!message) throw new ChatError("message not found", "not_found");
    if (message.userId !== client.userId) throw new ChatError("can only edit your own messages", "forbidden");
    if (message.deleted) throw new ChatError("message was deleted", "not_found");
    const text = this.#validateText(rawText);
    message.text = text;
    message.editedAt = this.clock();
    this.stats.edits++;
    return { direct: [], broadcast: [{ type: "edited", message: { ...message } }] };
  }

  deleteMessage(clientId, messageId) {
    const client = this.#requireClient(clientId);
    const message = this.messages.find((entry) => entry.id === messageId);
    if (!message) throw new ChatError("message not found", "not_found");
    if (message.userId !== client.userId) throw new ChatError("can only delete your own messages", "forbidden");
    message.deleted = true;
    message.text = "";
    this.stats.deletes++;
    return { direct: [], broadcast: [{ type: "deleted", messageId, roomId: message.roomId }] };
  }

  /**
   * Single entry point for the transport. Returns the events to send directly to
   * the caller and the events to broadcast to the room. Protocol errors come back
   * as an `error` event rather than throwing, because a chat server must not drop
   * a connection over one bad message.
   */
  dispatch(clientId, incoming) {
    try {
      if (!incoming || typeof incoming !== "object" || typeof incoming.type !== "string") {
        throw new ChatError("message needs a type", "invalid_protocol");
      }
      switch (incoming.type) {
        case "join":
          return this.join({
            clientId,
            userId: incoming.userId,
            name: incoming.name,
            roomId: incoming.roomId ?? "general",
          });
        case "message":
          return this.sendMessage(clientId, incoming.text);
        case "typing":
          return this.setTyping(clientId, incoming.value);
        case "history": {
          const client = this.#requireClient(clientId);
          const page = this.history(client.roomId, { beforeId: incoming.beforeId ?? null, limit: incoming.limit });
          return { direct: [{ type: "history", ...page }], broadcast: [] };
        }
        case "edit":
          return this.editMessage(clientId, incoming.messageId, incoming.text);
        case "delete":
          return this.deleteMessage(clientId, incoming.messageId);
        case "ping":
          return { direct: [{ type: "pong", at: incoming.at ?? this.clock(), serverTime: this.clock() }], broadcast: [] };
        case "leave": {
          const client = this.clients.get(clientId);
          if (!client) throw new ChatError("client has not joined a room", "not_joined");
          return this.leave(clientId);
        }
        default:
          throw new ChatError(`unknown message type ${incoming.type}`, "unknown_type");
      }
    } catch (error) {
      if (error instanceof ChatError) {
        this.#reject(error);
        return { direct: [{ type: "error", code: error.code, message: error.message }], broadcast: [] };
      }
      throw error;
    }
  }

  snapshot() {
    return {
      rooms: this.roomsList(),
      presence: Object.fromEntries([...this.rooms.keys()].map((roomId) => [roomId, this.presence(roomId)])),
      messages: this.messages.length,
      clients: this.clients.size,
      stats: { ...this.stats },
    };
  }
}

function publicUser(client) {
  return {
    clientId: client.id,
    userId: client.userId,
    name: client.name,
    color: client.color,
    joinedAt: client.joinedAt,
  };
}
