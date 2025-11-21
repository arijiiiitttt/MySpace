import { GameLoop } from './components/GameLoop.js';
import { Input } from './components/Input.js';
import { resources } from './components/Resource.js';
import { Sprite } from './components/Sprite.js';
import { Vector2 } from './components/Vector2.js';
import { moveTowards } from './helpers/moveTowards.js';
import './style.css';

import { Network } from './network.js';
import { Player } from './components/Player.js';

// **Pixel coordinates for initial position, 6 cells right, 5 cells down.**
const START_X = 6 * 16; 
const START_Y = 5 * 16; 

// ====================================================================
// NEW HELPER FUNCTION: Set initial idle frame for remote players
// ====================================================================

/**
 * Sets the remote player's sprite frame to the correct idle stance
 * based on the integer direction received from the server.
 * @param {Player} player The Player component instance.
 * @param {number} direction The server's direction integer (1=UP, 2=DOWN, 3=LEFT, 4=RIGHT).
 */
function setRemoteIdleFrame(player, direction) {
    let idleFrame = 1; // Default: Down Idle (Frame 1)

    if (direction === 1) {
        idleFrame = 7; // UP Idle (Frame 7)
    } else if (direction === 2) {
        idleFrame = 1; // DOWN Idle (Frame 1)
    } else if (direction === 3) {
        idleFrame = 10; // LEFT Idle (Frame 10)
    } else if (direction === 4) {
        idleFrame = 4; // RIGHT Idle (Frame 4)
    }
    
    player.sprite.frame = idleFrame;
    player.sprite.hFrames = 1; // Ensure it's not cycling when idle
}

// ====================================================================
// UI ELEMENTS (omitted for brevity)
// ====================================================================
const characterScreen = document.getElementById("character-screen");
const startBtn = document.getElementById("start-btn");
const usernameInput = document.getElementById("username");
const gameCanvas = document.getElementById("game-canvas");

let selectedAvatar = null;
let playerName = "";

// CHARACTER SELECTION (omitted for brevity)
document.querySelectorAll(".char-option").forEach(img => {
  img.addEventListener("click", () => {
    document.querySelectorAll(".char-option").forEach(i => i.classList.remove("selected"));
    img.classList.add("selected");
    selectedAvatar = img.id;
  });
});

startBtn.onclick = () => {
  if (!selectedAvatar) return alert("Select a character!");
  if (!usernameInput.value.trim()) return alert("Enter a name!");
  playerName = usernameInput.value.trim();
  characterScreen.style.display = "none";
  gameCanvas.style.display = "block";
  startGame();
};

