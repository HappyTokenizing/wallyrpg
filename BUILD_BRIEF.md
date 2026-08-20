# WALLY RPG — Build Brief (every agent reads this first)

You are building **WALLY RPG**: a Three.js, Wind-Waker-styled 3D action-RPG starring
Wally, a matte-clay elephant in black sunglasses. It is a 3D remake of a 2D browser
RPG (`ref/original-wally.html`, `ref/original-README.md`).

Project root: `/Users/herwig/Desktop/Claude files/wally-rpg`

## Read before you write

1. `ART_DIRECTION.md` — **the law.** Colour, form, material, camera, physics, the
   acceptance bar. Do not deviate. Do not invent your own palette.
2. `src/core/contracts.js` — the module contract, the ctx object, ownership table,
   quality tiers, maths helpers (`damp`, `spring`, `smoothstep`, `lerp`, seeded rng).
3. `src/core/palette.js` — every colour. Import from here; never hardcode a hex.
4. `src/core/wind.js` — the global wind field. Anything that should move in the wind
   calls `ctx.wind.attach(material)` and includes `ctx.wind.glsl`.

## The module contract

Every file you own exports exactly:

```js
export async function init(ctx) {
  // build things, add to ctx.scene
  return {
    update(dt, elapsed) {},   // optional, every frame
    lateUpdate(dt) {},        // optional, after all updates (camera, IK)
    resize(w, h) {},          // optional
    dispose() {},             // optional
    /* ...your public API — other modules reach it via ctx.<namespace> */
  };
}
```

`main.js` assigns your return value to `ctx.<yourNamespace>` and calls your hooks.
**Never import another subsystem directly.** Reach it through `ctx`, or talk over
`ctx.bus`. This is what lets us build in parallel.

Boot order (you may depend on everything earlier, nothing later):

```
render → mat → wind → sky → world → water → phys → wally → cam → game → ui → audio → intro
```

## Hard rules

- **Only edit the files you are told you own.** Another agent owns every other file.
  If you need something from a file you do not own, add it to `ctx` via your own
  module, or emit an event, or ask for it in your final report.
- `import * as THREE from '<relative>/vendor/three.module.js'` — never a CDN, never a
  bare specifier. Three.js **r180**. There is no import map.
- Only `three.module.js` and `three.core.js` are vendored. Addons (`OrbitControls`,
  `EffectComposer`, `RGBELoader`, …) are **not available** — write them yourself into
  a file you own, or do without.
- No external assets. No network requests. Everything procedural: geometry, textures
  (generate to canvas or in-shader), audio. The game must run offline from `file://`
  after the build step.
- Respect `ctx.quality` (see `QUALITY_TIERS` in contracts.js). Every expensive feature
  needs a cheaper path.
- Use `damp(a, b, lambda, dt)` for smoothing, never `lerp(a, b, 0.1)` — the latter is
  frame-rate dependent and reads as sloppy.
- Use `ctx.rng()` / `ctx.makeRng(seed)` for anything random. `Math.random()` is banned
  in world generation: screenshots must be reproducible between builds.
- Dispose geometries/materials you replace. Watch `renderer.info` for leaks.
- **60 fps at 1600×900.** `window.__WALLY_PERF__` reports fps/draw calls/triangles.

## How to see your work

```bash
node tools/shot.mjs shots/my-thing.png --wait 3000
node tools/shot.mjs shots/my-thing.png --w 1920 --h 1080 --eval "WALLY.debug.foo()"
node tools/shot.mjs shots/my-thing.png --console      # print browser console
```

The harness boots a real headless Chrome with WebGL2, waits for
`window.__WALLY_READY__`, runs your `--eval`, screenshots, and prints perf. **It exits
non-zero and dumps the console if the page threw.** A silent zero exit means the frame
rendered clean.

**Then Read the PNG.** You have vision. Look at your own output and judge it against
`ART_DIRECTION.md §6`. Iterate until it is genuinely good — not until it merely runs.
A module that boots without errors but looks like untextured primitives is a failure.

Register debug entry points on `window.WALLY.debug` so screenshots can pose the world:

```js
window.WALLY.debug.poseWally = (name) => { ... };
window.WALLY.debug.setHour = (h) => { ... };
window.WALLY.debug.camera = (preset) => { ... };
```

## Comparison targets

- `shots/ref-original-place.png`, `-map.png`, `-title.png` — the 2D original. Our
  output must beat these decisively; they are genuinely well-crafted 2D art.
- `ref/wally-logo.png` — the flat Wally mark.
- `ART_DIRECTION.md §1` — the exact spec of the two reference clay renders of Wally,
  transcribed in full because the renders themselves are not on disk. **§1 is
  authoritative; treat it as if you were looking at the renders.**

## Definition of done for your slice

- It renders, at 60 fps, with zero console errors.
- You have looked at a screenshot of it and it satisfies `ART_DIRECTION.md §6`.
- Nothing in your frame is a recognisable untextured Three.js primitive.
- It moves — wind, animation, or life of some kind.
- Your final report is **≤ 25 lines**: what you built, the public API you put on
  `ctx.<ns>`, debug hooks you registered, and anything you need from another module.
