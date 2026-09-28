// =============================================================================
//  Tiny synthesized audio: engine note that follows rpm/throttle, a gravel /
//  skid hiss that follows tyre sliding, and a thump on impacts. No assets.
// =============================================================================
export class GameAudio {
  constructor() { this.ctx = null; this.enabled = true; }

  /** Must be called from a user gesture (browser autoplay rules). */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = this.enabled ? 0.55 : 0;
    this.master.connect(ctx.destination);

    // Engine: two detuned oscillators through a low-pass filter
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 900;
    this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'square';
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    this.osc1.connect(this.engFilter); this.osc2.connect(g2); g2.connect(this.engFilter);
    this.engFilter.connect(this.engGain); this.engGain.connect(this.master);
    this.osc1.start(); this.osc2.start();

    // Noise source shared by skid + impacts
    const len = ctx.sampleRate * 1.5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    this.skidFilter = ctx.createBiquadFilter(); this.skidFilter.type = 'bandpass'; this.skidFilter.frequency.value = 1200; this.skidFilter.Q.value = 0.8;
    this.skidGain = ctx.createGain(); this.skidGain.gain.value = 0;
    noise.connect(this.skidFilter); this.skidFilter.connect(this.skidGain); this.skidGain.connect(this.master);
    noise.start();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.05);
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended' && this.enabled) this.ctx.resume(); }

  /** Called every frame while driving. */
  update(car, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (!active) {
      this.engGain.gain.setTargetAtTime(0, t, 0.1);
      this.skidGain.gain.setTargetAtTime(0, t, 0.05);
      return;
    }
    const rpm = car.rpmShown;
    const f = rpm / 60 * 2;                   // 4-cylinder firing frequency
    this.osc1.frequency.setTargetAtTime(f, t, 0.02);
    this.osc2.frequency.setTargetAtTime(f * 0.5 * 1.01, t, 0.02);
    this.engFilter.frequency.setTargetAtTime(500 + car.throttleShown * 1600 + rpm * 0.12, t, 0.05);
    this.engGain.gain.setTargetAtTime(0.1 + car.throttleShown * 0.12, t, 0.05);

    const fx = car.fx;
    const loose = fx.surfRear !== 'tarmac';
    const slide = Math.max(fx.slideRear, fx.spinning ? 5 : 0, fx.locked ? car.speed * 0.4 : 0);
    let level = loose ? Math.min(0.25, car.speed * 0.006 + slide * 0.025) : Math.min(0.3, Math.max(0, slide - 2) * 0.05);
    this.skidFilter.frequency.setTargetAtTime(loose ? 700 : 2200, t, 0.1);
    this.skidGain.gain.setTargetAtTime(level, t, 0.05);

    if (fx.impact > 2.5) this.thump(Math.min(1, fx.impact / 15));
  }

  thump(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    if (this._lastThump && t - this._lastThump < 0.15) return;
    this._lastThump = t;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9 * strength, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(flt); flt.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + 0.4);
  }

  beep(freq = 660, dur = 0.15) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.frequency.value = freq; o.type = 'square';
    const g = ctx.createGain(); g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }
}
