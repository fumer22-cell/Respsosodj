// =============================================================================
//  Rendering: builds the PS1-style 3D world for a Stage — sky & skyline, road
//  and ground with baked (vertex) lighting from street lamps, instanced props,
//  gates — plus the low-poly JDM car and the chase camera.
//
//  Physics (x, y) maps to three.js (x, 0, y). A physics heading h maps to
//  rotation.y = -h. Models are built with their nose along +x.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { makeRng } from './rng.js';
import {
  psx, roadAtlas, ROAD_TILES, groundTexture, glowTexture, beamTexture,
  skylineTexture, liveryTexture, bannerTexture, pixelTexture,
} from './psx.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

// Material shorthands (all PS1-patched)
const lambert = (o) => psx(new THREE.MeshLambertMaterial({ flatShading: true, ...o }));
const basic = (o) => psx(new THREE.MeshBasicMaterial(o));
const additive = (o) => psx(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...o }), { affine: false });

// -----------------------------------------------------------------------------
// Geometry helpers
// -----------------------------------------------------------------------------
/** Merge simple geometries into one non-indexed geometry with vertex colours. */
function mergeColored(parts) {
  const pos = [], nor = [], col = [];
  const c = new THREE.Color();
  for (const { geo, color } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.computeVertexNormals();
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    c.set(color);
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i], p[i + 1], p[i + 2]); nor.push(n[i], n[i + 1], n[i + 2]);
      col.push(c.r, c.g, c.b);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

/** Collects instances per spatial chunk so each chunk can be frustum-culled. */
class ChunkedInstances {
  constructor(size) { this.size = size; this.types = new Map(); }
  add(type, x, z, rotY, sx, sy, sz, color, y = 0) {
    let chunks = this.types.get(type);
    if (!chunks) this.types.set(type, chunks = new Map());
    const key = `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`;
    let arr = chunks.get(key);
    if (!arr) chunks.set(key, arr = []);
    arr.push(x, z, rotY, sx, sy, sz, color, y);
  }
  build(parent, defs) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const e = new THREE.Euler(), c = new THREE.Color();
    const N = 8;
    for (const [type, chunks] of this.types) {
      const def = defs[type];
      for (const arr of chunks.values()) {
        const count = arr.length / N;
        const mesh = new THREE.InstancedMesh(def.geometry, def.material, count);
        for (let i = 0; i < count; i++) {
          const o = i * N;
          p.set(arr[o], arr[o + 7], arr[o + 1]);
          e.set(0, arr[o + 2], 0);
          q.setFromEuler(e);
          s.set(arr[o + 3], arr[o + 4], arr[o + 5]);
          m.compose(p, q, s);
          mesh.setMatrixAt(i, m);
          c.setHex(arr[o + 6]);
          mesh.setColorAt(i, c);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.matrixAutoUpdate = false;
        if (def.renderOrder) mesh.renderOrder = def.renderOrder;
        parent.add(mesh);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Renderer
// -----------------------------------------------------------------------------
export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x05050c);
  return renderer;
}

// -----------------------------------------------------------------------------
// Car models: extruded side profiles give a proper silhouette in few polys.
// -----------------------------------------------------------------------------
const PROFILES = {
  // Hatchback-coupe, pop-up headlights, ducktail (think late-80s JDM)
  coupe: {
    length: 4.2, width: 1.7, cabinWidth: 1.36,
    body: [[-2.1, 0.28], [2.02, 0.28], [2.1, 0.42], [2.04, 0.6], [0.95, 0.72], [-1.55, 0.78], [-2.08, 0.8], [-2.14, 0.5]],
    cabin: [[0.9, 0.7], [0.05, 1.16], [-0.8, 1.18], [-1.9, 0.82], [-1.9, 0.72]],
    wing: 'ducktail',
  },
  // Four-door turbo sedan with hood scoop and a big rear wing
  sedan: {
    length: 4.4, width: 1.74, cabinWidth: 1.42,
    body: [[-2.2, 0.3], [2.1, 0.3], [2.2, 0.48], [2.12, 0.66], [1.0, 0.78], [-1.45, 0.8], [-2.18, 0.84], [-2.24, 0.55]],
    cabin: [[1.0, 0.76], [0.15, 1.24], [-1.0, 1.26], [-1.55, 0.86], [-1.55, 0.78]],
    wing: 'big',
  },
};

function extrudeProfile(points, width) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  g.translate(0, 0, -width / 2);
  return g;
}

export function buildCarModel(type, time = 'night') {
  const car = CONFIG.cars[type];
  const prof = PROFILES[car.model] || PROFILES.coupe;
  const P = CONFIG.carBase;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Side livery: ExtrudeGeometry caps use (x, y) as uv, so map the profile box to 0..1
  const liv = liveryTexture(car.model, car);
  liv.repeat.set(1 / prof.length, 1 / 0.56);
  liv.offset.set(0.5, -0.28 / 0.56);
  // A little self-illumination keeps the car readable on dark night stages
  const glowOf = (c, k) => new THREE.Color(c).multiplyScalar(k);
  const selfLit = time === 'night' ? 0.28 : 0.1;
  const paint = lambert({ color: car.color, emissive: glowOf(car.color, selfLit) });
  const sidePaint = lambert({ map: liv, emissive: glowOf(0xffffff, selfLit * 0.6), emissiveMap: liv });
  const dark = lambert({ color: 0x15161a });
  const glass = lambert({ color: 0x1a2436, emissive: 0x05080f });
  const lightMat = basic({ color: 0xfff4c8 });
  const tailMat = basic({ color: 0xff2020 });
  const add = (geo, mat, x, y, z, parent = body) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };

