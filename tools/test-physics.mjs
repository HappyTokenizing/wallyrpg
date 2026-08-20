/* ============================================================
   tools/test-physics.mjs — headless verification of src/physics/*.

   No renderer, no DOM, no screenshots. This harness boots ctx.phys with
   a stub ctx, builds a small test world out of triangles and AABB
   proxies, and drives it exactly the way main.js does.

   What it proves:
     * the fallback plane answers before any geometry exists
     * a controller runs, accelerates on a curve, and holds a rest state
     * slopes: walkable under 48 deg, sliding over it
     * jumping onto a ledge / slope, coyote time, jump buffering
     * step offset climbs 0.30 m and refuses 0.60 m
     * falling off a ledge fires exactly one land event
     * NO TUNNELLING at 90 m/s horizontal or 45 m/s vertical
     * a 3-bone ear chain overshoots after a gust and then settles
       (that overshoot IS the feel — a chain that only decays is wrong)
     * ear inertia: the chain reacts to the ROOT accelerating, not just
       to wind
     * verlet cloth ripples, does not stretch, and does not explode
     * buoyancy finds the density-ratio waterline and fires ripples
     * the fixed timestep is dt-independent: jittery frame times produce
       bit-identical simulation state
     * nothing, anywhere, ever goes NaN

   Run:  node tools/test-physics.mjs        [--verbose]
   ============================================================ */

/* contracts.js reads `devicePixelRatio` at module scope for the quality
   tiers, so give Node the browser globals it expects before importing. */
globalThis.devicePixelRatio = 1;
globalThis.self = globalThis;

const THREE = await import('../vendor/three.module.js');
const { init: initPhysics, FIXED_DT } = await import('../src/physics/physics.js');

const VERBOSE = process.argv.includes('--verbose');

/* ------------------------------------------------------------------
   Tiny test runner
   ------------------------------------------------------------------ */
let passed = 0;
const failures = [];
let currentTest = '';

