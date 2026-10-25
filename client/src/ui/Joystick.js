import { bus } from "../app/emitter.js";

/** On-screen stick for touch devices. Emits `ui:joystick` {x,y} in -1..1. */
export class Joystick {
  constructor(el) {
    this.el = el;
    this.knob = el.querySelector("i");
    this.id = null;
    const R = 40;

    const update = (e) => {
      const r = el.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width / 2);
      let dy = e.clientY - (r.top + r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > R) {
        dx = (dx / len) * R;
        dy = (dy / len) * R;
      }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      bus.emit("ui:joystick", { x: dx / R, y: dy / R });
    };
    const end = (e) => {
      if (e.pointerId !== this.id) return;
      this.id = null;
      this.knob.style.transform = "";
      bus.emit("ui:joystick", { x: 0, y: 0 });
    };

    el.addEventListener("pointerdown", (e) => {
      this.id = e.pointerId;
      el.setPointerCapture(e.pointerId);
      update(e);
      e.preventDefault();
    });
    el.addEventListener("pointermove", (e) => e.pointerId === this.id && update(e));
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  static supported() {
    return window.matchMedia?.("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  }
}
