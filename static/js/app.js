'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────
const CARD_VALUES   = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const CARD_DISPLAY  = { A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King' };
const CARD_NUMERIC  = Object.fromEntries(CARD_VALUES.map((v,i) => [v, i+1]));
const POSITION_NAMES = ['Lowest', '2nd Lowest', 'Middle', '2nd Highest', 'Highest'];

// ─── Application State ─────────────────────────────────────────────────────
const S = {
  username:      null,
  players:       [],
  suit:          null,
  suitSymbol:    null,
  suitColor:     null,
  myCard:        null,
  myTurn:        false,
  isFinalRound:  false,
  currentPlayer: null,
  results:       null,
  guessPosition: null,
  guessCard:     null,
  guessSubmitted: false,
};

// Motion-sensor sub-state
const mot = {
  enabled:          false,
  listenerAdded:    false,  // prevent adding listener twice
  wasStable:        false,
  stableTimer:      null,
  cooldown:         false,
  listening:        false,
};

// Final-round voice state
const finalVoice = {
  recording:   false,
  submitOnEnd: false,  // submit when speechRec fires onend
  position:    null,
  cardNum:     null,
  transcript:  '',
};

// Whether the user has pre-armed mic permission via the lobby button
let micArmed = false;

// ─── Socket ─────────────────────────────────────────────────────────────────
const socket = io();

// ─────────────────────────────────────────────────────────────────────────────
//  SOCKET EVENTS  (server → client)
// ─────────────────────────────────────────────────────────────────────────────

socket.on('state_snapshot', (data) => {
  // If a game is already running when we connect, show a notice on login screen
  if (data.phase !== 'lobby') {
    showToast('A game is in progress. You may join the next round.', 'warning');
  }
});

socket.on('error', (data) => {
  showToast(data.msg || 'An error occurred.', 'error');
  // Re-enable login button if we were in login flow
  const loginBtn = document.getElementById('login-btn');
  if (loginBtn) loginBtn.disabled = false;
});

// ── Lobby ──────────────────────────────────────────────────────────────────
socket.on('joined', (data) => {
  S.username = data.username;
  S.players  = data.players;
  if (data.suit) {
    S.suit       = data.suit;
    S.suitSymbol = data.suit_symbol;
    S.suitColor  = data.suit_color;
  }
  renderLobbyPlayers();
  updateSuitDisplay();
  showScreen('s-lobby');
});

socket.on('player_joined', (data) => {
  S.players = data.players;
  renderLobbyPlayers();
  if (data.username) {
    showToast(data.is_bot ? `${data.username} (bot) added.` : `${data.username} joined.`, 'info');
  }
});

socket.on('player_left', (data) => {
  S.players = data.players;
  renderLobbyPlayers();
  showToast(`${data.username} left.`, 'warning');
});

socket.on('player_readied', (data) => {
  S.players = data.players;
  renderLobbyPlayers();
  updateLobbyStatus();
});

socket.on('bots_removed', (data) => {
  S.players = data.players;
  renderLobbyPlayers();
  showToast('Bots removed.', 'info');
});

socket.on('suit_selected', (data) => {
  S.suit       = data.suit;
  S.suitSymbol = data.symbol;
  S.suitColor  = data.color;
  updateSuitDisplay();
  const readyBtn = document.getElementById('ready-btn');
  readyBtn.disabled = false;
});

// ── Countdown ──────────────────────────────────────────────────────────────
socket.on('countdown_start', () => {
  showScreen('s-countdown');
  document.getElementById('countdown-msg').textContent =
    'Place your phone on your forehead!';
});

socket.on('countdown_tick', (data) => {
  const el = document.getElementById('countdown-number');
  el.textContent = data.n;
  // Restart animation so each number pops
  el.style.animation = 'none';
  el.offsetHeight; // reflow
  el.style.animation = '';
});

// ── Game / Card Display ────────────────────────────────────────────────────
socket.on('show_card', (data) => {
  S.myCard = data;
  renderGameCard(data);
  showScreen('s-game');
  syncCardAreaOffset();   // ensure no stale overlay-active class at game start
  // Start monitoring motion (enables tilt-to-signal)
  activateMotionMonitor();
});

socket.on('turn_started', (data) => {
  S.currentPlayer = data.player;
  S.myTurn        = (data.player === S.username);
  S.isFinalRound  = data.is_final || false;
  updateTurnIndicator(data);
  if (!S.myTurn) {
    hideTurnBanner();
    if (S.isFinalRound) {
      updateFinalOverlay('watching');
    }
  }
});

socket.on('your_turn', (data) => {
  S.myTurn = true;
  if (data.is_final) {
    flashScreen('green', 600);
    startFinalRoundTurn();
  } else {
    flashScreen('green', 600);
    vibrateGreen();
    showTurnBanner();
    mot.wasStable = false;
    mot.cooldown  = false;
  }
});

socket.on('turn_ended', (data) => {
  if (data.player === S.username) {
    hideTurnBanner();
    S.myTurn = false;
  }
});

socket.on('tilt_confirmed', () => {
  // Brief blue flash confirms we detected the tilt
  flashScreen('blue', 250);
  vibrateShort();
});

socket.on('next_round', (data) => {
  showToast(`Round ${data.round} begins — ${data.starter} goes first`, 'info');
});

// ── Final Round ────────────────────────────────────────────────────────────
socket.on('final_round_start', (data) => {
  S.isFinalRound = true;
  showRoundAnnounce('FINAL ROUND', `${data.starter} goes first`);
});

socket.on('red_buzz', () => {
  flashScreen('red', 1400);
  vibrateRed();
});

socket.on('prompt_final_guess', () => {
  // Stay on game screen — show the final-round overlay at the bottom
  updateFinalOverlay('watching');
});

socket.on('guess_submitted', (data) => {
  const prog = document.getElementById('guess-progress');
  if (prog) prog.textContent = `${data.count} / ${data.total} guesses in`;
  // Update hint text when watching others guess
  if (!S.myTurn) {
    const hintEl = document.getElementById('fro-hint');
    if (hintEl) hintEl.textContent =
      `${data.count} / ${data.total} guesses in — waiting for ${S.currentPlayer}…`;
  }
});

socket.on('guess_ack', () => {
  S.guessSubmitted = true;
  document.getElementById('guess-submitted-msg').classList.remove('hidden');
  document.getElementById('final-guess-form').classList.add('disabled');
  document.getElementById('confirm-guess-btn').disabled = true;
  showToast('Guess locked in!', 'success');
});

// ── Results ────────────────────────────────────────────────────────────────
socket.on('game_results', (results) => {
  S.results = results;
  mot.listening = false;
  document.getElementById('final-round-overlay').classList.add('hidden');
  renderResults(results);
  showScreen('s-results');
});

// ── Play Again / Abort ─────────────────────────────────────────────────────
socket.on('return_to_lobby', (data) => {
  S.players      = data.players;
  S.isFinalRound = false;
  S.myTurn       = false;
  S.suit         = null;
  S.suitSymbol   = null;
  S.suitColor    = null;
  S.myCard       = null;
  S.guessSubmitted = false;
  mot.listening  = false;
  document.getElementById('final-round-overlay').classList.add('hidden');

  resetLobby();
  renderLobbyPlayers();
  showScreen('s-lobby');
});

socket.on('game_aborted', (data) => {
  mot.listening = false;
  S.isFinalRound = false;
  S.myTurn       = false;
  document.getElementById('final-round-overlay').classList.add('hidden');
  showToast(data.reason, 'error');
  resetLobby();
  showScreen('s-lobby');
});

// ─────────────────────────────────────────────────────────────────────────────
//  SCREEN MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function flashScreen(colour, durationMs = 500) {
  const overlay = document.getElementById('flash');
  const palette = {
    green: 'rgba(63,185,80,0.72)',
    red:   'rgba(248,81,73,0.75)',
    blue:  'rgba(88,166,255,0.60)',
  };
  overlay.style.transition = 'none';
  overlay.style.background = palette[colour] || colour;
  overlay.style.opacity = '1';
  // Force reflow, then fade out
  overlay.offsetHeight;
  overlay.style.transition = `opacity ${durationMs}ms ease`;
  overlay.style.opacity = '0';
}

