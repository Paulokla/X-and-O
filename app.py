from flask import Flask, render_template, request, session, redirect, url_for, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
import sqlite3
import random
import os
import datetime
import logging
from logging.handlers import RotatingFileHandler
import json

app = Flask(__name__)

# Use threading mode for better compatibility
async_mode = 'None'
app.config['SECRET_KEY'] = 'i love python'

# Configure error logging
def setup_logging():
    if not os.path.exists('logs'):
        os.makedirs('logs')
    
    # Create file handler for errors
    file_handler = RotatingFileHandler(
        'logs/error.log', 
        maxBytes=10240, 
        backupCount=10
    )
    file_handler.setFormatter(logging.Formatter(
        '%(asctime)s %(levelname)s: %(message)s [in %(pathname)s:%(lineno)d]'
    ))
    file_handler.setLevel(logging.ERROR)
    
    # Apply to app logger
    app.logger.addHandler(file_handler)
    app.logger.setLevel(logging.ERROR)

setup_logging()

# Configure SocketIO with threading for maximum compatibility
socketio = SocketIO(
    app,
    async_mode=async_mode,
    cors_allowed_origins="*",
    ping_timeout=60,
    ping_interval=25,
    logger=False,
    engineio_logger=False  # Disabled for cleaner logs
)

# In-memory games (replace with Redis in production)
games = {}

DB_PATH = 'database.db'

# ---- Database init ----
def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()
        # history: store user's games
        c.execute("""
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            opponent TEXT,
            mode TEXT,
            result TEXT,
            board_size INTEGER,
            date TEXT
        )""")
        # leaderboard
        c.execute("""
        CREATE TABLE IF NOT EXISTS leaderboard (
            username TEXT PRIMARY KEY,
            score INTEGER DEFAULT 0,
            wins INTEGER DEFAULT 0
        )""")
        # user_sessions: store room codes for recovery
        c.execute("""
        CREATE TABLE IF NOT EXISTS user_sessions (
            username TEXT PRIMARY KEY,
            room_code TEXT,
            board_size INTEGER,
            mode TEXT,
            last_activity TEXT
        )""")
        conn.commit()

init_db()

def log_error(error_type, message, details=None):
    """Log errors to file with timestamp and details"""
    timestamp = datetime.datetime.utcnow().isoformat()
    error_data = {
        'timestamp': timestamp,
        'type': error_type,
        'message': message,
        'details': details
    }
    
    # Log to file
    app.logger.error(f"{error_type}: {message} - {details}")
    
    # Also write to a structured error log
    try:
        with open('logs/structured_errors.log', 'a') as f:
            f.write(json.dumps(error_data) + '\n')
    except Exception as e:
        app.logger.error(f"Failed to write structured error log: {e}")

def save_user_session(username, room_code, board_size, mode):
    """Save user's current room for recovery"""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            c = conn.cursor()
            c.execute("""
                INSERT OR REPLACE INTO user_sessions 
                (username, room_code, board_size, mode, last_activity)
                VALUES (?, ?, ?, ?, ?)
            """, (username, room_code, board_size, mode, datetime.datetime.utcnow().isoformat()))
            conn.commit()
    except Exception as e:
        log_error("SESSION_SAVE_ERROR", f"Failed to save session for {username}", str(e))

def get_user_session(username):
    """Get user's saved room session"""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            c = conn.cursor()
            c.execute("SELECT room_code, board_size, mode FROM user_sessions WHERE username = ?", (username,))
            result = c.fetchone()
            if result:
                return {
                    'room_code': result[0],
                    'board_size': result[1],
                    'mode': result[2]
                }
    except Exception as e:
        log_error("SESSION_LOAD_ERROR", f"Failed to load session for {username}", str(e))
    return None

def clear_user_session(username):
    """Clear user's saved session"""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            c = conn.cursor()
            c.execute("DELETE FROM user_sessions WHERE username = ?", (username,))
            conn.commit()
    except Exception as e:
        log_error("SESSION_CLEAR_ERROR", f"Failed to clear session for {username}", str(e))

