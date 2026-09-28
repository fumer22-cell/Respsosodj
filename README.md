# String Rally: Midnight Touge Edition

An arcade mountain-pass racer for phones, in the style of an early-2000s / PS1 driving game
(HTML5 + JavaScript + Three.js). You steer with an **invisible string**, and the handbrake is a
small button of its own.

- **Touch anywhere**: that point becomes the anchor, and you're on full throttle straight away.
- **Pull back**: small wobbles are ignored. Pulling further back lifts off the throttle, then
  braking builds up.
- **Pull back hard**: hard braking. Keep holding at a standstill to reverse. In reverse, steering
  still turns the nose toward your finger, so left is always left.
- **Left or right of the anchor**: turn left or right. The further out, the more lock. Steering is
  spring-smoothed, like tension on a string.
- **(P) handbrake**: a small button halfway up the left edge, for your second thumb. It's the only
  way to start a drift; otherwise the car grips and goes where you steer. While drifting, your
  steering sets the drift angle and the throttle holds it. The button can move to the right edge
  (Settings).
- **Let go**: coast.

Drifting scores points, and holding a slide builds a multiplier. The keyboard also works: arrows or
WASD to drive, Space for the handbrake.

### The retro look

There are no downloaded assets. Everything is built in code, partly because the Claude Artifact
viewer can't load files from other hosts, and partly because that's how the look is made:

- **Low resolution:** the scene renders at about 240 lines and is upscaled with hard pixels. This
  is also why it runs well on phones.
- **Vertex snapping:** vertices snap to a coarse screen grid, which gives the PS1 "wobble".
- **Affine textures:** textures warp and swim the way they did on the PS1.
- **15-bit colour:** colours are reduced and smoothed with a 4×4 ordered dither.
- **Tiny textures:** 32–64px pixel-art textures (road atlas, livery, skyline, banners) are drawn in
  code with nearest filtering.
- **Night lighting:** street lamps are "baked" into the road and ground colours, the headlights
  project a beam on the road, the car has neon underglow, and a city skyline sits on the horizon.

The cars are built from extruded side profiles:

- **RWD "Kestrel"**: a pop-up-headlight coupe.
- **AWD "Raijin"**: a turbo sedan with a big wing.

All of this lives in `js/psx.js` (shader patch and textures) and `js/scene.js`. The retro
resolution can be changed or switched off in Settings.

## Run it locally

The game is static files, but it uses ES modules, so it has to be served over `http://`. Opening
`index.html` directly as a file won't work. Three.js loads from `cdn.jsdelivr.net`, so the device
also needs internet access.

```bash
# from this folder, with either of these:
npx http-server -c-1 -p 8080 .        # Node (same as: npm start)
python3 -m http.server 8080           # Python 3
```

Then open <http://localhost:8080>.

## Play it on your phone

1. Put your computer and phone on the **same Wi-Fi network**.
2. Start the server as shown above. `http-server` also listens on your LAN address. With Python,
   add `--bind 0.0.0.0`.
3. Find your computer's local IP address:
   - macOS: `ipconfig getifaddr en0`
   - Linux: `hostname -I`
   - Windows: `ipconfig`, then look for "IPv4 Address"
4. On the phone, open `http://<that-ip>:8080`, for example `http://192.168.1.23:8080`.
5. If the phone can't connect, allow port 8080 through your computer's firewall.

Tips:

- Android Chrome switches to fullscreen when a race starts. You can turn this off in Settings.
- On iPhone, use Share → **Add to Home Screen** for a fullscreen, app-like experience.
- The co-driver voice uses the browser's speech synthesis. Turn off the silent switch to hear it.
- You can also use any static host, such as GitHub Pages or Netlify. Upload the folder as it is;
  there is no build step.

## Game flow

Title → pick a car (RWD "Kestrel" or AWD "Raijin") → pick a difficulty → **Random stage** or
enter a seed → race → results, with your time, checkpoint splits and your best time on that seed.
The results screen has **Next stage** and **Retry** buttons.

Stages are generated from a seed. The code shown in the HUD and on the results screen, such as
`N-K7Q2XD`, includes the difficulty letter (E, N or H), so anyone who enters that code gets the
same stage. Best times are stored per code in `localStorage`.

## Project layout

```
index.html        page, screens, HUD markup, import map for Three.js (CDN)
css/style.css     all styling (HUD, menus, portrait/landscape)
js/config.js      ALL tuning constants in one CONFIG object (physics, tyres, surfaces,
                  controls, camera, stage generation, difficulty, rules, rendering)
js/physics.js     2D vehicle model: Pacejka tyres, friction circle, weight transfer,
                  engine/gearbox, handbrake, surfaces, collisions (fixed 120 Hz step)
js/input.js       "invisible string" touch controls, handbrake button, string overlay
js/psx.js         PS1 look: vertex snap, affine textures, dither; pixel textures made in code
js/stage.js       seeded stage generator (non-crossing spline road, surfaces, width,
                  checkpoints, props/colliders) + fast road queries
js/pacenotes.js   corner detection from curvature, grading (1–6, hairpin), modifiers,
                  call timing
js/scene.js       Three.js world: road mesh, instanced/chunked props, gates, car, camera
js/effects.js     dust/mud/snow/smoke particles and tyre marks
js/audio.js       synthesized engine, skid and impact sounds (Web Audio, no assets)
js/ui.js          screens, HUD, localStorage (settings, best times, recent seeds)
js/main.js        game flow, fixed-timestep loop, checkpoints, penalties, pause
tools/            Node checks: physics sanity + stage generation/drivability with an autopilot
```

## Tuning

Every tuning value is in `js/config.js`, and each one is commented. Some examples:

- **Arcade feel**: `carBase.arcade` (grip-mode cornering `gripG`, traction control, handbrake
  grip, drift grip/boost, how steering sets the drift angle, anti-spin, launch boost). Set `arcade.enabled: false` for the plain simulation.
- **Car feel**: `carBase.front/rear` (Pacejka B/C/E), `tyreMu`, `countersteerAssist`,
  `cgToFront/cgToRear/cgHeight` (weight transfer), `torqueCurve`, `gears`, `topSpeed`.
- **Surfaces**: `surfaces.*.grip` and `bScale/cScale`. Loose surfaces have a broad tyre peak, so
  drifts are progressive.
- **Controls**: `controls.fullDrag` (pull-back for full brake), `throttleHold` / `throttleCut` /
  `brakeStart` (the pull-back map), `brakeCurve`, `steerSpring/steerDamping` (string tension).
- **Look**: `render.lines` (internal resolution), `snapDivisor` (wobble), `colorLevels`, `affine`,
  `render.skies` (night/dusk palettes), `stage.themes` (lamps, guardrails, surfaces).
- **Stages**: `difficulty.*` (length, corner radius scale, hairpin/chicane frequency, width,
  hazard density) and `stage.clearance` (the minimum distance between different parts of the
  road).

While the game is running, `window.rally.CONFIG` is available in the browser console for quick
experiments. Setting `rally.autopilot` to the export of `tools/autopilot.js` makes the car drive
itself:

```js
rally.autopilot = (await import('/tools/autopilot.js')).autopilot
```

## Single-file build

`node tools/build-single.mjs` bundles everything into `dist/string-rally.html`. Three.js still loads
from the CDN. This is the version published as a Claude Artifact.

## Checks

```bash
node tools/check-physics.mjs      # acceleration, braking, cornering, handbrake, reverse, creep
node tools/check-stages.mjs 10    # generates stages, verifies no self-crossing, drives each
                                  # with the autopilot and reports stage times
```
