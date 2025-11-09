import { resources } from './components/Resource';
import { Sprite } from './components/Sprite';
import { Vector2 } from './components/Vector2';
import './style.css'

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

const skySprite = new Sprite({
    resource: resources.images.sky,
   frameSize: new Vector2(320,180)
  });

  
const groundSprite = new Sprite({
    resource: resources.images.ground,
   frameSize: new Vector2(320,180)
  });

  const hero = new Sprite({
    resource: resources.images.hero,
    frameSize: new Vector2(32,32),
    hFrames: 3,
    vFrames: 8,
    frame: 1,
    });

const shadow = new Sprite({
    resource: resources.images.shadow,
    frameSize: new Vector2(32,32),});


 const heroPos = new Vector2(16*6, 16*5);


const draw = () => {
  skySprite.drawImage(ctx,0,0);
  groundSprite.drawImage(ctx,0,0);

  const heroOffsetX = new Vector2(-8,-21);
  const heroPosX = heroPos.x + heroOffsetX.x;
  const heroPosY = heroPos.y +1 + heroOffsetX.y;
shadow.drawImage(ctx, heroPosX, heroPosY);
  hero.drawImage(ctx, heroPosX, heroPosY);
}


setInterval(() => {
  draw();
}, 300);
