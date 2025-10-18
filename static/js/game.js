// ----- Setup / globals -----
const socket = (typeof io !== 'undefined') ? io() : null;
const BOARD = document.getElementById('board');
const CHAT_MESSAGES = document.getElementById('chat-messages');
const CHAT_INPUT = document.getElementById('chat-input');
const SEND_CHAT_BTN = document.getElementById('send-chat');
const ROOM_CODE_EL = document.getElementById('room-code');
const TURN_IND = document.getElementById('turn-indicator');
const PLAYER_SYMBOL_EL = document.getElementById('player-symbol');
const HISTORY_LIST = document.getElementById('history-list');
const POWER_BLOCK_BTN = document.getElementById('power-block');
const POWER_CLEAR_BTN = document.getElementById('power-clear');
const NEW_GAME_BTN = document.getElementById('new-game-btn');
const REFRESH_HISTORY_BTN = document.getElementById('refresh-history');
const EXIT_BTN = document.getElementById('exit-btn');
const COUNT_BLOCK = document.getElementById('count-block');
const COUNT_CLEAR = document.getElementById('count-clear');
const BOARD_LABEL = document.getElementById('board-size-label');
const CHAT_SECTION = document.getElementById('chat-section');

// Game statistics elements
const STAT_WINS = document.getElementById('stat-wins');
const STAT_LOSSES = document.getElementById('stat-losses');
const STAT_DRAWS = document.getElementById('stat-draws');
const STAT_STREAK = document.getElementById('stat-streak');

// injected by template
if (typeof username === 'undefined') window.username = 'Guest';
if (typeof boardSize === 'undefined') window.boardSize = 3;
if (typeof roomCode === 'undefined') window.roomCode = null;
if (typeof mode === 'undefined') window.mode = 'solo';

// local state
let localGame = null;      // object when solo is active, null otherwise
let currentRoom = null;    // room code for multiplayer
let mySymbol = null;       // 'X' or 'O' in multiplayer; 'X' in solo
let isSolo = false;
let myPowerups = { block: 1, clear: 1 }; // default local powerups (persisted per-game)
let gameStats = {          // game statistics
  wins: 0,
  losses: 0,
  draws: 0,
  streak: 0
};

// ----- Session Recovery -----
function setupSessionRecovery() {
  // Check if we have a username and are in multiplayer mode
  if (username && mode === 'multiplayer' && (!roomCode || roomCode === 'null')) {
    attemptSessionRecovery();
  }
}

async function attemptSessionRecovery() {
  try {
    const response = await fetch(`/recover-session?username=${encodeURIComponent(username)}`);
    if (response.ok) {
      const sessionData = await response.json();
      if (sessionData.room_code && sessionData.room_code !== 'LOCAL') {
        // Show recovery dialog
        showSessionRecoveryDialog(sessionData);
      }
    }
  } catch (error) {
    console.log('No saved session found or error recovering:', error);
  }
}

