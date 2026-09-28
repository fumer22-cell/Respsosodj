// =============================================================================
//  Rendering: builds the 3D world for a Stage (road, ground, instanced props,
//  gates), the low-poly car, and the chase camera.
//
//  Physics (x, y) maps to three.js (x, 0, y). A physics heading h maps to
//  rotation.y = -h. Models are built with their nose along +x.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { makeRng } from './rng.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

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

function canvasTexture(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Collects instances per spatial chunk so each chunk can be frustum-culled. */
class ChunkedInstances {
  constructor(size) { this.size = size; this.types = new Map(); }
  add(type, x, z, rotY, sx, sy, sz, color) {
    let chunks = this.types.get(type);
    if (!chunks) this.types.set(type, chunks = new Map());
    const key = `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`;
    let arr = chunks.get(key);
    if (!arr) chunks.set(key, arr = []);
    arr.push(x, z, rotY, sx, sy, sz, color);
  }
  build(parent, defs) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const e = new THREE.Euler(), c = new THREE.Color();
    for (const [type, chunks] of this.types) {
      const def = defs[type];
      for (const arr of chunks.values()) {
        const count = arr.length / 7;
        const mesh = new THREE.InstancedMesh(def.geometry, def.material, count);
        for (let i = 0; i < count; i++) {
          const o = i * 7;
          p.set(arr[o], def.y || 0, arr[o + 1]);
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
  renderer.setClearColor(0x9fc3e3);
  return renderer;
}

// -----------------------------------------------------------------------------
// Car model
// -----------------------------------------------------------------------------
export function buildCarModel(type) {
  const car = CONFIG.cars[type];
  const P = CONFIG.carBase;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const paint = new THREE.MeshLambertMaterial({ color: car.color });
  const accent = new THREE.MeshLambertMaterial({ color: car.accent });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1b1f26 });
  const glass = new THREE.MeshLambertMaterial({ color: 0x223344, emissive: 0x0a1420 });
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff6d0 });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a });

  const add = (geo, mat, x, y, z, parent = body) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
  // Lower body + bumpers
  add(new THREE.BoxGeometry(3.9, 0.5, 1.72), paint, 0, 0.55, 0);
  add(new THREE.BoxGeometry(0.3, 0.32, 1.66), dark, 2.0, 0.42, 0);
  add(new THREE.BoxGeometry(0.3, 0.32, 1.66), dark, -2.0, 0.42, 0);
  // Bonnet slope and cabin
  const bonnet = add(new THREE.BoxGeometry(1.3, 0.2, 1.6), paint, 1.3, 0.86, 0); bonnet.rotation.z = -0.12;
  add(new THREE.BoxGeometry(1.9, 0.52, 1.5), glass, -0.25, 1.05, 0);
  add(new THREE.BoxGeometry(1.6, 0.1, 1.44), paint, -0.35, 1.34, 0);   // roof
  add(new THREE.BoxGeometry(0.2, 0.05, 1.3), accent, -0.35, 1.41, 0);  // roof vent
  // Livery stripe
  add(new THREE.BoxGeometry(3.92, 0.12, 0.5), accent, 0, 0.72, 0);
  add(new THREE.BoxGeometry(0.8, 0.02, 0.62), accent, 1.3, 0.98, 0);
  // Door number plates
  for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.7, 0.34, 0.02), accent, -0.2, 0.6, side * 0.87);
  // Rear wing
  add(new THREE.BoxGeometry(0.45, 0.06, 1.7), dark, -1.85, 1.28, 0);
  for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.2, 0.36, 0.06), dark, -1.8, 1.08, side * 0.7);
  // Lights
  for (const side of [-1, 1]) {
    add(new THREE.BoxGeometry(0.06, 0.16, 0.34), lightMat, 1.96, 0.66, side * 0.56);
    add(new THREE.BoxGeometry(0.06, 0.14, 0.3), tailMat, -1.96, 0.7, side * 0.6);
    add(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 10).rotateZ(Math.PI / 2), lightMat, 2.14, 0.52, side * 0.35); // spot lamps
  }
  // Mud flaps
  for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.04, 0.3, 0.3), dark, -1.62, 0.25, side * 0.72);

  // Wheels (separate from the body so they don't roll with it)
  const wheelGeo = new THREE.CylinderGeometry(P.wheelRadius, P.wheelRadius, 0.26, 12).rotateX(Math.PI / 2);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x151515 });
  const rimGeo = new THREE.CylinderGeometry(P.wheelRadius * 0.6, P.wheelRadius * 0.6, 0.27, 6).rotateX(Math.PI / 2);
  const rimMat = new THREE.MeshLambertMaterial({ color: 0xd9dde2 });
  const wheels = [];
  const half = P.trackWidth / 2;
  for (const [x, z, front] of [[P.cgToFront, half, true], [P.cgToFront, -half, true], [-P.cgToRear, half, false], [-P.cgToRear, -half, false]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, P.wheelRadius, z);
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.add(new THREE.Mesh(rimGeo, rimMat));
    pivot.add(w);
    root.add(pivot);
    wheels.push({ pivot, mesh: w, front });
  }

  // Soft blob shadow
  const shadowTex = canvasTexture(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 2.8).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.position.y = 0.05;
  shadow.renderOrder = 1;
  root.add(shadow);

  return { root, body, wheels };
}

