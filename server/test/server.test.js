import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { GameServer } from "../src/GameServer.js";
import { loadWorld } from "../src/world.js";

process.env.LOG_LEVEL = "silent";
const { log } = await import("../src/util.js");
log.quiet = true;

const world = loadWorld();
let http, game, url;

before(async () => {
  http = createServer();
  game = new GameServer(world, { tickMs: 10, maxRoomPlayers: 3, maxConnsPerIp: 50 }).attach(http);
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  url = `ws://127.0.0.1:${http.address().port}`;
});

after(() => {
  game.close();
  http.close();
});

/** Tiny test client: records every message and lets tests await specific ones. */
class Client {
  constructor() {
    this.msgs = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.closed = new Promise((r) => this.ws.on("close", (code) => r(code)));
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => !w(m));
    });
    this.open = new Promise((r) => this.ws.on("open", r));
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  /** Resolves with the first message (past or future) matching the predicate. */
  next(pred, ms = 1500) {
    const typeFn = typeof pred === "string" ? (m) => m.t === pred : pred;
    const found = this.msgs.find(typeFn);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${pred}`)), ms);
      this.waiters.push((m) => {
        if (!typeFn(m)) return false;
        clearTimeout(timer);
        resolve(m);
        return true;
      });
    });
  }

  /** Forget what we've seen so a later next() only matches new traffic. */
  clear() {
    this.msgs = [];
  }

  close() {
    this.ws.close();
  }
}

async function join(opts = {}) {
  const c = new Client();
  await c.open;
  c.send({ t: "join", name: "Tester", avatar: "adam", room: "lobby", ...opts });
  c.hello = await c.next((m) => m.t === "hello" || m.t === "err");
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("join: hello contains id, spawn on walkable ground and ICE servers", async () => {
  const a = await join({ name: "  Ada\u0000 Lovelace  " });
  assert.equal(a.hello.t, "hello");
  assert.equal(a.hello.room.id, "lobby");
  assert.ok(a.hello.id.length >= 6);
  assert.equal(world.isSolidAt(a.hello.spawn.x, a.hello.spawn.y), false);
  assert.ok(Array.isArray(a.hello.ice));
  a.close();
});

test("join: second player sees first, and first is told about the newcomer", async () => {
  const a = await join({ name: "Ann", room: "meet-1" });
  const b = await join({ name: "Bob", room: "meet-1" });
  assert.deepEqual(b.hello.players.map((p) => p.name), ["Ann"]);
  const joined = await a.next("joined");
  assert.equal(joined.p.name, "Bob");
  b.close();
  const left = await a.next("left");
  assert.equal(left.id, b.hello.id);
  a.close();
});

test("join: name is sanitised, bad avatar is replaced, empty name gets a guest tag", async () => {
  const a = await join({ name: "   ", avatar: "<script>" });
  const me = a.hello.id;
  const b = await join({});
  const seen = b.hello.players.find((p) => p.id === me);
  assert.match(seen.name, /^Guest\d{4}$/);
  assert.ok(["adam", "ash", "lucy", "nancy"].includes(seen.avatar));
  a.close();
  b.close();
});

test("join: invalid room name is rejected and the socket is closed", async () => {
  const c = await join({ room: "../etc/passwd" });
  assert.equal(c.hello.t, "err");
  assert.equal(c.hello.code, "bad_room");
  assert.equal(await c.closed, 4001);
});

test("must join before doing anything else", async () => {
  const c = new Client();
  await c.open;
  c.send({ t: "chat", text: "hi" });
  c.send({ t: "ping", n: 7 });
  const pong = await c.next("pong");
  assert.equal(pong.n, 7);
  assert.equal(c.msgs.some((m) => m.t === "chat"), false);
  c.close();
});

test("rooms are isolated from each other", async () => {
  const a = await join({ room: "iso-a" });
  const b = await join({ room: "iso-b" });
  a.send({ t: "chat", text: "secret" });
  await a.next("chat");
  await sleep(60);
  assert.equal(b.msgs.some((m) => m.t === "chat"), false);
  a.close();
  b.close();
});

test("private rooms: need the right key; stats hide them", async () => {
  const owner = await join({ room: "vip", key: "hunter2" });
  assert.equal(owner.hello.room.locked, true);

  const wrong = await join({ room: "vip", key: "nope" });
  assert.equal(wrong.hello.code, "bad_key");

  const right = await join({ room: "vip", key: "hunter2" });
  assert.equal(right.hello.t, "hello");

  assert.equal(game.stats().rooms.some((r) => r.id === "vip"), false);
  assert.ok(game.stats().online >= 2);
  owner.close();
  right.close();
});

test("rooms enforce their capacity", async () => {
  const room = "tiny";
  const clients = [];
  for (let i = 0; i < 3; i++) clients.push(await join({ room }));
  const overflow = await join({ room });
  assert.equal(overflow.hello.code, "room_full");
  clients.forEach((c) => c.close());
});

test("empty custom rooms are disposed, the lobby is not", async () => {
  const c = await join({ room: "temp-room" });
  assert.ok(game.rooms.has("temp-room"));
  c.close();
  await sleep(80);
  assert.equal(game.rooms.has("temp-room"), false);
  assert.ok(game.rooms.has("lobby"));
});

test("movement: valid steps are broadcast to others (batched)", async () => {
  const a = await join({ room: "move-1" });
  const b = await join({ room: "move-1" });
  const { x, y } = a.hello.spawn;
  a.send({ t: "move", x: x + 4, y, a: "run_right" });
  const batch = await b.next((m) => m.t === "moves" && m.m.some((e) => e[0] === a.hello.id));
  const entry = batch.m.find((e) => e[0] === a.hello.id);
  assert.deepEqual(entry.slice(1), [x + 4, y, "run_right"]);
  a.close();
  b.close();
});

test("movement: teleporting is rejected with a snap back", async () => {
  const a = await join({ room: "move-2" });
  const { x, y } = a.hello.spawn;
  a.send({ t: "move", x: x + 400, y, a: "run_right" });
  const snap = await a.next("snap");
  assert.deepEqual([snap.x, snap.y], [x, y]);
  a.close();
});

test("movement: walking into a wall is rejected", async () => {
  const a = await join({ room: "move-3" });
  // Find a spot right next to a solid cell and step into it.
  const { x, y } = a.hello.spawn;
  let wallX = null;
  for (let dx = 4; dx < 400; dx += 4) {
    if (world.isSolidAt(x + dx, y)) {
      wallX = x + dx;
      break;
    }
  }
  assert.ok(wallX !== null, "expected a wall to the right of spawn");
  // walk there in legal steps (each well under the speed limit)
  let cx = x;
  while (cx + 6 < wallX - 2) {
    cx += 6;
    a.send({ t: "move", x: cx, y, a: "run_right" });
    await sleep(30);
  }
  a.clear();
  a.send({ t: "move", x: wallX + 2, y, a: "run_right" });
  const snap = await a.next("snap");
  assert.ok(snap.x < wallX);
  a.close();
});

test("movement: garbage coordinates never crash the server", async () => {
  const a = await join({ room: "move-4" });
  for (const bad of [null, "x", NaN, Infinity, {}, [], -1e9]) {
    a.send({ t: "move", x: bad, y: bad, a: 42 });
  }
  a.send({ t: "ping", n: 1 });
  await a.next("pong");
  a.close();
});

test("chat: broadcast with sanitised text, history for latecomers", async () => {
  const a = await join({ room: "chat-1", name: "Ann" });
  a.send({ t: "chat", text: "  hello\n\n   world ​ " });
  const msg = await a.next("chat");
  assert.equal(msg.text, "hello world");
  assert.equal(msg.name, "Ann");

  const b = await join({ room: "chat-1" });
  assert.equal(b.hello.history.length, 1);
  assert.equal(b.hello.history[0].text, "hello world");
  a.close();
  b.close();
});

test("chat: floods are throttled and empty messages ignored", async () => {
  const a = await join({ room: "chat-2" });
  a.send({ t: "chat", text: "   " });
  for (let i = 0; i < 20; i++) a.send({ t: "chat", text: `spam ${i}` });
  await a.next("err");
  await sleep(50);
  const delivered = a.msgs.filter((m) => m.t === "chat").length;
  assert.ok(delivered <= 6, `delivered ${delivered}`);
  a.close();
});

test("emotes: only whitelisted emoji pass", async () => {
  const a = await join({ room: "emote-1" });
  a.send({ t: "emote", e: "<img src=x>" });
  a.send({ t: "emote", e: "🎉" });
  const em = await a.next("emote");
  assert.equal(em.e, "🎉");
  assert.equal(a.msgs.filter((m) => m.t === "emote").length, 1);
  a.close();
});

// ---- chairs -----------------------------------------------------------------

/** Teleport a player next to something by joining with a spawn position. */
const nearChair = (chair) => ({ x: chair.x, y: chair.y + 40 });

test("sit: takes the seat, moves you to it, and a second sitter is refused", async () => {
  const chair = world.chairs.find((c) => !world.isSolidAt(c.x, c.y + 40));
  assert.ok(chair);
  const a = await join({ room: "seat-1", ...nearChair(chair) });
  const b = await join({ room: "seat-1", ...nearChair(chair) });

  a.send({ t: "sit", chair: chair.id });
  const seat = await b.next("seat");
  assert.deepEqual([seat.chair, seat.id], [chair.id, a.hello.id]);
  const mv = await b.next((m) => m.t === "moves" && m.m.some((e) => e[0] === a.hello.id && e[3].startsWith("sit_")));
  assert.ok(mv);

  b.send({ t: "sit", chair: chair.id });
  const err = await b.next("err");
  assert.equal(err.code, "seat_taken");

  // standing frees the chair
  a.send({ t: "stand" });
  const freed = await b.next((m) => m.t === "seat" && m.id === null);
  assert.equal(freed.chair, chair.id);
  b.send({ t: "sit", chair: chair.id });
  const seat2 = await b.next((m) => m.t === "seat" && m.id === b.hello.id);
  assert.equal(seat2.chair, chair.id);
  a.close();
  b.close();
});

test("sit: too far away is refused; leaving frees the seat; late joiners see occupied seats", async () => {
  const chair = world.chairs[0];
  const far = world.spawns.find((s) => Math.hypot(s.x - chair.x, s.y - chair.y) > 300);
  const a = await join({ room: "seat-2", x: far.x, y: far.y });
  a.send({ t: "sit", chair: chair.id });
  assert.equal((await a.next("err")).code, "too_far");
  a.close();

  const sitter = await join({ room: "seat-3", ...nearChair(chair) });
  sitter.send({ t: "sit", chair: chair.id });
  await sitter.next((m) => m.t === "seat");
  const late = await join({ room: "seat-3" });
  assert.equal(late.hello.seats[chair.id], sitter.hello.id);
  sitter.close();
  const freed = await late.next((m) => m.t === "seat" && m.id === null);
  assert.equal(freed.chair, chair.id);
  late.close();
});

test("sit: seated players can't walk until they stand", async () => {
  const chair = world.chairs[0];
  const a = await join({ room: "seat-4", ...nearChair(chair) });
  a.send({ t: "sit", chair: chair.id });
  await a.next("seat");
  a.clear();
  a.send({ t: "move", x: chair.x + 10, y: chair.y + 40, a: "run_left" });
  await sleep(60);
  assert.equal(a.msgs.some((m) => m.t === "moves" && m.m.some((e) => e[3] === "run_left")), false);
  a.close();
});

// ---- computers / screen share -----------------------------------------------

test("computers: join, share, busy for others, cleanup on disconnect", async () => {
  const pc = world.computers[0];
  const spot = { x: pc.x, y: pc.y + 70 };
  const a = await join({ room: "pc-1", ...spot });
  const b = await join({ room: "pc-1", ...spot });

  a.send({ t: "pc", id: pc.id, on: true });
  b.send({ t: "pc", id: pc.id, on: true });
  await b.next((m) => m.t === "pc" && m.users.length === 2);

  a.send({ t: "share", id: pc.id, on: true });
  const sharing = await b.next((m) => m.t === "pc" && m.sharer === a.hello.id);
  assert.equal(sharing.users.length, 2);

  b.send({ t: "share", id: pc.id, on: true });
  assert.equal((await b.next("err")).code, "busy");

  a.close();
  const after = await b.next((m) => m.t === "pc" && m.users.length === 1);
  assert.equal(after.sharer, null);
  b.close();
});

test("computers: signalling for screens only flows between people at that computer", async () => {
  const pc = world.computers[0];
  const spot = { x: pc.x, y: pc.y + 70 };
  const a = await join({ room: "pc-2", ...spot });
  const b = await join({ room: "pc-2", ...spot });
  const outsider = await join({ room: "pc-2" });

  a.send({ t: "pc", id: pc.id, on: true });
  b.send({ t: "pc", id: pc.id, on: true });
  await b.next((m) => m.t === "pc" && m.users.length === 2);

  a.send({ t: "rtc", to: b.hello.id, ch: "screen", pc: pc.id, d: { sdp: "x" } });
  a.send({ t: "rtc", to: outsider.hello.id, ch: "screen", pc: pc.id, d: { sdp: "leak" } });
  const got = await b.next("rtc");
  assert.deepEqual([got.from, got.ch, got.pc], [a.hello.id, "screen", pc.id]);
  await sleep(60);
  assert.equal(outsider.msgs.some((m) => m.t === "rtc"), false);
  [a, b, outsider].forEach((c) => c.close());
});

// ---- misc --------------------------------------------------------------------

test("rtc av signalling is relayed room-wide, but oversized payloads are dropped", async () => {
  const a = await join({ room: "rtc-1" });
  const b = await join({ room: "rtc-1" });
  a.send({ t: "rtc", to: b.hello.id, ch: "av", d: { type: "offer", sdp: "v=0..." } });
  const got = await b.next("rtc");
  assert.equal(got.d.type, "offer");
  b.clear();
  a.send({ t: "rtc", to: b.hello.id, ch: "av", d: { sdp: "x".repeat(13_000) } });
  await sleep(60);
  assert.equal(b.msgs.some((m) => m.t === "rtc"), false);
  a.close();
  b.close();
});

test("media + profile updates are broadcast", async () => {
  const a = await join({ room: "prof-1" });
  const b = await join({ room: "prof-1" });
  a.send({ t: "media", mic: true, cam: false });
  const media = await b.next("media");
  assert.deepEqual([media.id, media.mic, media.cam], [a.hello.id, true, false]);
  a.send({ t: "profile", name: "Renamed", avatar: "lucy" });
  const upd = await b.next("player");
  assert.deepEqual([upd.name, upd.avatar], ["Renamed", "lucy"]);
  a.close();
  b.close();
});

test("reconnecting with a saved position is honoured only if it is walkable", async () => {
  const good = world.spawns[3];
  const a = await join({ room: "re-1", x: good.x, y: good.y });
  assert.deepEqual([a.hello.spawn.x, a.hello.spawn.y], [good.x, good.y]);
  const b = await join({ room: "re-1", x: 5, y: 5 }); // inside the void/wall area
  assert.equal(world.isSolidAt(b.hello.spawn.x, b.hello.spawn.y), false);
  a.close();
  b.close();
});

test("oversized frames close the connection", async () => {
  const c = new Client();
  await c.open;
  c.send({ t: "chat", text: "x".repeat(40_000) });
  const code = await c.closed;
  assert.equal(code, 1009);
});
