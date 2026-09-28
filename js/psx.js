// =============================================================================
//  PS1-style rendering helpers.
//
//  The look comes from reproducing the original hardware's limitations:
//   * vertex snapping   - vertices land on a coarse screen grid, so geometry
//                         "wobbles" as the camera moves (no sub-pixel precision)
//   * affine textures   - textures are interpolated in screen space without
//                         perspective correction, so they warp and swim
//   * 15-bit colour     - 5 bits per channel with a 4x4 ordered (Bayer) dither
//   * nearest filtering - tiny textures, no mipmaps, hard texels
//   * low resolution    - the whole frame is rendered at ~240 lines and
//                         upscaled with hard pixels (see main.js)
//  All of it is injected into stock three.js materials via onBeforeCompile.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { makeRng } from './rng.js';

/** Uniforms shared by every PS1 material (updated on resize / settings). */
export const PSX = {
  uSnap: { value: new THREE.Vector2(160, 120) },   // snapping grid (half-res)
  uLevels: { value: CONFIG.render.colorLevels },
  uSnapOn: { value: 1 },
};

export function setPsxResolution(w, h, enabled = true) {
  const d = CONFIG.render.snapDivisor;
  PSX.uSnap.value.set(w / d, h / d);
  PSX.uSnapOn.value = enabled ? 1 : 0;
  PSX.uLevels.value = enabled ? CONFIG.render.colorLevels : 255;
}

const DITHER_GLSL = /* glsl */`
uniform float uLevels;
float psxBayer(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  float m[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
  for (int k = 0; k < 16; k++) if (k == i) return m[k] / 16.0 - 0.47;
  return 0.0;
}
`;

/**
 * Patch a material for the PS1 look. Options:
 *   affine: warp the colour map (default CONFIG.render.affine)
 */
