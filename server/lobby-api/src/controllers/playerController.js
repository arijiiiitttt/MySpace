// server/lobby-api/src/controllers/playerController.js

const Player = require('../models/Player');

const connectedPlayers = new Map(); 
let playerIdCounter = 1; 

function generatePlayerId() {
    return `p_${playerIdCounter++}`;
}

function handleJoinRequest(profile, ws) {
    if (profile.username.length < 3) {
        ws.send(JSON.stringify({ type: 'JOIN_FAILURE', reason: 'Name is too short.' }));
        return;
    }

    // NEW: Check for duplicate usernames among active connections
    const usernameExists = Array.from(connectedPlayers.values()).some(
        p => p.username.toLowerCase() === profile.username.toLowerCase()
    );

    if (usernameExists) {
        ws.send(JSON.stringify({ type: 'JOIN_FAILURE', reason: `Username "${profile.username}" is already taken.` }));
        console.log(`[Lobby] Rejecting join request for existing username: ${profile.username}`);
        return;
    }
    // END NEW CHECK

    const id = generatePlayerId();
    const newPlayer = new Player(id, profile, ws);
    connectedPlayers.set(id, newPlayer);
    
    // 1. Send world state to the new client
    const currentPlayers = Array.from(connectedPlayers.values())
        .map(p => p.getPublicData());

    newPlayer.ws.send(JSON.stringify({
        type: 'JOIN_SUCCESS',
        localId: id,
        players: currentPlayers
    }));

    // 2. Notify others
    const announcement = JSON.stringify({
        type: 'PLAYER_JOINED',
        player: newPlayer.getPublicData()
    });
    
    broadcast(announcement, newPlayer.ws); 

    console.log(`[Lobby] Player ${profile.username} (${id}) joined. Total: ${connectedPlayers.size}`);
}

function handleDisconnect(ws) {
    let disconnectedPlayer = null;

    for (const [id, player] of connectedPlayers.entries()) {
        if (player.ws === ws) {
            disconnectedPlayer = player;
            connectedPlayers.delete(id);
            break;
        }
    }

    if (disconnectedPlayer) {
        console.log(`[Lobby] Player ${disconnectedPlayer.username} disconnected. Total: ${connectedPlayers.size}`);
        
        const announcement = JSON.stringify({
            type: 'PLAYER_LEFT',
            id: disconnectedPlayer.id
        });
        
        broadcast(announcement);
    }
}

function broadcast(message, excludeWs = null) {
    for (const player of connectedPlayers.values()) {
        if (player.ws.readyState === player.ws.OPEN && player.ws !== excludeWs) {
            player.ws.send(message);
        }
    }
}


module.exports = {
    handleJoinRequest,
    handleDisconnect,
    broadcast,
    connectedPlayers
};