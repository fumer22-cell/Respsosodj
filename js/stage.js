// =============================================================================
//  Procedural rally stage generation + fast road queries.
//
//  1. A "turtle" walks forward laying down pieces (straights, sweepers,
//     hairpins, chicanes...) whose curvature ramps in and out (clothoids).
//     Every new piece is checked against everything laid so far with a
//     spatial grid; if it would come within `clearance` of older road it is
//     retried/mirrored, and if that fails we backtrack. The road can
//     therefore never cross (or even brush) itself.
//  2. Control points from the walk are fed through a centripetal
//     Catmull-Rom spline and resampled at a fixed spacing.
//  3. Surfaces, width, checkpoints, props and pace notes are layered on top.
//
//  This module has no three.js dependency so it can be run in Node.
// =============================================================================
import { CONFIG } from './config.js';
import { makeRng } from './rng.js';
import { detectCorners, buildPaceNotes } from './pacenotes.js';

const TAU = Math.PI * 2;
const wrap = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// -----------------------------------------------------------------------------
// Uniform grid of point indices, used for clearance checks and road lookups.
// -----------------------------------------------------------------------------
class PointGrid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  _key(ix, iy) { return (ix + 50000) * 100000 + (iy + 50000); }
  add(x, y, idx) {
    const k = this._key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let arr = this.map.get(k);
    if (!arr) { arr = []; this.map.set(k, arr); }
    arr.push(idx);
  }
  /** Remove every stored index >= n (indices are appended in order). */
  truncate(n, xs, ys, from) {
    for (let i = from - 1; i >= n; i--) {
      const arr = this.map.get(this._key(Math.floor(xs[i] / this.cell), Math.floor(ys[i] / this.cell)));
      if (arr) { const j = arr.lastIndexOf(i); if (j >= 0) arr.splice(j, 1); }
    }
  }
  forEachNear(x, y, r, fn) {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
      const arr = this.map.get(this._key(ix, iy));
      if (arr) for (let j = 0; j < arr.length; j++) if (fn(arr[j]) === false) return;
    }
  }
}

// -----------------------------------------------------------------------------
// Piece library. A piece is a list of [length, curvatureStart, curvatureEnd].
// Positive curvature = right turn.
// -----------------------------------------------------------------------------
function corner(R, angle, dir) {
  const k = dir / R;
  const arc = angle * R;                       // length if curvature were constant
  const ramp = Math.min(arc * 0.35, 26);       // clothoid entry/exit
  const body = Math.max(0, arc - ramp);        // ramps contribute half their length
  return [[ramp, 0, k], [body, k, k], [ramp, k, 0]];
}

function makePiece(type, rng, diff, dir) {
  const rs = diff.radiusScale;
  const R = (lo, hi, min = 13) => Math.max(min, rng.range(lo, hi) * rs);
  const link = (lo, hi) => [[rng.range(lo, hi), 0, 0]];
  switch (type) {
    case 'straight': return [[rng.range(diff.straight[0], diff.straight[1]), 0, 0]];
    case 'sweeper': return [...link(0, 30), ...corner(R(90, 230), rng.range(0.35, 1.05), dir)];
    case 'medium': return [...link(5, 35), ...corner(R(36, 80), rng.range(0.6, 1.6), dir)];
    case 'tight': return [...link(10, 40), ...corner(R(20, 34, 16), rng.range(0.9, 1.75), dir)];
    case 'hairpin': return [...link(30, 60), ...corner(Math.max(13.5, rng.range(13.5, 18)), rng.range(2.65, 3.1), dir), ...link(15, 30)];
    case 'chicane': return [...link(20, 50), ...corner(R(24, 45, 18), rng.range(0.5, 0.85), dir),
      ...link(0, 10), ...corner(R(24, 45, 18), rng.range(0.5, 0.85), -dir)];
    case 'esses': {
      const out = [...link(10, 30)];
      const n = rng.int(2, 3);
      for (let i = 0; i < n; i++) { out.push(...corner(R(50, 110), rng.range(0.35, 0.75), i % 2 ? -dir : dir)); out.push(...link(0, 18)); }
      return out;
    }
  }
  return [[50, 0, 0]];
}

