import { AVATAR_IDS } from "../net/protocol.js";

/**
 * All four avatars share one 52-frame sheet layout (32x48 per frame):
 *   idle  right 0-5   up 6-11   left 12-17  down 18-23
 *   run   right 24-29 up 30-35  left 36-41  down 42-47
 *   sit   down 48     left 49   right 50    up 51
 */
const IDLE = { right: [0, 5], up: [6, 11], left: [12, 17], down: [18, 23] };
const RUN = { right: [24, 29], up: [30, 35], left: [36, 41], down: [42, 47] };
const SIT = { down: 48, left: 49, right: 50, up: 51 };

export const DIRS = ["up", "down", "left", "right"];

export function createAvatarAnims(anims) {
  for (const avatar of AVATAR_IDS) {
    for (const dir of DIRS) {
      anims.create({
        key: `${avatar}_idle_${dir}`,
        frames: anims.generateFrameNumbers(avatar, { start: IDLE[dir][0], end: IDLE[dir][1] }),
        frameRate: 9,
        repeat: -1,
      });
      anims.create({
        key: `${avatar}_run_${dir}`,
        frames: anims.generateFrameNumbers(avatar, { start: RUN[dir][0], end: RUN[dir][1] }),
        frameRate: 15,
        repeat: -1,
      });
      anims.create({
        key: `${avatar}_sit_${dir}`,
        frames: [{ key: avatar, frame: SIT[dir] }],
        frameRate: 1,
        repeat: 0,
      });
    }
  }
}

/** "run_left" -> { state: "run", dir: "left" } */
export function parseAnim(a) {
  const [state, dir] = String(a).split("_");
  return { state, dir };
}

/** Sprite offsets while seated: [dx, dy, depthShift] — carried over from metaverse. */
export const SIT_SHIFT = {
  up: [0, 3, -10],
  down: [0, 3, 1],
  left: [0, -8, 10],
  right: [0, -8, 10],
};