export function psx(material, { affine = CONFIG.render.affine } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSnap = PSX.uSnap;
    shader.uniforms.uLevels = PSX.uLevels;
    shader.uniforms.uSnapOn = PSX.uSnapOn;
    const useAffine = affine && !!material.map;
    // ---- vertex: snap to the coarse grid, pass affine uv ----
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform vec2 uSnap;
uniform float uSnapOn;
${useAffine ? 'varying vec3 vAffineUv;' : ''}`)
      .replace('#include <project_vertex>', `#include <project_vertex>
if (uSnapOn > 0.5) {
  vec2 ndc = gl_Position.xy / gl_Position.w;
  ndc = floor(ndc * uSnap + 0.5) / uSnap;
  gl_Position.xy = ndc * gl_Position.w;
}
${useAffine ? 'vAffineUv = vec3(vMapUv * gl_Position.w, gl_Position.w);' : ''}`);
    // ---- fragment: affine sampling + 15-bit ordered dither ----
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${DITHER_GLSL}
${useAffine ? 'varying vec3 vAffineUv;' : ''}`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
gl_FragColor.rgb = clamp(floor(gl_FragColor.rgb * uLevels + 0.5 + psxBayer(gl_FragCoord.xy)) / uLevels, 0.0, 1.0);`);
    if (useAffine) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
        THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', 'texture2D( map, vAffineUv.xy / vAffineUv.z )'));
    }
  };
  material.customProgramCacheKey = () => `psx${affine && material.map ? 'a' : ''}`;
  return material;
}

/** GLSL snippet for hand-written ShaderMaterials that want the same dither. */
export const PSX_DITHER_GLSL = DITHER_GLSL;

// -----------------------------------------------------------------------------
// Pixel-art textures drawn in code (tiny, nearest-filtered, no mipmaps)
// -----------------------------------------------------------------------------
export function pixelTexture(w, h, draw, { repeat = false } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  if (repeat) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; }
  return tex;
}

const hex = (c) => '#' + c.toString(16).padStart(6, '0');
function shade(c, f) {
  const r = Math.min(255, Math.max(0, ((c >> 16) & 255) * f)) | 0;
  const g = Math.min(255, Math.max(0, ((c >> 8) & 255) * f)) | 0;
  const b = Math.min(255, Math.max(0, (c & 255) * f)) | 0;
  return `rgb(${r},${g},${b})`;
}
/** Fill with a base colour plus per-texel brightness noise. */
function noiseFill(ctx, w, h, base, amount, rng, x0 = 0, y0 = 0) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    ctx.fillStyle = shade(base, 1 + (rng.next() - 0.5) * amount);
    ctx.fillRect(x0 + x, y0 + y, 1, 1);
  }
}

/**
 * Road atlas: one 32x64 column per surface, laid side by side. u across the
 * road picks the column; v runs along the road and repeats.
 */
export const ROAD_TILES = ['tarmac', 'gravel', 'dirt', 'mud', 'snow', 'verge', 'grass'];
export function roadAtlas() {
  const TW = 32, TH = 64;
  const rng = makeRng('road-atlas');
  return pixelTexture(TW * ROAD_TILES.length, TH, (ctx) => {
    ROAD_TILES.forEach((name, t) => {
      const x0 = t * TW;
      const base = CONFIG.surfaces[name].color;
      const amt = name === 'tarmac' ? 0.35 : name === 'snow' ? 0.12 : 0.5;
      noiseFill(ctx, TW, TH, base, amt, rng, x0, 0);
      if (name === 'tarmac') {
        // Worn white edge lines + yellow centre dashes (touge markings)
        ctx.fillStyle = '#d8d8d0';
        ctx.fillRect(x0 + 1, 0, 1, TH); ctx.fillRect(x0 + TW - 2, 0, 1, TH);
        ctx.fillStyle = '#e0b030';
        ctx.fillRect(x0 + TW / 2 - 1, 0, 1, 20); ctx.fillRect(x0 + TW / 2 - 1, 32, 1, 20);
        // a few cracks / tar seams
        ctx.fillStyle = '#26282c';
        for (let k = 0; k < 10; k++) ctx.fillRect(x0 + 3 + rng.int(0, TW - 7), rng.int(0, TH - 1), rng.int(1, 3), 1);
      } else if (name === 'gravel' || name === 'dirt' || name === 'mud') {
        // Two darker wheel ruts
        ctx.fillStyle = shade(base, 0.72);
        ctx.fillRect(x0 + 7, 0, 3, TH); ctx.fillRect(x0 + TW - 10, 0, 3, TH);
        for (let k = 0; k < 60; k++) { ctx.fillStyle = shade(base, 1.35); ctx.fillRect(x0 + rng.int(0, TW - 1), rng.int(0, TH - 1), 1, 1); }
      } else if (name === 'snow') {
        ctx.fillStyle = shade(base, 0.8);
        ctx.fillRect(x0 + 7, 0, 3, TH); ctx.fillRect(x0 + TW - 10, 0, 3, TH);
      } else if (name === 'grass') {
        for (let k = 0; k < 80; k++) { ctx.fillStyle = shade(base, 1.4); ctx.fillRect(x0 + rng.int(0, TW - 1), rng.int(0, TH - 2), 1, 2); }
      }
    });
  });
}

/** Tileable ground texture (grass or snow). */
export function groundTexture(color, snowy) {
  const rng = makeRng('ground-tex');
  return pixelTexture(32, 32, (ctx, w, h) => {
    noiseFill(ctx, w, h, color, snowy ? 0.12 : 0.45, rng);
    for (let k = 0; k < 50; k++) {
      ctx.fillStyle = shade(color, snowy ? 0.88 : 1.45);
      ctx.fillRect(rng.int(0, w - 1), rng.int(0, h - 1), 1, snowy ? 1 : 2);
    }
  }, { repeat: true });
}

/** Radial glow used for lamps, headlights, underglow (white; tint via material). */
export function glowTexture(size = 32, hard = false) {
  return pixelTexture(size, size, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (x + 0.5) / w * 2 - 1, dy = (y + 0.5) / h * 2 - 1;
      let a = Math.max(0, 1 - Math.hypot(dx, dy));
      a = hard ? (a > 0.5 ? 1 : a * 1.6) : a * a;
      // quantise to 6 steps: banding is part of the charm
      a = Math.round(a * 6) / 6;
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = a * 255;
    }
    ctx.putImageData(img, 0, 0);
  });
}

/** Headlight beam on the ground: a pixelated trapezoid fading with distance. */
export function beamTexture() {
  return pixelTexture(32, 32, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const along = 1 - y / (h - 1);                  // canvas top = far end (flipY)
      const half = 0.25 + along * 0.7;
      const across = Math.abs((x + 0.5) / w * 2 - 1) / half;
      let a = across < 1 ? (1 - across * across) * (1 - along) * Math.min(1, along * 6) : 0;
      a = Math.round(a * 5) / 5;
      const i = (y * w + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 245; img.data[i + 2] = 215; img.data[i + 3] = a * 255;
    }
    ctx.putImageData(img, 0, 0);
  });
}

/** Distant skyline ring: mountains + city blocks with lit windows + neon. */
export function skylineTexture(time) {
  const rng = makeRng('skyline' + time);
  const W = 512, H = 64;
  const night = time === 'night';
  return pixelTexture(W, H, (ctx) => {
    ctx.clearRect(0, 0, W, H);
    // Mountain ridges
    for (const [col, top, rough] of [[night ? 0x121022 : 0x3a2a48, 18, 10], [night ? 0x0b0a16 : 0x2a1f38, 30, 7]]) {
      ctx.fillStyle = hex(col);
      let y = top + rng.range(-4, 4);
      for (let x = 0; x < W; x++) {
        y = Math.max(8, Math.min(H - 6, y + rng.range(-1, 1) * rough * 0.18 + (top + 6 - y) * 0.02));
        ctx.fillRect(x, Math.round(y), 1, H);
      }
    }
    // City clusters on the horizon
    for (let cluster = 0; cluster < 5; cluster++) {
      let x = rng.int(0, W - 80);
      const end = x + rng.int(40, 90);
      while (x < end) {
        const bw = rng.int(3, 7), bh = rng.int(6, 22);
        ctx.fillStyle = night ? '#07070e' : '#241a2e';
        ctx.fillRect(x, H - bh, bw, bh);
        for (let wy = H - bh + 2; wy < H - 1; wy += 2) for (let wx = x + 1; wx < x + bw - 1; wx += 2) {
          if (rng.chance(night ? 0.45 : 0.15)) { ctx.fillStyle = rng.pick(['#ffd27a', '#ffe9b0', '#9fe8ff']); ctx.fillRect(wx, wy, 1, 1); }
        }
        if (rng.chance(0.2)) { ctx.fillStyle = rng.pick(['#ff2bd6', '#19e6ff', '#ff3b3b']); ctx.fillRect(x, H - bh - 1, bw, 1); }
        x += bw + rng.int(0, 2);
      }
    }
  }, { repeat: true });
}

/** Side decal for a car body (ExtrudeGeometry caps use x/y as uv). */
export function liveryTexture(kind, colors) {
  const rng = makeRng('livery' + kind);
  return pixelTexture(64, 16, (ctx, w, h) => {
    ctx.fillStyle = hex(colors.color); ctx.fillRect(0, 0, w, h);
    if (kind === 'coupe') {
      // Two-tone "panda": dark lower half, a thin pinstripe, door text
      ctx.fillStyle = hex(colors.accent); ctx.fillRect(0, 10, w, 6);
      ctx.fillStyle = '#ff2bd6'; ctx.fillRect(0, 9, w, 1);
      ctx.fillStyle = '#20202a'; ctx.font = '5px monospace';
      ctx.fillRect(28, 3, 16, 5); ctx.fillStyle = '#f2f2ee';
      for (let k = 0; k < 6; k++) ctx.fillRect(29 + k * 2 + (k > 2 ? 1 : 0), 4, 1, 3);   // "text"
    } else {
      // Rally-sedan style: gold stripe, big number roundel on the door
      ctx.fillStyle = hex(colors.accent); ctx.fillRect(0, 6, w, 2);
      ctx.fillStyle = '#f5f5f5'; ctx.fillRect(30, 3, 9, 9);
      ctx.fillStyle = '#101018'; ctx.fillRect(32, 5, 2, 5); ctx.fillRect(35, 5, 2, 5); ctx.fillRect(34, 5, 1, 1); ctx.fillRect(34, 9, 1, 1);
      ctx.fillStyle = '#0c1a40'; ctx.fillRect(0, 14, w, 2);
    }
    // dirt/wear speckle near the sills
    for (let k = 0; k < 20; k++) { ctx.fillStyle = 'rgba(40,30,20,0.35)'; ctx.fillRect(rng.int(0, w - 1), rng.int(12, h - 1), 1, 1); }
  });
}

/** Gate banner (START / CHECKPOINT n / FINISH) as a tiny pixel texture. */
export function bannerTexture(kind, label) {
  return pixelTexture(128, 16, (ctx, w, h) => {
    if (kind === 'finish') {
      for (let x = 0; x < w; x += 4) for (let y = 0; y < h; y += 4) { ctx.fillStyle = ((x + y) / 4) % 2 ? '#fff' : '#111'; ctx.fillRect(x, y, 4, 4); }
      ctx.fillStyle = '#111'; ctx.fillRect(34, 2, 60, 12);
    } else {
      ctx.fillStyle = kind === 'start' ? '#0a4d2a' : '#12122a'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = kind === 'start' ? '#19e6ff' : '#ff2bd6'; ctx.fillRect(0, 0, w, 1); ctx.fillRect(0, h - 1, w, 1);
    }
    ctx.fillStyle = kind === 'checkpoint' ? '#ffd23a' : '#ffffff';
    ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, w / 2, h / 2 + 1);
  });
}
