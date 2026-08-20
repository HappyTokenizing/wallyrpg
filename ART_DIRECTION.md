# WALLY RPG — Art Direction Bible

**This document is the single source of truth for every visual decision.**
Every agent building geometry, materials, shaders or post-processing must conform to it.
If your output disagrees with this document, your output is wrong.

---

## 0. The one-sentence brief

*The Legend of Zelda: The Wind Waker* — its sculpted cel-shaded islands, its enormous
readable silhouettes, its saturated sea-and-sky palette, its wind — **rendered in soft
matte clay**, starring a grey vinyl-toy elephant in black sunglasses.

Wind Waker gives us **composition, colour, camera and wind**.
The elephant reference gives us **surface, form language and character**.
Nothing in the game may violate either.

---

## 1. The reference character — exact specification

**REVISED against the real renders.** Four canonical studio renders of Wally now exist
ON DISK and supersede any prose where they disagree:

- `ref/wally-ref-cool.png` — THE canonical full-body render: the cool three-quarter
  pose, matte clay, studio-lit. When in doubt, open this file and look.
- `ref/wally-glint-canon.png` — the approved sunglasses motif at high resolution plus
  the canon checklist (light-gray elephant · two ivory tusks · barefoot, no clothing ·
  permanent black sunglasses · white rising-line lens motif).
- `ref/wally-logo.png` — the flat 2D mark.

Additional views studied for this spec (side, back, front-welcome): the same toy from
every angle. Their measurements are folded into the tables below.

The character is a matte grey vinyl/clay designer toy. Soft key from upper-left, weak
fill, no outlines, no rim light, soft contact shadow. Fine, uniform, subtle surface
grain — visible up close, never reading as noise at gameplay distance.

### 1.1 Proportions (canonical, in Wally-heights `H` = total standing height)

| Part | Measure |
|---|---|
| Total height | `1.00 H` |
| Head ball (cranium, no ears) | `0.36 H` tall — bigger than previously specced; it is nearly wider than it is tall and utterly dominates the figure |
| Head width vs torso width | head ≈ **1.15×** the belly (the widest torso point) |
| Ear span (tip to tip) | ~`0.80 H` — ≈ 2.2× shoulder width |
| Single ear | a huge rounded fan, `0.35 H` tall × `0.22 H` wide, thick at the root, thin at the rim |
| **Ear direction** | **sweeps BACK and UP from the skull.** Top edge rises to crown height or a touch above; the fan opens outward and backward at ~25–35° from vertical. From the front you see the fan's inner face; from the side it covers the whole rear half of the head. **Ears never droop below the jawline hinge — a downward-hanging ear is the single worst likeness error.** |
| Trunk | root directly under the glasses bridge, thick — root diameter ≈ the gap between the lenses. `0.40 H` long when hanging; **surface SMOOTH** (no ribs, no segmentation) except exactly **three short incised lines** on its top ridge just below the bridge. Gentle S as it falls; ends in a rounded nub tip with a subtle front nostril dimple. In the idle/cool pose the tip **curls up and forward**. |
| Tusks | two small cream cones flanking the trunk at its root, emerging from under the cheek line, pointing **down, forward and slightly out**, `0.09 H`, rounded tips, ~3° asymmetry |
| Torso | pear. Narrow chest, **belly is the widest point of the whole body** at ~`0.40 H` above ground and protrudes forward past the chest line in profile; hips tuck under. Back nearly straight, slight lumbar curve into the tail root. |
| Neck | none — but the head is a DISTINCT ball sitting ON the shoulders: the silhouette shows a clear notch where head meets body. The head must never read as sunk into the chest. |
| Arm | `0.30 H`, relaxed sausage with a gentle inward curve, no sharp elbow; hangs clear of the flank — **daylight between arm and body along most of its length** |
| Hand | soft mitten: **four stubby rounded digits + a thumb**, each digit `~0.035 H`; reads as a hand at arm's length, not a claw |
| Leg | `0.30 H`, sturdy column, slight taper, clear gap between the legs |
| Foot | rounded soft-boot stub, `0.10 H` long, slight forward toe box, flat sole, **no toes** |
| Tail | **required — it is in every reference.** Thin rope from the low-center back, hanging to ~knee height, ending in a `0.03 H` teardrop tuft. Visible from side and back; occasionally peeks past a hip from the front three-quarter. |

