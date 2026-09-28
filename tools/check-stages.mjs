// Generates many stages, checks they never cross themselves, and drives each
// with the autopilot to estimate stage time. Run: node tools/check-stages.mjs [count]
import { Stage } from '../js/stage.js';
import { Car, CollisionWorld } from '../js/physics.js';
import { carParams } from '../js/config.js';
import { autopilot } from './autopilot.js';

const count = Number(process.argv[2] || 6);
const DT = 1 / 120;
let failed = 0;
for (const diff of ['easy', 'normal', 'hard']) {
  const times = [];
  for (let s = 0; s < count; s++) {
    const seed = 'CHK' + s;
    const t0 = performance.now();
    const st = new Stage(seed, diff);
    const genMs = performance.now() - t0;
    if (!Stage.selfClear(st.xs, st.ys, st.ds, 16)) { console.log(`FAIL ${diff} ${seed}: road too close to itself`); failed++; }
    const car = new Car(carParams('awd'));
    const world = new CollisionWorld(st.colliders);
    const i0 = st.startIndex;
    car.reset(st.xs[i0], st.ys[i0], st.heading[i0], i0);
    // Same rules as the game: >4 s off the road = reset to last checkpoint + 5 s
    let t = 0, hits = 0, off = 0, resets = 0, offTimer = 0, cp = 0, stuck = 0;
    while (car.hint < st.finishIndex && t < 400) {
      car.step(DT, autopilot(car, st), st, world);
      if (car.fx.impact > 2) hits++;
      while (cp < st.checkpoints.length && car.hint >= st.checkpoints[cp]) cp++;
      if (car.proj.edge > 3.6) { off += DT; offTimer += DT; } else offTimer = Math.max(0, offTimer - 2 * DT);
      t += DT;
      stuck = car.speed < 1 ? stuck + DT : 0;
      if (offTimer > 4 || stuck > 3) {
        const ri = cp > 0 ? st.checkpoints[cp - 1] : st.startIndex;
        car.reset(st.xs[ri], st.ys[ri], st.heading[ri], ri);
        t += 5; resets++; offTimer = 0; stuck = -2;
      }
    }
    const done = car.hint >= st.finishIndex;
    times.push(t);
    console.log(`${done ? 'ok  ' : 'FAIL'} ${diff.padEnd(6)} ${seed}  ${st.theme.name.padEnd(13)} ${(st.length / 1000).toFixed(2)} km  corners ${String(st.corners.length).padStart(2)}  props ${st.colliders.circles.length}  gen ${genMs.toFixed(0)}ms  bot time ${t.toFixed(1)}s  hits ${hits}  offroad ${off.toFixed(1)}s  resets ${resets}`);
    if (!done) failed++;
  }
  console.log(`   ${diff}: bot times ${Math.min(...times).toFixed(0)}–${Math.max(...times).toFixed(0)} s\n`);
}
if (failed) { console.log(`${failed} problem(s)`); process.exit(1); }
console.log('All stages OK');
