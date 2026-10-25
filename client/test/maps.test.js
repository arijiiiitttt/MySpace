import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NavGrid } from "../src/game/nav.js";

const manifest = JSON.parse(readFileSync(new URL("../src/game/maps.json", import.meta.url), "utf8"));
const maps = new Map(
  manifest.maps.map((m) => [m.id, { ...m, json: JSON.parse(readFileSync(new URL(`../public/assets/map/${m.file}`, import.meta.url), "utf8")) }]),
);

const TILESET_BY_LAYER = {
  Wall: "FloorAndGround",
  Objects: "Modern_Office_Black_Shadow",
  ObjectsOnCollide: "Modern_Office_Black_Shadow",
  GenericObjects: "Generic",
  GenericObjectsOnCollide: "Generic",
  Basement: "Basement",
  BasementDecor: "Basement",
  FloorDecor: "Generic",
  ClassroomObjects: "Classroom_and_library",
  ClassroomObjectsOnCollide: "Classroom_and_library",
  Chair: "chair",
  Computer: "computer",
  Whiteboard: "whiteboard",
  VendingMachine: "vendingmachine",
};
const SOLID_LAYERS = ["ObjectsOnCollide", "GenericObjectsOnCollide", "ClassroomObjectsOnCollide", "Basement", "VendingMachine"];

const layer = (json, name) => json.layers.find((l) => l.name === name);
const objects = (json, name) => layer(json, name)?.objects ?? [];
const prop = (o, name, fallback) => (o.properties ?? []).find((p) => p.name === name)?.value ?? fallback;

function navFor(json) {
  const ground = layer(json, "Ground");
  const set = json.tilesets.find((t) => t.name === "FloorAndGround");
  const colliding = new Set(set.tiles.filter((t) => (t.properties ?? []).some((p) => p.name === "collides" && p.value)).map((t) => t.id));
  const solidAt = (x, y) => {
    const cx = Math.floor(x / 32);
    const cy = Math.floor(y / 32);
    if (cx < 0 || cy < 0 || cx >= json.width || cy >= json.height) return true;
    const gid = ground.data[cy * json.width + cx];
    return gid === 0 || colliding.has(gid - set.firstgid);
  };
  const rects = SOLID_LAYERS.flatMap((n) => objects(json, n)).map((o) => ({ x0: o.x, y0: o.y - o.height, x1: o.x + o.width, y1: o.y }));
  return new NavGrid({ width: json.width * 32, height: json.height * 32 }, solidAt, rects);
}

test("manifest: start map exists and every map file is listed once", () => {
  assert.ok(maps.has(manifest.start));
  assert.equal(maps.size, manifest.maps.length);
  for (const m of manifest.maps) assert.match(m.id, /^[a-z][a-z0-9-]*$/);
});

for (const [id, { json }] of maps) {
  test(`${id}: every object uses a tileset that exists and a frame inside it`, () => {
    for (const [layerName, tilesetName] of Object.entries(TILESET_BY_LAYER)) {
      const list = objects(json, layerName);
      if (list.length === 0) continue; // a map only needs the tilesets it actually uses
      const set = json.tilesets.find((t) => t.name === tilesetName);
      assert.ok(set, `${id}: tileset ${tilesetName} missing`);
      for (const o of list) {
        const frame = o.gid - set.firstgid;
        assert.ok(frame >= 0 && frame < set.tilecount, `${id}/${layerName}: gid ${o.gid} outside ${tilesetName}`);
      }
    }
    const ground = layer(json, "Ground");
    assert.equal(ground.data.length, json.width * json.height);
  });

  test(`${id}: chairs have a valid direction and sit on walkable ground`, () => {
    const nav = navFor(json);
    for (const o of objects(json, "Chair")) {
      assert.ok(["up", "down", "left", "right"].includes(prop(o, "direction", "down")));
      const cx = o.x + o.width / 2;
      const cy = o.y - o.height / 2;
      assert.ok(cx > 0 && cx < json.width * 32 && cy > 0 && cy < json.height * 32, `chair at ${cx},${cy} is outside the map`);
      assert.ok(nav.nearestFree(...nav.toCell(cx, cy), 6), `chair at ${cx},${cy} is walled in`);
    }
  });
}

test("portals link back to each other and land in open space", () => {
  for (const [id, { json }] of maps) {
    const portals = objects(json, "Portal");
    assert.ok(portals.length > 0, `${id} has no way out`);
    const nav = navFor(json);
    for (const p of portals) {
      const to = maps.get(prop(p, "to", ""));
      assert.ok(to, `${id}:${p.name} points at an unknown map`);
      const back = objects(to.json, "Portal").find((q) => q.name === prop(p, "toPortal", ""));
      assert.ok(back, `${id}:${p.name} points at a missing door`);
      assert.equal(prop(back, "to", ""), id);
      assert.equal(prop(back, "toPortal", ""), p.name);
      // where people arrive on THIS map (through this door)
      const land = { x: prop(p, "landx", NaN), y: prop(p, "landy", NaN) };
      assert.ok(Number.isFinite(land.x) && Number.isFinite(land.y), `${id}:${p.name} has no landing point`);
      const [cx, cy] = nav.toCell(land.x, land.y);
      assert.equal(nav.isBlocked(cx, cy), false, `${id}:${p.name} lands somewhere blocked`);
      const onDoor = land.x > p.x && land.x < p.x + p.width && land.y + 19 > p.y && land.y + 19 < p.y + p.height;
      assert.equal(onDoor, false, `${id}:${p.name} lands on a door, which would bounce you straight back`);
    }
  }
});

test("everything interesting is reachable on foot from every arrival point", () => {
  for (const [id, { json }] of maps) {
    const nav = navFor(json);
    const starts = objects(json, "Portal").map((p) => ({ x: prop(p, "landx", 0), y: prop(p, "landy", 0) }));
    const targets = [
      ...objects(json, "Portal").map((p) => ({ what: `door ${p.name}`, x: p.x + p.width / 2, y: p.y + p.height / 2 - 19 })),
      ...objects(json, "Computer").map((o, i) => ({ what: `computer ${i}`, x: o.x + o.width / 2, y: o.y + 14 - 19 })),
      ...objects(json, "Chair").map((o, i) => ({ what: `chair ${i}`, x: o.x + o.width / 2, y: o.y - o.height / 2 + 14 - 19 })),
    ];
    for (const from of starts) {
      for (const t of targets) {
        const path = nav.findPath(from, t);
        if (path.length === 0) {
          const [sx, sy] = nav.toCell(from.x, from.y);
          const [tx, ty] = nav.toCell(t.x, t.y);
          assert.ok(sx === tx && sy === ty, `${id}: cannot walk from arrival (${from.x},${from.y}) to ${t.what}`);
          continue;
        }
        const end = path.at(-1);
        assert.ok(Math.hypot(end.x - t.x, end.y - t.y) < 70, `${id}: path to ${t.what} ends ${Math.round(Math.hypot(end.x - t.x, end.y - t.y))}px away`);
      }
    }
  }
});
