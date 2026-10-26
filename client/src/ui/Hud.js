import { bus } from "../app/emitter.js";
import { MAPS, mapInfo } from "../game/maps.js";
import { EMOTES, colorFor, AVATARS } from "../net/protocol.js";
import { icon } from "./icons.js";
import { fa, EMOTE_ICONS, EMOTE_COLORS } from "./fa.js";
import { drawAvatar } from "./sprites.js";

const $ = (id) => document.getElementById(id);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Everything on screen that isn't the game canvas: dock, chat, people list,
 * video tiles, the computer / screen-share panel, toasts and shortcuts.
 */
export class Hud {
  constructor(session, media, labels) {
    this.session = session;
    this.media = media;
    this.labels = labels;
    this.tab = "chat";
    this.unread = 0;
    this.sideOpen = false;
    this.computer = null;
    this.tiles = new Map();
    this.offs = [];
    this.peopleDirty = false;
    this.#icons();
    this.#bindDock();
    this.#bindChat();
    this.#bindScreen();
    this.#bindProfile();
    this.#bindKeys();
    this.#bindBus();
  }

  // ---- lifecycle -------------------------------------------------------------

  show() {
    const { session } = this;
    $("hud").hidden = false;
    $("room-name").textContent = session.room.id;
    $("room-lock").hidden = !session.room.locked;
    $("room-lock").innerHTML = icon("lock", 13);
    this.#renderCount();
    this.#renderChatAll();
    this.#renderPeople();
    this.#syncDock();
    $("help").classList.remove("is-faded");
    clearTimeout(this.helpTimer);
    this.helpTimer = setTimeout(() => $("help").classList.add("is-faded"), 14000);
    this.systemMessage(`You joined #${session.room.id}`);
  }

  hide() {
    $("hud").hidden = true;
    this.#setSide(false);
    this.#closeEmoteMenu();
    this.#closeComputer();
    for (const id of [...this.tiles.keys()]) this.#removeTile(id);
    $("chat-log").replaceChildren();
    this.unread = 0;
    this.#renderUnread();
    clearTimeout(this.helpTimer);
  }

  destroy() {
    this.offs.forEach((off) => off());
  }

  // ---- toasts -------------------------------------------------------------------

