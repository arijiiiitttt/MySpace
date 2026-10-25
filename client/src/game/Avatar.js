import { SIT_SHIFT, parseAnim } from "./animations.js";
import { BODY } from "./nav.js";

export const WALK_SPEED = 200; // px/s — keep at or under the server's MAX_SPEED

/** Common bits: the sprite, which avatar skin it wears, and sit/idle/run playback. */
class Avatar {
  constructor(scene, p) {
    this.scene = scene;
    this.id = p.id;
    this.avatarId = p.avatar;
    this.state = "idle";
    this.dir = "down";
    this.seatChair = null; // chair record while seated
    this.sprite = this.createSprite(scene, p);
    this.sprite.setDepth(p.y);
    this.applyAnim(p.a ?? "idle_down", true);
  }

  createSprite(scene, p) {
    return scene.add.sprite(p.x, p.y, p.avatar);
  }

  get x() {
    return this.sprite.x;
  }
  get y() {
    return this.sprite.y;
  }

  setSkin(avatarId) {
    if (avatarId === this.avatarId) return;
    this.avatarId = avatarId;
    this.sprite.setTexture(avatarId);
    this.applyAnim(`${this.state}_${this.dir}`, true);
  }

  applyAnim(a, force = false) {
    const { state, dir } = parseAnim(a);
    if (!state || !dir) return;
    if (!force && state === this.state && dir === this.dir) return;
    this.state = state;
    this.dir = dir;
    this.sprite.anims.play(`${this.avatarId}_${state}_${dir}`, true);
  }

  /** Depth sorting: by feet position, with the per-direction tweak while seated. */
  updateDepth() {
    if (this.state === "sit" && this.seatChair) {
      this.sprite.setDepth(this.seatChair.sprite.depth + SIT_SHIFT[this.dir][2]);
    } else {
      this.sprite.setDepth(this.sprite.y);
    }
  }

  /** Where speech bubbles and name tags attach (just above the head). */
  get labelAnchor() {
    return { x: this.sprite.x, y: this.sprite.y - 26 };
  }

  destroy() {
    this.sprite.destroy();
  }
}

/** Someone else. No physics: we just glide towards the latest position the server gave us. */
export class RemoteAvatar extends Avatar {
  constructor(scene, p) {
    super(scene, p);
    this.target = { x: p.x, y: p.y };
  }

  setTarget(x, y, a) {
    this.target.x = x;
    this.target.y = y;
    this.applyAnim(a);
  }

  update(dtMs) {
    const s = this.sprite;
    const dx = this.target.x - s.x;
    const dy = this.target.y - s.y;
    if (Math.abs(dx) > 160 || Math.abs(dy) > 160) {
      s.setPosition(this.target.x, this.target.y); // teleport / reconnect: don't slide across the map
    } else {
      const k = 1 - Math.exp(-(dtMs / 1000) * 14); // frame-rate independent smoothing
      s.x += dx * k;
      s.y += dy * k;
      if (Math.abs(this.target.x - s.x) < 0.25) s.x = this.target.x;
      if (Math.abs(this.target.y - s.y) < 0.25) s.y = this.target.y;
    }
    this.updateDepth();
  }
}

/** You. Arcade physics body at the feet so walls and furniture collide like in metaverse. */
export class MyAvatar extends Avatar {
  createSprite(scene, p) {
    const sprite = scene.physics.add.sprite(p.x, p.y, p.avatar);
    // 16x10 box flush with the bottom of the 32x48 frame (metaverse used 0.5 x 0.2 of the
    // sprite). Its centre is BODY.cy below the sprite centre — nav.js relies on that.
    sprite.body.setSize(BODY.halfW * 2, BODY.halfH * 2).setOffset(8, 48 - BODY.halfH * 2);
    return sprite;
  }

  get body() {
    return this.sprite.body;
  }

  /** Walk with a direction vector (-1..1 each axis). Returns true while moving. */
  walk(vx, vy, speed = WALK_SPEED) {
    if (vx === 0 && vy === 0) {
      this.body.setVelocity(0, 0);
      this.applyAnim(`idle_${this.dir}`);
      return false;
    }
    this.body.setVelocity(vx, vy);
    this.body.velocity.setLength(speed);
    // Same rule as metaverse: horizontal wins over vertical when both are held.
    const dir = Math.abs(vx) >= Math.abs(vy) ? (vx > 0 ? "right" : "left") : vy > 0 ? "down" : "up";
    this.applyAnim(`run_${dir}`);
    return true;
  }

  stop() {
    this.body.setVelocity(0, 0);
  }

  sitDown(chair, pos) {
    this.stop();
    this.seatChair = chair;
    this.body.enable = false;
    this.sprite.setPosition(pos.x, pos.y);
    this.applyAnim(`sit_${chair.dir}`, true);
    this.updateDepth();
  }

  standUp() {
    this.seatChair = null;
    this.body.enable = true;
    this.body.reset(this.sprite.x, this.sprite.y);
    this.applyAnim(`idle_${this.dir}`, true);
    this.updateDepth();
  }

  /** Current anim as the "state_dir" string the protocol uses. */
  get animKey() {
    return `${this.state}_${this.dir}`;
  }
}

