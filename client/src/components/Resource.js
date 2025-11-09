class Resources {
    constructor() {
        // list of resources to load
        this.toLoad = {
            sky: "./images/sky.png",
            ground: "./images/ground.png",
            hero: "./images/hero-sheet.png",
            shadow: "./images/shadow.png",

        };

        //all the images will be stored here 
        this.images = {};

        //load each image
        Object.keys(this.toLoad).forEach((key) => {
            const img = new Image();
            img.src = this.toLoad[key];
            this.images[key] = {
                image: img,
                isLoaded: false
            }
            img.onload = () => {
                this.images[key].isLoaded = true;
            }
        })
    }
}

export const resources = new Resources();