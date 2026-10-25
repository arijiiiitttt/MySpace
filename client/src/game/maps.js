import manifest from "./maps.json";

/** Every map the office is made of: [{ id, name, file, icon }]. The server reads the same file. */
export const MAPS = manifest.maps;
export const START_MAP = manifest.start;
export const mapInfo = (id) => MAPS.find((m) => m.id === id) ?? MAPS[0];
export const tilemapKey = (id) => `map:${id}`;
