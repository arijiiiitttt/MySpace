import Phaser from "phaser";
import "@fortawesome/fontawesome-free/css/fontawesome.min.css";
import "@fortawesome/fontawesome-free/css/solid.min.css";
import { fetchStats } from "./app/config.js";
import { bus } from "./app/emitter.js";
import { Session } from "./app/Session.js";
import { store } from "./app/storage.js";
import { BootScene } from "./game/BootScene.js";
import { OfficeScene } from "./game/OfficeScene.js";
import { Media } from "./media/Media.js";
import { AVATARS, AVATAR_IDS, cleanRoomName } from "./net/protocol.js";
import { Hud } from "./ui/Hud.js";
import { Joystick } from "./ui/Joystick.js";
import { Minimap } from "./ui/Minimap.js";
import { WorldLabels } from "./ui/WorldLabels.js";
import { drawAvatar } from "./ui/sprites.js";
import { icon } from "./ui/icons.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state
const session = new Session();
const labels = new WorldLabels($("labels"));
let media = null;
let hud = null;
let minimap = null;
let inGame = false;
let selectedAvatar = store.get("profile")?.avatar;
if (!AVATAR_IDS.includes(selectedAvatar)) selectedAvatar = AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)];
let publicRooms = [];
let booted = false;

// the icon font is also drawn inside the game canvas, so make sure it is ready early
document.fonts?.load('900 14px "Font Awesome 7 Free"').catch(() => {});

// ---------------------------------------------------------------- game
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#070b18",
  pixelArt: true,
  // Phaser clamps frame time for the first `panicMax` (120) frames. On a slow device that is many
  // seconds of slow-motion after joining, so turn the warm-up clamp off.
  fps: { panicMax: 0 },
  scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  input: { keyboard: { capture: [] }, touch: { capture: false } },
  scene: [BootScene, OfficeScene],
});

if (import.meta.env.DEV || location.search.includes("debug")) {
  window.__myspace = { game, session, bus, labels, get media() { return media; } };
}

// ---------------------------------------------------------------- join screen
function renderAvatarPicker() {
  const wrap = $("avatar-picker");
  wrap.replaceChildren(
    ...AVATARS.map((a) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "avatar";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(a.id === selectedAvatar));
      b.dataset.avatar = a.id;
      const c = document.createElement("canvas");
      drawAvatar(c, a.id);
      const s = document.createElement("span");
      s.textContent = a.label;
      b.append(c, s);
      b.onclick = () => {
        selectedAvatar = a.id;
        renderAvatarPicker();
      };
      return b;
    }),
  );
}

function setError(msg) {
  const el = $("join-error");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

function setBusy(busy, label) {
  const btn = $("join-btn");
  btn.disabled = busy || !booted;
  $("join-btn-label").textContent = label ?? (booted ? "Enter My Space" : "Loading world…");
}

function syncKeyField() {
  const id = cleanRoomName($("room").value);
  const known = id === "lobby" || publicRooms.some((r) => r.id === id);
  $("key-field").hidden = known && !$("key").value;
}

function renderRoomChips() {
  const wrap = $("room-list");
  const rooms = publicRooms.filter((r) => r.players > 0 || r.id === "lobby");
  wrap.replaceChildren(
    ...rooms.slice(0, 6).map((r) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.innerHTML = `<span></span><b>${r.players}</b>`;
      b.firstChild.textContent = r.id;
      b.onclick = () => {
        $("room").value = r.id;
        syncKeyField();
      };
      return b;
    }),
  );
}

let statsTimer = null;
async function pollStats() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const stats = await fetchStats(ctl.signal);
    clearTimeout(t);
    publicRooms = stats.rooms;
    $("online-count").textContent = stats.online === 1 ? "1 person online" : `${stats.online} people online`;
    renderRoomChips();
    syncKeyField();
  } catch {
    $("online-count").textContent = "Server unreachable";
  }
}
function startStatsPolling() {
  clearInterval(statsTimer);
  pollStats();
  statsTimer = setInterval(pollStats, 5000);
}
function stopStatsPolling() {
  clearInterval(statsTimer);
}

