// SocketChat demo.
//
// The browser runs the real ChatHub from ../src/hub.js and simulates three peers
// calling the same hub methods the WebSocket server calls. There is no second
// chat implementation here; the only difference from production is the transport.
import { ChatHub, DEFAULT_ROOMS } from "../src/hub.js";

const $ = A.$, el = A.el, fmt = A.fmt;

const ME = { clientId: "me", name: "You", userId: "u_me" };
const PEERS = [
  { clientId: "p_anish", name: "Anish Shrestha", role: "Engineering lead", userId: "u_anish", seed: 0 },
  { clientId: "p_prakriti", name: "Prakriti Rai", role: "Product designer", userId: "u_prakriti", seed: 1 },
  { clientId: "p_bikash", name: "Bikash Thapa", role: "Backend engineer", userId: "u_bikash", seed: 2 },
];
const ROLE_BY_USER = Object.fromEntries(PEERS.map((peer) => [peer.userId, peer.role]));

const SCRIPTS = {
  general: [
    [0, "The frame codec is green against the RFC vectors — masked Hello round-trips byte for byte."],
    [1, "Can the presence list show who is typing without another round trip?"],
    [2, "It rides the presence payload. Typing is a six-second expiry on the client record."],
    [0, "Close frames echo the peer's status code now instead of always sending 1000."],
    [1, "Room switcher feels good. Do we want unread counts?"],
    [2, "Not yet — history is per room, unread needs a per-client cursor."],
    [0, "Leaving that out of v1. The runbook has it as a follow-up."],
  ],
  engineering: [
    [2, "The assembler rejects a continuation frame before its start frame."],
    [0, "Good. Check that control frames can interleave between fragments too."],
    [2, "Test sends a ping between two text fragments and expects a pong plus the rejoined message."],
    [0, "Rate limit is six messages per ten seconds per client. Enough to stop a paste loop."],
    [2, "The server heartbeat pings every 30s and drops a socket that misses two."],
    [0, "The upgrade rejects a short Sec-WebSocket-Key before the handshake is written."],
  ],
  design: [
    [1, "Message bubbles cap at 640px so a long URL does not stretch the column."],
    [0, "Presence dots reuse the status colour tokens — gold when someone is typing."],
    [1, "The typing indicator is one fixed-height line; it must not push the composer."],
    [0, "Composer hint says 2,000 characters. That is the hub limit, not a UI guess."],
    [1, "I like that own messages are right-aligned without a second bubble colour."],
  ],
};

const LIVE_LINES = {
  general: [
    "Has anyone tried the raw socket client? It is about forty lines.",
    "The demo hub is the production hub — same dispatch path, just no socket.",
    "History pagination walks backwards from a message id, so reconnect is cheap.",
    "The moderation hook is a function you pass in; the default allows everything.",
  ],
  engineering: [
    "Frame length 127 reads a big-endian uint64; the test uses 70,000 bytes.",
    "Ping payload is echoed back verbatim in the pong.",
    "Close 1009 means the message was too big — separate from a protocol error.",
    "The handshake only accepts version 13. Older drafts are dead.",
  ],
  design: [
    "Time labels are tabular so timestamps line up down the column.",
    "Deleted messages stay in history as a placeholder rather than disappearing.",
    "This rail only shows protocol events, not raw frames — the frames live in tests.",
    "Room list counts come from the hub, never from a local guess.",
  ],
};

const state = { room: "general", generation: 0, events: [], replyTimer: null, typingTimer: null };

// Seed history a few minutes in the past so the first screen has a conversation.
const virtual = { now: Date.now() - 9 * 60_000 };
const hub = new ChatHub({ clock: () => virtual.now });

function seed() {
  for (const room of DEFAULT_ROOMS) {
    for (const peer of PEERS) hub.join({ clientId: peer.clientId, name: peer.name, userId: peer.userId, roomId: room.id });
    for (const [peerIndex, text] of SCRIPTS[room.id] ?? []) {
      virtual.now += Math.round(70_000 + Math.random() * 50_000);
      const peer = PEERS[peerIndex];
      const result = hub.sendMessage(peer.clientId, text);
      state.events.push(...result.broadcast.map((event) => ({ event, direction: "broadcast", at: virtual.now })));
    }
    for (const peer of PEERS) hub.leave(peer.clientId);
    virtual.now += 30_000;
  }
  virtual.now = Date.now();
}

seed();
state.events = state.events.slice(-30);