  add(extrudeProfile(prof.body, prof.width), [sidePaint, paint], 0, 0, 0);
  add(extrudeProfile(prof.cabin, prof.cabinWidth), [glass, glass], 0, 0, 0);
  // Painted roof panel + A/C pillars hint
  const roofX = (prof.cabin[1][0] + prof.cabin[2][0]) / 2, roofL = prof.cabin[1][0] - prof.cabin[2][0];
  add(new THREE.BoxGeometry(roofL, 0.05, prof.cabinWidth + 0.02), paint, roofX, prof.cabin[2][1] + 0.01, 0);
  // Bumpers / grille
  add(new THREE.BoxGeometry(0.12, 0.22, prof.width - 0.1), dark, prof.length / 2 + 0.02, 0.36, 0);
  add(new THREE.BoxGeometry(0.12, 0.22, prof.width - 0.1), dark, -prof.length / 2 - 0.02, 0.4, 0);
  // Lights
  const front = prof.length / 2;
  for (const side of [-1, 1]) {
    if (car.model === 'coupe') {
      add(new THREE.BoxGeometry(0.34, 0.14, 0.36), paint, front - 0.45, 0.68, side * 0.55);          // pop-up pods
      add(new THREE.BoxGeometry(0.04, 0.1, 0.3), lightMat, front - 0.27, 0.68, side * 0.55);
    } else {
      add(new THREE.BoxGeometry(0.06, 0.12, 0.38), lightMat, front + 0.06, 0.58, side * 0.55);
    }
    add(new THREE.BoxGeometry(0.05, 0.12, 0.42), tailMat, -front - 0.04, 0.66, side * 0.52);
  }
  // Wing
  if (prof.wing === 'big') {
    add(new THREE.BoxGeometry(0.4, 0.05, 1.62), paint, -front + 0.22, 1.2, 0);
    for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.16, 0.34, 0.05), dark, -front + 0.26, 1.0, side * 0.6);
    add(new THREE.BoxGeometry(0.5, 0.08, 0.5), dark, 1.35, 0.8, 0);                                // hood scoop
  } else {
    const lip = add(new THREE.BoxGeometry(0.3, 0.05, 1.5), dark, -front + 0.12, 0.84, 0); lip.rotation.z = 0.25;
  }
  // Exhaust + mudflaps
  add(new THREE.CylinderGeometry(0.06, 0.06, 0.2, 6).rotateZ(Math.PI / 2), dark, -front - 0.05, 0.3, 0.5);

  // Wheels (separate from the body so they don't roll with it)
  const wheelGeo = new THREE.CylinderGeometry(P.wheelRadius, P.wheelRadius, 0.26, 8).rotateX(Math.PI / 2);
  const tyreMat = lambert({ color: 0x141414 });
  const rimGeo = new THREE.CylinderGeometry(P.wheelRadius * 0.62, P.wheelRadius * 0.62, 0.28, 5).rotateX(Math.PI / 2);
  const rimMat = lambert({ color: car.rim });
  const wheels = [];
  const half = P.trackWidth / 2;
  const axF = prof.length / 2 - 0.85, axR = -prof.length / 2 + 0.8;
  for (const [x, z, fr] of [[axF, half, true], [axF, -half, true], [axR, half, false], [axR, -half, false]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, P.wheelRadius, z);
    const w = new THREE.Mesh(wheelGeo, tyreMat);
    w.add(new THREE.Mesh(rimGeo, rimMat));
    pivot.add(w);
    root.add(pivot);
    wheels.push({ pivot, mesh: w, front: fr });
  }

  // Glows: headlight beam on the road, tail-light halos, neon underglow
  const glow = glowTexture(32);
  const night = time === 'night';
  const beam = new THREE.Mesh(new THREE.PlaneGeometry(12, 22).rotateX(-Math.PI / 2).rotateY(-Math.PI / 2),
    additive({ map: beamTexture(), color: 0xfff0d0, opacity: night ? 0.75 : 0.25 }));
  beam.position.set(front + 11, 0.09, 0);
  beam.renderOrder = 4;
  root.add(beam);
  const under = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 3.0).rotateX(-Math.PI / 2),
    additive({ map: glow, color: car.underglow, opacity: night ? 0.9 : 0.55 }));
  under.position.y = 0.08; under.renderOrder = 4;
  root.add(under);
  for (const side of [-1, 1]) {
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6).rotateY(-Math.PI / 2), additive({ map: glow, color: 0xff2020, opacity: 0.9 }));
    halo.position.set(-front - 0.12, 0.66, side * 0.52); halo.renderOrder = 5;
    body.add(halo);
  }
  // Blob shadow
  const shadowTex = pixelTexture(16, 16, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.hypot((x + 0.5) / w * 2 - 1, (y + 0.5) / h * 2 - 1);
      img.data[(y * w + x) * 4 + 3] = Math.round(Math.max(0, 1 - d) * 3) / 3 * 170;
    }
    ctx.putImageData(img, 0, 0);
  });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(prof.length + 0.8, 2.5).rotateX(-Math.PI / 2),
    basic({ map: shadowTex, color: 0x000000, transparent: true, depthWrite: false }));
  shadow.position.y = 0.07; shadow.renderOrder = 3;
  root.add(shadow);

  return { root, body, wheels, beam, under };
}

