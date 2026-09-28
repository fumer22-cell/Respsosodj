// =============================================================================
//  Game flow: menus -> stage build -> countdown -> race -> results.
//  Owns the fixed-timestep loop, timing, checkpoints, penalties, pause.
// =============================================================================
import { CONFIG, carParams } from './config.js';
import { Stage } from './stage.js';
import { Car, CollisionWorld } from './physics.js';
import { StringInput } from './input.js';
import { createRenderer, World } from './scene.js';
import { EffectsDirector } from './effects.js';
import { PaceNoteCaller } from './pacenotes.js';
import { GameAudio } from './audio.js';
import { UI, storage, formatTime, formatDelta } from './ui.js';
import { randomSeed, sanitizeSeed } from './rng.js';

window.__rallyBooted = true;
const $ = (s) => document.querySelector(s);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- Core objects ------------------------------------------------------------
const canvas = $('#gl');
const overlay = $('#string');
const renderer = createRenderer(canvas);
const ui = new UI();
const input = new StringInput($('#touch'), overlay);
const tryInput = new StringInput($('#try-pad'), overlay);
const audio = new GameAudio();
let settings = storage.loadSettings();

const G = {
  mode: 'menu',            // menu | countdown | racing | finished | results
  paused: false,
  carType: 'rwd', diff: 'normal', seed: null,
  stage: null, world: null, car: null, collision: null, effects: null, caller: null,
  raceTime: 0, penalties: 0, penaltyCount: 0, splits: [], cpNext: 0,
  offroad: 0, wrongWay: 0, countdown: 0, shownCount: 0, finishTimer: 0, acc: 0,
  best: null, builtKey: null,
};
const HOLD_START = { throttle: 0, brake: 1, steer: 0, handbrake: false, emergency: false, hold: true };
const HOLD_FINISH = { throttle: 0, brake: 0.45, steer: 0, handbrake: false, emergency: false, hold: true };

const stageCode = () => `${CONFIG.difficulty[G.diff].code}-${G.seed}`;

// ---- Rendering size / quality --------------------------------------------------
let pixelRatio = 1;
function applyQuality() {
  const dpr = window.devicePixelRatio || 1;
  const R = CONFIG.render.maxPixelRatio;
  pixelRatio = settings.quality === 'low' ? Math.min(dpr, R.low)
    : settings.quality === 'high' ? Math.min(dpr, R.high) : Math.min(dpr, 1.5);
  renderer.setPixelRatio(pixelRatio);
  resize();
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  if (G.world) G.world.resize(w, h);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

// Auto quality: lower resolution if the phone can't hold ~50 fps.
const perf = { t: 0, frames: 0 };
function autoQuality(dt) {
  if (settings.quality !== 'auto' || G.mode !== 'racing' || G.paused) { perf.t = 0; perf.frames = 0; return; }
  perf.t += dt; perf.frames++;
  if (perf.t < 2.5) return;
  const fps = perf.frames / perf.t;
  perf.t = 0; perf.frames = 0;
  if (fps < 48) {
    const steps = CONFIG.render.autoPixelRatio.filter((r) => r < pixelRatio - 0.01);
    if (steps.length) { pixelRatio = steps[steps.length - 1]; renderer.setPixelRatio(pixelRatio); resize(); }
  }
}

// ---- Page hygiene: no scrolling, zooming, pull-to-refresh -------------------------
document.addEventListener('touchmove', (e) => { if (!e.target.closest('.scroll')) e.preventDefault(); }, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- Pause on focus loss ------------------------------------------------------------
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else requestWakeLock(); });
window.addEventListener('blur', () => pause());
window.addEventListener('pagehide', () => pause());

let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || !['countdown', 'racing'].includes(G.mode)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) { /* not allowed */ }
}
function maybeFullscreen() {
  if (!settings.fullscreen || document.fullscreenElement) return;
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (fn) { try { const p = fn.call(el, { navigationUI: 'hide' }); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ } }
}

// ---- Speech ---------------------------------------------------------------------------
let voice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  voice = vs.find((v) => /en[-_]GB/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  const ss = speechSynthesis;
  if (ss.pending) ss.cancel();                     // never fall behind the car
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.3; u.pitch = 1; if (voice) u.voice = voice;
  ss.speak(u);
}
function unlockSpeech() {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (_) { /* ignore */ }
}

