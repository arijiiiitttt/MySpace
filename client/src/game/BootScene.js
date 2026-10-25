import Phaser from "phaser";
import { bus } from "../app/emitter.js";
import { AVATAR_IDS } from "../net/protocol.js";
import { createAvatarAnims } from "./animations.js";
import { MAPS, tilemapKey } from "./maps.js";
import { makeVoidTexture } from "./office.js";

/**
 * Loads every asset while the player is still on the join screen, so pressing
 * "Enter" drops them straight into the office.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  preload() {
    const base = "/assets";
    this.load.on("progress", (v) => bus.emit("boot:progress", v));
    this.load.on("loaderror", (file) => bus.emit("boot:error", file.src));

    for (const m of MAPS) this.load.tilemapTiledJSON(tilemapKey(m.id), `${base}/map/${m.file}`);
    this.load.spritesheet("tiles_wall", `${base}/map/FloorAndGround.png`, { frameWidth: 32, frameHeight: 32 });

    this.load.spritesheet("chairs", `${base}/items/chair.png`, { frameWidth: 32, frameHeight: 64 });
    this.load.spritesheet("computers", `${base}/items/computer.png`, { frameWidth: 96, frameHeight: 64 });
    this.load.spritesheet("vendingmachines", `${base}/items/vendingmachine.png`, { frameWidth: 48, frameHeight: 72 });
    this.load.spritesheet("whiteboards", `${base}/items/whiteboard.png`, { frameWidth: 64, frameHeight: 64 });

    this.load.spritesheet("office", `${base}/tileset/Modern_Office_Black_Shadow.png`, { frameWidth: 32, frameHeight: 32 });
    this.load.spritesheet("generic", `${base}/tileset/Generic.png`, { frameWidth: 32, frameHeight: 32 });
    this.load.spritesheet("basement", `${base}/tileset/Basement.png`, { frameWidth: 32, frameHeight: 32 });
    this.load.spritesheet("classroom", `${base}/tileset/Classroom_and_library.png`, { frameWidth: 32, frameHeight: 32 });

    for (const id of AVATAR_IDS) {
      this.load.spritesheet(id, `${base}/characters/${id}.png`, { frameWidth: 32, frameHeight: 48 });
    }
  }

  create() {
    createAvatarAnims(this.anims);
    makeVoidTexture(this);
    bus.emit("boot:ready");
  }
}
