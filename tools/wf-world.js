export const meta = {
  name: 'wally-phase2-world',
  description: 'Build the WALLY RPG island world and the Wally character, each item looping against its own harsh visual critic until it reaches AAA',
  phases: [
    { title: 'Wally',  detail: 'the character: model, rig, animation, ear/trunk physics' },
    { title: 'World',  detail: 'sky, terrain, city, foliage, water, camera, NPCs — in parallel, each looping' },
  ],
}

const ROOT = '/Users/herwig/Desktop/Claude files/wally-rpg'

const PREAMBLE = `You are an agent on the WALLY RPG build.
Project root: ${ROOT}   (cd there first; all paths are relative to it)

MANDATORY FIRST STEP — read in this order, in full, before writing anything:
  1. BUILD_BRIEF.md          the rules, the module contract, how to screenshot
  2. ART_DIRECTION.md        the law: colour, form, material, camera, physics
  3. src/core/contracts.js   ctx, ownership, quality tiers, damp/spring/rng helpers
  4. src/core/palette.js     every colour in the game
  5. src/core/wind.js        the global wind field — attach to anything that should move
  6. src/render/toon.js      ctx.mat — the material factory you MUST build everything from
  7. src/render/renderer.js  ctx.render — the frame pipeline
  8. src/physics/physics.js  ctx.phys — collision, controller, spring chains, cloth
  9. src/game/data.js        the world content: 28 locations, 10 zones, their 3D coords

The render core, physics and game data are already built by other agents. Do not
rewrite them. Read their real APIs from the source above and code against them.

You own ONLY the files listed in your task. Every other file belongs to another
agent working at this moment. Touching one loses your work in a conflict.

Never hardcode a colour — import from src/core/palette.js.
Never use Math.random() in world generation — use ctx.rng() / ctx.makeRng(seed),
because screenshots must be reproducible between builds.
`

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'score', 'blockers', 'notes'],
  properties: {
    verdict: { type: 'string', enum: ['AAA', 'CLOSE', 'AMATEUR'] },
    score: { type: 'number', description: '0-100; 90+ = shippable in a retail AAA game' },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'why', 'fix'],
        properties: {
          what: { type: 'string', description: 'the specific defect' },
          why: { type: 'string', description: 'why it reads as not-AAA' },
          fix: { type: 'string', description: 'the concrete change: file, parameter, direction' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const CRITIC_RUBRIC = `
Scoring discipline — this matters more than being encouraging:
  AAA     = 90+. You would ship this frame in a retail game. Genuine AAA is RARE.
            If you are hesitating between CLOSE and AAA, it is CLOSE.
  CLOSE   = 70-89. Good work, but a player would clock it as not-quite-there.
  AMATEUR = <70. Reads as a WebGL demo or a grey-box.

Automatic AMATEUR, no matter how nice the rest looks:
  - grey or black shadows instead of blue-violet (ART_DIRECTION §2.1)
  - a recognisable untextured Three.js primitive in frame
  - any flat, ungrained, perfectly clean surface
  - a completely static frame with nothing moving in the wind
  - the screenshot command failing, or a black/empty image

Every blocker must name the file, the parameter and the direction to move it.
"Improve the lighting" is useless and will be ignored. "In src/world/sky.js the
horizon band is 8 degrees too tight; widen uHorizonFalloff from 0.06 to ~0.14" is
what a useful blocker looks like.`

/* ------------------------------------------------------------------
   One item = one owned slice. Each loops build -> critique -> fix ->
   re-critique on its own, with no barrier against the other items,
   so a slow slice never stalls a fast one.
   ------------------------------------------------------------------ */

async function buildLoop(item, phaseName) {
  let last = await agent(`${PREAMBLE}\n${item.build}`,
    { label: `build:${item.key}`, phase: phaseName, effort: item.effort || 'high' })

  let best = null
  for (let round = 0; round < 2; round++) {
    const v = await agent(
      `You are a HARSH, sceptical AAA art director reviewing one slice of WALLY RPG.
Project root: ${ROOT}

Read ART_DIRECTION.md first — it is the standard you are judging against.

${item.critique}

${CRITIC_RUBRIC}`,
      { label: `critic:${item.key}${round ? `:r${round + 1}` : ''}`, phase: phaseName, schema: VERDICT, effort: 'high' })

    if (!v) break
    best = v
    log(`${item.key}: round ${round + 1} -> ${v.score}/100 ${v.verdict} (${v.blockers.length} blockers)`)
    if (v.verdict === 'AAA' || v.score >= 90 || !v.blockers.length) break
    if (round === 1) break   // final round: record the verdict, polish phase picks it up

    last = await agent(`${PREAMBLE}
YOU ARE THE ${item.key.toUpperCase()} AGENT AGAIN. An art director reviewed your work
and scored it ${v.score}/100 (${v.verdict}). Fix every blocker.

You own exactly the same files as before:
${item.files}

BLOCKERS:
${v.blockers.map((b, i) => `${i + 1}. ${b.what}\n   why: ${b.why}\n   fix: ${b.fix}`).join('\n')}

Reviewer notes:
${v.notes}

Where a blocker conflicts with another, ART_DIRECTION.md decides.
After each substantive change, re-screenshot and READ the PNG yourself. Keep working
until you would personally score it 90+. Do not report done on a partial fix.

Report <=25 lines: blocker by blocker, what changed, and your own honest score.`,
      { label: `fix:${item.key}`, phase: phaseName, effort: item.effort || 'high' })
  }

  return { key: item.key, score: best?.score ?? 0, verdict: best?.verdict ?? 'UNKNOWN', report: last, blockers: best?.blockers ?? [] }
}

/* ==================================================================
   Wally goes first and alone. He is the title character, every other
   agent's sense of scale, and the thing the whole art direction is
   built around — the world should be built against a finished Wally,
   not the other way round.
   ================================================================== */

phase('Wally')

const WALLY = {
  key: 'wally',
  effort: 'xhigh',
  files: `  src/character/wally.js       ctx.wally — build, rig, expose
  src/character/model.js      the procedural mesh
  src/character/rig.js        skeleton + skinning
  src/character/anim.js       the animation state machine and the clips
  src/character/secondary.js  ear/trunk/belly springs, squash & stretch
  src/character/expression.js blendshape-ish face/pose accents`,
  build: `YOU ARE THE WALLY AGENT. You are building the title character. Everything about
this game is judged on him first.

FILES YOU OWN (create/replace):
  src/character/wally.js, model.js, rig.js, anim.js, secondary.js, expression.js

ART_DIRECTION.md §1 is a full, exact transcription of the two reference renders of
Wally — a matte grey vinyl designer toy in black wayfarer sunglasses, shot on white
under a soft upper-left key. The renders themselves are not on disk; §1 IS the
reference. Follow its proportion table to the number. Re-read it as you work.

Non-negotiables from §1, in the order players will notice them:
  1. THE SILHOUETTE. Ears dominate: ear span 0.78H, 2.2x the shoulder width. Head ball
     0.30H, wider than the torso. Pear body, widest at the belly. Four stubby limbs.
     NO NECK — the head sits straight on the shoulders. Fill it black: it must read as
     ears + head-ball + pear + stubs, instantly.
  2. THE SUNGLASSES, and specifically THE GLINT. One white specular mark per lens,
     shaped like a flattened lightning bolt / lazy-Z: short horizontal stroke, diagonal
     drop right-and-down, second short horizontal stroke. Both lenses point the SAME
     way (not mirrored). ~14% of lens width, upper-left third of each lens, soft round
     caps. It is painted into the lens material so it never drifts or vanishes as the
     camera moves. This mark is the character's logo — it must read at 32 px.
     Look at ref/wally-logo.png: that flat mark shows the glint shape clearly.
  3. THE CLAY. Use ctx.mat.clay() from the render core. Base #D3D3D2, roughness ~0.94,
     one broad 8% sheen on the upper-left cranium, velvet grain, generous soft warm AO
     in every crease, faint warm subsurface in the ear membranes and trunk tip.
     NO OUTLINE on Wally — his form reads entirely through shading. This is what
     separates him from every other toon character.
  4. Three shallow horizontal wrinkle grooves on the upper trunk. Sculpted and AO'd,
     never drawn lines. No eyes, ever. Tusks warm off-white, slightly glossier than the
     body, rounded tips, 3 degrees of asymmetry between left and right.

GEOMETRY: build it procedurally — no mesh files. Metaballs/SDF meshing, lathed and
skinned profiles, or carefully blended subdivided primitives; whatever gets you
genuinely organic, smooth, faceting-free forms with clean topology at the joints.
Visible polygon faceting on any organic form is an automatic failure. Generate proper
normals and enough resolution that the silhouette is smooth at close camera range.

RIG: a real skeleton with skinned weights — root, hips, spine, head, two ear chains
(3 bones each), a trunk chain (5 bones), two arms, two legs, jaw. Skinning must work
with ctx.mat.clay() (the render core supports skinning; confirm in its source).

ANIMATION: a state machine with proper blending, not snapping. Clips, all authored in
code: idle (with a breathing cycle and occasional weight shift), walk, run, sprint,
turn-in-place, jump takeoff / air / land, talk, wave, cheer, think, tired, sit,
ride-bicycle, and the two reference poses by name:
  'cool'    — weight on one leg, trunk curled up and off to the side with a cocked tip,
              one arm relaxed. Casual and confident. (the intro uses this)
  'welcome' — square on, both arms open wide and low, palms forward and up, trunk
              hanging straight between the tusks. Warm and inviting. (title screen)
Blend with proper crossfades and a foot-phase-matched transition into and out of locomotion.

SECONDARY MOTION — the single most visible piece of polish in the game. Use
ctx.phys.createChain() (read src/physics/physics.js for the real signature):
  - Ears: 3-bone spring chains reacting to acceleration, turning, wind gusts
    (ctx.wind.vector()) and landing impacts. They must FLAP when he runs and settle
    with a visible overshoot when he stops.
  - Trunk: 5-bone chain, plus an animation-driven curl parameter.
  - Belly: light soft-body offset, ~0.03m.
  - Squash & stretch: 8% on takeoff, 14% on landing, resolved over 0.18s on an elastic
    ease, volume-preserving.
  - Foot IK onto terrain slopes via ctx.phys.groundAt(), with the hips lowering to
    compensate.

API on ctx.wally — design it, then document it exactly, because the camera, intro,
game and UI agents all code against it:
  ctx.wally.root / .position / .rotation
  ctx.wally.play(clipName, {fade, loop})
  ctx.wally.pose(name)                 'cool' | 'welcome' | ...
  ctx.wally.setLocomotion(speed, turn)  drives the locomotion blend
  ctx.wally.look(target)                head/trunk aim
  ctx.wally.express(name)               happy | tired | surprised | thinking
  ctx.wally.controller                  the ctx.phys controller instance

DEBUG HOOKS (register on window.WALLY.debug — the screenshot harness needs these):
  window.WALLY.debug.pose(name)
  window.WALLY.debug.clip(name)
  window.WALLY.debug.wallyCam(preset)   'face' | 'full' | 'threequarter' | 'silhouette'
  window.WALLY.debug.turntable(deg)

VERIFY — do this repeatedly, it is most of the job:
  node tools/shot.mjs shots/wally-full.png  --wait 2500 --eval "WALLY.debug.wallyCam('full')"
  node tools/shot.mjs shots/wally-face.png  --wait 2500 --eval "WALLY.debug.wallyCam('face')"
  node tools/shot.mjs shots/wally-3q.png    --wait 2500 --eval "WALLY.debug.wallyCam('threequarter');WALLY.debug.pose('cool')"
  node tools/shot.mjs shots/wally-sil.png   --wait 2500 --eval "WALLY.debug.wallyCam('silhouette')"
READ every PNG. Compare against ART_DIRECTION §1 line by line and against
ref/wally-logo.png for the glint and the face layout. Iterate until a cropped render of
him would pass as the reference toy. This will take several passes. Do them.

Report <=25 lines: the ctx.wally API, the debug hooks, the clip list, and your own
honest score out of 100 against ART_DIRECTION §6.`,
  critique: `Judge ONE thing: is this Wally?

Run these and READ every PNG:
  cd ${ROOT}
  node tools/shot.mjs shots/crit-wally-full.png --wait 2500 --eval "WALLY.debug.wallyCam('full')"
  node tools/shot.mjs shots/crit-wally-face.png --wait 2500 --eval "WALLY.debug.wallyCam('face')"
  node tools/shot.mjs shots/crit-wally-3q.png   --wait 2500 --eval "WALLY.debug.wallyCam('threequarter');WALLY.debug.pose('cool')"
  node tools/shot.mjs shots/crit-wally-sil.png  --wait 2500 --eval "WALLY.debug.wallyCam('silhouette')"
Also Read ref/wally-logo.png — the flat mark of the same character.

Check against ART_DIRECTION.md §1, ruthlessly and in this order:
  - PROPORTION. Measure against the §1 table. Is the ear span really 2.2x the shoulder
    width? Is the head really 0.30H and wider than the torso? Is there a neck? (there
    must not be). Is the body a pear widest at the belly, or a generic capsule?
  - SILHOUETTE. In the silhouette shot, does it read instantly as this character, or
    could it be any round animal?
  - THE GLINT. Is it the flattened lightning-bolt / lazy-Z from §1.4, or has it
    degenerated into an ellipse, a plain diagonal streak, or a generic highlight? Do
    both lenses point the same way? Would it read at 32 px?
  - CLAY. Matte vinyl toy, or shiny plastic, or flat unlit grey? One broad faint sheen
    or a hard specular dot? Is the velvet grain visible? Is the AO soft, wide and warm?
  - Is there an outline on him? There must NOT be. That is a blocker.
  - Are there eyes? There must not be.
  - FACETING. Any visible polygon edges on the head, trunk, ears or body?
  - Do the three trunk wrinkles exist, sculpted rather than drawn?
  - Do the tusks read warm off-white and slightly glossier, with rounded tips?

Be specific about proportion errors in units of H (total height).`,
}

const wallyResult = await buildLoop(WALLY, 'Wally')
log(`WALLY: ${wallyResult.score}/100 ${wallyResult.verdict}`)

/* ==================================================================
   The world. Seven independent slices, each looping on its own.
   ================================================================== */

phase('World')

const ITEMS = [
  {
    key: 'sky',
    effort: 'high',
    files: `  src/world/sky.js, src/world/clouds.js, src/world/weather.js, src/world/lighting.js`,
    build: `YOU ARE THE SKY & LIGHTING AGENT.

FILES YOU OWN: src/world/sky.js (ctx.sky), src/world/clouds.js,
src/world/weather.js, src/world/lighting.js

Build the sky Wind Waker is famous for — huge, saturated, alive, and the primary
light source for everything else.

  - Sky dome shader: zenith #2E7FD4 to horizon #9FD8F2, with a WIDE dramatic pale band
    at the horizon (this is the signature — a tight gradient reads as a generic skybox).
    Drive it from the TIME_OF_DAY keyframe table in src/core/palette.js.
  - The sun: a large soft disc with a broad warm halo, plus screen-space god rays when
    it is low or behind geometry. A moon and a star field for night, with the stars
    fading in over dusk rather than popping.
  - Clouds: stylised, sculpted, VOLUME-reading cumulus — Wind Waker's clouds look
    modelled, not painted. Raymarched billboards, layered impostors or shaded card
    stacks; whatever gives them a lit top, a shadowed underside, and a soft silhouette.
    They drift with ctx.wind and reshape slowly. Flat alpha-mapped planes are a fail.
  - The lighting rig, which every other module depends on: key directional light (with
    the CSM shadows the render core provides), a sky-coloured hemisphere fill, a warm
    bounce from the ground, and exposure — all driven from TIME_OF_DAY and interpolated
    smoothly. Cast shadows must be tinted blue-violet, never black.
  - Distance haze/fog paling everything toward #B8DEF0 past ~120m (ART_DIRECTION §2.4).
    Match the fog colour to the horizon per time of day or the horizon line will crack.
  - Weather: clear, cloudy, rain (with a wet-surface signal other modules can read),
    and storm. Transitions take minutes, never snap.

API on ctx.sky: setHour(h), setWeather(name, fadeSeconds), sunDirection (Vector3),
sunColor, ambientColor, fogColor, exposure, isNight, and the lights themselves so
other modules can read them.
DEBUG: window.WALLY.debug.setHour(h), .setWeather(name).

VERIFY at several hours and weathers:
  node tools/shot.mjs shots/sky-07.png --wait 2500 --eval "WALLY.debug.setHour(7)"
  node tools/shot.mjs shots/sky-13.png --wait 2500 --eval "WALLY.debug.setHour(13)"
  node tools/shot.mjs shots/sky-18.png --wait 2500 --eval "WALLY.debug.setHour(18)"
  node tools/shot.mjs shots/sky-22.png --wait 2500 --eval "WALLY.debug.setHour(22)"
  node tools/shot.mjs shots/sky-rain.png --wait 3000 --eval "WALLY.debug.setHour(11);WALLY.debug.setWeather('rain')"
READ every PNG and iterate. Report <=25 lines: the ctx.sky API and debug hooks.`,
    critique: `Judge ONE thing: the sky, clouds and lighting, against Wind Waker.
Run and READ all of these:
  cd ${ROOT}
  node tools/shot.mjs shots/crit-sky-07.png --wait 2500 --eval "WALLY.debug.setHour(7)"
  node tools/shot.mjs shots/crit-sky-13.png --wait 2500 --eval "WALLY.debug.setHour(13)"
  node tools/shot.mjs shots/crit-sky-18.png --wait 2500 --eval "WALLY.debug.setHour(18)"
  node tools/shot.mjs shots/crit-sky-22.png --wait 2500 --eval "WALLY.debug.setHour(22)"
Check: is the horizon band WIDE and dramatic, or a tight generic gradient? Do the clouds
read as sculpted volumes with a lit top and shadowed underside, or as flat alpha cards?
Is the sun disc large and soft with a real halo? At 18:00 is it a proper warm dusk, and
at 22:00 a believable night with stars — or just the day sky darkened? Do fog and horizon
colour agree, or is there a visible seam at the horizon line? Are cast shadows tinted?
Is the whole frame high-key and saturated, or washed out / muddy?`,
  },
  {
    key: 'terrain',
    effort: 'high',
    files: `  src/world/world.js, src/world/terrain.js, src/world/paths.js`,
    build: `YOU ARE THE TERRAIN AGENT. You build the island every other world module sits on,
so land early and document your API precisely.

FILES YOU OWN: src/world/world.js (ctx.world — the facade main.js boots),
src/world/terrain.js, src/world/paths.js

Build ONE continuous sculpted island, ~900m across, holding all 10 zones from
src/game/data.js. Read that file: every zone and location carries 3D world coordinates
laid out by the game-systems agent. Build the terrain to those coordinates — do not
invent your own layout.

  - Heightfield from layered seeded noise (ctx.makeRng), sculpted so each zone gets the
    character its data blurb describes: Rusty Row low and cramped, Golden Heights a
    literal height, Iron Hills rocky and steep, Green Edge rolling farmland, Waterfront
    at sea level, Learning Quarter a terrace. Wind Waker islands are SCULPTED and
    intentional, never noise-blobs — silhouette from a distance is the test.
  - Cliffs with strata, rounded Wind-Waker-style rock forms, beaches grading from wet
    sand to dry, and a clean shoreline for the water agent to meet.
  - Terrain material built from ctx.mat: grass / sand / rock / dirt / path blended by
    slope, height and zone, with the two-band toon ramp and blue-violet shade colour.
    Add subtle large-scale colour variation so it is never a flat field of one green.
  - Paths and roads between locations, laid out from the location coordinates, with
    worn edges and a slightly different material.
  - Register everything with ctx.phys.addStatic() so Wally can walk on it, and expose
    a fast height query.
  - LOD and frustum culling: this is the biggest geometry in the game and must not
    blow the frame budget.

API on ctx.world: heightAt(x,z), normalAt(x,z), zoneAt(x,z), locationAt(x,z),
placeOnGround(object3d, x, z, opts), bounds, and the scene graph roots other agents
attach to (ctx.world.groundGroup, .propGroup, .foliageGroup, .cityGroup) — the city,
foliage and NPC agents will all ask for these, so create them even if unused.
DEBUG: window.WALLY.debug.flyTo(zoneId), .topDown(), .orbit(deg).

VERIFY:
  node tools/shot.mjs shots/terrain-wide.png --wait 3000 --eval "WALLY.debug.topDown()"
  node tools/shot.mjs shots/terrain-ground.png --wait 3000 --eval "WALLY.debug.flyTo('rustyrow')"
  node tools/shot.mjs shots/terrain-cliff.png --wait 3000 --eval "WALLY.debug.flyTo('ironhills')"
READ them and iterate. Report <=25 lines: the ctx.world API, the group names, debug hooks.`,
    critique: `Judge ONE thing: the island terrain against Wind Waker's sculpted islands.
Run and READ:
  cd ${ROOT}
  node tools/shot.mjs shots/crit-terrain-wide.png --wait 3000 --eval "WALLY.debug.topDown()"
  node tools/shot.mjs shots/crit-terrain-ground.png --wait 3000 --eval "WALLY.debug.flyTo('rustyrow')"
  node tools/shot.mjs shots/crit-terrain-cliff.png --wait 3000 --eval "WALLY.debug.flyTo('ironhills')"
Check: does the island read as SCULPTED and intentional, or as a noise blob? Does its
distant silhouette have character? Do the zones read as distinct places? Are the cliffs
rounded Wind-Waker rock with strata, or a displaced plane? Does the grass have large-scale
colour variation or is it one flat green? Is the shade colour blue-green, never black?
Is the shoreline clean enough for water to meet it? Any visible tiling, seams, LOD pops
or stretched texture at cliff faces?`,
  },
  {
    key: 'water',
    effort: 'high',
    files: `  src/world/water.js, src/world/foam.js, src/world/ripples.js`,
    build: `YOU ARE THE WATER AGENT. In a Wind Waker game the sea is a main character.

FILES YOU OWN: src/world/water.js (ctx.water), src/world/foam.js, src/world/ripples.js

Implement ART_DIRECTION §5.4:
  - Toon ocean: BANDED depth colour from #57C6D8 shallow to #1B6FA8 deep — discrete
    bands, not a smooth gradient. Gerstner wave displacement driven by ctx.wind
    (direction and strength), with banded 3-step specular and stylised sparkle glints
    on the wave crests.
  - Hard-edged opaque white foam (#F4FBFF) — a shoreline band that follows the terrain
    intersection and animates in and out with the swell, plus a foam ring around every
    object touching the water. Soft alpha foam is wrong; Wind Waker foam has a crisp edge.
  - Scrolling caustic bands visible through shallow water, and a wet-sand darkening
    band on the shore above the waterline.
  - Ripples: expanding rings from Wally's steps, splashes on entry, and a persistent V
    wake behind anything moving. Drive these off ctx.phys buoyancy callbacks.
  - Reflection: a cheap stylised reflection of sky and large silhouettes at high
    quality tiers, off at low. Never a mirror — Wind Waker water reflects suggestively.
  - Meet ctx.world's shoreline exactly. Read ctx.world.heightAt() for depth.

API on ctx.water: level, heightAt(x,z,t), splash(pos, strength), ripple(pos, radius),
wake(object, opts), isUnder(pos).
DEBUG: window.WALLY.debug.waterCam('shore'|'open'|'under'), .splashTest().

VERIFY:
  node tools/shot.mjs shots/water-shore.png --wait 3000 --eval "WALLY.debug.waterCam('shore')"
  node tools/shot.mjs shots/water-open.png  --wait 3000 --eval "WALLY.debug.waterCam('open')"
  node tools/shot.mjs shots/water-splash.png --wait 3000 --eval "WALLY.debug.waterCam('shore');WALLY.debug.splashTest()"
READ them and iterate. Report <=25 lines: the ctx.water API and debug hooks.`,
    critique: `Judge ONE thing: the sea, against Wind Waker's.
Run and READ:
  cd ${ROOT}
  node tools/shot.mjs shots/crit-water-shore.png --wait 3000 --eval "WALLY.debug.waterCam('shore')"
  node tools/shot.mjs shots/crit-water-open.png  --wait 3000 --eval "WALLY.debug.waterCam('open')"
Check: is the depth colour BANDED into discrete steps, or a smooth gradient (a fail)?
Is the foam crisp, opaque and white, or a soft grey alpha smear (a fail)? Does the
shoreline foam follow the terrain properly or float at a fixed radius? Are there real
Gerstner waves with shaped crests, or a bumpy plane? Is the specular banded and
sparkling, or a smooth PBR highlight? Do the caustics read? Is there a visible seam
where water meets land? Does the sea look like a place you would sail, or like a blue
plane with a normal map?`,
  },
  {
    key: 'city',
    effort: 'xhigh',
    files: `  src/world/city.js, src/world/buildings.js, src/world/kits.js, src/world/props.js, src/world/signs.js`,
    build: `YOU ARE THE CITY AGENT. The largest visual surface in the game.

FILES YOU OWN: src/world/city.js, src/world/buildings.js, src/world/kits.js,
src/world/props.js, src/world/signs.js

Build all 28 locations across the 10 zones from src/game/data.js at their given 3D
coordinates, attaching to ctx.world.cityGroup / .propGroup.

  - A per-zone architecture KIT so each district is instantly recognisable, in the
    Wind Waker vernacular: chunky rounded forms, thick stylised timber, terracotta
    roofs (#D9713F), warm stucco (#F0E4CC), NOTHING at right angles by accident — walls
    lean, roofs sag, beams bow. Straight-edged grey boxes are the failure mode.
      rustyrow  cramped, patched, corrugated, laundry lines, lean-tos
      mainstreet  respectable shopfronts, awnings, painted signs
      learning  brick terraces, tall windows, a clocktower
      marketsq  stalls, canopies, crates, bunting
      greenedge  barns, silos, fences, hay
      ironhills  headframes, ore carts, tin sheds, spoil heaps
      waterfront  docks, cranes, containers, gulls, piers on piles
      innovation  clean glass-and-timber, roof gardens
      stampede  the stadium bowl, floodlights, banners
      goldenheights  stone, columns, gold trim, formal gardens
  - Buildings must be BUILT, not boxed: separate roof / walls / windows / doors /
    trim / gutters / chimneys / balconies, with rounded edges and chamfers everywhere.
    Vary every instance procedurally from ctx.makeRng(location.id) so no two repeat.
  - Signs above every location's door, showing its name and its emoji glyph from the
    data — generate readable sign textures procedurally to canvas. This is how players
    navigate; they must be legible at gameplay distance.
  - Props everywhere, with contact shadows: crates, barrels, benches, lamps (emissive
    at night), bins, carts, bicycles, market produce, potted plants, fences, bollards,
    awnings and banners using ctx.phys.createCloth() so they ripple in the wind.
  - Windows emissive and warm after dark; read ctx.sky.isNight.
  - Use InstancedMesh aggressively for repeated props and keep draw calls sane. LOD:
    distant buildings drop to a simplified silhouette version.
  - Register solid geometry with ctx.phys.addStatic() so Wally cannot walk through walls.

API on ctx.city: buildingAt(locId), doorPosition(locId), signAt(locId), interiorAnchor(locId).
DEBUG: window.WALLY.debug.flyTo(locId) should already exist from the terrain agent —
extend it if it does not cover locations; add .cityTour(i) stepping through locations.

VERIFY at least five zones:
  node tools/shot.mjs shots/city-main.png  --wait 3000 --eval "WALLY.debug.flyTo('mainstreet')"
  node tools/shot.mjs shots/city-market.png --wait 3000 --eval "WALLY.debug.flyTo('marketsq')"
  node tools/shot.mjs shots/city-water.png --wait 3000 --eval "WALLY.debug.flyTo('waterfront')"
  node tools/shot.mjs shots/city-gold.png  --wait 3000 --eval "WALLY.debug.flyTo('goldenheights')"
  node tools/shot.mjs shots/city-rusty.png --wait 3000 --eval "WALLY.debug.flyTo('rustyrow')"
READ every PNG and iterate hard. Report <=25 lines: the ctx.city API and debug hooks.`,
    critique: `Judge ONE thing: the architecture, against Wind Waker's Windfall Island.
Run and READ all five:
  cd ${ROOT}
  node tools/shot.mjs shots/crit-city-main.png   --wait 3000 --eval "WALLY.debug.flyTo('mainstreet')"
  node tools/shot.mjs shots/crit-city-market.png --wait 3000 --eval "WALLY.debug.flyTo('marketsq')"
  node tools/shot.mjs shots/crit-city-water.png  --wait 3000 --eval "WALLY.debug.flyTo('waterfront')"
  node tools/shot.mjs shots/crit-city-gold.png   --wait 3000 --eval "WALLY.debug.flyTo('goldenheights')"
  node tools/shot.mjs shots/crit-city-rusty.png  --wait 3000 --eval "WALLY.debug.flyTo('rustyrow')"
Check: are these BUILDINGS or boxes with a roof prism? Count the parts — separate roof,
trim, gutters, windows with frames, doors with handles, chimneys? Are edges chamfered
and rounded, do walls lean and roofs sag, or is everything mechanically square (a fail)?
Are the five zones instantly distinguishable from each other, or the same kit recoloured?
Are signs present and legible? Is there prop density and clutter that says people live
here, or empty ground between buildings? Is anything moving in the wind? Do the props
have contact shadows? Any untextured primitive visible anywhere?`,
  },
  {
    key: 'foliage',
    effort: 'high',
    files: `  src/world/foliage.js, src/world/grass.js, src/world/trees.js, src/world/scatter.js`,
    build: `YOU ARE THE FOLIAGE AGENT. Wind Waker's grass and trees are half of why it looks alive.

FILES YOU OWN: src/world/foliage.js, src/world/grass.js, src/world/trees.js,
src/world/scatter.js — attach to ctx.world.foliageGroup.

  - GRASS: instanced blades (or clustered cards) covering every grass surface out to
    ctx.quality.grassDist, density scaled by ctx.quality.grass. Per-blade wind bend from
    ctx.wind.glsl with a phase offset by world position so gusts travel across the field
    in visible sheets. Colour graded by ctx.world height/zone and by an AO term so grass
    darkens where it meets geometry. Blades bend away from Wally as he walks through
    (an interaction the player will notice immediately). Fade to a ground texture at
    distance rather than popping.
  - TREES: sculpted Wind Waker trees — thick tapered trunks with a few strong branches
    and big rounded stylised canopy masses, NOT a cone of alpha cards. Canopy sways as
    a whole and flutters at the leaf level. Several species matched to zone (orchard,
    palm at the waterfront, pine at Iron Hills, formal topiary in Golden Heights).
    Outline the canopy silhouette only, per ART_DIRECTION §5.5.
  - SCATTER: bushes, flowers, reeds at the waterline, rocks, fallen leaves, and a
    drifting particle layer of pollen/leaves crossing every shot — ART_DIRECTION §2.3
    requires something moving in the wind in EVERY frame.
  - Everything instanced, LODed, frustum-culled and budgeted.

API on ctx.foliage: plantTree(kind, x, z), clearArea(x, z, r), density(v), windResponse(v).
DEBUG: window.WALLY.debug.foliageCam('field'|'grove'|'closeup').

VERIFY:
  node tools/shot.mjs shots/foliage-field.png   --wait 3000 --eval "WALLY.debug.foliageCam('field')"
  node tools/shot.mjs shots/foliage-grove.png   --wait 3000 --eval "WALLY.debug.foliageCam('grove')"
  node tools/shot.mjs shots/foliage-closeup.png --wait 3000 --eval "WALLY.debug.foliageCam('closeup')"
READ them and iterate. Report <=25 lines: the ctx.foliage API and debug hooks.`,
    critique: `Judge ONE thing: grass, trees and scatter, against Wind Waker.
Run and READ:
  cd ${ROOT}
  node tools/shot.mjs shots/crit-foliage-field.png   --wait 3000 --eval "WALLY.debug.foliageCam('field')"
  node tools/shot.mjs shots/crit-foliage-grove.png   --wait 3000 --eval "WALLY.debug.foliageCam('grove')"
  node tools/shot.mjs shots/crit-foliage-closeup.png --wait 3000 --eval "WALLY.debug.foliageCam('closeup')"
Check: is there real grass geometry with density and depth, or a green texture with a few
sprites? Do blades vary in height, lean and colour? Does grass darken where it meets
geometry? Are the trees SCULPTED — thick tapered trunk, real branches, big rounded canopy
masses — or a cone of alpha cards (a fail)? Is there a visible drifting particle layer?
Is there an obvious LOD or density boundary line on the ground? Take two shots a second
apart if you must, to confirm things actually move.`,
  },
  {
    key: 'camera',
    effort: 'high',
    files: `  src/core/camera.js`,
    build: `YOU ARE THE CAMERA AGENT. Camera is 50% of how a game feels.

FILE YOU OWN: src/core/camera.js (ctx.cam)

Implement ART_DIRECTION §2.5. Wind Waker's camera is low, wide and reverent.

  - Follow rig: default 4.2m behind and 2.1m above Wally, looking down ~9 degrees, FOV
    45-55, framing him on the lower third. Critically damped springs on position, target
    and FOV — use ctx.phys spring helpers or damp() from contracts.js. NEVER a linear
    lerp; that is the single most common tell of an amateur camera.
  - Behaviours: speed-based pull-back and FOV widening when running; look-ahead in the
    movement direction; a slow auto-orbit toward Wally's facing when the player is not
    steering; height easing over terrain; and a soft collision that pulls in when
    geometry intrudes (sphere-cast against ctx.phys) and eases back out.
  - Vista framing: when Wally reaches a viewpoint, ease up and back to reveal the
    horizon, then return. Wind Waker does this constantly and it is a lot of the magic.
  - Cinematic API for the intro agent: ctx.cam.cinematic(shots) taking a list of
    {position, target, fov, dof, duration, ease} and interpolating along a smoothed
    spline with proper easing, plus handheld noise at a controllable amplitude,
    letterbox in/out, and ctx.cam.release() to hand control back to gameplay.
  - Depth of field: feed the focus distance to ctx.render.setDOF() every frame from the
    distance to whatever the camera is looking at.
  - Screen shake API with trauma decay for impacts.
  - First-class debug orbit camera so the other agents' debug hooks keep working — read
    src/world/*.js and src/character/wally.js for the debug hooks already registered
    (flyTo, wallyCam, waterCam, foliageCam) and make sure ctx.cam does not fight them.
    Provide ctx.cam.override(pos, target, fov) and ctx.cam.releaseOverride() for them.

API on ctx.cam: follow(target), cinematic(shots), release(), override(...),
releaseOverride(), shake(trauma), setFov(f), vista(pos, dur), current camera state.
DEBUG: window.WALLY.debug.camPreset(name), .letterbox(on).

VERIFY:
  node tools/shot.mjs shots/cam-follow.png --wait 3000
  node tools/shot.mjs shots/cam-vista.png  --wait 3000 --eval "WALLY.debug.camPreset('vista')"
READ them. Judge the FRAMING as a cinematographer: is Wally on the lower third, is the
horizon placed well, does the shot have depth (foreground, midground, background)?
Report <=25 lines: the ctx.cam API and debug hooks.`,
    critique: `Judge ONE thing: camera framing and feel.
Run and READ:
  cd ${ROOT}
  node tools/shot.mjs shots/crit-cam-follow.png --wait 3000
  node tools/shot.mjs shots/crit-cam-vista.png  --wait 3000 --eval "WALLY.debug.camPreset('vista')"
Then Read src/core/camera.js and audit the code for feel, not just the images.
Check the images: is Wally framed on the lower third or dead centre? Is the horizon at a
deliberate height or bisecting the frame? Does the shot have foreground/midground/
background depth, or is it flat? Is the FOV wide enough to feel like Wind Waker rather
than a shooter? Is DOF driven by a real focus distance?
Check the code: are ALL smoothing terms frame-rate independent (damp/spring), or is there
a raw lerp(a,b,0.1) anywhere? That is an automatic blocker. Is there camera collision?
Look-ahead? Speed-based pull-back? A cinematic spline with real easing?`,
  },
  {
    key: 'npcs',
    effort: 'high',
    files: `  src/character/npc.js, src/character/crowd.js, src/character/humans.js`,
    build: `YOU ARE THE NPC AGENT. The city needs people or it is a diorama.

FILES YOU OWN: src/character/npc.js (ctx.npc), src/character/crowd.js,
src/character/humans.js

The original game had a parametric human generator — 8 skin tones, 6 face shapes, 17
hairstyles, 13 hair colours, beards, glasses, 12 hats. Read the "art.js" section of
ref/original-wally.html (the portrait() and hair functions) and the CLIENTS table in
src/game/data.js for the 24 named characters and their exact appearance parameters.

  - Build a 3D parametric human in the SAME clay language as Wally: ctx.mat.clay(),
    matte, grained, soft warm AO, rounded volumes, no outlines, big readable
    silhouettes, stylised proportions (roughly 4.5 heads tall, chunky, Wind-Waker-ish).
    They must look like they come from the same toy line as Wally. Same-world coherence
    matters more than realism.
  - Drive every parameter from the client data so all 24 named clients are recognisably
    themselves: skin, face shape, hair style and colour, beard, glasses, hat, plus their
    hue for clothing. Wally is the only elephant — everyone else is human.
  - Skeleton + animation: idle variations, walk, talk with gesture, sit, work, wave,
    react. Reuse the animation approach from src/character/anim.js if it exposes
    anything shareable, but do NOT edit files under src/character/ that you do not own
    (wally.js, model.js, rig.js, anim.js, secondary.js, expression.js belong to the
    Wally agent — read them, do not write them).
  - Ambient crowd: townsfolk wandering between locations on the paths from
    src/world/paths.js, respecting opening hours from the game data, with simple
    steering and avoidance. Density scaled by ctx.quality.particles.
  - Named clients stand at their home locations and can be approached.
  - Nameplates/interaction prompts that fade in on approach.

API on ctx.npc: spawn(clientId, pos), spawnCrowd(n), at(locId), nearest(pos, radius),
lookAt(id, target), say(id, text).
DEBUG: window.WALLY.debug.npcCam(clientId), .lineup() — lineup should stand a dozen
generated humans side by side facing camera for review.

VERIFY:
  node tools/shot.mjs shots/npc-lineup.png --wait 3000 --eval "WALLY.debug.lineup()"
  node tools/shot.mjs shots/npc-mabel.png  --wait 3000 --eval "WALLY.debug.npcCam('mabel')"
  node tools/shot.mjs shots/npc-crowd.png  --wait 3000 --eval "WALLY.debug.flyTo('marketsq')"
READ them and iterate. Report <=25 lines: the ctx.npc API and debug hooks.`,
    critique: `Judge ONE thing: the humans.
Run and READ:
  cd ${ROOT}
  node tools/shot.mjs shots/crit-npc-lineup.png --wait 3000 --eval "WALLY.debug.lineup()"
  node tools/shot.mjs shots/crit-npc-mabel.png  --wait 3000 --eval "WALLY.debug.npcCam('mabel')"
  node tools/shot.mjs shots/crit-npc-crowd.png  --wait 3000 --eval "WALLY.debug.flyTo('marketsq')"
Also read shots/crit-wally-full.png if it exists (or take one with
--eval "WALLY.debug.wallyCam('full')") and judge whether the humans and Wally look like
they belong to the SAME toy line — same clay, same grain, same AO, same stylisation.
A mismatch there is the most damaging possible defect and is an automatic blocker.
Check: are they varied, or the same mesh recoloured? Do faces have sculpted features or
painted-on decals? Are hair and hats real geometry? Is the silhouette readable and
appealing, or lumpy? Do they animate, or are they statues? Is the clay material actually
ctx.mat.clay(), or has someone used a default MeshStandardMaterial (an automatic fail)?`,
  },
]

const results = await pipeline(ITEMS, (item) => buildLoop(item, 'World'))

const done = results.filter(Boolean)
log(`world slices: ${done.map(r => `${r.key}=${r.score}`).join(' ')}`)

return {
  wally: { score: wallyResult.score, verdict: wallyResult.verdict },
  world: done.map(r => ({ key: r.key, score: r.score, verdict: r.verdict, openBlockers: r.blockers.length })),
  reports: Object.fromEntries(done.map(r => [r.key, r.report])),
  wallyReport: wallyResult.report,
}
