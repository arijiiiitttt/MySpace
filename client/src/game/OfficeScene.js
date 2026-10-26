import Phaser from "phaser";
import { bus } from "../app/emitter.js";
import { store } from "../app/storage.js";
import { SIT_SHIFT } from "./animations.js";
import { MyAvatar, RemoteAvatar, WALK_SPEED } from "./Avatar.js";
import { mapInfo } from "./maps.js";
import { GLYPH, FA_FAMILY } from "../ui/fa.js";
import { BODY, NavGrid } from "./nav.js";
import { buildOffice } from "./office.js";

const SEND_EVERY_MS = 50;
const ZOOM_STEPS = [1, 1.5, 2, 2.5, 3];
const REACH = { chair: 62, computer: 92, vending: 72 };
const LEAVE_COMPUTER_DISTANCE = 210;

const isTyping = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};

/**
 * The office. Everything that moves or is drawn on the map lives here; the
 * session (who is where) and the DOM labels are injected by the app shell.
 */
export class OfficeScene extends Phaser.Scene {
  constructor() {
    super("office");
  }

  init({ session, labels }) {
    this.session = session;
    this.labels = labels;
  }

  create() {
    const { session, labels } = this;
    this.unsubs = [];
    this.remotes = new Map();
    this.path = [];
    this.pending = null; // { type: "sit" | "computer" | "vending", item }
    this.joy = { x: 0, y: 0 };
    this.nextSendAt = 0;
    this.lastSent = { x: NaN, y: NaN, a: "" };
    this.usingComputer = null;
    this.stuck = { x: 0, y: 0, ms: 0 };
    this.travelling = false; // I stepped on a door and am waiting for the server to move me
    this.portalMs = 0; // how long I have been standing on a door

    // ---- world -----------------------------------------------------------
    this.cameras.main.setBackgroundColor("#070b18");
    this.void = this.add.tileSprite(0, 0, this.scale.width, this.scale.height, "void_tile").setOrigin(0).setScrollFactor(0).setDepth(-10);
    this.office = buildOffice(this, session.map);
    this.#drawPortals();
    this.nav = new NavGrid({ width: this.office.width, height: this.office.height }, this.office.solidAt, this.office.rects);
    this.keys = this.#makeKeys();

    // ---- me ---------------------------------------------------------------
    const meData = session.me;
    this.me = new MyAvatar(this, meData);
    this.office.colliders.forEach((c) => this.physics.add.collider(this.me.sprite, c));
    this.physics.add.collider(this.me.sprite, this.office.ground);
    labels.add(meData.id, { name: meData.name, isMe: true });
    labels.setMedia(meData.id, meData);

    // ---- camera -----------------------------------------------------------
    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.office.width, this.office.height);
    this.zoomIndex = ZOOM_STEPS.indexOf(store.get("zoom", 2));
    if (this.zoomIndex < 0) this.zoomIndex = 2;
    cam.setZoom(this.#autoZoom(ZOOM_STEPS[this.zoomIndex]));
    cam.startFollow(this.me.sprite, true, 0.12, 0.12);
    cam.centerOn(this.me.x, this.me.y);

    // ---- others -----------------------------------------------------------
    for (const p of session.players.values()) if (!p.isMe) this.#addRemote(p);
    for (const [chair, id] of session.seats) this.#assignSeat(chair, id);
    this.#restoreSeatAfterJoin(meData);

    // ---- input ------------------------------------------------------------
    this.input.on("pointerdown", (pointer) => this.#onPointerDown(pointer));
    this.input.on("pointermove", (pointer) => this.#onPointerMove(pointer));
    this.input.on("wheel", (_p, _o, _dx, dy) => this.#zoomBy(dy < 0 ? 1 : -1));
    this.keys.E.on("down", () => !isTyping() && this.#pressE());
    this.keys.R.on("down", () => !isTyping() && this.#pressR());
    this.keys.ESC.on("down", () => this.#cancelAll());

    // ---- network / UI events ---------------------------------------------
    const on = (type, fn) => this.unsubs.push(bus.on(type, fn));
    on("player:joined", (p) => this.#addRemote(p));
    on("player:left", (p) => this.#removeRemote(p.id));
    on("player:update", (p, changes) => this.#onPlayerUpdate(p, changes));
    on("moves", (list) => list.forEach((p) => this.remotes.get(p.id)?.setTarget(p.x, p.y, p.a)));
    on("seat", ({ chair, id }) => this.#onSeat(chair, id));
    on("snap", (pos) => this.#onSnap(pos));
    on("chat", (m) => labels.say(m.id, m.text));
    on("emote", (m) => labels.emote(m.id, m.e));
    on("session:reset", () => this.#onReset());
    // I went through a door: the session now describes the new map, so rebuild the scene around it
    on("map:change", () => this.scene.restart({ session, labels }));
    on("ui:goto", (pos) => this.#goTo(pos.x, pos.y - BODY.cy));
    on("ui:joystick", (v) => (this.joy = v));
    on("ui:zoom", (dir) => this.#zoomBy(dir));
    on("ui:leave-computer", () => this.#leaveComputer());
    on("ui:interact", (kind) => (kind === "E" ? this.#pressE() : this.#pressR()));

    const onResize = () => {
      this.void.setSize(this.scale.width, this.scale.height);
      cam.setZoom(this.#autoZoom(ZOOM_STEPS[this.zoomIndex]));
    };
    this.scale.on("resize", onResize);
    this.unsubs.push(() => this.scale.off("resize", onResize));

    this.events.once("shutdown", () => this.#teardown());

    bus.emit("office:ready", {
      width: this.office.width,
      height: this.office.height,
      solidAt: this.office.solidAt,
      rects: this.office.rects,
      chairs: this.office.chairs,
      computers: this.office.computers,
      vending: this.office.vending,
    });
  }

  // ---- frame loop --------------------------------------------------------

  update(time, dt) {
    const { me, labels, session } = this;
    const typing = isTyping();

    // Parallax void background
    const cam = this.cameras.main;
    this.void.tilePositionX = cam.scrollX * 0.4;
    this.void.tilePositionY = cam.scrollY * 0.4;

    // ---- my movement ------------------------------------------------------
    const seated = !!me.seatChair;
    let ix = 0;
    let iy = 0;
    if (!typing) {
      const k = this.keys;
      ix = (k.RIGHT.isDown || k.D.isDown ? 1 : 0) - (k.LEFT.isDown || k.A.isDown ? 1 : 0);
      iy = (k.DOWN.isDown || k.S.isDown ? 1 : 0) - (k.UP.isDown || k.W.isDown ? 1 : 0);
    }
    if (Math.hypot(this.joy.x, this.joy.y) > 0.25) {
      ix = this.joy.x;
      iy = this.joy.y;
    }
    const manual = ix !== 0 || iy !== 0;

    if (seated) {
      if (manual) this.#stand();
    } else {
      if (manual && this.path.length) this.#cancelPath();
      let speed = WALK_SPEED;
      if (!manual && this.path.length) [ix, iy, speed] = this.#pathStep(time, dt);
      me.walk(ix, iy, speed);
      if (manual && this.pending) this.pending = null;
    }
    me.updateDepth();

    // keep my record in the session fresh (reconnect + minimap read it)
    const meData = session.me;
    if (meData) {
      meData.x = me.x;
      meData.y = me.y;
      meData.a = me.animKey;
    }

    // ---- tell the server ----------------------------------------------------
    if (!seated && time >= this.nextSendAt) {
      const a = me.animKey;
      const moved = Math.abs(me.x - this.lastSent.x) > 0.5 || Math.abs(me.y - this.lastSent.y) > 0.5;
      if (moved || a !== this.lastSent.a) {
        session.sendMove(me.x, me.y, a);
        this.lastSent = { x: me.x, y: me.y, a };
        this.nextSendAt = time + SEND_EVERY_MS;
      }
    }

    // ---- others ------------------------------------------------------------
    for (const r of this.remotes.values()) {
      r.update(dt);
      labels.anchor(r.id, r.labelAnchor.x, r.labelAnchor.y);
    }
    labels.anchor(me.id, me.labelAnchor.x, me.labelAnchor.y);

    // ---- computers: walking away ends the session ----------------------------
    if (this.usingComputer !== null) {
      const pc = this.office.computers[this.usingComputer];
      if (!pc || Math.hypot(me.x - pc.x, me.y - pc.y) > LEAVE_COMPUTER_DISTANCE) this.#leaveComputer();
    }

    this.#checkPortals(dt, seated);
    this.#updatePrompt();
    labels.update(cam);
  }

  // ---- doors to other maps ---------------------------------------------------

  #drawPortals() {
    const font = '"Pixelify Sans", system-ui, sans-serif';
    // outline of an arched opening: straight sides + a half-round top
    const arch = (cx, base, w, h) => {
      const r = w / 2;
      const pts = [{ x: cx - r, y: base }];
      for (let i = 0; i <= 14; i++) {
        const a = Math.PI - (i / 14) * Math.PI;
        pts.push({ x: cx + Math.cos(a) * r, y: base - h + r - Math.sin(a) * r });
      }
      pts.push({ x: cx + r, y: base });
      return pts;
    };
    const mix = (c1, c2, t) => {
      const ch = (c, sh) => (c >> sh) & 255;
      const m = (sh) => Math.round(ch(c1, sh) + (ch(c2, sh) - ch(c1, sh)) * t);
      return (m(16) << 16) | (m(8) << 8) | m(0);
    };
    for (const p of this.office.portals) {
      const W = Math.min(p.w, 80);
      const H = 82;
      p.tw = W; // the doorway is narrower than its trigger pad
      const cx = p.x + p.w / 2;
      const base = p.y + p.h - 4;
      const top = base - H;

      // soft light spilling out of the tunnel mouth (below people)
      const floor = this.add.graphics().setDepth(2);
      floor.fillStyle(0x5eead4, 0.13).fillEllipse(cx, base + 2, W + 30, 26);
      floor.fillStyle(0x1b2733, 0.95).fillRoundedRect(cx - W / 2 + 6, base - 12, W - 12, 12, 3);
      for (let i = 0; i < 3; i++) floor.fillStyle(0x5eead4, 0.55).fillRect(cx - W / 2 + 14 + i * ((W - 36) / 2), base - 8, 8, 3);

      // the tunnel itself: stone ring, then arches that shrink and darken into the distance
      const g = this.add.graphics().setDepth(top);
      g.fillStyle(0x000000, 0.28).fillEllipse(cx, base + 3, W + 14, 12);
      g.fillStyle(0x6b7480, 1).fillPoints(arch(cx, base, W, H), true);
      g.lineStyle(2, 0x9aa3ad, 1).strokePoints(arch(cx, base, W, H), true);
      // brick joints on the ring
      g.lineStyle(1, 0x535b67, 0.9);
      for (let i = 1; i < 7; i++) {
        const a = Math.PI - (i / 7) * Math.PI;
        const r = W / 2;
        const ox = cx + Math.cos(a) * r;
        const oy = top + r - Math.sin(a) * r;
        g.lineBetween(ox, oy, ox - Math.cos(a) * 9, oy + Math.sin(a) * 9);
      }
      g.fillStyle(0x8892a0, 1).fillRect(cx - 5, top - 2, 10, 5); // keystone
      const N = 6;
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const w = (W - 22) * (1 - 0.62 * t);
        const h = (H - 14) * (1 - 0.52 * t);
        const b = base - 3 - t * 20;
        g.fillStyle(mix(0x15303d, 0x02080e, t), 1).fillPoints(arch(cx, b, w, h), true);
        g.lineStyle(1, mix(0x2b5566, 0x07141d, t), 1).strokePoints(arch(cx, b, w, h), true);
        if (i % 2 === 0) {
          // wall lamps getting smaller down the tunnel
          const lampY = b - h * 0.45;
          g.fillStyle(0xf3d36b, 0.9).fillRect(cx - w / 2 + 1, lampY, 3, 4).fillRect(cx + w / 2 - 4, lampY, 3, 4);
        }
      }
      // floor lines running into the distance
      g.lineStyle(1, 0x3a6b7c, 0.55);
      for (const k of [-0.28, 0, 0.28]) g.lineBetween(cx + k * (W - 22), base - 4, cx + k * (W - 22) * 0.38, base - 23);

      // bright end of the tunnel (pulses)
      const end = this.add.graphics().setDepth(top + 1);
      const ew = (W - 22) * 0.34;
      end.fillGradientStyle(0xd9fffa, 0xd9fffa, 0x5eead4, 0x5eead4, 0.95, 0.95, 0.85, 0.85);
      end.fillPoints(arch(cx, base - 22, ew, (H - 14) * 0.46), true);
      this.tweens.add({ targets: end, alpha: { from: 0.55, to: 1 }, duration: 1000, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });

      const target = mapInfo(p.to);
      const labelY = top - 6;
      const label = this.add
        .text(cx, labelY, p.label, { fontFamily: font, fontSize: "12px", color: "#d9fffa", stroke: "#04101c", strokeThickness: 4 })
        .setOrigin(0.5, 1)
        .setResolution(2)
        .setDepth(8999);
      const glyph = GLYPH[target.icon];
      if (glyph) {
        const ico = this.add
          .text(0, labelY, glyph, { fontFamily: FA_FAMILY, fontStyle: "900", fontSize: "12px", color: "#5eead4", stroke: "#04101c", strokeThickness: 4 })
          .setOrigin(1, 1)
          .setResolution(2)
          .setDepth(8999);
        ico.x = cx - label.width / 2 - 6;
        // keep the pair centred on the door
        const shift = (ico.width + 6) / 2;
        label.x += shift;
        ico.x += shift;
      }
    }
  }

  /** Standing on a door for a moment takes you through it. */
  #checkPortals(dt, seated) {
    const { me } = this;
    if (seated || this.travelling || !this.office.portals.length) return;
    const fx = me.x;
    const fy = me.y + BODY.cy;
    const on = this.office.portals.find((p) => Math.abs(fx - (p.x + p.w / 2)) < (p.tw ?? p.w) / 2 && fx > p.x + 4 && fx < p.x + p.w - 4 && fy > p.y + 4 && fy < p.y + p.h - 4);
    if (!on) {
      this.portalMs = 0;
      return;
    }
    // click-walking past a door must not take it: only count the dwell if the walk ends on this pad
    const end = this.path[this.path.length - 1];
    if (end && !(end.x > on.x && end.x < on.x + on.w && end.y + BODY.cy > on.y && end.y + BODY.cy < on.y + on.h)) {
      this.portalMs = 0;
      return;
    }
    this.portalMs += dt;
    if (this.portalMs < 220) return;
    this.travelling = true;
    this.#cancelAll();
    me.stop();
    this.session.travel(on.id);
    // If the server says no (cooldown, lag), let the player try again.
    this.time.delayedCall(2500, () => {
      this.travelling = false;
      this.portalMs = 0;
    });
  }

  // ---- movement helpers ---------------------------------------------------

  /** @returns {[number, number, number]} direction x, y and the speed to use this frame */
  #pathStep(time, dt) {
    const { me } = this;
    const wp = this.path[0];
    const dx = wp.x - me.x;
    const dy = wp.y - me.y;
    const dist = Math.hypot(dx, dy);

    // stuck detection: no progress for 600 ms of *game* time -> give up instead of grinding
    // on a wall. (Game time, not wall-clock, so a slow device doesn't trigger it falsely.)
    this.stuck.ms += dt;
    if (this.stuck.ms > 600) {
      if (Math.hypot(me.x - this.stuck.x, me.y - this.stuck.y) < 2) {
        this.#cancelPath();
        return [0, 0, WALK_SPEED];
      }
      this.stuck = { x: me.x, y: me.y, ms: 0 };
    }

    // Waypoints are verified-free cells, so when we're within about a frame's travel of one we
    // simply snap onto it. At 60 fps that is a ~3px nudge nobody can see; on a slow frame it stops
    // the character overshooting and circling the waypoint forever.
    const perFrame = WALK_SPEED * (Math.max(dt, 1) / 1000);
    if (dist <= Math.max(3.5, perFrame * 1.5)) {
      me.sprite.setPosition(wp.x, wp.y);
      me.body.reset(wp.x, wp.y);
      this.stuck = { x: wp.x, y: wp.y, ms: 0 };
      this.path.shift();
      if (!this.path.length) {
        this.#arrive();
        return [0, 0, WALK_SPEED];
      }
      return this.#pathStep(time, dt);
    }
    return [dx / dist, dy / dist, WALK_SPEED];
  }

  #goTo(x, y, pending = null) {
    if (this.me.seatChair) this.#stand();
    const path = this.nav.findPath({ x: this.me.x, y: this.me.y }, { x, y });
    this.pending = pending;
    this.path = path;
    this.stuck = { x: this.me.x, y: this.me.y, ms: 0 };
    if (!path.length) {
      // already there (or nowhere to go): run the action straight away if we can
      this.#arrive();
      return;
    }
    const end = path[path.length - 1];
    this.#spawnPing(end.x, end.y + BODY.cy);
  }

  #spawnPing(x, y) {
    const ring = this.add.circle(x, y, 3, 0xffffff, 0).setStrokeStyle(1.5, 0x7dd3fc, 1).setDepth(9000);
    this.tweens.add({ targets: ring, radius: 11, alpha: 0, duration: 450, ease: "Cubic.easeOut", onComplete: () => ring.destroy() });
  }

  #cancelPath() {
    this.path = [];
    this.pending = null;
  }

  #cancelAll() {
    this.#cancelPath();
    if (this.usingComputer !== null) this.#leaveComputer();
  }

  #arrive() {
    const p = this.pending;
    this.pending = null;
    this.path = [];
    if (!p) return;
    const { item, type } = p;
    if (Math.hypot(this.me.x - item.x, this.me.y - item.y) > REACH[type] + 24) return; // didn't actually make it
    if (type === "sit") this.session.sit(item.id);
    else if (type === "computer") this.#useComputer(item);
    else if (type === "vending") this.#useVending();
  }

  // ---- pointer ------------------------------------------------------------

  #itemAt(wx, wy) {
    const o = this.office;
    for (const c of o.computers) if (Math.abs(wx - c.x) <= c.w / 2 && Math.abs(wy - c.y) <= c.h / 2) return { type: "computer", item: c };
    for (const v of o.vending) if (Math.abs(wx - v.x) <= v.w / 2 && Math.abs(wy - v.y) <= v.h / 2) return { type: "vending", item: v };
    for (const c of o.chairs) if (Math.abs(wx - c.x) <= 18 && wy >= c.y - 22 && wy <= c.y + 26) return { type: "sit", item: c };
    return null;
  }

  #onPointerMove(pointer) {
    const hit = this.#itemAt(pointer.worldX, pointer.worldY);
    this.input.setDefaultCursor(hit ? "pointer" : "default");
  }

  #onPointerDown(pointer) {
    const { worldX: wx, worldY: wy } = pointer;
    const hit = this.#itemAt(wx, wy);
    if (hit) {
      if (hit.type === "sit" && this.session.seats.has(hit.item.id) && this.session.seats.get(hit.item.id) !== this.session.meId) {
        bus.emit("toast", { text: "Someone is already sitting there.", kind: "warn" });
        return;
      }
      this.#goTo(hit.item.x, hit.item.y + 14 - BODY.cy, hit);
      return;
    }
    this.#goTo(wx, wy - BODY.cy);
  }

  // ---- zoom -----------------------------------------------------------------

  #autoZoom(wanted) {
    // never zoom so far in that a phone screen shows only a few tiles
    const maxForScreen = Math.max(1, Math.min(this.scale.width / 360, this.scale.height / 300));
    return Math.min(wanted, Math.max(1, Math.round(maxForScreen * 2) / 2));
  }

  #zoomBy(dir) {
    const next = Phaser.Math.Clamp(this.zoomIndex + dir, 0, ZOOM_STEPS.length - 1);
    if (next === this.zoomIndex) return;
    this.zoomIndex = next;
    store.set("zoom", ZOOM_STEPS[next]);
    this.cameras.main.zoomTo(this.#autoZoom(ZOOM_STEPS[next]), 180);
  }

  // ---- keyboard ------------------------------------------------------------

  #makeKeys() {
    const kb = this.input.keyboard;
    // `false` = don't preventDefault, otherwise W/A/S/D/E/R could not be typed in the chat box.
    const K = Phaser.Input.Keyboard.KeyCodes;
    const keys = kb.addKeys(
      { W: K.W, A: K.A, S: K.S, D: K.D, E: K.E, R: K.R, UP: K.UP, DOWN: K.DOWN, LEFT: K.LEFT, RIGHT: K.RIGHT, ESC: K.ESC },
      false,
    );
    return keys;
  }

  // ---- interactions --------------------------------------------------------

  /**
   * What is in reach right now. E is for seats, R is for things you use, so they are
   * resolved separately: the office chair in front of a computer must not hide the computer.
   */
  #inReach() {
    const { me } = this;
    const nearest = (kind, items, radius) => {
      let best = null;
      let bestD = radius;
      for (const item of items) {
        const d = Math.hypot(me.x - item.x, me.y - item.y);
        if (d <= bestD) {
          bestD = d;
          best = { type: kind, item };
        }
      }
      return best;
    };
    const o = this.office;
    const computer = nearest("computer", o.computers, REACH.computer);
    const vending = nearest("vending", o.vending, REACH.vending);
    return {
      sit: nearest("sit", o.chairs, REACH.chair),
      use: computer ?? vending,
    };
  }

  #updatePrompt() {
    const { labels, me, session } = this;
    if (me.seatChair) {
      labels.showPrompt({ html: `<kbd>E</kbd> Stand up`, x: me.x, y: me.y + 30, onClick: () => this.#stand() });
      return;
    }
    if (this.usingComputer !== null) {
      const pc = this.office.computers[this.usingComputer];
      labels.showPrompt({ html: `<kbd>R</kbd> Leave computer`, x: pc.x, y: pc.y + 40, onClick: () => this.#leaveComputer() });
      return;
    }
    const { sit, use } = this.#inReach();
    if (!sit && !use) return labels.hidePrompt();

    const parts = [];
    let taken = false;
    if (use?.type === "computer") {
      const n = session.pcs.get(use.item.id)?.users.length ?? 0;
      parts.push(n ? `<kbd>R</kbd> Join computer <span class="muted">· ${n} here</span>` : `<kbd>R</kbd> Use computer`);
    } else if (use?.type === "vending") {
      parts.push(`<kbd>R</kbd> Grab a coffee`);
    }
    if (sit) {
      const holder = session.seats.get(sit.item.id);
      taken = !!holder && holder !== session.meId;
      parts.push(taken ? `Seat taken` : `<kbd>E</kbd> Sit down`);
    }
    const anchor = use ?? sit;
    labels.showPrompt({
      html: parts.join(`<span class="prompt-sep"></span>`),
      x: anchor.item.x,
      y: anchor.item.y + (anchor.type === "computer" ? 38 : anchor.type === "vending" ? 44 : 34),
      disabled: !use && taken,
      onClick: () => (use ? this.#pressR() : this.#pressE()),
    });
  }

  #pressE() {
    if (this.me.seatChair) return this.#stand();
    const { sit } = this.#inReach();
    if (!sit) return;
    const holder = this.session.seats.get(sit.item.id);
    if (holder && holder !== this.session.meId) {
      bus.emit("toast", { text: "Someone is already sitting there.", kind: "warn" });
      return;
    }
    this.#cancelPath();
    this.me.stop();
    this.session.sit(sit.item.id);
  }

  #pressR() {
    if (this.usingComputer !== null) return this.#leaveComputer();
    const { use } = this.#inReach();
    if (use?.type === "computer") this.#useComputer(use.item);
    else if (use?.type === "vending") this.#useVending();
  }

  #stand() {
    if (!this.me.seatChair) return;
    this.session.stand();
    this.me.standUp();
    this.#syncSeatFlag(null);
  }

  #useComputer(pc) {
    if (this.me.seatChair) this.#stand();
    this.#cancelPath();
    this.me.stop();
    this.usingComputer = pc.id;
    this.session.useComputer(pc.id, true);
    bus.emit("me:computer", pc.id);
  }

  #leaveComputer() {
    if (this.usingComputer === null) return;
    this.session.useComputer(this.usingComputer, false);
    this.usingComputer = null;
    bus.emit("me:computer", null);
  }

  #useVending() {
    this.#cancelPath();
    this.session.sendEmote("coffee");
    bus.emit("toast", { text: "Fresh coffee. Enjoy!", kind: "info" });
  }

  // ---- seats ---------------------------------------------------------------

  #syncSeatFlag(chairId) {
    const me = this.session.me;
    if (me) me.seat = chairId;
  }

  #restoreSeatAfterJoin() {
    // After a reconnect the server forgets our seat; make sure we are not frozen in a chair.
    if (this.me.seatChair && this.session.me?.seat == null) this.me.standUp();
  }

