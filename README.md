# String Rally

A mobile rally driving game in the browser (HTML5 + JavaScript + Three.js). You drive with an
**invisible string**: touch anywhere, keep your finger down, and pull. There are no on-screen
driving buttons.

- **Drag up**: throttle (the further you drag, the more throttle)
- **Drag down**: brake. Hold it at a standstill to reverse.
- **Drag left/right**: steer. Steering is spring-smoothed so it feels like tension on a string.
- **Quick flick**, or **spin your finger in a circle**: handbrake, to start a drift
- **Sharp downward flick**: emergency brake
- **Let go**: coast. The car idles forward slowly and the steering returns to centre.

A faint line is drawn from where you touched down to your finger. Its colour and thickness show
the tension. On desktop, the arrow keys or WASD with Space also work, which helps with testing.

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

Title → pick a car (RWD "Kestrel" or AWD "Tundra") → pick a difficulty → **Random stage** or
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
js/input.js       "invisible string" touch controls + gestures + string overlay
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

- **Car feel**: `carBase.front/rear` (Pacejka B/C/E), `tyreMu`, `countersteerAssist`,
  `cgToFront/cgToRear/cgHeight` (weight transfer), `torqueCurve`, `gears`, `topSpeed`.
- **Surfaces**: `surfaces.*.grip` and `bScale/cScale`. Loose surfaces have a broad tyre peak, so
  drifts are progressive.
- **Controls**: `controls.fullDrag` (how far to drag for full input), `steerSpring/steerDamping`
  (string tension), `flickSpeed`, `spinTurns`.
- **Stages**: `difficulty.*` (length, corner radius scale, hairpin/chicane frequency, width,
  hazard density) and `stage.clearance` (the minimum distance between different parts of the
  road).

While the game is running, `window.rally.CONFIG` is available in the browser console for quick
experiments. Setting `rally.autopilot` to the export of `tools/autopilot.js` makes the car drive
itself:

```js
rally.autopilot = (await import('/tools/autopilot.js')).autopilot
```

## Checks

```bash
node tools/check-physics.mjs      # acceleration, braking, cornering, handbrake, reverse, creep
node tools/check-stages.mjs 10    # generates stages, verifies no self-crossing, drives each
                                  # with the autopilot and reports stage times
```
