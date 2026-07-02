// app.js — screen router, 2s state polling, timers, and game flow glue.
// Screens: home, lobby, write, sculpt, guess, waiting, reveal.

import * as api from './api.js';
import { Sculptor } from './sculptor.js';
import { Viewer } from './viewer.js';
import { RevealFlow } from './reveal.js';
import { PALETTE, MAX_VOXELS } from './scene.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state

const store = {
  playerId: sessionStorage.getItem('ts_playerId') || null,
  roomCode: sessionStorage.getItem('ts_roomCode') || null,
  name: sessionStorage.getItem('ts_name') || '',
  screen: null,
  state: null,          // latest GET /state payload
  task: null,           // latest GET /task payload
  lastRouteKey: null,   // guard: only re-route when phase/step/submitted changed
};

let pollHandle = null;
let sculptor = null;
let guessViewer = null;
let revealFlow = null;
let timer = null;             // { handle, deadline, el }
let placeholderHandle = null;
let waitingLineHandle = null;
let submitting = false;

const SCREENS = ['home', 'lobby', 'write', 'sculpt', 'guess', 'waiting', 'reveal'];

const WRITE_IDEAS = [
  'a cat playing bagpipes', 'sad robot eating spaghetti', 'the moon but angry',
  'a haunted vending machine', 'grandma’s turbo wheelchair', 'a shy volcano',
  'two ducks sharing a secret', 'the world’s smallest skyscraper',
];
const WAITING_LINES = [
  'Waiting for the others…', 'Sculptors at work…', 'Genius takes a moment…',
  'Someone is overthinking this…', 'Voxels are being harmed…', 'Almost there…',
];
const FALLBACK_TEXT = '…mysterious silence…';

// ------------------------------------------------------------------ helpers

function saveSession() {
  sessionStorage.setItem('ts_playerId', store.playerId || '');
  sessionStorage.setItem('ts_roomCode', store.roomCode || '');
  sessionStorage.setItem('ts_name', store.name || '');
}

function clearSession() {
  sessionStorage.removeItem('ts_playerId');
  sessionStorage.removeItem('ts_roomCode');
  sessionStorage.removeItem('ts_name');
  store.playerId = null;
  store.roomCode = null;
  store.state = null;
  store.task = null;
  store.lastRouteKey = null;
}

function toast(msg, kind = 'error') {
  const box = $('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 350);
  }, 3500);
}

function showScreen(name) {
  if (store.screen === name) return;
  store.screen = name;
  for (const s of SCREENS) {
    $(`screen-${s}`).classList.toggle('active', s === name);
  }
  // Pause 3D loops on screens we left (battery friendliness).
  if (name !== 'sculpt' && sculptor) sculptor.stop();
  if (name !== 'guess' && guessViewer) guessViewer.stop();
  if (name !== 'reveal' && revealFlow && revealFlow.viewer) revealFlow.viewer.stop();
  if (name !== 'write') stopPlaceholderRotation();
  if (name !== 'waiting') stopWaitingLines();
}

// countdown timer -----------------------------------------------------------

function startTimer(el, seconds, onExpire) {
  stopTimer();
  const deadline = Date.now() + seconds * 1000;
  el.classList.remove('urgent');
  const paint = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('urgent', left <= 10);
    if (left <= 0) {
      stopTimer();
      onExpire();
    }
  };
  paint();
  timer = { handle: setInterval(paint, 250), el };
}

function stopTimer() {
  if (timer) { clearInterval(timer.handle); timer = null; }
}

function stopPlaceholderRotation() {
  if (placeholderHandle) { clearInterval(placeholderHandle); placeholderHandle = null; }
}

function stopWaitingLines() {
  if (waitingLineHandle) { clearInterval(waitingLineHandle); waitingLineHandle = null; }
}

// player list rendering ------------------------------------------------------

function renderPlayerList(ul, players, { showDone = false } = {}) {
  ul.replaceChildren();
  for (const p of players) {
    const li = document.createElement('li');
    li.className = 'player-item' + (showDone && p.done ? ' done' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color || '#888';
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = p.name + (p.id === store.playerId ? ' (you)' : '');
    li.append(dot, name);
    if (store.state && p.id === store.state.hostId) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'host';
      li.appendChild(tag);
    }
    if (showDone) {
      const check = document.createElement('span');
      check.className = 'done-mark';
      check.textContent = p.done ? '✓' : '·';
      li.appendChild(check);
    }
    ul.appendChild(li);
  }
}

