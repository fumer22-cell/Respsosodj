// =============================================================================
//  "Invisible string" touch controls.
//
//  Touch anywhere: that point becomes the ANCHOR. The finger holds the other
//  end of a string tied to the back of the car.
//    drag up    -> throttle (proportional to distance)
//    drag down  -> brake (proportional); hold at a standstill -> reverse
//    drag sideways -> steering (proportional, spring-smoothed like tension)
//    quick flick   -> handbrake tap (start a drift)
//    sharp downward flick -> emergency brake
//    circular "spin" of the finger -> handbrake held while spinning
//    release       -> coast, steering springs back to centre
//
//  Keyboard (arrows/WASD + space) also works for desktop testing.
// =============================================================================
import { CONFIG } from './config.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class StringInput {
  constructor(target, overlay) {
    this.target = target;
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    this.enabled = false;
    this.settings = { ...CONFIG.defaultSettings };

    this.pointer = null;          // { id, ax, ay, x, y, t0 }
    this.samples = [];            // recent { t, x, y } for flick / spin detection
    this.spinAngles = [];         // recent { t, d } direction changes
    this.lastDir = null;

    // Smoothed outputs
    this.steer = 0; this.steerVel = 0;
    this.throttle = 0; this.brake = 0;
    this.handbrakeTimer = 0; this.emergencyTimer = 0; this.spinTimer = 0;
    this.flickCooldown = 0;
    this.flash = null;            // { text, t, x, y } gesture feedback

    this.keys = new Set();
    this.out = { throttle: 0, brake: 0, steer: 0, handbrake: false, emergency: false };

    this._bind();
  }

  setSettings(s) { this.settings = { ...this.settings, ...s }; }

  /** Clear all input state (e.g. on pause / reset). */
  release() {
    this.pointer = null; this.samples.length = 0; this.spinAngles.length = 0;
    this.throttle = this.brake = 0; this.handbrakeTimer = this.emergencyTimer = this.spinTimer = 0;
    this.keys.clear();
  }

  _now() { return performance.now() / 1000; }
  /** Event time in seconds on the same clock as performance.now(). Using the
   *  event's own timestamp keeps gesture speeds right even when frames jank. */
  _evTime(e) {
    const ts = e.timeStamp;
    return ts > 0 && Math.abs(ts - performance.now()) < 5000 ? ts / 1000 : this._now();
  }

  _bind() {
    const el = this.target;
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.pointer) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const t = this._evTime(e);
      this.pointer = { id: e.pointerId, ax: e.clientX, ay: e.clientY, x: e.clientX, y: e.clientY, t0: t };
      this.samples = [{ t, x: e.clientX, y: e.clientY }];
      this.spinAngles.length = 0; this.lastDir = null;
    }, { passive: false });

    const move = (e) => {
      const p = this.pointer;
      if (!p || e.pointerId !== p.id) return;
      e.preventDefault();
      // Use coalesced events for smoother gesture sampling where available.
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (evs.length ? evs : [e])) this._addSample(ev.clientX, ev.clientY, this._evTime(ev));
      p.x = e.clientX; p.y = e.clientY;
    };
    el.addEventListener('pointermove', move, { passive: false });

    const up = (e) => {
      const p = this.pointer;
      if (!p || e.pointerId !== p.id) return;
      // A short, fast touch that ends = flick.
      const t = this._evTime(e);
      const ls = this.samples[this.samples.length - 1];
      if (!ls || ls.x !== e.clientX || ls.y !== e.clientY) this._addSample(e.clientX, e.clientY, t);
      p.x = e.clientX; p.y = e.clientY;
      const v = this._fingerVelocity(t);
      const short = this._short();
      if (this.enabled && this.flickCooldown <= 0 &&
          (v.speed > CONFIG.controls.flickSpeed * short * 0.8 ||
           (t - p.t0 < CONFIG.controls.flickMaxTap && Math.hypot(p.x - p.ax, p.y - p.ay) > short * 0.08))) {
        const dx = p.x - p.ax, dy = p.y - p.ay;
        this._flick(v.speed > 1 ? v.vx : dx, v.speed > 1 ? v.vy : dy, p.x, p.y);
      }
      this.pointer = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'w', 'a', 's', 'd', 'shift'].includes(k)) {
        this.keys.add(k); e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
  }

  _short() { return Math.max(200, Math.min(window.innerWidth, window.innerHeight)); }

  _addSample(x, y, t) {
    const last = this.samples[this.samples.length - 1];
    this.samples.push({ t, x, y });
    while (this.samples.length > 2 && t - this.samples[0].t > 0.7) this.samples.shift();
    // Spin detection: accumulate signed change in movement direction.
    if (last) {
      const dx = x - last.x, dy = y - last.y;
      if (dx * dx + dy * dy > 9) {
        const dir = Math.atan2(dy, dx);
        if (this.lastDir !== null) {
          let d = dir - this.lastDir;
          while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
          if (Math.abs(d) < 1.2) this.spinAngles.push({ t, d });   // ignore reversals
        }
        this.lastDir = dir;
      }
    }
  }

  /** Finger velocity (px/s) over the last flickWindow seconds. */
  _fingerVelocity(t) {
    const w = CONFIG.controls.flickWindow;
    const s = this.samples;
    if (s.length < 2) return { vx: 0, vy: 0, speed: 0 };
    const last = s[s.length - 1];
    let first = last;
    for (let i = s.length - 1; i >= 0; i--) { first = s[i]; if (last.t - s[i].t >= w) break; }
    const dt = Math.max(1 / 240, last.t - first.t);
    if (t - last.t > 0.1) return { vx: 0, vy: 0, speed: 0 };      // finger has stopped
    const vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt;
    return { vx, vy, speed: Math.hypot(vx, vy) };
  }

  _flick(vx, vy, x, y) {
    const c = CONFIG.controls;
    this.flickCooldown = c.flickCooldown;
    if (vy > 0 && Math.abs(vx) / vy < c.downFlickCone) {
      this.emergencyTimer = c.emergencyTime;
      this.flash = { text: 'BRAKE!', t: 0.6, x, y, color: '#ff5a4a' };
    } else {
      this.handbrakeTimer = c.handbrakeTap;
      this.flash = { text: 'HANDBRAKE', t: 0.6, x, y, color: '#ffd23a' };
    }
    if (navigator.vibrate) { try { navigator.vibrate(18); } catch (_) { /* ignore */ } }
  }

  /** Map a normalised drag through the dead zone (0..1 out). */
  _dz(v) {
    const dz = clamp(this.settings.deadZone, 0, 0.5);
    return v <= dz ? 0 : clamp((v - dz) / (1 - dz), 0, 1);
  }

  /** Compute smoothed control outputs. Call once per frame. */
  update(dt) {
    const c = CONFIG.controls;
    const t = this._now();
    this.flickCooldown -= dt;
    this.handbrakeTimer -= dt; this.emergencyTimer -= dt; this.spinTimer -= dt;
    if (this.flash) { this.flash.t -= dt; if (this.flash.t <= 0) this.flash = null; }

    let thrT = 0, brkT = 0, steerT = 0, holding = false;
    const p = this.pointer;
    if (p && this.enabled) {
      holding = true;
      const sens = clamp(this.settings.sensitivity, 0.3, 3);
      const short = this._short();
      const full = c.fullDrag * short / sens;
      const sFull = c.steerFullDrag * short / sens;
      const dx = p.x - p.ax, dy = p.y - p.ay;
      const up = -dy / full;
      thrT = this._dz(up); brkT = this._dz(-up);
      const sx = Math.abs(dx) / sFull;
      steerT = Math.sign(dx) * Math.pow(this._dz(sx), c.steerCurve);
      if (this.settings.invertSteer) steerT = -steerT;

      // Mid-hold flick (a sudden jerk of the finger)
      const v = this._fingerVelocity(t);
      if (this.flickCooldown <= 0 && v.speed > c.flickSpeed * short * 1.35) this._flick(v.vx, v.vy, p.x, p.y);

      // Spin gesture: total rotation over the window
      while (this.spinAngles.length && t - this.spinAngles[0].t > c.spinWindow) this.spinAngles.shift();
      let sum = 0; for (const a of this.spinAngles) sum += a.d;
      if (Math.abs(sum) > c.spinTurns * Math.PI * 2) {
        if (this.spinTimer <= 0) this.flash = { text: 'HANDBRAKE', t: 0.5, x: p.x, y: p.y, color: '#ffd23a' };
        this.spinTimer = c.spinHold;
      }
    }

    // Keyboard fallback
    const K = this.keys;
    if (!holding && K.size) {
      if (K.has('arrowup') || K.has('w')) thrT = 1;
      if (K.has('arrowdown') || K.has('s')) brkT = 1;
      const kl = K.has('arrowleft') || K.has('a'), kr = K.has('arrowright') || K.has('d');
      steerT = (kr ? 1 : 0) - (kl ? 1 : 0);
      if (K.has(' ')) this.handbrakeTimer = Math.max(this.handbrakeTimer, 0.05);
      holding = true;
    }

    // Pedals: quick but not instant
    const rise = Math.min(1, c.pedalRise * dt);
    this.throttle += (thrT - this.throttle) * rise;
    this.brake += (brkT - this.brake) * Math.min(1, rise * 1.6);
    if (thrT === 0 && this.throttle < 0.01) this.throttle = 0;
    if (brkT === 0 && this.brake < 0.01) this.brake = 0;

    // Steering: spring-damper toward the target = "tension on a string".
    const k = holding ? c.steerSpring : c.returnSpring;
    const d = holding ? c.steerDamping : 2 * Math.sqrt(c.returnSpring);
    const tgt = holding ? steerT : 0;
    // Sub-step for stability at low frame rates
    const n = Math.ceil(dt / (1 / 120));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.steerVel += (k * (tgt - this.steer) - d * this.steerVel) * h;
      this.steer += this.steerVel * h;
    }
    this.steer = clamp(this.steer, -1.05, 1.05);

    const o = this.out;
    o.emergency = this.emergencyTimer > 0;
    o.throttle = o.emergency ? 0 : this.throttle;
    o.brake = o.emergency ? 1 : this.brake;
    o.steer = clamp(this.steer, -1, 1);
    o.handbrake = this.handbrakeTimer > 0 || this.spinTimer > 0;
    return o;
  }

  /** Draw the faint "string" from anchor to finger. */
  draw() {
    const cv = this.overlay, ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth, H = window.innerHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const p = this.pointer;
    if (p && this.enabled) {
      const dx = p.x - p.ax, dy = p.y - p.ay;
      const dist = Math.hypot(dx, dy);
      const short = this._short();
      const tension = clamp(dist / (CONFIG.controls.fullDrag * short / this.settings.sensitivity), 0, 1.2);
      // Colour: green for throttle, red for brake, white for steering only
      const col = this.throttle > 0.05 ? [120, 255, 150] : this.brake > 0.05 ? [255, 110, 90] : [255, 255, 255];
      // Dead-zone ring at the anchor
      ctx.strokeStyle = `rgba(255,255,255,0.18)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.ax, p.ay, Math.max(10, this.settings.deadZone * CONFIG.controls.fullDrag * short / this.settings.sensitivity), 0, Math.PI * 2);
      ctx.stroke();
      // The string: sags when slack, straight when taut
      const sag = (1 - clamp(tension, 0, 1)) * Math.min(40, dist * 0.35);
      const mx = (p.ax + p.x) / 2, my = (p.ay + p.y) / 2 + sag;
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.25 + 0.45 * clamp(tension, 0, 1)})`;
      ctx.lineWidth = 1.5 + 2.5 * clamp(tension, 0, 1);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(p.ax, p.ay); ctx.quadraticCurveTo(mx, my, p.x, p.y); ctx.stroke();
      // Anchor knot and finger ring
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.arc(p.ax, p.ay, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},0.5)`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 22, 0, Math.PI * 2); ctx.stroke();
    }
    if (this.flash) {
      const f = this.flash;
      ctx.globalAlpha = clamp(f.t / 0.3, 0, 1);
      ctx.fillStyle = f.color;
      ctx.font = '800 20px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(f.text, f.x, f.y - 40 - (0.6 - f.t) * 40);
      ctx.globalAlpha = 1;
    }
  }
}
