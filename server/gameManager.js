const crypto = require('crypto');
const { Chess } = require('chess.js');

const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_TTL_MS = 30 * 60 * 1000;
const SQUARE = /^[a-h][1-8]$/;
const PROMOTION = /^[qrbn]$/i;

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i += 1) {
      code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function createPlayer(ws, color) {
  return {
    id: crypto.randomUUID(),
    color,
    ws,
    connected: true,
  };
}

function send(ws, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function findBySocket(ws) {
  for (const room of rooms.values()) {
    for (const color of ['white', 'black']) {
      const player = room.players[color];
      if (player && player.ws === ws) {
        return { room, player };
      }
    }
  }
  return null;
}

function opponentOf(room, color) {
  return room.players[color === 'white' ? 'black' : 'white'];
}

function getOutcome(chess) {
  if (chess.isCheckmate()) {
    return {
      over: true,
      result: chess.turn() === 'w' ? 'black' : 'white',
      reason: 'checkmate',
    };
  }
  if (chess.isStalemate()) {
    return { over: true, result: 'draw', reason: 'stalemate' };
  }
  if (chess.isThreefoldRepetition()) {
    return { over: true, result: 'draw', reason: 'threefold repetition' };
  }
  if (chess.isInsufficientMaterial()) {
    return { over: true, result: 'draw', reason: 'insufficient material' };
  }
  if (typeof chess.isDrawByFiftyMoves === 'function' && chess.isDrawByFiftyMoves()) {
    return { over: true, result: 'draw', reason: 'fifty-move rule' };
  }
  if (chess.isDraw()) {
    return { over: true, result: 'draw', reason: 'draw' };
  }
  return { over: false, result: null, reason: null };
}

function capturedPieces(verboseHistory) {
  const captured = { w: [], b: [] };
  for (const move of verboseHistory) {
    if (move.captured) {
      const capturedColor = move.color === 'w' ? 'b' : 'w';
      captured[capturedColor].push(move.captured);
    }
  }
  return captured;
}

function snapshot(room) {
  const chess = room.chess;
  const verbose = chess.history({ verbose: true });
  const last = verbose[verbose.length - 1] || null;

  return {
    type: 'gameState',
    roomCode: room.code,
    fen: chess.fen(),
    turn: chess.turn(),
    inCheck: chess.inCheck(),
    lastMove: last ? { from: last.from, to: last.to, san: last.san } : null,
    history: chess.history(),
    captured: capturedPieces(verbose),
    legalMoves: chess.isGameOver()
      ? []
      : chess.moves({ verbose: true }).map((move) => ({
        from: move.from,
        to: move.to,
        promotion: move.promotion || undefined,
      })),
    waiting: !room.players.black,
    players: {
      white: room.players.white
        ? { connected: room.players.white.connected }
        : null,
      black: room.players.black
        ? { connected: room.players.black.connected }
        : null,
    },
    gameOver: getOutcome(chess),
  };
}

function broadcast(room, payload) {
  for (const color of ['white', 'black']) {
    const player = room.players[color];
    if (player && player.connected) {
      send(player.ws, payload);
    }
  }
}

function touch(room) {
  room.lastActivity = Date.now();
}

function assign(ws, room, player) {
  send(ws, {
    type: 'assigned',
    roomCode: room.code,
    playerId: player.id,
    color: player.color,
  });
}

function detachSocket(ws, { notify = true } = {}) {
  const found = findBySocket(ws);
  if (!found) return;
  const { room, player } = found;
  player.connected = false;
  player.ws = null;
  touch(room);
  if (notify) {
    const opponent = opponentOf(room, player.color);
    if (opponent && opponent.connected) {
      send(opponent.ws, { type: 'opponentDisconnected' });
      send(opponent.ws, snapshot(room));
    }
  }
}

function createRoom(ws) {
  detachSocket(ws);
  const code = generateRoomCode();
  const player = createPlayer(ws, 'white');
  const room = {
    code,
    chess: new Chess(),
    players: { white: player, black: null },
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  assign(ws, room, player);
  send(ws, snapshot(room));
}

function joinRoom(ws, roomCode) {
  const code = String(roomCode || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  const room = rooms.get(code);

  if (!room) {
    send(ws, { type: 'error', message: 'Room not found. Check the code and try again.' });
    return;
  }

  const alreadyHere = findBySocket(ws);
  if (alreadyHere && alreadyHere.room === room) {
    assign(ws, room, alreadyHere.player);
    send(ws, snapshot(room));
    return;
  }

  if (room.players.black) {
    send(ws, { type: 'error', message: 'That room is already full.' });
    return;
  }

  detachSocket(ws);

  const player = createPlayer(ws, 'black');
  room.players.black = player;
  touch(room);
  assign(ws, room, player);
  broadcast(room, snapshot(room));
}

function reconnect(ws, roomCode, playerId) {
  const code = String(roomCode || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  const room = rooms.get(code);

  if (!room) {
    send(ws, { type: 'error', message: 'Room not found. The game may have expired.' });
    return;
  }

  detachSocket(ws, { notify: false });

  const id = String(playerId || '');
  for (const color of ['white', 'black']) {
    const player = room.players[color];
    if (player && player.id === id) {
      player.ws = ws;
      player.connected = true;
      touch(room);
      assign(ws, room, player);
      send(ws, snapshot(room));
      const opponent = opponentOf(room, color);
      if (opponent && opponent.connected) {
        send(opponent.ws, { type: 'opponentReconnected' });
        send(opponent.ws, snapshot(room));
      }
      return;
    }
  }

  send(ws, { type: 'error', message: 'Could not reconnect to this room.' });
}

function applyMove(ws, rawMove) {
  const found = findBySocket(ws);
  if (!found) {
    send(ws, { type: 'invalidMove', message: 'You are not in a game.' });
    return;
  }

  const { room, player } = found;

  if (!room.players.black) {
    send(ws, { type: 'invalidMove', message: 'Waiting for an opponent.' });
    return;
  }

  if (room.chess.isGameOver()) {
    send(ws, { type: 'invalidMove', message: 'The game is already over.' });
    return;
  }

  const from = String(rawMove && rawMove.from ? rawMove.from : '').toLowerCase();
  const to = String(rawMove && rawMove.to ? rawMove.to : '').toLowerCase();
  const promotion = rawMove && rawMove.promotion
    ? String(rawMove.promotion).toLowerCase()
    : undefined;

  if (!SQUARE.test(from) || !SQUARE.test(to)) {
    send(ws, { type: 'invalidMove', message: 'Illegal move.' });
    return;
  }
  if (promotion && !PROMOTION.test(promotion)) {
    send(ws, { type: 'invalidMove', message: 'Illegal promotion piece.' });
    return;
  }

  const expected = room.chess.turn() === 'w' ? 'white' : 'black';
  if (player.color !== expected) {
    send(ws, { type: 'invalidMove', message: 'Not your turn.' });
    return;
  }

  let move;
  try {
    const spec = { from, to };
    if (promotion) spec.promotion = promotion;
    move = room.chess.move(spec);
  } catch {
    send(ws, { type: 'invalidMove', message: 'Illegal move.' });
    return;
  }

  if (!move) {
    send(ws, { type: 'invalidMove', message: 'Illegal move.' });
    return;
  }

  touch(room);
  broadcast(room, snapshot(room));
}

function handleDisconnect(ws) {
  detachSocket(ws);
}

function leaveRoom(ws) {
  detachSocket(ws);
}

function sweepExpiredRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const whiteGone = !room.players.white || !room.players.white.connected;
    const blackGone = !room.players.black || !room.players.black.connected;
    if (whiteGone && blackGone && now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}

setInterval(sweepExpiredRooms, 60 * 1000).unref();

module.exports = {
  createRoom,
  joinRoom,
  reconnect,
  applyMove,
  handleDisconnect,
  leaveRoom,
  send,
};