function showSessionRecoveryDialog(sessionData) {
  const dialog = document.createElement('div');
  dialog.id = 'session-recovery-dialog';
  dialog.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  `;
  
  const content = document.createElement('div');
  content.style.cssText = `
    background: white;
    padding: 30px;
    border-radius: 12px;
    text-align: center;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 10px 30px rgba(0,0,0,0.3);
  `;
  
  const titleEl = document.createElement('h2');
  titleEl.textContent = 'Game Session Found!';
  titleEl.style.color = '#6b35b7';
  titleEl.style.margin = '0 0 15px 0';
  
  const messageEl = document.createElement('p');
  messageEl.textContent = `We found your previous game session in room ${sessionData.room_code}. Would you like to rejoin?`;
  messageEl.style.margin = '0 0 20px 0';
  
  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = `
    display: flex;
    gap: 10px;
    justify-content: center;
  `;
  
  const yesButton = document.createElement('button');
  yesButton.textContent = 'Yes, Rejoin Game';
  yesButton.style.cssText = `
    background: #2e7d32;
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 8px;
    cursor: pointer;
    font-weight: bold;
  `;
  
  const noButton = document.createElement('button');
  noButton.textContent = 'No, Start New Game';
  noButton.style.cssText = `
    background: #d84315;
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 8px;
    cursor: pointer;
    font-weight: bold;
  `;
  
  yesButton.addEventListener('click', () => {
    // Rejoin the room
    roomCode = sessionData.room_code;
    boardSize = sessionData.board_size;
    mode = sessionData.mode;
    
    // Update session and reconnect
    updateSessionAndReconnect(sessionData);
    dialog.remove();
  });
  
  noButton.addEventListener('click', () => {
    // Clear the saved session and start fresh
    clearSavedSession();
    dialog.remove();
  });
  
  // Also close dialog when clicking outside
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      clearSavedSession();
      dialog.remove();
    }
  });
  
  buttonContainer.appendChild(noButton);
  buttonContainer.appendChild(yesButton);
  
  content.appendChild(titleEl);
  content.appendChild(messageEl);
  content.appendChild(buttonContainer);
  dialog.appendChild(content);
  document.body.appendChild(dialog);
}

function updateSessionAndReconnect(sessionData) {
  // Update the room code display
  setRoomCode(sessionData.room_code);
  
  // Update the board size label if needed
  if (BOARD_LABEL) {
    BOARD_LABEL.textContent = sessionData.board_size;
  }
  
  // Reconnect to the room
  if (socket && socket.connected) {
    socket.emit('join', { 
      username, 
      board_size: sessionData.board_size, 
      room: sessionData.room_code 
    });
  }
  
  // Show reconnection status
  showStatus("Rejoining game...", '#FF9800');
}

async function clearSavedSession() {
  try {
    await fetch('/logout', { method: 'GET' });
  } catch (error) {
    console.log('Error clearing session:', error);
  }
}

// ----- Exit Game Functionality -----
function setupExitButton() {
  if (EXIT_BTN) {
    EXIT_BTN.addEventListener('click', showExitConfirmation);
  }
}

function showExitConfirmation() {
  const dialog = document.createElement('div');
  dialog.id = 'exit-confirmation-dialog';
  dialog.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  `;
  
  const content = document.createElement('div');
  content.style.cssText = `
    background: white;
    padding: 30px;
    border-radius: 12px;
    text-align: center;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 10px 30px rgba(0,0,0,0.3);
  `;
  
  const titleEl = document.createElement('h2');
  titleEl.textContent = 'Exit Game';
  titleEl.style.color = '#d84315';
  titleEl.style.margin = '0 0 15px 0';
  
  const messageEl = document.createElement('p');
  messageEl.textContent = 'Are you sure you want to exit the game?';
  messageEl.style.margin = '0 0 20px 0';
  
  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = `
    display: flex;
    gap: 10px;
    justify-content: center;
  `;
  
  const yesButton = document.createElement('button');
  yesButton.textContent = 'Yes, Exit';
  yesButton.style.cssText = `
    background: #d84315;
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 8px;
    cursor: pointer;
    font-weight: bold;
  `;
  
  const noButton = document.createElement('button');
  noButton.textContent = 'No, Continue';
  noButton.style.cssText = `
    background: var(--purple);
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 8px;
    cursor: pointer;
    font-weight: bold;
  `;
  
  yesButton.addEventListener('click', () => {
    // For multiplayer, leave the room
    if (!isSolo && currentRoom && currentRoom !== 'LOCAL' && socket) {
      socket.emit('leave_room', { room: currentRoom, username });
    }
    
    // Clear saved session
    clearSavedSession();
    
    // Redirect to logout endpoint to clear session
    window.location.href = '/logout';
  });
  
  noButton.addEventListener('click', () => {
    dialog.remove();
  });
  
  // Also close dialog when clicking outside
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      dialog.remove();
    }
  });
  
  buttonContainer.appendChild(noButton);
  buttonContainer.appendChild(yesButton);
  
  content.appendChild(titleEl);
  content.appendChild(messageEl);
  content.appendChild(buttonContainer);
  dialog.appendChild(content);
  document.body.appendChild(dialog);
}

