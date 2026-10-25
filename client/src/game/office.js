import { tilemapKey } from "./maps.js";

/**
 * Turns the Tiled map into Phaser objects. Ported from metaverse's Game.ts
 * (`addObjectFromTiled` / `addGroupFromTiled`) with these changes:
 *   - items come back as plain data records (id, position, sprite) instead of
 *     being hidden inside Phaser groups, so the scene can query them
 *   - empty ground tiles (outside the building) are solid, matching the server
 *   - furniture boxes are exported for the nav grid and the minimap
 *   - whiteboards, which metaverse dropped, are drawn as decoration
 */
const DECOR_LAYERS = [
  { layer: "Wall", key: "tiles_wall", tileset: "FloorAndGround", collide: false },
  { layer: "Objects", key: "office", tileset: "Modern_Office_Black_Shadow", collide: false },
  { layer: "ObjectsOnCollide", key: "office", tileset: "Modern_Office_Black_Shadow", collide: true },
  { layer: "GenericObjects", key: "generic", tileset: "Generic", collide: false },
  { layer: "GenericObjectsOnCollide", key: "generic", tileset: "Generic", collide: true },
  { layer: "FloorDecor", key: "generic", tileset: "Generic", collide: false, depth: 1 },
  { layer: "Basement", key: "basement", tileset: "Basement", collide: true },
  { layer: "BasementDecor", key: "basement", tileset: "Basement", collide: false },
  { layer: "ClassroomObjects", key: "classroom", tileset: "Classroom_and_library", collide: false },
  { layer: "ClassroomObjectsOnCollide", key: "classroom", tileset: "Classroom_and_library", collide: true },
];

const prop = (obj, name, fallback) => obj.properties?.find((p) => p.name === name)?.value ?? fallback;

export function buildOffice(scene, mapId) {
  const map = scene.make.tilemap({ key: tilemapKey(mapId) });
  const groundTiles = map.addTilesetImage("FloorAndGround", "tiles_wall");
  const ground = map.createLayer("Ground", groundTiles);
  ground.setCollisionByProperty({ collides: true });
  // Outside the building there are no tiles at all: make that solid too.
  ground.forEachTile((tile) => {
    if (tile.index === -1) tile.setCollision(true, true, true, true);
  });

  const frameOf = (obj, tilesetName) => obj.gid - map.getTileset(tilesetName).firstgid;
  const centreOf = (obj) => ({ x: obj.x + obj.width / 2, y: obj.y - obj.height / 2 });
  const objects = (name) => map.getObjectLayer(name)?.objects ?? [];

  const rects = [];
  const colliders = [];
  const addRect = (o) => rects.push({ x0: o.x, y0: o.y - o.height, x1: o.x + o.width, y1: o.y });

  // ---- decoration + solid furniture ---------------------------------------
  for (const def of DECOR_LAYERS) {
    const group = def.collide ? scene.physics.add.staticGroup() : null;
    for (const o of objects(def.layer)) {
      const { x, y } = centreOf(o);
      const frame = frameOf(o, def.tileset);
      const sprite = group ? group.get(x, y, def.key, frame) : scene.add.image(x, y, def.key, frame);
      sprite.setDepth(def.depth ?? y);
      if (def.collide) addRect(o);
    }
    if (group) colliders.push(group);
  }

  // ---- interactive items ---------------------------------------------------
  const chairs = objects("Chair").map((o, id) => {
    const { x, y } = centreOf(o);
    const sprite = scene.add.image(x, y, "chairs", frameOf(o, "chair")).setDepth(y);
    return { id, x, y, dir: prop(o, "direction", "down"), meeting: prop(o, "meeting", false), sprite };
  });

  const computers = objects("Computer").map((o, id) => {
    const { x, y } = centreOf(o);
    const sprite = scene.add.image(x, y, "computers", frameOf(o, "computer")).setDepth(y + o.height * 0.27);
    return { id, x, y, w: o.width, h: o.height, sprite };
  });

  const vendingGroup = scene.physics.add.staticGroup();
  const vending = objects("VendingMachine").map((o, id) => {
    const { x, y } = centreOf(o);
    const sprite = vendingGroup.get(x, y, "vendingmachines", frameOf(o, "vendingmachine")).setDepth(y);
    addRect(o);
    return { id, x, y, w: o.width, h: o.height, sprite };
  });
  colliders.push(vendingGroup);

  const whiteboards = objects("Whiteboard").map((o, id) => {
    const { x, y } = centreOf(o);
    const sprite = scene.add.image(x, y, "whiteboards", frameOf(o, "whiteboard")).setDepth(y);
    return { id, x, y, w: o.width, h: o.height, sprite };
  });

  // doors to the other maps
  const portals = objects("Portal").map((o) => ({
    id: o.name,
    x: o.x,
    y: o.y,
    w: o.width,
    h: o.height,
    to: prop(o, "to", ""),
    label: prop(o, "label", o.name),
  }));

  // Solid ground test for a world-space point (used by the nav grid + minimap).
  const { width: cols, height: rows, tileWidth: tile } = map;
  const solidAt = (x, y) => {
    const cx = Math.floor(x / tile);
    const cy = Math.floor(y / tile);
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return true;
    const t = ground.getTileAt(cx, cy, true);
    return !t || t.index === -1 || t.collides;
  };

  return {
    map,
    ground,
    chairs,
    computers,
    vending,
    whiteboards,
    portals,
    colliders,
    rects,
    solidAt,
    width: map.widthInPixels,
    height: map.heightInPixels,
  };
}

/** Procedural backdrop for the void around the building (no 880 KB texture needed). */
export function makeVoidTexture(scene, key = "void_tile") {
  if (scene.textures.exists(key)) return key;
  const size = 64;
  const tex = scene.textures.createCanvas(key, size, size);
  const ctx = tex.getContext();
  ctx.fillStyle = "#0a1022";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#101a36";
  ctx.fillRect(0, 0, size, 1);
  ctx.fillRect(0, 0, 1, size);
  ctx.fillStyle = "#16224a";
  ctx.fillRect(31, 31, 2, 2);
  // a few "stars"
  ctx.fillStyle = "#2a3a78";
  for (const [x, y] of [[9, 14], [47, 8], [22, 50], [56, 41]]) ctx.fillRect(x, y, 1, 1);
  tex.refresh();
  return key;
}

