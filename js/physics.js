// =============================================================================
//  Custom 2D vehicle physics (top-down), stepped at a fixed rate.
//
//  Model: a "bicycle" car — one virtual tyre per axle — with
//   * a simplified Pacejka tyre curve per axle (separate front/rear slip
//     angles, so understeer / oversteer / drifting emerge naturally),
//   * a friction circle per axle: longitudinal force (drive, brake) eats into
//     the lateral grip that is left,
//   * longitudinal weight transfer (braking loads the front, throttle the rear),
//   * engine torque curve, automatic gearbox, drag, rolling resistance,
//   * handbrake that locks the rear axle into a sliding friction force,
//   * per-axle surface sampling (tarmac, gravel, dirt, mud, snow, verge, grass),
//   * circle/segment collisions against trees, rocks, hay and fences.
//
//  Conventions: car-local +x = forward, +y = right. Positive yaw rate turns
//  right. All tuning values come from CONFIG (see config.js).
// =============================================================================
import { CONFIG } from './config.js';

const G = 9.81;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Normalised Pacejka magic formula: peak ~1 at the optimal slip angle. */
export function pacejka(slip, B, C, E) {
  const x = B * slip;
  return Math.sin(C * Math.atan(x - E * (x - Math.atan(x))));
}

/** Linear interpolation on the [rpm, Nm] torque curve. */
function torqueAt(curve, rpm) {
  if (rpm <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (rpm <= curve[i][0]) {
      const [r0, t0] = curve[i - 1], [r1, t1] = curve[i];
      return lerp(t0, t1, (rpm - r0) / (r1 - r0));
    }
  }
  return curve[curve.length - 1][1];
}

// =============================================================================
//  Static collision world with a uniform grid.
// =============================================================================
export class CollisionWorld {
  constructor(colliders, cell = 10) {
    this.cell = cell;
    this.circles = colliders.circles;
    this.segments = colliders.segments;
    this.grid = new Map();
    const add = (ix, iy, item) => {
      const k = (ix + 50000) * 100000 + (iy + 50000);
      let a = this.grid.get(k); if (!a) this.grid.set(k, a = []);
      a.push(item);
    };
    for (const c of this.circles) {
      const x0 = Math.floor((c.x - c.r) / cell), x1 = Math.floor((c.x + c.r) / cell);
      const y0 = Math.floor((c.y - c.r) / cell), y1 = Math.floor((c.y + c.r) / cell);
      for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) add(ix, iy, c);
    }
    for (const s of this.segments) {
      s.circle = false;
      const x0 = Math.floor(Math.min(s.x1, s.x2) / cell), x1 = Math.floor(Math.max(s.x1, s.x2) / cell);
      const y0 = Math.floor(Math.min(s.y1, s.y2) / cell), y1 = Math.floor(Math.max(s.y1, s.y2) / cell);
      for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) add(ix, iy, s);
    }
    for (const c of this.circles) c.circle = true;
    this._stamp = 0;
  }
  /** Calls fn(item) once for each collider whose cell overlaps the circle. */
  query(x, y, r, fn) {
    const c = this.cell, stamp = ++this._stamp;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
      const a = this.grid.get((ix + 50000) * 100000 + (iy + 50000));
      if (!a) continue;
      for (const item of a) { if (item._s === stamp) continue; item._s = stamp; fn(item); }
    }
  }
}

// =============================================================================
//  The car
// =============================================================================
export class Car {
  constructor(params) {
    this.p = params;
    const p = params;
    this.L = p.cgToFront + p.cgToRear;
    this.inertia = p.mass * p.cgToFront * p.cgToRear * p.inertiaScale;
    this.proj = {}; this.projF = {}; this.projR = {};
    // Telemetry for effects / HUD / audio
    this.fx = {
      slipFront: 0, slipRear: 0, slideRear: 0, slideFront: 0,
      spinning: false, locked: false, handbrake: false,
      surfFront: 'tarmac', surfRear: 'tarmac', impact: 0, impactKind: null,
      wheelOmega: 0,
    };
    this.reset(0, 0, 0);
  }

  reset(x, y, heading, hint = 0) {
    this.x = x; this.y = y; this.h = heading;
    this.vx = 0; this.vy = 0; this.w = 0;
    this.u = 0; this.v = 0;                   // local velocity (forward, right)
    this.steer = 0;
    this.gear = 1; this.reverse = false;
    this.rpm = this.p.idleRpm; this.rpmShown = this.p.idleRpm;
    this.shiftTimer = 0; this.stopTimer = 0;
    this.axFilt = 0; this.accelLat = 0;
    this.hint = hint;
    this.throttleShown = 0;
  }

  get speed() { return Math.hypot(this.vx, this.vy); }

