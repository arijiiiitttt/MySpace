import { ANIM_RE, EMOTES, LIMITS, cleanText } from "./protocol.js";
import { isNum } from "./util.js";

const MAX_SPEED = 240; // px/s. The client runs at 200; the rest is network jitter slack.
const SLACK_PX = 24;
const SIT_REACH = 110; // how close you must be to a chair to sit on it
const PC_REACH = 150; // ... and to a computer to use it

/** What other clients are allowed to know about a player. */
export const publicPlayer = (p) => ({
  id: p.id,
  name: p.name,
  avatar: p.avatar,
  x: Math.round(p.x),
  y: Math.round(p.y),
  a: p.a,
  seat: p.seat,
  mic: p.mic,
  cam: p.cam,
});

/**
 * One map inside a room (an "area"). Holds every player standing on it, who sits
 * where, who is at which computer. A Space (Space.js) groups the areas of one
 * room and shares chat between them. All input is untrusted: every handler
 * validates before touching state.
 */
export class Room {
  constructor(id, world, { key = "", max = 40, persistent = false, send, space = null }) {
    this.id = id;
    this.world = world;
    this.key = key;
    this.max = max;
    this.persistent = persistent;
    this.send = send; // (player, obj) => void   (injected so tests can stub it)
    this.space = space; // the room this map belongs to (null when used on its own)

    /** @type {Map<string, any>} */
    this.players = new Map();
    this.seats = new Map(); // chairId -> playerId
    this.computers = new Map(); // computerId -> { users:Set<string>, sharer:string|null }
    this.history = [];
    this.dirty = new Map(); // playerId -> [id,x,y,a]
  }

  get size() {
    return this.players.size;
  }

  get locked() {
    return Boolean(this.key);
  }

  broadcast(obj, exceptId = null) {
    for (const p of this.players.values()) {
      if (p.id !== exceptId) this.send(p, obj);
    }
  }

  // ---- membership ---------------------------------------------------------

  /**
   * Put a player on this map. `travel` = they came through a portal (they already know the
   * room), so they get a `map` message instead of a full `hello`.
   */
  add(player, ice, { travel = false, from = null } = {}) {
    this.players.set(player.id, player);
    player.room = this;
    const state = {
      you: publicPlayer(player),
      map: this.world.id,
      spawn: { x: Math.round(player.x), y: Math.round(player.y) },
      players: [...this.players.values()].filter((p) => p !== player).map(publicPlayer),
      seats: Object.fromEntries(this.seats),
      pcs: [...this.computers.keys()].map((id) => this.pcState(id)).filter((s) => s.users.length),
      serverTime: Date.now(),
    };
    if (travel) {
      this.send(player, { t: "map", ...state });
    } else {
      const hub = this.space ?? this;
      this.send(player, {
        t: "hello",
        id: player.id,
        ...state,
        room: this.space ? this.space.info() : { id: this.id, max: this.max, locked: this.locked },
        history: hub.history,
        where: this.space?.counts(),
        ice,
      });
    }
    this.broadcast({ t: "joined", p: publicPlayer(player), ...(travel && from && { from }) }, player.id);
  }

  remove(player, { to = null } = {}) {
    if (!this.players.has(player.id)) return;
    this.releaseSeat(player, { silent: true });
    this.leaveComputer(player);
    this.players.delete(player.id);
    this.dirty.delete(player.id);
    if (player.room === this) player.room = null;
    this.broadcast({ t: "left", id: player.id, ...(to && { to }) });
  }

  // ---- movement -----------------------------------------------------------

  move(player, m, now = Date.now()) {
    if (player.seat !== null) return; // seated players must stand up first
    const { x, y } = m;
    if (!isNum(x) || !isNum(y) || !this.world.inBounds(x, y)) return this.snap(player);

    const dt = Math.min(1, Math.max(0.02, (now - player.lastMoveAt) / 1000));
    const reach = MAX_SPEED * dt + SLACK_PX;
    const tooFar = Math.hypot(x - player.x, y - player.y) > reach;
    // "Not worse than where you already are": lets you walk out of a spot that
    // the map data considers solid (e.g. standing up from a chair).
    const intoWall = this.world.isSolidAt(x, y) && !this.world.isSolidAt(player.x, player.y);
    if (tooFar || intoWall) return this.snap(player);

    player.x = x;
    player.y = y;
    player.lastMoveAt = now;
    if (typeof m.a === "string" && ANIM_RE.test(m.a)) player.a = m.a;
    this.dirty.set(player.id, [player.id, Math.round(x), Math.round(y), player.a]);
  }

  snap(player) {
    player.violations += 1;
    this.send(player, { t: "snap", x: Math.round(player.x), y: Math.round(player.y) });
  }

  /** Called ~20x per second: ships every position change in one frame. */
  flush() {
    if (this.dirty.size === 0) return;
    const m = [...this.dirty.values()];
    this.dirty.clear();
    this.broadcast({ t: "moves", m });
  }

  // ---- chairs -------------------------------------------------------------

