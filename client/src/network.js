export class Network {
  constructor(onMessage) {
    const ws = new WebSocket('ws://localhost:8080');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => console.log('Connected');
    ws.onmessage = e => onMessage(new Uint8Array(e.data));
    ws.onclose = () => setTimeout(() => location.reload(), 1000);
    this.ws = ws;
  }
  send(buf) { if (this.ws.readyState === 1) this.ws.send(buf); }
}