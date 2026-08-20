# Wally: City of Assets

A complete, playable browser RPG. You are Wally — an elephant in sunglasses who arrives
in Asseton City with **$250**, a bicycle, a secondhand phone and no reputation at all.
Sixty-nine things in this city can be owned. Your job is to help one person at a time
until all of them are.

Vanilla HTML, CSS and JavaScript. No install, no build step, no accounts, no servers,
no real money. All companies, markets and currency are fictional.

---

## Boot

The game starts the way an arcade cabinet does: a CRT sweep, a POST sequence,
a memory count, then the logo slams in over **PRESS START**. Tap once to jump
to the logo, again to begin. It respects reduced-motion.

## Play it

**Easiest:** open `index.html` (the standalone build) by double-clicking it.
Everything — art, audio, save system — is inside that one file.

**From source:** open `src/index.html`, or serve the folder:

```
cd src && python3 -m http.server 8000    # then visit localhost:8000
```

Serving over http additionally loads the web fonts. On `file://` the game uses
system fonts on purpose, so it never stalls on a blocked request.

---

## What you actually do

**The city opens one door at a time.** On day one you know three places: your flat,
the TRUNK depot and a noodle cart. That is enough to sleep, eat and earn. Everything
else — markets, the school, the farm, the mine, the exchange, the stadium — has to be
earned through reputation, finished orders, passed courses or story progress. You go
from 3 places to all 28 across the run, and never more than a handful at a time.

A **🎯 objective strip** sits above the navigation at all times: it names your next
step and takes you straight there when tapped. First-time explanations appear once
each for travel costs, the office, filling an order and tokenizing.

Your office starts as the folding table in the flat. Clients come *there* until you
can afford a real desk, and everything that points at "the office" follows it.

The city is a **map**. You pick a place, pay a fare, and go.

| Mode | Cost | Speed | Effort |
|---|---|---|---|
| 🚲 Bicycle | free | slow | tiring |
| 🚈 City Train | $4 + $3/hop | fast | almost none |
| 🚕 TRUNK Ride | $9 + $7/hop | fastest | none |

The bicycle is deliberately free so you can never get stranded broke — but time and
energy are the real currency, and the paid options buy them back.

**Clients come to you.** Your office is the hub. Through the day people turn up in the
waiting room with a request, a budget and a deadline. You take the job or you don't.
Then you travel out, source what they need, and come back to deliver.

**Quests live at locations.** An orange `!` on the map means the current story step is
there. A red badge means clients are waiting at the office. A blue star means you have
never been to that place.

Time only moves when you act — travelling, working, eating, sleeping. There is no clock
ticking at you. But every venue has opening hours, so days need planning.

---

## Systems

- **69 collectible assets** across 10 categories, each with a live price, a spread, a
  liquidity rating and a home venue
- **24 recurring clients**, all human, each drawn from a parametric character system
  (8 skin tones, 6 face shapes, 17 hairstyles, 13 hair colours, beards, glasses, 12 hats —
  over three million distinct people), with tastes, dislikes, patience, a budget tier and a
  trust level that grows or sours
- **Five fee types**: order, management, spread, tokenization and IPO
- **Tokenization** — the core verb. Inspect an asset, file the paperwork, and it splits
  into ownership pieces: better liquidity, fractional buying, and one more percent of the
  city connected
- **Progressive discovery** — 28 locations that reveal themselves as you earn them
- **10 courses**, each ending in an exam you can genuinely fail
- **21 mini-games** on eight engines, 20 seconds to two minutes each
- **6 office stages**, Apartment Desk → Wally Tower
- **5 homes**, ending in the Golden Heights Penthouse
- **10 hireable employees**, each with a salary and a real effect
- **Questlines**: Auntie Maple's farm, Goldie's mine, four IPOs, and the ten-step
  Asseton Stampede story
- **Wally Swap**, a late-game automated market for tokenized assets
- **Phone** with nine apps: Messages, Places, Clients, Wallet, Calendar, News, WallyNet,
  Progress, Settings
- **City Tokenized 0–100%** with milestones every ten percent, and a five-act story

Reaching 100% costs roughly **$680,000** across every upgrade, course, home, listing
and questline.

---

## Art direction

Everything is drawn in one language: the soft matte clay of the reference render.
Diffuse light from the upper left, ambient occlusion in every crease, rounded volumes,
a velvety surface grain, and no outlines anywhere.

- **Characters** — Wally and all 24 humans share the same shading model: specular catch,
  rim light on the shadow side, contact shadow, matte grain.
- **Scenes** — five parallax bands hazing toward the sky, buildings sculpted with
  gradients and rounded corners rather than flat rectangles, bloom on every light
  source, ground scatter with its own contact shadows, and a graded, grained finish.
  258–1,278 drawn elements per scene.
- **The map** — a clay diorama seen from above: a sculpted island in lit water, terrain
  shaded per district with rooftops, trees and hills, hand-drawn roads that light up
  as the city tokenizes, a compass rose and paper grain.

## Accessibility

- Fully playable by keyboard: `M` map · `O` office · `P` phone · `Esc` back
- Touch-first layout; nothing depends on hover
- High-contrast mode, reduced-motion mode, four text sizes
- Separate music and sound-effect sliders
- **Relaxed time** — actions cost less of the day, for players who don't want deadline pressure

## Saving

Autosaves every 45 seconds and on every sleep, to `localStorage`.
Settings → Export writes a JSON file; Import reads one back.
Saves are versioned and migrate forward; a corrupt save is detected and refused rather
than crashing the game.

---

## Files

```
index.html          the whole game in one file — this is the one to open
src/                the readable source
  index.html          shell
  styles.css          design system
  data.js             assets, clients, courses, the map, quests, all content
  art.js              every pixel: Wally, scenes, portraits, icons — all SVG
  boot.js             the arcade boot-up sequence
  map.js              the city map and travel
  ui.js               screens, office, markets, questlines
  game.js             time, client arrivals, quests, milestones
  economy.js          prices, orders, fees, tokenization, daily roll
  minigames.js        eight engines, 21 games
  phone.js            the nine phone apps
  save.js             versioned saves, export/import, recovery
  audio.js            procedural music and effects (Web Audio)
test.js             201 logic and integration checks
playtest.js         107 checks in a real browser, start to finish
build.js            inlines src/ into the standalone index.html
```

Run the tests:

```
node test.js
node playtest.js          # needs playwright + chromium
node build.js             # rebuild the standalone file
```
