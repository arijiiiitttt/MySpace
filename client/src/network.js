// export class Network {
//   constructor(onMessage) {
//     const ws = new WebSocket('ws://localhost:8080');
//     ws.binaryType = 'arraybuffer';
//     ws.onopen = () => console.log('Connected');
//     ws.onmessage = e => onMessage(new Uint8Array(e.data));
//     ws.onclose = () => setTimeout(() => location.reload(), 1000);
//     this.ws = ws;
//   }
//   send(buf) { if (this.ws.readyState === 1) this.ws.send(buf); }
// }


// This variable will be replaced by Vite during the build process:
// - Locally: 'ws://localhost:8080'
// - Deployed: 'wss://my-space-nb19.onrender.com'
// Auto-detect WebSocket URL (local vs production)
function getWebSocketURL() {
  const isLocal = window.location.hostname === "localhost";
  if (isLocal) return "ws://localhost:8080";

  // Production (Netlify → Render backend)
  return "wss://my-space-server.up.railway.app/";
}

export class Network {
  constructor(onMessage) {
    const ws = new WebSocket(getWebSocketURL());
    ws.binaryType = "arraybuffer";

    ws.onopen = () => console.log("Connected to WebSocket");
    ws.onmessage = (e) => onMessage(new Uint8Array(e.data));

    ws.onclose = () => {
      console.log("Disconnected. Reconnecting in 1 sec...");
      setTimeout(() => location.reload(), 1000);
    };

    this.ws = ws;
  }

  send(buf) {
    if (this.ws.readyState === 1) {
      this.ws.send(buf);
    }
  }
}
