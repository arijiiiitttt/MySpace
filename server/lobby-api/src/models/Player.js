class Player {
    constructor(id, profile, ws) {
        this.id = id;
        this.username = profile.username;
        this.sprite = profile.sprite;
        this.ws = ws; 
        this.x = 100 + Math.random() * 50; // Spawn near center for demonstration
        this.y = 100 + Math.random() * 50;
    }

    getPublicData() {
        return {
            id: this.id,
            username: this.username,
            sprite: this.sprite,
            x: this.x,
            y: this.y,
            // Future: micProducerId, camProducerId
        };
    }
}

module.exports = Player;