// ------------------------------------------------------------------ polling

function startPolling() {
  if (pollHandle) return;
  pollTick();
  pollHandle = setInterval(pollTick, 2000);
}

function stopPolling() {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
}

async function pollTick() {
  if (!store.roomCode || !store.playerId) return;
  let s;
  try {
    s = await api.getState(store.roomCode, store.playerId);
  } catch (e) {
    if (e.status === 404) {
      stopPolling();
      clearSession();
      showScreen('home');
      toast('That room no longer exists.');
    }
    return; // transient failures: silently retry on next tick
  }
  store.state = s;
  await route(s);
}

async function route(s) {
  if (s.phase === 'lobby') {
    store.lastRouteKey = 'lobby';
    showScreen('lobby');
    renderLobby(s);
    return;
  }

  if (s.phase === 'playing') {
    const key = `playing:${s.step}:${s.youSubmitted}`;
    if (key === store.lastRouteKey) {
      if (store.screen === 'waiting') renderPlayerList($('waiting-players'), s.players, { showDone: true });
      return;
    }
    store.lastRouteKey = key;
    if (s.youSubmitted) {
      enterWaiting(s);
      return;
    }
    let task;
    try {
      task = await api.getTask(store.roomCode, store.playerId);
    } catch {
      store.lastRouteKey = null; // retry next poll
      return;
    }
    store.task = task;
    if (task.type === 'write') enterWrite();
    else if (task.type === 'sculpt') enterSculpt(task);
    else if (task.type === 'guess') enterGuess(task);
    return;
  }

  if (s.phase === 'reveal') {
    if (store.lastRouteKey === 'reveal') return;
    store.lastRouteKey = 'reveal';
    stopTimer();
    try {
      const data = await api.getReveal(store.roomCode);
      enterReveal(data);
      stopPolling();
    } catch (e) {
      store.lastRouteKey = null;
      toast(e.message);
    }
  }
}

// After a successful local submit, jump straight to WAITING and pre-set the
// route key so the next poll doesn't rebuild anything.
function localSubmitted() {
  const step = store.state ? store.state.step : 0;
  store.lastRouteKey = `playing:${step}:true`;
  enterWaiting(store.state || { players: [] });
}

// ------------------------------------------------------------------ HOME

function wireHome() {
  const nameInput = $('home-name');
  const codeInput = $('home-code');
  nameInput.value = store.name || '';

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });

  $('btn-create').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('Enter your name first'); nameInput.focus(); return; }
    if (submitting) return;
    submitting = true;
    try {
      const res = await api.createRoom(name);
      store.playerId = res.playerId;
      store.roomCode = res.roomCode;
      store.name = name;
      saveSession();
      startPolling();
    } catch (e) {
      toast(e.message);
    } finally { submitting = false; }
  });

  $('btn-join').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const code = codeInput.value.trim().toUpperCase();
    if (!name) { toast('Enter your name first'); nameInput.focus(); return; }
    if (code.length !== 4) { toast('Room codes are 4 letters'); codeInput.focus(); return; }
    if (submitting) return;
    submitting = true;
    try {
      const res = await api.joinRoom(code, name);
      store.playerId = res.playerId;
      store.roomCode = res.roomCode;
      store.name = name;
      saveSession();
      startPolling();
    } catch (e) {
      toast(e.message);
    } finally { submitting = false; }
  });

  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-create').click(); });
}

// ------------------------------------------------------------------ LOBBY

function renderLobby(s) {
  $('lobby-code').textContent = store.roomCode || '????';
  renderPlayerList($('lobby-players'), s.players);
  const isHost = s.hostId === store.playerId;
  const startBtn = $('btn-start');
  startBtn.classList.toggle('hidden', !isHost);
  startBtn.disabled = s.players.length < 2;
  startBtn.textContent = s.players.length < 2 ? 'Need at least 2 players' : 'Start game';
  $('lobby-waiting-msg').classList.toggle('hidden', isHost);
}

function wireLobby() {
  $('btn-share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?room=${store.roomCode}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'TeleSculpt', text: `Join my TeleSculpt room: ${store.roomCode}`, url }); return; } catch { /* cancelled */ return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied!', 'info');
    } catch {
      toast(url, 'info');
    }
  });

  $('btn-start').addEventListener('click', async () => {
    try {
      await api.startGame(store.roomCode, store.playerId);
      pollTick();
    } catch (e) {
      toast(e.message);
    }
  });
}