// ----- New Game Confirmation -----
function showNewGameConfirmation(requestedBy) {
  const dialog = document.createElement('div');
  dialog.id = 'new-game-confirmation-dialog';
  dialog.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  `;
  
  const content = document.createElement('div');
  content.style.cssText = `
    background: white;
    padding: 30px;
    border-radius: 12px;
    text-align: center;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 10px 30px rgba(0,0,0,0.3);
  `;
  
  const titleEl = document.createElement('h2');
  titleEl.textContent = 'New Game Request';
  titleEl.style.color = '#6b35b7';
  titleEl.style.margin = '0 0 15px 0';
  
  const messageEl = document.createElement('p');
  messageEl.textContent = `${requestedBy} wants to start a new game. Do you agree?`;
  messageEl.style.margin = '0 0 20px 0';
  
  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = `
    display: flex;
    gap: 10px;
    justify-content: center;
  `;
  
  const yesButton = document.createElement('button');
  yesButton.textContent = 'Yes, Start New Game';
  yesButton.style.cssText = `
    background: #2e7d32;
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 8px;
    cursor: pointer;
    font-weight: bold;
  `;
  
  const noButton = document.createElement('button');
  noButton.textContent = 'No, Continue Current';
  noButton.style.cssText = `
    background: #d84315;
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 8px;
    cursor: pointer;
    font-weight: bold;
  `;
  
  yesButton.addEventListener('click', () => {
    // Confirm new game
    socket.emit('confirm_new_game', { room: currentRoom, username });
    dialog.remove();
  });
  
  noButton.addEventListener('click', () => {
    // Cancel new game request
    socket.emit('cancel_new_game', { room: currentRoom, username });
    dialog.remove();
  });
  
  // Also close dialog when clicking outside
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      socket.emit('cancel_new_game', { room: currentRoom, username });
      dialog.remove();
    }
  });
  
  buttonContainer.appendChild(noButton);
  buttonContainer.appendChild(yesButton);
  
  content.appendChild(titleEl);
  content.appendChild(messageEl);
  content.appendChild(buttonContainer);
  dialog.appendChild(content);
  document.body.appendChild(dialog);
}

// ----- Chat Section Toggle -----
function toggleChatSection(show) {
  if (CHAT_SECTION) {
    CHAT_SECTION.style.display = show ? 'block' : 'none';
  }
}

// Load stats from localStorage
function loadStats() {
  const saved = localStorage.getItem('gameStats');
  if (saved) {
    gameStats = JSON.parse(saved);
    updateStatsDisplay();
  }
}

// Update stats display
function updateStatsDisplay() {
  if (STAT_WINS) STAT_WINS.textContent = gameStats.wins;
  if (STAT_LOSSES) STAT_LOSSES.textContent = gameStats.losses;
  if (STAT_DRAWS) STAT_DRAWS.textContent = gameStats.draws;
  if (STAT_STREAK) STAT_STREAK.textContent = gameStats.streak;
}

// Update game statistics
function updateStats(result) {
  if (result === 'win') {
    gameStats.wins++;
    gameStats.streak++;
  } else if (result === 'loss') {
    gameStats.losses++;
    gameStats.streak = 0;
  } else {
    gameStats.draws++;
    gameStats.streak = 0;
  }
  localStorage.setItem('gameStats', JSON.stringify(gameStats));
  updateStatsDisplay();
}

// small helper for element creation
function e(tag, cls) { const el = document.createElement(tag); if (cls) el.className = cls; return el; }
function showStatus(msg, color) { if (TURN_IND) { TURN_IND.textContent = msg; TURN_IND.style.color = color || '#333'; } }
function setRoomCode(code) { currentRoom = code; if (ROOM_CODE_EL) ROOM_CODE_EL.textContent = code || '—'; }

// ----- Game Dialog System -----
function showGameDialog(title, message, isWin = false) {
  // Remove existing dialog if any
  const existingDialog = document.getElementById('game-result-dialog');
  if (existingDialog) {
    existingDialog.remove();
  }
  
  const dialog = document.createElement('div');
  dialog.id = 'game-result-dialog';
  dialog.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  `;
  
  const content = document.createElement('div');
  content.style.cssText = `
    background: white;
    padding: 30px;
    border-radius: 12px;
    text-align: center;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 10px 30px rgba(0,0,0,0.3);
  `;
  
  const titleEl = document.createElement('h2');
  titleEl.textContent = title;
  titleEl.style.color = isWin ? '#2e7d32' : '#d84315';
  titleEl.style.margin = '0 0 15px 0';
  
  const messageEl = document.createElement('p');
  messageEl.textContent = message;
  messageEl.style.margin = '0 0 20px 0';
  
  const button = document.createElement('button');
  button.textContent = 'Continue';
  button.style.cssText = `
    background: var(--purple);
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 8px;
    cursor: pointer;
    font-weight: bold;
  `;
  
  button.addEventListener('click', () => {
    dialog.remove();
    if (isSolo && localGame) {
      // Reset the game for next round in solo mode
      startLocalGame(localGame.size);
    }
  });
  
  content.appendChild(titleEl);
  content.appendChild(messageEl);
  content.appendChild(button);
  dialog.appendChild(content);
  document.body.appendChild(dialog);
}