  toast(text, kind = "info", ms = 3200, iconName = null) {
    const el = document.createElement("div");
    el.className = `toast toast--${kind}`;
    if (iconName) el.innerHTML = fa(iconName) + " ";
    el.append(document.createTextNode(text));
    $("toasts").append(el);
    while ($("toasts").children.length > 3) $("toasts").firstChild.remove();
    setTimeout(() => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 260);
    }, ms);
  }

  // ---- setup ------------------------------------------------------------------------

  #icons() {
    $("btn-chat").innerHTML = icon("chat", 21) + `<b class="badge" id="chat-badge" hidden></b>`;
    $("btn-people").innerHTML = icon("users", 21);
    $("btn-emote").innerHTML = icon("smile", 21);
    $("btn-profile").innerHTML = icon("sliders", 21);
    $("btn-leave").innerHTML = icon("logout", 21);
    $("side-close").innerHTML = icon("x", 18);
    $("chat-send").innerHTML = icon("send", 18);
    $("copy-ico").innerHTML = icon("link", 15);
    this.#syncDock();
  }

  #syncDock() {
    const { media } = this;
    const set = (id, on, onIcon, offIcon) => {
      const b = $(id);
      b.innerHTML = icon(on ? onIcon : offIcon, 21);
      b.classList.toggle("is-on", on);
      b.classList.toggle("is-off", !on);
      b.setAttribute("aria-pressed", String(on));
    };
    set("btn-mic", media.mic, "mic", "mic-off");
    set("btn-cam", media.cam, "video", "video-off");
    const deaf = $("btn-deaf");
    deaf.innerHTML = icon(media.deafened ? "volume-off" : "volume", 21);
    deaf.classList.toggle("is-off", media.deafened);
    deaf.setAttribute("aria-pressed", String(media.deafened));
    $("btn-chat").classList.toggle("is-on", this.sideOpen && this.tab === "chat");
    $("btn-people").classList.toggle("is-on", this.sideOpen && this.tab === "people");
    this.#renderUnread();
  }

  #bindDock() {
    $("btn-mic").onclick = () => this.media.toggleMic();
    $("btn-cam").onclick = () => this.media.toggleCam();
    $("btn-deaf").onclick = () => this.media.setDeafened(!this.media.deafened);
    $("btn-chat").onclick = () => this.#toggleSide("chat");
    $("btn-people").onclick = () => this.#toggleSide("people");
    $("side-close").onclick = () => this.#setSide(false);
    $("btn-leave").onclick = () => bus.emit("app:leave");
    $("tab-chat").onclick = () => this.#setTab("chat");
    $("tab-people").onclick = () => this.#setTab("people");

    const menu = $("emote-menu");
    menu.replaceChildren(
      ...EMOTES.map((e, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.innerHTML = fa(EMOTE_ICONS[e]);
        b.firstChild.style.color = EMOTE_COLORS[e];
        b.title = `${e}  (${i + 1})`;
        b.setAttribute("aria-label", e);
        b.onclick = () => {
          this.session.sendEmote(e);
          this.#closeEmoteMenu();
        };
        return b;
      }),
    );
    $("btn-emote").onclick = (ev) => {
      ev.stopPropagation();
      menu.hidden ? this.#openEmoteMenu() : this.#closeEmoteMenu();
    };
    document.addEventListener("pointerdown", (e) => {
      if (!menu.hidden && !e.target.closest(".emote-wrap")) this.#closeEmoteMenu();
    });

    $("room-pill").onclick = async () => {
      const url = `${location.origin}/home?room=${encodeURIComponent(this.session.room.id)}`;
      try {
        await navigator.clipboard.writeText(url);
        this.toast(this.session.room.locked ? "Invite link copied. Share the password separately." : "Invite link copied!");
      } catch {
        this.toast(url, "info", 6000);
      }
    };
  }

  #openEmoteMenu() {
    $("emote-menu").hidden = false;
    $("btn-emote").setAttribute("aria-expanded", "true");
  }
  #closeEmoteMenu() {
    $("emote-menu").hidden = true;
    $("btn-emote").setAttribute("aria-expanded", "false");
  }

  // ---- side panel: chat + people ----------------------------------------------------

  #toggleSide(tab) {
    if (this.sideOpen && this.tab === tab) return this.#setSide(false);
    this.#setSide(true);
    this.#setTab(tab);
    if (tab === "chat") $("chat-input").focus({ preventScroll: true });
  }

  #setSide(open) {
    this.sideOpen = open;
    $("side").hidden = !open;
    if (open && this.tab === "chat") {
      this.unread = 0;
      this.#renderUnread();
      this.#scrollChat();
    }
    if (!open) document.activeElement?.blur?.();
    this.#syncDock();
  }

  #setTab(tab) {
    this.tab = tab;
    $("chat-pane").hidden = tab !== "chat";
    $("people-pane").hidden = tab !== "people";
    $("tab-chat").classList.toggle("is-active", tab === "chat");
    $("tab-people").classList.toggle("is-active", tab === "people");
    if (tab === "chat") {
      this.unread = 0;
      this.#renderUnread();
      this.#scrollChat();
    } else {
      this.#renderPeople();
    }
    this.#syncDock();
  }

  #renderUnread() {
    const n = this.unread;
    const badge = $("chat-badge");
    if (badge) {
      badge.hidden = n === 0;
      badge.textContent = n > 9 ? "9+" : String(n);
    }
    $("unread").hidden = n === 0;
    $("unread").textContent = String(n);
  }

  #bindChat() {
    $("chat-form").onsubmit = (e) => {
      e.preventDefault();
      const input = $("chat-input");
      const text = input.value.trim();
      if (!text) return;
      this.session.sendChat(text);
      input.value = "";
    };
    $("chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        $("chat-input").blur();
      }
    });
  }

  #renderChatAll() {
    const log = $("chat-log");
    log.replaceChildren();
    const msgs = this.session.chat;
    if (!msgs.length) {
      const empty = document.createElement("li");
      empty.className = "chat-empty";
      empty.id = "chat-empty";
      empty.textContent = "No messages yet. Say hi! Messages also pop up above your head.";
      log.append(empty);
    }
    for (const m of msgs) this.#appendMessage(m, false);
    this.#scrollChat();
  }

  #appendMessage(m, count = true) {
    $("chat-empty")?.remove();
    const mine = m.id === this.session.meId;
    const li = document.createElement("li");
    li.className = "msg" + (mine ? " msg--mine" : "");
    const who = document.createElement("div");
    who.className = "msg__who";
    who.style.color = colorFor(m.id);
    who.textContent = mine ? "You" : m.name;
    const time = document.createElement("span");
    time.className = "msg__time";
    time.textContent = fmtTime(m.ts);
    who.append(time);
    const text = document.createElement("div");
    text.className = "msg__text";
    text.textContent = m.text;
    li.append(who, text);
    this.#pushLog(li);
    if (count && !mine && !(this.sideOpen && this.tab === "chat")) {
      this.unread += 1;
      this.#renderUnread();
    }
  }

  systemMessage(text) {
    $("chat-empty")?.remove();
    const li = document.createElement("li");
    li.className = "msg--system";
    li.textContent = text;
    this.#pushLog(li);
  }

  #pushLog(li) {
    const log = $("chat-log");
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.append(li);
    while (log.children.length > 200) log.firstChild.remove();
    if (nearBottom) this.#scrollChat();
  }

  #scrollChat() {
    const log = $("chat-log");
    requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
  }

  #renderCount() {
    const { session } = this;
    const here = mapInfo(session.map);
    const n = session.players.size;
    const elsewhere = Object.entries(session.where ?? {}).reduce((sum, [id, c]) => (id === session.map ? sum : sum + c), 0);
    $("room-count").innerHTML = `${here.icon ? fa(here.icon) + " " : ""}<span>${here.name} · ${n} here${elsewhere ? ` · +${elsewhere}` : ""}</span>`;
    $("room-pill").title = "Copy invite link";
    this.#renderMapChips();
  }

  #renderMapChips() {
    const wrap = $("map-chips");
    if (!wrap) return;
    const { session } = this;
    wrap.replaceChildren(
      ...MAPS.map((m) => {
        const chip = document.createElement("span");
        chip.className = "map-chip" + (m.id === session.map ? " is-here" : "");
        chip.innerHTML = `${m.icon ? fa(m.icon) + " " : ""}`;
        chip.append(document.createTextNode(`${m.name} `));
        const b = document.createElement("b");
        b.textContent = String(session.where?.[m.id] ?? (m.id === session.map ? session.players.size : 0));
        chip.append(b);
        return chip;
      }),
    );
  }

  #queuePeople() {
    if (this.peopleDirty) return;
    this.peopleDirty = true;
    requestAnimationFrame(() => {
      this.peopleDirty = false;
      this.#renderPeople();
    });
  }

  #renderPeople() {
    this.#renderCount();
    if (!this.sideOpen || this.tab !== "people") return;
    const list = $("people-list");
    const players = [...this.session.players.values()].sort((a, b) => (b.isMe - a.isMe) || a.name.localeCompare(b.name));
    list.replaceChildren(
      ...players.map((p) => {
        const li = document.createElement("li");
        li.className = "person";
        const c = document.createElement("canvas");
        drawAvatar(c, p.avatar);
        const info = document.createElement("div");
        info.style.minWidth = "0";
        const name = document.createElement("div");
        name.className = "person__name";
        name.style.color = colorFor(p.id);
        name.textContent = p.isMe ? `${p.name} (you)` : p.name;
        const meta = document.createElement("div");
        meta.className = "person__meta";
        meta.textContent = p.pc != null ? `At computer ${p.pc + 1}` : p.seat != null ? "Sitting" : "Walking around";
        info.append(name, meta);
        li.append(c, info);
        if (p.mic || p.cam) {
          const icons = document.createElement("div");
          icons.className = "person__icons";
          icons.innerHTML = (p.mic ? icon("mic", 15) : "") + (p.cam ? icon("video", 15) : "");
          li.append(icons);
        }
        if (!p.isMe) {
          const go = document.createElement("button");
          go.className = "btn btn--ghost btn--sm";
          go.textContent = "Go to";
          go.onclick = () => bus.emit("ui:goto", { x: p.x, y: p.y + 20 });
          if (!(p.mic || p.cam)) li.append(go);
        }
        return li;
      }),
    );
  }

  // ---- computer / screen share --------------------------------------------------------

  #bindScreen() {
    $("screen-leave").onclick = () => bus.emit("ui:leave-computer");
    $("screen-size").onclick = () => {
      const large = $("screen-panel").classList.toggle("is-large");
      $("screen-size").textContent = large ? "Shrink" : "Expand";
    };
    $("screen-share").onclick = () => (this.media.isPresenting ? this.media.stopScreenShare() : this.media.startScreenShare());
  }

  #openComputer(id) {
    this.computer = id;
    $("screen-panel").hidden = false;
    $("screen-title").textContent = `Computer ${id + 1}`;
    this.#renderScreen();
  }

  #closeComputer() {
    this.computer = null;
    $("screen-panel").hidden = true;
    const v = $("screen-video");
    v.srcObject = null;
    this.screenSource = null;
  }

  #renderScreen() {
    if (this.computer === null) return;
    const { session, media } = this;
    const st = session.pcs.get(this.computer) ?? { users: [session.meId], sharer: null };
    const presenter = st.sharer ? session.players.get(st.sharer) : null;
    const iPresent = media.isPresenting;
    const btn = $("screen-share");
    btn.innerHTML = iPresent ? icon("x", 15) + "Stop sharing" : icon("monitor-up", 15) + "Share screen";
    btn.disabled = !iPresent && !!st.sharer && st.sharer !== session.meId;
    $("screen-sub").textContent =
      st.users.length <= 1
        ? "Only you here"
        : `${st.users.length} here` + (presenter && !presenter.isMe ? ` · ${presenter.name} is presenting` : iPresent ? " · you're presenting" : "");
    $("screen-empty").hidden = !!this.screenSource;
    if (!this.screenSource) {
      $("screen-empty").textContent = presenter && !presenter.isMe ? `Connecting to ${presenter.name}'s screen…` : "Nobody is presenting. Share your screen to show everyone at this computer.";
    }
  }

  #setScreenSource(stream) {
    const v = $("screen-video");
    this.screenSource = stream;
    v.srcObject = stream;
    v.muted = true;
    if (stream) v.play().catch(() => {});
    this.#renderScreen();
  }

  // ---- video tiles -------------------------------------------------------------------

  #setTile(id, stream, { me = false, name = "" } = {}) {
    let tile = this.tiles.get(id);
    if (!stream) return this.#removeTile(id);
    if (!tile) {
      const el = document.createElement("div");
      el.className = "vtile" + (me ? " vtile--me" : "");
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true; // audio is played separately
      const label = document.createElement("span");
      el.append(video, label);
      $("videos").append(el);
      tile = { el, video, label };
      this.tiles.set(id, tile);
    }
    tile.label.textContent = me ? "You" : name;
    if (tile.video.srcObject !== stream) {
      tile.video.srcObject = stream;
      tile.video.play().catch(() => {});
    }
  }

  #removeTile(id) {
    const t = this.tiles.get(id);
    if (!t) return;
    t.video.srcObject = null;
    t.el.remove();
    this.tiles.delete(id);
  }

  // ---- profile ------------------------------------------------------------------------

  #bindProfile() {
    const dlg = $("profile-dialog");
    let chosen = null;
    const renderChoices = () => {
      const wrap = $("profile-avatars");
      wrap.replaceChildren(
        ...AVATARS.map((a) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "avatar";
          b.setAttribute("role", "radio");
          b.setAttribute("aria-checked", String(a.id === chosen));
          const c = document.createElement("canvas");
          drawAvatar(c, a.id);
          const s = document.createElement("span");
          s.textContent = a.label;
          b.append(c, s);
          b.onclick = () => {
            chosen = a.id;
            renderChoices();
          };
          return b;
        }),
      );
    };
    $("btn-profile").onclick = () => {
      const me = this.session.me;
      if (!me) return;
      chosen = me.avatar;
      $("profile-name").value = me.name;
      renderChoices();
      dlg.showModal();
    };
    $("profile-form").addEventListener("submit", () => {
      if (dlg.returnValue === "cancel") return;
    });
    dlg.addEventListener("close", () => {
      if (dlg.returnValue !== "ok") return;
      const me = this.session.me;
      const name = $("profile-name").value.trim();
      const changes = {};
      if (name && name !== me.name) changes.name = name;
      if (chosen && chosen !== me.avatar) changes.avatar = chosen;
      if (Object.keys(changes).length) this.session.updateProfile(changes);
    });
  }

  // ---- keyboard shortcuts --------------------------------------------------------------

  #bindKeys() {
    const onKey = (e) => {
      if ($("hud").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (document.querySelector("dialog[open]")) return;
      if (typing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        this.#setSide(true);
        this.#setTab("chat");
        $("chat-input").focus();
      } else if (e.key === "m" || e.key === "M") {
        this.media.toggleMic();
      } else if (e.key === "v" || e.key === "V") {
        this.media.toggleCam();
      } else if (/^[1-8]$/.test(e.key)) {
        this.session.sendEmote(EMOTES[Number(e.key) - 1]);
      }
    };
    document.addEventListener("keydown", onKey);
    this.offs.push(() => document.removeEventListener("keydown", onKey));
  }

  // ---- bus ----------------------------------------------------------------------------

  #bindBus() {
    const on = (type, fn) => this.offs.push(bus.on(type, fn));
    const { session, labels } = this;

    on("toast", ({ text, kind }) => this.toast(text, kind));
    on("media:error", (msg) => this.toast(msg, "error", 6000));
    on("media:local", (st) => {
      this.#syncDock();
      this.#setTile(session.meId, st.stream, { me: true });
      this.#renderPeople();
    });
    on("media:remote-video", ({ id, stream }) => {
      const p = session.players.get(id);
      this.#setTile(id, stream, { name: p?.name ?? "" });
    });
    on("media:speaking", ({ id, speaking }) => {
      labels.setSpeaking(id, speaking);
      this.tiles.get(id)?.el.classList.toggle("is-speaking", speaking);
    });

    on("chat", (m) => this.#appendMessage(m));
    on("player:joined", (p, info) => {
      this.systemMessage(info?.from ? `${p.name} arrived from the ${mapInfo(info.from).name}` : `${p.name} joined`);
      this.#queuePeople();
    });
    on("player:left", (p, info) => {
      if (!info?.silent) this.systemMessage(info?.to ? `${p.name} went to the ${mapInfo(info.to).name}` : `${p.name} left`);
      this.#removeTile(p.id);
      this.#queuePeople();
    });
    on("where", () => this.#renderCount());
    on("map:change", ({ map }) => {
      const info = mapInfo(map);
      this.systemMessage(`You are in the ${info.name}`);
      this.toast(info.name, "info", 3200, info.icon);
      this.#renderPeople();
    });
    on("player:update", (p, changes) => {
      if (changes.name !== undefined && p.isMe) this.toast("Profile updated");
      this.#queuePeople();
    });
    on("seat", () => this.#queuePeople());
    on("pc", () => {
      this.#queuePeople();
      this.#renderScreen();
    });

    on("me:computer", (id) => (id === null ? this.#closeComputer() : this.#openComputer(id)));
    on("screen:local", (stream) => {
      this.#setScreenSource(stream);
      if (stream) this.toast("You're presenting. Everyone at this computer can see your screen.");
    });
    on("screen:remote", ({ stream }) => this.#setScreenSource(stream));

    on("net:status", (status, info) => {
      const badge = $("net-badge");
      const rc = $("reconnect");
      badge.classList.toggle("is-bad", status === "reconnecting");
      if (status === "reconnecting") {
        rc.hidden = false;
        $("reconnect-text").textContent = `Connection lost. Reconnecting${info?.attempt > 1 ? ` (try ${info.attempt})` : ""}…`;
        $("net-text").textContent = "offline";
      } else {
        rc.hidden = true;
        if (status === "online") $("net-text").textContent = "online";
      }
    });
    on("net:latency", (ms) => {
      const badge = $("net-badge");
      badge.classList.toggle("is-warn", ms >= 150 && ms < 350);
      badge.classList.toggle("is-bad", ms >= 350);
      $("net-text").textContent = `${ms} ms`;
    });
    on("session:reset", () => {
      this.#renderChatAll();
      this.systemMessage("Reconnected");
      this.#renderPeople();
      this.toast("Reconnected!");
    });
  }
}