// =============================================================================
//  Stage lifecycle
// =============================================================================
function buildWorld(seed, diff, carType) {
  const stage = new Stage(seed, diff);
  if (G.world) G.world.dispose();
  G.stage = stage;
  G.world = new World(renderer, stage, carType);
  G.world.resize(window.innerWidth, window.innerHeight);
  G.effects = new EffectsDirector(G.world.scene);
  G.car = new Car(carParams(carType));
  G.collision = new CollisionWorld(stage.colliders);
  G.caller = new PaceNoteCaller(stage.notes);
  G.builtKey = `${diff}|${seed}|${carType}`;
  placeCar(stage.startIndex);
}

function placeCar(i) {
  const st = G.stage;
  G.car.reset(st.xs[i], st.ys[i], st.heading[i], i);
  G.car.proj.edge = -1; G.car.proj.s = i * st.ds;
  G.world.update(0, G.car, true);
  G.effects.reset();
}

function startRace(seed, diff) {
  G.seed = seed;
  if (diff) G.diff = diff;
  storage.addRecent(stageCode());
  audio.unlock(); audio.setEnabled(settings.sound);
  unlockSpeech();
  maybeFullscreen();
  const key = `${G.diff}|${G.seed}|${G.carType}`;
  if (key === G.builtKey && G.world) { G.effects.marks.clear(); placeCar(G.stage.startIndex); beginCountdown(); return; }
  ui.show('loading');
  $('#loading-seed').textContent = `Seed ${stageCode()}`;
  // Let the loading panel paint before the (synchronous) generation.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { buildWorld(G.seed, G.diff, G.carType); beginCountdown(); } catch (err) {
      console.error(err);
      ui.show('stage');
      $('#seed-best').textContent = 'Could not build that stage: ' + err.message;
    }
  }));
}

function beginCountdown() {
  Object.assign(G, { raceTime: 0, penalties: 0, penaltyCount: 0, splits: [], cpNext: 0, offroad: 0, wrongWay: 0, acc: 0, finishTimer: 0, paused: false });
  G.mode = 'countdown';
  G.countdown = CONFIG.rules.countdown + 0.6;
  G.shownCount = 0;
  G.best = storage.getBest(stageCode());
  G.caller.reset(G.stage.startIndex * G.stage.ds);
  ui.hideScreens();
  ui.setHud(true); ui.clearNote(); ui.warn(null); ui.split('', '', 0.01);
  settings.runs = (settings.runs || 0) + 1; storage.saveSettings(settings);
  ui.hint(settings.runs <= 4);
  input.release(); input.enabled = true;
  lastFrame = performance.now();
  requestWakeLock();
}

function resetToCheckpoint(reason) {
  const st = G.stage;
  const idx = G.cpNext > 0 ? st.checkpoints[G.cpNext - 1] : st.startIndex;
  placeCar(idx);
  const pen = CONFIG.rules.offroadPenalty;
  G.raceTime += pen; G.penalties += pen; G.penaltyCount++;
  G.offroad = 0; G.wrongWay = 0;
  G.caller.reset(idx * st.ds);
  ui.clearNote(); ui.warn(null);
  ui.center(`+${pen}s`, 1.6);
  ui.split(reason, 'bad', 2);
  audio.thump(0.4);
}

function onCheckpoint() {
  const n = G.cpNext++;
  const t = G.raceTime;
  G.splits.push(t);
  const bestSplit = G.best && G.best.splits ? G.best.splits[n] : undefined;
  if (bestSplit !== undefined) {
    const d = t - bestSplit;
    ui.split(`CP${n + 1}  ${formatDelta(d)}`, d <= 0 ? 'good' : 'bad');
  } else ui.split(`CP${n + 1}  ${formatTime(t)}`, '');
  audio.beep(990, 0.12);
}

function onFinish() {
  G.mode = 'finished';
  G.finishTimer = 2.0;
  G.finalTime = G.raceTime;
  ui.center('FINISH', 2.2);
  ui.clearNote(); ui.warn(null);
  audio.beep(1320, 0.3);
}

