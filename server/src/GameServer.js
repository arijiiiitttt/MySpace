import { WebSocketServer } from "ws";
import { AVATARS, LIMITS, cleanRoomId, cleanText } from "./protocol.js";
import { Space } from "./Space.js";
import { TokenBucket, isNum, log, newId, safeEqual } from "./util.js";

const DEFAULT_ICE = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

/**
 * Owns the websocket server, the rooms, and the per-connection rules
 * (join handshake, rate limits, heartbeat). Game rules live in Room.
 */
export class GameServer {
  /**
   * @param worldOrWorlds  one world (a single-map server, used by tests) or { start, worlds: Map<id, world> }
   */
  constructor(worldOrWorlds, opts = {}) {
    const set = worldOrWorlds.worlds
      ? worldOrWorlds
      : { start: worldOrWorlds.id ?? "office", worlds: new Map([[worldOrWorlds.id ?? "office", worldOrWorlds]]) };
    this.worlds = set.worlds;
    this.startMap = set.start;
    this.world = this.worlds.get(this.startMap); // the map newcomers start on
    this.opts = {
      maxRoomPlayers: 40,
      maxRooms: 100,
      maxConnsPerIp: 12,
      tickMs: 50,
      heartbeatMs: 25_000,
      joinTimeoutMs: 15_000,
      ice: DEFAULT_ICE,
      allowedOrigins: [],
      trustProxy: false,
      ...opts,
    };
    this.rooms = new Map();
    this.connsByIp = new Map();
    this.wss = null;
    this.timers = [];

    // The lobby always exists.
    this.getOrCreateRoom("lobby", { persistent: true });
  }

  // ---- lifecycle ----------------------------------------------------------

