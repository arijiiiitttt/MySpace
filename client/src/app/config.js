/**
 * Where is the game server?
 *
 *  1. VITE_SERVER_URL (set at build time)   e.g. https://myspace-server.onrender.com
 *  2. dev server                            -> same host, port 8080
 *  3. otherwise                             -> same origin (server serves the client)
 */
const env = import.meta.env;

function baseHttpUrl() {
  const explicit = env.VITE_SERVER_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (env.DEV) return `${location.protocol}//${location.hostname}:8080`;
  return location.origin;
}

export const HTTP_URL = baseHttpUrl();
export const WS_URL = HTTP_URL.replace(/^http/, "ws");

/** Voice / video kicks in inside this radius (world pixels). */
export const PROXIMITY = {
  connect: 150,
  disconnect: 200,
  fullVolume: 60,
};

export async function fetchStats(signal) {
  const res = await fetch(`${HTTP_URL}/stats`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`stats ${res.status}`);
  return res.json();
}
