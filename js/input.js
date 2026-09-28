// =============================================================================
//  "Invisible string" touch controls (arcade version).
//
//  Touch anywhere: that point becomes the ANCHOR and you're instantly on
//  full throttle. From the anchor:
//    pull back a little -> throttle eases off and light braking starts
//    pull back hard     -> hard braking; hold it at a standstill -> reverse
//    drag sideways      -> steering (spring-smoothed, like tension on a string)
//    release            -> coast, steering springs back to centre
//  The handbrake is its own on-screen button (a separate finger), so it can
//  be used at any time, independent of the string.
//
//  Keyboard (arrows/WASD + space) also works for desktop testing.
// =============================================================================
import { CONFIG } from './config.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class StringInput {
  /**
   * @param target    element that receives driving touches
   * @param overlay   canvas the string is drawn on
   * @param handbrakeButton optional element acting as the handbrake
   */
  constructor(target, overlay, handbrakeButton = null) {
    this.target = target;
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    this.enabled = false;
    this.settings = { ...CONFIG.defaultSettings };

    this.pointer = null;          // { id, ax, ay, x, y }
    this.hbPointers = new Set();  // fingers on the handbrake button
    this.steer = 0; this.steerVel = 0;
    this.throttle = 0; this.brake = 0;
    this.keys = new Set();
    this.out = { throttle: 0, brake: 0, steer: 0, handbrake: false };

    this._bind();
    if (handbrakeButton) this._bindHandbrake(handbrakeButton);
  }

  setSettings(s) { this.settings = { ...this.settings, ...s }; }

  /** Clear all input state (e.g. on pause / reset). */
  release() {
    this.pointer = null;
    this.hbPointers.clear();
    if (this.hbButton) this.hbButton.classList.remove('down');
    this.throttle = this.brake = 0;
    this.keys.clear();
  }

  get handbrakeHeld() { return this.hbPointers.size > 0 || this.keys.has(' '); }

  _bind() {
    const el = this.target;
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.pointer) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this.pointer = { id: e.pointerId, ax: e.clientX, ay: e.clientY, x: e.clientX, y: e.clientY };
    }, { passive: false });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointer;
      if (!p || e.pointerId !== p.id) return;
      e.preventDefault();
      p.x = e.clientX; p.y = e.clientY;
    }, { passive: false });
    const up = (e) => { if (this.pointer && e.pointerId === this.pointer.id) this.pointer = null; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'w', 'a', 's', 'd'].includes(k)) {
        this.keys.add(k); e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
  }

  _bindHandbrake(btn) {
    this.hbButton = btn;
    const down = (e) => {
      if (!this.enabled) return;
      e.preventDefault(); e.stopPropagation();
      try { btn.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this.hbPointers.add(e.pointerId);
      btn.classList.add('down');
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) { /* ignore */ } }
    };
    const up = (e) => {
      this.hbPointers.delete(e.pointerId);
      if (!this.hbPointers.size) btn.classList.remove('down');
    };
    btn.addEventListener('pointerdown', down, { passive: false });
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _short() { return Math.max(200, Math.min(window.innerWidth, window.innerHeight)); }

  /** Compute smoothed control outputs. Call once per frame. */
  update(dt) {
    const c = CONFIG.controls;
    let thrT = 0, brkT = 0, steerT = 0, holding = false;
    const p = this.pointer;
    if (p && this.enabled) {
      holding = true;
      const sens = clamp(this.settings.sensitivity, 0.3, 3);
      const short = this._short();
      const full = c.fullDrag * short / sens;
      const sFull = c.steerFullDrag * short / sens;
      const dz = clamp(this.settings.deadZone, 0, 0.5);
      // Pull-back amount past the dead zone (0 = at or above the anchor)
      const pull = Math.max(0, (p.y - p.ay) / full - dz);
      thrT = 1 - clamp(pull / c.throttleCut, 0, 1);
      brkT = Math.pow(clamp((pull - c.brakeStart) / (1 - dz - c.brakeStart), 0, 1), c.brakeCurve);
      // Steering with a small dead zone and a gentle curve
      const sx = Math.abs(p.x - p.ax) / sFull;
      const sdz = dz * 0.5;
      steerT = Math.sign(p.x - p.ax) * Math.pow(clamp((sx - sdz) / (1 - sdz), 0, 1), c.steerCurve);
      if (this.settings.invertSteer) steerT = -steerT;
    }

    // Keyboard fallback
    const K = this.keys;
    if (!holding && K.size) {
      if (K.has('arrowup') || K.has('w')) thrT = 1;
      if (K.has('arrowdown') || K.has('s')) { brkT = 1; thrT = 0; }
      const kl = K.has('arrowleft') || K.has('a'), kr = K.has('arrowright') || K.has('d');
      steerT = (kr ? 1 : 0) - (kl ? 1 : 0);
      holding = kl || kr || thrT > 0 || brkT > 0;
    }

    // Throttle snaps in (touch = go), brake/lift are smoothed a little
    const up = thrT > this.throttle ? c.throttleRise : c.pedalRise;
    this.throttle += (thrT - this.throttle) * Math.min(1, up * dt);
    this.brake += (brkT - this.brake) * Math.min(1, c.pedalRise * 1.5 * dt);
    if (thrT === 0 && this.throttle < 0.01) this.throttle = 0;
    if (brkT === 0 && this.brake < 0.01) this.brake = 0;

    // Steering: spring-damper toward the target = "tension on a string".
    const k = holding ? c.steerSpring : c.returnSpring;
    const d = holding ? c.steerDamping : 2 * Math.sqrt(c.returnSpring);
    const tgt = holding ? steerT : 0;
    const n = Math.ceil(dt / (1 / 120));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.steerVel += (k * (tgt - this.steer) - d * this.steerVel) * h;
      this.steer += this.steerVel * h;
    }
    this.steer = clamp(this.steer, -1.05, 1.05);

    const o = this.out;
    o.throttle = this.throttle;
    o.brake = this.brake;
    o.steer = clamp(this.steer, -1, 1);
    o.handbrake = this.enabled && this.handbrakeHeld;
    return o;
  }

  /** Draw the "string" from anchor to finger. */
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
    if (!p || !this.enabled) return;
    const c = CONFIG.controls;
    const short = this._short();
    const full = c.fullDrag * short / this.settings.sensitivity;
    const dist = Math.hypot(p.x - p.ax, p.y - p.ay);
    const tension = clamp(dist / full, 0, 1);
    // Neon colours: cyan = throttle, magenta->red = braking
    const col = this.brake > 0.05 ? (this.brake > 0.5 ? [255, 60, 60] : [255, 60, 200]) : [40, 240, 255];
    const px = Math.round;   // keep it crisp and pixel-y
    // Brake zone guide: a short tick below the anchor where braking begins
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    const by = p.ay + (this.settings.deadZone + c.throttleCut) * full;
    ctx.fillRect(px(p.ax - 10), px(by), 20, 2);
    // The string: sags when slack, straight when taut
    const sag = (1 - tension) * Math.min(40, dist * 0.35);
    const mx = (p.ax + p.x) / 2, my = (p.ay + p.y) / 2 + sag;
    ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.35 + 0.45 * tension})`;
    ctx.lineWidth = 2 + 2 * tension;
    ctx.lineCap = 'square';
    ctx.beginPath(); ctx.moveTo(p.ax, p.ay); ctx.quadraticCurveTo(mx, my, p.x, p.y); ctx.stroke();
    // Anchor (square, retro) and finger ring
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(px(p.ax - 4), px(p.ay - 4), 8, 8);
    ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},0.7)`;
    ctx.lineWidth = 2;
    ctx.strokeRect(px(p.x - 18), px(p.y - 18), 36, 36);
  }
}
