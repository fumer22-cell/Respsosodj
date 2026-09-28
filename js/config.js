// =============================================================================
//  CONFIG — every tuning constant for the game lives here.
//
//  Units: metres, seconds, kilograms, newtons, radians (unless noted).
//  Physics runs in a top-down 2D plane: +x is "east", +y is "south" on the
//  map (rendered as three.js +z). A positive yaw rate turns the car to the
//  RIGHT from the driver's seat.
// =============================================================================

export const CONFIG = {
  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------
  sim: {
    hz: 120,               // fixed physics rate, independent of frame rate
    maxFrameTime: 0.1,     // clamp long frames (tab hitch) so we never spiral
  },

  // ---------------------------------------------------------------------------
  // Cars. Each car overrides the shared `carBase` values below.
  // ---------------------------------------------------------------------------
  carBase: {
    mass: 1250,            // kg
    inertiaScale: 1.05,    // yaw inertia = mass * a * b * inertiaScale
    cgToFront: 1.22,       // distance centre of gravity -> front axle (a)
    cgToRear: 1.33,        // distance centre of gravity -> rear axle (b)
    cgHeight: 0.52,        // used for longitudinal weight transfer
    trackWidth: 1.55,      // only for visuals / tire mark placement
    wheelRadius: 0.31,

    // Steering: max wheel angle shrinks with speed so high-speed input is calm.
    maxSteerLow: 0.62,     // rad at standstill
    maxSteerHigh: 0.26,    // rad at `steerFadeSpeed` and above
    steerFadeSpeed: 40,    // m/s
    countersteerAssist: 0.85, // 0 = none, 1 = wheels follow the slide direction fully

    // Tyres — simplified Pacejka "magic formula" (normalised, peak = 1):
    //   F = mu * Fz * sin(C * atan(B*a - E*(B*a - atan(B*a))))
    // B = stiffness (higher -> sharper, earlier peak), C = shape (higher ->
    // more grip loss once sliding), E = curvature near the peak.
    tyreMu: 1.3,           // peak friction coefficient on tarmac (arcade-high)
    front: { B: 9.5, C: 1.42, E: 0.2 },
    rear:  { B: 10.5, C: 1.38, E: 0.2 },
    spinGrip: 0.82,        // longitudinal grip left when wheels spin / lock
    minSlipSpeed: 3.0,     // m/s floor used in slip-angle maths (low-speed stability)
    kinematicSpeed: 2.5,   // below this speed blend toward a simple kinematic model

    // Engine: torque curve as [rpm, Nm] pairs (linearly interpolated).
    torqueCurve: [[900, 170], [2000, 235], [3000, 275], [4000, 300], [5000, 310],
                  [6000, 295], [7000, 265], [7600, 235]],
    idleRpm: 900,
    redline: 7600,
    launchRpm: 3800,       // clutch-slip rpm in first gear from standstill
    gears: [3.25, 2.25, 1.68, 1.32, 1.07, 0.9], // forward ratios
    reverseRatio: 3.4,
    finalDrive: 4.1,
    drivetrainEff: 0.85,
    shiftUpRpm: 7100,
    shiftDownRpm: 3300,
    shiftTime: 0.1,        // s of torque cut while changing gear
    topSpeed: 58,          // m/s hard limit (~209 km/h)
    engineBrake: 1500,     // N at redline when coasting (scales with rpm)

    // Creep: the car always idles forward slightly, like an automatic.
    creepThrottle: 0.22,
    creepSpeed: 4.0,       // m/s — creep fades out above this

    // Brakes
    brakeForce: 14500,     // N total at full pedal
    brakeBias: 0.64,       // share on front axle
    handbrakeSlide: 0.78,  // (unused in arcade mode) rear friction while fully locked
    reverseDelay: 0.35,    // s holding brake at standstill before reverse engages
    reverseMaxSpeed: 9,    // m/s

    // Resistances
    dragCoef: 0.42,        // N per (m/s)^2  (0.5 * rho * Cd * A)
    rollingCoef: 0.015,    // fraction of weight
    angularDamping: 0.4,   // small extra yaw damping (1/s)
    weightTransferLag: 0.08, // s smoothing on longitudinal accel used for load transfer

    // ---- Arcade layer ------------------------------------------------------
    // Assists on top of the tyre model that make drifting easy to start,
    // hold and steer, without spinning out. Set arcade.enabled=false for the
    // plain simulation.
    arcade: {
      enabled: true,
      handbrakeGrip: 0.32,    // rear lateral grip while the handbrake is held (not a full lock)
      handbrakeDrag: 0.18,    // rear braking (fraction of grip) while the handbrake is held
      driftGrip: 0.62,        // rear lateral grip once sliding with throttle (keeps drifts going)
      driftAngle: 0.18,       // rad of body slip; a handbrake drift ends when slip drops below half this
      driftBoost: 2600,       // N of push along the direction of travel while drifting on throttle
      driftSteerYaw: 3.0,     // 1/s^2: how strongly the car turns toward the drift angle your steering asks for
      maxDriftAngle: 0.95,    // rad; beyond this the car is pulled back so it doesn't spin
      antiSpin: 7,            // strength of that pull (1/s)
      straightDamping: 5,     // 1/s: outside a drift, how quickly yaw follows the steering
      slipDamping: 2.5,       // 1/s: outside a drift, how quickly sideways slip is scrubbed off
      gripG: 1.25,            // max cornering g outside a drift (times surface grip)
      tractionLimit: 0.72,    // outside a drift, rear drive force is capped at this share of grip
      gripCountersteer: 0.15, // counter-steer assist outside a drift (the drift value is countersteerAssist)
      launchBoost: 1.35,      // torque multiplier in 1st/2nd gear for punchy launches
    },

    // Collision shape: two circles along the car's centreline
    colliderOffset: 1.15,
    colliderRadius: 0.95,
  },

  cars: {
    rwd: {
      name: 'RWD "Kestrel"',
      blurb: 'Rear-drive coupe. Tail-happy, drifts on command, rewards throttle control.',
      drive: 'rwd',
      frontDriveShare: 0,
      model: 'coupe',
      color: 0xf2f2ee, accent: 0x151518, underglow: 0xff2bd6, rim: 0x9aa0a8,
    },
    awd: {
      name: 'AWD "Raijin"',
      blurb: 'Turbo AWD sedan. Planted and fast out of corners, great on loose stuff.',
      drive: 'awd',
      frontDriveShare: 0.42,
      model: 'sedan',
      color: 0x1d4fd0, accent: 0xffd23a, underglow: 0x19e6ff, rim: 0xe0b020,
      // per-car overrides of carBase
      overrides: { mass: 1320, torqueCurve: [[900, 180], [2000, 250], [3000, 290], [4000, 320],
        [5000, 330], [6000, 315], [7000, 280], [7600, 250]] },
    },
  },

  // ---------------------------------------------------------------------------
  // Surfaces. grip multiplies tyreMu. bScale/cScale reshape the tyre curve:
  // loose surfaces get a broad, forgiving peak (lower B & C) so slides are
  // progressive and drifting is easy.  rolling multiplies rolling resistance.
  // ---------------------------------------------------------------------------
  surfaces: {
    tarmac: { grip: 1.0,  bScale: 1.0,  cScale: 1.0,  rolling: 1.0, color: 0x4a4c50, dust: null,     mark: [0.08, 0.08, 0.08, 0.55], label: 'tarmac' },
    gravel: { grip: 0.8,  bScale: 0.72, cScale: 0.9,  rolling: 1.8, color: 0x9a8a72, dust: 0xc8b79a,  mark: [0.42, 0.36, 0.28, 0.45], label: 'gravel' },
    dirt:   { grip: 0.84, bScale: 0.78, cScale: 0.92, rolling: 1.6, color: 0x8a6444, dust: 0xa88a66,  mark: [0.32, 0.22, 0.14, 0.45], label: 'dirt' },
    mud:    { grip: 0.62, bScale: 0.65, cScale: 0.9,  rolling: 4.0, color: 0x5a4030, dust: 0x7a5a40,  mark: [0.20, 0.13, 0.08, 0.6],  label: 'mud', heavy: true },
    snow:   { grip: 0.55, bScale: 0.7,  cScale: 0.9,  rolling: 2.2, color: 0xe4e9ef, dust: 0xf4f8ff,  mark: [0.62, 0.66, 0.72, 0.5],  label: 'snow' },
    verge:  { grip: 0.7,  bScale: 0.7,  cScale: 0.9,  rolling: 2.5, color: 0x6e6040, dust: 0x8a7a5a,  mark: [0.25, 0.2, 0.12, 0.4],   label: 'verge' },
    grass:  { grip: 0.6,  bScale: 0.65, cScale: 0.9,  rolling: 3.5, color: 0x4f7a3a, dust: 0x6a5a3a,  mark: [0.2, 0.25, 0.12, 0.4],   label: 'grass' },
  },

  // ---------------------------------------------------------------------------
  // "Invisible string" touch controls
  // ---------------------------------------------------------------------------
  controls: {
    // Touch anywhere = full throttle straight away. From that anchor:
    //   pull back a little -> throttle eases off and light braking starts
    //   pull back hard     -> hard braking (and reverse when stopped)
    //   drag sideways      -> steering
    // Distances are fractions of the screen's shorter side, divided by the
    // sensitivity setting.
    fullDrag: 0.42,        // pull-back distance for full brake
    steerFullDrag: 0.22,   // sideways distance for full lock
    deadZone: 0.06,        // default dead zone (fraction of fullDrag), user adjustable
    // Pull-back map (fractions of fullDrag, measured past the dead zone):
    throttleHold: 0.2,     // throttle stays at 100% until here (small wobbles don't matter)
    throttleCut: 0.55,     // ...then eases off, reaching 0 here
    brakeStart: 0.35,      // braking starts here and reaches 100% at 1.0
    brakeCurve: 1.4,       // >1 = gentler light braking, sharper at the end
    steerCurve: 1.3,       // >1 = finer control near centre
    // String "tension": steering follows the finger through a spring-damper
    steerSpring: 110,      // stiffness
    steerDamping: 19,      // damping (about 2*sqrt(spring) is critically damped)
    returnSpring: 34,      // spring back to centre when the finger lifts
    throttleRise: 14,      // 1/s: how fast throttle comes in (fast = "mass acceleration")
    pedalRise: 9,          // 1/s: brake / throttle-lift smoothing
  },

  // Defaults for the settings screen (persisted in localStorage)
  defaultSettings: {
    sensitivity: 1.0,
    deadZone: 0.06,
    invertSteer: false,
    voice: true,
    sound: true,
    quality: 'psx',        // chunky (180p) | psx (240p) | sharp (360p) | native
    handbrakeSide: 'left',  // small (P) button, halfway up the screen edge
    units: 'kmh',
    fullscreen: true,
  },

  // ---------------------------------------------------------------------------
  // Chase camera
  // ---------------------------------------------------------------------------
  camera: {
    distance: 6.8,
    height: 2.9,
    lookAhead: 6,
    lookHeight: 0.6,
    portraitHeight: 4.0,   // portrait screens are tall: look down more
    portraitLookAhead: 6,
    posStiffness: 6.0,     // 1/s position follow (lower = more lag)
    yawStiffness: 3.2,     // 1/s how fast the camera swings behind the car
    driftSwing: 0.55,      // 0..1 how much the camera follows velocity during slides
    fovLandscape: 55,      // vertical fov in degrees
    fovPortrait: 76,
    portraitDistanceScale: 1.18,
    speedFov: 10,          // extra fov at top speed
    far: 300,
  },

  // ---------------------------------------------------------------------------
  // Stage generation
  // ---------------------------------------------------------------------------
  stage: {
    sampleSpacing: 2,      // m between centreline samples
    controlSpacing: 10,    // m between spline control points
    clearance: 26,         // min distance between non-adjacent road sections
    startStraight: 70,
    runOff: 110,           // straight after the finish line to stop
    vergeWidth: 1.6,
    checkpointCount: [4, 6],
    sectionLength: [260, 620], // surface section length
    mudPatch: [30, 80],
    // time: 'night' | 'dusk' selects the sky / lighting (see render.skies).
    // lamps: chance per 50 m of a street lamp. guardrail: chance a corner gets rails.
    themes: [
      { name: 'Midnight touge', weight: 4, time: 'night', ground: 0x24331f, main: ['tarmac', 'tarmac', 'tarmac'], patch: 'gravel', lamps: 0.75, guardrail: 0.85 },
      { name: 'Dusk pass',      weight: 2, time: 'dusk',  ground: 0x3d4a26, main: ['tarmac', 'tarmac', 'gravel'], patch: 'dirt', lamps: 0.3, guardrail: 0.7 },
      { name: 'Forest gravel',  weight: 1, time: 'dusk',  ground: 0x35502a, main: ['gravel', 'gravel', 'dirt'], patch: 'mud', lamps: 0.1, guardrail: 0.35 },
      { name: 'Snow pass',      weight: 1, time: 'night', lengthScale: 0.88, ground: 0xc6d0dc, main: ['snow', 'tarmac', 'snow'], patch: 'snow', snowy: true, lamps: 0.6, guardrail: 0.7 },
    ],
    // Hazard base densities (chance per 4 m per side)
    treeDensity: 0.28,
    rockDensity: 0.05,
    backdropTrees: 0.9,
  },

  // Stage length (m) is picked from `length`, then scaled by the theme's
  // lengthScale so slow surfaces (snow) still give 60–120 s of driving.
  difficulty: {
    easy:   { label: 'Easy',   code: 'E', length: [1700, 2200], radiusScale: 1.35, hairpin: 0.05, chicane: 0.08, width: [9.0, 11.0], hazard: 0.7, hazardGap: 1.6, straight: [60, 170] },
    normal: { label: 'Normal', code: 'N', length: [1800, 2350], radiusScale: 1.0,  hairpin: 0.10, chicane: 0.12, width: [7.8, 9.8],  hazard: 1.0, hazardGap: 1.0, straight: [40, 140] },
    hard:   { label: 'Hard',   code: 'H', length: [1750, 2250], radiusScale: 0.8,  hairpin: 0.16, chicane: 0.16, width: [6.8, 8.6],  hazard: 1.45, hazardGap: 0.7, straight: [30, 110] },
  },

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------
  rules: {
    offroadDistance: 2.0,  // m beyond the verge before you count as off the road
    offroadMaxTime: 4.0,   // s off-road before auto-reset
    offroadPenalty: 5.0,   // s added on auto-reset
    countdown: 3,
  },

  // Pace notes: minimum radius (m) for each grade. 1 = slowest, 6 = fastest.
  paceNotes: {
    grades: [[22, 1], [32, 2], [48, 3], [70, 4], [100, 5], [170, 6]],
    hairpinRadius: 20, hairpinAngle: 2.4,   // rad
    minAngle: 0.26,        // corners gentler than this are ignored
    enterCurvature: 1 / 190,
    exitCurvature: 1 / 320,
    longLength: 75,
    intoGap: 28,
    callLeadTime: 2.9,     // s before the corner the call is made
    callMinDistance: 55,
    callMaxDistance: 150,
  },

  // Rendering / effects — PS1-style: low internal resolution (upscaled with
  // hard pixels), vertex snapping ("wobble"), affine texture warping,
  // 15-bit colour with ordered dithering, tiny nearest-filtered textures.
  render: {
    lines: { chunky: 180, psx: 240, sharp: 360 },   // internal vertical resolution
    snapDivisor: 2,        // vertices snap to a grid of (resolution / this); higher = more wobble
    colorLevels: 31,       // 5 bits per channel
    affine: true,          // PS1 texture warping
    particles: 600,
    tireMarkSegments: 1800,
    chunkSize: 160,
    skies: {
      night: { top: 0x04050c, horizon: 0x33204f, fog: 0x1a1430, fogNear: 25, fogFar: 175, ambient: 0.42, hemi: [0x8fa0ff, 0x1a1a24, 0.9], sun: [0x9fb4ff, 0.35], stars: true, city: true },
      dusk:  { top: 0x1d2350, horizon: 0xff8a4a, fog: 0x7a5068, fogNear: 45, fogFar: 230, ambient: 0.78, hemi: [0xffc8a0, 0x303040, 1.2], sun: [0xffb070, 1.0], stars: false, city: true },
    },
    lampColor: 0xffb048,   // sodium street lights
  },

  // Drift scoring (arcade)
  drift: {
    minSpeed: 9,           // m/s
    minAngle: 0.22,        // rad of body slip
    pointsRate: 12,        // points per (m/s * rad) per second
    bankDelay: 0.8,        // s of grip before a drift combo is banked
    crashImpact: 4,        // m/s impact that wipes the current combo
  },
};

/** Merge carBase with a car's overrides -> the full parameter set for physics. */
export function carParams(type) {
  const car = CONFIG.cars[type];
  return { ...CONFIG.carBase, ...(car.overrides || {}), drive: car.drive, frontDriveShare: car.frontDriveShare };
}