  attach(httpServer) {
    this.wss = new WebSocketServer({
      server: httpServer,
      maxPayload: LIMITS.MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      verifyClient: ({ origin }, done) => {
        const allowed = this.opts.allowedOrigins;
        if (allowed.length === 0 || allowed.includes("*") || !origin) return done(true);
        return allowed.includes(origin) ? done(true) : done(false, 403, "origin not allowed");
      },
    });
    // ws forwards the HTTP server's errors (e.g. EADDRINUSE); index.js reports them, so just don't throw.
    this.wss.on("error", () => {});
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));

    this.timers.push(setInterval(() => this.tick(), this.opts.tickMs));
    this.timers.push(setInterval(() => this.heartbeat(), this.opts.heartbeatMs));
    return this;
  }

  close() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.wss?.close();
  }

  tick() {
    for (const room of this.rooms.values()) room.flush();
  }

  heartbeat() {
    for (const ws of this.wss?.clients ?? []) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }

  // ---- rooms --------------------------------------------------------------

  getOrCreateRoom(id, { key = "", persistent = false } = {}) {
    let room = this.rooms.get(id);
    if (!room) {
      room = new Space(id, {
        worlds: this.worlds,
        start: this.startMap,
        key,
        persistent,
        max: this.opts.maxRoomPlayers,
        send: (player, obj) => this.send(player.ws, obj),
      });
      this.rooms.set(id, room);
      log.info(`room created: ${id}${key ? " (locked)" : ""}`);
    }
    return room;
  }

  /** Public numbers for the landing page / room picker. Locked rooms stay private. */
  stats() {
    let online = 0;
    const rooms = [];
    for (const room of this.rooms.values()) {
      online += room.size;
      if (!room.locked && (room.size > 0 || room.persistent)) {
        rooms.push({ id: room.id, players: room.size, max: room.max });
      }
    }
    rooms.sort((a, b) => b.players - a.players || a.id.localeCompare(b.id));
    return { online, rooms };
  }

  // ---- connections --------------------------------------------------------

  clientIp(req) {
    if (this.opts.trustProxy) {
      const fwd = req.headers["x-forwarded-for"];
      if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  send(ws, obj) {
    if (ws.readyState !== 1) return;
    // A client that can't keep up would make us buffer without bound.
    if (ws.bufferedAmount > 1_000_000) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(obj));
  }

  onConnection(ws, req) {
    const ip = this.clientIp(req);
    const count = (this.connsByIp.get(ip) ?? 0) + 1;
    if (count > this.opts.maxConnsPerIp) {
      ws.close(1013, "too many connections");
      return;
    }
    this.connsByIp.set(ip, count);

    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    const conn = {
      ws,
      player: null,
      room: null, // the Space (room) this connection is in
      bucket: new TokenBucket(120, 240), // everything: movement, signalling bursts...
      chatBucket: new TokenBucket(0.6, 5),
      emoteBucket: new TokenBucket(1.5, 3),
      portalBucket: new TokenBucket(1, 3),
    };

    const joinTimer = setTimeout(() => {
      if (!conn.player) ws.close(4000, "join timeout");
    }, this.opts.joinTimeoutMs);

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      if (!conn.bucket.take()) return ws.close(1008, "rate limit");
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
      try {
        this.dispatch(conn, msg);
      } catch (err) {
        log.warn("handler error:", msg.t, err);
      }
    });

    ws.on("close", () => {
      clearTimeout(joinTimer);
      const left = (this.connsByIp.get(ip) ?? 1) - 1;
      if (left <= 0) this.connsByIp.delete(ip);
      else this.connsByIp.set(ip, left);
      this.leave(conn);
    });

    ws.on("error", () => {});
  }

  leave(conn) {
    const { room, player } = conn;
    if (!room || !player) return;
    room.remove(player); // Space.remove: takes the player off whichever map they are on
    conn.room = conn.player = null;
    if (room.size === 0 && !room.persistent) {
      this.rooms.delete(room.id);
      log.info(`room closed: ${room.id}`);
    }
  }

  // ---- messages -----------------------------------------------------------

  dispatch(conn, msg) {
    if (msg.t === "ping") {
      return this.send(conn.ws, { t: "pong", n: isNum(msg.n) ? msg.n : 0 });
    }
    if (msg.t === "join") return this.join(conn, msg);

    const { player, room: space } = conn;
    if (!player || !space) return; // must join first
    const room = player.room; // the map they are standing on
    if (!room) return;

    switch (msg.t) {
      case "portal":
        return conn.portalBucket.take() && space.travel(player, msg.id);
      case "move":
        return room.move(player, msg);
      case "chat":
        return conn.chatBucket.take() ? room.chat(player, msg) : this.throttle(conn, "You're sending messages too fast.");
      case "emote":
        return conn.emoteBucket.take() && room.emote(player, msg);
      case "sit":
        return room.sit(player, msg);
      case "stand":
        return room.stand(player);
      case "pc":
        return room.useComputer(player, msg);
      case "share":
        return room.share(player, msg);
      case "media":
        return room.media(player, msg);
      case "profile":
        return room.profile(player, msg, AVATARS);
      case "rtc":
        return room.rtc(player, msg);
      default:
    }
  }

  throttle(conn, msg) {
    this.send(conn.ws, { t: "err", code: "slow_down", msg });
  }

  join(conn, m) {
    if (conn.player) return;
    const fail = (code, msg) => {
      this.send(conn.ws, { t: "err", code, msg, fatal: true });
      conn.ws.close(4001, code);
    };

    const roomId = m.room === undefined || m.room === "" ? "lobby" : cleanRoomId(m.room);
    if (!roomId) return fail("bad_room", "Room names use letters, numbers and dashes (max 24).");
    const key = typeof m.key === "string" ? m.key.slice(0, LIMITS.KEY_MAX) : "";

    let room = this.rooms.get(roomId);
    if (room) {
      if (room.locked && !safeEqual(room.key, key)) return fail("bad_key", "Wrong room password.");
    } else {
      if (this.rooms.size >= this.opts.maxRooms) return fail("server_full", "The server is full right now.");
      room = this.getOrCreateRoom(roomId, { key: roomId === "lobby" ? "" : key });
    }
    if (room.size >= room.max) return fail("room_full", "That room is full.");

    const mapId = typeof m.map === "string" && this.worlds.has(m.map) ? m.map : this.startMap;
    const world = this.worlds.get(mapId);
    const spawn =
      isNum(m.x) && isNum(m.y) && world.inBounds(m.x, m.y) && !world.isSolidAt(m.x, m.y)
        ? { x: m.x, y: m.y }
        : world.randomSpawn();

    const player = {
      id: newId(),
      ws: conn.ws,
      name: cleanText(m.name, LIMITS.NAME_MAX) || `Guest${1000 + Math.floor(Math.random() * 9000)}`,
      avatar: AVATARS.includes(m.avatar) ? m.avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)],
      x: spawn.x,
      y: spawn.y,
      a: "idle_down",
      seat: null,
      pc: null,
      mic: false,
      cam: false,
      lastMoveAt: Date.now(),
      violations: 0,
      room: null, // the map (area) they are on, set by Room.add
      lastPortalAt: 0,
    };

    conn.player = player;
    conn.room = room;
    room.add(player, this.opts.ice, mapId);
    log.info(`${player.name} (${player.id}) joined ${room.id} [${room.size}/${room.max}]`);
  }
}