  #assignSeat(chairId, playerId) {
    const chair = this.office.chairs[chairId];
    if (!chair) return;
    if (playerId === this.session.meId) return;
    const r = this.remotes.get(playerId);
    if (r) r.seatChair = chair;
  }

  #onSeat(chairId, playerId) {
    const chair = this.office.chairs[chairId];
    if (!chair) return;
    const { session } = this;

    if (playerId === session.meId) {
      const [dx, dy] = SIT_SHIFT[chair.dir];
      this.#cancelPath();
      this.me.sitDown(chair, { x: chair.x + dx, y: chair.y + dy });
      this.#syncSeatFlag(chairId);
      return;
    }
    // someone else sat down / stood up
    for (const r of this.remotes.values()) if (r.seatChair === chair) r.seatChair = null;
    if (playerId) {
      const r = this.remotes.get(playerId);
      if (r) r.seatChair = chair;
    } else if (this.me.seatChair === chair && session.seats.get(chairId) !== session.meId) {
      // we were told our chair is free: only happens if the server dropped our seat
      this.me.standUp();
      this.#syncSeatFlag(null);
    }
  }

  // ---- remote players -------------------------------------------------------

  #addRemote(p) {
    if (this.remotes.has(p.id)) return;
    const r = new RemoteAvatar(this, p);
    if (p.seat != null) r.seatChair = this.office.chairs[p.seat] ?? null;
    this.remotes.set(p.id, r);
    this.labels.add(p.id, { name: p.name });
    this.labels.setMedia(p.id, p);
  }

  #removeRemote(id) {
    this.remotes.get(id)?.destroy();
    this.remotes.delete(id);
    this.labels.remove(id);
  }

  #onPlayerUpdate(p, changes) {
    if (changes.name !== undefined) this.labels.setName(p.id, changes.name);
    if (changes.mic !== undefined || changes.cam !== undefined) this.labels.setMedia(p.id, p);
    if (changes.avatar !== undefined) (p.isMe ? this.me : this.remotes.get(p.id))?.setSkin(changes.avatar);
  }

  #onSnap({ x, y }) {
    this.#cancelPath();
    this.me.sprite.setPosition(x, y);
    this.me.body.reset(x, y);
  }

  #onReset() {
    // reconnected: the server sent a fresh world. Rebuild everyone around it.
    for (const id of [...this.remotes.keys()]) this.#removeRemote(id);
    const { session, me } = this;
    if (me.seatChair) me.standUp();
    this.#cancelAll();
    const meData = session.me;
    me.sprite.setPosition(meData.x, meData.y);
    me.body.reset(meData.x, meData.y);
    this.labels.setName(meData.id, meData.name);
    this.labels.setMedia(meData.id, meData);
    me.setSkin(meData.avatar);
    for (const p of session.players.values()) if (!p.isMe) this.#addRemote(p);
    for (const [chair, id] of session.seats) this.#assignSeat(chair, id);
    this.lastSent = { x: NaN, y: NaN, a: "" };
  }

  #teardown() {
    this.unsubs.forEach((off) => off());
    this.unsubs = [];
    this.labels.clear();
    this.remotes.clear();
    this.input.setDefaultCursor("default");
    if (this.usingComputer !== null) {
      this.usingComputer = null;
      bus.emit("me:computer", null);
    }
  }
}

