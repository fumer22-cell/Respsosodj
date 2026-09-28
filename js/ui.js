// =============================================================================
//  UI: menu screens, HUD, settings, and localStorage persistence.
// =============================================================================
import { CONFIG } from './config.js';

const $ = (sel) => document.querySelector(sel);

export function formatTime(t) {
  if (!Number.isFinite(t)) return '--:--.--';
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${sign}${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}
export function formatDelta(d) { return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2); }

// -----------------------------------------------------------------------------
// Storage (all wrapped: private mode / blocked storage must not break the game)
// -----------------------------------------------------------------------------
const KEY_SETTINGS = 'stringrally.settings.v1';
const KEY_BEST = 'stringrally.best.v1';
const KEY_RECENT = 'stringrally.recent.v1';
const readJSON = (k, def) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (_) { return def; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } };

export const storage = {
  loadSettings() { return { ...CONFIG.defaultSettings, ...readJSON(KEY_SETTINGS, {}) }; },
  saveSettings(s) { writeJSON(KEY_SETTINGS, s); },
  getBest(code) { return readJSON(KEY_BEST, {})[code] || null; },
  setBest(code, rec) { const all = readJSON(KEY_BEST, {}); all[code] = rec; writeJSON(KEY_BEST, all); },
  recent() { return readJSON(KEY_RECENT, []); },
  addRecent(code) {
    const r = readJSON(KEY_RECENT, []).filter((c) => c !== code);
    r.unshift(code); writeJSON(KEY_RECENT, r.slice(0, 6));
  },
};

// -----------------------------------------------------------------------------
// Screens + HUD
// -----------------------------------------------------------------------------
export class UI {
  constructor() {
    this.screens = {};
    for (const el of document.querySelectorAll('.screen')) this.screens[el.id.replace('screen-', '')] = el;
    this.current = 'title';
    this.history = [];
    this.h = {
      hud: $('#hud'), time: $('#hud-time'), split: $('#hud-split'), cp: $('#hud-cp'), seed: $('#hud-seed'),
      speed: $('#hud-speed'), unit: $('#hud-unit'), gear: $('#hud-gear'), tach: $('#hud-tach'),
      drift: $('#hud-drift'), driftPts: $('#drift-pts'), driftLabel: $('#drift-label'), driftTotal: $('#hud-drift-total'),
      note: $('#hud-note'), noteArrow: $('#note-arrow'), noteGrade: $('#note-grade'), noteText: $('#note-text'),
      center: $('#hud-center'), warn: $('#hud-warn'), hint: $('#hud-hint'),
    };
    this._centerTimer = 0; this._noteTimer = 0; this._splitTimer = 0;
    this._last = {};
  }

  show(name) {
    if (this.current && this.current !== name) this.history.push(this.current);
    for (const [k, el] of Object.entries(this.screens)) el.classList.toggle('hidden', k !== name);
    this.current = name;
  }
  back() {
    const prev = this.history.pop() || 'title';
    for (const [k, el] of Object.entries(this.screens)) el.classList.toggle('hidden', k !== prev);
    this.current = prev;
    return prev;
  }
  hideScreens() {
    for (const el of Object.values(this.screens)) el.classList.add('hidden');
    this.current = null; this.history.length = 0;
  }

  // ---- HUD ----
  setHud(visible) { this.h.hud.classList.toggle('hidden', !visible); }
  /** Only touch the DOM when a value actually changes (cheap on phones). */
  _set(key, el, text) { if (this._last[key] !== text) { this._last[key] = text; el.textContent = text; } }

  updateHud({ time, speed, gear, rpmFrac, units, cpText, seedText }) {
    const h = this.h;
    this._set('time', h.time, formatTime(time));
    const v = units === 'mph' ? speed * 2.23694 : speed * 3.6;
    this._set('speed', h.speed, String(Math.round(v)));
    this._set('unit', h.unit, units === 'mph' ? 'mph' : 'km/h');
    this._set('gear', h.gear, gear);
    this._set('cp', h.cp, cpText);
    this._set('seed', h.seed, seedText);
    const r = Math.round(rpmFrac * 60);
    if (this._last.rpm !== r) { this._last.rpm = r; this._drawTach(r / 60); }
  }

