import os
import random
import time
import threading
import socket as _socket
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room
from flask_sqlalchemy import SQLAlchemy
from datetime import datetime

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'bmb_secret_key_change_me_in_production')

# Support both SQLite (local) and PostgreSQL (Render / any hosted DB).
# Render supplies DATABASE_URL starting with "postgres://"; SQLAlchemy needs "postgresql://".
# Use /tmp for SQLite on hosted servers — guaranteed writable on any Linux host.
_default_db = 'sqlite:///' + os.path.join('/tmp', 'game.db')
_db_url = os.environ.get('DATABASE_URL', _default_db)
if _db_url.startswith('postgres://'):
    _db_url = _db_url.replace('postgres://', 'postgresql://', 1)
app.config['SQLALCHEMY_DATABASE_URI'] = _db_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

# ─── Constants ────────────────────────────────────────────────────────────────
SUITS = {'Hearts': '♥', 'Diamonds': '♦', 'Clubs': '♣', 'Spades': '♠'}
SUIT_COLORS = {'Hearts': 'red', 'Diamonds': 'red', 'Clubs': 'black', 'Spades': 'black'}
CARD_VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
CARD_NUMERIC = {v: i + 1 for i, v in enumerate(CARD_VALUES)}
POSITION_NAMES = ['Lowest', '2nd Lowest', 'Middle', '2nd Highest', 'Highest']
MAX_PLAYERS = 5
GAME_ROOM = 'game_room'

# ─── Database Models ──────────────────────────────────────────────────────────
class PlayerProfile(db.Model):
    __tablename__ = 'player_profiles'
    id            = db.Column(db.Integer, primary_key=True)
    username      = db.Column(db.String(50), unique=True, nullable=False)
    games_played  = db.Column(db.Integer, default=0)
    wins          = db.Column(db.Integer, default=0)
    total_guesses = db.Column(db.Integer, default=0)
    correct_both  = db.Column(db.Integer, default=0)   # position AND card both correct
    total_card_dist = db.Column(db.Float, default=0.0) # sum of |guessed - actual| card values
    best_game_correct = db.Column(db.Integer, default=0)  # highest correct count in one game
    created_at    = db.Column(db.DateTime, default=datetime.utcnow)

    def to_stats(self):
        n = self.total_guesses
        return {
            'username':      self.username,
            'games_played':  self.games_played,
            'wins':          self.wins,
            'correct_pct':   round(self.correct_both / n * 100, 1) if n else 0,
            'incorrect_pct': round((n - self.correct_both) / n * 100, 1) if n else 0,
            'avg_distance':  round(self.total_card_dist / n, 2) if n else 0,
            'best_game':     self.best_game_correct,
        }

# ─── In-Memory Game State ─────────────────────────────────────────────────────
class GameState:
    def __init__(self):
        self.reset()

    def reset(self):
        self.phase        = 'lobby'    # lobby | countdown | playing | final_round | results
        self.players      = {}         # sid -> {username, ready}
        self.player_order = []         # ordered list of usernames (join order = clockwise)
        self.bots         = set()      # usernames that are bots (no real socket)
        self.cards        = {}         # username -> {value, numeric}
        self.suit         = None
        self.round_num    = 0          # 0 = round 1, 1 = round 2, 2 = final round
        self.starting_idx = 0          # index in player_order who starts the current round
        self.turn_offset  = 0          # how many turns have completed in current round
        self.final_guesses = {}        # username -> {position, card_numeric}
        self.last_results  = None

    # ── Lookups ──────────────────────────────────────────────────────────────
    def sid_of(self, username):
        for sid, p in self.players.items():
            if p['username'] == username:
                return sid
        return None

    def username_of(self, sid):
        return self.players.get(sid, {}).get('username')

    def current_player(self):
        if not self.player_order:
            return None
        idx = (self.starting_idx + self.turn_offset) % len(self.player_order)
        return self.player_order[idx]

    def positions(self):
        """Returns {username: 0-4} where 0=lowest card."""
        sorted_p = sorted(self.cards.items(), key=lambda x: x[1]['numeric'])
        return {u: i for i, (u, _) in enumerate(sorted_p)}

    def players_list(self):
        return [{'username': p['username'], 'ready': p['ready'],
                 'is_bot': p['username'] in self.bots}
                for p in self.players.values()]

    @property
    def all_ready(self):
        return (len(self.players) == MAX_PLAYERS
                and all(p['ready'] for p in self.players.values()))

    @property
    def count(self):
        return len(self.players)

