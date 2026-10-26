import { fa, EMOTE_ICONS, EMOTE_COLORS } from "./fa.js";
import { colorFor } from "../net/protocol.js";
import { icon } from "./icons.js";

/**
 * Name tags, speech bubbles, emotes and the "Press E" prompt are plain DOM
 * elements positioned over the canvas every frame. Compared with Phaser text
 * objects this gives crisp text at any zoom, real emoji, CSS animation and
 * accessible markup for free.
 */
export class WorldLabels {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.tags = new Map();
    this.promptEl = document.createElement("button");
    this.promptEl.className = "world-prompt";
    this.promptEl.hidden = true;
    this.promptEl.type = "button";
    root.append(this.promptEl);
    this.promptAnchor = null;
    this.promptHandler = null;
    this.promptEl.addEventListener("click", () => this.promptHandler?.());
  }

  add(id, { name, isMe = false }) {
    this.remove(id);
    const el = document.createElement("div");
    el.className = "tag" + (isMe ? " tag--me" : "");
    el.style.setProperty("--tag-color", colorFor(id));
    el.innerHTML = `
      <div class="tag__bubble" hidden></div>
      <div class="tag__emote" hidden></div>
      <div class="tag__name"><i class="tag__dot"></i><span class="tag__text"></span><span class="tag__media" hidden></span></div>`;
    this.root.append(el);
    const refs = {
      el,
      bubble: el.querySelector(".tag__bubble"),
      emote: el.querySelector(".tag__emote"),
      text: el.querySelector(".tag__text"),
      media: el.querySelector(".tag__media"),
      bubbleTimer: 0,
      emoteTimer: 0,
      anchor: { x: 0, y: 0 },
    };
    refs.text.textContent = name;
    this.tags.set(id, refs);
    return refs;
  }

  remove(id) {
    const t = this.tags.get(id);
    if (!t) return;
    clearTimeout(t.bubbleTimer);
    clearTimeout(t.emoteTimer);
    t.el.remove();
    this.tags.delete(id);
  }

  clear() {
    for (const id of [...this.tags.keys()]) this.remove(id);
    this.hidePrompt();
  }

  setName(id, name) {
    const t = this.tags.get(id);
    if (t) t.text.textContent = name;
  }

  setMedia(id, { mic, cam }) {
    const t = this.tags.get(id);
    if (!t) return;
    t.media.hidden = !(mic || cam);
    t.media.innerHTML = (mic ? icon("mic", 11) : "") + (cam ? icon("video", 11) : "");
  }

  setSpeaking(id, speaking) {
    this.tags.get(id)?.el.classList.toggle("is-speaking", speaking);
  }

  say(id, text) {
    const t = this.tags.get(id);
    if (!t) return;
    const shown = text.length > 140 ? `${text.slice(0, 137)}…` : text;
    t.bubble.textContent = shown;
    t.bubble.hidden = false;
    // restart the pop-in animation
    t.bubble.classList.remove("is-new");
    void t.bubble.offsetWidth;
    t.bubble.classList.add("is-new");
    clearTimeout(t.bubbleTimer);
    t.bubbleTimer = setTimeout(() => (t.bubble.hidden = true), 3500 + Math.min(shown.length * 60, 5000));
  }

  emote(id, key) {
    const t = this.tags.get(id);
    if (!t) return;
    t.emote.innerHTML = fa(EMOTE_ICONS[key] ?? "face-smile");
    t.emote.style.color = EMOTE_COLORS[key] ?? "#fbbf24";
    t.emote.hidden = false;
    t.emote.classList.remove("is-new");
    void t.emote.offsetWidth;
    t.emote.classList.add("is-new");
    clearTimeout(t.emoteTimer);
    t.emoteTimer = setTimeout(() => (t.emote.hidden = true), 2400);
  }

  /** Where the tag of `id` should hang, in world coordinates. */
  anchor(id, x, y) {
    const t = this.tags.get(id);
    if (t) {
      t.anchor.x = x;
      t.anchor.y = y;
    }
  }

  showPrompt({ html, x, y, disabled = false, onClick }) {
    this.promptEl.hidden = false;
    this.promptEl.disabled = disabled;
    if (this.promptEl.dataset.html !== html) {
      this.promptEl.innerHTML = html;
      this.promptEl.dataset.html = html;
    }
    this.promptAnchor = { x, y };
    this.promptHandler = onClick;
  }

  hidePrompt() {
    this.promptEl.hidden = true;
    this.promptAnchor = null;
    this.promptHandler = null;
    delete this.promptEl.dataset.html;
  }

  /** Call once per frame with the Phaser camera. */
  update(cam) {
    const view = cam.worldView;
    const z = cam.zoom;
    const w = cam.width;
    const h = cam.height;
    for (const t of this.tags.values()) {
      const sx = Math.round((t.anchor.x - view.x) * z);
      const sy = Math.round((t.anchor.y - view.y) * z);
      const off = sx < -120 || sy < -120 || sx > w + 120 || sy > h + 120;
      if (off !== t.off) {
        t.off = off;
        t.el.style.visibility = off ? "hidden" : "visible";
      }
      if (!off) {
        t.el.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;
        t.el.style.zIndex = String(Math.round(t.anchor.y));
      }
    }
    if (this.promptAnchor) {
      const sx = Math.round((this.promptAnchor.x - view.x) * z);
      const sy = Math.round((this.promptAnchor.y - view.y) * z);
      this.promptEl.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;
    }
  }
}