function record(result, incomingType = "event") {
  for (const event of result.direct ?? []) state.events.push({ event, direction: "direct", at: Date.now(), incomingType });
  for (const event of result.broadcast ?? []) state.events.push({ event, direction: "broadcast", at: Date.now(), incomingType });
  if (state.events.length > 60) state.events = state.events.slice(-60);
}

const room = (id) => DEFAULT_ROOMS.find((entry) => entry.id === id) ?? DEFAULT_ROOMS[0];
const peerById = (clientId) => PEERS.find((peer) => peer.clientId === clientId);
const timeOf = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const avatarFor = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("");

function membersFor(id) {
  try { return hub.presence(id); } catch { return []; }
}

/* -------------------------------------------------------------- rendering */

function renderRooms() {
  const list = hub.roomsList();
  $("#room-list").replaceChildren(...list.map((entry) =>
    el("div", {
      class: `room-item ${entry.id === state.room ? "active" : ""}`,
      role: "button",
      tabindex: "0",
      onclick: () => switchRoom(entry.id),
      onkeydown: (event) => { if (event.key === "Enter") switchRoom(entry.id); },
    },
      el("span", { class: "hash", text: "#" }),
      el("span", { text: entry.name }),
      el("span", { class: "count", text: String(entry.members) }))));
}

function renderPresence() {
  const members = membersFor(state.room);
  $("#presence-list").replaceChildren(...members.map((member) => {
    const peer = peerById(member.clientId);
    const role = member.userId === ME.userId ? "You" : peer?.role ?? "Member";
    return el("div", { class: "person" },
      el("span", { class: "avatar sm", style: `background:${member.color}22;color:${member.color};border-color:${member.color}55`, text: avatarFor(member.name) }),
      el("div", { style: "min-width:0" },
        el("div", { class: "person-name", text: member.name }),
        el("div", { class: "person-role", text: role })),
      el("span", { class: `status ${member.typing ? "typing" : ""}`, title: member.typing ? "typing" : "online" }));
  }));
}

function renderTyping() {
  const typing = membersFor(state.room).filter((member) => member.typing && member.clientId !== ME.clientId);
  const line = $("#typing-line");
  line.classList.toggle("active", typing.length > 0);
  if (!typing.length) { $("#typing-text").textContent = "Nobody is typing"; return; }
  const names = typing.map((member) => member.name.split(" ")[0]);
  $("#typing-text").textContent = `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} typing…`;
}

function renderMessages() {
  const { messages } = hub.history(state.room, { limit: 200 });
  const nodes = [];
  let lastDay = null;
  for (const message of messages) {
    const day = new Date(message.ts).toDateString();
    if (day !== lastDay) {
      nodes.push(el("div", { class: "day-sep", text: new Date(message.ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }) }));
      lastDay = day;
    }
    const own = message.userId === ME.userId;
    const peer = PEERS.find((entry) => entry.userId === message.userId);
    nodes.push(el("div", { class: `msg ${own ? "own" : ""}` },
      el("span", { class: "avatar sm", style: own ? "" : `background:${message.color}22;color:${message.color};border-color:${message.color}55`, text: own ? "AV" : avatarFor(message.name) }),
      el("div", { class: "msg-body" },
        el("div", { class: "msg-head" },
          el("span", { class: "msg-name", text: own ? "You" : message.name }),
          el("span", { class: "msg-role", text: own ? "demo user" : peer?.role ?? "Member" }),
          el("span", { class: "msg-time", text: `${timeOf(message.ts)}${message.editedAt ? " · edited" : ""}` })),
        el("div", { class: "msg-text" },
          message.deleted ? el("em", { text: "message deleted" }) : message.text))));
  }
  const host = $("#messages");
  const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 80;
  host.replaceChildren(...nodes);
  if (atBottom) host.scrollTop = host.scrollHeight;
}

function renderWire() {
  const recent = state.events.slice(-9).reverse();
  $("#event-count").textContent = String(state.events.length);
  $("#wire-log").replaceChildren(...recent.map(({ event, direction, incomingType }) => {
    const type = event.type ?? "?";
    const body = JSON.stringify(event).slice(0, 120);
    return el("div", { class: "wire-row" },
      el("div", { class: "wire-top" },
        el("span", { class: `wire-dir ${direction}`, text: direction === "direct" ? "direct" : "broadcast" }),
        el("span", { class: "wire-type", text: type }),
        el("span", { class: "spacer" })),
      el("div", { class: "wire-body", text: body }));
  }));
}