function showResults() {
  G.mode = 'results';
  input.enabled = false; input.release();
  ui.setHud(false);
  const code = stageCode(), prev = G.best, time = G.finalTime, st = G.stage;
  const record = !prev || time < prev.time;
  if (record) storage.setBest(code, { time, splits: G.splits.slice(), car: G.carType, date: Date.now() });
  const rows = [];
  G.splits.forEach((t, i) => {
    const b = prev && prev.splits ? prev.splits[i] : undefined;
    rows.push({ label: `Checkpoint ${i + 1}`, time: formatTime(t), delta: b !== undefined ? formatDelta(t - b) : '', cls: b !== undefined ? (t <= b ? 'good' : 'bad') : '' });
  });
  rows.push({ label: 'Finish', time: formatTime(time), delta: prev ? formatDelta(time - prev.time) : '', cls: prev ? (time <= prev.time ? 'good' : 'bad') : '' });
  if (prev) rows.push({ label: 'Previous best', time: formatTime(prev.time), delta: CONFIG.cars[prev.car] ? prev.car.toUpperCase() : '' });
  if (G.penaltyCount) rows.push({ label: `Penalties (${G.penaltyCount})`, time: `+${G.penalties.toFixed(0)}s`, delta: '', cls: 'bad' });
  const km = (st.finishIndex - st.startLineIndex) * st.ds / 1000;
  const avg = km / Math.max(1, time - G.penalties) * 3600;
  const avgTxt = settings.units === 'mph' ? `${(avg * 0.621371).toFixed(0)} mph` : `${avg.toFixed(0)} km/h`;
  ui.showResults({
    title: record && prev ? 'New record!' : 'Stage complete',
    time, record, code, rows,
    sub: `${CONFIG.cars[G.carType].name} · ${CONFIG.difficulty[G.diff].label} · ${st.theme.name} · ${km.toFixed(2)} km · avg ${avgTxt}`,
  });
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (_) { /* ignore */ }
}

