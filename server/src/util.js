import { timingSafeEqual, randomBytes } from "node:crypto";

/** Classic token bucket: `rate` tokens per second, holds at most `burst`. */
export class TokenBucket {
  constructor(rate, burst, now = Date.now()) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }

  take(cost = 1, now = Date.now()) {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const newId = () => randomBytes(4).toString("hex");

export const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export const log = {
  quiet: process.env.LOG_LEVEL === "silent",
  info(...args) {
    if (!this.quiet) console.log(new Date().toISOString(), ...args);
  },
  warn(...args) {
    if (!this.quiet) console.warn(new Date().toISOString(), "WARN", ...args);
  },
  error(...args) {
    console.error(new Date().toISOString(), "ERROR", ...args);
  },
};
