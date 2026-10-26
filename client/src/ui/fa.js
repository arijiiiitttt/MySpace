/** Font Awesome (free, bundled) helpers. Icon names are the part after "fa-". */
export const fa = (name, extra = "") => `<i class="fa-solid fa-${name}${extra ? " " + extra : ""}" aria-hidden="true"></i>`;

/** Unicode glyphs for drawing icons inside the Phaser canvas (same font). */
export const GLYPH = {
  building: "\uf1ad", book: "\uf02d", "graduation-cap": "\uf19d", couch: "\uf4b8", "chart-column": "\ue0e3",
  gamepad: "\uf11b", "mug-hot": "\uf7b6", house: "\uf015", "microphone-lines": "\uf3c9", film: "\uf008",
  bed: "\uf236", "book-open": "\uf518", utensils: "\uf2e7", laptop: "\uf109", "box-archive": "\uf187", desktop: "\uf390",
};
export const FA_FAMILY = '"Font Awesome 7 Free"';

/** Emotes travel as these short ids; the icon is only a client-side look. */
export const EMOTE_ICONS = {
  wave: "hand", laugh: "face-laugh", heart: "heart", like: "thumbs-up",
  party: "champagne-glasses", wow: "face-surprise", coffee: "mug-hot", think: "lightbulb",
};
export const EMOTE_COLORS = {
  wave: "#fbbf24", laugh: "#fbbf24", heart: "#f43f5e", like: "#60a5fa",
  party: "#f59e0b", wow: "#fbbf24", coffee: "#d4a373", think: "#fde047",
};