**Silhouette test:** filled black, he reads as *huge back-swept ears + head-ball proud
of the shoulders + pear belly + four stubs + rope tail*. If the ears do not rise and
sweep back, or the head sinks into the chest, the model is wrong.

### 1.2 Surface — the "soft matte clay" law

- **Base albedo `#D3D3D2`** — desaturated warm grey. Lit cheek `#DEDEDD`, mid flank
  `#CFCFCE`, deep crease `#A9A9A8`. Warm AO, never blue on the character.
- **Matte.** Roughness `0.92–0.96`, metalness 0. ONE broad faint sheen upper-left on
  the cranium (~8%), never a hotspot.
- **Grain: fine and uniform.** The renders show a subtle, even, fine-scale speckle —
  like cast vinyl — clearly visible in a close-up, invisible as *noise* at gameplay
  distance. If a frame reads "fuzzy" or "dirty", the grain is too coarse or too strong.
- **Soft wide warm AO** in every crease: ear roots, under chin/trunk root, armpits,
  between the legs, under the belly, behind the knees, glasses-to-face contact.
- **No outline on Wally. No rim light. No eyes — ever.**

### 1.3 Tusks

Warm ivory `#F2EBDA` → `#E4D9C0` at the root, slightly glossier than the body
(roughness ~0.55). Small cones with soft rounded tips flanking the trunk root,
pointing down-forward-out. They read as *cute*, not as weapons.

### 1.4 The sunglasses — the character's identity

`ref/wally-glint-canon.png` is the law for the lens motif.

- **Frame:** near-black `#141414` satin wayfarer band: thick straight brow bar, two
  trapezoid lenses with rounded corners angled slightly down-and-out, low bridge
  sitting ON the trunk root. **Temple arms are real geometry**: they run back across
  the cheeks and hook under the ear roots — visible in side view, and their hooked
  ends peek past the head silhouette from behind.
- **Lens:** true black `#0A0A0A`, subtle fresnel edge.
- **THE GLINT — the approved white rising-line motif.** One per lens, both pointing
  the same direction (not mirrored): a short horizontal stroke, a rising diagonal, a
  short horizontal stroke — an S-curve/rising-line, soft round caps, ~40% of lens
  width, sitting mid-lens. Painted into the lens material, never a real reflection,
  must read at 32 px. Match `ref/wally-glint-canon.png`, not memory.
- Soft AO shadow from the brow bar onto the cheeks beneath.

### 1.5 Face

- No eyes. The glasses are the face.
- Exactly **three short incised wrinkle lines** on the trunk's top ridge just below
  the glasses bridge — crisp, shallow, ~60% of trunk width, evenly spaced. The rest
  of the trunk is SMOOTH.
- No mouth in the neutral face; the tusk/cheek crease provides all the character.
- Ear inner face is slightly darker/warmer (`#C6C2BF`) with a soft AO ring at the root.

### 1.6 Canonical poses (all four exist in reference)

1. **cool** — THE default idle. Weight on one leg, spine upright, head level, trunk
   tip curled up-and-forward, one arm slightly more relaxed than the other. Casual,
   confident. This is `ref/wally-ref-cool.png` exactly.
2. **welcome** — square to camera, arms open wide and low, palms forward (digits
   visible), trunk hanging straight with rounded tip at belly height.
3. **side profile** — belly proud of the chest, ear covering the rear half of the
   head, tail hanging to the knee, trunk S-curve with up-curled tip.
4. **back** — clean dome head, two huge fans wider than the body, glasses temple
   hooks visible at the ear roots, tail rope + tuft dead center.