// ------------------------------------------------------------------ WRITE

function enterWrite() {
  showScreen('write');
  const input = $('write-input');
  input.value = '';
  $('write-count').textContent = '0/60';
  $('btn-write-submit').disabled = false;
  stopPlaceholderRotation();
  let i = Math.floor(Math.random() * WRITE_IDEAS.length);
  input.placeholder = WRITE_IDEAS[i];
  placeholderHandle = setInterval(() => {
    i = (i + 1) % WRITE_IDEAS.length;
    input.placeholder = WRITE_IDEAS[i];
  }, 3000);
  startTimer($('write-timer'), 60, () => submitWrite(true));
}

async function submitWrite(auto = false) {
  if (submitting) return;
  const input = $('write-input');
  let text = input.value.trim().slice(0, 60);
  if (!text) {
    if (!auto) { toast('Write something first!'); return; }
    text = FALLBACK_TEXT;
  }
  submitting = true;
  stopTimer();
  $('btn-write-submit').disabled = true;
  try {
    await api.submitTurn(store.roomCode, { playerId: store.playerId, text });
    localSubmitted();
  } catch (e) {
    toast(e.message);
    $('btn-write-submit').disabled = false;
    if (!timer && store.screen === 'write') startTimer($('write-timer'), 15, () => submitWrite(true));
  } finally { submitting = false; }
}

function wireWrite() {
  $('btn-write-submit').addEventListener('click', () => submitWrite(false));
  const input = $('write-input');
  input.addEventListener('input', () => { $('write-count').textContent = `${input.value.length}/60`; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitWrite(false); });
}

// ------------------------------------------------------------------ SCULPT

function ensureSculptor() {
  if (!sculptor) {
    sculptor = new Sculptor($('sculpt-canvas'), {
      onChange(count) {
        $('sculpt-count').textContent = String(count);
        $('btn-undo').disabled = !sculptor.canUndo;
      },
    });
    buildPaletteBar();
  }
  sculptor.start();
  return sculptor;
}

function buildPaletteBar() {
  const bar = $('sculpt-palette');
  bar.replaceChildren();
  PALETTE.forEach((hex, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (i === 0 ? ' selected' : '');
    b.style.background = hex;
    b.setAttribute('aria-label', `Color ${i + 1}`);
    b.addEventListener('click', () => {
      sculptor.setColor(i);
      bar.querySelectorAll('.swatch').forEach((el) => el.classList.remove('selected'));
      b.classList.add('selected');
      setSculptMode('build'); // picking a color implies you want to build
    });
    bar.appendChild(b);
  });
}

function setSculptMode(mode) {
  if (sculptor) sculptor.setMode(mode);
  for (const m of ['build', 'erase', 'rotate']) {
    $(`mode-${m}`).classList.toggle('active', m === mode);
  }
}

function enterSculpt(task) {
  showScreen('sculpt');
  $('sculpt-prompt').textContent = task.prompt || '…';
  const s = ensureSculptor();
  s.reset();
  setSculptMode('build');
  const bar = $('sculpt-palette');
  bar.querySelectorAll('.swatch').forEach((el, i) => el.classList.toggle('selected', i === 0));
  $('btn-sculpt-submit').disabled = false;
  $('btn-sculpt-submit').textContent = 'Done';
  startTimer($('sculpt-timer'), 150, () => submitSculpture(true));
}

async function submitSculpture(auto = false) {
  if (submitting) return;
  submitting = true;
  stopTimer();
  const btn = $('btn-sculpt-submit');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    const sculpture = sculptor ? sculptor.serialize() : { v: 1, size: 16, palette: PALETTE.slice(), voxels: [] };
    const { sasUrl, blobUrl } = await api.getUploadUrl(store.roomCode, store.playerId);
    await api.uploadSculpture(sasUrl, sculpture);
    await api.submitTurn(store.roomCode, { playerId: store.playerId, blobUrl });
    localSubmitted();
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.textContent = 'Done';
    if (store.screen === 'sculpt') startTimer($('sculpt-timer'), auto ? 20 : 30, () => submitSculpture(true));
  } finally {
    submitting = false;
  }
}

function wireSculpt() {
  $('mode-build').addEventListener('click', () => setSculptMode('build'));
  $('mode-erase').addEventListener('click', () => setSculptMode('erase'));
  $('mode-rotate').addEventListener('click', () => setSculptMode('rotate'));
  $('btn-undo').addEventListener('click', () => { if (sculptor) sculptor.undo(); });
  $('btn-sculpt-submit').addEventListener('click', () => submitSculpture(false));
}