  sit(player, m) {
    const chair = this.world.chairById.get(Number(m.chair));
    if (!chair || player.seat !== null) return;
    const holder = this.seats.get(chair.id);
    if (holder && holder !== player.id) {
      return this.send(player, { t: "err", code: "seat_taken", msg: "Someone is already sitting there." });
    }
    if (Math.hypot(player.x - chair.x, player.y - chair.y) > SIT_REACH) {
      return this.send(player, { t: "err", code: "too_far", msg: "Walk closer to the chair first." });
    }
    const pos = this.world.sitPosition(chair);
    this.seats.set(chair.id, player.id);
    player.seat = chair.id;
    player.x = pos.x;
    player.y = pos.y;
    player.a = `sit_${chair.dir}`;
    player.lastMoveAt = Date.now();
    this.dirty.set(player.id, [player.id, Math.round(pos.x), Math.round(pos.y), player.a]);
    this.broadcast({ t: "seat", chair: chair.id, id: player.id });
  }

  stand(player) {
    this.releaseSeat(player);
  }

  releaseSeat(player, { silent = false } = {}) {
    if (player.seat === null) return;
    const chairId = player.seat;
    this.seats.delete(chairId);
    player.seat = null;
    player.a = player.a.replace(/^sit_/, "idle_");
    player.lastMoveAt = Date.now();
    // `silent` only skips the position update (the player is about to vanish);
    // everyone still needs to hear that the chair is free again.
    if (!silent) {
      this.dirty.set(player.id, [player.id, Math.round(player.x), Math.round(player.y), player.a]);
    }
    this.broadcast({ t: "seat", chair: chairId, id: null }, silent ? player.id : null);
  }

  // ---- computers (screen sharing) -----------------------------------------

  pcState(id) {
    const c = this.computers.get(id);
    return { id, users: c ? [...c.users] : [], sharer: c?.sharer ?? null };
  }

  useComputer(player, m) {
    const id = Number(m.id);
    const pc = this.world.computerById.get(id);
    if (!pc) return;
    if (!m.on) return this.leaveComputer(player);
    if (player.pc === id) return;
    if (Math.hypot(player.x - pc.x, player.y - pc.y) > PC_REACH) {
      return this.send(player, { t: "err", code: "too_far", msg: "Walk closer to the computer first." });
    }
    this.leaveComputer(player);
    if (!this.computers.has(id)) this.computers.set(id, { users: new Set(), sharer: null });
    this.computers.get(id).users.add(player.id);
    player.pc = id;
    this.broadcast({ t: "pc", ...this.pcState(id) });
  }

  leaveComputer(player) {
    if (player.pc === null) return;
    const id = player.pc;
    const c = this.computers.get(id);
    player.pc = null;
    if (!c) return;
    c.users.delete(player.id);
    if (c.sharer === player.id) c.sharer = null;
    if (c.users.size === 0) this.computers.delete(id);
    this.broadcast({ t: "pc", ...this.pcState(id) });
  }

  share(player, m) {
    const id = Number(m.id);
    const c = this.computers.get(id);
    if (!c || player.pc !== id) return;
    if (m.on) {
      if (c.sharer && c.sharer !== player.id) {
        return this.send(player, { t: "err", code: "busy", msg: "Someone is already presenting here." });
      }
      c.sharer = player.id;
    } else if (c.sharer === player.id) {
      c.sharer = null;
    } else {
      return;
    }
    this.broadcast({ t: "pc", ...this.pcState(id) });
  }

  // ---- social -------------------------------------------------------------

  chat(player, m) {
    const text = cleanText(m.text, LIMITS.CHAT_MAX);
    if (!text) return;
    const msg = { t: "chat", id: player.id, name: player.name, text, ts: Date.now() };
    const hub = this.space ?? this; // chat is shared by every map of a room
    hub.history.push(msg);
    if (hub.history.length > LIMITS.CHAT_HISTORY) hub.history.shift();
    if (this.space) this.space.broadcastAll(msg);
    else this.broadcast(msg);
  }

  emote(player, m) {
    if (!EMOTES.includes(m.e)) return;
    this.broadcast({ t: "emote", id: player.id, e: m.e });
  }

  media(player, m) {
    player.mic = m.mic === true;
    player.cam = m.cam === true;
    this.broadcast({ t: "media", id: player.id, mic: player.mic, cam: player.cam }, player.id);
  }

  profile(player, m, avatars) {
    const update = {};
    const name = cleanText(m.name, LIMITS.NAME_MAX);
    if (name && name !== player.name) update.name = player.name = name;
    if (avatars.includes(m.avatar) && m.avatar !== player.avatar) update.avatar = player.avatar = m.avatar;
    if (Object.keys(update).length) this.broadcast({ t: "player", id: player.id, ...update });
  }

  /** WebRTC signalling: we only forward, never inspect SDP. */
  rtc(player, m) {
    const target = this.players.get(m.to);
    if (!target || target.id === player.id) return;
    const ch = m.ch === "screen" ? "screen" : "av";
    let size = 0;
    try {
      size = JSON.stringify(m.d ?? null).length;
    } catch {
      return;
    }
    if (size > LIMITS.RTC_PAYLOAD_MAX) return;
    let pc;
    if (ch === "screen") {
      pc = Number(m.pc);
      // Screen streams only flow between people who are at that computer.
      if (player.pc !== pc || target.pc !== pc) return;
    }
    this.send(target, { t: "rtc", from: player.id, ch, pc, d: m.d });
  }
}
