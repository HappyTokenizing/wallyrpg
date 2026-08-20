/* ============================================================
   palette.js — the canonical colour set from ART_DIRECTION.md §2.1.

   NOTHING in this game hardcodes a colour. Everything imports from
   here. If a colour is missing, add it here rather than inlining it.

   All values are sRGB hex integers, ready for THREE.Color.setHex()
   with THREE.SRGBColorSpace conversion handled by the material layer.
   ============================================================ */

export const SKY = {
  zenith:   0x2e7fd4,
  horizon:  0x9fd8f2,
  sunDisc:  0xfff6d8,
  sunHalo:  0xffe9a8,
  haze:     0xb8def0,
  night:    0x141d3a,
  nightHorizon: 0x33406e,
  dusk:     0xf2925c,
  dawn:     0xf7c6a0,
};

export const SEA = {
  deep:     0x1b6fa8,
  shallow:  0x57c6d8,
  foam:     0xf4fbff,
  caustic:  0x9fe8f0,
  wet:      0x3a94b8,
};

export const LAND = {
  grassLit:   0x7ec24e,
  grassShade: 0x4e9a46,
  sand:       0xebd9a8,
  sandWet:    0xc9b381,
  dirt:       0x9c7a4e,
  rock:       0x8f8e88,
  rockShade:  0x676a70,
  cliff:      0xa89a82,
};

export const BUILD = {
  roof:       0xd9713f,
  roofShade:  0xa8502c,
  stucco:     0xf0e4cc,
  stuccoAlt:  0xe6d4b4,
  wood:       0xa9713f,
  woodDark:   0x7a4f2c,
  stone:      0xcfc4ae,
  metal:      0x8d94a0,
  glassLit:   0xffe6a8,
  awning:     0xd85c52,
  awningAlt:  0x4f8fb8,
};

/* Wally's clay. Sampled from the reference renders — see ART_DIRECTION §1.2. */
export const CLAY = {
  bodyLit:    0xdedede,   // lit cheek
  body:       0xd3d3d2,   // full-light base albedo
  bodyMid:    0xcfcfce,   // mid-tone flank
  bodyAO:     0xa9a9a8,   // deep AO crease
  earInner:   0xc6c2bf,
  sss:        0xe8dcd2,   // subsurface transmission tint
  tusk:       0xf2ebda,
  tuskRoot:   0xe4d9c0,
  frame:      0x141414,   // sunglass frame
  lens:       0x0a0a0a,   // sunglass lens
  glint:      0xffffff,   // THE glint
};

/* Wind Waker shadow law — see ART_DIRECTION §2.1.
   shadow = lerp(albedo, albedo * SHADOW.tint, SHADOW.amount) */
export const SHADOW = {
  tint:    0x5a6e9e,      // blue-violet
  amount:  0.55,
  mul:     0.82,
  ao:      0xa9a5a2,      // warm AO for clay
  contact: 0x4a5578,
};

/* Brand — carried over from the original Wally: City of Assets UI. */
export const BRAND = {
  token:    0xf5913c,
  token2:   0xd96f1e,
  good:     0x5fa86a,
  bad:      0xd45c48,
  warn:     0xe0a93c,
  info:     0x5b95c4,
  gem:      0x9b7cc4,
  ink:      0x12141c,
  paper:    0xf7efe0,
  text:     0xf3eee5,
};

/* Category colours, ported from the original data.js so the UI stays familiar. */
export const CATEGORY = {
  Stocks:         0x2f8280,
  Bonds:          0x8a6c3e,
  Farm:           0x5f9b58,
  Minerals:       0x8e7cc3,
  Property:       0xbe7a34,
  Culture:        0xc0518b,
  Infrastructure: 0x3e7bb0,
  Business:       0xd08a2b,
  Sports:         0xbe4c34,
  Transport:      0x6d8a3c,
};

/* Time-of-day keyframes. Each entry drives sky, sun colour/elevation, fog and grade.
   `t` is hours (0-24). The lighting rig interpolates between them. */
export const TIME_OF_DAY = [
  { t: 0,  sunEl: -35, sun: 0x8fa8d8, amb: 0x2a3560, sky: SKY.night,   horizon: SKY.nightHorizon, fog: 0x27314f, exposure: 0.72 },
  { t: 5,  sunEl: -6,  sun: 0xd88f7a, amb: 0x4a5580, sky: 0x3d5a92,    horizon: 0x9a7c9e,         fog: 0x6a6f92, exposure: 0.85 },
  { t: 7,  sunEl: 14,  sun: 0xffd4a8, amb: 0x7e93c4, sky: 0x4b93d8,    horizon: SKY.dawn,         fog: 0xc8d6e8, exposure: 1.0  },
  { t: 10, sunEl: 48,  sun: 0xfff4dc, amb: 0x9ab4d8, sky: SKY.zenith,  horizon: SKY.horizon,      fog: SKY.haze, exposure: 1.05 },
  { t: 13, sunEl: 72,  sun: 0xfffaf0, amb: 0xa8c0dc, sky: 0x2b7ad2,    horizon: 0xa8dff4,         fog: SKY.haze, exposure: 1.08 },
  { t: 16, sunEl: 40,  sun: 0xffe8c0, amb: 0x9ab0d4, sky: 0x3585d4,    horizon: 0xbfe2f2,         fog: 0xc4dcec, exposure: 1.02 },
  { t: 18, sunEl: 10,  sun: 0xff9e5c, amb: 0x7a7fae, sky: 0x4a72b8,    horizon: SKY.dusk,         fog: 0xd8a48c, exposure: 0.95 },
  { t: 20, sunEl: -8,  sun: 0xa06a94, amb: 0x4e5688, sky: 0x2c3f78,    horizon: 0x8a5a86,         fog: 0x5c5f84, exposure: 0.82 },
  { t: 22, sunEl: -24, sun: 0x8fa8d8, amb: 0x333f6a, sky: 0x1c2a52,    horizon: 0x3f4a78,         fog: 0x333d5e, exposure: 0.75 },
];

/* Convenience: 0xRRGGBB -> '#rrggbb' for DOM/UI use. */
export const css = (hex) => '#' + hex.toString(16).padStart(6, '0');