G    = GameState()
_lock = threading.Lock()   # protects G from concurrent socket-event handlers

# ─── HTTP Routes ──────────────────────────────────────────────────────────────
@app.route('/health')
def health():
    """Used by Render (and other hosts) to confirm the service is alive."""
    return 'OK', 200

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/profile/<username>')
def api_get_profile(username):
    p = PlayerProfile.query.filter_by(username=username.strip()).first()
    return jsonify({'found': bool(p), 'stats': p.to_stats() if p else None})

@app.route('/api/profile', methods=['POST'])
def api_create_profile():
    data = request.get_json() or {}
    username = data.get('username', '').strip()
    if not username or len(username) < 2 or len(username) > 20:
        return jsonify({'error': 'Username must be 2–20 characters.'}), 400
    p = PlayerProfile.query.filter_by(username=username).first()
    if not p:
        p = PlayerProfile(username=username)
        db.session.add(p)
        db.session.commit()
    return jsonify({'found': True, 'stats': p.to_stats()})

# ─── Socket: Connection ────────────────────────────────────────────────────────
@socketio.on('connect')
def on_connect():
    emit('state_snapshot', {
        'phase':   G.phase,
        'players': G.players_list(),
        'suit':    G.suit,
        'count':   G.count,
    })

@socketio.on('disconnect')
def on_disconnect():
    with _lock:
        if request.sid not in G.players:
            return
        username = G.players.pop(request.sid)['username']
        was_mid_game = G.phase in ('playing', 'final_round')
        if username in G.player_order:
            G.player_order.remove(username)

    socketio.emit('player_left', {
        'username': username,
        'players':  G.players_list(),
    }, room=GAME_ROOM)

    if was_mid_game:
        with _lock:
            saved       = {sid: {'username': d['username'], 'ready': False}
                           for sid, d in G.players.items()}
            saved_order = list(G.player_order)
            G.reset()
            G.players      = saved
            G.player_order = saved_order
        socketio.emit('game_aborted', {
            'reason': f'{username} disconnected mid-game.',
        }, room=GAME_ROOM)

# ─── Socket: Lobby ────────────────────────────────────────────────────────────
@socketio.on('join_game')
def on_join(data):
    username = (data.get('username') or '').strip()
    if not username:
        return emit('error', {'msg': 'Invalid username.'})
    with _lock:
        if G.phase != 'lobby':
            return emit('error', {'msg': 'A game is already in progress.'})
        existing_sid = G.sid_of(username)
        if existing_sid and existing_sid != request.sid:
            return emit('error', {'msg': 'That username is already taken in this session.'})
        if G.count >= MAX_PLAYERS and request.sid not in G.players:
            return emit('error', {'msg': 'Lobby is full (5 players max).'})
        G.players[request.sid] = {'username': username, 'ready': False}
        if username not in G.player_order:
            G.player_order.append(username)
    join_room(GAME_ROOM)

    emit('joined', {
        'username': username,
        'players':  G.players_list(),
        'suit':     G.suit,
        'suit_symbol': SUITS.get(G.suit),
        'suit_color':  SUIT_COLORS.get(G.suit),
    })
    socketio.emit('player_joined', {
        'username': username,
        'players':  G.players_list(),
    }, room=GAME_ROOM)

@socketio.on('select_suit')
def on_suit(data):
    suit = data.get('suit')
    if suit not in SUITS:
        return emit('error', {'msg': 'Invalid suit.'})
    with _lock:
        if G.phase != 'lobby':
            return
        G.suit = suit
    socketio.emit('suit_selected', {
        'suit':   suit,
        'symbol': SUITS[suit],
        'color':  SUIT_COLORS[suit],
    }, room=GAME_ROOM)

@socketio.on('player_ready')
def on_ready():
    with _lock:
        if G.phase != 'lobby' or request.sid not in G.players:
            return
        if not G.suit:
            return emit('error', {'msg': 'Please select a suit first.'})
        G.players[request.sid]['ready'] = True
        username  = G.players[request.sid]['username']
        start_now = G.all_ready
    socketio.emit('player_readied', {
        'username': username,
        'players':  G.players_list(),
    }, room=GAME_ROOM)
    if start_now:
        socketio.start_background_task(_run_countdown)

