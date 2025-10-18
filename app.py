from flask import Flask, render_template, request, session, redirect, url_for, jsonify
from flask_socketio import SocketIO, emit, join_room
import sqlite3
import random
import datetime

app = Flask(__name__)
app.config['SECRET_KEY'] = 'change-me-to-a-secure-random-value'
socketio = SocketIO(app, cors_allowed_origins="*")

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
        conn.commit()

init_db()

def add_history_entry(entry):
    # entry: dict with username, opponent, mode, result, board_size, date
    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()
        c.execute("""
            INSERT INTO history (username, opponent, mode, result, board_size, date)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (entry.get('username'), entry.get('opponent'), entry.get('mode'),
              entry.get('result'), entry.get('board_size'), entry.get('date')))
        conn.commit()

def get_history_for_user(username, limit=100):
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

def update_leaderboard(username, points=10):
    # give points and increment wins by 1 for a win
    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()
        # try insert; if exists update
        c.execute("""
            INSERT INTO leaderboard (username, score, wins)
            VALUES (?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
                score = score + excluded.score,
                wins = wins + 1
        """, (username, points,1))
        conn.commit()

# ---- Game utilities ----
def new_empty_board(n):
    return [[None for _ in range(n)] for _ in range(n)]


# ---- mapping ----
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
    session.clear()
    return redirect(url_for('game_page'))

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
        print("History POST error:", e)
        return jsonify({'status':'error'}), 400

# ---- Socket.IO events ----
@socketio.on('join_game')
def handle_join(data):
    """
    payload: { username, board_size, room }
    If room provided and exists -> join, else create new room code.
    """
    username = data.get('username') or 'Guest'
    size = int(data.get('board_size', 3) or 3)
    requested_room = data.get('room')
    room = None

    if requested_room is None or requested_room == 'null' or requested_room == '':
        emit('joined_room', {'room': 'LOCAL'})
        return
    elif requested_room == 'LOCAL':
        emit('joined_room', {'room': 'LOCAL'})
        return
    else:
        room = requested_room

    join_room(room)

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
            'new_game_requested_by': None  # Track who requested new game
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

    emit('joined_room', {'room': room})
    # push initial game state to the room
    emit('game_update', games[room], room=room)

@socketio.on('make_move')
def handle_move(data):
    """
    data: { room, x, y, username }
    """
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

        

@socketio.on('use_power_up')
def handle_powerup(data):
    """
    payload: { room, power_up, username }
    power_up in ('block','clear')
    """
    room = data.get('room')
    if room == 'LOCAL':
        return
        
    power = data.get('power_up')
    username = data.get('username')

    if room not in games:
        emit('power_up_error', {'message':'Room not found.'}, room=request.sid)
        return

    game = games[room]
    # ensure user has powerup dict
    if username not in game['powerups']:
        game['powerups'][username] = {'block': 0, 'clear': 0}
    have = game['powerups'][username].get(power, 0)
    if have <= 0:
        emit('power_up_error', {'message': 'No power-ups left!'}, room=request.sid)
        return

    # consume
    game['powerups'][username][power] -= 1

    if power == 'block':
        # block opponent
        # find opponent
        opponent = None
        if len(game['players']) >= 2:
            opponent = game['players'][1] if game['players'][0] == username else game['players'][0]
        if opponent:
            game['blocked'] = True
            game['blocked_player'] = opponent
            emit('game_message', {'message': f'{username} blocked {opponent}.'}, room=room)
    elif power == 'clear':
        # set clear mode for this user (next click clears)
        game['clear_mode'] = username
        emit('game_message', {'message': f'{username} activated clear mode.'}, room=room)
    else:
        emit('power_up_error', {'message':'Unknown power-up.'}, room=request.sid)
        return

    emit('game_update', game, room=room)

@socketio.on('request_new_game')
def handle_new_game_request(data):
    """
    Handle new game request - ask other player for confirmation
    """
    room = data.get('room')
    username = data.get('username')
    
    if room not in games or room == 'LOCAL':
        return
        
    game = games[room]
    
    # Set who requested the new game
    game['new_game_requested_by'] = username
    
    # Ask other player for confirmation
    emit('new_game_requested', {'requested_by': username}, room=room, skip_sid=request.sid)
    emit('game_message', {'message': f'{username} wants to start a new game. Waiting for confirmation...'}, room=room)

@socketio.on('confirm_new_game')
def handle_confirm_new_game(data):
    """
    Handle new game confirmation from both players
    """
    room = data.get('room')
    username = data.get('username')
    
    if room not in games or room == 'LOCAL':
        return
        
    game = games[room]
    
    # Reset the game board and power-ups
    size = game['size']
    game['board'] = new_empty_board(size)
    game['turn'] = 'X'
    game['blocked'] = False
    game['blocked_player'] = None
    game['clear_mode'] = None
    game['new_game_requested_by'] = None
    
    # Reset power-ups for all players
    for player in game['players']:
        game['powerups'][player] = {'block': 1, 'clear': 1}
    
    emit('game_update', game, room=room)
    emit('game_message', {'message': 'New game started! Power-ups have been reset.'}, room=room)

@socketio.on('cancel_new_game')
def handle_cancel_new_game(data):
    """
    Handle cancellation of new game request
    """
    room = data.get('room')
    username = data.get('username')
    
    if room not in games or room == 'LOCAL':
        return
        
    game = games[room]
    game['new_game_requested_by'] = None
    
    emit('game_message', {'message': f'{username} cancelled the new game request.'}, room=room)

@socketio.on('chat_message')
def handle_chat(data):
    room = data.get('room')
    if room == 'LOCAL':
        return
        
    username = data.get('username')
    message = data.get('message')
    msg = {'username': username, 'message': message}
    emit('chat_update', msg, room=room)
    print(f"[chat][{room}] {username}: {message}")

# ---- Run ----
if __name__ == '__main__':
    print("Starting Flask + SocketIO server on http://127.0.0.1:5000")
    socketio.run(app, host='127.0.0.1', port=5000, debug=True)