// ----- History REST -----
async function loadHistory() {
  if (!username || !HISTORY_LIST) return;
  HISTORY_LIST.innerHTML = 'Loading...';
  try {
    const res = await fetch(`/history?username=${encodeURIComponent(username)}`);
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      HISTORY_LIST.innerHTML = '<div class="item">No games yet</div>';
      return;
    }
  HISTORY_LIST.innerHTML = '';
    data.slice(0, 20).forEach(h => {
      const div = e('div', 'item');
      div.textContent = `${(new Date(h.date)).toLocaleString()} — ${h.mode} — ${h.result} — vs ${h.opponent || 'CPU'}`;
      HISTORY_LIST.appendChild(div);
    });
  } catch (err) {
    HISTORY_LIST.innerHTML = '<div class="item">Error loading history</div>';
    console.error('History load error', err);
  }
}

async function saveHistory(entry) {
  try {
    await fetch('/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });
  } catch (e) { console.warn('Could not save history', e); }
}

// ----- Board rendering / click handling -----
function buildBoardDOM(boardSizeN, boardArray) {
  BOARD.innerHTML = '';
  BOARD.style.gridTemplateColumns = `repeat(${boardSizeN}, 1fr)`;
  const N = boardSizeN;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const cell = e('div', 'cell');
      const value = boardArray?.[i]?.[j] ?? null;
      if (value) {
        cell.textContent = value;
        cell.classList.add(value === 'X' ? 'x' : 'o');
      } else {
        cell.textContent = '';
      }
      cell.dataset.r = i; cell.dataset.c = j;
      // attach click handler (handles solo clear-mode and multiplayer emits)
      cell.addEventListener('click', () => handleCellClick(i, j));
      BOARD.appendChild(cell);
    }
  }
}

// ----- Win/draw checks (client-side for solo) -----
function getWinLen(sz) {
  if (sz <= 4) return 3;
  if (sz === 5) return 4;
  return 5;
}

function checkWinnerLocal(board, symbol, win_len) {
  const N = board.length;
  win_len = win_len || getWinLen(N);
  if (win_len > N) win_len = N;

  // horizontal
  for (let r = 0; r < N; r++) {
    for (let c = 0; c <= N - win_len; c++) {
      let ok = true;
      for (let k = 0; k < win_len; k++) if (board[r][c + k] !== symbol) { ok = false; break; }
      if (ok) return true;
    }
  }
  // vertical
  for (let c = 0; c < N; c++) {
    for (let r = 0; r <= N - win_len; r++) {
      let ok = true;
      for (let k = 0; k < win_len; k++) if (board[r + k][c] !== symbol) { ok = false; break; }
      if (ok) return true;
    }
  }
  // diag down-right
  for (let r = 0; r <= N - win_len; r++) {
    for (let c = 0; c <= N - win_len; c++) {
      let ok = true;
      for (let k = 0; k < win_len; k++) if (board[r + k][c + k] !== symbol) { ok = false; break; }
      if (ok) return true;
    }
  }
  // diag up-right
  for (let r = win_len - 1; r < N; r++) {
    for (let c = 0; c <= N - win_len; c++) {
      let ok = true;
      for (let k = 0; k < win_len; k++) if (board[r - k][c + k] !== symbol) { ok = false; break; }
      if (ok) return true;
    }
  }
  return false;
}

