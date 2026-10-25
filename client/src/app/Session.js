import { Network } from "../net/Network.js";
import { bus } from "./emitter.js";
import { store } from "./storage.js";

/**
 * Everything that is "true about the room right now": who is here, who sits
 * where, who is at which computer, the chat log. The Phaser scene, the DOM UI
 * and the voice layer all read from here and react to `bus` events.
 *
 * Bus events emitted:
 *   session:ready (hello)        session:reset (hello)   - after a reconnect
 *   map:change ({map})           - you walked through a door (players on the old map get player:left first)
 *   where (counts)               - how many people are on each map
 *   player:joined (p)  player:left (p)  player:update (p, changes)
 *   moves ([p])        snap ({x,y})
 *   chat (msg)         emote ({id,e})
 *   seat ({chair,id})  pc ({id,users,sharer})
 *   net:status (status, info)     net:latency (ms)
 *   toast ({text, kind})
 */
export class Session {
  net = new Network();
  /** @type {Map<string, any>} */
  players = new Map();
  /** chairId -> playerId */
  seats = new Map();
  /** computerId -> { users:string[], sharer:string|null } */
  pcs = new Map();
  chat = [];
  room = null;
  /** id of the map I am standing on */
  map = null;
  /** { mapId: playerCount } for the whole room */
  where = {};
  meId = null;
  iceServers = [];

