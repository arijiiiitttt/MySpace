class Resources {
    constructor() {
        // list of resources to load
        this.toLoad = {
            sky: "./Assets/sky.png",
            ground: "./Assets/ground.png",
            hero: "./Assets/hero-sheet.png",
            shadow: "./Assets/shadow.png",

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