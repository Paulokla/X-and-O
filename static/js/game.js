/* static/js/game.js
   Fixed version: renders winning move before disabling clicks,
   AI works, solo power-ups (block/clear) handled, multiplayer unchanged.
*/

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
const COUNT_BLOCK = document.getElementById('count-block');
const COUNT_CLEAR = document.getElementById('count-clear');
const BOARD_LABEL = document.getElementById('board-size-label');

// injected by template
if (typeof username === 'undefined') window.username = 'Guest';
if (typeof boardSize === 'undefined') window.boardSize = 3;
if (typeof roomCode === 'undefined') window.roomCode = null;

// local state
let localGame = null;      // object when solo is active, null otherwise
let currentRoom = null;    // room code for multiplayer
let mySymbol = null;       // 'X' or 'O' in multiplayer; 'X' in solo
let isSolo = false;
let myPowerups = { block: 1, clear: 1 }; // default local powerups (persisted per-game)

// small helper for element creation
function e(tag, cls){ const el = document.createElement(tag); if (cls) el.className = cls; return el; }
function showStatus(msg, color){ if (TURN_IND) { TURN_IND.textContent = msg; TURN_IND.style.color = color || '#333'; } }
function setRoomCode(code){ currentRoom = code; if (ROOM_CODE_EL) ROOM_CODE_EL.textContent = code || '—'; }

// ----- History REST -----
async function loadHistory(){
  if (!username || !HISTORY_LIST) return;
  HISTORY_LIST.innerHTML = 'Loading...';
  try {
    const res = await fetch(`/history?username=${encodeURIComponent(username)}`);
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0){
      HISTORY_LIST.innerHTML = '<div class="item">No games yet</div>';
      return;
    }
    HISTORY_LIST.innerHTML = '';
    data.slice(0,20).forEach(h => {
      const div = e('div','item');
      div.textContent = `${(new Date(h.date)).toLocaleString()} — ${h.mode} — ${h.result} — vs ${h.opponent || 'CPU'}`;
      HISTORY_LIST.appendChild(div);
    });
  } catch (err){
    HISTORY_LIST.innerHTML = '<div class="item">Error loading history</div>';
    console.error('History load error', err);
  }
}

async function saveHistory(entry){
  try {
    await fetch('/history', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(entry)
    });
  } catch(e){ console.warn('Could not save history', e); }
}

