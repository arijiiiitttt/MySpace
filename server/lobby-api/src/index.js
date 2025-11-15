// server/lobby-api/src/index.js

const express = require('express');
const { WebSocketServer } = require('ws'); 
const http = require('http');
const cors = require('cors'); 

const { handleJoinRequest, handleDisconnect } = require('./controllers/playerController');

const PORT = 5000; // Use a fixed port
const app = express();
const server = http.createServer(app);

app.use(cors());
app.get('/health', (req, res) => res.send({ status: 'ok', players: require('./controllers/playerController').connectedPlayers.size }));

const wss = new WebSocketServer({ server }); 

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'JOIN_REQUEST') {
                const { username, sprite } = data.profile;
                if (username && sprite) {
                    handleJoinRequest({ username, sprite }, ws);
                }
            } 
            // Future: MOVE_UPDATE, CHAT_MESSAGE, etc.
            
        } catch (error) {
            // Error handling
        }
    });

    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', () => handleDisconnect(ws));
});


server.listen(PORT, () => {
    console.log(`🚀 Lobby API listening on http://localhost:${PORT}`);
});