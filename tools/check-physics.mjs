// Sanity checks for the car physics on a flat, infinite surface.
// Run: node tools/check-physics.mjs
import { Car } from '../js/physics.js';
import { carParams } from '../js/config.js';

const flat = (surface) => ({
  project(x, y, hint, out) { out.i = 0; out.s = x; out.lat = 0; out.hw = 99; out.edge = -99; out.surface = surface; return out; },
});
const DT = 1 / 120;
const run = (car, st, secs, input) => { for (let t = 0; t < secs; t += DT) car.step(DT, input(t), st, null); };
const kmh = (c) => (c.speed * 3.6).toFixed(0);
let failed = 0;
const check = (name, ok, info) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`); if (!ok) failed++; };

for (const type of ['rwd', 'awd']) {
  for (const surf of ['tarmac', 'gravel', 'snow']) {
    const car = new Car(carParams(type)); const st = flat(surf);
    let t100 = null, t = 0;
    for (; t < 30; t += DT) { car.step(DT, { throttle: 1, brake: 0, steer: 0 }, st, null); if (t100 === null && car.speed > 27.78) t100 = t; }
    check(`${type}/${surf} 0-100`, t100 !== null && t100 < (surf === 'snow' ? 20 : 12), `${t100?.toFixed(2)}s, 30s speed ${kmh(car)} km/h gear ${car.gear}`);
    check(`${type}/${surf} straight`, Math.abs(car.h) < 0.05, `heading drift ${car.h.toFixed(3)}`);
    // Brake from speed
    const v0 = car.speed; let tb = 0;
    while (car.speed > 0.1 && tb < 20) { car.step(DT, { throttle: 0, brake: 1, steer: 0 }, st, null); tb += DT; }
    check(`${type}/${surf} brake`, tb < (surf === 'snow' ? 16 : 10), `${(v0 * 3.6).toFixed(0)}->0 in ${tb.toFixed(2)}s`);
  }
  // Steady cornering on gravel: should turn, not blow up
  const car = new Car(carParams(type)); const st = flat('gravel');
  run(car, st, 4, () => ({ throttle: 0.7, brake: 0, steer: 0 }));
  run(car, st, 4, () => ({ throttle: 0.5, brake: 0, steer: 0.6 }));
  check(`${type} cornering finite`, Number.isFinite(car.x) && Math.abs(car.w) < 5, `speed ${kmh(car)} yaw ${car.w.toFixed(2)} slipR ${car.fx.slipRear.toFixed(2)}`);
  // Handbrake at speed rotates the car
  const c2 = new Car(carParams(type));
  run(c2, st, 5, () => ({ throttle: 1, brake: 0, steer: 0 }));
  const h0 = c2.h;
  run(c2, st, 0.6, () => ({ throttle: 0, brake: 0, steer: 0.5, handbrake: true }));
  run(c2, st, 0.6, () => ({ throttle: 0.6, brake: 0, steer: 0.2 }));
  check(`${type} handbrake turn`, Math.abs(c2.h - h0) > 0.5, `rotated ${(c2.h - h0).toFixed(2)} rad, slip ${(c2.fx.slipRear).toFixed(2)}`);
  // Reverse
  const c3 = new Car(carParams(type));
  run(c3, flat('tarmac'), 3, () => ({ throttle: 0, brake: 0.8, steer: 0 }));
  check(`${type} reverse`, c3.reverse && c3.u < -1, `u ${c3.u.toFixed(2)}`);
  // Idle creep
  const c4 = new Car(carParams(type));
  run(c4, flat('tarmac'), 6, () => ({ throttle: 0, brake: 0, steer: 0 }));
  check(`${type} creep`, c4.u > 2 && c4.u < 6, `u ${c4.u.toFixed(2)}`);
}
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('All physics checks passed');
