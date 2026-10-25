import { Emitter } from "../app/emitter.js";
import { WS_URL } from "../app/config.js";

const CONNECT_TIMEOUT_MS = 8000;
const PING_EVERY_MS = 4000;

/**
 * WebSocket client.
 *
 *   const net = new Network();
 *   const hello = await net.connect({ name, avatar, room, key });   // rejects on fatal errors
 *   net.on("chat", (m) => ...);        // every server message is emitted by its `t`
 *   net.send({ t: "chat", text });
 *
 * If the socket drops after a successful join it reconnects with backoff,
 * re-joins the same room at the last known position and emits "rehello".
 */
export class Network extends Emitter {
  status = "idle"; // idle | connecting | online | reconnecting | closed
  id = null;
  ice = [];
  latency = null;

  #ws = null;
  #params = null;
  #joined = false;
  #manualClose = false;
  #fatal = false;
  #attempt = 0;
  #reconnectTimer = null;
  #pingTimer = null;
  #first = null;
  #getPosition = () => ({});

  /** Lets us rejoin where the player was standing. */
  setPositionProvider(fn) {
    this.#getPosition = fn;
  }

  connect(params) {
    this.#params = params;
    this.#manualClose = false;
    this.#fatal = false;
    this.#joined = false;
    this.#attempt = 0;
    return new Promise((resolve, reject) => {
      this.#first = { resolve, reject };
      this.#open();
    });
  }

  send(obj) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  close() {
    this.#manualClose = true;
    clearTimeout(this.#reconnectTimer);
    clearInterval(this.#pingTimer);
    this.#ws?.close(1000);
    this.#setStatus("closed");
  }

  #setStatus(status, extra = {}) {
    if (this.status === status && !Object.keys(extra).length) return;
    this.status = status;
    this.emit("status", status, extra);
  }

  #open() {
    this.#setStatus(this.#joined ? "reconnecting" : "connecting", { attempt: this.#attempt });
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      return this.#onClosed(new Error("Invalid server address."));
    }
    this.#ws = ws;
    const timer = setTimeout(() => ws.close(), CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(timer);
      this.send({ t: "join", ...this.#params, ...(this.#joined ? this.#getPosition() : {}) });
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#onMessage(msg);
    };

    ws.onclose = () => {
      clearTimeout(timer);
      if (ws !== this.#ws) return; // a stale socket from an earlier attempt
      this.#onClosed();
    };
    ws.onerror = () => {};
  }

  #onMessage(msg) {
    switch (msg.t) {
      case "hello": {
        const first = !this.#joined;
        this.#joined = true;
        this.#attempt = 0;
        this.id = msg.id;
        this.ice = msg.ice ?? [];
        this.#setStatus("online");
        this.#startPing();
        if (first) {
          this.#first?.resolve(msg);
          this.#first = null;
        }
        this.emit(first ? "hello" : "rehello", msg);
        return;
      }
      case "err":
        if (msg.fatal) {
          this.#fatal = true;
          const error = Object.assign(new Error(msg.msg || "Could not join."), { code: msg.code });
          if (this.#first) {
            this.#first.reject(error);
            this.#first = null;
          }
          this.emit("fatal", error);
        }
        this.emit("err", msg);
        return;
      case "pong":
        this.latency = Math.max(0, Date.now() - msg.n);
        this.emit("latency", this.latency);
        return;
      default:
        this.emit(msg.t, msg);
    }
  }

  #startPing() {
    clearInterval(this.#pingTimer);
    this.#pingTimer = setInterval(() => this.send({ t: "ping", n: Date.now() }), PING_EVERY_MS);
    this.send({ t: "ping", n: Date.now() });
  }

  #onClosed(error) {
    clearInterval(this.#pingTimer);
    if (this.#manualClose || this.#fatal) {
      this.#setStatus("closed");
      return;
    }
    if (!this.#joined) {
      // Never got in: tell the caller instead of retrying forever behind a form.
      this.#setStatus("closed");
      this.#first?.reject(error ?? new Error("Can't reach the server. Is it running?"));
      this.#first = null;
      return;
    }
    this.#attempt += 1;
    const delay = Math.min(500 * 2 ** (this.#attempt - 1), 8000) + Math.random() * 400;
    this.#setStatus("reconnecting", { attempt: this.#attempt, retryIn: delay });
    this.#reconnectTimer = setTimeout(() => this.#open(), delay);
  }
}
