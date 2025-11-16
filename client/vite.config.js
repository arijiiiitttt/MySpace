import { defineConfig } from 'vite';

export default defineConfig({
  base: './',                         // <-- assets load with relative paths
  server: {
    port: 5173,
    open: true
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: 'index.html',        // <-- entry for character-selection page
        game:  'home.html'          // <-- entry for the actual game page
      }
    }
  },
  define: {
    // Makes the WS URL available in client code (process.env.WS_URL)
    'process.env.WS_URL': JSON.stringify('ws://localhost:8080')
  }
});