async function test(name, fn) {
  currentTest = name;
  const t0 = process.hrtime.bigint();
  try {
    await fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name} \x1b[90m(${ms.toFixed(0)}ms)\x1b[0m`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n        ${e.message}`);
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: ${a} vs ${b} (tol ${tol})`);
}
function finite(v, msg) {
  const s = typeof v === 'number' ? v : (v.x + v.y + v.z);
  if (!Number.isFinite(s)) throw new Error(`${msg}: not finite (${JSON.stringify(v)})`);
}
function log(...a) { if (VERBOSE) console.log('       ', ...a); }

/* ------------------------------------------------------------------
   Stub ctx: a bus and a deterministic wind field with the same shape
   as core/wind.js (vector / sample / uniforms).
   ------------------------------------------------------------------ */
function makeWind() {
  const uniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindStrength: { value: 0.42 },
    uWindGust: { value: 0 },
    uWindFreq: { value: 0.34 },
  };
  return {
    uniforms,
    setGust(v) { uniforms.uWindGust.value = v; },
    setStrength(v) { uniforms.uWindStrength.value = v; },
    advance(dt) { uniforms.uTime.value += dt; },
    get strength() { return uniforms.uWindStrength.value + uniforms.uWindGust.value; },
    sample(x, z, phase = 0) {
      const d = uniforms.uWindDir.value, f = uniforms.uWindFreq.value, t = uniforms.uTime.value;
      const along = x * d.x + z * d.y;
      const cross = -x * d.y + z * d.x;
      const a = Math.sin(along * f - t * 2.4 + phase);
      const b = Math.sin(cross * f * 0.43 - t * 0.9 + phase * 1.7);
      return (a * 0.62 + b * 0.3) * this.strength;
    },
    vector(x, z, out) {
      const s = this.sample(x, z);
      const d = uniforms.uWindDir.value;
      const m = this.strength * 0.6 + s * 0.4;
      if (out) return out.set(d.x * m, 0, d.y * m);
      return { x: d.x * m, y: 0, z: d.y * m };
    },
  };
}

function makeBus() {
  const map = new Map();
  return {
    events: [],
    on(t, fn) { (map.get(t) ?? map.set(t, new Set()).get(t)).add(fn); return () => map.get(t).delete(fn); },
    emit(t, p) { this.events.push([t, p]); for (const fn of map.get(t) ?? []) fn(p); },
    count(t) { return this.events.filter((e) => e[0] === t).length; },
    clear() { this.events.length = 0; },
  };
}

async function makePhys(extra = {}) {
  const wind = makeWind();
  const bus = makeBus();
  const ctx = { bus, wind, ...extra };
  const phys = await initPhysics(ctx);
  return { phys, bus, wind, ctx };
}

/* Drive the sim exactly as main.js does: update() then lateUpdate(). */
function run(phys, seconds, dt = FIXED_DT, onFrame = null) {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    if (onFrame) onFrame(i * dt, i);
    phys.update(dt);
    phys.lateUpdate(dt);
  }
  return frames;
}

/* ------------------------------------------------------------------
   Test world. A 100 m ground slab, a 30 deg ramp, a 62 deg wall-slope,
   a raised ledge to walk off, two stairs and a thin wall for tunnelling.
   ------------------------------------------------------------------ */
const box = (x0, y0, z0, x1, y1, z1) =>
  new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));

/** Quad from four corners, wound so the normal points up-ish. */
function quad(a, b, c, d) {
  return [...a, ...b, ...c, ...a, ...c, ...d];
}

function buildWorld(phys) {
  phys.addAABB(box(-50, -2, -50, 50, 0, 50));                 // ground, top at y=0

  /* 30 deg ramp climbing +x from x=4 to x=10. */
  const h30 = 6 * Math.tan(30 * Math.PI / 180);
  phys.addTriangles(quad(
    [4, 0, -4], [4, 0, 4], [10, h30, 4], [10, h30, -4],
  ), null, { name: 'ramp30' });

  /* 62 deg slope climbing -x from x=-4 to x=-6 — over the 48 deg limit. */
  const h62 = 2 * Math.tan(62 * Math.PI / 180);
  phys.addTriangles(quad(
    [-4, 0, -4], [-6, h62, -4], [-6, h62, 4], [-4, 0, 4],
  ), null, { name: 'slope62' });

  /* A ledge to walk off: 2 m tall plateau spanning z in [20, 40]. */
  phys.addAABB(box(-10, 0, 20, 10, 2, 40), { name: 'ledge' });

  /* Stairs: one 0.30 m riser (climbable) and one 0.60 m (not). */
  phys.addAABB(box(-30, 0, -4, -26, 0.30, 4), { name: 'step-low' });
  phys.addAABB(box(-26, 0, -4, -22, 0.90, 4), { name: 'step-high' });

  /* Thin wall for the tunnelling test — 0.30 m thick. */
  phys.addAABB(box(15, 0, -6, 15.3, 4, 6), { name: 'thin-wall' });

  return { h30, h62 };
}

/** A controller with a settable input record. */
function makeRunner(phys, opts = {}) {
  const input = { x: 0, z: 0, jump: false, jumpHeld: false, run: true, crouch: false };
  const c = phys.createController({
    position: new THREE.Vector3(0, 0.05, 0),
    input: () => input,
    ...opts,
  });
  c.testInput = input;
  return c;
}

/* ==================================================================
   1. Standalone boot + the fallback plane
   ================================================================== */
console.log('\n\x1b[1mphysics\x1b[0m');


{
  const { phys } = await makePhys();
  await test('fallback plane: groundAt answers y=0 with no geometry', () => {
    const g = phys.groundAt(12.5, -300.25);
    near(g.y, 0, 1e-9, 'plane height');
    near(g.normal.y, 1, 1e-9, 'plane normal');
    ok(g.plane === true, 'should report the fallback plane');
    ok(phys.stats.triangles === 0, 'no triangles registered');
  });

  await test('fallback plane: raycast down hits it, up misses', () => {
    const hit = phys.raycast(new THREE.Vector3(3, 5, 3), new THREE.Vector3(0, -1, 0), 20);
    ok(hit, 'downward ray must hit the plane');
    near(hit.distance, 5, 1e-6, 'ray distance');
    near(hit.point.y, 0, 1e-6, 'ray hit y');
    const up = phys.raycast(new THREE.Vector3(3, 5, 3), new THREE.Vector3(0, 1, 0), 20);
    ok(up === null, 'upward ray must miss');
  });

  await test('fallback plane: a controller stands on it and stays put', () => {
    const c = phys.createController({ position: new THREE.Vector3(0, 3, 0) });
    run(phys, 3);
    finite(c.simPosition, 'position');
    near(c.simPosition.y, 0, 0.02, 'settles on the plane');
    ok(c.grounded, 'grounded');
    ok(c.speed < 0.05, `rest state (speed ${c.speed})`);
    c.dispose();
  });

  await test('registering geometry switches the fallback plane off', () => {
    phys.addAABB(box(-5, -1, -5, 5, 1.5, 5));
    ok(phys.stats.plane === null, 'plane must deactivate');
    near(phys.groundAt(0, 0).y, 1.5, 1e-6, 'ground is now the box top');
    ok(phys.groundAt(40, 40).hit === false, 'off the box there is nothing');
  });
}

/* ==================================================================
   2. Raycast + groundAt against real geometry
   ================================================================== */
{
  const { phys } = await makePhys();
  const { h30 } = buildWorld(phys);

  await test('groundAt tracks a 30 deg ramp', () => {
    const g = phys.groundAt(7, 0);
    near(g.y, 3 * Math.tan(30 * Math.PI / 180), 1e-5, 'ramp height at x=7');
    near(Math.acos(g.normal.y) * 180 / Math.PI, 30, 0.01, 'ramp slope');
    log('ramp top', h30.toFixed(3));
  });

  await test('groundAt finds the top of a stacked AABB', () => {
    near(phys.groundAt(-24, 0).y, 0.90, 1e-5, 'high step top');
    near(phys.groundAt(-28, 0).y, 0.30, 1e-5, 'low step top');
    near(phys.groundAt(0, 30).y, 2.0, 1e-5, 'ledge top');
  });

  await test('raycast: sideways hit on the thin wall, normal faces the ray', () => {
    /* z = 5.5 keeps us clear of the ramp, which spans z in [-4, 4]. */
    const hit = phys.raycast(new THREE.Vector3(0, 1, 5.5), new THREE.Vector3(1, 0, 0), 40);
    ok(hit, 'must hit the wall');
    near(hit.point.x, 15, 1e-4, 'wall face');
    ok(hit.normal.x < -0.9, `normal must oppose the ray (${hit.normal.x})`);
  });

  await test('raycast: 4000 random rays, all finite, none escape the slab', () => {
    const o = new THREE.Vector3(), d = new THREE.Vector3();
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const a = i * 0.7919, b = i * 1.3137;
      o.set(Math.sin(a) * 20, 1 + Math.abs(Math.cos(b)) * 6, Math.cos(a * 1.7) * 20);
      d.set(Math.sin(b), -Math.abs(Math.sin(a * 2.3)) - 0.05, Math.cos(b * 0.9));
      const h = phys.raycast(o, d, 60);
      if (h) { hits++; finite(h.point, 'ray hit point'); finite(h.distance, 'ray distance'); }
    }
    ok(hits > 3000, `most downward rays should hit the ground slab (${hits}/4000)`);
  });
}

/* ==================================================================
   3. The controller — movement feel
   ================================================================== */
{
  const { phys, bus } = await makePhys();
  buildWorld(phys);
  const c = makeRunner(phys);

  await test('acceleration is a CURVE: most of top speed arrives early', () => {
    c.teleport(new THREE.Vector3(0, 0.05, 0));
    c.testInput.z = 1; c.testInput.run = true;
    const samples = [];
    run(phys, 1.0, FIXED_DT, (t) => { samples.push(c.planarSpeed); });
    const top = c.opts.runSpeed;
    const at100 = samples[6] / top;      // ~0.1 s
    const at300 = samples[18] / top;     // ~0.3 s
    log('speed@0.1s', at100.toFixed(3), 'speed@0.3s', at300.toFixed(3), 'final', (c.planarSpeed / top).toFixed(3));
    ok(at100 > 0.35, `0.1s should already be >35% of top speed (${at100.toFixed(3)})`);
    ok(at300 > 0.85, `0.3s should be >85% of top speed (${at300.toFixed(3)})`);
    /* A linear ramp would sit at at300 ≈ 3 * at100. A curve does not. */
    ok(at300 < at100 * 2.6, 'must taper, not ramp linearly');
    near(c.planarSpeed, top, 0.35, 'reaches run speed');
  });

  await test('holds a flat rest state with no input (no creep, no jitter)', () => {
    c.testInput.z = 0;
    run(phys, 1.5);
    const p0 = c.simPosition.clone();
    run(phys, 3.0);
    ok(c.speed < 0.02, `velocity settles (${c.speed})`);
    ok(c.simPosition.distanceTo(p0) < 1e-3, `position must not creep (${c.simPosition.distanceTo(p0)})`);
    ok(c.grounded, 'stays grounded');
    near(c.simPosition.y, 0, 0.01, 'stays on the floor');
  });

  await test('walks up a 30 deg slope and stays glued to it', () => {
    c.teleport(new THREE.Vector3(2.0, 0.05, 0));
    c.testInput.x = 1; c.testInput.z = 0; c.testInput.run = true;
    run(phys, 1.0);                      // stop before he crests at x=10
    finite(c.simPosition, 'position on ramp');
    ok(c.simPosition.x > 5.5 && c.simPosition.x < 9.5,
      `must be climbing the ramp (x=${c.simPosition.x.toFixed(2)})`);
    const g = phys.groundAt(c.simPosition.x, c.simPosition.z);
    near(c.simPosition.y, g.y, 0.06, 'feet track the ramp surface');
    ok(c.grounded && !c.onSteepSlope, 'a 30 deg slope is walkable');
    near(c.groundSlope * 180 / Math.PI, 30, 1.5, 'reports the slope angle');
  });

  await test('cannot stand on a 62 deg slope — it slides him off', () => {
    c.teleport(new THREE.Vector3(-3.0, 0.05, 0));
    c.testInput.x = -1; c.testInput.z = 0;
    run(phys, 2.5);
    finite(c.simPosition, 'position on steep slope');
    ok(c.simPosition.x > -4.6, `must not climb past the toe (x=${c.simPosition.x.toFixed(2)})`);
    ok(c.simPosition.y < 0.5, `must not gain height (y=${c.simPosition.y.toFixed(2)})`);
  });

  await test('step offset: climbs a 0.30 m riser', () => {
    c.teleport(new THREE.Vector3(-32, 0.05, 0));
    c.testInput.x = 1; c.testInput.z = 0; c.testInput.run = false;
    run(phys, 3.0);
    ok(c.simPosition.x > -28.5, `must get onto the low step (x=${c.simPosition.x.toFixed(2)})`);
    near(c.simPosition.y, 0.30, 0.05, 'stands on the 0.30 m step');
  });

  await test('step offset: refuses a 0.60 m riser', () => {
    c.teleport(new THREE.Vector3(-27.5, 0.30, 0));
    c.testInput.x = 1; c.testInput.z = 0; c.testInput.run = true;
    run(phys, 3.0);
    ok(c.simPosition.y < 0.55, `must not climb 0.60 m (y=${c.simPosition.y.toFixed(2)})`);
    ok(c.simPosition.x < -25.9, `blocked by the high step (x=${c.simPosition.x.toFixed(2)})`);
  });

  await test('wall slide: running into a wall at an angle keeps lateral speed', () => {
    c.teleport(new THREE.Vector3(13, 0.05, 0));
    c.testInput.x = 1; c.testInput.z = 0.85; c.testInput.run = true;
    run(phys, 2.0);
    ok(c.simPosition.x < 15.0, `must not pass the wall (x=${c.simPosition.x.toFixed(3)})`);
    ok(c.simPosition.z > 3.0, `must slide along it (z=${c.simPosition.z.toFixed(2)})`);
    finite(c.simPosition, 'wall slide position');
  });

  await test('jump: buffered press + coyote time, lands once, squash fires', () => {
    bus.clear();
    c.teleport(new THREE.Vector3(0, 0.05, -10));
    c.testInput.x = 0; c.testInput.z = 0; c.testInput.run = false;
    run(phys, 0.5);
    let apex = 0;
    c.testInput.jump = true; c.testInput.jumpHeld = true;
    run(phys, 0.05);
    c.testInput.jump = false;
    run(phys, 2.0, FIXED_DT, () => { apex = Math.max(apex, c.simPosition.y); });
    log('apex', apex.toFixed(3), 'target', c.opts.jumpHeight);
    near(apex, c.opts.jumpHeight, 0.22, 'jump apex ~= jumpHeight');
    ok(bus.count('phys:jump') === 1, `exactly one jump event (${bus.count('phys:jump')})`);
    ok(bus.count('phys:land') === 1, `exactly one land event (${bus.count('phys:land')})`);
    const land = bus.events.find((e) => e[0] === 'phys:land')[1];
    ok(land.impact > 0.1, `landing carries an impact value (${land.impact.toFixed(3)})`);
    ok(c.squash.y > 0.6 && c.squash.y <= 1.45, 'squash signal in range');
    ok(c.grounded, 'back on the ground');
  });

  await test('jump cut: releasing early gives a materially lower apex', () => {
    c.teleport(new THREE.Vector3(0, 0.05, -10));
    let apexHeld = 0, apexCut = 0;
    c.testInput.jump = true; c.testInput.jumpHeld = true;
    run(phys, 0.05);
    c.testInput.jump = false;
    run(phys, 1.6, FIXED_DT, () => { apexHeld = Math.max(apexHeld, c.simPosition.y); });

    c.teleport(new THREE.Vector3(0, 0.05, -10));
    c.testInput.jump = true; c.testInput.jumpHeld = true;
    run(phys, 0.05);
    c.testInput.jump = false; c.testInput.jumpHeld = false;
    run(phys, 1.6, FIXED_DT, () => { apexCut = Math.max(apexCut, c.simPosition.y); });
    c.testInput.jumpHeld = false;
    log('apex held', apexHeld.toFixed(3), 'apex cut', apexCut.toFixed(3));
    ok(apexCut < apexHeld * 0.8, `cut jump must be much lower (${apexCut.toFixed(2)} vs ${apexHeld.toFixed(2)})`);
  });

  await test('coyote time: a jump 0.08 s after leaving the ledge still works', () => {
    bus.clear();
    /* Walk off the ledge, then press jump within the coyote window. */
    c.teleport(new THREE.Vector3(0, 2.05, 39.0));
    c.testInput.x = 0; c.testInput.z = 1; c.testInput.run = true;
    let leftAt = -1, t = 0, jumped = false, apex = 0;
    run(phys, 2.5, FIXED_DT, () => {
      t += FIXED_DT;
      if (leftAt < 0 && !c.grounded && c.simPosition.y > 1.5) leftAt = t;
      if (leftAt > 0 && !jumped && t - leftAt >= 0.06) {
        c.testInput.jump = true; c.testInput.jumpHeld = true; jumped = true;
      } else if (jumped) c.testInput.jump = false;
      apex = Math.max(apex, c.simPosition.y);
    });
    c.testInput.jumpHeld = false;
    ok(leftAt > 0, 'must actually leave the ledge');
    ok(bus.count('phys:jump') === 1, `coyote jump must fire (${bus.count('phys:jump')})`);
    ok(apex > 2.4, `coyote jump must gain height (apex ${apex.toFixed(2)})`);
  });

  await test('falls off a ledge and lands on the floor below', () => {
    bus.clear();
    c.teleport(new THREE.Vector3(0, 2.05, 30));
    c.testInput.x = 0; c.testInput.z = -1; c.testInput.run = true;
    c.testInput.jump = false; c.testInput.jumpHeld = false;
    let maxAir = 0;
    run(phys, 4.0, FIXED_DT, () => { maxAir = Math.max(maxAir, c.airTime); });
    finite(c.simPosition, 'position after the fall');
    ok(c.simPosition.z < 19.5, `must clear the ledge (z=${c.simPosition.z.toFixed(2)})`);
    near(c.simPosition.y, 0, 0.05, 'lands on the ground slab');
    ok(maxAir > 0.25, `must actually be airborne (${maxAir.toFixed(2)}s)`);
    ok(bus.count('phys:land') === 1, `one land event (${bus.count('phys:land')})`);
    ok(c.grounded, 'grounded at the end');
  });

  await test('jumps onto the 30 deg ramp from flat ground', () => {
    c.teleport(new THREE.Vector3(1.2, 0.05, 0));
    c.testInput.x = 1; c.testInput.z = 0; c.testInput.run = true;
    run(phys, 0.45);
    c.testInput.jump = true; c.testInput.jumpHeld = true;
    run(phys, 0.05);
    c.testInput.jump = false;
    run(phys, 2.0);
    c.testInput.jumpHeld = false;
    finite(c.simPosition, 'position after the ramp jump');
    ok(c.simPosition.x > 4.2, `must land up the ramp (x=${c.simPosition.x.toFixed(2)})`);
    const g = phys.groundAt(c.simPosition.x, c.simPosition.z);
    near(c.simPosition.y, g.y, 0.08, 'ends up on the ramp surface');
    ok(c.grounded, 'grounded on the ramp');
  });

  await test('footstep events fire at roughly the stride length', () => {
    bus.clear();
    c.teleport(new THREE.Vector3(0, 0.05, -20));
    c.testInput.x = 0; c.testInput.z = 1; c.testInput.run = true;
    const z0 = c.simPosition.z;
    run(phys, 3.0);
    const dist = c.simPosition.z - z0;
    const steps = bus.count('phys:step');
    const expect = dist / c.opts.strideLength;
    log('distance', dist.toFixed(2), 'steps', steps, 'expected', expect.toFixed(1));
    ok(Math.abs(steps - expect) <= 2, `stride cadence (${steps} vs ${expect.toFixed(1)})`);
  });
}

/* ==================================================================
   4. No tunnelling
   ================================================================== */
{
  const { phys } = await makePhys();
  buildWorld(phys);

  await test('no tunnelling: 90 m/s into a 0.30 m wall', () => {
    /* z = 5.5 keeps him off the ramp — otherwise he launches over the wall. */
    const c = phys.createController({ position: new THREE.Vector3(0, 0.05, 5.5), player: false });
    /* Re-inject the speed every fixed step so drag cannot rescue us. */
    c.setInputFn(() => { c.velocity.x = 90; return { x: 0, z: 0 }; });
    let worst = -Infinity;
    run(phys, 1.5, FIXED_DT, () => { worst = Math.max(worst, c.simPosition.x); });
    log('deepest x', worst.toFixed(4), 'wall face 15.0, radius', c.radius);
    finite(c.simPosition, 'position');
    ok(worst < 15.0, `must never reach the wall face (got ${worst.toFixed(4)})`);
    c.dispose();
  });

  await test('no tunnelling: dropped from 200 m onto the ground slab', () => {
    const c = phys.createController({
      position: new THREE.Vector3(0, 200, 0), snapOnSpawn: false, player: false,
    });
    let minY = Infinity, maxFall = 0;
    run(phys, 10, FIXED_DT, () => {
      minY = Math.min(minY, c.simPosition.y);
      maxFall = Math.max(maxFall, -c.velocity.y);
    });
    log('peak fall speed', maxFall.toFixed(1), 'lowest y', minY.toFixed(4));
    ok(maxFall > 30, 'must actually reach terminal-ish speed');
    ok(minY > -0.05, `must not punch through the floor (min y ${minY.toFixed(4)})`);
    near(c.simPosition.y, 0, 0.02, 'rests on the floor');
    ok(c.grounded, 'grounded after the drop');
    c.dispose();
  });

  await test('no tunnelling: 300 random launches never leave the world', () => {
    const c = phys.createController({ position: new THREE.Vector3(0, 1, 0), player: false });
    let escaped = 0;
    for (let i = 0; i < 300; i++) {
      const a = i * 2.399963, s = 8 + (i % 17) * 3.4;
      c.velocity.set(Math.cos(a) * s, Math.sin(i * 0.77) * 12, Math.sin(a) * s);
      run(phys, 0.2);
      finite(c.simPosition, `launch ${i} position`);
      finite(c.velocity, `launch ${i} velocity`);
      if (c.simPosition.y < -0.5) escaped++;
      if (Math.abs(c.simPosition.x) > 60 || Math.abs(c.simPosition.z) > 60) {
        c.teleport(new THREE.Vector3(0, 1, 0));
      }
    }
    ok(escaped === 0, `${escaped} launches fell through the world`);
    c.dispose();
  });
}

/* ==================================================================
   5. Spring chains — THE feel test
   ================================================================== */
{
  const { phys, wind } = await makePhys();

  await test('ear chain: builds at rest with zero energy and correct length', () => {
    const ear = phys.createChain({
      preset: 'ear', bones: 3, restDir: [0, -1, 0], wind: null,
      position: new THREE.Vector3(0, 2, 0),
    });
    ok(ear.n === 3, '3 bones');
    near(ear.tip.distanceTo(ear.points[0]), 3 * 0.09, 1e-6, 'chain length');
    near(ear.energy, 0, 1e-12, 'starts asleep');
    ear.dispose();
  });

  await test('ear chain: a gust deflects it, then it OVERSHOOTS and settles', () => {
    /* A switchable uniform gust along +x, so the signal is unambiguous. */
    let gust = 0;
    const ear = phys.createChain({
      preset: 'ear', bones: 3, restDir: [0, -1, 0],
      position: new THREE.Vector3(0, 2, 0),
      wind: (x, z, p) => ({ x: gust, y: 0, z: 0 }),
      phase: 0,
    });

    const trace = [];
    const sample = () => trace.push(ear.tip.x);

    /* 1. Gust on for 0.5 s — it must blow downwind. */
    gust = 1.0;
    run(phys, 0.5, FIXED_DT, sample);
    const peak = Math.max(...trace);
    ok(peak > 0.01, `gust must visibly deflect the ear (peak ${peak.toFixed(4)} m)`);

    /* 2. Gust off — it must swing back THROUGH rest, not merely decay. */
    gust = 0;
    const after = [];
    run(phys, 1.2, FIXED_DT, () => after.push(ear.tip.x));
    const undershoot = Math.min(...after);
    log('peak', peak.toFixed(4), 'overshoot past rest', undershoot.toFixed(4));
    ok(undershoot < -0.002,
      `must cross past rest — that overshoot IS the feel (got ${undershoot.toFixed(5)} m)`);
    ok(undershoot > -peak, 'overshoot must be smaller than the original push');

    /* 3. ...and then genuinely settle. */
    run(phys, 3.0);
    log('settled energy', ear.energy.toExponential(2), 'deviation', ear.deviation.toFixed(6));
    ok(ear.energy < 1e-4, `must come to rest (energy ${ear.energy.toExponential(2)})`);
    ok(ear.deviation < 0.02, `must return near its rest pose (${ear.deviation.toFixed(4)} m)`);
    finite(ear.tip, 'tip');
    ear.dispose();
  });

  await test('ear chain: reacts to the ROOT accelerating (running, stopping)', () => {
    const root = new THREE.Vector3(0, 2, 0);
    const ear = phys.createChain({
      preset: 'ear', bones: 3, restDir: [0, -1, 0], wind: null,
      position: root.clone(),
    });
    /* Accelerate the head from rest to 6.4 m/s over 0.35 s, then stop dead. */
    let x = 0, v = 0, maxDev = 0;
    run(phys, 1.6, FIXED_DT, (t) => {
      if (t < 0.35) v = Math.min(6.4, v + 20 * FIXED_DT);
      else if (t < 0.8) { /* cruise */ }
      else v = Math.max(0, v - 40 * FIXED_DT);
      x += v * FIXED_DT;
      ear.setRoot(root.set(x, 2, 0));
      maxDev = Math.max(maxDev, ear.deviation);
    });
    log('max deviation under body accel', maxDev.toFixed(4));
    ok(maxDev > 0.01, `body acceleration must whip the ear (${maxDev.toFixed(4)} m)`);
    run(phys, 3.0);
    ok(ear.energy < 1e-4, `must settle once he stops (${ear.energy.toExponential(2)})`);
    ear.dispose();
  });

  await test('ear chain: impulse() gives the landing flap and it decays', () => {
    const ear = phys.createChain({
      preset: 'ear', bones: 3, restDir: [0, -1, 0], wind: null,
      position: new THREE.Vector3(0, 2, 0),
    });
    run(phys, 0.5);
    const restX = ear.tip.x;
    /* Sideways: a kick along a hanging chain's own axis is purely radial
       and the length constraint eats it, which is correct. */
    ear.impulse(new THREE.Vector3(6, 0, 0));
    let peak = -Infinity, crossings = 0, prev = 0;
    run(phys, 2.5, FIXED_DT, () => {
      const d = ear.tip.x - restX;
      peak = Math.max(peak, d);
      if (prev !== 0 && Math.sign(d) !== Math.sign(prev) && Math.abs(d) > 1e-4) crossings++;
      prev = d;
    });
    log('impulse peak', peak.toFixed(4), 'zero crossings', crossings);
    ok(peak > 0.01, `impulse must lift the tip (${peak.toFixed(4)} m)`);
    ok(crossings >= 2, `must oscillate, not creep (${crossings} crossings)`);
    run(phys, 3);
    ok(ear.energy < 1e-4, 'settles');
    ear.dispose();
  });

  await test('trunk preset: 5 bones, heavier, settles without oscillating wildly', () => {
    const trunk = phys.createChain({
      preset: 'trunk', bones: 5, restDir: [0, -1, 0], wind: null,
      position: new THREE.Vector3(0, 2, 0),
    });
    ok(trunk.n === 5, '5 bones');
    trunk.impulse(new THREE.Vector3(5, 0, 0));
    let peak = 0;
    run(phys, 2.5, FIXED_DT, () => { peak = Math.max(peak, Math.abs(trunk.tip.x)); });
    ok(peak > 0.005, 'the trunk swings');
    run(phys, 3);
    ok(trunk.energy < 1e-4, `trunk settles (${trunk.energy.toExponential(2)})`);
    ok(trunk.deviation < 0.02, 'returns to rest');
    trunk.dispose();
  });

  await test('curl: setCurl bends the rest pose and the chain follows it', () => {
    const trunk = phys.createChain({
      preset: 'trunk', bones: 5, restDir: [0, -1, 0], curlAxis: [0, 0, 1], wind: null,
      position: new THREE.Vector3(0, 2, 0),
    });
    run(phys, 0.5);
    const straight = trunk.tip.clone();
    trunk.setCurl(0.35);
    run(phys, 2.5);
    const curled = trunk.tip.clone();
    log('tip moved', straight.distanceTo(curled).toFixed(4), 'm on curl');
    ok(straight.distanceTo(curled) > 0.05, `curl must move the tip (${straight.distanceTo(curled).toFixed(4)} m)`);
    ok(curled.y > straight.y, 'curling lifts the tip');
    run(phys, 2);
    ok(trunk.energy < 1e-4, 'settles at the curled pose');
    trunk.dispose();
  });

  await test('chain: inextensible under a 60 m/s^2 shove', () => {
    const ear = phys.createChain({
      preset: 'ear', bones: 3, restDir: [0, -1, 0], wind: null,
      position: new THREE.Vector3(0, 2, 0),
    });
    run(phys, 2.0, FIXED_DT, () => ear.setAcceleration(new THREE.Vector3(60, 0, 0)));
    for (let i = 0; i < ear.n; i++) {
      const L = ear.points[i + 1].distanceTo(ear.points[i]);
      near(L, ear.length[i], 1e-4, `segment ${i} length`);
    }
    finite(ear.tip, 'tip');
    ear.dispose();
  });

  await test('chain: 10 000 steps of real wind never goes NaN or explodes', () => {
    const ear = phys.createChain({
      preset: 'ear', bones: 3, restDir: [-0.92, -0.34, 0.18], phase: 2.1,
      position: new THREE.Vector3(3, 1.4, -2),
    });
    let maxDev = 0;
    for (let i = 0; i < 10000; i++) {
      wind.advance(FIXED_DT);
      wind.setGust(0.5 + 0.5 * Math.sin(i * 0.004));
      phys.update(FIXED_DT); phys.lateUpdate(FIXED_DT);
      maxDev = Math.max(maxDev, ear.deviation);
      if (!Number.isFinite(ear.tip.x + ear.tip.y + ear.tip.z)) throw new Error(`NaN at step ${i}`);
    }
    log('max deviation over 10k wind steps', maxDev.toFixed(4));
    ok(maxDev < 0.5, `bounded (${maxDev.toFixed(3)} m for a 0.27 m chain)`);
    ok(maxDev > 0.002, 'the wind must actually move it');
    wind.setGust(0);
    ear.dispose();
  });

  await test('scalar + vector springs and the squash helper behave', () => {
    const s = phys.createSpring({ value: 0, stiffness: 200, dampingRatio: 0.4 });
    let over = 0;
    for (let i = 0; i < 200; i++) over = Math.max(over, s.step(FIXED_DT, 1));
    ok(over > 1.05, `an under-damped spring must overshoot (${over.toFixed(3)})`);
    near(s.value, 1, 1e-3, 'settles on target');

    const crit = phys.createSpring({ value: 0, stiffness: 200, dampingRatio: 1.0 });
    let critOver = 0;
    for (let i = 0; i < 200; i++) critOver = Math.max(critOver, crit.step(FIXED_DT, 1));
    ok(critOver <= 1.001, `critically damped must not overshoot (${critOver.toFixed(4)})`);

    const v = phys.createSpringVec3({ stiffness: 150, dampingRatio: 1.0 });
    const tgt = new THREE.Vector3(2, 3, -1);
    for (let i = 0; i < 400; i++) v.step(FIXED_DT, tgt);
    ok(v.value.distanceTo(tgt) < 1e-3, 'vec3 spring reaches its target');

    const sq = phys.createSquash();
    sq.land(1);
    let minY = 1;
    for (let i = 0; i < 60; i++) { sq.step(FIXED_DT); minY = Math.min(minY, sq.y); }
    log('landing squash', minY.toFixed(3), 'xz', sq.xz.toFixed(3));
    ok(minY < 0.93 && minY > 0.75, `~14% landing squash (${minY.toFixed(3)})`);
    for (let i = 0; i < 120; i++) sq.step(FIXED_DT);
    near(sq.y, 1, 0.01, 'squash returns to 1');
  });
}

/* ==================================================================
   6. Verlet cloth
   ================================================================== */
{
  const { phys, wind } = await makePhys();

  await test('cloth: builds a geometry with the right vertex and index counts', () => {
    const flag = phys.createCloth({
      cols: 14, rows: 9, width: 1.6, height: 1.0,
      origin: new THREE.Vector3(0, 6, 0), pin: 'left',
    });
    ok(flag.geometry, 'geometry built for you');
    ok(flag.geometry.attributes.position.count === 14 * 9, 'vertex count');
    ok(flag.geometry.getIndex().count === 13 * 8 * 6, 'index count');
    ok(flag.geometry.attributes.uv.count === 14 * 9, 'uvs');
    flag.dispose();
  });

  await test('cloth: hangs, ripples in the wind, and never stretches', () => {
    const flag = phys.createCloth({
      cols: 14, rows: 9, width: 1.6, height: 1.0,
      origin: new THREE.Vector3(0, 6, 0), pin: 'left', phase: 0.4,
    });
    wind.setStrength(0.6);
    let maxStretch = 1, minEnergy = Infinity, maxEnergy = 0;
    for (let i = 0; i < 900; i++) {
      wind.advance(FIXED_DT);
      wind.setGust(0.35 + 0.35 * Math.sin(i * 0.01));
      phys.update(FIXED_DT); phys.lateUpdate(FIXED_DT);
      if (i > 120) {
        maxStretch = Math.max(maxStretch, flag.maxStretch);
        minEnergy = Math.min(minEnergy, flag.energy);
        maxEnergy = Math.max(maxEnergy, flag.energy);
      }
    }
    log('maxStretch', maxStretch.toFixed(4), 'energy', minEnergy.toExponential(2), '->', maxEnergy.toExponential(2));
    for (let p = 0; p < flag.count; p++) finite(flag.getPoint(p), `particle ${p}`);
    ok(maxStretch < 1.08, `structural edges must stay rigid (${maxStretch.toFixed(4)})`);
    ok(minEnergy > 1e-7, 'it must never stop moving while the wind blows');
    /* Ripple, not jitter: the motion is a slow swell, not per-step noise. */
    ok(maxEnergy < 0.4, `must not shimmer or explode (peak energy ${maxEnergy.toExponential(2)})`);

    /* The free edge has to actually travel downwind of the pinned edge. */
    const pinned = flag.getPoint(flag.index(0, 4));
    const free = flag.getPoint(flag.index(13, 4));
    log('free edge offset', (free.x - pinned.x).toFixed(3), (free.y - pinned.y).toFixed(3));
    ok(free.x - pinned.x > 0.6, 'the free edge streams downwind');
    ok(free.y < pinned.y, 'and hangs below the pin under gravity');
    flag.dispose();
  });

  await test('cloth: settles to a stable hang when the wind stops', () => {
    const flag = phys.createCloth({
      cols: 10, rows: 10, width: 1.0, height: 1.0,
      origin: new THREE.Vector3(0, 6, 0), pin: 'top', wind: null,
    });
    run(phys, 6.0);
    const e = flag.energy;
    const p0 = flag.getPoint(flag.index(5, 9));
    run(phys, 3.0);
    const p1 = flag.getPoint(flag.index(5, 9));
    log('settled energy', e.toExponential(2), 'drift', p0.distanceTo(p1).toExponential(2));
    ok(e < 1e-5, `must reach a stable rest state (${e.toExponential(2)})`);
    ok(p0.distanceTo(p1) < 1e-3, 'and stay there');
    near(flag.maxStretch, 1, 0.02, 'no residual stretch');
    flag.dispose();
  });

  await test('cloth: pinned particles do not move; movePins carries the sheet', () => {
    const awn = phys.createCloth({
      cols: 8, rows: 6, width: 1.2, height: 0.8,
      origin: new THREE.Vector3(0, 3, 0), pin: 'top', wind: null,
    });
    const pinBefore = awn.getPoint(awn.index(3, 0));
    run(phys, 2.0);
    const pinAfter = awn.getPoint(awn.index(3, 0));
    ok(pinBefore.distanceTo(pinAfter) < 1e-9, 'pins are immovable');
    awn.movePins(2, 0, 0);
    near(awn.getPoint(awn.index(3, 0)).x, pinBefore.x + 2, 1e-6, 'movePins translates the pin');
    run(phys, 3.0);
    ok(awn.getPoint(awn.index(3, 5)).x > pinBefore.x + 1.2, 'the sheet follows its pins');
    finite(awn.getPoint(awn.index(3, 5)), 'moved cloth');
    awn.dispose();
  });
}

/* ==================================================================
   7. Buoyancy
   ================================================================== */
{
  const { phys, bus } = await makePhys();
  phys.setWaterLevel(0);

  await test('buoy: a crate finds the density-ratio waterline and stays there', () => {
    const crate = phys.createBuoy({
      shape: 'sphere', radius: 0.4, density: 420,
      position: new THREE.Vector3(0, 3, 0),
    });
    run(phys, 12);
    finite(crate.position, 'crate position');
    log('submerged', crate.submerged.toFixed(3), 'y', crate.position.y.toFixed(3));
    near(crate.submerged, 0.42, 0.08, 'floats at rho_body / rho_water');
    ok(crate.inWater, 'in the water');
    ok(Math.abs(crate.velocity.y) < 0.15, `bobbing dies down (${crate.velocity.y.toFixed(3)})`);
    crate.dispose();
  });

  await test('buoy: entering the water fires a splash, then ripple rings', () => {
    bus.clear();
    const b = phys.createBuoy({
      shape: 'box', size: new THREE.Vector3(0.7, 0.7, 0.7), density: 500,
      position: new THREE.Vector3(4, 6, 4),
    });
    run(phys, 8);
    log('splashes', bus.count('water:splash'), 'ripples', bus.count('water:ripple'));
    ok(bus.count('water:splash') === 1, `exactly one splash (${bus.count('water:splash')})`);
    ok(bus.count('water:ripple') > 2, `ripple rings while it bobs (${bus.count('water:ripple')})`);
    const r = bus.events.find((e) => e[0] === 'water:ripple')[1];
    ok(r.radius > 0 && r.strength > 0, 'ripple carries a radius and a strength');
    near(r.y, 0, 1e-9, 'ripple sits on the surface');
    b.dispose();
  });

  await test('buoy: a dense body sinks, a light one is pushed clear', () => {
    const rock = phys.createBuoy({ shape: 'sphere', radius: 0.3, density: 2600, position: new THREE.Vector3(-4, 1, 0) });
    const cork = phys.createBuoy({ shape: 'sphere', radius: 0.3, density: 120, position: new THREE.Vector3(-8, -2, 0) });
    run(phys, 6);
    finite(rock.position, 'rock'); finite(cork.position, 'cork');
    ok(rock.position.y < -3, `dense body sinks (${rock.position.y.toFixed(2)})`);
    ok(cork.submerged < 0.3, `light body rides high (${cork.submerged.toFixed(3)})`);
    rock.dispose(); cork.dispose();
  });

  await test('buoy: 60 m/s entry does not explode', () => {
    const b = phys.createBuoy({ shape: 'sphere', radius: 0.35, density: 600, position: new THREE.Vector3(9, 2, 0) });
    b.velocity.set(0, -60, 0);
    let worst = 0;
    run(phys, 8, FIXED_DT, () => { worst = Math.max(worst, b.velocity.length()); });
    finite(b.position, 'position'); finite(b.velocity, 'velocity');
    /* 60 m/s entry + a touch of free-fall before the surface: anything
       much above that means explicit drag flipped the sign. */
    ok(worst < 62, `drag must never invert the velocity (peak |v| ${worst.toFixed(1)})`);
    near(b.submerged, 0.6, 0.15, 'still finds its waterline');
    b.dispose();
  });

  await test('buoy: object3D is driven and interpolated', () => {
    const obj = new THREE.Object3D();
    const b = phys.createBuoy({ shape: 'sphere', radius: 0.3, density: 400, object3D: obj, position: new THREE.Vector3(12, 2, 0) });
    run(phys, 5);
    finite(obj.position, 'object position');
    near(obj.position.y, b.position.y, 0.02, 'the Object3D tracks the body');
    b.dispose();
  });
}

/* ==================================================================
   8. The fixed timestep itself
   ================================================================== */
{
  await test('fixed timestep: jittery frame times give identical simulation state', async () => {
    const build = async () => {
      const { phys } = await makePhys();
      buildWorld(phys);
      const c = makeRunner(phys);
      c.testInput.x = 0.7; c.testInput.z = 1; c.testInput.run = true;
      const chain = phys.createChain({
        preset: 'ear', bones: 3, restDir: [0, -1, 0], wind: null,
        position: new THREE.Vector3(0, 2, 0),
      });
      return { phys, c, chain };
    };

    const TARGET = 420;                       // fixed steps to compare at

    const a = await build();
    let stepsA = 0;
    while (stepsA < TARGET) { a.phys.update(FIXED_DT); a.phys.lateUpdate(FIXED_DT); stepsA += a.phys.stepsLastFrame; }

    const b = await build();
    let stepsB = 0, i = 0;
    while (stepsB < TARGET) {
      /* 8 ms .. 41 ms — everything from 120 fps to a hitch. */
      const dt = 0.008 + ((i * 9301 + 49297) % 233280) / 233280 * 0.033;
      i++;
      const before = stepsB;
      if (stepsB + 5 > TARGET) {
        /* Land exactly on TARGET so the comparison is meaningful. */
        while (stepsB < TARGET) { b.phys.update(FIXED_DT); b.phys.lateUpdate(FIXED_DT); stepsB += b.phys.stepsLastFrame; }
        break;
      }
      b.phys.update(dt); b.phys.lateUpdate(dt);
      stepsB += b.phys.stepsLastFrame;
      if (stepsB === before && i > 4000) throw new Error('accumulator stalled');
    }

    ok(stepsA === stepsB, `same step count (${stepsA} vs ${stepsB})`);
    const d = a.c.simPosition.distanceTo(b.c.simPosition);
    log('controller divergence', d.toExponential(2), 'chain tip', a.chain.tip.distanceTo(b.chain.tip).toExponential(2));
    ok(d < 1e-9, `controller state must be dt-independent (diverged ${d.toExponential(3)} m)`);
    ok(a.chain.tip.distanceTo(b.chain.tip) < 1e-9, 'chain state must be dt-independent');
    ok(Math.abs(a.phys.simTime - b.phys.simTime) < 1e-9, 'sim clocks agree');
  });

  await test('fixed timestep: a 2 s hitch does not spiral or teleport anyone', async () => {
    const { phys } = await makePhys();
    buildWorld(phys);
    const c = makeRunner(phys);
    c.testInput.z = 1;
    run(phys, 1.0);
    const before = c.simPosition.clone();
    phys.update(2.0);                       // the hitch
    phys.lateUpdate(2.0);
    log('steps run for a 2 s frame', phys.stepsLastFrame, 'moved', c.simPosition.distanceTo(before).toFixed(3));
    ok(phys.stepsLastFrame <= 5, `must clamp catch-up (${phys.stepsLastFrame} steps)`);
    ok(c.simPosition.distanceTo(before) < 1.0, 'must not teleport across the map');
    finite(c.simPosition, 'position after the hitch');
    /* And the accumulator must not still be in debt on the next frame. */
    phys.update(FIXED_DT); phys.lateUpdate(FIXED_DT);
    ok(phys.stepsLastFrame === 1, `back to real time immediately (${phys.stepsLastFrame})`);
  });

  await test('interpolation: rendered position leads/lags between fixed steps', async () => {
    const { phys } = await makePhys();
    buildWorld(phys);
    const c = makeRunner(phys);
    c.testInput.z = 1; c.testInput.run = true;
    run(phys, 1.0);
    /* Half a step of extra time: the rendered position must sit between
       the previous and the current simulated one. */
    phys.update(FIXED_DT * 0.5);
    near(phys.alpha, 0.5, 0.02, 'alpha is the accumulator remainder');
    const lo = Math.min(c._prevPosition.z, c.simPosition.z);
    const hi = Math.max(c._prevPosition.z, c.simPosition.z);
    ok(c.position.z >= lo - 1e-9 && c.position.z <= hi + 1e-9,
      'rendered position lies between the two sim positions');
  });
}

/* ==================================================================
   9. Lifecycle
   ================================================================== */
{
  await test('bodies are dropped after dispose and the sim keeps running', async () => {
    const { phys } = await makePhys();
    buildWorld(phys);
    const c = makeRunner(phys);
    const ear = phys.createChain({ preset: 'ear', bones: 3, position: new THREE.Vector3(0, 2, 0) });
    const flag = phys.createCloth({ cols: 6, rows: 6, origin: new THREE.Vector3(0, 5, 0) });
    const buoy = phys.createBuoy({ position: new THREE.Vector3(0, 5, 0) });
    run(phys, 0.5);
    ok(phys.stats.controllers === 1 && phys.stats.chains === 1, 'registered');
    ear.dispose(); flag.dispose(); buoy.dispose(); c.dispose();
    run(phys, 0.5);
    const s = phys.stats;
    ok(s.controllers === 0 && s.chains === 0 && s.cloths === 0 && s.buoys === 0,
      `all dropped (${JSON.stringify(s)})`);
    run(phys, 0.5);        // must not throw on an empty world
  });

  await test('remove() unregisters collision and the world keeps answering', async () => {
    const { phys } = await makePhys();
    const id = phys.addAABB(box(-5, 0, -5, 5, 3, 5));
    near(phys.groundAt(0, 0).y, 3, 1e-6, 'on the box');
    ok(phys.remove(id), 'removed');
    const g = phys.groundAt(0, 0);
    ok(g.hit === false || g.y !== 3, 'the box is gone');
    phys.setGroundPlane(0);
    near(phys.groundAt(0, 0).y, 0, 1e-6, 'pinned plane answers again');
  });

  await test('world:collision bus event registers late geometry', async () => {
    const { phys, ctx } = await makePhys();
    ok(phys.stats.triangles === 0, 'starts empty');
    ctx.bus.emit('world:collision', box(-4, 0, -4, 4, 5, 4));
    ok(phys.stats.triangles === 12, `AABB ingested (${phys.stats.triangles} tris)`);
    near(phys.groundAt(0, 0).y, 5, 1e-6, 'and is collidable');
  });
}

/* ------------------------------------------------------------------ */
console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) {
    console.log(`\x1b[31m${f.name}\x1b[0m`);
    console.log(f.e.stack?.split('\n').slice(0, 4).join('\n'));
  }
  process.exit(1);
}
process.exit(0);