// ------------------------------------------------------------------ GUESS

function ensureGuessViewer() {
  if (!guessViewer) guessViewer = new Viewer($('guess-viewer'));
  guessViewer.start();
  return guessViewer;
}

function enterGuess(task) {
  showScreen('guess');
  const input = $('guess-input');
  input.value = '';
  $('btn-guess-submit').disabled = false;
  const v = ensureGuessViewer();
  v.load({ voxels: [] });
  v.loadUrl(task.sculptureUrl).catch((e) => toast(e.message));
  startTimer($('guess-timer'), 60, () => submitGuess(true));
}

async function submitGuess(auto = false) {
  if (submitting) return;
  const input = $('guess-input');
  let text = input.value.trim().slice(0, 60);
  if (!text) {
    if (!auto) { toast('Take a guess first!'); return; }
    text = FALLBACK_TEXT;
  }
  submitting = true;
  stopTimer();
  $('btn-guess-submit').disabled = true;
  try {
    await api.submitTurn(store.roomCode, { playerId: store.playerId, text });
    localSubmitted();
  } catch (e) {
    toast(e.message);
    $('btn-guess-submit').disabled = false;
    if (store.screen === 'guess') startTimer($('guess-timer'), 15, () => submitGuess(true));
  } finally { submitting = false; }
}

function wireGuess() {
  $('btn-guess-submit').addEventListener('click', () => submitGuess(false));
  $('guess-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGuess(false); });
}

// ------------------------------------------------------------------ WAITING

function enterWaiting(s) {
  showScreen('waiting');
  renderPlayerList($('waiting-players'), s.players || [], { showDone: true });
  stopWaitingLines();
  const el = $('waiting-status');
  let i = 0;
  el.textContent = WAITING_LINES[0];
  waitingLineHandle = setInterval(() => {
    i = (i + 1) % WAITING_LINES.length;
    el.textContent = WAITING_LINES[i];
  }, 4000);
}

// ------------------------------------------------------------------ REVEAL

function enterReveal(data) {
  showScreen('reveal');
  if (revealFlow) revealFlow.dispose();
  revealFlow = new RevealFlow({
    progress: $('reveal-progress'),
    cardArea: $('reveal-cards'),
    viewerWrap: $('reveal-viewer-wrap'),
    viewerHost: $('reveal-viewer'),
    sculptorName: $('reveal-sculptor'),
    nextBtn: $('btn-reveal-next'),
    finalPanel: $('reveal-final'),
    playAgainBtn: $('btn-play-again'),
    confettiCanvas: $('confetti-canvas'),
  }, data, { onPlayAgain: resetToHome });
  revealFlow.start();
}

function resetToHome() {
  stopPolling();
  stopTimer();
  if (revealFlow) { revealFlow.dispose(); revealFlow = null; }
  clearSession();
  history.replaceState(null, '', location.pathname); // drop ?room=
  $('home-code').value = '';
  showScreen('home');
}

// ------------------------------------------------------------------ debug hooks (see docs/README.md)

window.__ts = {
  getState() {
    return {
      screen: store.screen,
      roomCode: store.roomCode,
      playerId: store.playerId,
      phase: store.state ? store.state.phase : null,
      step: store.state ? store.state.step : null,
      task: store.task,
      voxelCount: sculptor ? sculptor.count : 0,
    };
  },
  forceScreen(name) {
    stopTimer();
    showScreen(name);
    if (name === 'sculpt') ensureSculptor();
    if (name === 'guess') ensureGuessViewer();
  },
  get sculptor() { return sculptor; },
  debugPlaceVoxel(x, y, z, colorIndex = 0) {
    ensureSculptor();
    return sculptor.debugPlaceVoxel(x, y, z, colorIndex);
  },
  debugSerialize() {
    ensureSculptor();
    return sculptor.serialize();
  },
};

// ------------------------------------------------------------------ init

function init() {
  wireHome();
  wireLobby();
  wireWrite();
  wireSculpt();
  wireGuess();

  const params = new URLSearchParams(location.search);
  const roomParam = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (roomParam) {
    $('home-code').value = roomParam;
  }

  showScreen('home');
  if (roomParam && !(store.playerId && store.roomCode)) {
    $('home-name').focus();
  }

  // Refresh mid-game? state+task fetch decides which screen.
  if (store.playerId && store.roomCode) {
    startPolling();
  }
}

init();
