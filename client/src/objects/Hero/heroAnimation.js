const makeStandingFrames = (rootFrame = 0) => {
    return walk = {
        duration: 400,
        frames:
            [
                {
                    time: 0,
                    frame: rootFrame,
                },
            ]
    }
}


const makeWalikingFrames = (rootFrame = 0) => {
    return walk = {
        duration: 400,
        frames:
            [
                {
                    time: 0,
                    frame: rootFrame + 1,
                },
                {
                    time: 100,
                    frame: rootFrame,
                },
                {
                    time: 200,
                    frame: rootFrame + 1,
                },
                {
                    time: 300,
                    frame: rootFrame + 2,
                },
            ]
    }
}


export const STAND_DOWN = makeStandingFrames(1);
export const STAND_RIGHT = makeStandingFrames(4);
export const STAND_UP = makeStandingFrames(7);
export const STAND_LEFT = makeStandingFrames(10);


export const WALK_DOWN = makeWalikingFrames(0);
export const WALK_UP = makeWalikingFrames(6);
export const WALK_LEFT = makeWalikingFrames(9);
export const WALK_RIGHT = makeWalikingFrames(3);