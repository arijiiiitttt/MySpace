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
const LIVE_WS_URL = process.env.WS_URL; 

export class Network {
  constructor(onMessage) {
    // Use the final URL string injected by Vite
    const ws = new WebSocket(LIVE_WS_URL); 
    
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => console.log('Connected');
    ws.onmessage = e => onMessage(new Uint8Array(e.data));
    ws.onclose = () => {
        console.log('Connection closed. Attempting to reconnect in 1 second...');
        setTimeout(() => location.reload(), 1000);
    }
    this.ws = ws;
  }
  
  send(buf) { 
    if (this.ws.readyState === 1) {
      this.ws.send(buf); 
    }
  }
}