  /** Retro analog tach: 3/4 arc of LED segments, redline in red. */
  _drawTach(frac) {
    const cv = this.h.tach, ctx = cv.getContext('2d');
    const W = cv.width, cx = W / 2, cy = W / 2;
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = 'rgba(7,6,13,0.65)';
    ctx.beginPath(); ctx.arc(cx, cy, W / 2 - 2, 0, Math.PI * 2); ctx.fill();
    const N = 24, a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const a = a0 + (a1 - a0) * t;
      const lit = t <= frac + 0.001;
      ctx.strokeStyle = !lit ? 'rgba(255,255,255,0.12)' : t > 0.85 ? '#ff4a4a' : t > 0.65 ? '#ffb048' : '#19e6ff';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (W / 2 - 16), cy + Math.sin(a) * (W / 2 - 16));
      ctx.lineTo(cx + Math.cos(a) * (W / 2 - 6), cy + Math.sin(a) * (W / 2 - 6));
      ctx.stroke();
    }
  }

  /** Drift combo readout. state: 'live' | 'banked' | 'lost' | null */
  drift(points, mult, state, total) {
    const h = this.h;
    if (!state) { h.drift.classList.add('hidden'); } else {
      h.drift.classList.remove('hidden');
      h.drift.classList.toggle('banked', state === 'banked');
      h.drift.classList.toggle('lost', state === 'lost');
      this._set('dpts', h.driftPts, state === 'lost' ? 'CRASH' : String(Math.round(points)));
      this._set('dlbl', h.driftLabel, state === 'banked' ? `+${Math.round(points)} BANKED` : state === 'lost' ? 'COMBO LOST' : `DRIFT x${mult}`);
    }
    this._set('dtot', h.driftTotal, total > 0 ? `DRIFT ${Math.round(total)}` : '');
  }

  tick(dt) {
    if (this._centerTimer > 0 && (this._centerTimer -= dt) <= 0) this.h.center.textContent = '';
    if (this._noteTimer > 0 && (this._noteTimer -= dt) <= 0) this.h.note.classList.add('hidden');
    if (this._splitTimer > 0 && (this._splitTimer -= dt) <= 0) { this.h.split.textContent = ''; this.h.split.className = 'hud-split'; }
  }

  center(text, secs = 1) {
    const el = this.h.center;
    el.textContent = text;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    this._centerTimer = secs;
  }

  split(text, cls, secs = 3.5) {
    this.h.split.textContent = text;
    this.h.split.className = 'hud-split ' + (cls || '');
    this._splitTimer = secs;
  }

  warn(text, info = false) {
    const el = this.h.warn;
    if (!text) { el.classList.add('hidden'); this._last.warn = null; return; }
    if (this._last.warn !== text) { this._last.warn = text; el.textContent = text; }
    el.classList.toggle('info', info);
    el.classList.remove('hidden');
  }

  hint(show) { this.h.hint.classList.toggle('hidden', !show); }

  showNote(note) {
    const h = this.h;
    if (note.kind === 'corner') {
      const p = note.parts[0];
      h.noteArrow.textContent = p.dir < 0 ? '◀' : '▶';
      h.noteGrade.textContent = note.parts.map((q) => (q.dir < 0 ? 'L' : 'R') + q.label).join(' › ');
      h.noteArrow.style.display = '';
      h.note.classList.toggle('caution', note.parts.some((q) => q.caution));
    } else {
      h.noteArrow.style.display = 'none';
      h.noteGrade.textContent = note.kind === 'finish' ? '🏁' : '⚠';
      h.note.classList.remove('caution');
    }
    h.noteText.textContent = note.text;
    h.note.classList.remove('hidden');
    h.note.style.animation = 'none'; void h.note.offsetWidth; h.note.style.animation = '';
    this._noteTimer = 3.2;
  }
  clearNote() { this.h.note.classList.add('hidden'); this._noteTimer = 0; }

  // ---- Results ----
  showResults(r) {
    $('#res-title').textContent = r.title;
    $('#res-time').textContent = formatTime(r.time);
    $('#res-record').classList.toggle('hidden', !r.record);
    $('#res-sub').textContent = r.sub;
    $('#res-seed').textContent = r.code;
    $('#btn-copy').textContent = 'Copy';
    const tbl = $('#res-splits');
    tbl.innerHTML = '';
    for (const row of r.rows) {
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.textContent = row.label;
      const b = document.createElement('td'); b.textContent = row.time;
      const c = document.createElement('td'); c.textContent = row.delta || ''; c.className = row.cls || '';
      if (row.cls === 'drift') { a.className = b.className = 'drift'; }
      tr.append(a, b, c); tbl.append(tr);
    }
    this.show('results');
  }
}