  /**
   * Advance the simulation by dt.
   * input: { throttle 0..1, brake 0..1, steer -1..1 (+ = right), handbrake bool, emergency bool,
   *          hold bool (never engage reverse — used on the start line / after the finish) }
   */
  step(dt, input, stage, world) {
    const p = this.p, cfgS = CONFIG.surfaces;
    const a = p.cgToFront, b = p.cgToRear, m = p.mass;
    const ch = Math.cos(this.h), sh = Math.sin(this.h);

    // ---- Local velocity --------------------------------------------------------
    let u = this.vx * ch + this.vy * sh;       // forward
    let v = -this.vx * sh + this.vy * ch;      // rightward
    const speed = Math.hypot(u, v);

    // ---- Surface under each axle (local search so we never jump road legs) ----
    stage.project(this.x, this.y, this.hint, this.proj);
    this.hint = this.proj.i;
    stage.project(this.x + ch * a, this.y + sh * a, this.hint, this.projF, 12);
    stage.project(this.x - ch * b, this.y - sh * b, this.hint, this.projR, 12);
    const sf = cfgS[this.projF.surface], sr = cfgS[this.projR.surface];
    this.fx.surfFront = this.projF.surface; this.fx.surfRear = this.projR.surface;

    // ---- Steering: speed-sensitive lock + physical rack rate -------------------
    const maxSteer = lerp(p.maxSteerLow, p.maxSteerHigh, clamp(Math.abs(u) / p.steerFadeSpeed, 0, 1));
    // Counter-steer assist: add some steering toward the direction of travel
    // when the car is sliding (beta = body slip angle). Makes drifts catchable
    // on a touch screen while leaving the car free to slide.
    const beta = u > 2 ? Math.atan2(v, u) : 0;
    const assist = p.countersteerAssist * clamp(beta, -0.7, 0.7);
    const target = clamp(clamp(input.steer, -1, 1) * maxSteer + assist, -p.maxSteerLow, p.maxSteerLow);
    const rate = 5.0 * dt;                     // rad per step the wheels can turn
    this.steer += clamp(target - this.steer, -rate, rate);
    const delta = this.steer;

    // ---- Direction / reverse logic ---------------------------------------------
    let drive = 0, brake = 0;
    const throttle = input.throttle, brakeIn = input.brake;
    if (!this.reverse) {
      drive = throttle; brake = brakeIn;
      // Hold "brake" while (nearly) stopped -> engage reverse.
      if (brakeIn > 0.15 && u < 0.6 && throttle < 0.05 && !input.hold) {
        this.stopTimer += dt;
        if (this.stopTimer > p.reverseDelay) { this.reverse = true; this.stopTimer = 0; }
      } else this.stopTimer = 0;
      // Creep: automatic-style idle push at low speed.
      if (brake < 0.05 && !input.handbrake) {
        const creep = p.creepThrottle * clamp((p.creepSpeed - u) / 2, 0, 1);
        drive = Math.max(drive, creep);
      }
    } else {
      if (throttle > 0.1) {
        if (u < -0.6) { brake = throttle; drive = 0; }   // brake the backwards roll first
        else { this.reverse = false; drive = throttle; }
      } else {
        drive = brakeIn;                                   // "brake" drag = reverse throttle
        if (brakeIn < 0.05 && u > -0.3) this.reverse = false;
      }
    }

    // ---- Engine & automatic gearbox ---------------------------------------------
    const wheelOmega = Math.abs(u) / p.wheelRadius;
    const toRpm = 60 / (2 * Math.PI);
    let ratio;
    if (this.reverse) {
      ratio = p.reverseRatio * p.finalDrive;
    } else {
      if (this.shiftTimer <= 0) {
        const rpmNow = wheelOmega * p.gears[this.gear - 1] * p.finalDrive * toRpm;
        if (rpmNow > p.shiftUpRpm && this.gear < p.gears.length && throttle > 0.05) {
          this.gear++; this.shiftTimer = p.shiftTime;
        } else if (this.gear > 1) {
          const rpmDown = wheelOmega * p.gears[this.gear - 2] * p.finalDrive * toRpm;
          if (rpmNow < p.shiftDownRpm && rpmDown < p.shiftUpRpm - 400) { this.gear--; this.shiftTimer = p.shiftTime * 0.7; }
        }
      }
      ratio = p.gears[this.gear - 1] * p.finalDrive;
    }
    this.shiftTimer -= dt;
    let rpm = wheelOmega * ratio * toRpm;
    if (this.reverse || this.gear === 1) rpm = Math.max(rpm, p.idleRpm + (p.launchRpm - p.idleRpm) * drive); // clutch slip
    rpm = Math.max(rpm, p.idleRpm);
    let torque = torqueAt(p.torqueCurve, Math.min(rpm, p.redline)) * drive;
    if (rpm >= p.redline) torque = 0;                      // rev limiter
    if (this.shiftTimer > 0) torque *= 0.15;               // torque cut during shift
    if (!this.reverse && u > p.topSpeed) torque = 0;       // top speed limiter
    if (this.reverse && -u > p.reverseMaxSpeed) torque = 0;
    let driveForce = torque * ratio * p.drivetrainEff / p.wheelRadius * (this.reverse ? -1 : 1);
    // Engine braking when coasting in a forward gear
    let engineBrake = 0;
    if (!this.reverse && drive < 0.05 && u > p.creepSpeed) engineBrake = -p.engineBrake * (rpm / p.redline);
    this.rpm = rpm;

    // ---- Axle loads with longitudinal weight transfer ----------------------------
    const W = m * G;
    let Fzf = W * b / this.L - m * this.axFilt * p.cgHeight / this.L;
    let Fzr = W * a / this.L + m * this.axFilt * p.cgHeight / this.L;
    Fzf = clamp(Fzf, 0.2 * W, 0.8 * W); Fzr = W - Fzf;

    // ---- Longitudinal demands per axle -------------------------------------------
    const frontShare = p.frontDriveShare;
    const brakeTotal = p.brakeForce * brake * (input.emergency ? p.emergencyBrakeBoost : 1);
    const handbrake = !!input.handbrake;

    // Contact-patch velocities in each wheel's own frame
    const cd = Math.cos(delta), sd = Math.sin(delta);
    const vfy = v + this.w * a, vry = v - this.w * b;
    const vfwx = u * cd + vfy * sd, vfwy = -u * sd + vfy * cd;   // front wheel frame
    const vrwx = u, vrwy = vry;                                    // rear wheel frame

    const brakeFn = (share, vw) => -Math.sign(vw) * brakeTotal * share * Math.min(1, Math.abs(vw) / 0.6);
    const rollFn = (Fz, surf, vw) => -p.rollingCoef * surf.rolling * Fz * clamp(vw / 0.5, -1, 1);

    // ---------- FRONT AXLE ----------
    const capF = p.tyreMu * sf.grip * Fzf;
    let FxF = driveForce * frontShare + engineBrake * (frontShare > 0 ? frontShare : 0)
      + brakeFn(p.brakeBias, vfwx) + rollFn(Fzf, sf, vfwx);
    let frontSlipping = false;
    if (Math.abs(FxF) > capF) { FxF = Math.sign(FxF) * capF * p.spinGrip; frontSlipping = true; }
    const slipF = Math.atan2(vfwy, Math.max(Math.abs(vfwx), p.minSlipSpeed));
    let FyF = -capF * pacejka(slipF, p.front.B * sf.bScale, p.front.C * sf.cScale, p.front.E);
    const latF = Math.sqrt(Math.max(0, capF * capF - FxF * FxF));   // friction circle
    FyF = clamp(FyF, -latF, latF);

    // ---------- REAR AXLE ----------
    const capR = p.tyreMu * sr.grip * Fzr;
    let FxR, FyR, rearSlipping = false;
    const slipR = Math.atan2(vrwy, Math.max(Math.abs(vrwx), p.minSlipSpeed));
    if (handbrake) {
      // Locked rear wheels: pure sliding friction opposing the contact velocity.
      const vr = Math.hypot(vrwx, vrwy);
      const f = capR * p.handbrakeSlide / Math.max(vr, 0.5);
      FxR = -vrwx * f; FyR = -vrwy * f;
      rearSlipping = vr > 1;
    } else {
      FxR = driveForce * (1 - frontShare) + engineBrake * (1 - frontShare)
        + brakeFn(1 - p.brakeBias, vrwx) + rollFn(Fzr, sr, vrwx);
      if (Math.abs(FxR) > capR) { FxR = Math.sign(FxR) * capR * p.spinGrip; rearSlipping = true; }
      FyR = -capR * pacejka(slipR, p.rear.B * sr.bScale, p.rear.C * sr.cScale, p.rear.E);
      const latR = Math.sqrt(Math.max(0, capR * capR - FxR * FxR));
      FyR = clamp(FyR, -latR, latR);
    }

    // ---- Sum forces in the car frame ------------------------------------------------
    const Fdrag = p.dragCoef * speed;
    const Fx = FxF * cd - FyF * sd + FxR - Fdrag * u;
    const Fy = FxF * sd + FyF * cd + FyR - Fdrag * v;
    const torqueZ = a * (FxF * sd + FyF * cd) - b * FyR;

    const axc = Fx / m, ayc = Fy / m;
    this.axFilt += (axc - this.axFilt) * Math.min(1, dt / p.weightTransferLag);
    this.accelLat = ayc;

    // ---- Integrate (semi-implicit Euler) ----------------------------------------------
    this.vx += (axc * ch - ayc * sh) * dt;
    this.vy += (axc * sh + ayc * ch) * dt;
    this.w += (torqueZ / this.inertia - p.angularDamping * this.w) * dt;

    // Low-speed blend toward a kinematic model: tyre maths is ill-conditioned
    // near standstill, so we gently steer yaw toward what the wheels dictate.
    const spd = Math.hypot(this.vx, this.vy);
    if (spd < p.kinematicSpeed && !handbrake) {
      const t = 1 - spd / p.kinematicSpeed;
      u = this.vx * ch + this.vy * sh; v = -this.vx * sh + this.vy * ch;
      const wKin = u * Math.tan(delta) / this.L;
      this.w = lerp(this.w, wKin, t * Math.min(1, dt * 25));
      v *= 1 - t * Math.min(1, dt * 12);
      this.vx = u * ch - v * sh; this.vy = u * sh + v * ch;
      // Hold still when braking at a standstill (no creep jitter)
      if (brake > 0.05 && drive < 0.01 && spd < 0.08) { this.vx = 0; this.vy = 0; this.w = 0; }
    }

    this.x += this.vx * dt; this.y += this.vy * dt;
    this.h += this.w * dt;

    // ---- Collisions --------------------------------------------------------------------
    this.fx.impact = 0;
    if (world) this._collide(world);

    // ---- Telemetry -----------------------------------------------------------------------
    const c2 = Math.cos(this.h), s2 = Math.sin(this.h);
    this.u = this.vx * c2 + this.vy * s2;
    this.v = -this.vx * s2 + this.vy * c2;
    const fx = this.fx;
    fx.slipFront = slipF; fx.slipRear = slipR;
    fx.slideRear = Math.abs(vrwy); fx.slideFront = Math.abs(vfwy);
    fx.spinning = rearSlipping && !handbrake && Math.abs(driveForce) > 0;
    fx.locked = (frontSlipping && brake > 0.2) || handbrake;
    fx.handbrake = handbrake;
    fx.wheelOmega = (fx.spinning ? Math.abs(u) + 8 : u) / p.wheelRadius;
    this.rpmShown = lerp(this.rpmShown, fx.spinning ? Math.min(p.redline, rpm + 1800) : rpm, Math.min(1, dt * 12));
    this.throttleShown = drive;
  }

