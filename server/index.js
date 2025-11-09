import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = 3000;

// store all players in one global world
const players = {}; // { id: { name, x, y } }

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  // when player joins world
  socket.on("join_world", (playerData) => {
    players[socket.id] = {
      name: playerData.name || "Guest",
      x: playerData.x || 0,
      y: playerData.y || 0,
    };

    // send current world state to new player
    socket.emit("world_data", players);

    // notify others that new player joined
    socket.broadcast.emit("player_joined", {
      id: socket.id,
      data: players[socket.id],
    });

    console.log(`${playerData.name} joined the world`);
  });

  // when player moves
  socket.on("move", (coords) => {
    if (players[socket.id]) {
      players[socket.id].x = coords.x;
      players[socket.id].y = coords.y;
      // broadcast to everyone except self
      socket.broadcast.emit("player_moved", {
        id: socket.id,
        x: coords.x,
        y: coords.y,
      });
    }
  });

  // when player disconnects
  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    delete players[socket.id];
    io.emit("player_left", socket.id);
  });
});

// test route
app.get("/", (req, res) => {
  res.send("Metaverse 2D Server is running 🚀");
});

server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
