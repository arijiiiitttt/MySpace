import { WebSocketServer } from 'ws';
import { walls } from '../client/src/components/levels/level1.js';
import { isSpaceFree } from '../client/src/helpers/grid.js';

const wss = new WebSocketServer({ port: 8080 });
console.log('Server running on ws://localhost:8080');

const players = new Map();
let nextId = 1;

wss.on('connection', ws => {
  const id = nextId++;
  // Initialize player with a default direction (2 = DOWN)
  players.set(id, { ws, x: 96, y: 80, name: '??', isBoy: true, direction: 2 }); 

  // SEND ID (Type 1) (Omitted for brevity)
  const idBuf = new ArrayBuffer(5);
  const dv = new DataView(idBuf);
  dv.setUint8(0, 1);
  dv.setUint32(1, id, true);
  ws.send(idBuf);

  ws.on('message', data => {
    const buf = new Uint8Array(data);
    const type = buf[0];
    const p = players.get(id);
    if (!p) return; 

    if (type === 3) { // JOIN
      p.isBoy = buf[1] === 0;
      const nameLen = buf[2];
      p.name = new TextDecoder().decode(buf.slice(3, 3 + nameLen));
    }

    else if (type === 2) { // INPUT
      const bits = buf[1];
      const speed = 2;  
      const old = { x: p.x, y: p.y };
      
      // Check for movement and update direction
      if (bits & 1) { p.y -= speed; p.direction = 1; } // UP
      if (bits & 2) { p.y += speed; p.direction = 2; } // DOWN
      if (bits & 4) { p.x -= speed; p.direction = 3; } // LEFT
      if (bits & 8) { p.x += speed; p.direction = 4; } // RIGHT

      // If multiple directions pressed, the last one checked determines the final direction state.
      // This is acceptable as client animation is based on the highest priority direction in Input.js

      // WALL COLLISION
      if (!isSpaceFree(walls, p.x, p.y)) {
        p.x = old.x;
        p.y = old.y;
      }
    }
  });

  ws.on('close', () => players.delete(id));
});

// 30 Hz SNAPSHOT (Type 0)
setInterval(() => {
  const list = [];
  for (const [id, p] of players) {
    // Include the direction state here
    list.push({ id, x: p.x, y: p.y, name: p.name, isBoy: p.isBoy, direction: p.direction }); 
  }

  let nameBytes = 0;
  for (const p of list) {
    nameBytes += new TextEncoder().encode(p.name).length; 
  }

  // Calculate new buffer size: (Previous: 14) -> (New: 15) bytes per player + name length
  const buf = new ArrayBuffer(3 + list.length * 15 + nameBytes);
  const dv = new DataView(buf);
  dv.setUint8(0, 0); 
  dv.setUint16(1, list.length, true);
  let off = 3;

  for (const p of list) {
    dv.setUint32(off, p.id, true);
    dv.setFloat32(off + 4, p.x, true);
    dv.setFloat32(off + 8, p.y, true);
    dv.setUint8(off + 12, p.isBoy ? 0 : 1); 
    dv.setUint8(off + 13, p.direction); // <-- NEW: Direction byte
    
    const nameB = new TextEncoder().encode(p.name);
    dv.setUint8(off + 14, nameB.length); // Name length moved by 1 byte
    new Uint8Array(buf, off + 15).set(nameB); // Name data moved by 1 byte
    off += 15 + nameB.length; // Offset increased by 1
  }

  for (const p of players.values()) {
    if (p.ws.readyState === 1) p.ws.send(buf);
  }
}, 1000 / 30);