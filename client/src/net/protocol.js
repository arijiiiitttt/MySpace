/** Mirror of server/src/protocol.js — keep the two in sync. */

export const AVATARS = [
  { id: "adam", label: "Adam", color: "#8fb35a" },
  { id: "ash", label: "Ash", color: "#c98a5b" },
  { id: "lucy", label: "Lucy", color: "#f0a93c" },
  { id: "nancy", label: "Nancy", color: "#8a6a58" },
];

export const AVATAR_IDS = AVATARS.map((a) => a.id);

export const EMOTES = ["👋", "😂", "❤️", "👍", "🎉", "😮", "☕", "🤔"];

export const LIMITS = { NAME_MAX: 20, CHAT_MAX: 280 };

/** Stable pastel colour per player id, used for chat names and minimap dots. */
export function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 75% 68%)`;
}

export function cleanRoomName(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}
