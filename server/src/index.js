import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { GameServer } from "./GameServer.js";
import { loadWorlds } from "./world.js";
import { log } from "./util.js";

const env = process.env;
const PORT = Number(env.PORT) || 8080;
const HOST = env.HOST || "0.0.0.0";

const csv = (v) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function parseIce(raw) {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    log.warn("ICE_SERVERS is not valid JSON, falling back to public STUN");
    return undefined;
  }
}

const allowedOrigins = csv(env.ALLOWED_ORIGINS); // empty = allow any origin

const worlds = loadWorlds();
const game = new GameServer(worlds, {
  allowedOrigins,
  maxRoomPlayers: Number(env.MAX_ROOM_PLAYERS) || 40,
  maxRooms: Number(env.MAX_ROOMS) || 100,
  trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
  ...(parseIce(env.ICE_SERVERS) && { ice: parseIce(env.ICE_SERVERS) }),
});

// ---- optional: serve the built client from this same process --------------------------------
// `npm run build` in /client creates client/dist. If it exists we serve it, so a single
// service (Render, Railway, Fly, Docker...) hosts both the website and the game server.
const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(env.CLIENT_DIR || join(here, "../../client/dist"));
const serveClient = existsSync(join(CLIENT_DIR, "home.html"));
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req, res, pathname) {
  const clean = pathname === "/" ? "/index.html" : pathname === "/home" || pathname === "/home/" ? "/home.html" : pathname;
  let file = normalize(join(CLIENT_DIR, decodeURIComponent(clean)));
  if (file !== CLIENT_DIR && !file.startsWith(CLIENT_DIR + sep)) return false; // path traversal
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  const hashed = /\/assets\/.+-[\w-]{8}\.\w+$/.test(clean); // Vite fingerprints these
  res.writeHead(200, {
    "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
  return true;
}

const corsOrigin = (origin) =>
  allowedOrigins.length === 0 || allowedOrigins.includes("*") ? "*" : allowedOrigins.includes(origin) ? origin : "";

const http = createServer((req, res) => {
  const allow = corsOrigin(req.headers.origin ?? "");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(allow && { "Access-Control-Allow-Origin": allow, Vary: "Origin" }),
  };
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS" });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) }));
  }
  if (req.method === "GET" && url.pathname === "/stats") {
    res.writeHead(200, headers);
    return res.end(JSON.stringify(game.stats()));
  }
  if (serveClient && (req.method === "GET" || req.method === "HEAD")) {
    try {
      if (serveStatic(req, res, url.pathname)) return;
    } catch {
      /* fall through to 404 */
    }
  }
  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "not found" }));
});

game.attach(http);

http.on("error", (err) => {
  if (err.code === "EADDRINUSE") log.error(`port ${PORT} is already in use. Stop the other process or set PORT=<another port>`);
  else log.error(`server error: ${err.message}`);
  process.exit(1);
});

http.listen(PORT, HOST, () => {
  log.info(`My Space server listening on http://${HOST}:${PORT}  (ws + /health + /stats${serveClient ? " + client" : ""})`);
  if (allowedOrigins.length) log.info(`allowed origins: ${allowedOrigins.join(", ")}`);
});

function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  game.close();
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
