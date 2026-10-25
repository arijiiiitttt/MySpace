const cache = new Map();

function loadSheet(id) {
  if (!cache.has(id)) {
    cache.set(
      id,
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = `/assets/characters/${id}.png`;
      }),
    );
  }
  return cache.get(id);
}

/** Draw the idle-facing-down frame of an avatar into a canvas (32x48 backing store). */
export async function drawAvatar(canvas, id, frame = 18) {
  canvas.width = 32;
  canvas.height = 48;
  try {
    const img = await loadSheet(id);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 32, 48);
    ctx.drawImage(img, frame * 32, 0, 32, 48, 0, 0, 32, 48);
  } catch {
    /* image missing: leave the canvas empty */
  }
  return canvas;
}
