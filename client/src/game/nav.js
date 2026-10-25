/**
 * Walkability grid + A* for click-to-move.
 *
 * Differences from the original metaverse pathfinder (4-way A* on 32px tiles
 * that ignored furniture):
 *   - 8px cells, so paths squeeze through doorways and between desks
 *   - furniture collision boxes are baked in, inflated by the player's body so
 *     a path is never "walkable on paper but blocked by a desk"
 *   - 8-way movement, no corner cutting, then line-of-sight smoothing so
 *     characters walk straight lines instead of staircases
 *   - clicking a wall/desk finds the nearest reachable spot instead of failing
 *
 * Coordinates: callers use the *sprite* position (centre of the 32x48 sprite).
 * Internally the grid is about the *feet* (body centre), BODY_CY below the sprite centre.
 */
export const BODY = { halfW: 8, halfH: 5, cy: 19 };

// 8px cells: doorways on the map are only 32px wide, so a 16px grid can have no cell
// centre that lets the 16px body through.
const CELL = 8;

class MinHeap {
  #a = [];
  get size() {
    return this.#a.length;
  }
  push(node) {
    const a = this.#a;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.#a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export class NavGrid {
  /**
   * @param {{width:number,height:number}} size  world size in px
   * @param {(x:number,y:number)=>boolean} isGroundSolid  feet-point test (world px)
   * @param {{x0:number,y0:number,x1:number,y1:number}[]} rects  furniture boxes
   */
  constructor(size, isGroundSolid, rects) {
    this.cols = Math.ceil(size.width / CELL);
    this.rows = Math.ceil(size.height / CELL);
    this.blocked = new Uint8Array(this.cols * this.rows);

    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const px = cx * CELL + CELL / 2;
        const py = cy * CELL + CELL / 2;
        // body box centred on this cell (+1px of breathing room)
        const x0 = px - BODY.halfW - 1;
        const x1 = px + BODY.halfW + 1;
        const y0 = py - BODY.halfH - 1;
        const y1 = py + BODY.halfH + 1;

        let blocked =
          isGroundSolid(x0, y0) || isGroundSolid(x1, y0) || isGroundSolid(x0, y1) || isGroundSolid(x1, y1) ||
          isGroundSolid(px, py);
        if (!blocked) {
          for (const r of rects) {
            if (x1 > r.x0 && x0 < r.x1 && y1 > r.y0 && y0 < r.y1) {
              blocked = true;
              break;
            }
          }
        }
        this.blocked[cy * this.cols + cx] = blocked ? 1 : 0;
      }
    }
  }

  // sprite position <-> grid cell
  toCell(x, y) {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / CELL)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor((y + BODY.cy) / CELL)));
    return [cx, cy];
  }
  toWorld(cx, cy) {
    return { x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 - BODY.cy };
  }
  isBlocked(cx, cy) {
    return cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows || this.blocked[cy * this.cols + cx] === 1;
  }

  /** Nearest free cell to (cx,cy), searching outwards in rings. */
  nearestFree(cx, cy, maxRing = 24) {
    if (!this.isBlocked(cx, cy)) return [cx, cy];
    for (let r = 1; r <= maxRing; r++) {
      let best = null;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.isBlocked(cx + dx, cy + dy)) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = [cx + dx, cy + dy];
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** @returns {{x:number,y:number}[]} waypoints in sprite coordinates (empty = no route) */
  findPath(from, to) {
    let start = this.toCell(from.x, from.y);
    const goalWanted = this.toCell(to.x, to.y);
    // Standing on a "blocked" cell (e.g. just stood up from a chair): start from the nearest free one.
    if (this.isBlocked(...start)) {
      const free = this.nearestFree(...start, 10);
      if (!free) return [];
      start = free;
    }
    const goal = this.nearestFree(...goalWanted);
    if (!goal) return [];

    const { cols } = this;
    const idx = (cx, cy) => cy * cols + cx;
    const g = new Map([[idx(...start), 0]]);
    const parent = new Map();
    const closed = new Set();
    const open = new MinHeap();
    const h = (cx, cy) => {
      const dx = Math.abs(cx - goal[0]);
      const dy = Math.abs(cy - goal[1]);
      return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy); // octile
    };
    open.push({ cx: start[0], cy: start[1], f: h(...start) });

    const dirs = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ];

    let found = false;
    let guard = 0;
    while (open.size && guard++ < 100000) {
      const cur = open.pop();
      const ci = idx(cur.cx, cur.cy);
      if (closed.has(ci)) continue;
      closed.add(ci);
      if (cur.cx === goal[0] && cur.cy === goal[1]) {
        found = true;
        break;
      }
      for (const [dx, dy, cost] of dirs) {
        const nx = cur.cx + dx;
        const ny = cur.cy + dy;
        if (this.isBlocked(nx, ny)) continue;
        // no squeezing diagonally between two blocked cells
        if (dx !== 0 && dy !== 0 && (this.isBlocked(cur.cx + dx, cur.cy) || this.isBlocked(cur.cx, cur.cy + dy))) continue;
        const ni = idx(nx, ny);
        if (closed.has(ni)) continue;
        const ng = g.get(ci) + cost;
        if (ng < (g.get(ni) ?? Infinity)) {
          g.set(ni, ng);
          parent.set(ni, ci);
          open.push({ cx: nx, cy: ny, f: ng + h(nx, ny) });
        }
      }
    }
    if (!found) return [];

    const cells = [];
    for (let i = idx(...goal); i !== undefined; i = parent.get(i)) {
      cells.push([i % cols, Math.floor(i / cols)]);
      if (i === idx(...start)) break;
    }
    cells.reverse();
    return this.#smooth(cells).map(([cx, cy]) => this.toWorld(cx, cy));
  }

  /** Drop waypoints that have a clear straight line between their neighbours. */
  #smooth(cells) {
    if (cells.length <= 2) return cells.slice(1);
    const out = [];
    let anchor = 0;
    for (let i = 2; i < cells.length; i++) {
      if (!this.#lineClear(cells[anchor], cells[i])) {
        out.push(cells[i - 1]);
        anchor = i - 1;
      }
    }
    out.push(cells[cells.length - 1]);
    return out;
  }

  /**
   * Is the straight walk between two cell centres safe for the player's body?
   * Cells are inflated by the body, but a body *between* two centres can still
   * touch an obstacle that only blocks one of the cells bracketing it, so every
   * bracketing cell has to be free (on an axis-aligned run that is just one cell).
   */
  #lineClear([x0, y0], [x1, y1]) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 4);
    const snap = (v) => Math.round(v * 1e6) / 1e6;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const fx = snap(x0 + dx * t);
      const fy = snap(y0 + dy * t);
      for (const cx of new Set([Math.floor(fx), Math.ceil(fx)])) {
        for (const cy of new Set([Math.floor(fy), Math.ceil(fy)])) {
          if (this.isBlocked(cx, cy)) return false;
        }
      }
    }
    return true;
  }
}
