import { Sprite } from './Sprite.js';
import { Vector2 } from './Vector2.js';
import { resources } from './Resource.js';

export class Player {
  constructor(isBoy) {
    this.isBoy = isBoy;
    const sheet = isBoy ? resources.images.hero : resources.images.heroine;
    this.sprite = new Sprite({
      resource: sheet,
      frameSize: new Vector2(32, 32),
      hFrames: 3,
      vFrames: 8,
      frame: 1
    });
    this.shadow = new Sprite({
      resource: resources.images.shadow,
      frameSize: new Vector2(32, 32)
    });
    this.position = new Vector2();
    this.direction = 'down';
  }

  step(delta) {
    this.sprite.step(delta);
  }

  draw(ctx, x, y, name) {
    const off = new Vector2(-8, -21);
    const px = x + off.x;
    const py = y + 1 + off.y;

    this.shadow.drawImage(ctx, px, py);
    this.sprite.drawImage(ctx, px, py);

    ctx.save();
    ctx.font = '9px PixelFont';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'white';
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 3;
    ctx.strokeText(name, px + 16, py + 5);
    ctx.fillText(name, px + 16, py + 5);
    ctx.restore();
  }
}