def add_history_entry(entry):
    # entry: dict with username, opponent, mode, result, board_size, date
    try:
        with sqlite3.connect(DB_PATH) as conn:
            c = conn.cursor()
            c.execute("""
                INSERT INTO history (username, opponent, mode, result, board_size, date)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (entry.get('username'), entry.get('opponent'), entry.get('mode'),
                  entry.get('result'), entry.get('board_size'), entry.get('date')))
            conn.commit()
    except Exception as e:
        log_error("HISTORY_SAVE_ERROR", "Failed to save history entry", str(e))

def get_history_for_user(username, limit=100):
    try:
        with sqlite3.connect(DB_PATH) as conn:
            c = conn.cursor()
            c.execute("SELECT username, opponent, mode, result, board_size, date FROM history WHERE username = ? ORDER BY id DESC LIMIT ?", (username, limit))
            rows = c.fetchall()
            return [
                {
                    'username': r[0],
                    'opponent': r[1],
                    'mode': r[2],
                    'result': r[3],
                    'board_size': r[4],
                    'date': r[5]
                } for r in rows
            ]
    except Exception as e:
        log_error("HISTORY_LOAD_ERROR", f"Failed to load history for {username}", str(e))
        return []

def update_leaderboard(username, points=10):
    try:
        with sqlite3.connect(DB_PATH) as conn:
            c = conn.cursor()
            c.execute("""
                INSERT INTO leaderboard (username, score, wins)
                VALUES (?, ?, ?)
                ON CONFLICT(username) DO UPDATE SET
                    score = score + excluded.score,
                    wins = wins + 1
            """, (username, points,1))
            conn.commit()
    except Exception as e:
        log_error("LEADERBOARD_UPDATE_ERROR", f"Failed to update leaderboard for {username}", str(e))

# ---- Game utilities ----
def new_empty_board(n):
    return [[None for _ in range(n)] for _ in range(n)]

def get_win_len(size):
    if size <= 4:
        return 3
    if size == 5:
        return 4
    return 5

def is_board_full(board):
    return all(cell is not None for row in board for cell in row)

def check_winner(board, symbol, win_len=None):
    n = len(board)
    if win_len is None:
        win_len = get_win_len(n)
    if win_len > n:
        win_len = n

    # horizontal
    for r in range(n):
        for c in range(0, n - win_len + 1):
            ok = True
            for k in range(win_len):
                if board[r][c + k] != symbol:
                    ok = False
                    break
            if ok:
                return True

    # vertical
    for c in range(n):
        for r in range(0, n - win_len + 1):
            ok = True
            for k in range(win_len):
                if board[r + k][c] != symbol:
                    ok = False
                    break
            if ok:
                return True

    # diagonal down-right
    for r in range(0, n - win_len + 1):
        for c in range(0, n - win_len + 1):
            ok = True
            for k in range(win_len):
                if board[r + k][c + k] != symbol:
                    ok = False
                    break
            if ok:
                return True

    # diagonal up-right
    for r in range(win_len - 1, n):
        for c in range(0, n - win_len + 1):
            ok = True
            for k in range(win_len):
                if board[r - k][c + k] != symbol:
                    ok = False
                    break
            if ok:
                return True

    return False

# ---- Routes ----
@app.route('/')
def root():
    # Clear session and redirect to game page for fresh start
    session.clear()
    return redirect(url_for('game_page'))

@app.route('/game', methods=['GET', 'POST'])
def game_page():
    if request.method == 'POST':
        username = request.form.get('username', 'Guest').strip()
        if not username:
            username = 'Guest'
            
        board_size = int(request.form.get('board_size', 3))
        mode = request.form.get('mode', 'solo')
        room_code = request.form.get('room_code', '').strip()

        if mode == 'multiplayer' and not room_code:
            room_code = str(random.randint(1000, 9999))

        if mode == 'solo':
            room_code = None

        # Store in session
        session['username'] = username
        session['board_size'] = board_size
        session['mode'] = mode
        session['room_code'] = room_code

        # Save session for recovery
        if mode == 'multiplayer' and room_code:
            save_user_session(username, room_code, board_size, mode)

        return render_template(
            'game.html',
            username=username,
            board_size=board_size,
            mode=mode,
            room_code=room_code
        )
    
    # GET request - check if user has session
    username = session.get('username')
    board_size = session.get('board_size', 3)
    mode = session.get('mode', 'solo')
    room_code = session.get('room_code')
    
    # Check for saved session if no current session but username exists
    if not room_code and username and mode == 'multiplayer':
        saved_session = get_user_session(username)
        if saved_session:
            room_code = saved_session['room_code']
            board_size = saved_session['board_size']
            mode = saved_session['mode']
            session['room_code'] = room_code
            session['board_size'] = board_size
            session['mode'] = mode
    
    # If no session exists, show the login form
    return render_template(
        'game.html',
        username=username,
        board_size=board_size,
        mode=mode,
        room_code=room_code
    )

@app.route('/logout')
def logout():
    username = session.get('username')
    if username:
        clear_user_session(username)
    session.clear()
    return redirect(url_for('game_page'))

@app.route('/recover-session')
def recover_session():
    """API endpoint to recover user session"""
    username = request.args.get('username')
    if not username:
        return jsonify({'error': 'Username required'}), 400
    
    session_data = get_user_session(username)
    if session_data:
        return jsonify(session_data)
    else:
        return jsonify({'error': 'No saved session found'}), 404

# History endpoints (REST)
@app.route('/history', methods=['GET', 'POST'])
def history_endpoint():
    if request.method == 'GET':
        username = request.args.get('username')
        if not username:
            return jsonify([]), 200
        data = get_history_for_user(username)
        return jsonify(data), 200

    # POST: insert history entry
    try:
        payload = request.get_json()
        # validate minimal fields
        entry = {
            'username': payload.get('username'),
            'opponent': payload.get('opponent'),
            'mode': payload.get('mode'),
            'result': payload.get('result'),
            'board_size': int(payload.get('board_size', 3)),
            'date': payload.get('date') or datetime.datetime.utcnow().isoformat()
        }
        add_history_entry(entry)
        return jsonify({'status':'ok'}), 200
    except Exception as e:
        log_error("HISTORY_API_ERROR", "Failed to process history POST", str(e))
        return jsonify({'status':'error'}), 400

@app.route('/health')
def health_check():
    return {'status': 'healthy', 'timestamp': datetime.datetime.utcnow().isoformat()}, 200

# ---- Socket.IO events ----
@socketio.on('connect')
def handle_connect():
    try:
        print(f"Client connected: {request.sid}")
    except Exception as e:
        log_error("CONNECT_ERROR", "Error in connect handler", str(e))

@socketio.on('disconnect')
def handle_disconnect():
    try:
        print(f"Client disconnected: {request.sid}")
    except Exception as e:
        log_error("DISCONNECT_ERROR", "Error in disconnect handler", str(e))

@socketio.on('join')
def handle_join(data):
    """Handle player joining a room"""
    try:
        room = data.get('room')
        username = data.get('username') or 'Guest'
        size = int(data.get('board_size', 3) or 3)
        
        # Handle LOCAL room case
        if room is None or room == 'null' or room == '' or room == 'LOCAL':
            emit('joined_room', {'room': 'LOCAL'})
            return
        
        join_room(room)

        # Save session for recovery
        save_user_session(username, room, size, 'multiplayer')

        # create or update game state
        if room not in games:
            # initialize new game
            games[room] = {
                'board': new_empty_board(size),
                'players': [username],
                'turn': 'X',
                'powerups': { username: {'block': 1, 'clear': 1} },
                'size': size,
                'blocked': False,
                'blocked_player': None,
                'clear_mode': None,
                'new_game_requested_by': None
            }
            print(f"[room {room}] created by {username}")
        else:
            # add player if not present and if less than 2
            if username not in games[room]['players'] and len(games[room]['players']) < 2:
                games[room]['players'].append(username)
                games[room]['powerups'][username] = {'block': 1, 'clear': 1}
                print(f"[room {room}] {username} joined")
            else:
                # If already there or room full, ignore extra joins
                if username not in games[room]['players']:
                    print(f"[room {room}] join attempted but room full/occupied")
                    emit('join_error', {'message': 'Room is full'}, room=request.sid)
                    return

        emit('joined_room', {'room': room})
        # push initial game state to the room
        emit('game_update', games[room], room=room)
        
    except Exception as e:
        log_error("JOIN_ERROR", f"Error joining room {data.get('room')}", str(e))
        emit('join_error', {'message': 'Internal server error'}, room=request.sid)

@socketio.on('leave_room')
def handle_leave_room(data):
    """Handle player leaving room"""
    try:
        room = data.get('room')
        username = data.get('username')
        
        if room in games and room != 'LOCAL':
            leave_room(room)
            game = games[room]
            if username in game['players']:
                game['players'].remove(username)
                if username in game['powerups']:
                    del game['powerups'][username]
                
                print(f"[room {room}] {username} left")
                
                # If room becomes empty, clean it up
                if len(game['players']) == 0:
                    del games[room]
                    print(f"[room {room}] deleted (empty)")
                else:
                    # Notify remaining players
                    emit('game_message', {'message': f'{username} left the game'}, room=room)
                    emit('game_update', game, room=room)
            
            # Clear user session when they intentionally leave
            clear_user_session(username)
            
    except Exception as e:
        log_error("LEAVE_ROOM_ERROR", f"Error leaving room {data.get('room')}", str(e))

@socketio.on('make_move')
def handle_move(data):
    """Handle player making a move"""
    try:
        room = data.get('room')
        if room == 'LOCAL':
            return
            
        x = int(data.get('x'))
        y = int(data.get('y'))
        username = data.get('username')

        if room not in games:
            emit('game_message', {'message': 'Game room not found.'}, room=request.sid)
            return

        game = games[room]

        # require two players to actually play (server enforces)
        if len(game['players']) < 2:
            emit('game_update', game, room=room)
            return

        # validate bounds
        size = game['size']
        if not (0 <= x < size and 0 <= y < size):
            return

        # clear mode handling
        if game.get('clear_mode') == username:
            if game['board'][x][y] is not None:
                game['board'][x][y] = None
                game['clear_mode'] = None
                emit('game_message', {'message': f'{username} cleared a cell.'}, room=room)
                emit('game_update', game, room=room)
            else:
                game['clear_mode'] = None
                emit('game_message', {'message': f'{username} attempted to clear an empty cell.'}, room=room)
            return

        # block handling: if this user is blocked, skip their move and flip turn
        if game.get('blocked') and game.get('blocked_player') == username:
            game['blocked'] = False
            game['blocked_player'] = None
            # flip the turn to other player
            game['turn'] = 'O' if game['turn'] == 'X' else 'X'
            emit('game_message', {'message': f'{username} was blocked this turn.'}, room=room)
            emit('game_update', game, room=room)
            return

        current_turn = game['turn']
        # map current turn to expected player
        player_index = 0 if current_turn == 'X' else 1
        if player_index >= len(game['players']):
            # no player assigned for this symbol (shouldn't happen)
            emit('game_update', game, room=room)
            return
        expected_player = game['players'][player_index]
        if expected_player != username:
            return

        # place move if empty
        if game['board'][x][y] is None:
            game['board'][x][y] = current_turn
            
            # normal turn swap
            game['turn'] = 'O' if current_turn == 'X' else 'X'
            emit('game_update', game, room=room)
            

            # check win based on win length
            win_len = get_win_len(size)
            if check_winner(game['board'], current_turn, win_len):
                # update leaderboard & history
                winner = username
                # loser is the other player if present
                loser = None
                if len(game['players']) >= 2:
                    loser = game['players'][1] if game['players'][0] == username else game['players'][0]
                update_leaderboard(winner, 10)

                # save history for both players (if they exist)
                ts = datetime.datetime.utcnow().isoformat()
                add_history_entry({'username': winner, 'opponent': loser or 'opponent', 'mode': 'multiplayer', 'result': 'win', 'board_size': size, 'date': ts})
                if loser:
                    add_history_entry({'username': loser, 'opponent': winner, 'mode': 'multiplayer', 'result': 'loss', 'board_size': size, 'date': ts})

                emit('game_over', {'winner': winner, 'loser': loser, 'status': 'win'}, room=room)

                # reset board
                game['board'] = new_empty_board(size)
                game['turn'] = 'X'
                emit('game_update', game, room=room)
                return

            # check draw
            if is_board_full(game['board']):
                ts = datetime.datetime.utcnow().isoformat()
                # save draw history for all players
               
                add_history_entry({'username': game['players'][0], 'opponent': game['players'][1], 'mode': 'multiplayer', 'result': 'draw', 'board_size': size, 'date': ts})
                emit('game_over', {'winner': None, 'status': 'draw'}, room=room)
                
                # reset board
                game['board'] = new_empty_board(size)
                game['turn'] = 'X'
                emit('game_update', game, room=room)
                return
                
    except Exception as e:
        log_error("MOVE_ERROR", f"Error processing move in room {data.get('room')}", str(e))
        emit('game_message', {'message': 'Error processing move'}, room=request.sid)

if not os.path.exists('logs'):
    os.makedirs('logs')

# ---- Run ----
if __name__ == '__main__':
    print("Starting Flask + SocketIO server")
    port = int(os.environ.get('PORT', 5000))
    debug_mode = os.environ.get('DEBUG', 'False').lower() == 'true'
        
    print(f"Starting Flask + SocketIO server on port {port}")
    print(f"Debug mode: {debug_mode}")
    
    socketio.run(
        app, 
        host='0.0.0.0', 
        port=port, 
        debug=debug_mode,
        allow_unsafe_werkzeug=True
    )