// ─────────────────────────────────────────────────────────────────────────────
//  VIBRATION
// ─────────────────────────────────────────────────────────────────────────────

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}
function vibrateGreen() { vibrate([80, 40, 120]); }
function vibrateRed()   { vibrate([300, 100, 300]); }
function vibrateShort() { vibrate([60]); }

// ─────────────────────────────────────────────────────────────────────────────
//  MOTION / TILT DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask for DeviceMotion permission (required on iOS 13+) then set up listeners.
 * Called once when the card is first shown.
 */
function _addMotionListener() {
  if (mot.listenerAdded) return;
  mot.listenerAdded = true;
  mot.enabled = true;
  window.addEventListener('devicemotion', onDeviceMotion, { passive: true });
  setMotionStatus('Motion: active');
}

async function activateMotionMonitor() {
  mot.listening = true;
  if (typeof DeviceMotionEvent === 'undefined') {
    setMotionStatus('Motion sensor unavailable — use button');
    return;
  }
  if (mot.enabled) return; // already set up via lobby button
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    // iOS 13+: try checking existing permission state (non-gesture context)
    try {
      const perm = await DeviceMotionEvent.requestPermission();
      if (perm === 'granted') {
        _addMotionListener();
      } else {
        setMotionStatus('Motion denied — use button');
      }
    } catch (_) {
      // requestPermission failed outside a user gesture — already handled by lobby button
      setMotionStatus('Motion: tap lobby button');
    }
  } else {
    _addMotionListener();
  }
}

async function requestMotionPermissionExplicit() {
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceMotionEvent.requestPermission();
      if (perm === 'granted') {
        _addMotionListener();
        showToast('Motion sensor enabled!', 'success');
        document.getElementById('motion-perm-btn').classList.add('hidden');
      } else {
        showToast('Motion permission denied — use the Done button.', 'warning');
      }
    } catch (e) {
      showToast('Could not request permission.', 'error');
    }
  } else {
    _addMotionListener();
    showToast('Motion active!', 'success');
    document.getElementById('motion-perm-btn').classList.add('hidden');
  }
}