// -----------------------------------------------------------------------------
// World
// -----------------------------------------------------------------------------
export class World {
  constructor(renderer, stage, carType) {
    this.renderer = renderer;
    this.stage = stage;
    const theme = stage.theme;
    this.time = theme.time || 'dusk';
    this.sky = CONFIG.render.skies[this.time];
    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(this.sky.fog);
    scene.fog = new THREE.Fog(this.sky.fog, this.sky.fogNear, this.sky.fogFar);
    const [hs, hg, hi] = this.sky.hemi;
    scene.add(new THREE.HemisphereLight(hs, hg, hi));
    const sun = new THREE.DirectionalLight(this.sky.sun[0], this.sky.sun[1]);
    sun.position.set(-0.4, 1, 0.5);
    scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, CONFIG.camera.far);
    this.camYaw = 0; this.camPos = new THREE.Vector3(); this.camInit = false;

    this._buildSky();
    this._lampLights = this._lampList(stage);
    this._buildGround(stage);
    this._buildRoad(stage);
    this._buildProps(stage);
    this._buildGates(stage);

    this.car = buildCarModel(carType, this.time);
    scene.add(this.car.root);
    this.wheelSpin = 0;
  }

  // ---- Sky: gradient dome, stars, moon, skyline ring (follows the camera) ----
  _buildSky() {
    const S = this.sky;
    const g = this.skyGroup = new THREE.Group();
    const dome = new THREE.SphereGeometry(250, 16, 10);
    const top = new THREE.Color(S.top), hor = new THREE.Color(S.horizon), fog = new THREE.Color(S.fog);
    const cols = [], pos = dome.attributes.position, c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getY(i) / 250;
      if (t > 0) c.copy(hor).lerp(top, Math.pow(t, 0.55)); else c.copy(hor).lerp(fog, Math.min(1, -t * 4));
      cols.push(c.r, c.g, c.b);
    }
    dome.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const domeMesh = new THREE.Mesh(dome, basic({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    domeMesh.renderOrder = -3;
    g.add(domeMesh);
    if (S.stars) {
      const rng = makeRng('stars');
      const sp = [];
      for (let i = 0; i < 260; i++) {
        const a = rng.range(0, Math.PI * 2), e = Math.asin(rng.range(0.08, 1));
        sp.push(Math.cos(a) * Math.cos(e) * 240, Math.sin(e) * 240, Math.sin(a) * Math.cos(e) * 240);
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
      const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xdfe6ff, size: 1, sizeAttenuation: false, fog: false, depthWrite: false }));
      stars.renderOrder = -2;
      g.add(stars);
    }
    // Moon / low sun
    const moon = new THREE.Mesh(new THREE.PlaneGeometry(26, 26),
      additive({ map: glowTexture(32, true), color: this.time === 'night' ? 0xdfe8ff : 0xffb070, fog: false }));
    moon.position.set(-150, this.time === 'night' ? 110 : 32, -150);
    moon.lookAt(0, 0, 0);
    moon.renderOrder = -2;
    g.add(moon);
    // Skyline ring
    if (S.city) {
      const tex = skylineTexture(this.time);
      tex.repeat.set(3, 1);
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(225, 225, 36, 48, 1, true),
        basic({ map: tex, side: THREE.BackSide, fog: false, alphaTest: 0.5, depthWrite: false }));
      ring.position.y = 12;
      ring.renderOrder = -1;
      g.add(ring);
    }
    this.scene.add(g);
  }

  // ---- Street lamps: head positions used for baked lighting + meshes ----
  _lampList(st) {
    return st.props.lamps.map((l) => {
      // The lamp head hangs 1.8 m over the road from the pole
      const nx = st.nx[l.i], ny = st.ny[l.i];
      return { ...l, hx: l.x - nx * l.side * 1.8, hy: l.y - ny * l.side * 1.8 };
    });
  }

  /** Baked vertex light at a ground point: ambient + sodium lamp pools. */
  _bake(x, y, base, out, noise = 0) {
    const amb = this.sky.ambient + noise;
    out.copy(base).multiplyScalar(amb);
    const L = CONFIG.render.lampColor;
    const lr = ((L >> 16) & 255) / 255, lg = ((L >> 8) & 255) / 255, lb = (L & 255) / 255;
    for (const l of this._lampLights) {
      const dx = x - l.hx, dy = y - l.hy;
      const d2 = dx * dx + dy * dy;
      if (d2 > 225) continue;
      // Hard-ish falloff, quantised later by the 15-bit dither
      const f = Math.max(0, 1 - Math.sqrt(d2) / 15);
      const k = f * f * 1.25;
      out.r += base.r * lr * k + 0.1 * k; out.g += base.g * lg * k + 0.06 * k; out.b += base.b * lb * k;
    }
    return out;
  }

  _buildGround(st) {
    const b = st.bounds, pad = 260;
    const w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2;
    const seg = Math.min(110, Math.ceil(Math.max(w, h) / 18));
    const geo = new THREE.PlaneGeometry(w, h, seg, seg).rotateX(-Math.PI / 2);
    geo.translate((b.minX + b.maxX) / 2, 0, (b.minY + b.maxY) / 2);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    const rng = makeRng('ground' + st.seed);
    const white = new THREE.Color(1, 1, 1), c = new THREE.Color();
    const cols = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      uv.setXY(i, x / 6, z / 6);
      this._bake(x, z, white, c, rng.range(-0.08, 0.05));
      cols.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const ground = new THREE.Mesh(geo, basic({ map: groundTexture(st.theme.ground, !!st.theme.snowy), vertexColors: true }));
    ground.matrixAutoUpdate = false;
    this.scene.add(ground);
  }

  _buildRoad(st) {
    const n = st.count, verge = CONFIG.stage.vergeWidth;
    const NT = ROAD_TILES.length;
    const tileOf = (name) => Math.max(0, ROAD_TILES.indexOf(name));
    const vergeTile = tileOf(st.theme.snowy ? 'snow' : 'verge');
    const pos = [], uvs = [], col = [];
    const white = new THREE.Color(1, 1, 1), c = new THREE.Color();
    const rng = makeRng('road' + st.seed);
    // Precompute edge points per sample: [outerL, edgeL, edgeR, outerR]
    const P = [];
    for (let i = 0; i < n; i++) {
      const x = st.xs[i], y = st.ys[i], nx = st.nx[i], ny = st.ny[i], hw = st.hw[i];
      P.push([-hw - verge - 0.5, -hw, hw, hw + verge + 0.5].map((l) => [x + nx * l, y + ny * l]));
    }
    const light = P.map((row) => row.map(([x, y]) => this._bake(x, y, white, c, rng.range(-0.04, 0.04)).clone()));
    const quad = (i, a, bIdx, u0, u1, v0, v1, yA, yB) => {
      // two triangles, CCW seen from above: (aL, aR, bL), (aR, bR, bL)
      const pa = P[i - 1], pb = P[i], la = light[i - 1], lb = light[i];
      const vs = [[pa[a], la[a], u0, v0, yA], [pa[bIdx], la[bIdx], u1, v0, yB], [pb[a], lb[a], u0, v1, yA],
        [pa[bIdx], la[bIdx], u1, v0, yB], [pb[bIdx], lb[bIdx], u1, v1, yB], [pb[a], lb[a], u0, v1, yA]];
      for (const [[x, y], L, u, v, yy] of vs) { pos.push(x, yy, y); uvs.push(u, v); col.push(L.r, L.g, L.b); }
    };
    const REP = 16;   // metres of road per texture repeat
    for (let i = 1; i < n; i++) {
      const v0 = ((i - 1) * st.ds) / REP, v1 = (i * st.ds) / REP;
      const t = tileOf(st.surf[i - 1]);
      const u = (k) => (t + k) / NT;
      quad(i, 1, 2, u(0.02), u(0.98), v0, v1, 0.04, 0.04);                        // road
      const vu = (k) => (vergeTile + k) / NT;
      quad(i, 0, 1, vu(0.05), vu(0.95), v0, v1, 0.005, 0.03);                     // left verge
      quad(i, 2, 3, vu(0.95), vu(0.05), v0, v1, 0.03, 0.005);                     // right verge
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const atlas = roadAtlas();
    atlas.wrapS = THREE.ClampToEdgeWrapping; atlas.wrapT = THREE.RepeatWrapping;
    const road = new THREE.Mesh(geo, basic({ map: atlas, vertexColors: true }));
    road.matrixAutoUpdate = false;
    this.scene.add(road);
  }

  _buildProps(st) {
    const snowy = !!st.theme.snowy;
    const glowTex = glowTexture(16);
    const defs = {
      tree: {  // Japanese cedar: tall trunk, three stacked cones
        geometry: mergeColored([
          { geo: new THREE.CylinderGeometry(0.16, 0.26, 2.2, 5).translate(0, 1.1, 0), color: 0x4a3322 },
          { geo: new THREE.ConeGeometry(1.5, 2.6, 6).translate(0, 2.8, 0), color: snowy ? 0x1f3a2c : 0x1d3d24 },
          { geo: new THREE.ConeGeometry(1.2, 2.3, 6).translate(0, 4.0, 0), color: snowy ? 0x2a4a38 : 0x24492b },
          { geo: new THREE.ConeGeometry(0.8, 2.0, 6).translate(0, 5.2, 0), color: snowy ? 0xdfe8f2 : 0x2c5733 },
        ]),
        material: lambert({ vertexColors: true }),
      },
      rock: { geometry: mergeColored([{ geo: new THREE.IcosahedronGeometry(1, 0), color: 0xffffff }]), material: lambert({ vertexColors: true }) },
      tires: {
        geometry: mergeColored([0, 1, 2].map((k) => ({ geo: new THREE.CylinderGeometry(0.52, 0.52, 0.3, 8).translate(0, 0.15 + k * 0.3, 0), color: k % 2 ? 0x222222 : 0x151515 }))),
        material: lambert({ vertexColors: true }),
      },
      post: { geometry: new THREE.BoxGeometry(0.12, 0.8, 0.12).translate(0, 0.4, 0), material: lambert({ color: 0x9aa0a6 }) },
      rail: { geometry: new THREE.BoxGeometry(1, 0.3, 0.06).translate(0, 0.62, 0), material: lambert({ color: 0xffffff }) },
      delin: { geometry: new THREE.BoxGeometry(0.08, 0.9, 0.08).translate(0, 0.45, 0), material: lambert({ color: 0xe8e8e8 }) },
      reflector: { geometry: new THREE.BoxGeometry(0.1, 0.12, 0.1).translate(0, 0.86, 0), material: basic({ color: 0xffffff }) },
      lampPole: { geometry: new THREE.BoxGeometry(0.16, 6, 0.16).translate(0, 3, 0), material: lambert({ color: 0x70747a }) },
      lampArm: { geometry: new THREE.BoxGeometry(1, 0.1, 0.1).translate(0.5, 5.95, 0), material: lambert({ color: 0x70747a }) },
      lampHead: { geometry: new THREE.BoxGeometry(0.7, 0.14, 0.32).translate(0, 5.86, 0), material: basic({ color: 0xffd28a }) },
      lampHalo: {
        geometry: new THREE.PlaneGeometry(4.5, 4.5).rotateX(-Math.PI / 2).translate(0, 5.7, 0),
        material: additive({ map: glowTex, color: CONFIG.render.lampColor, opacity: 0.8, side: THREE.DoubleSide }), renderOrder: 6,
      },
      body: { geometry: new THREE.CylinderGeometry(0.22, 0.28, 1.15, 5).translate(0, 0.58, 0), material: lambert({ color: 0xffffff }) },
      head: { geometry: new THREE.BoxGeometry(0.28, 0.28, 0.28).translate(0, 1.32, 0), material: lambert({ color: 0xe0b090 }) },
    };
    const B = new ChunkedInstances(CONFIG.render.chunkSize);
    const P = st.props;
    const grey = (v) => { const c = Math.round(clamp(v, 0, 1) * 255); return (c << 16) | (c << 8) | c; };
    for (const t of P.trees) B.add('tree', t.x, t.y, t.rot, t.scale, t.scale * (0.9 + 0.35 * (t.shade - 0.75)), t.scale, grey(t.shade * 0.85));
    for (const r of P.rocks) B.add('rock', r.x, r.y, r.rot, r.r, r.r * r.sy, r.r * 1.1, snowy ? 0xd6dbe2 : grey(0.45 + (r.rot % 1) * 0.15));
    for (const h of P.tires) B.add('tires', h.x, h.y, 0, 1, h.h / 3, 1, 0xffffff);
    for (const p of P.fencePosts) B.add('post', p.x, p.y, 0, 1, 1, 1, 0xffffff);
    for (const r of P.fenceRails) {
      const dx = r.x2 - r.x1, dy = r.y2 - r.y1;
      B.add('rail', (r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2, -Math.atan2(dy, dx), Math.hypot(dx, dy) + 0.05, 1, 1, r.color);
    }
    for (const p of P.posts) {
      B.add('delin', p.x, p.y, 0, 1, 1, 1, 0xffffff);
      B.add('reflector', p.x, p.y, 0, 1, 1, 1, 0xff9a20);
    }
    for (const l of this._lampLights) {
      const ang = Math.atan2(l.hy - l.y, l.hx - l.x);
      B.add('lampPole', l.x, l.y, 0, 1, 1, 1, 0xffffff);
      B.add('lampArm', l.x, l.y, -ang, 1.8, 1, 1, 0xffffff);
      B.add('lampHead', l.hx, l.hy, -ang, 1, 1, 1, 0xffffff);
      B.add('lampHalo', l.hx, l.hy, 0, 1, 1, 1, 0xffffff);
    }
    const shirt = [0xe84a3a, 0x3a7be8, 0xf2c230, 0x2fb36a, 0xffffff, 0x222222, 0xf07bd0, 0xff8a1f];
    for (const s of P.spectators) {
      B.add('body', s.x, s.y, -s.rot, 1, 1, 1, shirt[s.color]);
      B.add('head', s.x, s.y, -s.rot, 1, 1, 1, 0xffffff);
    }
    B.build(this.scene, defs);

    // Vending machines: glowing boxes with a pixel-art drinks panel
    const vtex = pixelTexture(8, 16, (ctx) => {
      ctx.fillStyle = '#dfe8f0'; ctx.fillRect(0, 0, 8, 16);
      const cols = ['#e83a3a', '#3a7be8', '#f2c230', '#2fb36a', '#ff8a1f'];
      for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) { ctx.fillStyle = cols[(r * 4 + k) % 5]; ctx.fillRect(1 + k * 2 - (k > 1 ? 1 : 0), 2 + r * 3, 1, 2); }
      ctx.fillStyle = '#202830'; ctx.fillRect(1, 12, 6, 2);
    });
    for (const v of P.vending) {
      const g = new THREE.Group();
      g.position.set(v.x, 0, v.y); g.rotation.y = -v.rot;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.8, 0.75).translate(0, 0.9, 0), lambert({ color: v.color }));
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 1.4).rotateY(-Math.PI / 2), basic({ map: vtex }));
      panel.position.set(-0.41, 1.0, 0);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(6, 6).rotateX(-Math.PI / 2), additive({ map: glowTex, color: 0xbfe6ff, opacity: 0.35 }));
      glow.position.set(-1.5, 0.08, 0); glow.renderOrder = 4;
      g.add(box, panel, glow);
      this.scene.add(g);
    }
  }

  _buildGates(st) {
    for (const g of st.props.gates) {
      const i = g.i;
      const x = st.xs[i], y = st.ys[i], h = st.heading[i], hw = st.hw[i] + 1.2;
      const grp = new THREE.Group();
      grp.position.set(x, 0, y);
      grp.rotation.y = -h;
      const label = g.kind === 'finish' ? 'FINISH' : g.kind === 'start' ? 'START' : `CHECKPOINT ${g.n}`;
      const postMat = lambert({ color: 0x2a2a30 });
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 5, 0.25), postMat);
        post.position.set(0, 2.5, side * hw);
        grp.add(post);
      }
      // Banner: two planes back to back so the text reads from both directions (unlit: readable at night)
      const bannerMat = basic({ map: bannerTexture(g.kind, label) });
      const plane = new THREE.PlaneGeometry(hw * 2, hw * 2 / 8);
      const front = new THREE.Mesh(plane, bannerMat);
      front.position.set(-0.08, 4.6, 0); front.rotation.y = -Math.PI / 2;
      const back = new THREE.Mesh(plane, bannerMat);
      back.position.set(0.08, 4.6, 0); back.rotation.y = Math.PI / 2;
      grp.add(front, back);
      if (g.kind !== 'checkpoint') {
        const tex = pixelTexture(4, 16, (ctx, w, hh) => {
          for (let cx = 0; cx < w; cx += 2) for (let cy = 0; cy < hh; cy += 2) { ctx.fillStyle = ((cx + cy) / 2) % 2 ? '#eee' : '#111'; ctx.fillRect(cx, cy, 2, 2); }
        });
        const line = new THREE.Mesh(new THREE.PlaneGeometry(1.0, hw * 2 - 2.4).rotateX(-Math.PI / 2),
          basic({ map: g.kind === 'finish' ? tex : null, color: g.kind === 'finish' ? 0xffffff : 0xdddddd }));
        line.position.y = 0.06;
        grp.add(line);
      }
      this.scene.add(grp);
    }
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Sync the car model and chase camera with the physics state. */
  update(dt, car, snapCamera = false) {
    const m = this.car;
    m.root.position.set(car.x, 0, car.y);
    m.root.rotation.y = -car.h;
    // Body roll/pitch from accelerations (purely visual, exaggerated = arcade)
    const roll = clamp(-car.accelLat * 0.016, -0.1, 0.1);
    const pitch = clamp(car.axFilt * 0.012, -0.07, 0.07);
    m.body.rotation.x += (roll - m.body.rotation.x) * Math.min(1, dt * 8);
    m.body.rotation.z += (pitch - m.body.rotation.z) * Math.min(1, dt * 8);
    this.wheelSpin -= car.fx.wheelOmega * dt;
    for (const w of m.wheels) {
      if (w.front) w.pivot.rotation.y = -car.steer;
      if (!(car.fx.handbrake && !w.front)) w.mesh.rotation.z = this.wheelSpin;
    }

    // ---- Chase camera -------------------------------------------------------
    const C = CONFIG.camera;
    const cam = this.camera;
    const portrait = cam.aspect < 1;
    const speed = car.speed;
    let desiredYaw = car.h;
    if (speed > 3 && car.u > 0) {
      const velYaw = Math.atan2(car.vy, car.vx);
      desiredYaw = car.h + clamp(wrap(velYaw - car.h), -1.1, 1.1) * C.driftSwing;
    }
    if (snapCamera || !this.camInit) this.camYaw = desiredYaw;
    this.camYaw += wrap(desiredYaw - this.camYaw) * Math.min(1, C.yawStiffness * dt);
    const dist = C.distance * (portrait ? C.portraitDistanceScale : 1);
    const height = portrait ? C.portraitHeight : C.height;
    const tx = car.x - Math.cos(this.camYaw) * dist, tz = car.y - Math.sin(this.camYaw) * dist;
    if (snapCamera || !this.camInit) { this.camPos.set(tx, height, tz); this.camInit = true; }
    const k = Math.min(1, C.posStiffness * dt);
    this.camPos.x += (tx - this.camPos.x) * k;
    this.camPos.z += (tz - this.camPos.z) * k;
    this.camPos.y += (height - this.camPos.y) * k;
    const ddx = this.camPos.x - car.x, ddz = this.camPos.z - car.y;
    const dd = Math.hypot(ddx, ddz);
    if (dd < dist * 0.7) { this.camPos.x = car.x + ddx / dd * dist * 0.7; this.camPos.z = car.y + ddz / dd * dist * 0.7; }
    cam.position.copy(this.camPos);
    const ahead = portrait ? C.portraitLookAhead : C.lookAhead;
    cam.lookAt(car.x + Math.cos(this.camYaw) * ahead, C.lookHeight, car.y + Math.sin(this.camYaw) * ahead);
    const fov = (portrait ? C.fovPortrait : C.fovLandscape) + C.speedFov * clamp(speed / 50, 0, 1);
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 3); cam.updateProjectionMatrix(); }
    this.skyGroup.position.set(cam.position.x, 0, cam.position.z);
  }

  render() { this.renderer.render(this.scene, this.camera); }

  dispose() {
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const mt of mats) { if (mt.map) mt.map.dispose(); mt.dispose(); }
      if (o.isInstancedMesh) o.dispose();
    });
  }
}