  constructor() {
    const { net } = this;
    net.on("status", (status, info) => bus.emit("net:status", status, info));
    net.on("latency", (ms) => bus.emit("net:latency", ms));
    net.on("hello", (m) => this.#load(m, false));
    net.on("rehello", (m) => this.#load(m, true));
    net.on("map", (m) => this.#changeMap(m));
    net.on("where", ({ c }) => {
      this.where = c;
      bus.emit("where", c);
    });

    net.on("joined", ({ p, from }) => {
      const player = { ...p, isMe: false };
      this.players.set(p.id, player);
      bus.emit("player:joined", player, { from });
    });

    net.on("left", ({ id, to }) => {
      const p = this.players.get(id);
      if (!p) return;
      this.players.delete(id);
      for (const [chair, pid] of this.seats) if (pid === id) this.seats.delete(chair);
      bus.emit("player:left", p, { to });
    });

    net.on("moves", ({ m }) => {
      const changed = [];
      for (const [id, x, y, a] of m) {
        const p = this.players.get(id);
        if (!p || p.isMe) continue;
        p.x = x;
        p.y = y;
        p.a = a;
        changed.push(p);
      }
      if (changed.length) bus.emit("moves", changed);
    });

    net.on("snap", (pos) => bus.emit("snap", pos));

    net.on("chat", (m) => {
      this.#pushChat(m);
      bus.emit("chat", m);
    });

    net.on("emote", (m) => bus.emit("emote", m));

    net.on("seat", ({ chair, id }) => {
      if (id) this.seats.set(chair, id);
      else this.seats.delete(chair);
      const p = this.players.get(id ?? this.#seatOwnerBefore(chair));
      for (const pl of this.players.values()) {
        if (pl.seat === chair && pl.id !== id) pl.seat = null;
      }
      if (id && this.players.get(id)) this.players.get(id).seat = chair;
      bus.emit("seat", { chair, id, player: p });
    });

    net.on("pc", ({ id, users, sharer }) => {
      if (users.length) this.pcs.set(id, { users, sharer });
      else this.pcs.delete(id);
      for (const p of this.players.values()) {
        p.pc = null;
      }
      for (const [pcId, st] of this.pcs) for (const uid of st.users) {
        const p = this.players.get(uid);
        if (p) p.pc = pcId;
      }
      bus.emit("pc", { id, users, sharer });
    });

    net.on("media", ({ id, mic, cam }) => {
      const p = this.players.get(id);
      if (!p) return;
      Object.assign(p, { mic, cam });
      bus.emit("player:update", p, { mic, cam });
    });

    net.on("player", ({ id, ...changes }) => {
      const p = this.players.get(id);
      if (!p) return;
      Object.assign(p, changes);
      if (p.isMe) store.set("profile", { name: p.name, avatar: p.avatar });
      bus.emit("player:update", p, changes);
    });

    net.on("err", (m) => {
      if (!m.fatal) bus.emit("toast", { text: m.msg, kind: "warn" });
    });
  }

  get me() {
    return this.players.get(this.meId) ?? null;
  }

  /** Resolves with the hello message, rejects with an Error (has `.code`). */
  async join(params) {
    this.joinParams = params;
    this.net.setPositionProvider(() => {
      const me = this.me;
      return me ? { x: me.x, y: me.y, map: this.map } : {};
    });
    return this.net.connect(params);
  }

  leave() {
    this.net.close();
  }

  // ---- actions ------------------------------------------------------------

  sendMove(x, y, a) {
    this.net.send({ t: "move", x: Math.round(x), y: Math.round(y), a });
  }
  sendChat(text) {
    const clean = text.trim();
    if (clean) this.net.send({ t: "chat", text: clean });
  }
  sendEmote(e) {
    this.net.send({ t: "emote", e });
  }
  /** Walk through a door. The server checks you are standing on it. */
  travel(portalId) {
    this.net.send({ t: "portal", id: portalId });
  }
  sit(chair) {
    this.net.send({ t: "sit", chair });
  }
  stand() {
    this.net.send({ t: "stand" });
  }
  useComputer(id, on) {
    this.net.send({ t: "pc", id, on });
  }
  share(id, on) {
    this.net.send({ t: "share", id, on });
  }
  announceMedia(mic, cam) {
    const me = this.me;
    if (me) Object.assign(me, { mic, cam });
    this.net.send({ t: "media", mic, cam });
  }
  updateProfile(changes) {
    this.net.send({ t: "profile", ...changes });
  }

  // ---- internals ----------------------------------------------------------

  #load(hello, isReconnect) {
    this.meId = hello.id;
    this.room = hello.room;
    this.map = hello.map;
    this.where = hello.where ?? {};
    this.iceServers = hello.ice ?? [];
    this.players.clear();
    this.seats.clear();
    this.pcs.clear();
    this.chat = [];

    this.players.set(hello.id, { ...hello.you, isMe: true });
    for (const p of hello.players) this.players.set(p.id, { ...p, isMe: false });
    for (const [chair, pid] of Object.entries(hello.seats ?? {})) this.seats.set(Number(chair), pid);
    for (const st of hello.pcs ?? []) this.pcs.set(st.id, { users: st.users, sharer: st.sharer });
    for (const p of this.players.values()) {
      p.pc = null;
    }
    for (const [pcId, st] of this.pcs) for (const uid of st.users) {
      const p = this.players.get(uid);
      if (p) p.pc = pcId;
    }
    for (const m of hello.history ?? []) this.#pushChat(m);

    bus.emit(isReconnect ? "session:reset" : "session:ready", hello);
  }

  /** The server moved me to another map: forget the old crowd, adopt the new one. */
  #changeMap(m) {
    for (const p of [...this.players.values()]) {
      if (!p.isMe) bus.emit("player:left", p, { silent: true }); // closes voice/video links, removes avatars
    }
    this.map = m.map;
    this.players.clear();
    this.seats.clear();
    this.pcs.clear();
    this.players.set(this.meId, { ...m.you, isMe: true });
    for (const p of m.players) this.players.set(p.id, { ...p, isMe: false });
    for (const [chair, pid] of Object.entries(m.seats ?? {})) this.seats.set(Number(chair), pid);
    for (const st of m.pcs ?? []) this.pcs.set(st.id, { users: st.users, sharer: st.sharer });
    for (const p of this.players.values()) p.pc = null;
    for (const [pcId, st] of this.pcs) {
      for (const uid of st.users) {
        const p = this.players.get(uid);
        if (p) p.pc = pcId;
      }
    }
    bus.emit("map:change", { map: m.map });
  }

  #pushChat(m) {
    this.chat.push(m);
    if (this.chat.length > 200) this.chat.shift();
  }

  #seatOwnerBefore(chair) {
    for (const p of this.players.values()) if (p.seat === chair) return p.id;
    return null;
  }
}