// -----------------------------------------------------------------------------
// World
// -----------------------------------------------------------------------------
export class World {
  constructor(renderer, stage, carType) {
    this.renderer = renderer;
    this.stage = stage;
    const scene = this.scene = new THREE.Scene();
    const snowy = !!stage.theme.snowy;
    const sky = snowy ? 0xc9d5e2 : 0x9fc3e3;
    scene.background = new THREE.Color(sky);
    scene.fog = new THREE.Fog(sky, CONFIG.render.fogNear, CONFIG.render.fogFar);

    scene.add(new THREE.HemisphereLight(0xdfefff, snowy ? 0x9aa6b4 : 0x4a5a30, 1.25));
    const sun = new THREE.DirectionalLight(0xfff1d8, 1.6);
    sun.position.set(0.5, 1, 0.3);
    scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, CONFIG.camera.far);
    this.camYaw = 0; this.camPos = new THREE.Vector3(); this.camInit = false;

    this._buildGround(stage);
    this._buildRoad(stage);
    this._buildProps(stage);
    this._buildGates(stage);

    this.car = buildCarModel(carType);
    scene.add(this.car.root);
    this.wheelSpin = 0;
  }

  _buildGround(st) {
    const b = st.bounds, pad = 380;
    const w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2;
    const seg = Math.min(90, Math.ceil(Math.max(w, h) / 30));
    const geo = new THREE.PlaneGeometry(w, h, seg, seg).rotateX(-Math.PI / 2);
    geo.translate((b.minX + b.maxX) / 2, 0, (b.minY + b.maxY) / 2);
    const rng = makeRng('ground' + st.seed);
    const base = new THREE.Color(st.theme.ground);
    const cols = [];
    const c = new THREE.Color();
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const v = rng.range(-0.06, 0.06);
      c.copy(base).offsetHSL(rng.range(-0.015, 0.015), 0, v);
      cols.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    ground.matrixAutoUpdate = false;
    this.scene.add(ground);
  }

  _buildRoad(st) {
    const n = st.count, verge = CONFIG.stage.vergeWidth;
    const rng = makeRng('road' + st.seed);
    const ground = new THREE.Color(st.theme.ground);
    const surfCol = {};
    for (const [k, v] of Object.entries(CONFIG.surfaces)) surfCol[k] = new THREE.Color(v.color);
    // Road colour per sample, blended over neighbours so surface changes fade.
    const roadCols = [];
    for (let i = 0; i < n; i++) {
      const c = new THREE.Color(0, 0, 0);
      let cnt = 0;
      for (let j = i - 5; j <= i + 5; j++) if (j >= 0 && j < n) { c.add(surfCol[st.surf[j]]); cnt++; }
      c.multiplyScalar(1 / cnt);
      c.offsetHSL(0, 0, rng.range(-0.025, 0.025));
      roadCols.push(c);
    }
    const pos = [], col = [], idx = [];
    const Y_ROAD = 0.04, Y_VERGE = 0.03;
    for (let i = 0; i < n; i++) {
      const x = st.xs[i], y = st.ys[i], nx = st.nx[i], ny = st.ny[i], hw = st.hw[i];
      const lats = [-hw - verge - 0.6, -hw, -hw, hw, hw, hw + verge + 0.6];
      const ys = [0.005, Y_VERGE, Y_ROAD, Y_ROAD, Y_VERGE, 0.005];
      const rc = roadCols[i];
      const vc = rc.clone().lerp(ground, 0.45).offsetHSL(0, -0.05, -0.04);
      const cs = [ground, vc, rc, rc, vc, ground];
      for (let k = 0; k < 6; k++) {
        pos.push(x + nx * lats[k], ys[k], y + ny * lats[k]);
        col.push(cs[k].r, cs[k].g, cs[k].b);
      }
      if (i > 0) {
        const a = (i - 1) * 6, b = i * 6;
        for (const [p, q] of [[0, 1], [2, 3], [4, 5]]) {
          idx.push(a + p, a + q, b + p, a + q, b + q, b + p);   // CCW seen from above
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const road = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    road.matrixAutoUpdate = false;
    this.scene.add(road);

    // Dashed centre line on tarmac sections
    const dpos = [], didx = [];
    for (let i = 0; i < n - 2; i += 5) {
      if (st.surf[i] !== 'tarmac' || st.surf[i + 2] !== 'tarmac') continue;
      const base = dpos.length / 3;
      for (const j of [i, i + 2]) {
        for (const l of [-0.08, 0.08]) dpos.push(st.xs[j] + st.nx[j] * l, 0.05, st.ys[j] + st.ny[j] * l);
      }
      didx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
    if (dpos.length) {
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.Float32BufferAttribute(dpos, 3));
      dg.setIndex(didx);
      const dm = new THREE.Mesh(dg, new THREE.MeshBasicMaterial({ color: 0xe8e4d0 }));
      dm.matrixAutoUpdate = false;
      this.scene.add(dm);
    }
  }

  _buildProps(st) {
    const snowy = !!st.theme.snowy;
    const lam = (opts) => new THREE.MeshLambertMaterial(opts);
    const defs = {
      tree: {
        geometry: mergeColored([
          { geo: new THREE.CylinderGeometry(0.2, 0.3, 1.6, 5).translate(0, 0.8, 0), color: 0x5a3d26 },
          { geo: new THREE.ConeGeometry(1.7, 3.4, 7).translate(0, 2.9, 0), color: snowy ? 0x2c4a36 : 0x2f5d2a },
          { geo: new THREE.ConeGeometry(1.2, 2.6, 7).translate(0, 4.5, 0), color: snowy ? 0xe8eef4 : 0x3b7032 },
        ]),
        material: lam({ vertexColors: true }),
      },
      rock: {
        geometry: mergeColored([{ geo: new THREE.IcosahedronGeometry(1, 0), color: 0xffffff }]),
        material: lam({ vertexColors: true, flatShading: true }),
      },
      hay: {
        geometry: mergeColored([{ geo: new THREE.CylinderGeometry(0.62, 0.62, 1.2, 10).rotateZ(Math.PI / 2).translate(0, 0.62, 0), color: 0xd9b95a }]),
        material: lam({ vertexColors: true }),
      },
      post: {
        geometry: new THREE.BoxGeometry(0.1, 1.1, 0.1).translate(0, 0.55, 0),
        material: lam({ color: 0x9a9a9a }),
      },
      rail: {
        geometry: new THREE.BoxGeometry(1, 0.14, 0.04).translate(0, 0.85, 0),
        material: lam({ color: 0xffffff }),
      },
      body: {
        geometry: new THREE.CylinderGeometry(0.22, 0.28, 1.15, 6).translate(0, 0.58, 0),
        material: lam({ color: 0xffffff }),
      },
      head: {
        geometry: new THREE.SphereGeometry(0.17, 6, 4).translate(0, 1.35, 0),
        material: lam({ color: 0xe8b894 }),
      },
    };
    const B = new ChunkedInstances(CONFIG.render.chunkSize);
    const P = st.props;
    const grey = (v) => { const c = Math.round(clamp(v, 0, 1) * 255); return (c << 16) | (c << 8) | c; };
    for (const t of P.trees) B.add('tree', t.x, t.y, t.rot, t.scale, t.scale * (0.85 + 0.3 * (t.shade - 0.75)), t.scale, grey(t.shade * 0.9));
    for (const r of P.rocks) B.add('rock', r.x, r.y, r.rot, r.r, r.r * r.sy, r.r * 1.1, snowy ? 0xd6dbe2 : grey(0.5 + (r.rot % 1) * 0.15));
    for (const h of P.hay) B.add('hay', h.x, h.y, -h.rot, 1, 1, 1, 0xffffff);
    for (const p of P.fencePosts) B.add('post', p.x, p.y, 0, 1, 1, 1, 0xffffff);
    for (const r of P.fenceRails) {
      const dx = r.x2 - r.x1, dy = r.y2 - r.y1;
      B.add('rail', (r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2, -Math.atan2(dy, dx), Math.hypot(dx, dy), 1, 1, r.color);
    }
    const shirt = [0xe84a3a, 0x3a7be8, 0xf2c230, 0x2fb36a, 0xffffff, 0x222222, 0xf07bd0, 0xff8a1f];
    for (const s of P.spectators) {
      B.add('body', s.x, s.y, -s.rot, 1, 1, 1, shirt[s.color]);
      B.add('head', s.x, s.y, 0, 1, 1, 1, 0xffffff);
    }
    B.build(this.scene, defs);
  }

  _buildGates(st) {
    for (const g of st.props.gates) {
      const i = g.i;
      const x = st.xs[i], y = st.ys[i], h = st.heading[i], hw = st.hw[i] + 1.2;
      const grp = new THREE.Group();
      grp.position.set(x, 0, y);
      grp.rotation.y = -h;
      const color = g.kind === 'finish' ? '#111' : g.kind === 'start' ? '#1b5e20' : '#f2b705';
      const label = g.kind === 'finish' ? 'FINISH' : g.kind === 'start' ? 'START' : `CHECKPOINT ${g.n}`;
      const tex = canvasTexture(512, 64, (ctx, w, hh) => {
        if (g.kind === 'finish') {
          for (let cx = 0; cx < w; cx += 16) for (let cy = 0; cy < hh; cy += 16) {
            ctx.fillStyle = ((cx + cy) / 16) % 2 ? '#fff' : '#111'; ctx.fillRect(cx, cy, 16, 16);
          }
          ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(w * 0.25, 8, w * 0.5, hh - 16);
        } else { ctx.fillStyle = color; ctx.fillRect(0, 0, w, hh); }
        ctx.fillStyle = g.kind === 'checkpoint' ? '#111' : '#fff';
        ctx.font = 'bold 40px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, w / 2, hh / 2 + 2);
      });
      const postMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 5, 0.25), postMat);
        post.position.set(0, 2.5, side * hw);
        grp.add(post);
      }
      // Banner: two planes back to back so the text reads from both directions
      const bannerMat = new THREE.MeshLambertMaterial({ map: tex });
      const plane = new THREE.PlaneGeometry(hw * 2, 0.9);
      const front = new THREE.Mesh(plane, bannerMat);
      front.position.set(-0.08, 4.6, 0); front.rotation.y = -Math.PI / 2;
      const back = new THREE.Mesh(plane, bannerMat);
      back.position.set(0.08, 4.6, 0); back.rotation.y = Math.PI / 2;
      grp.add(front, back);
      // Line across the road
      if (g.kind !== 'checkpoint') {
        const lineTex = canvasTexture(256, 16, (ctx, w, hh) => {
          for (let cx = 0; cx < w; cx += 8) for (let cy = 0; cy < hh; cy += 8) {
            ctx.fillStyle = ((cx + cy) / 8) % 2 ? '#fff' : '#111'; ctx.fillRect(cx, cy, 8, 8);
          }
        });
        const line = new THREE.Mesh(new THREE.PlaneGeometry(1.0, hw * 2 - 2.4).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ map: g.kind === 'finish' ? lineTex : null, color: g.kind === 'finish' ? 0xffffff : 0xf0f0f0 }));
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
    // Body roll/pitch from accelerations (purely visual)
    const roll = clamp(-car.accelLat * 0.012, -0.08, 0.08);
    const pitch = clamp(car.axFilt * 0.01, -0.06, 0.06);
    m.body.rotation.x += (roll - m.body.rotation.x) * Math.min(1, dt * 8);
    m.body.rotation.z += (pitch - m.body.rotation.z) * Math.min(1, dt * 8);
    this.wheelSpin -= car.fx.wheelOmega * dt;
    for (const w of m.wheels) {
      if (w.front) w.pivot.rotation.y = -car.steer;
      w.mesh.rotation.z = car.fx.handbrake && !w.front ? w.mesh.rotation.z : this.wheelSpin;
    }

    // ---- Chase camera -------------------------------------------------------
    const C = CONFIG.camera;
    const cam = this.camera;
    const portrait = cam.aspect < 1;
    const speed = car.speed;
    let desiredYaw = car.h;
    if (speed > 3 && car.u > 0) {
      // Swing toward the velocity direction when the car slides
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
    // Keep a minimum distance so a hard stop doesn't swallow the camera
    const ddx = this.camPos.x - car.x, ddz = this.camPos.z - car.y;
    const dd = Math.hypot(ddx, ddz);
    if (dd < dist * 0.7) { this.camPos.x = car.x + ddx / dd * dist * 0.7; this.camPos.z = car.y + ddz / dd * dist * 0.7; }
    cam.position.copy(this.camPos);
    const ahead = portrait ? C.portraitLookAhead : C.lookAhead;
    cam.lookAt(car.x + Math.cos(this.camYaw) * ahead, C.lookHeight, car.y + Math.sin(this.camYaw) * ahead);
    const fov = (portrait ? C.fovPortrait : C.fovLandscape) + C.speedFov * clamp(speed / 45, 0, 1);
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 3); cam.updateProjectionMatrix(); }
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
