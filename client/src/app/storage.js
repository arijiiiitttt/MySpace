/** localStorage that never throws (private mode, blocked storage, quota). */
const safe = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export const store = {
  get: (key, fallback = null) =>
    safe(() => {
      const raw = localStorage.getItem(`myspace.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    }, fallback),
  set: (key, value) => safe(() => localStorage.setItem(`myspace.${key}`, JSON.stringify(value))),
  remove: (key) => safe(() => localStorage.removeItem(`myspace.${key}`)),
};