@socketio.on('add_bot')
def on_add_bot():
    with _lock:
        if G.phase != 'lobby':
            return emit('error', {'msg': 'Can only add bots in the lobby.'})
        if G.count >= MAX_PLAYERS:
            return emit('error', {'msg': 'Lobby is full (5 players max).'})
        existing_names = {p['username'] for p in G.players.values()}
        bot_name = None
        for i in range(1, 10):
            candidate = f'Bot{i}'
            if candidate not in existing_names:
                bot_name = candidate
                break
        if bot_name is None:
            return emit('error', {'msg': 'Could not create a bot.'})
        bot_sid = f'__bot__{bot_name}'
        G.players[bot_sid] = {'username': bot_name, 'ready': True}
        G.player_order.append(bot_name)
        G.bots.add(bot_name)
        start_now = G.suit and G.all_ready
    socketio.emit('player_joined', {
        'username': bot_name,
        'players':  G.players_list(),
        'is_bot':   True,
    }, room=GAME_ROOM)
    if start_now:
        socketio.start_background_task(_run_countdown)

@socketio.on('remove_bots')
def on_remove_bots():
    with _lock:
        if G.phase != 'lobby':
            return emit('error', {'msg': 'Can only remove bots in the lobby.'})
        bot_sids = [sid for sid, p in G.players.items() if p['username'] in G.bots]
        for sid in bot_sids:
            username = G.players[sid]['username']
            if username in G.player_order:
                G.player_order.remove(username)
            del G.players[sid]
        G.bots.clear()
    socketio.emit('bots_removed', {'players': G.players_list()}, room=GAME_ROOM)

# ─── Background: Countdown → Deal → Game ──────────────────────────────────────
def _run_countdown():
    with app.app_context():
        G.phase = 'countdown'
        socketio.emit('countdown_start', {}, room=GAME_ROOM)

        for i in range(5, 0, -1):
            socketio.emit('countdown_tick', {'n': i}, room=GAME_ROOM)
            time.sleep(1)

        # Deal 5 random cards from the chosen suit
        deck = random.sample(CARD_VALUES, MAX_PLAYERS)
        G.cards = {
            u: {'value': v, 'numeric': CARD_NUMERIC[v]}
            for u, v in zip(G.player_order, deck)
        }

        G.phase        = 'playing'
        G.round_num    = 0
        G.starting_idx = 0
        G.turn_offset  = 0

        # Send each player their own card (they cannot see it themselves)
        for sid, pdata in list(G.players.items()):
            un      = pdata['username']
            my_card = G.cards[un]
            # Include all players' info so client knows who sits where
            others = {
                u: {'value': c['value']}
                for u, c in G.cards.items() if u != un
            }
            socketio.emit('show_card', {
                'value':        my_card['value'],
                'numeric':      my_card['numeric'],
                'suit':         G.suit,
                'symbol':       SUITS[G.suit],
                'color':        SUIT_COLORS[G.suit],
                'others':       others,
                'player_order': G.player_order,
            }, room=sid)

        time.sleep(1)
        _announce_turn()

def _announce_turn():
    """Emit turn_started to all, your_turn to the current human, or schedule a bot action."""
    current = G.current_player()
    if not current:
        return
    is_final = (G.phase == 'final_round')
    is_bot   = current in G.bots

    socketio.emit('turn_started', {
        'player':        current,
        'round':         G.round_num + 1,
        'turn_num':      G.turn_offset + 1,
        'total_players': len(G.player_order),
        'is_final':      is_final,
    }, room=GAME_ROOM)

    if is_bot:
        if is_final:
            socketio.start_background_task(_bot_final_guess, current)
        else:
            socketio.start_background_task(_bot_playing_turn, current)
    else:
        sid = G.sid_of(current)
        if sid:
            socketio.emit('your_turn', {
                'round':    G.round_num + 1,
                'is_final': is_final,
            }, room=sid)

