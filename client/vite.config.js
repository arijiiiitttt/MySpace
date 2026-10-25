import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * Clean URLs: /home -> home.html (dev + preview). In production the host does
 * this (vercel.json `cleanUrls`, or the bundled Node server).
 */
const cleanUrls = () => {
  const rewrite = (req, _res, next) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/home" || path === "/home/") req.url = "/home.html" + (req.url.includes("?") ? "?" + req.url.split("?")[1] : "");
    next();
  };
  return {
    name: "myspace-clean-urls",
    // (block bodies: returning the middleware stack would make Vite treat it as a post-hook)
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
};

export default defineConfig({
  plugins: [cleanUrls()],
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
  build: {
    outDir: "dist",
    target: "es2020",
    chunkSizeWarningLimit: 1500, // Phaser alone is ~1.2 MB minified
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        home: resolve(import.meta.dirname, "home.html"),
      },
      output: {
        manualChunks: { phaser: ["phaser"] },
      },
    },
  },
});