function showJoin(errorMessage) {
  const profile = store.get("profile");
  if (profile?.name) $("name").value = profile.name;
  if (AVATAR_IDS.includes(profile?.avatar) && profile.avatar !== selectedAvatar) {
    selectedAvatar = profile.avatar;
    renderAvatarPicker();
  }
  $("join").hidden = false;
  document.title = "My Space";
  setError(errorMessage);
  setBusy(false);
  startStatsPolling();
}

let joystick = null; // created lazily on touch devices

async function enter(event) {
  event.preventDefault();
  if (inGame || !booted) return;
  const name = $("name").value.trim();
  const room = cleanRoomName($("room").value) || "lobby";
  const key = $("key").value;
  if (!name) {
    setError("Please pick a name first.");
    $("name").focus();
    return;
  }
  $("room").value = room;
  setError(null);
  setBusy(true, "Connecting…");
  store.set("profile", { name, avatar: selectedAvatar });
  store.set("room", room);

  try {
    await session.join({ name, avatar: selectedAvatar, room, key });
  } catch (err) {
    setBusy(false);
    if (err.code === "bad_key") {
      $("key-field").hidden = false;
      $("key").focus();
    }
    setError(err.message || "Couldn't connect.");
    return;
  }

  inGame = true;
  stopStatsPolling();
  $("join").hidden = true;
  setBusy(false);

  media = new Media(session);
  media.start();
  hud ??= new Hud(session, media, labels);
  hud.media = media;
  minimap = new Minimap($("minimap"), session);
  game.scene.start("office", { session, labels });
  hud.show();

  history.replaceState(null, "", `?room=${encodeURIComponent(session.room.id)}${location.search.includes("debug") ? "&debug" : ""}`);
  document.title = `#${session.room.id} · My Space`;
  if (Joystick.supported()) {
    $("joystick").hidden = false;
    joystick ??= new Joystick($("joystick"));
  }
}

function leave(message) {
  if (!inGame) return;
  inGame = false;
  media?.destroy();
  media = null;
  minimap?.stop();
  minimap = null;
  session.leave();
  game.scene.stop("office");
  labels.clear();
  hud?.hide();
  $("joystick").hidden = true;
  $("reconnect").hidden = true;
  history.replaceState(null, "", location.pathname);
  showJoin(message);
}

// ---------------------------------------------------------------- wiring
bus.on("app:leave", () => leave());
session.net.on("fatal", (err) => inGame && leave(err.message));
bus.on("boot:progress", (v) => {
  $("boot-bar").style.width = `${Math.round(v * 100)}%`;
});
bus.on("boot:error", (src) => {
  setError(`Couldn't load a game file (${src.split("/").slice(-2).join("/")}). Try refreshing.`);
});
bus.on("boot:ready", () => {
  booted = true;
  document.querySelector(".progress").style.opacity = "0";
  setBusy(false);
});

$("join-form").addEventListener("submit", enter);
$("room").addEventListener("input", syncKeyField);
$("room-random").addEventListener("click", () => {
  const words = ["sunny", "cosy", "brave", "quiet", "neon", "mellow", "lucky", "pixel", "cedar", "river"];
  const things = ["den", "loft", "cafe", "hub", "nook", "lab", "club", "yard", "desk", "attic"];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  $("room").value = `${pick(words)}-${pick(things)}-${Math.floor(Math.random() * 90 + 10)}`;
  $("key-field").hidden = false;
  $("room").focus();
});

// ---------------------------------------------------------------- boot
(function init() {
  const profile = store.get("profile");
  const params = new URLSearchParams(location.search);
  $("name").value = profile?.name ?? "";
  $("room").value = cleanRoomName(params.get("room") ?? store.get("room", "lobby")) || "lobby";
  renderAvatarPicker();
  setBusy(true);
  showJoin();
  if (!profile?.name) $("name").focus();
  $("copy-ico").innerHTML = icon("link", 15);
})();