# ─── Socket: Playing Rounds (1 & 2) ──────────────────────────────────────────
@socketio.on('turn_complete')
def on_turn_complete():
    with _lock:
        if G.phase != 'playing':
            return
        username = G.username_of(request.sid)
        if username != G.current_player():
            return  # silently ignore — not their turn

        emit('tilt_confirmed', {})
        G.turn_offset += 1
        round_done    = G.turn_offset >= len(G.player_order)
        next_round_num = None
        next_starter   = None
        start_final    = False
        starter_sid    = None

        if round_done:
            G.round_num   += 1
            G.starting_idx = (G.starting_idx + 1) % len(G.player_order)
            G.turn_offset  = 0
            if G.round_num < 2:
                next_round_num = G.round_num + 1
                next_starter   = G.current_player()
            else:
                start_final = True
                G.phase     = 'final_round'
                starter     = G.current_player()
                starter_sid = G.sid_of(starter)

    socketio.emit('turn_ended', {'player': username}, room=GAME_ROOM)

    if round_done:
        if not start_final:
            socketio.emit('next_round', {
                'round':   next_round_num,
                'starter': next_starter,
            }, room=GAME_ROOM)
            socketio.start_background_task(_delayed_turn, 1.5)
        else:
            socketio.emit('final_round_start', {'starter': starter}, room=GAME_ROOM)
            if starter_sid:
                socketio.emit('red_buzz', {}, room=starter_sid)
            socketio.start_background_task(_launch_final_round)
    else:
        socketio.start_background_task(_delayed_turn, 0.5)

def _delayed_turn(delay):
    with app.app_context():
        time.sleep(delay)
        _announce_turn()

# ─── Bot Actions ──────────────────────────────────────────────────────────────
def _bot_playing_turn(username):
    """Bot waits a moment then signals its turn is done (like a human tilting)."""
    with app.app_context():
        time.sleep(random.uniform(1.5, 3.0))
        with _lock:
            if G.phase != 'playing' or G.current_player() != username:
                return
            G.turn_offset += 1
            round_done     = G.turn_offset >= len(G.player_order)
            start_final    = False
            starter        = None
            starter_sid    = None
            next_round_num = None
            next_starter   = None
            if round_done:
                G.round_num   += 1
                G.starting_idx = (G.starting_idx + 1) % len(G.player_order)
                G.turn_offset  = 0
                if G.round_num < 2:
                    next_round_num = G.round_num + 1
                    next_starter   = G.current_player()
                else:
                    start_final = True
                    G.phase     = 'final_round'
                    starter     = G.current_player()
                    starter_sid = G.sid_of(starter) if starter not in G.bots else None

        socketio.emit('turn_ended', {'player': username}, room=GAME_ROOM)
        if round_done:
            if not start_final:
                socketio.emit('next_round', {'round': next_round_num, 'starter': next_starter}, room=GAME_ROOM)
                socketio.start_background_task(_delayed_turn, 1.5)
            else:
                socketio.emit('final_round_start', {'starter': starter}, room=GAME_ROOM)
                if starter_sid:
                    socketio.emit('red_buzz', {}, room=starter_sid)
                socketio.start_background_task(_launch_final_round)
        else:
            socketio.start_background_task(_delayed_turn, 0.5)

def _bot_final_guess(username):
    """Bot waits a moment then submits a random final guess."""
    with app.app_context():
        time.sleep(random.uniform(2.0, 4.0))
        with _lock:
            if G.phase != 'final_round' or G.current_player() != username:
                return
            if username in G.final_guesses:
                return
            G.final_guesses[username] = {
                'position':     random.randint(0, 4),
                'card_numeric': random.randint(1, 13),
            }
            G.turn_offset += 1
            all_done = len(G.final_guesses) == len(G.player_order)
            count    = len(G.final_guesses)
            total    = len(G.player_order)

        socketio.emit('guess_submitted', {'username': username, 'count': count, 'total': total}, room=GAME_ROOM)
        if all_done:
            socketio.start_background_task(_finish_game)
        else:
            socketio.start_background_task(_delayed_final_turn)

def _launch_final_round():
    with app.app_context():
        time.sleep(2.5)
        socketio.emit('prompt_final_guess', {}, room=GAME_ROOM)
        time.sleep(0.5)
        _announce_turn()

# ─── Socket: Final Round ──────────────────────────────────────────────────────
@socketio.on('submit_final_guess')
def on_final_guess(data):
    position     = data.get('position')
    card_numeric = data.get('card_numeric')
    if position is None or card_numeric is None:
        return emit('error', {'msg': 'Incomplete guess — select both position and card.'})

    with _lock:
        if G.phase != 'final_round':
            return
        username = G.username_of(request.sid)
        if not username or username in G.final_guesses:
            return
        if username != G.current_player():
            return emit('error', {'msg': "It's not your turn yet."})
        G.final_guesses[username] = {
            'position':     int(position),
            'card_numeric': int(card_numeric),
        }
        G.turn_offset += 1
        all_done = len(G.final_guesses) == len(G.player_order)
        count    = len(G.final_guesses)
        total    = len(G.player_order)

    emit('guess_ack', {})
    socketio.emit('guess_submitted', {
        'username': username,
        'count':    count,
        'total':    total,
    }, room=GAME_ROOM)

    if all_done:
        socketio.start_background_task(_finish_game)
    else:
        socketio.start_background_task(_delayed_final_turn)

