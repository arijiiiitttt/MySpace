import { Room } from "./Room.js";

const PORTAL_REACH = 56; // px beyond the portal's edge you may stand and still use it
const PORTAL_COOLDOWN_MS = 1200;
const FOOT_OFFSET_Y = 19; // sprite centre -> feet

/**
 * One room (a lobby, a private room...) made of several maps. Each map is a `Room`
 * "area" with its own players, chairs and computers; the Space owns what is shared:
 * the name/password/capacity, the chat log, and moving people through portals.
 */
export class Space {
  constructor(id, { worlds, start, key = "", max = 40, persistent = false, send }) {
    this.id = id;
    this.key = key;
    this.max = max;
    this.persistent = persistent;
    this.start = start;
    this.history = [];
    this.send = send;
    /** @type {Map<string, Room>} */
    this.areas = new Map();
    for (const [mapId, world] of worlds) {
      this.areas.set(mapId, new Room(id, world, { key, max, persistent, send, space: this }));
    }
  }

  get size() {
    let n = 0;
    for (const area of this.areas.values()) n += area.size;
    return n;
  }

  get locked() {
    return Boolean(this.key);
  }

  info() {
    return { id: this.id, max: this.max, locked: this.locked };
  }

  area(mapId) {
    return this.areas.get(mapId) ?? this.areas.get(this.start);
  }

  /** How many people stand on each map: { office: 3, library: 1 } */
  counts() {
    const out = {};
    for (const [id, area] of this.areas) out[id] = area.size;
    return out;
  }

  broadcastAll(obj, exceptId = null) {
    for (const area of this.areas.values()) area.broadcast(obj, exceptId);
  }

  announce() {
    this.broadcastAll({ t: "where", c: this.counts() });
  }

  flush() {
    for (const area of this.areas.values()) area.flush();
  }

  /** First arrival (join / reconnect). */
  add(player, ice, mapId) {
    this.area(mapId).add(player, ice);
    this.announce();
  }

  remove(player) {
    player.room?.remove(player);
    this.announce();
  }

  /** Walk through a portal: validated, then the player appears at the matching door on the other map. */
  travel(player, portalId) {
    const from = player.room;
    if (!from) return;
    const portal = from.world.portalById.get(String(portalId));
    if (!portal) return;
    const now = Date.now();
    if (now - (player.lastPortalAt ?? 0) < PORTAL_COOLDOWN_MS) return;

    const fx = player.x;
    const fy = player.y + FOOT_OFFSET_Y;
    const near =
      fx >= portal.x - PORTAL_REACH && fx <= portal.x + portal.w + PORTAL_REACH &&
      fy >= portal.y - PORTAL_REACH && fy <= portal.y + portal.h + PORTAL_REACH;
    if (!near) {
      return this.send(player, { t: "err", code: "too_far", msg: "Walk onto the door first." });
    }

    const to = this.areas.get(portal.to);
    const door = to?.world.portalById.get(portal.toPortal);
    if (!to || !door) return;

    from.remove(player, { to: portal.to }); // frees the seat / computer and tells the old map
    const land = to.world.isSolidAt(door.land.x, door.land.y) ? to.world.randomSpawn() : door.land;
    player.x = land.x;
    player.y = land.y;
    player.a = "idle_down";
    player.lastMoveAt = now;
    player.lastPortalAt = now;
    to.add(player, null, { travel: true, from: from.world.id });
    this.announce();
  }
}