/**
 * Algorithm:
 *   - Track whether the phone has been still (all rotation axes < 25 °/s)
 *     for at least 800 ms → "wasStable" = true.
 *   - If a sudden burst ≥ 120 °/s appears after a stable window, fire the tilt.
 *   - Head-turning typically stays < 60 °/s; deliberate fast wrist motion > 150 °/s.
 *   - A 3-second cooldown prevents double-fires.
 */
function onDeviceMotion(e) {
  if (!mot.enabled || !mot.listening || !S.myTurn) return;
  if (mot.cooldown) return;

  const rr = e.rotationRate;
  if (!rr || rr.alpha === null) return;

  const alpha = rr.alpha || 0;  // spin around Z-axis (perpendicular to screen)
  const beta  = rr.beta  || 0;  // forward/back tilt
  const gamma = rr.gamma || 0;  // left/right tilt

  // Total movement for stability check
  const totalMove = Math.sqrt(alpha * alpha + beta * beta + gamma * gamma);

  // "Head movement" axes — if these are high while alpha is high,
  // it's a head turn/nod, not a deliberate phone flick
  const headAxes = Math.sqrt(beta * beta + gamma * gamma);

  // A deliberate CCW wrist flick spins mostly on alpha (Z-axis) with
  // very little beta/gamma. Head turns produce significant beta/gamma
  // even when alpha is also moving.
  const STABLE_THRESHOLD  = 25;   // °/s total — phone genuinely still
  const SPIN_THRESHOLD    = 140;  // °/s alpha — fast deliberate spin
  const HEAD_AXIS_MAX     = 50;   // °/s — max allowed beta/gamma during spin
                                   //  (head turns always exceed this)

  if (totalMove < STABLE_THRESHOLD) {
    if (!mot.stableTimer) {
      mot.stableTimer = setTimeout(() => {
        mot.wasStable = true;
        mot.stableTimer = null;
        setMotionStatus('Motion: ready ✓');
      }, 500);
    }
  } else {
    clearTimeout(mot.stableTimer);
    mot.stableTimer = null;

    const isPureFlick = Math.abs(alpha) >= SPIN_THRESHOLD && headAxes < HEAD_AXIS_MAX;

    if (isPureFlick && mot.wasStable) {
      mot.wasStable = false;
      mot.cooldown  = true;
      const cooldownMs = S.isFinalRound ? 1800 : 2500;
      setTimeout(() => { mot.cooldown = false; }, cooldownMs);
      setMotionStatus('Motion: fired');

      // Final round uses tap buttons only — tilt only ends regular turns
      if (!S.isFinalRound) {
        socket.emit('turn_complete');
      }
    } else if (Math.abs(alpha) >= SPIN_THRESHOLD && !mot.wasStable) {
      setMotionStatus('Hold still first…');
    }
  }
}

function setMotionStatus(msg) {
  const el = document.getElementById('motion-status');
  if (el) el.textContent = msg;
}

// ─────────────────────────────────────────────────────────────────────────────
//  DING SOUND
// ─────────────────────────────────────────────────────────────────────────────

function _playTone(freqStart, freqEnd, duration, volume) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freqStart, ctx.currentTime);
    if (freqEnd !== freqStart)
      osc.frequency.exponentialRampToValueAtTime(freqEnd, ctx.currentTime + duration * 0.6);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (_) {}
}
// Your-turn announcement: C6 → A5 → C6 (warm, inviting)
function playDing() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1046, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880,  ctx.currentTime + 0.15);
    osc.frequency.exponentialRampToValueAtTime(1046, ctx.currentTime + 0.35);
    gain.gain.setValueAtTime(0.55, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.7);
  } catch (_) {}
}
// Recording-start: rising short beep
function playBeepUp()   { _playTone(700, 1100, 0.25, 0.5); }
// Recording-stop / submit: falling short beep
function playBeepDown() { _playTone(1100, 600, 0.3, 0.45); }

// ─────────────────────────────────────────────────────────────────────────────
//  FINAL ROUND — full-screen tap-button recording
// ─────────────────────────────────────────────────────────────────────────────

function startFinalRoundTurn() {
  finalVoice.recording   = false;
  finalVoice.submitOnEnd = false;
  finalVoice.position    = null;
  finalVoice.cardNum     = null;
  finalVoice.transcript  = '';
  // Alert the player it's their turn even if looking away
  playDing();
  vibrateGreen();
  updateFinalOverlay('waiting');
}