/** Integrate a piece from a pose; returns sampled points (excluding the start). */
function integratePiece(piece, x, y, h, ds, out) {
  for (const [len, k0, k1] of piece) {
    const steps = Math.max(1, Math.round(len / ds));
    const step = len / steps;
    for (let i = 0; i < steps; i++) {
      const k = lerp(k0, k1, (i + 0.5) / steps);
      const hm = h + k * step * 0.5;           // midpoint heading
      x += Math.cos(hm) * step; y += Math.sin(hm) * step;
      h += k * step;
      out.push(x, y, h);
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Turtle walk with clearance checking and backtracking.
// -----------------------------------------------------------------------------
function walk(rng, diff, targetLength) {
  const sc = CONFIG.stage;
  const ds = sc.sampleSpacing;
  const clearance = sc.clearance;
  const window = Math.max(3 * clearance, Math.PI * 18 + 2 * clearance); // arc exempt from clearance
  const windowPts = Math.ceil(window / ds);
  const xs = [], ys = [], hs = [];
  const grid = new PointGrid(clearance);
  const pieces = [];                            // start index of each committed piece
  let drift = rng.range(0, TAU);                // general direction of travel
  let lastType = 'straight';

  const push = (x, y, h) => { grid.add(x, y, xs.length); xs.push(x); ys.push(y); hs.push(h); };
  push(0, 0, drift);
  const startPts = integratePiece([[sc.startStraight, 0, 0]], 0, 0, drift, ds, []);
  for (let i = 0; i < startPts.length; i += 3) push(startPts[i], startPts[i + 1], startPts[i + 2]);

  const types = [
    { t: 'straight', weight: 0.2 }, { t: 'sweeper', weight: 0.22 }, { t: 'medium', weight: 0.22 },
    { t: 'tight', weight: 0.12 }, { t: 'esses', weight: 0.08 },
    { t: 'hairpin', weight: diff.hairpin }, { t: 'chicane', weight: diff.chicane },
  ];

  const fits = (cand) => {
    const base = xs.length;
    const c2 = clearance * clearance;
    for (let p = 0; p < cand.length; p += 3) {
      const idx = base + p / 3;
      const x = cand[p], y = cand[p + 1];
      let ok = true;
      grid.forEachNear(x, y, clearance, (j) => {
        if (idx - j <= windowPts) return true;
        const dx = xs[j] - x, dy = ys[j] - y;
        if (dx * dx + dy * dy < c2) { ok = false; return false; }
        return true;
      });
      if (!ok) return false;
    }
    return true;
  };

  let failures = 0;
  const total = targetLength + sc.runOff;
  while ((xs.length - 1) * ds < total) {
    if (failures > 80) return null;
    let type = rng.weighted(types).t;
    if (type === 'straight' && lastType === 'straight') type = 'medium';
    // Prefer turning back toward the general direction so the stage travels
    // somewhere rather than coiling up.
    const dev = wrap(hs[hs.length - 1] - drift);
    let dir = rng.chance(0.72) ? (dev > 0 ? -1 : 1) : rng.sign();
    let placed = false;
    for (let attempt = 0; attempt < 6 && !placed; attempt++) {
      if (attempt === 3) { type = rng.pick(['sweeper', 'medium', 'straight']); }
      const piece = makePiece(type, rng, diff, attempt % 2 ? -dir : dir);
      const n = xs.length - 1;
      const cand = integratePiece(piece, xs[n], ys[n], hs[n], ds, []);
      if (fits(cand)) {
        pieces.push(xs.length);
        for (let i = 0; i < cand.length; i += 3) push(cand[i], cand[i + 1], cand[i + 2]);
        placed = true; lastType = type;
      }
    }
    if (!placed) {
      failures++;
      // Backtrack one or two pieces (never the start straight).
      const back = Math.min(pieces.length, rng.int(1, 2));
      for (let b = 0; b < back; b++) {
        const from = pieces.pop();
        grid.truncate(from, xs, ys, xs.length);
        xs.length = from; ys.length = from; hs.length = from;
      }
      drift += rng.range(-0.8, 0.8);
    } else {
      drift += rng.range(-0.25, 0.25);
    }
  }
  return { xs, ys };
}

// -----------------------------------------------------------------------------
// Centripetal Catmull-Rom spline through control points, resampled by arc length.
// -----------------------------------------------------------------------------
function splineResample(cx, cy, ds) {
  const n = cx.length;
  const P = (i) => [cx[clamp(i, 0, n - 1)], cy[clamp(i, 0, n - 1)]];
  const dense = [];
  const sub = 12;
  for (let i = 0; i < n - 1; i++) {
    let p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    if (i === 0) p0 = [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]];
    if (i === n - 2) p3 = [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]];
    const td = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5) || 1e-4;
    const t0 = 0, t1 = t0 + td(p0, p1), t2 = t1 + td(p1, p2), t3 = t2 + td(p2, p3);
    for (let j = 0; j < sub; j++) {
      const t = lerp(t1, t2, j / sub);
      const pt = [0, 0];
      for (let d = 0; d < 2; d++) {
        const A1 = (t1 - t) / (t1 - t0) * p0[d] + (t - t0) / (t1 - t0) * p1[d];
        const A2 = (t2 - t) / (t2 - t1) * p1[d] + (t - t1) / (t2 - t1) * p2[d];
        const A3 = (t3 - t) / (t3 - t2) * p2[d] + (t - t2) / (t3 - t2) * p3[d];
        const B1 = (t2 - t) / (t2 - t0) * A1 + (t - t0) / (t2 - t0) * A2;
        const B2 = (t3 - t) / (t3 - t1) * A2 + (t - t1) / (t3 - t1) * A3;
        pt[d] = (t2 - t) / (t2 - t1) * B1 + (t - t1) / (t2 - t1) * B2;
      }
      dense.push(pt);
    }
  }
  dense.push(P(n - 1));
  // Resample at constant arc length
  const xs = [dense[0][0]], ys = [dense[0][1]];
  let acc = 0;
  for (let i = 1; i < dense.length; i++) {
    let ax = dense[i - 1][0], ay = dense[i - 1][1];
    const bx = dense[i][0], by = dense[i][1];
    let seg = Math.hypot(bx - ax, by - ay);
    while (acc + seg >= ds) {
      const t = (ds - acc) / seg;
      ax = lerp(ax, bx, t); ay = lerp(ay, by, t);
      xs.push(ax); ys.push(ay);
      seg = Math.hypot(bx - ax, by - ay); acc = 0;
    }
    acc += seg;
  }
  return { xs, ys };
}