function isBoardFullLocal(board) {
  for (let r = 0; r < board.length; r++) for (let c = 0; c < board.length; c++) if (board[r][c] === null) return false;
  return true;
}

// ----- Simple AI -----
// tries immediate win, then block, then center, then random
function chooseAIMove(board, symbol) {
  const N = board.length;
  function tryFor(sym) {
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (board[r][c] !== null) continue;
        board[r][c] = sym;
        const win = checkWinnerLocal(board, sym, getWinLen(N));
        board[r][c] = null;
        if (win) return [r, c];
      }
    }
    return null;
  }
  // win
  let m = tryFor(symbol);
  if (m) return m;
  // block opponent
  const opp = symbol === 'X' ? 'O' : 'X';
  m = tryFor(opp);
  if (m) return m;
  // center
  const center = Math.floor(N / 2);
  if (board[center][center] === null) return [center, center];
  // random
  const free = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (board[r][c] === null) free.push([r, c]);
  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)];
}

// ----- Solo game logic -----
function startLocalGame(N) {
  isSolo = true;
  localGame = {
    size: N,
    board: Array.from({ length: N }, () => Array.from({ length: N }, () => null)),
    turn: 'X',
    players: [username, 'CPU'],
    powerups: { 
      [username]: { 
        block: myPowerups.block || 1, 
        clear: myPowerups.clear || 1 
      } 
    },
    blocked: false,
    clear_mode: null
  };
  mySymbol = 'X';
  setRoomCode('LOCAL');
  
  // Hide chat section for solo mode
  toggleChatSection(false);
  
  renderFromState(localGame);
  showStatus("Your turn (you are X)", '#4CAF50');
  
  // Update player symbol display
  if (PLAYER_SYMBOL_EL) PLAYER_SYMBOL_EL.textContent = `You are: X`;
}

// handle click (both solo and multiplayer)
async function handleCellClick(r, c) {
  // if solo mode and no localGame active, ignore
  if (isSolo) {
    if (!localGame) return;
    // If clear-mode active for this user, clear a filled cell
    if (localGame.clear_mode === username) {
      if (localGame.board[r][c] !== null) {
        localGame.board[r][c] = null;
        localGame.clear_mode = null;
        renderFromState(localGame);
        showStatus("Cell cleared. Your turn continues.", '#4CAF50');
      } else {
        // nothing to clear
        localGame.clear_mode = null;
        showStatus("Nothing there to clear.", '#FF9800');
      }
      return;
    }

    // normal move flow
    if (localGame.board[r][c] !== null) return;      // occupied
    if (localGame.turn !== mySymbol) return;         // not player's turn

    // place player's symbol
    localGame.board[r][c] = mySymbol;
    renderFromState(localGame);

    // Check for player's win
    const winlen = getWinLen(localGame.size);
    if (checkWinnerLocal(localGame.board, mySymbol, winlen)) {
      showStatus("You win!", '#2e7d32');
      showGameDialog('🎉 You Won!', `Congratulations ${username}! You won against the CPU!`, true);
      updateStats('win');
      await saveHistory({ username, opponent: 'CPU', mode: 'solo', result: 'win', date: new Date().toISOString(), board_size: localGame.size });
      return;
    }

    // Check draw
    if (isBoardFullLocal(localGame.board)) {
      showStatus("Draw", '#555');
      showGameDialog('🤝 Draw!', 'The game ended in a draw. Well played!', false);
      updateStats('draw');
      await saveHistory({ username, opponent: 'CPU', mode: 'solo', result: 'draw', date: new Date().toISOString(), board_size: localGame.size });
      return;
    }

    // switch to CPU turn (or handle blocked)
    localGame.turn = 'O';
    renderFromState(localGame);

    // If CPU is blocked (from player's power-up), skip CPU move once
    if (localGame.blocked) {
      localGame.blocked = false;
      localGame.turn = 'X';
      renderFromState(localGame);
      showStatus("CPU was blocked — your turn again.", '#4CAF50');
      return;
    }

    showStatus("CPU thinking...", '#ff7043');
    setTimeout(async () => {
      const mv = chooseAIMove(localGame.board, 'O');
      if (!mv) {
        showStatus("Draw", '#555');
        showGameDialog('🤝 Draw!', 'The game ended in a draw. Well played!', false);
        updateStats('draw');
        await saveHistory({ username, opponent: 'CPU', mode: 'solo', result: 'draw', date: new Date().toISOString(), board_size: localGame.size });
        return;
      }
      const [rr, cc] = mv;
      localGame.board[rr][cc] = 'O';
      renderFromState(localGame);

      // Check CPU win
      if (checkWinnerLocal(localGame.board, 'O', winlen)) {
        showStatus("CPU wins", '#b00020');
        showGameDialog('😢 CPU Wins', 'The AI outsmarted you this time. Try again!', false);
        updateStats('loss');
        await saveHistory({ username, opponent: 'CPU', mode: 'solo', result: 'loss', date: new Date().toISOString(), board_size: localGame.size });
        return;
      }

      if (isBoardFullLocal(localGame.board)) {
        showStatus("Draw", '#555');
        showGameDialog('🤝 Draw!', 'The game ended in a draw. Well played!', false);
        updateStats('draw');
        await saveHistory({ username, opponent: 'CPU', mode: 'solo', result: 'draw', date: new Date().toISOString(), board_size: localGame.size });
        return;
      }

      // back to player
      localGame.turn = 'X';
      renderFromState(localGame);
      showStatus("Your turn", '#4CAF50');
    }, 450);

    return;
  }

  // Multiplayer path: send move to server
  if (!currentRoom || currentRoom === 'LOCAL') return;
  socket.emit('make_move', { room: currentRoom, x: r, y: c, username });
}