function _tapOverlay() {
  if (!S.myTurn || !S.isFinalRound) return;

  if (!finalVoice.recording) {
    // First tap — start recording
    finalVoice.recording   = true;
    finalVoice.submitOnEnd = false;
    finalVoice.transcript  = '';
    finalVoice.position    = null;
    finalVoice.cardNum     = null;
    playBeepUp();
    vibrateShort();
    updateFinalOverlay('recording');
    if (speechRec) { try { speechRec.start(); } catch (_) {} }
  } else {
    // Second tap — stop and submit
    finalVoice.recording   = false;
    finalVoice.submitOnEnd = true;
    playBeepDown();
    vibrateShort();
    updateFinalOverlay('submitting');
    if (speechRec) { try { speechRec.stop(); } catch (_) {} }
    // 1.5 s safety net if onend never fires
    setTimeout(() => {
      if (finalVoice.submitOnEnd) {
        finalVoice.submitOnEnd = false;
        submitFinalGuess();
      }
    }, 1500);
  }
}

function submitFinalGuess() {
  const pos  = finalVoice.position;
  const card = finalVoice.cardNum;

  if (pos === null || card === null) {
    // Couldn't parse — let them try again
    updateFinalOverlay('failed');
    setTimeout(() => {
      if (S.myTurn && S.isFinalRound) updateFinalOverlay('waiting');
    }, 2500);
    return;
  }

  socket.emit('submit_final_guess', { position: pos, card_numeric: card });
  updateFinalOverlay('submitted');
}

