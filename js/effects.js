// =============================================================================
//  Visual effects: dust / mud / snow / smoke particles and tyre marks.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { psx } from './psx.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// -----------------------------------------------------------------------------
// Pooled point-sprite particles (one draw call).
// -----------------------------------------------------------------------------
export class Particles {
  constructor(scene, max) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.next = 0;
    const g = this.geo = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('palpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 } },
      vertexShader: `
        attribute vec3 pcolor; attribute float palpha; attribute float psize;
        uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vColor = pcolor; vAlpha = palpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * uScale / max(0.5, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          // Chunky PS1 sprite: 4x4 blocky disc with stepped alpha
          vec2 q = floor(gl_PointCoord * 4.0) / 3.0 - 0.5;
          float d = length(q);
          if (d > 0.62 || vAlpha <= 0.0) discard;
          gl_FragColor = vec4(vColor, vAlpha * (d < 0.35 ? 1.0 : 0.55));
        }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
    this._c = new THREE.Color();
  }

  emit(x, y, z, vx, vy, vz, color, size, life, grow, grav, alpha) {
    const i = this.next; this.next = (this.next + 1) % this.max;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this._c.setHex(color);
    this.col[i3] = this._c.r; this.col[i3 + 1] = this._c.g; this.col[i3 + 2] = this._c.b;
    this.size[i] = size; this.life[i] = life; this.maxLife[i] = life;
    this.grow[i] = grow; this.grav[i] = grav; this.a0[i] = alpha; this.alpha[i] = alpha;
  }

  update(dt, viewportHeight, fov) {
    this.mat.uniforms.uScale.value = viewportHeight / (2 * Math.tan((fov * Math.PI / 180) / 2));
    const drag = Math.exp(-2.2 * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const i3 = i * 3;
      this.vel[i3] *= drag; this.vel[i3 + 2] *= drag;
      this.vel[i3 + 1] = this.vel[i3 + 1] * drag - this.grav[i] * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] = Math.max(0.05, this.pos[i3 + 1] + this.vel[i3 + 1] * dt);
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = this.a0[i] * Math.min(1, t * 1.6) * Math.min(1, (1 - t) * 8 + 0.2);
    }
    const a = this.geo.attributes;
    a.position.needsUpdate = a.palpha.needsUpdate = a.psize.needsUpdate = a.pcolor.needsUpdate = true;
  }
}

// -----------------------------------------------------------------------------
// Tyre marks: a ring buffer of quads with RGBA vertex colours.
// -----------------------------------------------------------------------------
export class TireMarks {
  constructor(scene, maxSeg) {
    this.max = maxSeg;
    this.pos = new Float32Array(maxSeg * 4 * 3);
    this.col = new Float32Array(maxSeg * 4 * 4);
    const idx = new Uint32Array(maxSeg * 6);
    for (let q = 0; q < maxSeg; q++) {
      const v = q * 4, o = q * 6;
      idx[o] = v; idx[o + 1] = v + 2; idx[o + 2] = v + 1;
      idx[o + 3] = v + 1; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    const g = this.geo = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh = new THREE.Mesh(g, psx(new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    })));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.next = 0;
    this.tracks = [null, null, null, null];
    this.dirty = false;
  }

  /** Add to track `k` at (x, y). intensity <= 0 breaks the mark. rgba = base colour. */
  add(k, x, y, intensity, rgba, width = 0.24) {
    const last = this.tracks[k];
    if (intensity <= 0.02) { this.tracks[k] = null; return; }
    if (!last) { this.tracks[k] = { x, y, px: 0, py: 0, a: 0 }; return; }
    const dx = x - last.x, dy = y - last.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.35) return;
    if (d > 3) { this.tracks[k] = { x, y, px: 0, py: 0, a: 0 }; return; } // teleported
    const px = -dy / d * width / 2, py = dx / d * width / 2;
    const q = this.next; this.next = (this.next + 1) % this.max;
    const p = this.pos, c = this.col, v = q * 12, cv = q * 16;
    const lpx = last.a > 0 ? last.px : px, lpy = last.a > 0 ? last.py : py;
    const Y = 0.06;
    p[v] = last.x - lpx; p[v + 1] = Y; p[v + 2] = last.y - lpy;
    p[v + 3] = last.x + lpx; p[v + 4] = Y; p[v + 5] = last.y + lpy;
    p[v + 6] = x - px; p[v + 7] = Y; p[v + 8] = y - py;
    p[v + 9] = x + px; p[v + 10] = Y; p[v + 11] = y + py;
    const a1 = rgba[3] * clamp(intensity, 0, 1), a0 = last.a > 0 ? last.a : a1;
    for (let j = 0; j < 4; j++) {
      c[cv + j * 4] = rgba[0]; c[cv + j * 4 + 1] = rgba[1]; c[cv + j * 4 + 2] = rgba[2];
      c[cv + j * 4 + 3] = j < 2 ? a0 : a1;
    }
    this.tracks[k] = { x, y, px, py, a: a1 };
    this.dirty = true;
  }

  breakAll() { this.tracks.fill(null); }

  clear() { this.col.fill(0); this.breakAll(); this.dirty = true; }

  update() {
    if (!this.dirty) return;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.dirty = false;
  }
}

// -----------------------------------------------------------------------------
// Decides what the car's wheels throw up and draw, per surface.
// -----------------------------------------------------------------------------
export class EffectsDirector {
  constructor(scene) {
    this.particles = new Particles(scene, CONFIG.render.particles);
    this.marks = new TireMarks(scene, CONFIG.render.tireMarkSegments);
    this.accum = [0, 0, 0, 0];
  }

  reset() { this.marks.breakAll(); }

  update(dt, car, camera, viewportHeight) {
    const P = car.p, S = CONFIG.surfaces;
    const ch = Math.cos(car.h), sh = Math.sin(car.h);
    const half = P.trackWidth / 2;
    const speed = car.speed;
    const fx = car.fx;
    const wheels = [
      [-P.cgToRear, -half, fx.surfRear, false], [-P.cgToRear, half, fx.surfRear, false],
      [P.cgToFront, -half, fx.surfFront, true], [P.cgToFront, half, fx.surfFront, true],
    ];
    for (let k = 0; k < 4; k++) {
      const [lx, ly, surfName, front] = wheels[k];
      const surf = S[surfName];
      const wx = car.x + ch * lx - sh * ly, wy = car.y + sh * lx + ch * ly;
      const slide = front ? fx.slideFront : fx.slideRear;
      const spin = !front && fx.spinning ? 6 : 0;
      const locked = fx.locked && (front ? !fx.handbrake : true) && speed > 1;
      const loose = surfName !== 'tarmac';
      // --- tyre marks ---
      let intensity = 0;
      if (loose) intensity = clamp(speed / 25, 0, 0.45) + clamp((slide + spin) / 6, 0, 0.55);
      else intensity = clamp((slide - 2.2) / 4, 0, 1) + (spin ? 0.6 : 0) + (locked ? 0.7 : 0);
      if (front && !locked && slide < 3) intensity = loose ? intensity * 0.5 : 0;
      this.marks.add(k, wx, wy, speed > 0.8 ? intensity : 0, surf.mark);

      // --- particles (rear wheels mostly) ---
      if (front && !(locked && loose)) continue;
      let rate = 0, color = surf.dust, size = 0.9, life = 1.2, grav = -0.15, alpha = 0.35, up = 0.8, grow = 1.6;
      if (loose && color !== null) {
        rate = speed * 0.9 + (slide + spin) * 5;
        if (surf.heavy) { size = 0.22; life = 0.7; grav = 9; alpha = 0.7; up = 2.5; grow = 0.05; rate *= 0.45; }
        if (surfName === 'snow') { alpha = 0.55; grow = 2.0; }
      } else if (slide > 3 || spin || (locked && speed > 5)) {
        color = 0xd8d8d8; rate = 25 + slide * 4; alpha = 0.3; size = 0.8; grow = 2.4; life = 1.6;
      }
      if (rate <= 0 || color === null) continue;
      this.accum[k] += rate * dt;
      while (this.accum[k] >= 1) {
        this.accum[k] -= 1;
        const bx = -car.vx * 0.15 + (Math.random() - 0.5) * 2, by = -car.vy * 0.15 + (Math.random() - 0.5) * 2;
        this.particles.emit(wx + (Math.random() - 0.5) * 0.3, 0.25, wy + (Math.random() - 0.5) * 0.3,
          bx, up * (0.5 + Math.random()), by, color, size * (0.7 + Math.random() * 0.6), life * (0.7 + Math.random() * 0.6), grow, grav, alpha);
      }
      if (this.accum[k] > 3) this.accum[k] = 0;
    }
    // Impact puff
    if (fx.impact > 2.5) {
      const c = fx.impactKind === 'tires' ? 0x303030 : fx.impactKind === 'tree' ? 0x6b8a3a : 0xaaaaaa;
      for (let i = 0; i < Math.min(18, fx.impact * 2); i++) {
        this.particles.emit(car.x + ch * 1.8, 0.6, car.y + sh * 1.8, (Math.random() - 0.5) * 6, Math.random() * 3, (Math.random() - 0.5) * 6, c, 0.5, 0.8, 1.2, 3, 0.8);
      }
    }
    this.particles.update(dt, viewportHeight, camera.fov);
    this.marks.update();
  }
}
