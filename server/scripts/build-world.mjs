#!/usr/bin/env node
/**
 * Builds server/data/worlds/<map>.json for every map listed in the client's
 * src/game/maps.json (the Tiled files are in public/assets/map).
 *
 * The server never renders anything, but it needs to know, per map:
 *   - which ground tiles are solid (to reject players walking through walls)
 *   - where every chair, computer and vending machine is (seat ownership,
 *     "who is at which computer", distance checks)
 *   - where the portals (doors to other maps) are and where they drop you
 *   - safe spawn cells
 *
 * Run:  npm run build:world   (from /server)
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mapDir = resolve(here, "../../client/public/assets/map");
const outDir = resolve(here, "../data/worlds");

const manifest = JSON.parse(readFileSync(resolve(here, "../../client/src/game/maps.json"), "utf8"));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const objectCenter = (o) => ({ x: o.x + o.width / 2, y: o.y - o.height / 2 });
const prop = (o, name, fallback) => (o.properties ?? []).find((p) => p.name === name)?.value ?? fallback;

function build(entry) {
  const map = JSON.parse(readFileSync(resolve(mapDir, entry.file), "utf8"));
  const TILE = map.tilewidth;
  const COLS = map.width;
  const ROWS = map.height;

  // ---- solid ground tiles -------------------------------------------------
  const ground = map.layers.find((l) => l.name === "Ground");
  const groundSet = map.tilesets.find((t) => t.name === "FloorAndGround");
  const collidingIds = new Set(
    (groundSet.tiles ?? [])
      .filter((t) => (t.properties ?? []).some((p) => p.name === "collides" && p.value === true))
      .map((t) => t.id),
  );
  const solidRows = [];
  for (let y = 0; y < ROWS; y++) {
    let row = "";
    for (let x = 0; x < COLS; x++) {
      const gid = ground.data[y * COLS + x];
      // gid 0 = empty tile = outside the building = not walkable either
      row += gid === 0 || collidingIds.has(gid - groundSet.firstgid) ? "1" : "0";
    }
    solidRows.push(row);
  }

  // ---- tiled objects -> world coordinates (same maths as the client) ------
  const layer = (name) => map.layers.find((l) => l.name === name)?.objects ?? [];
  const chairs = layer("Chair").map((o, id) => ({ id, ...objectCenter(o), dir: prop(o, "direction", "down"), meeting: prop(o, "meeting", false) }));
  const computers = layer("Computer").map((o, id) => ({ id, ...objectCenter(o) }));
  const vending = layer("VendingMachine").map((o, id) => ({ id, ...objectCenter(o) }));
  const whiteboards = layer("Whiteboard").map((o, id) => ({ id, ...objectCenter(o) }));
  const portals = layer("Portal").map((o) => ({
    id: o.name,
    x: o.x,
    y: o.y,
    w: o.width,
    h: o.height,
    to: prop(o, "to", ""),
    toPortal: prop(o, "toPortal", ""),
    label: prop(o, "label", o.name),
    land: { x: prop(o, "landx", o.x + o.width / 2), y: prop(o, "landy", o.y + o.height / 2) },
  }));

  // ---- spawn cells ---------------------------------------------------------
  const isSolid = (cx, cy) => cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS || solidRows[cy][cx] === "1";
  const furniture = [...chairs, ...computers, ...vending];
  const nearFurniture = (x, y) => furniture.some((f) => Math.hypot(f.x - x, f.y - y) < 56);
  const nearPortal = (x, y) => portals.some((p) => x > p.x - 40 && x < p.x + p.w + 40 && y > p.y - 40 && y < p.y + p.h + 40);

  // Where newcomers appear: the original metaverse lobby spot for the office, the arrival point
  // of the first portal for every other map.
  const anchor = entry.id === manifest.start ? { x: 705, y: 500 } : portals[0]?.land ?? { x: (COLS * TILE) / 2, y: (ROWS * TILE) / 2 };
  const spawns = [];
  for (let radius = 96; radius <= 288 && spawns.length < 6; radius += 96) {
    spawns.length = 0;
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const x = cx * TILE + TILE / 2;
        const y = cy * TILE + TILE / 2;
        if (Math.hypot(x - anchor.x, y - anchor.y) > radius) continue;
        let free = true;
        for (let oy = -1; oy <= 1 && free; oy++) for (let ox = -1; ox <= 1; ox++) if (isSolid(cx + ox, cy + oy)) free = false;
        if (free && !nearFurniture(x, y) && !nearPortal(x, y)) spawns.push({ x, y });
      }
    }
  }
  if (spawns.length === 0) throw new Error(`no spawn cells found in ${entry.id}`);

  // Every portal landing must be on walkable ground.
  for (const p of portals) {
    const cx = Math.floor(p.land.x / TILE);
    const cy = Math.floor((p.land.y + 20) / TILE);
    if (isSolid(cx, cy)) throw new Error(`${entry.id}: portal ${p.id} lands inside a wall`);
  }

  const world = {
    id: entry.id,
    name: entry.name,
    tile: TILE,
    cols: COLS,
    rows: ROWS,
    width: COLS * TILE,
    height: ROWS * TILE,
    solid: solidRows,
    spawns,
    chairs,
    computers,
    vending,
    whiteboards,
    portals,
  };
  writeFileSync(resolve(outDir, `${entry.id}.json`), JSON.stringify(world));
  console.log(
    `${entry.id.padEnd(10)} ${COLS}x${ROWS} tiles, ${chairs.length} chairs, ${computers.length} computers, ` +
      `${portals.length} portals, ${spawns.length} spawn cells`,
  );
  return world;
}

const worlds = manifest.maps.map(build);

// Cross-check the portal graph: every portal must point at a real portal that points back.
const byId = new Map(worlds.map((w) => [w.id, w]));
for (const w of worlds) {
  for (const p of w.portals) {
    const target = byId.get(p.to)?.portals.find((q) => q.id === p.toPortal);
    if (!target) throw new Error(`${w.id}:${p.id} points at missing ${p.to}:${p.toPortal}`);
    if (target.to !== w.id || target.toPortal !== p.id) throw new Error(`${w.id}:${p.id} <-> ${p.to}:${p.toPortal} do not link back to each other`);
  }
}

writeFileSync(
  resolve(outDir, "index.json"),
  JSON.stringify({ start: manifest.start, maps: manifest.maps.map(({ id, name }) => ({ id, name })) }),
);
console.log(`worlds written to data/worlds (${worlds.length} maps, start = ${manifest.start})`);
