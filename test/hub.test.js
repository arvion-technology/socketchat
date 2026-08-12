import test from "node:test";
import assert from "node:assert/strict";
import { ChatHub, ChatError, LIMITS, createCounterIds } from "../src/hub.js";

function makeHub(options = {}) {
  const clock = { now: 1_000_000 };
  const hub = new ChatHub({ clock: () => clock.now, ...options });
  return { hub, clock };
}

test("join returns welcome, rooms, presence and empty history", () => {
  const { hub } = makeHub();
  const result = hub.join({ clientId: "c1", name: "Ada", userId: "u1" });
  assert.equal(result.direct.length, 1);
  const welcome = result.direct[0];
  assert.equal(welcome.type, "welcome");
  assert.equal(welcome.protocol, 1);
  assert.equal(welcome.clientId, "c1");
  assert.ok(welcome.rooms.length >= 3);
  assert.deepEqual(welcome.presence.map((member) => member.name), ["Ada"]);
  assert.deepEqual(welcome.history, []);
  assert.equal(result.broadcast[0].type, "presence");
  assert.equal(hub.snapshot().clients, 1);
});

test("join validation rejects unknown rooms, empty names and double joins", () => {
  const { hub } = makeHub();
  assert.throws(() => hub.join({ clientId: "c1", name: "Ada", roomId: "nope" }), /unknown room/);
  assert.throws(() => hub.join({ clientId: "c1", name: "   " }), /display name/);
  hub.join({ clientId: "c1", name: "Ada" });
  assert.throws(() => hub.join({ clientId: "c1", name: "Ada" }), /already joined/);
});

test("presence updates when clients join, leave and switch rooms", () => {
  const { hub } = makeHub();
  hub.join({ clientId: "c1", name: "Ada" });
  const second = hub.join({ clientId: "c2", name: "Grace" });
  assert.equal(second.broadcast[0].members.length, 2);
  assert.deepEqual(second.broadcast[0].members.map((member) => member.name), ["Ada", "Grace"]);

  const left = hub.leave("c2");
  assert.deepEqual(left.broadcast[0].members.map((member) => member.name), ["Ada"]);
  assert.equal(hub.presence("general").length, 1);

  hub.join({ clientId: "c3", name: "Linus", roomId: "engineering" });
  assert.equal(hub.presence("general").length, 1);
  assert.equal(hub.presence("engineering").length, 1);
});

test("messages broadcast to the room and appear in history in order", () => {
  const { hub } = makeHub();
  hub.join({ clientId: "c1", name: "Ada" });
  hub.join({ clientId: "c2", name: "Grace" });
  const first = hub.sendMessage("c1", "  hello   ");
  assert.equal(first.broadcast[0].type, "message");
  assert.equal(first.broadcast[0].message.text, "hello");
  hub.sendMessage("c2", "hi Ada");
  const history = hub.history("general");
  assert.deepEqual(history.messages.map((message) => message.text), ["hello", "hi Ada"]);
  assert.equal(history.hasMore, false);
  assert.equal(hub.stats.messages, 2);
});

test("message validation: empty, whitespace, too long, not joined", () => {
  const { hub } = makeHub({ maxMessageLength: 10 });
  assert.throws(() => hub.sendMessage("ghost", "hello"), /not joined/);
  hub.join({ clientId: "c1", name: "Ada" });
  assert.throws(() => hub.sendMessage("c1", "   "), /empty/);
  assert.throws(() => hub.sendMessage("c1", "this is too long"), /10 characters/);
  assert.throws(() => hub.sendMessage("c1", 42), /string/);
});

test("the rate limiter stops a message flood and refills after the window", () => {
  const { hub, clock } = makeHub({ rateLimit: { messages: 3, windowMs: 10_000 } });
  hub.join({ clientId: "c1", name: "Ada" });
  for (let i = 0; i < 3; i++) hub.sendMessage("c1", `message ${i}`);
  assert.throws(() => hub.sendMessage("c1", "one too many"), /rate limit/);
  assert.equal(hub.stats.rateLimited, 1);
  clock.now += 10_000;
  assert.doesNotThrow(() => hub.sendMessage("c1", "after the window"));
});

test("typing state is broadcast and expires", () => {
  const { hub, clock } = makeHub();
  hub.join({ clientId: "c1", name: "Ada" });
  hub.join({ clientId: "c2", name: "Grace" });
  const typing = hub.setTyping("c1", true);
  assert.deepEqual(
    { type: typing.broadcast[0].type, name: typing.broadcast[0].name, typing: typing.broadcast[0].typing },
    { type: "typing", name: "Ada", typing: true },
  );
  assert.equal(hub.presence("general").find((member) => member.name === "Ada").typing, true);
  clock.now += 6_001;
  assert.equal(hub.presence("general").find((member) => member.name === "Ada").typing, false);
});

