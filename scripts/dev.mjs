#!/usr/bin/env node
/** Runs the game server (:8080) and the Vite dev server (:5173) together. Ctrl+C stops both. */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const procs = [
  { name: "server", color: "\x1b[36m", args: ["run", "dev", "--prefix", "server"] },
  { name: "client", color: "\x1b[35m", args: ["run", "dev", "--prefix", "client"] },
].map(({ name, color, args }) => {
  const child = spawn(npm, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const tag = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on("data", (chunk) => out.write(chunk.toString().split("\n").filter(Boolean).map((l) => tag + l).join("\n") + "\n"));
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (code) console.error(`${tag}exited with code ${code}`);
    stop();
  });
  return child;
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log("\n  My Space dev:  open http://localhost:5173   (game server on :8080)\n");
