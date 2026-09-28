// A simple autopilot used for testing: pure-pursuit steering along the
// centreline plus a speed target from the curvature ahead. It is not fast —
// a good human beats it — but it gives a reproducible stage-time estimate.
import { CONFIG } from '../js/config.js';

export function autopilot(car, stage) {
  const ds = stage.ds, i = car.hint, speed = car.speed;
  const n = stage.count;
  const look = Math.min(n - 1, i + Math.round((4 + speed * 0.3) / ds));
  const dx = stage.xs[look] - car.x, dy = stage.ys[look] - car.y;
  const ang = Math.atan2(dy, dx) - car.h;
  const a = Math.atan2(Math.sin(ang), Math.cos(ang));
  const steer = Math.max(-1, Math.min(1, a * 3.0 - (car.proj.lat || 0) * 0.04));
  // Speed limit from the tightest curvature within braking distance
  const grip = CONFIG.surfaces[car.fx.surfRear]?.grip ?? 0.7;
  const mu = 1.0 * grip * 9.81 * 0.8;
  let vmax = 60;
  const horizon = Math.round((speed * speed / (2 * mu * 0.8) + 25) / ds);
  for (let j = i; j < Math.min(n, i + horizon); j++) {
    const k = Math.abs(stage.k[j]);
    if (k < 1e-4) continue;
    const vCorner = Math.sqrt(mu / k);
    const dist = (j - i) * ds;
    vmax = Math.min(vmax, Math.sqrt(vCorner * vCorner + 2 * mu * 0.8 * dist));
  }
  const throttle = speed < vmax - 1 ? 1 : speed < vmax ? 0.3 : 0;
  const brake = speed > vmax + 1.5 ? Math.min(1, (speed - vmax) / 6) : 0;
  return { throttle, brake, steer, handbrake: false, emergency: false };
}