The intro uses (1); the title screen uses (2). The game's idle must BE pose (1),
gently breathing, not a generic A-pose with the arms at the sides.

## 2. Wind Waker — what we take

### 2.1 Colour
A high-key, high-saturation, **low-contrast-in-shadow** palette. Shadows are
*coloured*, never grey-black.

| Role | Colour | Note |
|---|---|---|
| Sky zenith | `#2E7FD4` | deep but not navy |
| Sky horizon | `#9FD8F2` | pales dramatically toward the sea line |
| Sun disc | `#FFF6D8` | large, soft, with a wide warm halo |
| Sea deep | `#1B6FA8` | |
| Sea shallow | `#57C6D8` | turquoise, banded not gradient |
| Sea foam | `#F4FBFF` | pure, opaque, hard-edged |
| Grass lit | `#7EC24E` | |
| Grass shade | `#4E9A46` | **hue shifts toward blue-green in shade, never toward black** |
| Sand | `#EBD9A8` | |
| Terracotta roofs | `#D9713F` | |
| Stucco walls | `#F0E4CC` | |
| Wood | `#A9713F` | |
| Shadow tint (global) | `#5A6E9E` multiplied at 0.82 | the Wind Waker "blue shadow" |
| Token orange (brand) | `#F5913C` | carried over from the original game's UI |

**Rule:** shadow = `lerp(albedo, albedo × shadowTint, 0.55)` — a *hue rotation toward
blue-violet plus a modest value drop*. Never `albedo × 0.4`.

### 2.2 Shading model
Two-band toon ramp, **soft-stepped** (`smoothstep` over ~0.06 of the terminator, not
a hard step), plus:
- a narrow warm **rim light** on world objects (not on Wally),
- a very soft **fresnel sky-bounce** on all upward-facing surfaces,
- **banded** specular on water and metal (3 discrete steps),
- outline pass on world geometry: **inverted-hull**, width scaling with distance so it
  stays ~1.6 px on screen, colour = object albedo darkened 55 % and hue-rotated toward
  blue. **Never pure black outlines.**

### 2.3 Wind — the signature
Wind is a **global uniform** every shader reads: `uWindDir`, `uWindStrength`,
`uTime`. It must visibly move:
- grass (per-blade bend, phase offset by world position),
- tree canopies (whole-canopy sway + leaf flutter),
- flags, banners, awnings, laundry lines (vertex-driven cloth ripple),
- Wally's ears (physics, see §4),
- water surface direction,
- leaf/pollen/dust particles drifting across every shot,
- the cloud layer.

Wind changes direction slowly over minutes. When it gusts, *everything* gusts together.
A still frame of this game must still feel windy.

### 2.4 Sea and sky are always present
The city sits on an island. From nearly every exterior camera you can see water and a
horizon. Distance haze pales everything toward `#B8DEF0` past ~120 m.

### 2.5 Camera
Wind Waker's camera is **low, wide and reverent**. Default: 45–55° FOV, positioned
`4.2 m` behind and `2.1 m` above Wally, looking slightly down (−9°). It lags with a
critically-damped spring, frames Wally at the lower third, and pulls back and up on
vistas. Cinematic moments drop to 32° FOV with heavy depth of field.

---

## 3. Rendering pipeline (mandatory order)

1. **Depth + normal prepass** (for AO, outlines, DOF)
2. **Main forward pass** — toon ramp, shadows, wind
3. **Inverted-hull outline pass** (world only, Wally excluded)
4. **SSAO** — wide radius (0.9 m), soft, warm-tinted, strength 0.55. This is what sells
   the clay look at world scale.
5. **Bloom** — threshold 0.85, soft knee, 5 mip levels, tint slightly warm. Wind Waker
   blooms *generously*.
6. **Depth of field** — bokeh, near + far, always on but subtle in gameplay (f/5.6
   equivalent), aggressive in cinematics (f/1.8).
7. **Colour grade** — ACES filmic tone map, then a lift-gamma-gain grade pushing
   shadows blue-violet and highlights warm-cream, then a per-scene LUT.