  /** Push out of obstacles; bounce with restitution and some friction. */
  _collide(world) {
    const p = this.p;
    const r = p.colliderRadius;
    const m = p.mass, I = this.inertia;
    for (let pass = 0; pass < 2; pass++) {
      for (const sgn of [1, -1]) {
        const ch = Math.cos(this.h), sh = Math.sin(this.h);
        const ox = ch * p.colliderOffset * sgn, oy = sh * p.colliderOffset * sgn;
        const cx = this.x + ox, cy = this.y + oy;
        world.query(cx, cy, r + 1.5, (o) => {
          let nx, ny, depth;
          if (o.circle) {
            const dx = cx - o.x, dy = cy - o.y;
            const d = Math.hypot(dx, dy), minD = r + o.r;
            if (d >= minD || d < 1e-6) return;
            nx = dx / d; ny = dy / d; depth = minD - d;
          } else {
            const sx = o.x2 - o.x1, sy = o.y2 - o.y1;
            const l2 = sx * sx + sy * sy || 1;
            const t = clamp(((cx - o.x1) * sx + (cy - o.y1) * sy) / l2, 0, 1);
            const px = o.x1 + sx * t, py = o.y1 + sy * t;
            const dx = cx - px, dy = cy - py, d = Math.hypot(dx, dy);
            if (d >= r || d < 1e-6) return;
            nx = dx / d; ny = dy / d; depth = r - d;
          }
          // Positional correction
          this.x += nx * depth; this.y += ny * depth;
          // Velocity at the contact point (relative to CG)
          const rx = ox - nx * r, ry = oy - ny * r;
          const vpx = this.vx - this.w * ry, vpy = this.vy + this.w * rx;
          const vn = vpx * nx + vpy * ny;
          if (vn >= 0) return;
          const rn = rx * ny - ry * nx;
          const jn = -(1 + o.e) * vn / (1 / m + rn * rn / I);
          // Tangential (friction) impulse, capped by Coulomb friction
          const tx = -ny, ty = nx;
          const vt = vpx * tx + vpy * ty;
          const rt = rx * ty - ry * tx;
          let jt = -vt / (1 / m + rt * rt / I);
          jt = clamp(jt, -o.mu * jn, o.mu * jn);
          this.vx += (jn * nx + jt * tx) / m;
          this.vy += (jn * ny + jt * ty) / m;
          this.w += (rn * jn + rt * jt) / I * 0.6;   // damped spin: bumps shouldn't feel random
          this.w = clamp(this.w, -3.5, 3.5);
          if (-vn > this.fx.impact) { this.fx.impact = -vn; this.fx.impactKind = o.kind; }
        });
      }
    }
  }
}