function pause() {
  if (G.paused || !['countdown', 'racing', 'finished'].includes(G.mode)) return;
  G.paused = true;
  input.enabled = false; input.release(); input.draw();   // clear the string overlay
  ui.show('pause');
  audio.suspend();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
function resume() {
  if (!G.paused) return;
  G.paused = false;
  ui.hideScreens();
  input.enabled = true;
  audio.resume();
  lastFrame = performance.now();
  G.acc = 0;
}

function toMenu() {
  G.mode = 'menu'; G.paused = false;
  input.enabled = false; input.release();
  ui.setHud(false);
  ui.hideScreens(); ui.show('title');
  audio.update(G.car, false);
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// =============================================================================
//  Simulation step (fixed rate)
// =============================================================================
function physicsStep(h, inp) {
  const car = G.car, st = G.stage;
  const ctrl = G.mode === 'countdown' ? { ...HOLD_START, steer: inp.steer }
    : (G.mode === 'finished' || G.mode === 'results') ? HOLD_FINISH : inp;
  car.step(h, ctrl, st, G.collision);
  if (G.mode !== 'racing') return;
  G.raceTime += h;

  const i = car.hint;
  const cps = st.checkpoints;
  while (G.cpNext < cps.length && i >= cps[G.cpNext]) onCheckpoint();
  if (G.cpNext >= cps.length && i >= st.finishIndex) { onFinish(); return; }

  // Off-road timer -> auto reset with penalty
  const R = CONFIG.rules;
  if (car.proj.edge > CONFIG.stage.vergeWidth + R.offroadDistance) G.offroad += h;
  else G.offroad = Math.max(0, G.offroad - h * 2);
  if (G.offroad > R.offroadMaxTime) { resetToCheckpoint('Off the road'); return; }

  // Driving the wrong way for too long -> reset too
  const along = car.vx * st.tx[i] + car.vy * st.ty[i];
  if (along < -3) G.wrongWay += h; else G.wrongWay = Math.max(0, G.wrongWay - h);
  if (G.wrongWay > 7) resetToCheckpoint('Wrong way');
}

// =============================================================================
//  Frame loop
// =============================================================================
let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = clamp((now - lastFrame) / 1000, 0, CONFIG.sim.maxFrameTime);
  lastFrame = now;
  ui.tick(dt);

  // Settings "try the string" pad
  if (ui.current === 'settings') {
    tryInput.enabled = true;
    const o = tryInput.update(dt);
    const pct = (v) => `${Math.round(v * 100)}%`;
    const txt = tryInput.pointer
      ? `Throttle ${pct(o.throttle)} · Brake ${pct(o.brake)} · Steer ${o.steer < 0 ? 'L' : 'R'} ${pct(Math.abs(o.steer))}${o.handbrake ? ' · HANDBRAKE' : ''}${o.emergency ? ' · E-BRAKE' : ''}`
      : (o.handbrake || o.emergency ? (o.emergency ? 'EMERGENCY BRAKE' : 'HANDBRAKE') : 'touch & drag');
    const el = $('#try-readout'); if (el.textContent !== txt) el.textContent = txt;
    tryInput.draw();
  } else if (tryInput.enabled) { tryInput.enabled = false; tryInput.release(); }

  if (!G.world) return;
  const world = G.world, car = G.car;

  if (G.mode === 'menu') {
    // Attract mode: slow orbit around the parked car.
    const t = now / 1000 * 0.12;
    const cam = world.camera;
    cam.position.set(car.x + Math.cos(t) * 10, 3.6, car.y + Math.sin(t) * 10);
    cam.lookAt(car.x, 0.9, car.y);
    world.render();
    if (ui.current !== 'settings') input.draw();
    return;
  }
  if (G.paused) return;

  // `rally.autopilot` (see tools/autopilot.js) can drive the car for testing.
  const inp = window.rally.autopilot ? window.rally.autopilot(car, G.stage) : input.update(dt);
  const h = 1 / CONFIG.sim.hz;
  G.acc += dt;
  let steps = 0;
  while (G.acc >= h && steps < 24) { physicsStep(h, inp); G.acc -= h; steps++; }

  // Countdown
  if (G.mode === 'countdown') {
    G.countdown -= dt;
    const n = Math.ceil(G.countdown - 0.6);
    if (n >= 1 && n <= 3 && n !== G.shownCount) { G.shownCount = n; ui.center(String(n), 0.9); audio.beep(520, 0.15); }
    if (G.countdown <= 0) {
      G.mode = 'racing';
      ui.center('GO!', 0.8); audio.beep(1040, 0.35);
      ui.hint(false);
    }
  } else if (G.mode === 'finished') {
    G.finishTimer -= dt;
    if (G.finishTimer <= 0) showResults();
  }

  // Pace notes and warnings
  if (G.mode === 'racing') {
    const note = G.caller.update(car.proj.s, car.speed);
    if (note) { ui.showNote(note); speak(note.say); }
    if (G.offroad > 0.7) ui.warn(`Get back on the road!  ${Math.ceil(CONFIG.rules.offroadMaxTime - G.offroad)}`);
    else if (G.wrongWay > 1.5) ui.warn('Wrong way!');
    else ui.warn(null);
  }

  world.update(dt, car);
  G.effects.update(dt, car, world.camera, window.innerHeight * pixelRatio);
  audio.update(car, G.mode !== 'results');

  if (G.mode !== 'results') {
    const p = car.p;
    ui.updateHud({
      time: G.mode === 'countdown' ? 0 : G.mode === 'finished' ? G.finalTime : G.raceTime,
      speed: car.speed, gear: car.reverse ? 'R' : String(car.gear),
      rpmFrac: clamp((car.rpmShown - p.idleRpm) / (p.redline - p.idleRpm), 0, 1),
      units: settings.units,
      cpText: `CP ${G.cpNext}/${G.stage.checkpoints.length}`,
      seedText: stageCode(),
    });
  }
  world.render();
  input.draw();
  autoQuality(dt);
}

// =============================================================================
//  Menus & settings wiring
// =============================================================================
function parseSeedInput(text) {
  const t = String(text || '').trim().toUpperCase();
  const m = t.match(/^([ENH])\s*-\s*(.+)$/);
  if (m) {
    const diff = Object.keys(CONFIG.difficulty).find((k) => CONFIG.difficulty[k].code === m[1]);
    return { seed: sanitizeSeed(m[2]), diff };
  }
  return { seed: sanitizeSeed(t), diff: null };
}

function refreshStageScreen() {
  const val = $('#seed-input').value;
  const { seed, diff } = parseSeedInput(val);
  const d = diff || G.diff;
  const info = $('#seed-best');
  if (seed) {
    const best = storage.getBest(`${CONFIG.difficulty[d].code}-${seed}`);
    info.textContent = best ? `Your best on ${CONFIG.difficulty[d].code}-${seed}: ${formatTime(best.time)}` : `${CONFIG.difficulty[d].label} · no time set yet`;
  } else info.textContent = `Difficulty: ${CONFIG.difficulty[G.diff].label}. Share seeds like "N-K7Q2XD" — the letter sets the difficulty.`;
  const rec = $('#recent');
  rec.innerHTML = '';
  for (const code of storage.recent()) {
    const b = document.createElement('button');
    const best = storage.getBest(code);
    b.textContent = best ? `${code} · ${formatTime(best.time)}` : code;
    b.addEventListener('click', () => { const p = parseSeedInput(code); startRace(p.seed, p.diff); });
    rec.append(b);
  }
}

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) {
    audio.unlock();
    const t = go.dataset.go;
    if (t === 'back') ui.back(); else ui.show(t);
    if (t === 'settings') loadSettingsUI();
  }
  const card = e.target.closest('[data-car]');
  if (card) { G.carType = card.dataset.car; ui.show('diff'); }
  const d = e.target.closest('[data-diff]');
  if (d) { G.diff = d.dataset.diff; ui.show('stage'); refreshStageScreen(); }
});
$('#btn-random').addEventListener('click', () => startRace(randomSeed()));
$('#seed-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const { seed, diff } = parseSeedInput($('#seed-input').value);
  $('#seed-input').blur();
  if (!seed) { $('#seed-best').textContent = 'Type a seed (letters and numbers), e.g. N-K7Q2XD'; return; }
  startRace(seed, diff);
});
$('#seed-input').addEventListener('input', refreshStageScreen);
$('#btn-pause').addEventListener('pointerdown', (e) => { e.stopPropagation(); });
$('#btn-pause').addEventListener('click', () => pause());
$('#btn-resume').addEventListener('click', resume);
$('#btn-restart').addEventListener('click', () => { G.paused = false; audio.resume(); startRace(G.seed, G.diff); });
$('#btn-quit').addEventListener('click', toMenu);
$('#btn-next').addEventListener('click', () => startRace(randomSeed(), G.diff));
$('#btn-retry').addEventListener('click', () => startRace(G.seed, G.diff));
$('#btn-menu').addEventListener('click', toMenu);
$('#btn-copy').addEventListener('click', async () => {
  const code = stageCode();
  const text = `Beat my ${formatTime(G.finalTime)} on String Rally stage ${code}!`;
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(code); $('#btn-copy').textContent = 'Copied'; }
  } catch (_) { /* cancelled */ }
});