function renderState() {
  const entry = room(state.room);
  const messages = hub.history(state.room, { limit: 500 }).messages.length;
  $("#room-title").textContent = entry.name;
  $("#room-topic").textContent = entry.topic;
  $("#room-members").textContent = `${membersFor(state.room).length} online`;
  $("#state-room").textContent = `#${entry.id}`;
  $("#state-members").textContent = String(membersFor(state.room).length);
  $("#state-messages").textContent = String(messages);
  $("#composer-input").placeholder = `Message #${entry.id}`;
}

function render() {
  renderRooms();
  renderPresence();
  renderTyping();
  renderMessages();
  renderWire();
  renderState();
}

/* ---------------------------------------------------------------- actions */

function moveEveryone(roomId) {
  for (const clientId of [ME.clientId, ...PEERS.map((peer) => peer.clientId)]) {
    if (hub.clients.has(clientId)) hub.leave(clientId);
  }
  for (const peer of PEERS) hub.join({ clientId: peer.clientId, name: peer.name, userId: peer.userId, roomId });
  const result = hub.dispatch(ME.clientId, { type: "join", userId: ME.userId, name: ME.name, roomId });
  record(result, "join");
}

function cancelPending() {
  clearTimeout(state.replyTimer);
  clearTimeout(state.typingTimer);
  state.generation++;
}

function switchRoom(roomId) {
  if (state.room === roomId) return;
  cancelPending();
  state.room = roomId;
  moveEveryone(roomId);
  if (location.hash !== `#${roomId}`) history.replaceState(null, "", `#${roomId}`);
  render();
  schedulePeer();
}

function send(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const result = hub.dispatch(ME.clientId, { type: "message", text: trimmed });
  record(result, "message");
  if (result.direct.some((event) => event.type === "error")) {
    const error = result.direct.find((event) => event.type === "error");
    A.toast(error.message, "error", 2200);
    render();
    return;
  }
  render();
  scheduleReply();
}

/** One scripted peer reply shortly after the human sends something. */
function scheduleReply() {
  cancelPending();
  const roomId = state.room;
  const peer = PEERS[Math.floor(Math.random() * PEERS.length)];
  state.typingTimer = setTimeout(() => {
    if (state.room !== roomId) return;
    record(hub.dispatch(peer.clientId, { type: "typing", value: true }), "typing");
    render();
  }, 450);
  state.replyTimer = setTimeout(() => {
    if (state.room !== roomId) return;
    record(hub.dispatch(peer.clientId, { type: "typing", value: false }), "typing");
    record(hub.dispatch(peer.clientId, { type: "message", text: pickLine(state.room, peer) }), "message");
    render();
    schedulePeer();
  }, 1_500);
}

function pickLine(roomId, peer) {
  const lines = LIVE_LINES[roomId] ?? LIVE_LINES.general;
  return lines[Math.floor(Math.random() * lines.length)];
}

/** Ambient traffic so the room feels alive without a real second browser tab. */
function schedulePeer() {
  cancelPending();
  const roomId = state.room;
  const delay = 4_500 + Math.random() * 3_500;
  state.replyTimer = setTimeout(() => {
    if (state.room !== roomId) return;
    const peer = PEERS[Math.floor(Math.random() * PEERS.length)];
    record(hub.dispatch(peer.clientId, { type: "typing", value: true }), "typing");
    render();
    state.typingTimer = setTimeout(() => {
      if (state.room !== roomId) return;
      record(hub.dispatch(peer.clientId, { type: "typing", value: false }), "typing");
      record(hub.dispatch(peer.clientId, { type: "message", text: pickLine(state.room, peer) }), "message");
      render();
      schedulePeer();
    }, 1_400 + Math.random() * 900);
  }, delay);
}

/* ---------------------------------------------------------------- wiring */

function route() {
  const requested = (location.hash || "#general").slice(1);
  const target = DEFAULT_ROOMS.some((entry) => entry.id === requested) ? requested : "general";
  if (target !== state.room) switchRoom(target);
}

function wire() {
  $("#send-btn").addEventListener("click", () => {
    const input = $("#composer-input");
    send(input.value);
    input.value = "";
    input.focus();
  });
  $("#composer-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    $("#send-btn").click();
  });
  $("#jump-latest").addEventListener("click", () => {
    const host = $("#messages");
    host.scrollTop = host.scrollHeight;
  });
  window.addEventListener("hashchange", route);
}

moveEveryone(state.room);
wire();
render();
if (location.hash) route();
schedulePeer();
