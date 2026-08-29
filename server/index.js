const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const game = require('./gameManager');

const app = express();
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.static(publicDir));

app.get('/health', (_req, res) => {
  res.status(200).type('text').send('ok');
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    game.send(ws, { type: 'error', message: 'Invalid message.' });
    return;
  }

  if (!msg || typeof msg.type !== 'string') {
    game.send(ws, { type: 'error', message: 'Invalid message.' });
    return;
  }

  switch (msg.type) {
    case 'create':
      game.createRoom(ws);
      break;
    case 'join':
      game.joinRoom(ws, msg.roomCode);
      break;
    case 'reconnect':
      game.reconnect(ws, msg.roomCode, msg.playerId);
      break;
    case 'move':
      game.applyMove(ws, msg);
      break;
    case 'leave':
      game.leaveRoom(ws);
      break;
    case 'ping':
      game.send(ws, { type: 'pong' });
      break;
    default:
      game.send(ws, { type: 'error', message: 'Unknown action.' });
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    try {
      handleMessage(ws, raw);
    } catch (err) {
      console.error('Message handler error:', err);
      game.send(ws, { type: 'error', message: 'Server error.' });
    }
  });

  ws.on('close', () => {
    try {
      game.handleDisconnect(ws);
    } catch (err) {
      console.error('Disconnect handler error:', err);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => {
  clearInterval(heartbeat);
});

const PORT = process.env.PORT || 3000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Multiplayer chess listening on ${PORT}`);
});
