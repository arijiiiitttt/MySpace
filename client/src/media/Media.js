import { PROXIMITY } from "../app/config.js";
import { bus } from "../app/emitter.js";

/**
 * Proximity voice / video + screen sharing over WebRTC (mesh, signalling via the game server).
 *
 *  - walk within PROXIMITY.connect of someone -> peer connection opens, you hear/see each other
 *  - walk beyond PROXIMITY.disconnect         -> it closes (hysteresis avoids flapping at the edge)
 *  - volume falls off with distance
 *  - at a computer, one person can present their screen to everyone else at that computer
 *
 * Events on `bus`: media:local (state), media:remote-video ({id, stream|null}), media:speaking ({id, speaking}),
 *                  media:error (msg), screen:local (bool), screen:remote ({stream|null, from})
 */
export class Media {
  constructor(session) {
    this.session = session;
    this.mic = false;
    this.cam = false;
    this.audioTrack = null;
    this.videoTrack = null;
    this.peers = new Map(); // playerId -> Peer
    this.screenOut = new Map(); // viewerId -> RTCPeerConnection (I present)
    this.screenIn = null; // { from, pc } (I watch)
    this.screenStream = null;
    this.myPc = null; // computer id I'm at
    this.deafened = false;
    this.audioCtx = null;
    this.speaking = new Map();
    this.timer = null;

    const { net } = session;
    this.unsubs = [
      net.on("rtc", (m) => (m.ch === "screen" ? this.#onScreenSignal(m) : this.#onAvSignal(m))),
      bus.on("player:left", (p) => this.#closePeer(p.id)),
      bus.on("pc", () => this.#syncScreen()),
      bus.on("me:computer", (id) => {
        this.myPc = id;
        if (id === null) this.stopScreenShare();
        this.#syncScreen();
      }),
      bus.on("session:reset", () => this.#reset()),
    ];
  }

  start() {
    this.timer = setInterval(() => this.#tick(), 250);
    this.vadTimer = setInterval(() => this.#detectSpeech(), 120);
  }

  destroy() {
    clearInterval(this.timer);
    clearInterval(this.vadTimer);
    this.unsubs.forEach((u) => u());
    this.#reset();
    this.audioTrack?.stop();
    this.videoTrack?.stop();
    this.audioTrack = this.videoTrack = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  // ---- local devices -----------------------------------------------------------

  async toggleMic() {
    if (this.mic) {
      this.audioTrack.enabled = false;
      this.mic = false;
    } else {
      if (!this.audioTrack) {
        const track = await this.#getTrack({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }, "microphone");
        if (!track) return;
        this.audioTrack = track;
        track.onended = () => {
          this.audioTrack = null;
          this.mic = false;
          this.#publishState();
        };
        this.#watchLocalLevel(track);
      }
      this.audioTrack.enabled = true;
      this.mic = true;
    }
    this.#pushTracks();
    this.#publishState();
  }

  async toggleCam() {
    if (this.cam) {
      this.videoTrack?.stop();
      this.videoTrack = null;
      this.cam = false;
    } else {
      const track = await this.#getTrack({ video: { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 24 } } }, "camera");
      if (!track) return;
      this.videoTrack = track;
      track.onended = () => {
        this.videoTrack = null;
        this.cam = false;
        this.#pushTracks();
        this.#publishState();
      };
      this.cam = true;
    }
    this.#pushTracks();
    this.#publishState();
  }

  setDeafened(on) {
    this.deafened = on;
    for (const peer of this.peers.values()) peer.audio.muted = on;
    bus.emit("media:local", this.state());
  }

  state() {
    return { mic: this.mic, cam: this.cam, deafened: this.deafened, stream: this.videoTrack ? new MediaStream([this.videoTrack]) : null };
  }

  async #getTrack(constraints, label) {
    if (!navigator.mediaDevices?.getUserMedia) {
      bus.emit("media:error", "Your browser can't access the " + label + " here (it needs HTTPS or localhost).");
      return null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      return stream.getTracks()[0];
    } catch (err) {
      const denied = err?.name === "NotAllowedError" || err?.name === "SecurityError";
      const missing = err?.name === "NotFoundError" || err?.name === "OverconstrainedError";
      bus.emit(
        "media:error",
        denied
          ? `Permission to use the ${label} was blocked. Allow it in your browser's address bar and try again.`
          : missing
            ? `No ${label} found.`
            : `Couldn't start the ${label}: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  #publishState() {
    this.session.announceMedia(this.mic, this.cam);
    bus.emit("player:update", this.session.me, { mic: this.mic, cam: this.cam });
    bus.emit("media:local", this.state());
  }

  #pushTracks() {
    for (const peer of this.peers.values()) {
      peer.audioSender?.replaceTrack(this.audioTrack).catch(() => {});
      peer.videoSender?.replaceTrack(this.videoTrack).catch(() => {});
    }
  }

  // ---- proximity -------------------------------------------------------------------

  #tick() {
    const me = this.session.me;
    if (!me) return;
    for (const p of this.session.players.values()) {
      if (p.isMe) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      const peer = this.peers.get(p.id);
      if (!peer && d <= PROXIMITY.connect) this.#openPeer(p.id);
      else if (peer && d > PROXIMITY.disconnect) this.#closePeer(p.id);
      else if (peer) {
        const span = PROXIMITY.connect - PROXIMITY.fullVolume;
        peer.audio.volume = Math.max(0.05, Math.min(1, 1 - (d - PROXIMITY.fullVolume) / (span * 1.6)));
      }
    }
  }

  /**
   * Roles are fixed per pair so offers never collide: the player with the larger id is the
   * caller (creates transceivers, sends the offer), the other one answers. `sid` identifies one
   * connection attempt, so a stale answer/candidate from an older attempt is ignored.
   */
  #openPeer(id, sid = Math.random().toString(36).slice(2, 10)) {
    if (this.peers.has(id) || id === this.session.meId) return this.peers.get(id);
    const pc = new RTCPeerConnection({ iceServers: this.session.iceServers });
    const caller = this.session.meId > id;
    const audio = new Audio();
    audio.autoplay = true;
    audio.muted = this.deafened;
    const peer = { id, sid, pc, caller, audio, audioSender: null, videoSender: null, queued: [] };
    this.peers.set(id, peer);

    pc.ontrack = ({ track }) => {
      if (track.kind === "audio") {
        audio.srcObject = new MediaStream([track]);
        audio.play().catch(() => {});
        this.#watchRemoteLevel(id, track);
      } else {
        const show = () => bus.emit("media:remote-video", { id, stream: track.muted ? null : new MediaStream([track]) });
        track.onmute = show;
        track.onunmute = show;
        track.onended = show;
        show();
      }
    };
    pc.onicecandidate = ({ candidate }) => candidate && this.#signal(id, "av", { sid, cand: candidate });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" && this.peers.get(id) === peer) {
        this.#closePeer(id); // the proximity tick opens a fresh one if we're still close
      }
    };

    if (caller) {
      const a = pc.addTransceiver("audio", { direction: "sendrecv" });
      const v = pc.addTransceiver("video", { direction: "sendrecv" });
      peer.audioSender = a.sender;
      peer.videoSender = v.sender;
      if (this.audioTrack) a.sender.replaceTrack(this.audioTrack).catch(() => {});
      if (this.videoTrack) v.sender.replaceTrack(this.videoTrack).catch(() => {});
      pc.onnegotiationneeded = async () => {
        try {
          await pc.setLocalDescription();
          this.#signal(id, "av", { sid, desc: pc.localDescription });
        } catch (err) {
          console.warn("offer failed", err);
        }
      };
    }
    return peer;
  }

  #closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.audio.srcObject = null;
    this.speaking.delete(id);
    bus.emit("media:remote-video", { id, stream: null });
    bus.emit("media:speaking", { id, speaking: false });
  }

  async #flushCandidates(peer) {
    const queued = peer.queued.splice(0);
    for (const cand of queued) await peer.pc.addIceCandidate(cand).catch(() => {});
  }

  async #onAvSignal({ from, d }) {
    if (!d) return;
    try {
      if (d.desc?.type === "offer") {
        // We are the callee. A new sid means the caller started over: drop the old connection.
        let peer = this.peers.get(from);
        if (peer && peer.sid !== d.sid) {
          this.#closePeer(from);
          peer = null;
        }
        if (!peer) {
          const them = this.session.players.get(from);
          const me = this.session.me;
          if (!them || !me || Math.hypot(them.x - me.x, them.y - me.y) > PROXIMITY.disconnect) return;
          peer = this.#openPeer(from, d.sid);
        }
        if (peer.caller) return; // we call this one; ignore a crossed offer
        const { pc } = peer;
        await pc.setRemoteDescription(d.desc);
        // The offer created our transceivers receive-only; we want to send back too.
        for (const t of pc.getTransceivers()) {
          t.direction = "sendrecv";
          if (t.receiver.track.kind === "audio") peer.audioSender = t.sender;
          else peer.videoSender = t.sender;
        }
        peer.audioSender?.replaceTrack(this.audioTrack).catch(() => {});
        peer.videoSender?.replaceTrack(this.videoTrack).catch(() => {});
        await pc.setLocalDescription();
        this.#signal(from, "av", { sid: d.sid, desc: pc.localDescription });
        await this.#flushCandidates(peer);
        return;
      }

      const peer = this.peers.get(from);
      if (!peer || peer.sid !== d.sid) return;
      if (d.desc?.type === "answer") {
        if (peer.pc.signalingState === "have-local-offer") await peer.pc.setRemoteDescription(d.desc);
        await this.#flushCandidates(peer);
      } else if (d.cand) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(d.cand).catch(() => {});
        else peer.queued.push(d.cand);
      }
    } catch (err) {
      console.warn("av signal error", err);
    }
  }

  #signal(to, ch, d, extra = {}) {
    this.session.net.send({ t: "rtc", to, ch, d, ...extra });
  }

  // ---- speech detection ------------------------------------------------------------

  #ctx() {
    this.audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state === "suspended") this.audioCtx.resume().catch(() => {});
    return this.audioCtx;
  }

  #analyser(track) {
    try {
      const ctx = this.#ctx();
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      return { analyser, data: new Uint8Array(analyser.fftSize), src };
    } catch {
      return null;
    }
  }

  #watchLocalLevel(track) {
    this.localLevel = this.#analyser(track);
  }

  #watchRemoteLevel(id, track) {
    const peer = this.peers.get(id);
    if (peer) peer.level = this.#analyser(track);
  }

  #level(l) {
    if (!l) return 0;
    l.analyser.getByteTimeDomainData(l.data);
    let sum = 0;
    for (const v of l.data) sum += (v - 128) ** 2;
    return Math.sqrt(sum / l.data.length) / 128;
  }

  #detectSpeech() {
    const set = (id, on) => {
      if (this.speaking.get(id) === on) return;
      this.speaking.set(id, on);
      bus.emit("media:speaking", { id, speaking: on });
    };
    if (this.session.meId) set(this.session.meId, this.mic && this.#level(this.localLevel) > 0.04);
    for (const [id, peer] of this.peers) set(id, this.#level(peer.level) > 0.03);
  }

  // ---- screen sharing -----------------------------------------------------------------

  get isPresenting() {
    return !!this.screenStream;
  }

  async startScreenShare() {
    if (this.myPc === null) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      bus.emit("media:error", "Screen sharing isn't supported in this browser.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    } catch (err) {
      if (err?.name !== "NotAllowedError") bus.emit("media:error", `Couldn't share your screen: ${err?.message ?? err}`);
      return;
    }
    this.screenStream = stream;
    stream.getVideoTracks()[0].onended = () => this.stopScreenShare();
    this.shareConfirmed = false;
    this.session.share(this.myPc, true);
    bus.emit("screen:local", stream);
    // If the server never names us presenter (someone else got there first), give up.
    setTimeout(() => {
      if (this.screenStream === stream && !this.shareConfirmed) this.stopScreenShare();
    }, 3000);
  }

  stopScreenShare() {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.shareConfirmed = false;
    for (const pc of this.screenOut.values()) pc.close();
    this.screenOut.clear();
    if (this.myPc !== null) this.session.share(this.myPc, false);
    bus.emit("screen:local", null);
  }

  /** Reconcile peer connections with who is at my computer right now. */
  #syncScreen() {
    const me = this.session.meId;
    const st = this.myPc === null ? null : this.session.pcs.get(this.myPc);

    // viewers: tear down if the presenter changed or left
    if (this.screenIn && (!st || st.sharer !== this.screenIn.from)) {
      this.screenIn.pc.close();
      this.screenIn = null;
      bus.emit("screen:remote", { from: null, stream: null });
    }
    if (!st || st.sharer !== me) {
      // Ignore the update that was already in flight before the server heard "share".
      if (this.screenStream && this.shareConfirmed) this.stopScreenShare();
      return;
    }
    this.shareConfirmed = true;
    if (!this.screenStream) return;

    // presenter: one outgoing connection per viewer
    for (const [id, pc] of this.screenOut) {
      if (!st.users.includes(id)) {
        pc.close();
        this.screenOut.delete(id);
      }
    }
    for (const id of st.users) {
      if (id === me || this.screenOut.has(id)) continue;
      this.#offerScreen(id);
    }
  }

  async #offerScreen(viewerId) {
    const pc = new RTCPeerConnection({ iceServers: this.session.iceServers });
    this.screenOut.set(viewerId, pc);
    const track = this.screenStream.getVideoTracks()[0];
    pc.addTransceiver(track, { direction: "sendonly", streams: [this.screenStream] });
    pc.onicecandidate = ({ candidate }) => candidate && this.#signal(viewerId, "screen", { cand: candidate }, { pc: this.myPc });
    try {
      await pc.setLocalDescription();
      this.#signal(viewerId, "screen", { desc: pc.localDescription }, { pc: this.myPc });
    } catch (err) {
      console.warn("screen offer failed", err);
    }
  }

  async #onScreenSignal({ from, d, pc: pcId }) {
    if (!d || pcId !== this.myPc) return;
    try {
      // presenter side: viewer answers / sends candidates
      const out = this.screenOut.get(from);
      if (out) {
        if (d.desc) await out.setRemoteDescription(d.desc);
        else if (d.cand) await out.addIceCandidate(d.cand);
        return;
      }
      // viewer side
      const st = this.session.pcs.get(this.myPc);
      if (!st || st.sharer !== from) return;
      if (d.desc?.type === "offer") {
        this.screenIn?.pc.close();
        const pc = new RTCPeerConnection({ iceServers: this.session.iceServers });
        this.screenIn = { from, pc };
        pc.ontrack = ({ streams, track }) => bus.emit("screen:remote", { from, stream: streams[0] ?? new MediaStream([track]) });
        pc.onicecandidate = ({ candidate }) => candidate && this.#signal(from, "screen", { cand: candidate }, { pc: this.myPc });
        await pc.setRemoteDescription(d.desc);
        await pc.setLocalDescription();
        this.#signal(from, "screen", { desc: pc.localDescription }, { pc: this.myPc });
      } else if (d.cand && this.screenIn?.from === from) {
        await this.screenIn.pc.addIceCandidate(d.cand);
      }
    } catch (err) {
      console.warn("screen signal error", err);
    }
  }

  #reset() {
    for (const id of [...this.peers.keys()]) this.#closePeer(id);
    this.stopScreenShare();
    this.screenIn?.pc.close();
    this.screenIn = null;
    this.myPc = null;
    bus.emit("screen:remote", { from: null, stream: null });
  }
}
