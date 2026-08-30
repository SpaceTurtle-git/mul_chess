(() => {
  const PIECE_THEME = '/img/chesspieces/wikipedia/{piece}.png';
  const UNICODE = {
    w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
    b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
  };
  const STORAGE_KEY = 'overboard.session';

  const els = {
    lobby: document.getElementById('lobby'),
    game: document.getElementById('game'),
    createBtn: document.getElementById('createBtn'),
    joinBtn: document.getElementById('joinBtn'),
    roomInput: document.getElementById('roomInput'),
    lobbyError: document.getElementById('lobbyError'),
    connStatus: document.getElementById('connStatus'),
    roomCodeLabel: document.getElementById('roomCodeLabel'),
    copyBtn: document.getElementById('copyBtn'),
    copyCarrier: document.getElementById('copyCarrier'),
    leaveBtn: document.getElementById('leaveBtn'),
    turnBanner: document.getElementById('turnBanner'),
    oppLabel: document.getElementById('oppLabel'),
    oppConn: document.getElementById('oppConn'),
    youLabel: document.getElementById('youLabel'),
    youColor: document.getElementById('youColor'),
    capturedOpp: document.getElementById('capturedOpp'),
    capturedYou: document.getElementById('capturedYou'),
    historyList: document.getElementById('historyList'),
    reconnectBanner: document.getElementById('reconnectBanner'),
    resultModal: document.getElementById('resultModal'),
    resultTitle: document.getElementById('resultTitle'),
    resultBody: document.getElementById('resultBody'),
    resultLeaveBtn: document.getElementById('resultLeaveBtn'),
    promoModal: document.getElementById('promoModal'),
    promoChoices: document.getElementById('promoChoices'),
    promoCancel: document.getElementById('promoCancel'),
  };

  const state = {
    ws: null,
    board: null,
    playerId: null,
    roomCode: null,
    color: null,
    fen: 'start',
    turn: 'w',
    inCheck: false,
    lastMove: null,
    waiting: true,
    gameOver: { over: false },
    players: { white: null, black: null },
    reconnecting: false,
    everOpened: false,
    pingTimer: null,
    retryTimer: null,
    retryDelay: 800,
    pendingPromotion: null,
    selectedSquare: null,
    legalMoves: [],
    clickBound: false,
  };

  function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }

  function send(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
    }
  }

  function saveSession() {
    if (!state.playerId || !state.roomCode) return;
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        playerId: state.playerId,
        roomCode: state.roomCode,
        color: state.color,
      })
    );
  }

  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function clearSession() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  function show(el) {
    el.hidden = false;
    el.classList.remove('hidden');
  }

  function hide(el) {
    el.hidden = true;
    el.classList.add('hidden');
  }

  function setConn(label, dataState) {
    els.connStatus.textContent = label;
    els.connStatus.dataset.state = dataState;
  }

  function showLobbyError(message) {
    els.lobbyError.textContent = message;
    els.lobbyError.hidden = !message;
  }

  function findKingSquare(fen, color) {
    const piece = color === 'w' ? 'K' : 'k';
    const rows = fen.split(' ')[0].split('/');
    for (let r = 0; r < 8; r += 1) {
      let file = 0;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') {
          file += Number(ch);
        } else {
          if (ch === piece) return 'abcdefgh'[file] + String(8 - r);
          file += 1;
        }
      }
    }
    return null;
  }

  function isMyTurn() {
    return (state.turn === 'w' && state.color === 'white')
      || (state.turn === 'b' && state.color === 'black');
  }

  function pieceAt(square) {
    if (!state.board) return null;
    const position = state.board.position();
    return position[square] || null;
  }

  function movesFrom(square) {
    return (state.legalMoves || []).filter((move) => move.from === square);
  }

  function findMove(from, to) {
    return (state.legalMoves || []).find((move) => move.from === from && move.to === to) || null;
  }

  function clearSelection() {
    state.selectedSquare = null;
    paintHighlights();
  }

  function onSquareClick(square) {
    if (!square || state.gameOver.over || state.waiting || state.reconnecting) return;
    if (!state.color || !isMyTurn()) return;

    const piece = pieceAt(square);
    const mine = state.color === 'white' ? 'w' : 'b';

    if (state.selectedSquare) {
      if (square === state.selectedSquare) {
        clearSelection();
        return;
      }

      if (piece && piece[0] === mine) {
        state.selectedSquare = square;
        paintHighlights();
        return;
      }

      const legal = findMove(state.selectedSquare, square);
      if (!legal) {
        clearSelection();
        return;
      }

      const from = state.selectedSquare;
      state.selectedSquare = null;
      if (legal.promotion) {
        state.pendingPromotion = { from, to: square };
        openPromotion();
        paintHighlights();
        return;
      }
      send({ type: 'move', from, to: square });
      paintHighlights();
      return;
    }

    if (piece && piece[0] === mine && movesFrom(square).length) {
      state.selectedSquare = square;
      paintHighlights();
    }
  }

  function paintHighlights() {
    const $board = $('#board');
    $board.find('.square-55d63').removeClass('last-move in-check selected legal-move legal-capture');
    if (state.lastMove) {
      $board.find(`.square-${state.lastMove.from}`).addClass('last-move');
      $board.find(`.square-${state.lastMove.to}`).addClass('last-move');
    }
    if (state.inCheck && state.fen && state.fen !== 'start') {
      const sq = findKingSquare(state.fen, state.turn);
      if (sq) $board.find(`.square-${sq}`).addClass('in-check');
    }
    if (state.selectedSquare) {
      $board.find(`.square-${state.selectedSquare}`).addClass('selected');
      const position = state.board ? state.board.position() : {};
      for (const move of movesFrom(state.selectedSquare)) {
        const cls = position[move.to] ? 'legal-capture' : 'legal-move';
        $board.find(`.square-${move.to}`).addClass(cls);
      }
    }
  }

  function bindBoardClicks() {
    if (state.clickBound) return;
    state.clickBound = true;
    document.getElementById('board').addEventListener('click', (event) => {
      const squareEl = event.target.closest('[data-square]');
      if (!squareEl) return;
      onSquareClick(squareEl.getAttribute('data-square'));
    });
  }

  function ensureBoard() {
    const orientation = state.color || 'white';
    bindBoardClicks();
    if (!state.board) {
      state.board = window.Chessboard('board', {
        draggable: false,
        position: state.fen === 'start' ? 'start' : state.fen,
        orientation,
        pieceTheme: PIECE_THEME,
      });
    } else {
      state.board.orientation(orientation);
      state.board.position(state.fen === 'start' ? 'start' : state.fen, false);
    }
    state.board.resize();
    paintHighlights();
  }

  function renderCaptured(captured) {
    const mine = state.color === 'white' ? 'w' : 'b';
    const opp = mine === 'w' ? 'b' : 'w';
    const mineTaken = (captured && captured[mine]) || [];
    const oppTaken = (captured && captured[opp]) || [];
    els.capturedYou.textContent = mineTaken.map((p) => UNICODE[mine][p] || p).join(' ');
    els.capturedOpp.textContent = oppTaken.map((p) => UNICODE[opp][p] || p).join(' ');
  }

  function renderHistory(moves) {
    els.historyList.replaceChildren();
    const list = moves || [];
    for (let i = 0; i < list.length; i += 2) {
      const li = document.createElement('li');
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = `${i / 2 + 1}.`;
      const white = document.createElement('span');
      white.textContent = list[i];
      const black = document.createElement('span');
      black.textContent = list[i + 1] || '';
      li.append(num, white, black);
      els.historyList.append(li);
    }
    els.historyList.scrollTop = els.historyList.scrollHeight;
  }

  function outcomeCopy(gameOver) {
    if (!gameOver || !gameOver.over) return { title: '', body: '' };
    const youWin = gameOver.result === state.color;
    if (gameOver.reason === 'checkmate') {
      return {
        title: youWin ? 'Checkmate — you win' : 'Checkmate — you lose',
        body: youWin
          ? 'The opponent’s king has nowhere left to go.'
          : 'Your king is trapped. Better luck next game.',
      };
    }
    const reasons = {
      stalemate: 'Draw by stalemate.',
      'threefold repetition': 'Draw by threefold repetition.',
      'insufficient material': 'Draw by insufficient material.',
      'fifty-move rule': 'Draw by the fifty-move rule.',
      draw: 'The game is a draw.',
    };
    return {
      title: 'Draw',
      body: reasons[gameOver.reason] || 'The game is a draw.',
    };
  }

  function updateTurnBanner() {
    const banner = els.turnBanner;
    banner.classList.remove('yours', 'theirs', 'waiting', 'over');

    if (state.gameOver.over) {
      banner.classList.add('over');
      const copy = outcomeCopy(state.gameOver);
      banner.textContent = copy.title;
      return;
    }

    if (state.waiting) {
      banner.classList.add('waiting');
      banner.textContent = 'Waiting for opponent';
      return;
    }

    const myTurn = (state.turn === 'w' && state.color === 'white')
      || (state.turn === 'b' && state.color === 'black');
    if (myTurn) {
      banner.classList.add('yours');
      banner.textContent = state.inCheck ? 'Your turn — check' : 'Your turn';
    } else {
      banner.classList.add('theirs');
      banner.textContent = state.inCheck ? "Opponent's turn — you are checking" : "Opponent's turn";
    }
  }

  function showGameView() {
    hide(els.lobby);
    show(els.game);
    els.roomCodeLabel.value = state.roomCode || '';
    els.youColor.textContent = state.color === 'black' ? 'Black' : 'White';
    els.youLabel.textContent = 'You';
    els.oppLabel.textContent = 'Opponent';
    requestAnimationFrame(() => {
      ensureBoard();
      requestAnimationFrame(() => {
        if (state.board) {
          state.board.resize();
          paintHighlights();
        }
      });
    });
  }

  function showLobbyView() {
    hide(els.game);
    hide(els.resultModal);
    hide(els.promoModal);
    hide(els.reconnectBanner);
    show(els.lobby);
    if (state.board) {
      state.board.destroy();
      state.board = null;
    }
  }

  function applyGameState(msg) {
    state.fen = msg.fen;
    state.turn = msg.turn;
    state.inCheck = !!msg.inCheck;
    state.lastMove = msg.lastMove;
    state.waiting = !!msg.waiting;
    state.gameOver = msg.gameOver || { over: false };
    state.players = msg.players || state.players;
    state.legalMoves = msg.legalMoves || [];
    state.selectedSquare = null;

    showGameView();
    updateTurnBanner();
    renderCaptured(msg.captured);
    renderHistory(msg.history);

    const oppColor = state.color === 'white' ? 'black' : 'white';
    const opp = state.players[oppColor];
    if (state.waiting) {
      els.oppConn.textContent = 'Waiting';
      els.oppConn.dataset.state = 'waiting';
    } else if (opp && opp.connected) {
      els.oppConn.textContent = 'Connected';
      els.oppConn.dataset.state = 'connected';
    } else {
      els.oppConn.textContent = 'Disconnected';
      els.oppConn.dataset.state = 'disconnected';
    }

    if (state.gameOver.over) {
      const copy = outcomeCopy(state.gameOver);
      els.resultTitle.textContent = copy.title;
      els.resultBody.textContent = copy.body;
      show(els.resultModal);
    } else {
      hide(els.resultModal);
    }
  }

  function openPromotion() {
    const color = state.color === 'black' ? 'b' : 'w';
    const pieces = [
      { code: 'q', label: UNICODE[color].q },
      { code: 'r', label: UNICODE[color].r },
      { code: 'b', label: UNICODE[color].b },
      { code: 'n', label: UNICODE[color].n },
    ];
    els.promoChoices.replaceChildren();
    for (const piece of pieces) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = piece.label;
      btn.addEventListener('click', () => {
        const pending = state.pendingPromotion;
        state.pendingPromotion = null;
        hide(els.promoModal);
        if (pending) {
          send({ type: 'move', from: pending.from, to: pending.to, promotion: piece.code });
        }
      });
      els.promoChoices.append(btn);
    }
    show(els.promoModal);
  }

  function cancelPromotion() {
    state.pendingPromotion = null;
    hide(els.promoModal);
    if (state.board) {
      state.board.position(state.fen === 'start' ? 'start' : state.fen, false);
      paintHighlights();
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'assigned':
        state.playerId = msg.playerId;
        state.roomCode = msg.roomCode;
        state.color = msg.color;
        saveSession();
        history.replaceState({}, '', `/?room=${encodeURIComponent(msg.roomCode)}`);
        showLobbyError('');
        showGameView();
        break;
      case 'gameState':
        applyGameState(msg);
        break;
      case 'invalidMove':
        if (state.board) {
          state.board.position(state.fen === 'start' ? 'start' : state.fen, false);
          paintHighlights();
        }
        break;
      case 'error':
        if (!state.roomCode) showLobbyError(msg.message || 'Something went wrong.');
        break;
      case 'opponentDisconnected':
        els.oppConn.textContent = 'Disconnected';
        els.oppConn.dataset.state = 'disconnected';
        break;
      case 'opponentReconnected':
        els.oppConn.textContent = 'Connected';
        els.oppConn.dataset.state = 'connected';
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  function tryResume() {
    const session = loadSession();
    const urlRoom = new URLSearchParams(location.search).get('room');
    if (session && session.playerId && session.roomCode) {
      send({ type: 'reconnect', roomCode: session.roomCode, playerId: session.playerId });
      return;
    }
    if (urlRoom) {
      els.roomInput.value = urlRoom.toUpperCase();
      send({ type: 'join', roomCode: urlRoom });
    }
  }

  function connect() {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const ws = new WebSocket(wsUrl());
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.reconnecting = false;
      state.retryDelay = 800;
      state.everOpened = true;
      hide(els.reconnectBanner);
      setConn('Live', 'open');
      if (state.pingTimer) clearInterval(state.pingTimer);
      state.pingTimer = setInterval(() => send({ type: 'ping' }), 20000);
      tryResume();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      if (state.pingTimer) {
        clearInterval(state.pingTimer);
        state.pingTimer = null;
      }
      if (state.playerId) {
        state.reconnecting = true;
        show(els.reconnectBanner);
        setConn('Reconnecting', 'reconnecting');
      } else {
        setConn('Offline', 'reconnecting');
      }
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  function scheduleReconnect() {
    if (state.retryTimer) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      state.retryDelay = Math.min(state.retryDelay * 1.6, 8000);
      connect();
    }, state.retryDelay);
  }

  function leaveGame() {
    send({ type: 'leave' });
    clearSession();
    state.playerId = null;
    state.roomCode = null;
    state.color = null;
    state.fen = 'start';
    state.turn = 'w';
    state.waiting = true;
    state.gameOver = { over: false };
    state.lastMove = null;
    state.pendingPromotion = null;
    state.selectedSquare = null;
    state.legalMoves = [];
    history.replaceState({}, '', '/');
    showLobbyError('');
    showLobbyView();
  }

  function requireLiveConnection() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      showLobbyError('Not connected yet. Wait a moment and try again.');
      return false;
    }
    return true;
  }

  els.createBtn.addEventListener('click', () => {
    if (!requireLiveConnection()) return;
    showLobbyError('');
    send({ type: 'create' });
  });

  els.joinBtn.addEventListener('click', () => {
    const code = els.roomInput.value.trim();
    if (!code) {
      showLobbyError('Enter a room code.');
      return;
    }
    if (!requireLiveConnection()) return;
    showLobbyError('');
    send({ type: 'join', roomCode: code });
  });

  els.roomInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') els.joinBtn.click();
  });

  function inviteUrl() {
    return `${location.origin}/?room=${encodeURIComponent(state.roomCode || '')}`;
  }

  function copyWithCarrier(text) {
    const carrier = els.copyCarrier;
    if (!carrier) return false;
    carrier.value = text;
    carrier.removeAttribute('aria-hidden');
    carrier.style.position = 'fixed';
    carrier.style.left = '0';
    carrier.style.top = '0';
    carrier.style.opacity = '1';
    carrier.style.width = '2px';
    carrier.style.height = '2px';
    carrier.focus();
    carrier.select();
    carrier.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    carrier.setAttribute('aria-hidden', 'true');
    carrier.style.opacity = '0';
    carrier.blur();
    els.copyBtn.focus();
    return ok;
  }

  async function copyInviteLink() {
    const url = inviteUrl();
    if (!state.roomCode) return;

    let copied = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await Promise.race([
          navigator.clipboard.writeText(url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 400)),
        ]);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) copied = copyWithCarrier(url);

    if (copied) {
      els.copyBtn.textContent = 'Copied';
      setTimeout(() => {
        els.copyBtn.textContent = 'Copy link';
      }, 1400);
      return;
    }

    els.roomCodeLabel.focus();
    els.roomCodeLabel.select();
    els.copyBtn.textContent = 'Select & copy';
    setTimeout(() => {
      els.copyBtn.textContent = 'Copy link';
    }, 1800);
  }

  els.copyBtn.addEventListener('click', (event) => {
    event.preventDefault();
    copyInviteLink();
  });
  els.roomCodeLabel.addEventListener('click', () => {
    els.roomCodeLabel.select();
  });
  els.leaveBtn.addEventListener('click', leaveGame);
  els.resultLeaveBtn.addEventListener('click', leaveGame);
  els.promoCancel.addEventListener('click', cancelPromotion);

  window.addEventListener('resize', () => {
    if (state.board) {
      state.board.resize();
      paintHighlights();
    }
  });

  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) els.roomInput.value = urlRoom.toUpperCase();

  connect();
})();