8. **Film grain** — 0.018 amplitude, animated, matched to the clay's surface grain so
   the whole frame feels like one material.
9. **Vignette** — 0.22, soft, slightly warm.
10. **FXAA/SMAA** after grading.

Shadows: **4-cascade CSM**, 2048 per cascade, PCF-soft with a wide kernel and a
generous normal bias. Shadow colour is tinted, never black (see §2.1).

**Performance target: locked 60 fps at 1920×1080 on integrated graphics.** Every
feature above must have an automatic quality-tier fallback.

---

## 4. Physics & secondary motion (the "AAA" tell)

- **Character controller:** capsule, swept collision, slope limit 48°, step offset
  0.35 m, coyote time 0.12 s, jump buffering 0.14 s, acceleration curves not linear
  lerps, snappy air control, landing squash.
- **Ear physics:** each ear is a 3-bone chain driven by a damped spring; it reacts to
  Wally's acceleration, to turning, to wind gusts and to landing impacts. **This is the
  most visible piece of polish in the game.** Ears must flap when he runs and settle
  with a slight overshoot when he stops.
- **Trunk physics:** 5-bone chain, same solver, plus a curl parameter driven by
  animation state. It swings when he turns and lifts when he's happy.
- **Belly jiggle:** a light soft-body offset on the torso, 0.03 m amplitude.
- **Squash & stretch:** 8 % on jump takeoff, 14 % on landing, resolved over 0.18 s with
  an elastic ease. Volume-preserving.
- **Foot IK:** feet plant on terrain slopes; hips lower to compensate.
- **Cloth:** flags, awnings, banners use a verlet grid, wind-driven.
- **Water:** buoyancy + drag for floating objects; Wally displaces water with a ring
  ripple and leaves a wake.

---

## 5. Materials catalogue (world)

Every world material derives from one of these five, so the whole game reads as one
sculpture:

1. **Clay** — characters. Matte, grained, heavy soft AO, no outline.
2. **Painted plaster** — buildings. Matte, slight colour variation blotching, chipped
   edges lighter, outlined.
3. **Weathered wood** — docks, carts, signs. Directional grain, roughness variation,
   outlined.
4. **Toon water** — banded depth colour, animated foam rings at every intersection,
   scrolling caustic bands, a hard white foam ring around every object touching it.
5. **Foliage** — two-band flat colour, alpha-tested cards for leaves, wind-driven,
   outlined only on the canopy silhouette.

No PBR metal/glass unless it is a deliberate accent (sunglasses, water, gold).

---

## 6. What "AAA" means for this project — the acceptance bar

A build passes only if **all** of these are true:

- [ ] A still frame, shown next to an official Wind Waker HD screenshot, is not
      obviously the amateur one.
- [ ] Wally, cropped and shown alone, is indistinguishable in *material and proportion*
      from the reference render.
- [ ] The sunglass glint is present, correctly shaped, and readable at 32 px.
- [ ] Nothing in frame is a visible untextured primitive.
- [ ] Every surface has grain; nothing is flat-shaded and clean.
- [ ] Shadows are blue-violet, never grey.
- [ ] Something is moving in the wind in every single frame.
- [ ] The horizon is visible from every exterior camera and hazes correctly.
- [ ] Bloom, DOF, grain and vignette are all active and none of them is overdone.
- [ ] 60 fps, no hitches, no pop-in.
- [ ] The intro is genuinely cinematic — camera moves with intent, not a turntable.

---

## 7. Forbidden

- Pure black shadows or outlines
- Flat unlit `MeshBasicMaterial` anywhere in the world
- Untextured, ungrained surfaces
- Default Three.js `MeshStandardMaterial` on a character
- Visible polygon faceting on any organic form
- Linear lerp camera follow
- Eyes on Wally
- Outlines on Wally
- A sunglass glint that is a plain ellipse or a plain diagonal streak
- Hard-edged contact shadows
- Grey shadows
- A static frame
