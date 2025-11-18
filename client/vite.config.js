// vite.config.js

import { defineConfig } from 'vite';

// Prioritize the environment variable (VITE_WS_URL) for production deployment
// and fall back to the local URL for development //my-space-server.up.railway.app
const WS_URL = process.env.VITE_WS_URL || 'ws://localhost:8080';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    open: true
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: 'index.html',
        game:  'home.html'
      }
    }
  },
  define: {
    // ⭐ This line injects the determined URL into the client code 
    // using the name 'process.env.WS_URL', which network.js reads.
    'process.env.WS_URL': JSON.stringify(WS_URL) 
  }
});