// Smooth value noise in [0,1] along the stage (for road width).
function valueNoise1D(rng, length, period) {
  const n = Math.ceil(length / period) + 2;
  const v = Array.from({ length: n }, () => rng.next());
  return (s) => {
    const f = s / period, i = Math.floor(f), t = f - i;
    const u = (1 - Math.cos(t * Math.PI)) / 2;
    return lerp(v[clamp(i, 0, n - 1)], v[clamp(i + 1, 0, n - 1)], u);
  };
}

// =============================================================================
//  Stage: the generated road plus query helpers.
// =============================================================================
export class Stage {
  constructor(seed, difficultyKey) {
    this.seed = seed;
    this.difficultyKey = difficultyKey;
    const diff = CONFIG.difficulty[difficultyKey];
    const sc = CONFIG.stage;
    const ds = sc.sampleSpacing;
    let path = null, rng = null;
    this.theme = makeRng(`theme|${diff.code}|${seed}`).weighted(sc.themes);
    for (let attempt = 0; attempt < 20 && !path; attempt++) {
      rng = makeRng(`${diff.code}|${seed}|${attempt}`);
      const target = rng.range(diff.length[0], diff.length[1]) * (this.theme.lengthScale || 1);
      const walked = walk(rng, diff, target);
      if (!walked) continue;
      // Spline through every Nth point of the walk.
      const every = Math.round(sc.controlSpacing / ds);
      const cx = [], cy = [];
      for (let i = 0; i < walked.xs.length; i += every) { cx.push(walked.xs[i]); cy.push(walked.ys[i]); }
      const last = walked.xs.length - 1;
      if ((last % every) !== 0) { cx.push(walked.xs[last]); cy.push(walked.ys[last]); }
      const res = splineResample(cx, cy, ds);
      if (Stage.selfClear(res.xs, res.ys, ds, sc.clearance * 0.85)) { path = res; this.targetLength = target; }
    }
    if (!path) throw new Error('Stage generation failed for seed ' + seed);
    this.rng = rng;
    this._build(path, diff, rng);
  }