// ----- Board rendering / click handling -----
function buildBoardDOM(boardSizeN, boardArray){
  BOARD.innerHTML = '';
  BOARD.style.gridTemplateColumns = `repeat(${boardSizeN}, 1fr)`;
  const N = boardSizeN;
  for (let i=0;i<N;i++){
    for (let j=0;j<N;j++){
      const cell = e('div','cell');
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
function getWinLen(sz){
  if (sz <= 4) return 3;
  if (sz === 5) return 4;
  return 5;
}
function checkWinnerLocal(board, symbol, win_len){
  const N = board.length;
  win_len = win_len || getWinLen(N);
  if (win_len > N) win_len = N;

  // horizontal
  for (let r=0;r<N;r++){
    for (let c=0;c<=N-win_len;c++){
      let ok=true;
      for (let k=0;k<win_len;k++) if (board[r][c+k] !== symbol) { ok=false; break; }
      if (ok) return true;
    }
  }
  // vertical
  for (let c=0;c<N;c++){
    for (let r=0;r<=N-win_len;r++){
      let ok=true;
      for (let k=0;k<win_len;k++) if (board[r+k][c] !== symbol) { ok=false; break; }
      if (ok) return true;
    }
  }
  // diag down-right
  for (let r=0;r<=N-win_len;r++){
    for (let c=0;c<=N-win_len;c++){
      let ok=true;
      for (let k=0;k<win_len;k++) if (board[r+k][c+k] !== symbol) { ok=false; break; }
      if (ok) return true;
    }
  }
  // diag up-right
  for (let r=win_len-1;r<N;r++){
    for (let c=0;c<=N-win_len;c++){
      let ok=true;
      for (let k=0;k<win_len;k++) if (board[r-k][c+k] !== symbol) { ok=false; break; }
      if (ok) return true;
    }
  }
  return false;
}
function isBoardFullLocal(board){
  for (let r=0;r<board.length;r++) for (let c=0;c<board.length;c++) if (board[r][c] === null) return false;
  return true;
}

// ----- Simple AI -----
// tries immediate win, then block, then center, then random
function chooseAIMove(board, symbol){
  const N = board.length;
  function tryFor(sym){
    for (let r=0;r<N;r++){
      for (let c=0;c<N;c++){
        if (board[r][c] !== null) continue;
        board[r][c] = sym;
        const win = checkWinnerLocal(board, sym, getWinLen(N));
        board[r][c] = null;
        if (win) return [r,c];
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
  const center = Math.floor(N/2);
  if (board[center][center] === null) return [center, center];
  // random
  const free = [];
  for (let r=0;r<N;r++) for (let c=0;c<N;c++) if (board[r][c] === null) free.push([r,c]);
  if (free.length === 0) return null;
  return free[Math.floor(Math.random()*free.length)];
}

// ----- Solo game logic -----
function startLocalGame(N){
  isSolo = true;
  localGame = {
    size: N,
    board: Array.from({length:N}, ()=>Array.from({length:N}, ()=>null)),
    turn: 'X',
    players: [username, 'CPU'],
    powerups: { [username]: {...myPowerups} },
    blocked: false,
    clear_mode: null
  };
  mySymbol = 'X';
  setRoomCode('LOCAL');
  renderFromState(localGame);
  showStatus("Your turn (you are X)", '#4CAF50');
}

// handle click (both solo and multiplayer)
async function handleCellClick(r, c){
  // if solo mode and no localGame active, ignore
  if (isSolo){
    if (!localGame) return;
    // If clear-mode active for this user, clear a filled cell
    if (localGame.clear_mode === username){
      if (localGame.board[r][c] !== null){
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
    if (checkWinnerLocal(localGame.board, mySymbol, winlen)){
      // render the winning move (already rendered) then save & disable after short delay
      showStatus("You win!", '#2e7d32');
      await saveHistory({ username, opponent:'CPU', mode:'solo', result:'win', date: new Date().toISOString(), board_size: localGame.size });
      // keep board visible then end game
      setTimeout(()=> { localGame = null; }, 350);
      return;
    }

    // Check draw
    if (isBoardFullLocal(localGame.board)){
      renderFromState(localGame);
      showStatus("Draw", '#555');
      await saveHistory({ username, opponent:'CPU', mode:'solo', result:'draw', date: new Date().toISOString(), board_size: localGame.size });
      setTimeout(()=> { localGame = null; }, 350);
      return;
    }

    // switch to CPU turn (or handle blocked)
    localGame.turn = 'O';
    renderFromState(localGame);

    // If CPU is blocked (from player's power-up), skip CPU move once
    if (localGame.blocked){
      localGame.blocked = false;
      localGame.turn = 'X';
      renderFromState(localGame);
      showStatus("CPU was blocked — your turn again.", '#4CAF50');
      return;
    }

    showStatus("CPU thinking...", '#ff7043');
    setTimeout(async ()=>{
      const mv = chooseAIMove(localGame.board, 'O');
      if (!mv){
        showStatus("Draw", '#555');
        await saveHistory({ username, opponent:'CPU', mode:'solo', result:'draw', date: new Date().toISOString(), board_size: localGame.size });
        setTimeout(()=> localGame = null, 350);
        return;
      }
      const [rr, cc] = mv;
      localGame.board[rr][cc] = 'O';
      renderFromState(localGame);

      // Check CPU win
      if (checkWinnerLocal(localGame.board, 'O', winlen)){
        showStatus("CPU wins", '#b00020');
        await saveHistory({ username, opponent:'CPU', mode:'solo', result:'loss', date: new Date().toISOString(), board_size: localGame.size });
        setTimeout(()=> localGame = null, 350);
        return;
      }

      if (isBoardFullLocal(localGame.board)){
        showStatus("Draw", '#555');
        await saveHistory({ username, opponent:'CPU', mode:'solo', result:'draw', date: new Date().toISOString(), board_size: localGame.size });
        setTimeout(()=> localGame = null, 350);
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
  if (!currentRoom) return;
  socket.emit('make_move', { room: currentRoom, x: r, y: c, username });
}

// ----- Render from a given game state object (local or server) -----
function renderFromState(state){
  buildBoardDOM(state.size, state.board);
  // update power-up displays
  const p = (state.powerups && state.powerups[username]) ? state.powerups[username] : (state.powerups ? Object.values(state.powerups)[0] : myPowerups);
  if (COUNT_BLOCK) COUNT_BLOCK.textContent = p?.block ?? 0;
  if (COUNT_CLEAR) COUNT_CLEAR.textContent = p?.clear ?? 0;
}

// ----- Power-ups (solo and multiplayer) -----
function usePowerUp(power){
  if (isSolo){
    if (!localGame) return alert('No active game');
    const ups = localGame.powerups[username] || {block:0, clear:0};
    if ((ups[power] || 0) <= 0) return alert('No power-ups left');
    ups[power] -= 1;
    if (power === 'clear'){
      localGame.clear_mode = username;
      alert('Click a filled cell to clear it.');
    } else if (power === 'block'){
      // set blocked flag so CPU's next turn is skipped
      localGame.blocked = true;
      alert('CPU will be blocked on its next turn.');
    }
    renderFromState(localGame);
    return;
  }

  // multiplayer: notify server
  if (!currentRoom) return alert('Not in a room');
  socket.emit('use_power_up', { room: currentRoom, power_up: power, username });
}

// ----- Socket.IO (multiplayer) handlers -----
if (socket){
  socket.on('connect', ()=>{
    socket.emit('join_game', { username, board_size: boardSize, room: roomCode || null });
  });

  socket.on('joined_room', (data)=>{
    setRoomCode(data.room);
  });

  socket.on('game_update', (game)=>{
    // switch to multiplayer mode
    isSolo = false;
    // set symbol
    if (game.players && game.players.length >= 1){
      mySymbol = (game.players[0] === username) ? 'X' : 'O';
      if (PLAYER_SYMBOL_EL) PLAYER_SYMBOL_EL.textContent = `You are: ${mySymbol}`;
    }
    // render
    renderFromState(game);
    // turn indicator
    if ((game.players || []).length < 2){
      showStatus('Waiting for another player...', '#FF9800');
    } else {
      const currentPlayer = game.players[ game.turn === 'X' ? 0 : 1 ];
      if (currentPlayer === username) showStatus("🎯 YOUR TURN!", '#2e7d32'); else showStatus(`Waiting for ${currentPlayer}...`, '#ff7043');
    }
  });

  socket.on('game_over', async (data)=>{
    if (data.status === 'win'){
      if (data.winner === username){
        alert('🎉 You WON!');
        // await saveHistory({ username, opponent: data.loser || 'opponent', mode:'multiplayer', result:'win', date: new Date().toISOString(), board_size: boardSize });
      } else {
        alert(`😢 You lost. Winner: ${data.winner}`);
        // await saveHistory({ username, opponent: data.winner || 'opponent', mode:'multiplayer', result:'loss', date: new Date().toISOString(), board_size: boardSize });
      }
    } else if (data.status === 'draw'){
      alert("🤝 It's a draw!");
      // await saveHistory({ username, opponent: 'opponent', mode:'multiplayer', result:'draw', date: new Date().toISOString(), board_size: boardSize });
    }
  });

  socket.on('chat_update', (data)=> appendChatLine(data.username, data.message));
  socket.on('power_up_error', (data)=> alert(data.message));
  socket.on('game_message', (data)=> appendChatSystem(data.message || ''));
}

// ----- Chat helpers -----
function appendChatLine(sender, message){
  if (!CHAT_MESSAGES) return;
  const p = e('p'); p.textContent = `${sender}: ${message}`;
  CHAT_MESSAGES.appendChild(p); CHAT_MESSAGES.scrollTop = CHAT_MESSAGES.scrollHeight;
}
function appendChatSystem(msg){
  if (!CHAT_MESSAGES) return;
  const p = e('p'); p.textContent = `* ${msg}`; p.style.fontStyle='italic'; p.style.opacity='0.9';
  CHAT_MESSAGES.appendChild(p); CHAT_MESSAGES.scrollTop = CHAT_MESSAGES.scrollHeight;
}
if (SEND_CHAT_BTN) SEND_CHAT_BTN.addEventListener('click', ()=> sendChat());
if (CHAT_INPUT) CHAT_INPUT.addEventListener('keypress', (e)=> { if (e.key === 'Enter') sendChat(); });
function sendChat(){
  const v = CHAT_INPUT.value?.trim();
  if (!v) return;
  if (isSolo){
    appendChatLine(username, v);
  } else {
    if (!currentRoom) return alert('Not connected to a room');
    socket.emit('chat_message', { room: currentRoom, username, message: v });
  }
  CHAT_INPUT.value = '';
}

// ----- Controls: new game, power buttons, history refresh -----
if (NEW_GAME_BTN) NEW_GAME_BTN.addEventListener('click', ()=>{
  if (isSolo) startLocalGame(boardSize);
  else {
    if (!currentRoom) return alert('Not in a room');
    socket.emit('new_game', { room: currentRoom });
  }
});
if (REFRESH_HISTORY_BTN) REFRESH_HISTORY_BTN.addEventListener('click', ()=> loadHistory());
if (POWER_BLOCK_BTN) POWER_BLOCK_BTN.addEventListener('click', ()=> usePowerUp('block'));
if (POWER_CLEAR_BTN) POWER_CLEAR_BTN.addEventListener('click', ()=> usePowerUp('clear'));

// ----- Initialization -----
function init(){
  BOARD_LABEL && (BOARD_LABEL.textContent = boardSize);
  // if (roomCode === null || roomCode === 'null' || roomCode === '') {
  //   // default to solo mode on load
  //   startLocalGame(Number(boardSize));
  // } else {
  //   // join multiplayer room
  //   isSolo = false;
  //   setRoomCode(roomCode);
  //   if (socket && socket.connected) socket.emit('join_game', { username, board_size: boardSize, room: roomCode });
  // }
  console.log(mode)
  if (mode === 'solo') {
    startLocalGame(Number(boardSize));
  } else {
    isSolo = false;
    setRoomCode(roomCode);
    if (socket && socket.connected) {
      socket.emit('join_game', { username, board_size: boardSize, room: roomCode || null });
    }
  }
  loadHistory();
}
init();