// ----- Render from a given game state object (local or server) -----
function renderFromState(state) {
  buildBoardDOM(state.size, state.board);
  // update power-up displays
  const p = (state.powerups && state.powerups[username]) ? state.powerups[username] : (state.powerups ? Object.values(state.powerups)[0] : myPowerups);
  if (COUNT_BLOCK) COUNT_BLOCK.textContent = p?.block ?? 0;
  if (COUNT_CLEAR) COUNT_CLEAR.textContent = p?.clear ?? 0;
}

// ----- Power-ups (solo and multiplayer) -----
function usePowerUp(power) {
  if (isSolo) {
    if (!localGame) return alert('No active game');
    const ups = localGame.powerups[username] || { block: 0, clear: 0 };
    if ((ups[power] || 0) <= 0) return alert('No power-ups left');
    ups[power] -= 1;
    
    // Update global power-up counts
    myPowerups[power] = ups[power];
    
    if (power === 'clear') {
      localGame.clear_mode = username;
      showStatus("Clear mode activated - click an occupied cell", '#FF9800');
    } else if (power === 'block') {
      localGame.blocked = true;
      showStatus("CPU will be blocked next turn!", '#4CAF50');
    }
    renderFromState(localGame);
    return;
  }

  // multiplayer: notify server
  if (!currentRoom || currentRoom === 'LOCAL') return alert('Not in a room');
  socket.emit('use_power_up', { room: currentRoom, power_up: power, username });
}