// ====================================================================
// MAIN GAME
// ====================================================================
function startGame() {
  const canvas = document.getElementById("game-canvas");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const skySprite = new Sprite({ resource: resources.images.sky, frameSize: new Vector2(320, 180) });
  const groundSprite = new Sprite({ resource: resources.images.ground, frameSize: new Vector2(320, 180) });

  const avatarSheet = selectedAvatar === "boy" ? resources.images.hero : resources.images.heroine;
  const hero = new Sprite({
    resource: avatarSheet,
    frameSize: new Vector2(32, 32),
    hFrames: 3, vFrames: 8, frame: 1,
    position: new Vector2(START_X, START_Y) 
  });
  const shadow = new Sprite({ resource: resources.images.shadow, frameSize: new Vector2(32, 32) });

  const input = new Input();
  const heroDestinationPosition = hero.position.duplicate(); 

// --------------------------------------------------------------------
  // MULTIPLAYER SETUP 
// --------------------------------------------------------------------
  let myId = null;
  const others = new Map();

  const network = new Network(buf => {
    const dv = new DataView(buf.buffer);
    const type = dv.getUint8(0);

    if (type === 1) { // CONNECTED
      myId = dv.getUint32(1, true);

      // SEND NAME + AVATAR (Type 3)
      const enc = new TextEncoder();
      const nameB = enc.encode(playerName);
      const joinBuf = new ArrayBuffer(3 + nameB.length);
      const jdv = new DataView(joinBuf);
      jdv.setUint8(0, 3);
      jdv.setUint8(1, selectedAvatar === 'boy' ? 0 : 1);
      jdv.setUint8(2, nameB.length);
      new Uint8Array(joinBuf, 3).set(nameB);
      network.send(joinBuf);
    }

    else if (type === 0) { // SNAPSHOT
      const count = dv.getUint16(1, true);
      let off = 3;
      const seen = new Set();

      for (let i = 0; i < count; i++) {
        const id = dv.getUint32(off, true);
        const x = dv.getFloat32(off + 4, true);
        const y = dv.getFloat32(off + 8, true);
        const isBoy = dv.getUint8(off + 12) === 0;
        const direction = dv.getUint8(off + 13); // Read direction byte
        const nameLen = dv.getUint8(off + 14); 
        const name = new TextDecoder().decode(new Uint8Array(buf.buffer, off + 15, nameLen)); 
        off += 15 + nameLen; 

        seen.add(id);

        if (id === myId) {
          heroDestinationPosition.x = x;
          heroDestinationPosition.y = y;
          
          if (hero.position.distance(heroDestinationPosition) > 16) {
             hero.position.x = x;
             hero.position.y = y;
          }
          
        } else {
          let p = others.get(id);
          if (!p) {
              p = { player: new Player(isBoy), name, oldX: x, oldY: y }; 
              others.set(id, p);
              // Set initial idle frame upon first receipt
              setRemoteIdleFrame(p.player, direction);
          } else {
              p.name = name;
              p.oldX = p.player.position.x;
              p.oldY = p.player.position.y;
          }
          p.player.position.x = x; 
          p.player.position.y = y;
        }
      }

      for (const id of others.keys()) {
        if (!seen.has(id)) others.delete(id);
      }
    }
  });

  // SEND INPUT — 30 Hz (Type 2)
  const inputBuf = new ArrayBuffer(2);
  const iv = new DataView(inputBuf);
  iv.setUint8(0, 2);
  setInterval(() => {
    let bits = 0;
    if (input.direction === 'UP') bits |= 1;
    if (input.direction === 'DOWN') bits |= 2;
    if (input.direction === 'LEFT') bits |= 4;
    if (input.direction === 'RIGHT') bits |= 8;
    iv.setUint8(1, bits);
    network.send(new Uint8Array(inputBuf));
  }, 1000 / 30);

// --------------------------------------------------------------------
  // UPDATE (Game Loop)
// --------------------------------------------------------------------
  const update = (delta) => {
    // Local Hero Movement and Animation
    const speed = 2.5; 
    moveTowards(hero, heroDestinationPosition, speed);
    
    // ⭐ THE FIX: Use input state to drive local animation for smoothness
    const isHeroMoving = !!input.direction; 

    if (isHeroMoving) {
        // Use current input direction for animation
        if (input.direction === "DOWN") {
            hero.frame = 0;
        } else if (input.direction === "RIGHT") {
            hero.frame = 3;
        } else if (input.direction === "UP") {
            hero.frame = 6;
        } else if (input.direction === "LEFT") {
            hero.frame = 9;
        }
        hero.hFrames = 3; 
    } else {
        // Set IDLE animation based on last animated direction (from previous movement)
        if (hero.frame >= 0 && hero.frame <= 2) hero.frame = 1; 
        else if (hero.frame >= 3 && hero.frame <= 5) hero.frame = 4; 
        else if (hero.frame >= 6 && hero.frame <= 8) hero.frame = 7; 
        else if (hero.frame >= 9 && hero.frame <= 11) hero.frame = 10; 
        
        hero.hFrames = 1; 
    }

    hero.step(delta); 

    // Remote Players Animation (This section remains correct for remote players)
    for (const p of others.values()) {
        const player = p.player;
        // The movement check relies on the position difference between the server's last two snapshots
        const dx = player.position.x - p.oldX;
        const dy = player.position.y - p.oldY;
        const isRemoteMoving = dx !== 0 || dy !== 0;

        if (isRemoteMoving) {
            // Player is moving: start walk cycle based on travel direction
            if (Math.abs(dy) >= Math.abs(dx)) {
                if (dy > 0) player.sprite.frame = 0; 
                else player.sprite.frame = 6; 
            } else {
                if (dx > 0) player.sprite.frame = 3; 
                else player.sprite.frame = 9; 
            }
            player.sprite.hFrames = 3;
        } else {
            // Player is stopped: enforce the correct idle frame based on the current strip
            if (player.sprite.frame >= 0 && player.sprite.frame <= 2) {
                player.sprite.frame = 1; // Down Idle
            } else if (player.sprite.frame >= 3 && player.sprite.frame <= 5) {
                player.sprite.frame = 4; // Right Idle
            } else if (player.sprite.frame >= 6 && player.sprite.frame <= 8) {
                player.sprite.frame = 7; // Up Idle
            } else if (player.sprite.frame >= 9 && player.sprite.frame <= 11) {
                player.sprite.frame = 10; // Left Idle 
            }
            
            player.sprite.hFrames = 1; // Disable animation cycle
        }
        
      p.player.step(delta);
    }
  };
  
// --------------------------------------------------------------------
  // DRAW
// --------------------------------------------------------------------
  const draw = () => {
    skySprite.drawImage(ctx, 0, 0);
    groundSprite.drawImage(ctx, 0, 0);

    const heroOffset = new Vector2(-8, -21);
    const heroX = hero.position.x + heroOffset.x;
    const heroY = hero.position.y + 1 + heroOffset.y;

    shadow.drawImage(ctx, heroX, heroY);
    hero.drawImage(ctx, heroX, heroY);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.textAlign = "center";
    ctx.font = "9px PixelFont";
    ctx.fillStyle = "white";
    ctx.strokeStyle = "black";
    ctx.lineWidth = 3;
    ctx.strokeText(playerName, heroX + 16, heroY + 5);
    ctx.fillText(playerName, heroX + 16, heroY + 5);
    ctx.restore();

    // REMOTE PLAYERS
    for (const { player, name } of others.values()) {
      const off = new Vector2(-8, -21);
      const x = player.position.x + off.x;
      const y = player.position.y + 1 + off.y;

      player.shadow.drawImage(ctx, x, y);
      player.sprite.drawImage(ctx, x, y);

      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.textAlign = "center";
      ctx.font = "9px PixelFont";
      ctx.fillStyle = "white";
      ctx.strokeStyle = "black";
      ctx.lineWidth = 3;
      ctx.strokeText(name, x + 16, y + 5);
      ctx.fillText(name, x + 16, y + 5);
      ctx.restore();
    }
  };

  new GameLoop(update, draw).start();
}