function updateFinalOverlay(state) {
  const overlay = document.getElementById('final-round-overlay');
  const iconEl  = document.getElementById('fro-icon');
  const mainEl  = document.getElementById('fro-main');
  const hintEl  = document.getElementById('fro-hint');
  if (!overlay) return;

  overlay.classList.remove('recording', 'fro-failed');

  if (state === 'watching' || state === 'submitted') {
    // Hide entirely — turn indicator at top handles watching; submitted hides briefly
    overlay.classList.add('hidden');
    return;
  }

  overlay.classList.remove('hidden');

  if (state === 'waiting') {
    iconEl.textContent = '🎤';
    mainEl.textContent = 'TAP TO SPEAK';
    hintEl.textContent = 'Speak your guess, then tap again to submit';
  } else if (state === 'recording') {
    iconEl.textContent = '⏹';
    mainEl.textContent = 'RECORDING…';
    hintEl.textContent = 'Tap anywhere to stop and submit';
    overlay.classList.add('recording');
  } else if (state === 'submitting') {
    iconEl.textContent = '⏳';
    mainEl.textContent = 'SUBMITTING…';
    hintEl.textContent = '';
  } else if (state === 'failed') {
    iconEl.textContent = '🔄';
    mainEl.textContent = 'COULDN\'T PARSE';
    hintEl.textContent = 'Say e.g. "second lowest, seven" — tap to try again';
    overlay.classList.add('fro-failed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CARD RENDERING
// ─────────────────────────────────────────────────────────────────────────────

const SUIT_CODE = { Hearts: 'H', Diamonds: 'D', Clubs: 'C', Spades: 'S' };

function renderGameCard(data) {
  const card = document.getElementById('game-card');
  card.className = 'card';

  // deckofcardsapi uses '0' for the 10 card
  const imgVal  = data.value === '10' ? '0' : data.value;
  const imgSrc  = `/static/cards/${imgVal}${SUIT_CODE[data.suit] || 'H'}.png`;

  card.innerHTML =
    `<img class="card-full-img" src="${imgSrc}" alt="${data.value} of ${data.suit}">`;
}


function displayValue(v) {
  return CARD_DISPLAY[v] || v;
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOBBY UI
// ─────────────────────────────────────────────────────────────────────────────

function renderLobbyPlayers() {
  const list = document.getElementById('player-list');
  list.innerHTML = S.players.map(p => `
    <div class="player-row ${p.username === S.username ? 'me' : ''}">
      <span class="player-name">
        ${p.username}${p.is_bot ? '<span class="bot-badge">BOT</span>' : ''}${p.username === S.username ? ' <em style="opacity:.5;font-style:normal">(you)</em>' : ''}
      </span>
      <span class="ready-badge ${p.ready ? 'ready' : 'not-ready'}">
        ${p.ready ? '✓' : '○'}
      </span>
    </div>
  `).join('');

  const n    = S.players.length;
  const need = 5 - n;
  const countEl = document.getElementById('player-count');
  countEl.innerHTML = `<span class="count-num">${n}</span> / 5 players${need > 0 ? ` — need ${need} more` : ' — lobby full!'}`;
  countEl.classList.toggle('count-full', n === 5);

  // Show/hide remove-bots button based on whether any bots are present
  const hasBots = S.players.some(p => p.is_bot);
  const removeBotBtn = document.getElementById('remove-bots-btn');
  if (removeBotBtn) removeBotBtn.classList.toggle('hidden', !hasBots);

  // Disable add-bot button when lobby is full
  const addBotBtn = document.getElementById('add-bot-btn');
  if (addBotBtn) addBotBtn.disabled = (n >= 5);

  updateLobbyStatus();
}

function updateSuitDisplay() {
  document.querySelectorAll('.suit-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.suit === S.suit);
  });
  const readyBtn = document.getElementById('ready-btn');
  if (readyBtn) readyBtn.disabled = !S.suit;
}

function updateLobbyStatus() {
  const el    = document.getElementById('lobby-status');
  const ready = S.players.filter(p => p.ready).length;
  const total = S.players.length;
  if (total < 5) {
    el.textContent = `Waiting for ${5 - total} more player${5 - total !== 1 ? 's' : ''}…`;
  } else if (ready < 5) {
    el.textContent = `${ready} / 5 players ready — waiting for everyone…`;
  } else {
    el.textContent = 'All players ready! Starting…';
  }
}

function resetLobby() {
  const readyBtn = document.getElementById('ready-btn');
  if (readyBtn) {
    readyBtn.disabled = true;
    readyBtn.classList.remove('ready-done');
    readyBtn.textContent = "I'm Ready!";
  }
  document.querySelectorAll('.suit-btn').forEach(b => b.classList.remove('selected'));
}

// ─────────────────────────────────────────────────────────────────────────────
//  TURN INDICATOR & BANNER
// ─────────────────────────────────────────────────────────────────────────────

/** Toggle .overlay-active on card-area when the your-turn-banner (bottom bar) is visible.
 *  The final-round-overlay is now full-screen so no shift is needed for it. */
function syncCardAreaOffset() {
  const banner  = document.getElementById('your-turn-banner');
  const cardArea = document.getElementById('card-area');
  if (!cardArea) return;
  const hasBottomBar = banner && !banner.classList.contains('hidden');
  cardArea.classList.toggle('overlay-active', hasBottomBar);
}

function updateTurnIndicator(data) {
  const el = document.getElementById('turn-indicator');
  if (!el) return;
  const phase = data.is_final ? 'Final Round' : `Round ${data.round}`;
  el.textContent =
    `${phase}  ·  ${data.player}'s turn  (${data.turn_num} / ${data.total_players})`;
}

function showTurnBanner() {
  document.getElementById('your-turn-banner').classList.remove('hidden');
  syncCardAreaOffset();
}

function hideTurnBanner() {
  const b = document.getElementById('your-turn-banner');
  if (b) b.classList.add('hidden');
  syncCardAreaOffset();
}

function showRoundAnnounce(title, sub) {
  const overlay = document.getElementById('round-announce');
  document.getElementById('announce-title').textContent = title;
  document.getElementById('announce-sub').textContent   = sub;
  overlay.classList.remove('hidden');
  setTimeout(() => overlay.classList.add('hidden'), 2600);
}

// ─────────────────────────────────────────────────────────────────────────────
//  FINAL GUESS FORM
// ─────────────────────────────────────────────────────────────────────────────

function resetFinalGuessForm() {
  document.querySelectorAll('.pos-btn, .card-btn')
    .forEach(b => b.classList.remove('selected'));
  document.getElementById('confirm-guess-btn').disabled = true;
  document.getElementById('guess-submitted-msg').classList.add('hidden');
  document.getElementById('final-guess-form').classList.remove('disabled');
  document.getElementById('transcript').textContent   = '';
  document.getElementById('parsed-result').textContent = '';
  document.getElementById('guess-progress').textContent = '';
  const wl = document.getElementById('waiting-label');
  wl.classList.add('hidden');
  wl.textContent = '';
}

function enableFinalGuessForm() {
  if (S.guessSubmitted) return;
  const form = document.getElementById('final-guess-form');
  form.classList.remove('disabled');
  const wl = document.getElementById('waiting-label');
  wl.classList.add('hidden');
  updateConfirmBtn();
}

function disableFinalGuessForm() {
  if (!S.guessSubmitted) {
    document.getElementById('final-guess-form').classList.add('disabled');
  }
}

function updateConfirmBtn() {
  const btn = document.getElementById('confirm-guess-btn');
  btn.disabled = (
    S.guessPosition === null ||
    S.guessCard     === null ||
    S.guessSubmitted ||
    S.currentPlayer !== S.username
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  VOICE RECOGNITION
// ─────────────────────────────────────────────────────────────────────────────

let speechRec = null;

function setupSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    const micBtn = document.getElementById('mic-btn');
    micBtn.textContent = 'Voice not supported on this browser';
    micBtn.disabled = true;
    return;
  }
  speechRec = new SR();
  speechRec.continuous    = false;
  speechRec.interimResults = true;
  speechRec.lang           = 'en-US';

  speechRec.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      (e.results[i].isFinal ? (final += e.results[i][0].transcript)
                             : (interim += e.results[i][0].transcript));
    }
    const text = final || interim;

    if (S.isFinalRound) {
      // Parse the spoken guess silently (no transcript display — phone is on forehead)
      if (final) {
        const parsed = parseGuess(final);
        finalVoice.transcript = final;
        if (parsed.position   !== null) finalVoice.position = parsed.position;
        if (parsed.cardNumeric !== null) finalVoice.cardNum  = parsed.cardNumeric;
      }
    } else {
      document.getElementById('transcript').textContent = text ? `"${text}"` : '';
      if (final) {
        const parsed = parseGuess(final);
        applyParsedGuess(parsed);
      }
    }
  };

  speechRec.onend = () => {
    const btn = document.getElementById('mic-btn');
    if (btn) { btn.classList.remove('recording'); btn.textContent = '🎤 Speak Your Guess'; }

    // Final-round: submit once all results have arrived
    if (S.isFinalRound && finalVoice.submitOnEnd) {
      finalVoice.submitOnEnd = false;
      submitFinalGuess();
    }
  };

  speechRec.onerror = () => {
    const btn = document.getElementById('mic-btn');
    if (btn) { btn.classList.remove('recording'); btn.textContent = '🎤 Speak Your Guess'; }
  };
}

function toggleMic() {
  if (!speechRec) return;
  const btn = document.getElementById('mic-btn');
  if (btn.classList.contains('recording')) {
    speechRec.stop();
  } else {
    try {
      speechRec.start();
      btn.classList.add('recording');
      btn.textContent = '⏹ Stop listening';
    } catch (_) {
      btn.classList.remove('recording');
    }
  }
}

/**
 * Parse spoken text into { position (0–4 | null), cardNumeric (1–13 | null) }.
 *
 * Position: check multi-word phrases before single words to avoid false matches.
 * Card:     accept spoken number words, face names, and digit strings.
 */
function parseGuess(text) {
  const t = text.toLowerCase();
  let position    = null;
  let cardNumeric = null;

  // ── Position ──────────────────────────────────────────────────────────────
  if (/second\s+lowest|2nd\s+lowest/.test(t))        position = 1;
  else if (/second\s+highest|2nd\s+highest/.test(t)) position = 3;
  else if (/\blowest\b/.test(t))                      position = 0;
  else if (/\bhighest\b/.test(t))                     position = 4;
  else if (/\bmiddle\b|\bmid\b|\bthird\b|\bcenter\b/.test(t)) position = 2;

  // ── Card value ────────────────────────────────────────────────────────────
  const cardMap = [
    [/\bace\b|\bone\b/,              1],
    [/\btwo\b|\b2\b/,                2],
    [/\bthree\b|\b3\b/,              3],
    [/\bfour\b|\bfor\b|\b4\b/,       4],
    [/\bfive\b|\b5\b/,               5],
    [/\bsix\b|\b6\b/,                6],
    [/\bseven\b|\b7\b/,              7],
    [/\beight\b|\bate\b|\b8\b/,      8],
    [/\bnine\b|\b9\b/,               9],
    [/\bten\b|\b10\b/,              10],
    [/\bjack\b|\beleven\b|\b11\b/,  11],
    [/\bqueen\b|\btwelve\b|\b12\b/, 12],
    [/\bking\b|\bthirteen\b|\b13\b/,13],
  ];
  for (const [re, n] of cardMap) {
    if (re.test(t)) { cardNumeric = n; break; }
  }

  return { position, cardNumeric };
}

function applyParsedGuess({ position, cardNumeric }) {
  if (position !== null) {
    S.guessPosition = position;
    document.querySelectorAll('.pos-btn').forEach(b => {
      b.classList.toggle('selected', +b.dataset.pos === position);
    });
  }
  if (cardNumeric !== null) {
    S.guessCard = cardNumeric;
    document.querySelectorAll('.card-btn').forEach(b => {
      b.classList.toggle('selected', +b.dataset.num === cardNumeric);
    });
  }

  // Show human-readable summary
  let parts = [];
  if (position !== null)    parts.push(`Position: ${POSITION_NAMES[position]}`);
  if (cardNumeric !== null) {
    const val = CARD_VALUES[cardNumeric - 1];
    parts.push(`Card: ${CARD_DISPLAY[val] || val}`);
  }
  document.getElementById('parsed-result').textContent = parts.join('  ·  ');
  updateConfirmBtn();
}

// ─────────────────────────────────────────────────────────────────────────────
//  RESULTS SCREEN
// ─────────────────────────────────────────────────────────────────────────────

function renderResults(results) {
  const banner = document.getElementById('result-banner');
  if (results.won) {
    banner.textContent = '🎉 YOU WIN!';
    banner.className   = 'result-banner win';
  } else {
    const correct = results.players.filter(p => p.both_correct).length;
    banner.textContent = `Game Over — ${correct} / 5 correct`;
    banner.className   = 'result-banner lose';
  }

  const tbody = document.getElementById('results-body');
  tbody.innerHTML = results.players.map(p => `
    <tr class="${p.both_correct ? 'row-correct' : 'row-wrong'}">
      <td><strong>${p.username}</strong>${p.username === S.username ? ' ★' : ''}</td>
      <td>${p.actual_card}${p.symbol || ''}</td>
      <td>${p.actual_position_name}</td>
      <td class="${p.position_correct ? 'correct' : 'wrong'}">${p.guessed_position_name}</td>
      <td class="${p.card_correct ? 'correct' : 'wrong'}">${p.guessed_card}${p.symbol || ''}</td>
      <td>${p.card_distance === 0 ? '✓' : `±${p.card_distance}`}</td>
    </tr>
  `).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
//  REPLAY ANIMATION
// ─────────────────────────────────────────────────────────────────────────────

function startReplay(results) {
  showScreen('s-replay');
  document.getElementById('replay-phase').textContent = 'Replay';
  buildReplayCircle(results);
  animateReplay(results);
}

function buildReplayCircle(results) {
  const container = document.getElementById('replay-circle');
  container.innerHTML = '';

  const n = results.players.length;

  results.players.forEach((p, i) => {
    // Distribute evenly, starting at top (−π/2)
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    // Use percentage-based positioning relative to container
    const cx = 50 + 38 * Math.cos(angle); // % from left
    const cy = 50 + 38 * Math.sin(angle); // % from top
    const isRed = p.color === 'red';

    const slot = document.createElement('div');
    slot.className = 'replay-card-slot';
    slot.id        = `rslot-${i}`;
    slot.style.left = `${cx}%`;
    slot.style.top  = `${cy}%`;

    slot.innerHTML = `
      <div class="replay-card-flip">
        <div class="replay-card-inner" id="rflip-${i}">
          <div class="replay-card-back"></div>
          <div class="replay-card-front ${isRed ? 'red' : 'black'}">
            <div class="rc-val">${p.actual_card}</div>
            <div class="rc-suit">${p.symbol || ''}</div>
          </div>
        </div>
      </div>
      <div class="replay-player-name">${p.username}</div>
      <div class="replay-guess-badge hidden" id="rbadge-${i}"></div>
    `;
    container.appendChild(slot);
  });
}

async function animateReplay(results) {
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // Phase 1 — flip cards face-up one at a time
  document.getElementById('replay-phase').textContent = 'Revealing cards…';
  for (let i = 0; i < results.players.length; i++) {
    await delay(700);
    document.getElementById(`rflip-${i}`).classList.add('flipped');
    vibrateShort();
  }

  await delay(900);

  // Phase 2 — reveal each player's final guess with colour feedback
  document.getElementById('replay-phase').textContent = 'Final round guesses…';

  // Follow the same turn order (player_order from server)
  const order = results.player_order || results.players.map(p => p.username);
  for (const username of order) {
    const idx = results.players.findIndex(p => p.username === username);
    if (idx === -1) continue;
    const p = results.players[idx];

    await delay(1300);

    const slot  = document.getElementById(`rslot-${idx}`);
    const badge = document.getElementById(`rbadge-${idx}`);

    const posLine  = `${p.guessed_position_name}`;
    const cardLine = `${p.guessed_card}${p.symbol || ''}`;
    const isRight  = p.both_correct;

    badge.innerHTML = `
      <div class="badge-line"><strong>${p.username}</strong></div>
      <div class="${isRight ? 'badge-correct' : 'badge-wrong'}">
        ${posLine} · ${cardLine}
      </div>
      ${!isRight ? `<div class="badge-dist">Card off by ${p.card_distance}</div>` : ''}
    `;
    badge.classList.remove('hidden');

    if (isRight) {
      slot.classList.add('glow-green');
      vibrate([80, 40, 120]);
    } else {
      slot.classList.add('glow-red');
      vibrate([180]);
    }
  }

  await delay(800);
  document.getElementById('replay-phase').textContent =
    results.won ? '🎉 Victory! Every player was correct!' : 'Better luck next time!';
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOAST NOTIFICATION
// ─────────────────────────────────────────────────────────────────────────────

let _toastTimer = null;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = `toast ${type} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATS DISPLAY (login screen)
// ─────────────────────────────────────────────────────────────────────────────

function showStats(stats) {
  const el = document.getElementById('stats-box');
  el.innerHTML = `
    <div class="stats-title">Welcome back, ${stats.username}!</div>
    <div class="stats-grid">
      <div class="stat">
        <div class="stat-val">${stats.games_played}</div>
        <div class="stat-label">Games</div>
      </div>
      <div class="stat">
        <div class="stat-val">${stats.wins}</div>
        <div class="stat-label">Wins</div>
      </div>
      <div class="stat">
        <div class="stat-val">${stats.correct_pct}%</div>
        <div class="stat-label">Correct</div>
      </div>
      <div class="stat">
        <div class="stat-val">${stats.avg_distance}</div>
        <div class="stat-label">Avg Distance</div>
      </div>
      <div class="stat">
        <div class="stat-val">${stats.best_game}/5</div>
        <div class="stat-label">Best Game</div>
      </div>
      <div class="stat">
        <div class="stat-val">${stats.incorrect_pct}%</div>
        <div class="stat-label">Wrong</div>
      </div>
    </div>
  `;
  el.classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
//  INITIALIZATION — wire up all DOM event listeners
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

  // ── Login ──────────────────────────────────────────────────────────────────
  const loginBtn = document.getElementById('login-btn');
  const usernameInput = document.getElementById('username-input');

  loginBtn.addEventListener('click', handleLogin);
  usernameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });

  // ── Lobby: suit selection ─────────────────────────────────────────────────
  document.querySelectorAll('.suit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('select_suit', { suit: btn.dataset.suit });
    });
  });

  // ── Lobby: ready button ───────────────────────────────────────────────────
  document.getElementById('ready-btn').addEventListener('click', () => {
    socket.emit('player_ready');
    const rb = document.getElementById('ready-btn');
    rb.classList.add('ready-done');
    rb.disabled = true;
    rb.textContent = 'Ready ✓';
  });

  // ── Lobby: bot controls ───────────────────────────────────────────────────
  document.getElementById('add-bot-btn').addEventListener('click', () => {
    socket.emit('add_bot');
  });
  document.getElementById('remove-bots-btn').addEventListener('click', () => {
    socket.emit('remove_bots');
  });

  // ── Lobby: iOS microphone permission ─────────────────────────────────────
  const micPermBtn = document.getElementById('mic-perm-btn');
  // Show only when SpeechRecognition exists (skip Android/desktop where it auto-prompts)
  // On iOS Safari, calling .start() from a non-gesture context fails silently.
  // A single user-gesture start+stop grants permission for the rest of the session.
  const _SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (_SR && typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    // iOS: show both permission buttons
    micPermBtn.classList.remove('hidden');
  }
  micPermBtn.addEventListener('click', async () => {
    if (!speechRec) {
      showToast('Voice recognition not available on this browser.', 'warning');
      return;
    }
    try {
      // Arm mic permission: start immediately then stop — this is the user gesture
      // that grants iOS permission for subsequent programmatic calls.
      speechRec.start();
      setTimeout(() => { try { speechRec.stop(); } catch (_) {} }, 200);
      micArmed = true;
      micPermBtn.textContent = 'Microphone Enabled ✓';
      micPermBtn.disabled = true;
      showToast('Microphone ready!', 'success');
    } catch (e) {
      showToast('Could not access microphone.', 'error');
    }
  });

  // ── Lobby: iOS motion permission ──────────────────────────────────────────
  const motBtn = document.getElementById('motion-perm-btn');
  // Show only on iOS 13+ where permission is needed
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    motBtn.classList.remove('hidden');
  }
  motBtn.addEventListener('click', requestMotionPermissionExplicit);

  // ── Game: manual "done" button (tilt fallback, playing rounds) ───────────
  document.getElementById('manual-done-btn').addEventListener('click', () => {
    if (S.myTurn && !S.isFinalRound) {
      socket.emit('turn_complete');
    }
  });

  // ── Final round: tap the full-screen overlay to start/stop recording ────────
  document.getElementById('final-round-overlay').addEventListener('click', _tapOverlay);

  // ── Final guess: position buttons ─────────────────────────────────────────
  document.querySelectorAll('.pos-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.guessPosition = +btn.dataset.pos;
      document.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      updateConfirmBtn();
    });
  });

  // ── Final guess: card value buttons (generated dynamically) ───────────────
  const cardBtnsEl = document.getElementById('card-btns');
  CARD_VALUES.forEach((v, i) => {
    const btn = document.createElement('button');
    btn.className      = 'card-btn';
    btn.dataset.num    = i + 1;
    btn.textContent    = CARD_DISPLAY[v] || v;
    btn.addEventListener('click', () => {
      S.guessCard = i + 1;
      document.querySelectorAll('.card-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      updateConfirmBtn();
    });
    cardBtnsEl.appendChild(btn);
  });

  // ── Final guess: mic ───────────────────────────────────────────────────────
  document.getElementById('mic-btn').addEventListener('click', toggleMic);
  setupSpeech();

  // ── Final guess: confirm ───────────────────────────────────────────────────
  document.getElementById('confirm-guess-btn').addEventListener('click', () => {
    if (S.guessPosition === null || S.guessCard === null) return;
    if (S.guessSubmitted || S.currentPlayer !== S.username) return;
    socket.emit('submit_final_guess', {
      position:    S.guessPosition,
      card_numeric: S.guessCard,
    });
  });

  // ── Results: replay & play again ──────────────────────────────────────────
  document.getElementById('replay-btn').addEventListener('click', () => {
    if (S.results) startReplay(S.results);
  });

  document.getElementById('play-again-btn').addEventListener('click', () => {
    socket.emit('play_again');
  });

  document.getElementById('play-again-from-replay-btn').addEventListener('click', () => {
    socket.emit('play_again');
  });

  document.getElementById('back-to-results-btn').addEventListener('click', () => {
    showScreen('s-results');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  LOGIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────

async function handleLogin() {
  const username = document.getElementById('username-input').value.trim();
  if (!username || username.length < 2) {
    showToast('Username must be at least 2 characters.', 'error');
    return;
  }

  const loginBtn = document.getElementById('login-btn');
  loginBtn.disabled = true;
  loginBtn.textContent = 'Connecting…';

  try {
    const res  = await fetch('/api/profile', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username }),
    });
    const data = await res.json();

    if (data.error) {
      showToast(data.error, 'error');
      loginBtn.disabled    = false;
      loginBtn.textContent = 'Enter Game';
      return;
    }

    // Show returning-player stats if they've played before
    if (data.stats && data.stats.games_played > 0) {
      showStats(data.stats);
    }

    // Join the game room via WebSocket
    socket.emit('join_game', { username });

  } catch (_) {
    showToast('Could not connect to server.', 'error');
    loginBtn.disabled    = false;
    loginBtn.textContent = 'Enter Game';
  }
}