// Settings screen
function loadSettingsUI() {
  $('#s-sens').value = settings.sensitivity; $('#o-sens').textContent = `${Number(settings.sensitivity).toFixed(2)}×`;
  $('#s-dz').value = settings.deadZone; $('#o-dz').textContent = `${Math.round(settings.deadZone * 100)}%`;
  $('#s-invert').checked = settings.invertSteer;
  $('#s-voice').checked = settings.voice;
  $('#s-sound').checked = settings.sound;
  $('#s-fs').checked = settings.fullscreen;
  $('#s-quality').value = settings.quality;
  $('#s-units').value = settings.units;
}
function applySettings() {
  input.setSettings(settings); tryInput.setSettings(settings);
  audio.setEnabled(settings.sound);
  storage.saveSettings(settings);
}
const bindSetting = (sel, key, parse, after) => $(sel).addEventListener('input', (e) => {
  const el = e.target;
  settings[key] = parse(el.type === 'checkbox' ? el.checked : el.value);
  loadSettingsUI(); applySettings(); if (after) after();
});
bindSetting('#s-sens', 'sensitivity', Number);
bindSetting('#s-dz', 'deadZone', Number);
bindSetting('#s-invert', 'invertSteer', Boolean);
bindSetting('#s-voice', 'voice', Boolean);
bindSetting('#s-sound', 'sound', Boolean);
bindSetting('#s-fs', 'fullscreen', Boolean);
bindSetting('#s-quality', 'quality', String, applyQuality);
bindSetting('#s-units', 'units', String);
$('#btn-settings-done').addEventListener('click', () => ui.back());

// =============================================================================
//  Boot
// =============================================================================
applySettings();
applyQuality();
try {
  G.carType = 'rwd';
  buildWorld(randomSeed(), 'easy', 'rwd');   // menu backdrop
  G.builtKey = null;                         // backdrop is never reused as a race
} catch (err) { console.error(err); }
G.carType = 'rwd';
ui.show('title'); ui.history.length = 0;
requestAnimationFrame(frame);

// Handy for tuning from the browser console
window.rally = { G, CONFIG, settings, input, autopilot: null };