def _delayed_final_turn():
    with app.app_context():
        time.sleep(1.0)
        _announce_turn()

def _finish_game():
    with app.app_context():
        time.sleep(0.5)
        _resolve_game()

# ─── Game Resolution ──────────────────────────────────────────────────────────
def _resolve_game():
    G.phase   = 'results'
    positions = G.positions()

    player_results = []
    won = True

    for username in G.player_order:
        card       = G.cards[username]
        actual_pos = positions[username]
        guess      = G.final_guesses.get(username, {})
        g_pos      = guess.get('position')
        g_card_num = guess.get('card_numeric')

        pos_ok  = (g_pos == actual_pos)
        card_ok = (g_card_num == card['numeric'])
        both_ok = pos_ok and card_ok
        if not both_ok:
            won = False

        dist          = abs(g_card_num - card['numeric']) if g_card_num is not None else 13
        g_card_val    = CARD_VALUES[g_card_num - 1] if g_card_num and 1 <= g_card_num <= 13 else '?'
        g_pos_name    = POSITION_NAMES[g_pos] if g_pos is not None else '?'

        player_results.append({
            'username':             username,
            'actual_card':          card['value'],
            'actual_numeric':       card['numeric'],
            'actual_position':      actual_pos,
            'actual_position_name': POSITION_NAMES[actual_pos],
            'guessed_position':     g_pos,
            'guessed_position_name': g_pos_name,
            'guessed_card':         g_card_val,
            'guessed_numeric':      g_card_num,
            'position_correct':     pos_ok,
            'card_correct':         card_ok,
            'both_correct':         both_ok,
            'card_distance':        dist,
            'suit':                 G.suit,
            'symbol':               SUITS.get(G.suit, ''),
            'color':                SUIT_COLORS.get(G.suit, 'black'),
        })

    results = {
        'won':          won,
        'suit':         G.suit,
        'symbol':       SUITS.get(G.suit, ''),
        'player_order': G.player_order,
        'players':      player_results,
    }
    G.last_results = results
    _update_stats(results)
    socketio.emit('game_results', results, room=GAME_ROOM)

def _update_stats(results):
    correct_count = sum(1 for p in results['players'] if p['both_correct'])
    for pr in results['players']:
        if pr['username'] in G.bots:
            continue
        profile = PlayerProfile.query.filter_by(username=pr['username']).first()
        if not profile:
            profile = PlayerProfile(username=pr['username'])
            db.session.add(profile)
        profile.games_played  += 1
        profile.total_guesses += 1
        if results['won']:
            profile.wins += 1
        if pr['both_correct']:
            profile.correct_both += 1
        profile.total_card_dist += pr['card_distance']
        if correct_count > profile.best_game_correct:
            profile.best_game_correct = correct_count
    db.session.commit()

# ─── Socket: Play Again ────────────────────────────────────────────────────────
@socketio.on('play_again')
def on_play_again():
    with _lock:
        if G.phase != 'results':
            return
        saved_bots  = set(G.bots)
        # Bots stay ready; humans reset to not-ready
        saved       = {sid: {'username': d['username'],
                             'ready': d['username'] in saved_bots}
                       for sid, d in G.players.items()}
        saved_order = list(G.player_order)
        G.reset()
        G.players      = saved
        G.player_order = saved_order
        G.bots         = saved_bots
    socketio.emit('return_to_lobby', {'players': G.players_list()}, room=GAME_ROOM)

# ─── Entry Point ──────────────────────────────────────────────────────────────

# Create tables on startup regardless of how the process is launched
# (covers both `python app.py` locally and Render's gunicorn/uvicorn entrypoint).
with app.app_context():
    db.create_all()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))

    try:
        local_ip = _socket.gethostbyname(_socket.gethostname())
    except Exception:
        local_ip = '127.0.0.1'

    print()
    print('=' * 52)
    print("  Blind Man's Bluff — Server Running")
    print(f"  Local:   http://localhost:{port}")
    print(f"  Network: http://{local_ip}:{port}")
    print()
    print("  Share the Network URL with all players.")
    print('=' * 52)
    print()

    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
