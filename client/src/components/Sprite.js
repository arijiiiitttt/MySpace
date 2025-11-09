export class Sprite {
    constructor({
        resource,
        frameSize,
        hFrames,
        vFrames,
        frame,
        scale,
        position,
    }) {
        this.resource = resource;
        this.frameSize = frameSize; // {width, height}
        this.hFrames = hFrames;
        this.vFrames = vFrames;
        this.frame = frame ?? 0;
        this.frameMap = new Map();
        this.scale = scale ?? 1;
        this.position = position;
    }

buildFrameMap() {
        let index = 0;
}

