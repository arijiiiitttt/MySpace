/** Minimal typed-by-convention event emitter. */
export class Emitter {
  #handlers = new Map();

  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(type, fn) {
    this.#handlers.get(type)?.delete(fn);
  }

  emit(type, ...args) {
    for (const fn of [...(this.#handlers.get(type) ?? [])]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[emitter] handler for "${type}" threw`, err);
      }
    }
  }
}

/** App-wide bus between the Phaser world and the DOM UI. */
export const bus = new Emitter();
