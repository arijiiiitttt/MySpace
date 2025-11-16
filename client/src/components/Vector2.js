// export class Vector2 {
//     constructor(x = 0, y=0) {
//         this.x = x;
//         this.y = y;
//     }

//     duplicate(){
//         return new Vector2(this.x, this.y);
//     }
// }



export class Vector2 {
    constructor(x = 0, y=0) {
        this.x = x;
        this.y = y;
    }

    duplicate(){
        return new Vector2(this.x, this.y);
    }
    
    distance(other) {
        const dx = this.x - other.x;
        const dy = this.y - other.y;
        return Math.sqrt(dx * dx + dy * dy);
    }
}