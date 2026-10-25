import { bus } from "../app/emitter.js";
import { colorFor } from "../net/protocol.js";

const SCALE = 8; // world px per minimap px

/** Top-down map of the office. Click anywhere to walk there. */
export class Minimap {
  constructor(canvas, session) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.session = session;
    this.base = null;
    this.timer = null;

    canvas.addEventListener("pointerdown", (e) => {
      if (!this.info) return;
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * this.info.width;
      const y = ((e.clientY - r.top) / r.height) * this.info.height;
      bus.emit("ui:goto", { x, y });
      e.preventDefault();
    });

    this.unsub = bus.on("office:ready", (info) => this.#build(info));
  }

  #build(info) {
    this.info = info;
    const w = Math.ceil(info.width / SCALE);
    const h = Math.ceil(info.height / SCALE);
    this.canvas.width = w;
    this.canvas.height = h;
    const base = document.createElement("canvas");
    base.width = w;
    base.height = h;
    const g = base.getContext("2d");
    g.fillStyle = "#070b18";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#2a3a70";
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!info.solidAt(x * SCALE + SCALE / 2, y * SCALE + SCALE / 2 + 20)) g.fillRect(x, y, 1, 1);
      }
    }
    g.fillStyle = "#4a5a95";
    for (const r of info.rects) g.fillRect(Math.floor(r.x0 / SCALE), Math.floor(r.y0 / SCALE), Math.ceil((r.x1 - r.x0) / SCALE), Math.ceil((r.y1 - r.y0) / SCALE));
    g.fillStyle = "#5eead4";
    for (const c of info.computers) g.fillRect(Math.floor((c.x - c.w / 2) / SCALE), Math.floor((c.y - c.h / 2) / SCALE), Math.ceil(c.w / SCALE), 3);
    g.fillStyle = "#fbbf24";
    for (const v of info.vending) g.fillRect(Math.floor(v.x / SCALE) - 1, Math.floor(v.y / SCALE) - 2, 3, 4);
    this.base = base;
    this.start();
  }

  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.draw(), 100);
    this.draw();
  }

  stop() {
    clearInterval(this.timer);
    this.unsub?.();
  }

  draw() {
    const { ctx, base, session } = this;
    if (!base) return;
    ctx.drawImage(base, 0, 0);
    const seatedDot = (p) => p.seat != null;
    for (const p of session.players.values()) {
      if (p.isMe) continue;
      const x = p.x / SCALE;
      const y = p.y / SCALE;
      ctx.fillStyle = colorFor(p.id);
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, seatedDot(p) ? 2 : 3, seatedDot(p) ? 2 : 3);
    }
    const me = session.me;
    if (me) {
      const x = me.x / SCALE;
      const y = me.y / SCALE;
      const pulse = 3 + Math.sin(performance.now() / 250) * 1;
      ctx.strokeStyle = "rgb(94 234 212 / 0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, pulse + 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3);
    }
  }
}