test("edit and delete only work on your own messages", () => {
  const { hub } = makeHub();
  hub.join({ clientId: "c1", name: "Ada", userId: "u1" });
  hub.join({ clientId: "c2", name: "Grace", userId: "u2" });
  const message = hub.sendMessage("c1", "frist").broadcast[0].message;

  assert.throws(() => hub.editMessage("c2", message.id, "hijacked"), /own messages/);
  assert.throws(() => hub.deleteMessage("c2", message.id), /own messages/);

  const edited = hub.editMessage("c1", message.id, "first");
  assert.equal(edited.broadcast[0].type, "edited");
  assert.equal(edited.broadcast[0].message.text, "first");
  assert.ok(edited.broadcast[0].message.editedAt);

  const deleted = hub.deleteMessage("c1", message.id);
  assert.deepEqual(deleted.broadcast[0], { type: "deleted", messageId: message.id, roomId: "general" });
  const history = hub.history("general").messages[0];
  assert.equal(history.deleted, true);
  assert.equal(history.text, "");
  assert.throws(() => hub.editMessage("c1", message.id, "again"), /deleted/);
});

test("the moderation hook can reject a message before it is stored", () => {
  const { hub } = makeHub({
    moderate: (text) => (text.includes("secret-token") ? "looks like a leaked credential" : null),
  });
  hub.join({ clientId: "c1", name: "Ada" });
  assert.throws(() => hub.sendMessage("c1", "here is secret-token=abc"), /leaked credential/);
  assert.equal(hub.history("general").messages.length, 0);
  assert.doesNotThrow(() => hub.sendMessage("c1", "the build passed"));
});

test("history pagination walks backwards with beforeId", () => {
  const { hub } = makeHub({ idFactory: createCounterIds("m"), rateLimit: { messages: 100, windowMs: 10_000 } });
  hub.join({ clientId: "c1", name: "Ada" });
  for (let i = 0; i < 7; i++) hub.sendMessage("c1", `m${i}`);
  const page = hub.history("general", { limit: 3 });
  assert.deepEqual(page.messages.map((message) => message.text), ["m4", "m5", "m6"]);
  assert.equal(page.hasMore, true);
  const older = hub.history("general", { beforeId: page.messages[0].id, limit: 3 });
  assert.deepEqual(older.messages.map((message) => message.text), ["m1", "m2", "m3"]);
  assert.equal(older.hasMore, true);
  const oldest = hub.history("general", { beforeId: older.messages[0].id, limit: 3 });
  assert.deepEqual(oldest.messages.map((message) => message.text), ["m0"]);
  assert.equal(oldest.hasMore, false);
});

test("history is capped so a long-lived room does not grow forever", () => {
  const { hub } = makeHub({ historyLimit: 5, rateLimit: { messages: 100, windowMs: 10_000 } });
  hub.join({ clientId: "c1", name: "Ada" });
  for (let i = 0; i < 8; i++) hub.sendMessage("c1", `m${i}`);
  assert.deepEqual(hub.history("general").messages.map((message) => message.text), ["m3", "m4", "m5", "m6", "m7"]);
});

test("dispatch maps protocol messages to events and returns errors instead of throwing", () => {
  const { hub } = makeHub();
  const bad = hub.dispatch("c1", { type: "message", text: "before join" });
  assert.equal(bad.direct[0].type, "error");
  assert.equal(bad.direct[0].code, "not_joined");

  hub.dispatch("c1", { type: "join", name: "Ada", roomId: "engineering" });
  const joined = hub.dispatch("c1", { type: "join", name: "Ada" });
  assert.equal(joined.direct[0].code, "already_joined");

  const ping = hub.dispatch("c1", { type: "ping", at: 123 });
  assert.equal(ping.direct[0].type, "pong");
  assert.equal(ping.direct[0].at, 123);

  const typing = hub.dispatch("c1", { type: "typing", value: true });
  assert.equal(typing.broadcast[0].type, "typing");

  const unknown = hub.dispatch("c1", { type: "dance" });
  assert.equal(unknown.direct[0].code, "unknown_type");
  const malformed = hub.dispatch("c1", {});
  assert.equal(malformed.direct[0].code, "invalid_protocol");
  assert.ok(hub.stats.rejected >= 4);
});

test("limits are explicit rather than magic numbers scattered around", () => {
  assert.equal(LIMITS.maxMessageLength, 2_000);
  assert.equal(LIMITS.historyPageSize, 50);
  assert.ok(LIMITS.rateLimit.messages > 0);
  assert.throws(() => new ChatHub({}).join({ clientId: "c", name: "x", roomId: "ghost" }), ChatError);
});
