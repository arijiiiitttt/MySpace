import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { GameServer } from "../src/GameServer.js";
import { loadWorlds } from "../src/world.js";
import { log } from "../src/util.js";

log.quiet = true;
const set = loadWorlds();
const office = set.worlds.get("office");
const library = set.worlds.get("library");
let http, game, url;

before(async () => {
  http = createServer();
  game = new GameServer(set, { tickMs: 10, maxRoomPlayers: 10, maxConnsPerIp: 50 }).attach(http);
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  url = `ws://127.0.0.1:${http.address().port}`;
});
after(() => {
  game.close();
  http.close();
});

class Client {
  constructor() {
    this.msgs = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => !w(m));
    });
    this.open = new Promise((r) => this.ws.on("open", r));
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  next(pred, ms = 1500) {
    const fn = typeof pred === "string" ? (m) => m.t === pred : pred;
    const found = this.msgs.find(fn);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${pred}`)), ms);
      this.waiters.push((m) => {
        if (!fn(m)) return false;
        clearTimeout(timer);
        resolve(m);
        return true;
      });
    });
  }
  clear() {
    this.msgs = [];
  }
  close() {
    this.ws.close();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const roomName = () => `portal-${++n}-${Date.now() % 100000}`;

async function join(room, opts = {}) {
  const c = new Client();
  await c.open;
  c.send({ t: "join", name: "T", avatar: "adam", room, ...opts });
  c.hello = await c.next((m) => m.t === "hello" || m.t === "err");
  return c;
}

// a point standing on a portal pad (sprite centre)
const onPad = (world, id) => {
  const p = world.portalById.get(id);
  return { x: p.x + p.w / 2, y: p.y + p.h / 2 - 19 };
};

test("world data: every portal links to a portal that links back, and lands on walkable ground", () => {
  for (const [id, world] of set.worlds) {
    assert.ok(world.portals.length > 0, `${id} has a way out`);
    for (const p of world.portals) {
      const other = set.worlds.get(p.to)?.portalById.get(p.toPortal);
      assert.ok(other, `${id}:${p.id} points somewhere real`);
      assert.equal(other.to, id);
      assert.equal(other.toPortal, p.id);
      assert.equal(world.isSolidAt(p.land.x, p.land.y), false, `${id}:${p.id} landing is walkable`);
    }
  }
});

test("join: starts on the office, or on a valid requested map; junk falls back", async () => {
  const room = roomName();
  const a = await join(room);
  assert.equal(a.hello.map, "office");
  const b = await join(room, { map: "library" });
  assert.equal(b.hello.map, "library");
  assert.equal(library.isSolidAt(b.hello.spawn.x, b.hello.spawn.y), false);
  const c = await join(room, { map: "../../etc/passwd" });
  assert.equal(c.hello.map, "office");
  assert.deepEqual(a.hello.where, Object.fromEntries([...set.worlds.keys()].map((k) => [k, k === "office" ? 1 : 0])));
  [a, b, c].forEach((x) => x.close());
});

test("portal: walking onto a door moves you to the matching door on the other map", async () => {
  const room = roomName();
  const a = await join(room, onPad(office, "to-library"));
  a.send({ t: "portal", id: "to-library" });
  const m = await a.next("map");
  assert.equal(m.map, "library");
  const door = library.portalById.get("to-office");
  assert.equal(m.you.x, door.land.x);
  assert.equal(m.you.y, door.land.y);
  assert.deepEqual(m.players, []);
  a.close();
});

test("portal: too far from the door is refused, unknown doors are ignored", async () => {
  const room = roomName();
  const a = await join(room); // random office spawn, nowhere near a door
  a.send({ t: "portal", id: "to-library" });
  const err = await a.next((m) => m.t === "err");
  assert.equal(err.code, "too_far");
  a.send({ t: "portal", id: "nope" });
  a.send({ t: "portal" });
  await sleep(80);
  assert.equal(a.msgs.some((m) => m.t === "map"), false);
  a.close();
});

test("portal: cooldown stops instant ping-pong, then the way back works", async () => {
  const room = roomName();
  const a = await join(room, onPad(office, "to-lounge"));
  a.send({ t: "portal", id: "to-lounge" });
  await a.next("map");
  a.clear();
  a.send({ t: "portal", id: "to-office" }); // inside the cooldown
  await sleep(150);
  assert.equal(a.msgs.some((m) => m.t === "map"), false);
  await sleep(1200);
  a.send({ t: "portal", id: "to-office" });
  const back = await a.next("map");
  assert.equal(back.map, "office");
  a.close();
});

test("maps are separate worlds: movement, joins and leaves stay on their own map", async () => {
  const room = roomName();
  const inOffice = await join(room, { map: "office" });
  const inLib = await join(room, { map: "library" });
  const traveller = await join(room, onPad(office, "to-library"));
  inOffice.clear();
  inLib.clear();

  traveller.send({ t: "portal", id: "to-library" });
  await traveller.next("map");
  const left = await inOffice.next((m) => m.t === "left");
  assert.equal(left.id, traveller.hello.id);
  const joined = await inLib.next((m) => m.t === "joined");
  assert.equal(joined.p.id, traveller.hello.id);
  assert.equal((await traveller.next("map")).players.length, 1, "sees the person already in the library");

  // moves only reach people on the same map
  inOffice.clear();
  inLib.clear();
  const here = (await traveller.next("map")).you;
  traveller.send({ t: "move", x: here.x + 12, y: here.y, a: "run_right" });
  await sleep(120);
  assert.equal(inOffice.msgs.some((m) => m.t === "moves"), false);
  assert.ok(inLib.msgs.some((m) => m.t === "moves"));
  [inOffice, inLib, traveller].forEach((x) => x.close());
});

test("chat is shared across maps; player counts are announced", async () => {
  const room = roomName();
  const a = await join(room, { map: "office" });
  const b = await join(room, { map: "classroom" });
  a.clear();
  b.send({ t: "chat", text: "hello from class" });
  const heard = await a.next("chat");
  assert.equal(heard.text, "hello from class");
  const c = await join(room, { map: "lounge" });
  const where = await a.next((m) => m.t === "where" && m.c.lounge === 1);
  assert.equal(where.c.classroom, 1);
  assert.equal(c.hello.history.at(-1).text, "hello from class", "chat history follows you to a new map");
  [a, b, c].forEach((x) => x.close());
});

test("WebRTC signalling and screen-share rooms do not leak between maps", async () => {
  const room = roomName();
  const a = await join(room, { map: "office" });
  const b = await join(room, { map: "library" });
  b.clear();
  a.send({ t: "rtc", to: b.hello.id, ch: "av", d: { x: 1 } });
  await sleep(100);
  assert.equal(b.msgs.some((m) => m.t === "rtc"), false);
  [a, b].forEach((x) => x.close());
});

test("seats and computers are freed when you walk through a door", async () => {
  const room = roomName();
  const pc = office.computers[0];
  const a = await join(room, { x: pc.x, y: pc.y + 60 });
  const watcher = await join(room, { x: pc.x + 40, y: pc.y + 60 });
  a.send({ t: "pc", id: pc.id, on: true });
  await watcher.next((m) => m.t === "pc" && m.users.length === 1);
  // teleporting to a door is not allowed by the server, so use a second player standing on a pad
  const t = await join(room, onPad(office, "to-library"));
  t.send({ t: "pc", id: 0, on: true }); // far away: refused, nothing to free
  t.send({ t: "portal", id: "to-library" });
  await t.next("map");
  assert.equal(game.rooms.get(room).areas.get("library").size, 1);
  [a, watcher, t].forEach((x) => x.close());
});

test("leaving the room from another map cleans everything up", async () => {
  const room = roomName();
  const a = await join(room, onPad(office, "to-classroom"));
  a.send({ t: "portal", id: "to-classroom" });
  await a.next("map");
  const space = game.rooms.get(room);
  assert.equal(space.size, 1);
  a.close();
  await sleep(150);
  assert.equal(game.rooms.has(room), false, "empty custom room is disposed");
});
