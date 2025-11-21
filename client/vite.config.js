import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: "index.html",
        game: "home.html",
      },
    },
  },
});