// ----- Socket.IO (multiplayer) handlers -----
if (socket) {
  socket.on('connect', () => {
    if (mode !== 'solo') {
      socket.emit('join', { username, board_size: boardSize, room: roomCode || null });
    }
  });

  socket.on('joined_room', (data) => {
    setRoomCode(data.room);
    
    // Show chat section for multiplayer
    if (data.room !== 'LOCAL') {
      toggleChatSection(true);
    }
  });

  socket.on('game_update', (game) => {
    if (mode === 'solo') return;
    
    // switch to multiplayer mode
    isSolo = false;
    // set symbol
    if (game.players && game.players.length >= 1) {
      mySymbol = (game.players[0] === username) ? 'X' : 'O';
      if (PLAYER_SYMBOL_EL) PLAYER_SYMBOL_EL.textContent = `You are: ${mySymbol}`;
    }
    // render
    renderFromState(game);
    // turn indicator
    if ((game.players || []).length < 2) {
      showStatus('Waiting for another player...', '#FF9800');
    } else {
      const currentPlayer = game.players[game.turn === 'X' ? 0 : 1];
      if (currentPlayer === username) showStatus("🎯 YOUR TURN!", '#2e7d32'); else showStatus(`Waiting for ${currentPlayer}...`, '#ff7043');
    }
  });

  socket.on('game_over', async (data) => {
    if (data.status === 'win') {
      if (data.winner === username) {
        showGameDialog('🎉 You Won!', `Congratulations! You won against ${data.loser || 'opponent'}!`, true);
        updateStats('win');
      } else {
        showGameDialog('😢 You Lost', `Better luck next time! ${data.winner} won this round.`, false);
        updateStats('loss');
      }
    } else if (data.status === 'draw') {
      showGameDialog('🤝 Draw!', 'The game ended in a draw. Well played both!', false);
      updateStats('draw');
    }
  });

  // New game request handler
  socket.on('new_game_requested', (data) => {
    showNewGameConfirmation(data.requested_by);
  });

  // Error handlers
  socket.on('join_error', (data) => {
    alert('Join error: ' + (data.message || 'Room is full'));
    window.location.href = '/game';
  });

  socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    showStatus("Connection failed", '#b00020');
  });

  socket.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
    showStatus("Disconnected", '#b00020');
  });

  socket.on('chat_update', (data) => appendChatLine(data.username, data.message));
  socket.on('power_up_error', (data) => alert(data.message));
  socket.on('game_message', (data) => appendChatSystem(data.message || ''));
}

// ----- Chat helpers -----
function appendChatLine(sender, message) {
  if (!CHAT_MESSAGES) return;
  const p = e('p'); p.textContent = `${sender}: ${message}`;
  CHAT_MESSAGES.appendChild(p); CHAT_MESSAGES.scrollTop = CHAT_MESSAGES.scrollHeight;
}
function appendChatSystem(msg) {
  if (!CHAT_MESSAGES) return;
  const p = e('p'); p.textContent = `* ${msg}`; p.style.fontStyle = 'italic'; p.style.opacity = '0.9';
  CHAT_MESSAGES.appendChild(p); CHAT_MESSAGES.scrollTop = CHAT_MESSAGES.scrollHeight;
}
if (SEND_CHAT_BTN) SEND_CHAT_BTN.addEventListener('click', () => sendChat());
if (CHAT_INPUT) CHAT_INPUT.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const v = CHAT_INPUT.value?.trim();
  if (!v) return;
  if (isSolo) {
    appendChatLine(username, v);
  } else {
    if (!currentRoom || currentRoom === 'LOCAL') return alert('Not connected to a room');
    socket.emit('chat_message', { room: currentRoom, username, message: v });
  }
  CHAT_INPUT.value = '';
}

// ----- Controls: new game, power buttons, history refresh -----
if (NEW_GAME_BTN) NEW_GAME_BTN.addEventListener('click', () => {
  if (isSolo) {
    // For solo mode, just reset immediately with power-ups
    myPowerups = { block: 1, clear: 1 }; // Reset power-ups
    startLocalGame(boardSize);
  } else {
    if (!currentRoom || currentRoom === 'LOCAL') return alert('Not in a room');
    // For multiplayer, request confirmation from other player
    socket.emit('request_new_game', { room: currentRoom, username });
  }
});
if (REFRESH_HISTORY_BTN) REFRESH_HISTORY_BTN.addEventListener('click', () => loadHistory());
if (POWER_BLOCK_BTN) POWER_BLOCK_BTN.addEventListener('click', () => usePowerUp('block'));
if (POWER_CLEAR_BTN) POWER_CLEAR_BTN.addEventListener('click', () => usePowerUp('clear'));

// ----- Initialization -----
function init() {
  BOARD_LABEL && (BOARD_LABEL.textContent = boardSize);
  loadStats(); // Load game statistics
  setupExitButton(); // Setup exit button functionality
  setupSessionRecovery(); // Setup session recovery
  
  console.log("Initializing with mode:", mode);
  
  if (mode === 'solo') {
    startLocalGame(Number(boardSize));
  } else {
    isSolo = false;
    setRoomCode(roomCode);
    if (socket && socket.connected) {
      socket.emit('join', { username, board_size: boardSize, room: roomCode || null });
    }
  }
  loadHistory();
}

// Start the game
init();