  /** Verify no two far-apart (along the road) samples are closer than `clr`. */
  static selfClear(xs, ys, ds, clr) {
    const grid = new PointGrid(clr);
    const windowPts = Math.ceil(Math.max(3 * clr, Math.PI * 18 + 2 * clr) / ds);
    for (let i = 0; i < xs.length; i++) grid.add(xs[i], ys[i], i);
    const c2 = clr * clr;
    for (let i = 0; i < xs.length; i++) {
      let ok = true;
      grid.forEachNear(xs[i], ys[i], clr, (j) => {
        if (Math.abs(i - j) <= windowPts) return true;
        const dx = xs[j] - xs[i], dy = ys[j] - ys[i];
        if (dx * dx + dy * dy < c2) { ok = false; return false; }
        return true;
      });
      if (!ok) return false;
    }
    return true;
  }

  _build(path, diff, rng) {
    const sc = CONFIG.stage;
    const ds = sc.sampleSpacing;
    const n = path.xs.length;
    this.count = n;
    this.ds = ds;
    this.xs = Float32Array.from(path.xs);
    this.ys = Float32Array.from(path.ys);
    this.tx = new Float32Array(n); this.ty = new Float32Array(n);
    this.nx = new Float32Array(n); this.ny = new Float32Array(n);
    this.heading = new Float32Array(n);
    this.k = new Float32Array(n);
    this.hw = new Float32Array(n);
    this.surf = new Array(n);
    this.length = (n - 1) * ds;

    // Tangents / normals (normal points to the RIGHT of travel).
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let dx = this.xs[b] - this.xs[a], dy = this.ys[b] - this.ys[a];
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      this.tx[i] = dx; this.ty[i] = dy; this.nx[i] = -dy; this.ny[i] = dx;
      this.heading[i] = Math.atan2(dy, dx);
    }
    // Curvature = d(heading)/ds, lightly smoothed.
    const raw = new Float32Array(n);
    for (let i = 1; i < n - 1; i++) raw[i] = wrap(this.heading[i + 1] - this.heading[i - 1]) / (2 * ds);
    const W = 3;
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0;
      for (let j = i - W; j <= i + W; j++) if (j >= 0 && j < n) { sum += raw[j]; cnt++; }
      this.k[i] = sum / cnt;
    }

    // Stage theme & surfaces in sections, with short patches.
    let s = 0, idx = 0;
    const surfAt = new Array(n);
    let first = true;
    while (idx < n) {
      const len = rng.range(sc.sectionLength[0], sc.sectionLength[1]);
      const surface = first ? this.theme.main[0] : rng.pick(this.theme.main);
      first = false;
      const end = Math.min(n, idx + Math.round(len / ds));
      for (let i = idx; i < end; i++) surfAt[i] = surface;
      // A patch (mud/snow/dirt) somewhere in the middle of the section
      if (end - idx > 60 && rng.chance(0.45) && this.theme.patch !== surface) {
        const plen = Math.round(rng.range(sc.mudPatch[0], sc.mudPatch[1]) / ds);
        const pstart = idx + rng.int(15, Math.max(16, end - idx - plen - 15));
        for (let i = pstart; i < Math.min(end, pstart + plen); i++) surfAt[i] = this.theme.patch;
      }
      idx = end; s += len;
    }
    this.surf = surfAt;

    // Width: smooth noise between the difficulty's limits, wider in hairpins.
    const noise = valueNoise1D(rng, this.length, 140);
    for (let i = 0; i < n; i++) {
      const w = lerp(diff.width[0], diff.width[1], noise(i * ds));
      this.hw[i] = w / 2 + Math.min(1.2, Math.abs(this.k[i]) * 16);
    }
    // Smooth the width so hairpin widening blends in.
    const hw2 = Float32Array.from(this.hw);
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0;
      for (let j = i - 8; j <= i + 8; j++) if (j >= 0 && j < n) { sum += hw2[j]; cnt++; }
      this.hw[i] = sum / cnt;
    }

    // Start / finish / checkpoints
    this.startIndex = Math.round(35 / ds);            // car starts here
    this.startLineIndex = Math.round(45 / ds);        // timing starts on GO; line is cosmetic
    this.finishIndex = n - 1 - Math.round(sc.runOff / ds);
    const cpCount = rng.int(sc.checkpointCount[0], sc.checkpointCount[1]);
    this.checkpoints = [];
    for (let c = 1; c <= cpCount; c++) {
      this.checkpoints.push(Math.round(lerp(this.startLineIndex, this.finishIndex, c / (cpCount + 1))));
    }

    // Lookup grid of samples
    this.grid = new PointGrid(20);
    for (let i = 0; i < n; i++) this.grid.add(this.xs[i], this.ys[i], i);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, this.xs[i]); maxX = Math.max(maxX, this.xs[i]);
      minY = Math.min(minY, this.ys[i]); maxY = Math.max(maxY, this.ys[i]);
    }
    this.bounds = { minX, minY, maxX, maxY };

    // Corners -> props (need corner info) -> pace notes (need "don't cut" flags)
    this.corners = detectCorners(this);
    this._placeProps(diff, rng);
    this.notes = buildPaceNotes(this);
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------
  /**
   * Project a point onto the road near sample `hint`. Local search only, so a
   * car on one leg of a hairpin never snaps to the other leg.
   * Writes into `out`: {i, s, lat (+ = right), hw, surface, edge}
   */
  project(x, y, hint, out = {}, window = 30) {
    const n = this.count;
    const lo = Math.max(0, hint - window), hi = Math.min(n - 1, hint + window);
    let best = lo, bd = Infinity;
    for (let i = lo; i <= hi; i++) {
      const dx = x - this.xs[i], dy = y - this.ys[i];
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return this._fill(x, y, best, out);
  }

  /** Global nearest sample (grid search). */
  projectGlobal(x, y, out = {}) {
    let best = -1, bd = Infinity;
    for (let r = 20; best < 0 && r <= 320; r *= 2) {
      this.grid.forEachNear(x, y, r, (i) => {
        const dx = x - this.xs[i], dy = y - this.ys[i];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      });
    }
    if (best < 0) best = 0;
    return this._fill(x, y, best, out);
  }

  _fill(x, y, i, out) {
    const dx = x - this.xs[i], dy = y - this.ys[i];
    const along = dx * this.tx[i] + dy * this.ty[i];
    out.i = i;
    out.s = i * this.ds + along;
    out.lat = dx * this.nx[i] + dy * this.ny[i];
    out.hw = this.hw[i];
    const a = Math.abs(out.lat);
    const verge = CONFIG.stage.vergeWidth;
    out.edge = a - out.hw;                        // <0 on road
    out.surface = a <= out.hw ? this.surf[i] : a <= out.hw + verge ? 'verge' : (this.theme.snowy ? 'snow' : 'grass');
    return out;
  }

  /** Clearance from a point to the nearest road edge over ALL road sections. */
  edgeClearance(x, y) {
    let best = Infinity;
    this.grid.forEachNear(x, y, 30, (i) => {
      const d = Math.hypot(x - this.xs[i], y - this.ys[i]) - this.hw[i];
      if (d < best) best = d;
    });
    return best;
  }

  // ---------------------------------------------------------------------------
  // Props: trees, rocks, guardrails, lamps, reflector posts, spectators,
  // tyre stacks, vending machines (+ their colliders)
  // ---------------------------------------------------------------------------
  _placeProps(diff, rng) {
    const sc = CONFIG.stage;
    const verge = sc.vergeWidth;
    const P = this.props = { trees: [], rocks: [], tires: [], fencePosts: [], fenceRails: [], spectators: [], gates: [],
      lamps: [], posts: [], vending: [] };
    const C = this.colliders = { circles: [], segments: [] };
    const hz = diff.hazard, gap = diff.hazardGap;
    const snowy = !!this.theme.snowy;
    const at = (i, side, off, along = 0) => {
      const x = this.xs[i] + this.nx[i] * side * off + this.tx[i] * along;
      const y = this.ys[i] + this.ny[i] * side * off + this.ty[i] * along;
      return [x, y];
    };
    const free = (x, y, need) => this.edgeClearance(x, y) >= need;
    const nearGate = (i) => {
      if (Math.abs(i - this.startLineIndex) < 6 || Math.abs(i - this.finishIndex) < 6) return true;
      for (const c of this.checkpoints) if (Math.abs(i - c) < 4) return true;
      return false;
    };

    const addTree = (x, y, scale, collide) => {
      P.trees.push({ x, y, scale, rot: rng.range(0, TAU), shade: rng.range(0.75, 1.15) });
      if (collide) C.circles.push({ x, y, r: 0.42 * scale + 0.1, e: 0.25, mu: 0.35, kind: 'tree' });
    };

    for (let i = 0; i < this.count; i += 2) {
      const k = this.k[i];
      const hw = this.hw[i];
      for (const side of [-1, 1]) {
        const outside = side * k < 0 ? Math.min(1, Math.abs(k) * 45) : 0;
        // Near-road trees, denser on the outside of corners
        if (!nearGate(i) && rng.chance(sc.treeDensity * hz * (0.55 + 1.9 * outside))) {
          const g = outside > 0.3 ? rng.range(1.0, 4.5) : rng.range(2.5, 9);
          const off = hw + verge + g * gap + 0.6;
          const [x, y] = at(i, side, off, rng.range(-2, 2));
          if (free(x, y, verge + 0.9)) addTree(x, y, rng.range(0.8, 1.35), true);
        }
        // Rocks close to the edge
        if (rng.chance(sc.rockDensity * hz * (1 + 1.5 * outside))) {
          const r = rng.range(0.45, 1.1);
          const off = hw + verge + r + rng.range(0.3, 3) * gap;
          const [x, y] = at(i, side, off, rng.range(-2, 2));
          if (free(x, y, verge + r)) {
            P.rocks.push({ x, y, r, rot: rng.range(0, TAU), sy: rng.range(0.55, 0.9) });
            C.circles.push({ x, y, r: r * 0.95, e: 0.3, mu: 0.3, kind: 'rock' });
          }
        }
        // Backdrop forest (visual depth; collidable but far from the road)
        const bd = sc.backdropTrees * (this.theme.name === 'Mixed asphalt' ? 0.6 : 1);
        if (rng.chance(bd)) {
          const off = hw + verge + rng.range(11, 55);
          const [x, y] = at(i, side, off, rng.range(-2, 2));
          if (free(x, y, 9)) addTree(x, y, rng.range(0.9, 1.7), true);
        }
      }
    }

    // Corner furniture: guardrails + spectators on the outside, tyre stacks at
    // tight apexes, and "don't cut" rocks on the inside of some corners.
    for (const c of this.corners) {
      const outSide = -c.dir;                   // right turn -> outside is left
      const apex = c.apex;
      if (c.grade <= 5 && rng.chance(this.theme.guardrail ?? 0.55)) {
        // Guardrail along the outside, right at the edge of the verge
        const i0 = Math.max(0, c.start - 8), i1 = Math.min(this.count - 1, c.end + 12);
        let prev = null;
        for (let i = i0; i <= i1; i += 2) {
          if (nearGate(i)) { prev = null; continue; }
          const off = this.hw[i] + verge + 0.5;
          const [x, y] = at(i, outSide, off);
          if (!free(x, y, verge + 0.4)) { prev = null; continue; }
          P.fencePosts.push({ x, y });
          if (prev) {
            P.fenceRails.push({ x1: prev[0], y1: prev[1], x2: x, y2: y, color: 0xd6dbe0 });
            C.segments.push({ x1: prev[0], y1: prev[1], x2: x, y2: y, e: 0.15, mu: 0.12, kind: 'rail' });
          }
          prev = [x, y];
          // The gallery: spectators watching behind the rail
          if (rng.chance(0.12)) {
            const [sx, sy] = at(i, outSide, off + rng.range(2.5, 6), rng.range(-1, 1));
            if (free(sx, sy, verge + 3)) P.spectators.push({ x: sx, y: sy, rot: this.heading[i] + (outSide > 0 ? -Math.PI / 2 : Math.PI / 2), color: rng.int(0, 7), phase: rng.range(0, TAU) });
          }
        }
      }
      if ((c.grade <= 2 || c.hairpin) && rng.chance(0.75)) {
        // Tyre stacks on the outside of the apex
        for (let a = -12; a <= 12; a += 1.5) {
          const i = clamp(apex + Math.round(a / this.ds), 0, this.count - 1);
          const off = this.hw[i] + verge + 1.1;
          const [x, y] = at(i, outSide, off);
          if (!free(x, y, verge + 0.5)) continue;
          P.tires.push({ x, y, rot: this.heading[i], h: rng.int(2, 4) });
          C.circles.push({ x, y, r: 0.65, e: 0.1, mu: 0.15, kind: 'tires' });
        }
      }
      if (c.grade >= 2 && c.grade <= 4 && !c.hairpin && rng.chance(0.4 * Math.min(1.3, hz))) {
        // Rocks on the inside: the co-driver will say "don't cut"
        let placed = 0;
        for (let a = -10; a <= 10; a += rng.range(3, 5)) {
          const i = clamp(apex + Math.round(a / this.ds), 0, this.count - 1);
          const r = rng.range(0.5, 0.85);
          const off = this.hw[i] + 0.4 + r + rng.range(0, 0.8);
          const [x, y] = at(i, c.dir, off);
          if (!free(x, y, 0.35 + r)) continue;
          P.rocks.push({ x, y, r, rot: rng.range(0, TAU), sy: rng.range(0.6, 0.9) });
          C.circles.push({ x, y, r: r * 0.95, e: 0.3, mu: 0.3, kind: 'rock' });
          placed++;
        }
        if (placed >= 2) c.dontCut = true;
      }
    }

    // Crowds at the start and finish, behind tape
    for (const gi of [this.startLineIndex, this.finishIndex]) {
      for (const side of [-1, 1]) {
        for (let a = -14; a <= 18; a += 1.2) {
          if (!rng.chance(0.6)) continue;
          const i = clamp(gi + Math.round(a / this.ds), 0, this.count - 1);
          const [x, y] = at(i, side, this.hw[i] + verge + rng.range(3.5, 7.5));
          if (free(x, y, verge + 3)) P.spectators.push({ x, y, rot: this.heading[i] + (side > 0 ? -Math.PI / 2 : Math.PI / 2), color: rng.int(0, 7), phase: rng.range(0, TAU) });
        }
      }
    }

    // Street lamps (sodium), roughly every 50 m, alternating sides
    let lampSide = rng.sign();
    for (let i = 10; i < this.count - 5; i += 25) {
      if (!rng.chance(this.theme.lamps ?? 0)) continue;
      lampSide = -lampSide;
      const j = i + rng.int(-3, 3);
      const [x, y] = at(j, lampSide, this.hw[j] + verge + 0.9);
      if (!free(x, y, verge + 0.7)) continue;
      P.lamps.push({ x, y, i: j, side: lampSide, heading: this.heading[j] });
      C.circles.push({ x, y, r: 0.22, e: 0.2, mu: 0.2, kind: 'pole' });
    }
    // Reflector posts along both edges (visual only)
    for (let i = 6; i < this.count - 2; i += 12) {
      for (const side of [-1, 1]) {
        const [x, y] = at(i, side, this.hw[i] + verge * 0.6);
        if (free(x, y, verge * 0.5)) P.posts.push({ x, y });
      }
    }
    // Vending machines glowing by the start line
    for (let k = 0; k < 3; k++) {
      const i = clamp(this.startLineIndex - 8 + k, 0, this.count - 1);
      const side = rng.chance(0.5) ? 1 : -1;
      const [x, y] = at(i, side, this.hw[i] + verge + 3 + rng.range(0, 1));
      if (free(x, y, verge + 2)) {
        P.vending.push({ x, y, rot: this.heading[i] + (side > 0 ? -Math.PI / 2 : Math.PI / 2), color: rng.pick([0xe8e8f0, 0xd83030, 0x2f6fe0]) });
        C.circles.push({ x, y, r: 0.6, e: 0.2, mu: 0.3, kind: 'box' });
      }
    }

    P.gates.push({ i: this.startLineIndex, kind: 'start' });
    this.checkpoints.forEach((ci, n) => P.gates.push({ i: ci, kind: 'checkpoint', n: n + 1 }));
    P.gates.push({ i: this.finishIndex, kind: 'finish' });
    this.snowy = snowy;
  }
}
