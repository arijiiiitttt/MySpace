import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NavGrid, BODY } from "../src/game/nav.js";

// The server world data is generated from the same Tiled map the client renders.
const world = JSON.parse(readFileSync(new URL("../../server/data/worlds/office.json", import.meta.url), "utf8"));
const solidAt = (x, y) => {
  const cx = Math.floor(x / world.tile);
  const cy = Math.floor(y / world.tile);
  return cx < 0 || cy < 0 || cx >= world.cols || cy >= world.rows || world.solid[cy][cx] === "1";
};
const nav = new NavGrid({ width: world.width, height: world.height }, solidAt, []);
const spawn = world.spawns[0];
const from = { x: spawn.x, y: spawn.y };
// sprite position that puts the feet at a given world point
const feet = (x, y) => ({ x, y: y - BODY.cy });

test("every spawn point sits on a walkable cell", () => {
  for (const s of world.spawns) assert.equal(nav.isBlocked(...nav.toCell(s.x, s.y)), false, JSON.stringify(s));
});

test("every chair and computer can be reached from the lobby (doorways are passable)", () => {
  for (const item of [...world.chairs, ...world.computers]) {
    const path = nav.findPath(from, feet(item.x, item.y + 14));
    assert.ok(path.length > 0, `no route to ${item.x},${item.y}`);
  }
});

test("routes never pass through blocked cells", () => {
  const target = world.chairs[0];
  const path = nav.findPath(from, feet(target.x, target.y + 14));
  assert.ok(path.length >= 2);
  for (const p of path) {
    const [cx, cy] = nav.toCell(p.x, p.y);
    assert.equal(nav.isBlocked(cx, cy), false, `waypoint ${p.x},${p.y} is blocked`);
  }
});

test("straight walks along an open corridor smooth down to a single segment", () => {
  const path = nav.findPath({ x: 688, y: 560 }, feet(688, 460));
  assert.equal(path.length, 1);
});

test("clicking inside a wall walks to the nearest open spot instead of failing", () => {
  const path = nav.findPath(from, feet(10, 10));
  assert.ok(path.length > 0);
  const last = path[path.length - 1];
  assert.equal(nav.isBlocked(...nav.toCell(last.x, last.y)), false);
});

test("no route when the start is boxed in by walls everywhere", () => {
  const sealed = new NavGrid({ width: 320, height: 320 }, () => true, []);
  assert.deepEqual(sealed.findPath({ x: 100, y: 100 }, { x: 200, y: 100 }), []);
});

test("furniture rectangles block paths and are walked around", () => {
  const open = new NavGrid({ width: 400, height: 200 }, () => false, [{ x0: 190, y0: 0, x1: 210, y1: 150 }]);
  const path = open.findPath({ x: 50, y: 60 }, { x: 350, y: 60 });
  assert.ok(path.length >= 2, "should detour around the wall");
  assert.ok(path.some((p) => p.y + BODY.cy > 150), "detour goes under the obstacle");
});
