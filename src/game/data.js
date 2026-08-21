/* ============================================================
   data.js — all WALLY RPG content, ported from ref/original-wally.html.

   No behaviour lives here. Everything is frozen at module load and
   handed out as `ctx.game.data`.

   IMPORTANT: this file (and every file in src/game/) must import
   cleanly in plain node — no `document`, no `window`, no `location`
   at module scope. That is why nothing here imports core/contracts.js
   (its QUALITY_TIERS table reads `devicePixelRatio` at import time).

   ------------------------------------------------------------
   THE 3D COORDINATE CONVENTION  (read this, world builder)
   ------------------------------------------------------------
   The original game shipped a 1000 x 660 hand-authored 2D map. That
   layout is good and is preserved verbatim as `loc.x` / `loc.y`.
   The 3D island is the SAME layout, projected:

       world.x = (map.x - 500) * 0.9      // +X is EAST
       world.z = (map.y - 330) * 0.9      // +Z is SOUTH (map "down")
       world.y = ground elevation in metres above sea level

   * Units are metres. Three.js right-handed, +Y up. Sea level is y = 0.
   * Scale is 0.9 m per map unit (WORLD.scale). The built city occupies
     roughly 740 x 460 m; the island around it is one continuous
     landmass ~970 m east-west by ~760 m north-south, centred on the
     world origin. Use WORLD.toWorld() / WORLD.toMap() rather than
     re-deriving the constants.
   * The shoreline is an ellipse of semi-axes WORLD.islandRadiusX /
     islandRadiusZ around the origin, and WORLD.shoreSDF(x, z) is its
     signed distance (<0 inland, 0 at the water, >0 at sea). Every
     location sits at least ~29 m inland of it; the outer
     WORLD.beachWidth metres are sand.
   * `zone.world` carries the zone's anchor, its base elevation and an
     axis-aligned {min,max} box plus a radius, computed from its member
     locations with a 45 m skirt. Terrain should read these to sculpt
     plateaus: Golden Heights is a 58 m headland, Iron Hills a 44 m
     ridge, the Waterfront sits at 3 m.
   * `loc.world.y` is the intended GROUND height at that spot. The
     terrain heightfield must pass through it (or the world module
     should snap the building down to its own terrain and ignore y).
   * `loc.yaw` is the building's facing, radians about +Y, where a mesh
     whose front is +Z needs `mesh.rotation.y = loc.yaw`. Every
     building faces its zone anchor (the district's public square);
     zone anchors face the island centre.
   * `loc.size` is {w, d, h} in metres and `loc.radius` a clearance
     circle — nothing else may be placed inside it. The clearance
     circles are guaranteed non-overlapping (asserted in the tests).
   * `loc.kit` names the building archetype ('interior', 'market',
     'learn', 'civic', …) and `loc.tint` its accent colour, so one
     generic builder can dress all 28 places.
   * `JOBS[k].locs` lists the locations that offer that shift; it is
     derived from each location's own `acts`, never hand-maintained.

   Nothing in the world builder should hardcode a place: iterate
   ctx.game.data.locations and read world / yaw / size / kit / tint.
   ============================================================ */

/* ---------------- CONFIG ---------------- */
export const CONFIG = Object.freeze({
  version: 6,
  saveKey: 'wally_rpg_save_v6',
  legacyKeys: Object.freeze(['wally_rpg_save_v5', 'wally_city_of_assets_save_v4']),
  minutesPerSecond: 4,
  dayStartMin: 7 * 60,
  forceSleepMin: 26 * 60,      // 02:00
  rentAmount: 90,
  rentEveryDays: 7,
  startMoney: 250,
  hungerPerHour: 3.4,
  energyPerStep: 0.0032,
  totalAssets: 69,
  totalClients: 24,
  totalLocations: 28,
});

/* ---------------- CATEGORIES ---------------- */
export const CATEGORIES = {
  Stocks:         { ico: '📈', color: '#2F8280' },
  Bonds:          { ico: '📜', color: '#8A6C3E' },
  Farm:           { ico: '🌾', color: '#5F9B58' },
  Minerals:       { ico: '⛏️', color: '#8E7CC3' },
  Property:       { ico: '🏠', color: '#BE7A34' },
  Culture:        { ico: '🎨', color: '#C0518B' },
  Infrastructure: { ico: '⚡', color: '#3E7BB0' },
  Business:       { ico: '🏪', color: '#D08A2B' },
  Sports:         { ico: '🏟️', color: '#BE4C34' },
  Transport:      { ico: '🚋', color: '#6D8A3C' },
};

/* ---------------- 69 ASSETS ----------------
   v: base value | q: liquidity 1..5 | ven: venue
   tq: tokenization difficulty 1..3 | div/cpn/farm/mine: yield tiers
--------------------------------------------- */
export const ASSETS = [
  /* 15 public stocks */
  { id: 'trnk', n: 'Trunk Technologies',        tick: 'TRNK', cat: 'Stocks', v: 42, q: 5, ven: 'exchange', tq: 2, ico: '🚗', div: 0.4 },
  { id: 'acrn', n: 'Acorn Foods',               tick: 'ACRN', cat: 'Stocks', v: 28, q: 5, ven: 'exchange', tq: 1, ico: '🥫', div: 0.5 },
  { id: 'mmtr', n: 'MetroMammoth Transit',      tick: 'MMTR', cat: 'Stocks', v: 35, q: 4, ven: 'exchange', tq: 2, ico: '🚈', div: 0.6 },
  { id: 'bgrd', n: 'BrightGrid Energy',         tick: 'BGRD', cat: 'Stocks', v: 51, q: 5, ven: 'exchange', tq: 2, ico: '🔌', div: 0.8 },
  { id: 'ctsk', n: 'CloudTusk Systems',         tick: 'CTSK', cat: 'Stocks', v: 88, q: 5, ven: 'exchange', tq: 3, ico: '☁️', div: 0.2 },
  { id: 'stmd', n: 'Stampede Media',            tick: 'STMD', cat: 'Stocks', v: 19, q: 4, ven: 'exchange', tq: 2, ico: '📺', div: 0.1 },
  { id: 'brbm', n: 'Brick & Beam Construction', tick: 'BRBM', cat: 'Stocks', v: 33, q: 4, ven: 'exchange', tq: 1, ico: '🧱', div: 0.5 },
  { id: 'blrv', n: 'BlueRiver Health',          tick: 'BLRV', cat: 'Stocks', v: 64, q: 5, ven: 'exchange', tq: 2, ico: '🩺', div: 0.4 },
  { id: 'orbt', n: 'Orchard Robotics',          tick: 'ORBT', cat: 'Stocks', v: 46, q: 4, ven: 'exchange', tq: 3, ico: '🤖', div: 0.1 },
  { id: 'czbr', n: 'CozyBurrow Hotels',         tick: 'CZBR', cat: 'Stocks', v: 22, q: 4, ven: 'exchange', tq: 1, ico: '🛏️', div: 0.6 },
  { id: 'pbmb', n: 'Pebble Mobile',             tick: 'PBMB', cat: 'Stocks', v: 17, q: 5, ven: 'exchange', tq: 1, ico: '📱', div: 0.3 },
  { id: 'lntr', n: 'Lantern Retail',            tick: 'LNTR', cat: 'Stocks', v: 26, q: 5, ven: 'exchange', tq: 1, ico: '🛍️', div: 0.5 },
  { id: 'rvrn', n: 'RiverRun Logistics',        tick: 'RVRN', cat: 'Stocks', v: 39, q: 4, ven: 'exchange', tq: 2, ico: '📦', div: 0.4 },
  { id: 'wflw', n: 'WaffleWorks',               tick: 'WFLW', cat: 'Stocks', v: 12, q: 4, ven: 'exchange', tq: 2, ico: '🧇', div: 0.2 },
  { id: 'nrth', n: 'NorthStar Manufacturing',   tick: 'NRTH', cat: 'Stocks', v: 57, q: 4, ven: 'exchange', tq: 2, ico: '⚙️', div: 0.7 },

  /* 4 treasury bonds — tickers read as maturities */
  { id: 'bond3m',  n: 'Three-Month City Note',         tick: 'B3M',  cat: 'Bonds', v: 100,  q: 5, ven: 'treasury', tq: 1, ico: '🧾',  cpn: 0.6 },
  { id: 'bond1y',  n: 'One-Year Community Bond',       tick: 'B1Y',  cat: 'Bonds', v: 250,  q: 4, ven: 'treasury', tq: 1, ico: '📜',  cpn: 1.4 },
  { id: 'bond5y',  n: 'Five-Year Infrastructure Bond', tick: 'B5Y',  cat: 'Bonds', v: 500,  q: 3, ven: 'treasury', tq: 2, ico: '🏗️', cpn: 3.2 },
  { id: 'bond10y', n: 'Ten-Year Restoration Bond',     tick: 'B10Y', cat: 'Bonds', v: 1000, q: 3, ven: 'treasury', tq: 2, ico: '🏛️', cpn: 7 },

  /* 8 farm — the crop, spelled the way you would say it */
  { id: 'straw',  n: 'Strawberry Field Token', tick: 'BERRY', cat: 'Farm', v: 60,  q: 3, ven: 'farmcoop', tq: 1, ico: '🍓', farm: 1 },
  { id: 'wheat',  n: 'Wheat Field Token',      tick: 'WHEAT', cat: 'Farm', v: 45,  q: 3, ven: 'farmcoop', tq: 1, ico: '🌾', farm: 1 },
  { id: 'corn',   n: 'Cornfield Token',        tick: 'CORN',  cat: 'Farm', v: 48,  q: 3, ven: 'farmcoop', tq: 1, ico: '🌽', farm: 2 },
  { id: 'apple',  n: 'Apple Orchard Token',    tick: 'APPLE', cat: 'Farm', v: 75,  q: 3, ven: 'farmcoop', tq: 2, ico: '🍎', farm: 2 },
  { id: 'milk',   n: 'Milk Route Token',       tick: 'MILK',  cat: 'Farm', v: 55,  q: 3, ven: 'farmcoop', tq: 2, ico: '🥛', farm: 3 },
  { id: 'cattle', n: 'Cattle Herd Token',      tick: 'HERD',  cat: 'Farm', v: 140, q: 2, ven: 'farmcoop', tq: 3, ico: '🐄', farm: 3 },
  { id: 'honey',  n: 'Honey Hive Token',       tick: 'HONEY', cat: 'Farm', v: 90,  q: 2, ven: 'farmcoop', tq: 3, ico: '🍯', farm: 4 },
  { id: 'timber', n: 'Timber Stand Token',     tick: 'TIMBR', cat: 'Farm', v: 120, q: 2, ven: 'farmcoop', tq: 2, ico: '🌲', farm: 4 },

  /* 4 minerals — the metal */
  { id: 'gold',   n: 'Gold Seam Token',       tick: 'GOLD',  cat: 'Minerals', v: 320, q: 3, ven: 'mineral', tq: 2, ico: '🥇', mine: 2 },
  { id: 'silver', n: 'Silver Seam Token',     tick: 'SILVR', cat: 'Minerals', v: 180, q: 3, ven: 'mineral', tq: 1, ico: '🥈', mine: 1 },
  { id: 'copper', n: 'Copper Vein Token',     tick: 'COPPR', cat: 'Minerals', v: 95,  q: 4, ven: 'mineral', tq: 1, ico: '🟤', mine: 1 },
  { id: 'gems',   n: 'Gemstone Pocket Token', tick: 'GEMS',  cat: 'Minerals', v: 420, q: 2, ven: 'mineral', tq: 3, ico: '💎', mine: 3 },

  /* 8 property — P + what kind of building it is */
  { id: 'flat',   n: 'Rusty Row Starter Flat',      tick: 'PFLAT', cat: 'Property', v: 900,  q: 2, ven: 'property', tq: 1, ico: '🏚️' },
  { id: 'store',  n: 'Main Street Storefront',      tick: 'PSHOP', cat: 'Property', v: 1600, q: 2, ven: 'property', tq: 1, ico: '🏬' },
  { id: 'wareh',  n: 'Iron Hills Warehouse',        tick: 'PWHSE', cat: 'Property', v: 2100, q: 2, ven: 'property', tq: 2, ico: '🏭' },
  { id: 'offblk', n: 'Market Square Office Block',  tick: 'POFFC', cat: 'Property', v: 3200, q: 2, ven: 'property', tq: 2, ico: '🏢' },
  { id: 'luxapt', n: 'Waterfront Luxury Apartment', tick: 'PLUXE', cat: 'Property', v: 5200, q: 1, ven: 'property', tq: 2, ico: '🌇' },
  { id: 'induyd', n: 'Iron Hills Industrial Yard',  tick: 'PYARD', cat: 'Property', v: 2600, q: 1, ven: 'property', tq: 2, ico: '🚧' },
  { id: 'dorm',   n: 'Learning Quarter Housing',    tick: 'PDORM', cat: 'Property', v: 1900, q: 2, ven: 'property', tq: 1, ico: '🏘️' },
  { id: 'tower',  n: 'Waterfront Tower Floor',      tick: 'PTWR',  cat: 'Property', v: 7400, q: 1, ven: 'property', tq: 3, ico: '🗼' },

  /* 7 culture — the object itself */
  { id: 'gallery', n: 'Juniper Gallery Collection', tick: 'GALRY', cat: 'Culture', v: 480, q: 2, ven: 'bazaar', tq: 2, ico: '🖼️' },
  { id: 'catalog', n: 'Bull Bear Music Catalog',    tick: 'MUSIC', cat: 'Culture', v: 620, q: 2, ven: 'bazaar', tq: 2, ico: '🎵' },
  { id: 'sneaks',  n: 'Vintage Trunk Sneakers',     tick: 'SNEAK', cat: 'Culture', v: 210, q: 3, ven: 'bazaar', tq: 1, ico: '👟' },
  { id: 'card',    n: 'Rare Stampede Rookie Card',  tick: 'CARD',  cat: 'Culture', v: 240, q: 2, ven: 'bazaar', tq: 1, ico: '🃏' },
  { id: 'watch',   n: 'Historic Clocktower Watch',  tick: 'WATCH', cat: 'Culture', v: 560, q: 1, ven: 'bazaar', tq: 2, ico: '⌚' },
  { id: 'film',    n: 'Riverlight Film Royalties',  tick: 'FILM',  cat: 'Culture', v: 700, q: 1, ven: 'bazaar', tq: 3, ico: '🎬' },
  { id: 'museum',  n: 'City Museum Collection',     tick: 'MUSEM', cat: 'Culture', v: 880, q: 1, ven: 'bazaar', tq: 3, ico: '🏺' },

  /* 7 infrastructure — the utility */
  { id: 'solar',   n: 'Green Edge Solar Field',   tick: 'SOLAR', cat: 'Infrastructure', v: 1200, q: 2, ven: 'infra', tq: 2, ico: '🔆' },
  { id: 'wind',    n: 'Ridge Wind Farm',          tick: 'WIND',  cat: 'Infrastructure', v: 1500, q: 2, ven: 'infra', tq: 2, ico: '🌬️' },
  { id: 'battery', n: 'Battery Yard Facility',    tick: 'BATT',  cat: 'Infrastructure', v: 1100, q: 2, ven: 'infra', tq: 2, ico: '🔋' },
  { id: 'water',   n: 'Bull Bear Water Utility',  tick: 'WATER', cat: 'Infrastructure', v: 1800, q: 1, ven: 'infra', tq: 3, ico: '🚰' },
  { id: 'bridge',  n: 'Old Toll Bridge',          tick: 'BRDG',  cat: 'Infrastructure', v: 2200, q: 1, ven: 'infra', tq: 3, ico: '🌉' },
  { id: 'station', n: 'Central Train Station',    tick: 'STATN', cat: 'Infrastructure', v: 2800, q: 1, ven: 'infra', tq: 3, ico: '🚉' },
  { id: 'fiber',   n: 'Fiber Backbone Network',   tick: 'FIBER', cat: 'Infrastructure', v: 1700, q: 2, ven: 'infra', tq: 3, ico: '🕸️' },

  /* 7 businesses — what is written on the awning */
  { id: 'bakery',  n: 'Crumb & Co. Bakery',   tick: 'CRUMB', cat: 'Business', v: 380,  q: 3, ven: 'broker', tq: 1, ico: '🥐' },
  { id: 'cafe',    n: 'Rusty Row Café',       tick: 'CAFE',  cat: 'Business', v: 420,  q: 3, ven: 'broker', tq: 1, ico: '☕' },
  { id: 'resto',   n: "Rico's Restaurant",    tick: 'RICO',  cat: 'Business', v: 750,  q: 2, ven: 'broker', tq: 2, ico: '🍝' },
  { id: 'fleet',   n: 'TRUNK Delivery Fleet', tick: 'FLEET', cat: 'Business', v: 980,  q: 2, ven: 'broker', tq: 2, ico: '🚚' },
  { id: 'inn',     n: 'CozyBurrow Inn',       tick: 'INN',   cat: 'Business', v: 1300, q: 2, ven: 'broker', tq: 2, ico: '🏨' },
  { id: 'arcade',  n: 'Pixel Palace Arcade',  tick: 'PIXEL', cat: 'Business', v: 400,  q: 3, ven: 'broker', tq: 1, ico: '🕹️' },
  { id: 'mkthall', n: 'Market Hall Stalls',   tick: 'STALL', cat: 'Business', v: 640,  q: 3, ven: 'broker', tq: 2, ico: '🧺' },

  /* 5 sports */
  { id: 'academy',  n: 'Stampede Youth Academy',        tick: 'YOUTH', cat: 'Sports', v: 900,  q: 2, ven: 'stadiumoffice', tq: 2, ico: '🎽' },
  { id: 'concess',  n: 'Stadium Concessions',           tick: 'CONCS', cat: 'Sports', v: 1150, q: 2, ven: 'stadiumoffice', tq: 2, ico: '🌭' },
  { id: 'rights',   n: 'Stampede Media Rights',         tick: 'RIGHT', cat: 'Sports', v: 2400, q: 1, ven: 'stadiumoffice', tq: 3, ico: '📡' },
  { id: 'minorlg',  n: 'Bull Bear Minor League Club',   tick: 'MINOR', cat: 'Sports', v: 1900, q: 1, ven: 'stadiumoffice', tq: 3, ico: '⚾' },
  { id: 'stampede', n: 'Bull Bear Stampede Team Token', tick: 'TEAM',  cat: 'Sports', v: 9500, q: 1, ven: 'stadiumoffice', tq: 3, ico: '🐘' },

  /* 4 transport */
  { id: 'ferry',  n: 'Harbor Ferry Line',          tick: 'FERRY', cat: 'Transport', v: 1400, q: 2, ven: 'infra', tq: 2, ico: '⛴️' },
  { id: 'busdep', n: 'Crosstown Bus Depot',        tick: 'BUS',   cat: 'Transport', v: 1250, q: 2, ven: 'infra', tq: 2, ico: '🚌' },
  { id: 'bikes',  n: 'City Bicycle Share Network', tick: 'BIKES', cat: 'Transport', v: 380,  q: 3, ven: 'infra', tq: 1, ico: '🚲' },
  { id: 'hangar', n: 'Northfield Airfield Hangar', tick: 'HANGR', cat: 'Transport', v: 3100, q: 1, ven: 'infra', tq: 3, ico: '✈️' },
];

export const ASSET_BY_ID = {};
for (const a of ASSETS) ASSET_BY_ID[a.id] = a;

/* ============================================================
   TICKERS — every asset has one, and it is the primary handle.

   THE SCHEME. All 69 are 3–5 characters, uppercase, unique, and
   asserted unique in tools/test-game.mjs so a future edit cannot
   collide. Per category:

     Stocks    the 15 original symbols, untouched — they are in
               save files and quest text (TRNK, ACRN, MMTR, …)
     Bonds     the maturity          B3M B1Y B5Y B10Y
     Farm      the crop              WHEAT CORN APPLE MILK HERD …
     Minerals  the metal             GOLD SILVR COPPR GEMS
     Property  P + the building      PFLAT PSHOP PWHSE POFFC PTWR …
     Culture   the object            GALRY MUSIC SNEAK CARD WATCH …
     Infra     the utility           SOLAR WIND BATT WATER BRDG …
     Business  the awning            CRUMB CAFE RICO FLEET INN …
     Sports    the thing you own     YOUTH CONCS RIGHT MINOR TEAM
     Transport the vehicle           FERRY BUS BIKES HANGR

   So an order reads like a trade ticket: "3x WHEAT", "buy GOLD".

   normTicker() is deliberately forgiving — case, whitespace and
   punctuation are all stripped — because players type into a
   search box, not a form field.
   ============================================================ */
export const ASSET_BY_TICK = {};
for (const a of ASSETS) ASSET_BY_TICK[a.tick] = a;

export const normTicker = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');

/* Exact resolve: an asset id, or a ticker in any casing/spacing.
   Never fuzzy — callers that want fuzzy use searchAssets(). */
export function byTicker(s) {
  if (s == null) return null;
  const raw = String(s).trim();
  if (ASSET_BY_ID[raw]) return ASSET_BY_ID[raw];
  return ASSET_BY_TICK[normTicker(raw)] || null;
}
/* id | ticker -> canonical asset id, or null. */
export function assetIdOf(s) {
  const a = byTicker(s);
  return a ? a.id : null;
}
/* 'GOLD · Gold Seam Token' — the one place ticker+name is joined. */
export function assetLabel(s, sep = ' · ') {
  const a = byTicker(s);
  return a ? a.tick + sep + a.n : String(s == null ? '' : s);
}
/* '2x WHEAT' — one line of a trade ticket. */
export function tickerQty(s, qty = 1) {
  const a = byTicker(s);
  return (qty === 1 ? '' : qty + 'x ') + (a ? a.tick : String(s));
}

/* Fuzzy/prefix search over TICKER **and** NAME, best first.
   "gol" -> GOLD, "wheat" -> WHEAT, "rusty" -> PFLAT + CAFE.
   Scores, high to low:
     100 exact ticker or id   80 ticker prefix     70 ticker substring
      60 name prefix          50 word-start in name
      40 name substring       20 ticker subsequence ("gms" -> GEMS)
   Ties break on the cheaper asset, so the common thing wins. */
export function searchAssets(q, limit = 12) {
  const raw = String(q == null ? '' : q).trim();
  if (!raw) return [];
  const T = normTicker(raw);
  const L = raw.toLowerCase();
  const out = [];
  for (const a of ASSETS) {
    const tick = a.tick, name = a.n.toLowerCase();
    let score = 0;
    if (tick === T) score = 100;
    else if (T && tick.startsWith(T)) score = 80;
    else if (T && tick.includes(T)) score = 70;
    else if (name.startsWith(L)) score = 60;
    else if (name.split(/[^a-z0-9]+/).some((w) => w && w.startsWith(L))) score = 50;
    else if (name.includes(L)) score = 40;
    else if (T && subseq(T, tick)) score = 20;
    if (a.id === raw.toLowerCase()) score = 100;
    if (score) out.push({ a, score });
  }
  out.sort((x, y) => y.score - x.score || x.a.v - y.a.v || x.a.id.localeCompare(y.a.id));
  return out.slice(0, limit).map((x) => x.a);
}
function subseq(needle, hay) {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}

/* ---------------- 9 VENUES ---------------- */
export const VENUES = {
  exchange:      { name: 'Bull Bear Stock Exchange', flag: 'exchange',      spread: 0.02, hours: [9, 16] },
  treasury:      { name: 'City Treasury',            flag: 'treasury',      spread: 0.01, hours: [9, 15] },
  farmcoop:      { name: 'Farm Cooperative',         flag: 'farmcoop',      spread: 0.05, hours: [6, 17] },
  mineral:       { name: 'Mineral Exchange',         flag: 'mineral',       spread: 0.05, hours: [7, 17] },
  property:      { name: 'Property Office',          flag: 'property',      spread: 0.07, hours: [9, 18] },
  bazaar:        { name: 'Culture Bazaar',           flag: 'bazaar',        spread: 0.09, hours: [11, 21] },
  broker:        { name: 'Business Broker',          flag: 'broker',        spread: 0.08, hours: [9, 18] },
  infra:         { name: 'Infrastructure Authority', flag: 'infra',         spread: 0.06, hours: [8, 17] },
  stadiumoffice: { name: 'Stadium Office',           flag: 'stadiumoffice', spread: 0.06, hours: [10, 20] },
};

/* which location sells which venue's assets */
export const VENUE_LOC = {
  exchange: 'exchange', treasury: 'treasury', farmcoop: 'farmcoop', mineral: 'mineral',
  property: 'propertyoffice', bazaar: 'bazaar', broker: 'broker', infra: 'infra',
  stadiumoffice: 'stadiumoffice',
};

/* ---------------- 24 CLIENTS ---------------- */
export const CLIENTS = [
  { id: 'mabel', n: 'Mabel', role: 'Retired teacher', fav: ['Bonds', 'Property'], hate: ['Minerals'], patience: 5, budget: 1, hue: '#B98CC0', skin: 'fair', face: 'round', hair: 'bob', hairCol: 'silver', beard: 'none', specs: 'halfmoon', age: 2, mood: 'warm', hat: 'none', home: 'rustyrow',
    intro: "I taught arithmetic for thirty-one years. I still don't trust anything that goes up too fast." },
  { id: 'rico', n: 'Rico', role: 'Restaurant owner', fav: ['Farm', 'Business'], hate: ['Culture'], patience: 3, budget: 2, hue: '#C4553D', skin: 'tan', face: 'broad', hair: 'buzz', hairCol: 'black', beard: 'full', specs: 'none', age: 1, mood: 'warm', hat: 'chef', home: 'mainstreet',
    intro: "If it doesn't end up on a plate, I don't understand it. Make me understand it." },
  { id: 'juniper', n: 'Juniper', role: 'Gallery artist', fav: ['Culture'], hate: ['Minerals'], patience: 4, budget: 1, hue: '#3E8E8C', skin: 'porcelain', face: 'heart', hair: 'pony', hairCol: 'plum', beard: 'none', specs: 'none', age: 0, mood: 'warm', hat: 'beret', home: 'marketsq',
    intro: "Everyone says art isn't an asset. Everyone is also broke, so." },
  { id: 'bolt', n: 'Bolt', role: 'Tech founder', fav: ['Stocks', 'Infrastructure'], hate: ['Bonds'], patience: 2, budget: 3, hue: '#4A7BC4', skin: 'olive', face: 'oval', hair: 'quiff', hairCol: 'darkbrown', beard: 'stubble', specs: 'square', age: 0, mood: '', hat: 'none', home: 'innovation',
    intro: 'I have twelve minutes. Actually nine. Make them count.' },
  { id: 'tusk', n: 'Mayor Tusk', role: 'City mayor', fav: ['Infrastructure', 'Transport'], hate: [], patience: 4, budget: 3, hue: '#8A6C3E', skin: 'warm', face: 'square', hair: 'receding', hairCol: 'grey', beard: 'moustache', specs: 'none', age: 2, mood: 'warm', hat: 'top', home: 'mainstreet',
    intro: "I don't need the details, Wally. I need a ribbon to cut." },
  { id: 'penny', n: 'Penny', role: 'Collector', fav: ['Culture'], hate: ['Bonds'], patience: 2, budget: 1, hue: '#D08A2B', skin: 'fair', face: 'long', hair: 'braids', hairCol: 'auburn', beard: 'none', specs: 'round', age: 1, mood: '', hat: 'flat', home: 'marketsq',
    intro: "That's your price? That's your FIRST price, surely." },
  { id: 'thunder', n: 'Coach Thunder', role: 'Stampede coach', fav: ['Sports'], hate: [], patience: 5, budget: 2, hue: '#BE4C34', skin: 'bronze', face: 'square', hair: 'buzz', hairCol: 'black', beard: 'goatee', specs: 'none', age: 1, mood: 'stern', hat: 'cap', home: 'stampede',
    intro: "Forty years on that field. I'd like ten more." },
  { id: 'ledger', n: 'Mr. Ledger', role: 'Old money', fav: ['Property', 'Bonds'], hate: ['Business'], patience: 1, budget: 4, hue: '#33291D', skin: 'porcelain', face: 'long', hair: 'side', hairCol: 'white', beard: 'none', specs: 'halfmoon', age: 2, mood: 'stern', hat: 'none', home: 'goldenheights',
    intro: "You work from an apartment. I'll wait outside." },
  { id: 'maple', n: 'Auntie Maple', role: 'Farm owner', fav: ['Farm'], hate: ['Stocks'], patience: 5, budget: 1, hue: '#5F9B58', skin: 'tan', face: 'round', hair: 'bun', hairCol: 'grey', beard: 'none', specs: 'none', age: 2, mood: 'warm', hat: 'bucket', home: 'greenedge',
    intro: "The soil's fine. It's the paperwork that's dying." },
  { id: 'goldie', n: 'Goldie', role: 'Retired miner', fav: ['Minerals'], hate: ['Culture'], patience: 4, budget: 1, hue: '#8E7CC3', skin: 'warm', face: 'broad', hair: 'short', hairCol: 'silver', beard: 'full', specs: 'none', age: 2, mood: '', hat: 'helm', home: 'ironhills',
    intro: 'Every rock down there is probably valuable. Probably.' },
  { id: 'dot', n: 'Dot', role: 'Barista', fav: ['Business', 'Farm'], hate: ['Property'], patience: 4, budget: 1, hue: '#C0518B', skin: 'deep', face: 'oval', hair: 'afro', hairCol: 'black', beard: 'none', specs: 'none', age: 0, mood: 'warm', hat: 'none', home: 'mainstreet',
    intro: "I saved four hundred dollars. Please don't lose it. Please." },
  { id: 'hazel', n: 'Hazel', role: 'Librarian', fav: ['Culture', 'Bonds'], hate: ['Stocks'], patience: 5, budget: 1, hue: '#6D8A3C', skin: 'olive', face: 'oval', hair: 'long', hairCol: 'chestnut', beard: 'none', specs: 'round', age: 1, mood: 'warm', hat: 'none', home: 'learning',
    intro: 'Shhh. Now, about the museum collection.' },
  { id: 'barnaby', n: 'Barnaby', role: 'Bus driver', fav: ['Transport'], hate: ['Culture'], patience: 4, budget: 1, hue: '#3E7BB0', skin: 'fair', face: 'broad', hair: 'bald', hairCol: 'grey', beard: 'moustache', specs: 'none', age: 2, mood: '', hat: 'flat', home: 'rustyrow',
    intro: 'Route 6, thirty years. I know where this city hurts.' },
  { id: 'ivy', n: 'Ivy', role: 'Solar engineer', fav: ['Infrastructure'], hate: ['Minerals'], patience: 3, budget: 2, hue: '#E4B33C', skin: 'bronze', face: 'heart', hair: 'locs', hairCol: 'darkbrown', beard: 'none', specs: 'none', age: 0, mood: 'warm', hat: 'helm', home: 'greenedge',
    intro: 'The sun is free. Everything after the sun is expensive.' },
  { id: 'sunny', n: 'Sunny', role: 'Waffle stand owner', fav: ['Business', 'Farm'], hate: ['Bonds'], patience: 3, budget: 1, hue: '#F0A22A', skin: 'warm', face: 'round', hair: 'curly', hairCol: 'ginger', beard: 'none', specs: 'none', age: 0, mood: 'warm', hat: 'chef', home: 'marketsq',
    intro: 'One stand. One dream. Two waffle irons, one of which works.' },
  { id: 'grimm', n: 'Marcus Grimm', role: 'Landlord', fav: ['Property'], hate: ['Sports'], patience: 2, budget: 3, hue: '#5A5148', skin: 'porcelain', face: 'long', hair: 'side', hairCol: 'black', beard: 'stubble', specs: 'thick', age: 1, mood: 'stern', hat: 'fedora', home: 'rustyrow',
    intro: "Rent is due. That's not a threat, it's a business model." },
  { id: 'fenn', n: 'Fenn', role: 'Student', fav: ['Stocks'], hate: ['Property'], patience: 3, budget: 1, hue: '#4AA6C4', skin: 'fair', face: 'oval', hair: 'mohawk', hairCol: 'teal', beard: 'none', specs: 'none', age: 0, mood: '', hat: 'beanie', home: 'learning',
    intro: 'I have ninety dollars and unlimited confidence.' },
  { id: 'nadia', n: 'Nadia', role: 'Hotel manager', fav: ['Business', 'Property'], hate: ['Minerals'], patience: 3, budget: 2, hue: '#B4646E', skin: 'olive', face: 'heart', hair: 'headscarf', hairCol: 'plum', beard: 'none', specs: 'none', age: 1, mood: 'warm', hat: 'none', home: 'waterfront',
    intro: 'Occupancy is at nineteen percent. I would like a different number.' },
  { id: 'otto', n: 'Otto', role: 'Arcade owner', fav: ['Business', 'Culture'], hate: ['Bonds'], patience: 4, budget: 1, hue: '#7B5EA7', skin: 'ebony', face: 'square', hair: 'short', hairCol: 'black', beard: 'goatee', specs: 'square', age: 1, mood: 'warm', hat: 'none', home: 'rustyrow',
    intro: "Kids don't have quarters anymore. What do they have?" },
  { id: 'pearl', n: 'Pearl', role: 'Waterfront developer', fav: ['Property', 'Infrastructure'], hate: ['Farm'], patience: 2, budget: 4, hue: '#2F8280', skin: 'deep', face: 'oval', hair: 'bun', hairCol: 'black', beard: 'none', specs: 'thick', age: 1, mood: 'stern', hat: 'none', home: 'waterfront',
    intro: "I build things that block other people's views. Professionally." },
  { id: 'wendell', n: 'Wendell', role: 'Train dispatcher', fav: ['Transport', 'Infrastructure'], hate: [], patience: 5, budget: 2, hue: '#8A6C3E', skin: 'fair', face: 'long', hair: 'wavy', hairCol: 'blonde', beard: 'none', specs: 'round', age: 1, mood: '', hat: 'visor', home: 'innovation',
    intro: 'Platform three has been closed since before you were born.' },
  { id: 'bex', n: 'Bex', role: 'Sneaker dealer', fav: ['Culture', 'Sports'], hate: ['Bonds'], patience: 2, budget: 2, hue: '#C4553D', skin: 'bronze', face: 'round', hair: 'braids', hairCol: 'blonde', beard: 'none', specs: 'none', age: 0, mood: 'warm', hat: 'cap', home: 'marketsq',
    intro: "Deadstock. Never worn. Don't ask where from." },
  { id: 'quill', n: 'Dr. Quill', role: 'Health researcher', fav: ['Stocks', 'Infrastructure'], hate: ['Sports'], patience: 4, budget: 3, hue: '#5F9B58', skin: 'olive', face: 'long', hair: 'short', hairCol: 'grey', beard: 'stubble', specs: 'square', age: 2, mood: '', hat: 'none', home: 'innovation',
    intro: 'I fund studies. Studies do not fund themselves. Tragically.' },
  { id: 'vance', n: 'Silas Vance', role: 'Institutional capital', fav: ['Property', 'Sports', 'Infrastructure'], hate: [], patience: 2, budget: 5, hue: '#1F1B16', skin: 'porcelain', face: 'square', hair: 'receding', hairCol: 'silver', beard: 'none', specs: 'halfmoon', age: 2, mood: 'stern', hat: 'none', home: 'goldenheights',
    intro: 'I move slowly and then all at once. Impress me.' },
];

export const CLIENT_BY_ID = {};
for (const c of CLIENTS) CLIENT_BY_ID[c.id] = c;

/* ---------------- 10 COURSES ---------------- */
export const COURSES = [
  { id: 'negotiation',  n: 'Negotiation Basics',      cost: 120, hours: 3, energy: 18, rep: 2, mg: 'meter',
    desc: 'Better prices when you haggle with private sellers.' },
  { id: 'inspection',   n: 'Asset Inspection',        cost: 150, hours: 3, energy: 18, rep: 2, mg: 'inspect',
    desc: 'Reveals hidden faults before you buy. Required for tokenization work.' },
  { id: 'psychology',   n: 'Client Psychology',       cost: 180, hours: 3, energy: 16, rep: 3, mg: 'pick',
    desc: 'Shows what each client secretly wants.' },
  { id: 'fundamentals', n: 'Market Fundamentals',     cost: 260, hours: 4, energy: 22, rep: 4, mg: 'chart',
    desc: 'Trader badge exam. Step one of unlocking the Stock Exchange.', req: ['inspection'] },
  { id: 'agops',        n: 'Agricultural Operations', cost: 220, hours: 4, energy: 20, rep: 3, mg: 'timing',
    desc: 'Bigger harvests, healthier fields.' },
  { id: 'mining',       n: 'Mining and Safety',       cost: 240, hours: 4, energy: 24, rep: 3, mg: 'route',
    desc: 'Required before the elevator inspector will even look at you.' },
  { id: 'valuation',    n: 'Business Valuation',      cost: 420, hours: 5, energy: 24, rep: 5, mg: 'valuation',
    desc: 'Required for every IPO questline.', req: ['fundamentals'] },
  { id: 'fundcon',      n: 'Fund Construction',       cost: 380, hours: 4, energy: 20, rep: 5, mg: 'sort',
    desc: 'Build larger client baskets and charge weekly fees.', req: ['psychology'] },
  { id: 'mobile',       n: 'Mobile Asset Management', cost: 340, hours: 3, energy: 16, rep: 4, mg: 'sort',
    desc: 'Unlocks the phone Asset Wallet upgrade path.' },
  { id: 'advmkt',       n: 'Advanced Market Systems', cost: 900, hours: 6, energy: 30, rep: 8, mg: 'pool',
    desc: 'The theory behind Wally Swap. Very long. Free coffee.', req: ['fundamentals', 'fundcon'] },
];
export const COURSE_BY_ID = {};
for (const c of COURSES) COURSE_BY_ID[c.id] = c;

/* ---------------- 6 OFFICE STAGES ---------------- */
export const OFFICE_STAGES = [
  { n: 'Apartment Desk',      cost: 0,      slots: 1, invCap: 12,  fundCap: 0,  rep: 0,  desc: 'A folding table that is also your dining table.' },
  { n: 'Shared Desk',         cost: 1200,   slots: 2, invCap: 20,  fundCap: 1,  rep: 12, desc: 'Main Street. Free coffee, questionable chair.' },
  { n: 'Small Office',        cost: 5500,   slots: 3, invCap: 32,  fundCap: 3,  rep: 30, desc: 'A waiting area! People can wait for you now.' },
  { n: 'Professional Office', cost: 22000,  slots: 4, invCap: 48,  fundCap: 5,  rep: 55, desc: 'Departments. A conference room. A research terminal.' },
  { n: 'City Headquarters',   cost: 55000,  slots: 6, invCap: 70,  fundCap: 8,  rep: 80, desc: 'Automated operations and a city-wide asset map.' },
  { n: 'Wally Tower',         cost: 150000, slots: 8, invCap: 110, fundCap: 12, rep: 95, desc: 'Rooftop watering hole. Actual water. It is a joke about elephants.' },
];

/* ---------------- 5 HOMES ---------------- */
export const HOMES = [
  { id: 'rusty',     n: 'Rusty Row Apartment',      cost: 0,      rest: 62,  rent: 90,  store: 0,  rep: 0,  desc: 'Mattress, broken desk, leaking sink, one poster.' },
  { id: 'studio',    n: 'Main Street Studio',       cost: 3400,   rest: 74,  rent: 150, store: 6,  rep: 5,  desc: 'The sink works. Revolutionary.' },
  { id: 'loft',      n: 'Market Square Loft',       cost: 14000,  rest: 84,  rent: 240, store: 12, rep: 12, desc: 'Remote order acceptance from the kitchen table.' },
  { id: 'water',     n: 'Waterfront Apartment',     cost: 40000,  rest: 94,  rent: 420, store: 20, rep: 25, desc: 'Boats. Actual boats, outside the window.' },
  { id: 'penthouse', n: 'Golden Heights Penthouse', cost: 220000, rest: 100, rent: 900, store: 36, rep: 45, desc: 'The most expensive apartment in Bull Bear City.' },
];
export const HOME_BY_ID = {};
for (const h of HOMES) HOME_BY_ID[h.id] = h;

/* ---------------- 10 ZONES ----------------
   x/y are 2D-map coords on the original 1000x660 board.
   `elev` is the district's base ground height in metres.
   `world` is filled in by the projection pass below.
------------------------------------------- */
export const ZONES = {
  rustyrow:      { id: 'rustyrow',      n: 'Rusty Row',           x: 150, y: 520, kit: 'rundown', unlock: 0, elev: 7,  tint: '#6E5B46', blurb: 'Cheap rent, loud pipes, good people.' },
  mainstreet:    { id: 'mainstreet',    n: 'Main Street',         x: 320, y: 392, kit: 'city',    unlock: 0, elev: 13, tint: '#5E6880', blurb: 'Where the city pretends to be doing fine.' },
  learning:      { id: 'learning',      n: 'Learning Quarter',    x: 148, y: 286, kit: 'learn',   unlock: 0, elev: 19, tint: '#6E6A50', blurb: 'Chalk dust and second chances.' },
  marketsq:      { id: 'marketsq',      n: 'Market Square',       x: 452, y: 296, kit: 'market',  unlock: 0, elev: 15, tint: '#8A6248', blurb: 'Everything is for sale, loudly.' },
  greenedge:     { id: 'greenedge',     n: 'Green Edge',          x: 212, y: 132, kit: 'farm',    unlock: 0, elev: 11, tint: '#5E7A48', blurb: 'Fields that stopped being profitable.' },
  ironhills:     { id: 'ironhills',     n: 'Iron Hills',          x: 470, y: 112, kit: 'mine',    unlock: 0, elev: 44, tint: '#6A5A50', blurb: 'The hills remember being rich.' },
  waterfront:    { id: 'waterfront',    n: 'Waterfront',          x: 472, y: 544, kit: 'water',   unlock: 0, elev: 3,  tint: '#43687E', blurb: 'Cranes, gulls, and cold coffee.' },
  innovation:    { id: 'innovation',    n: 'Innovation District', x: 702, y: 300, kit: 'tech',    unlock: 0, elev: 21, tint: '#4A6A80', blurb: 'Six startups per building. Four will fail.' },
  stampede:      { id: 'stampede',      n: 'Stampede District',   x: 762, y: 528, kit: 'stadium', unlock: 0, elev: 9,  tint: '#7A5044', blurb: 'Home of a team that has not won since.' },
  goldenheights: { id: 'goldenheights', n: 'Golden Heights',      x: 806, y: 126, kit: 'gold',    unlock: 0, elev: 58, tint: '#8A7448', blurb: 'Where the money already lives.' },
};

/* ---------------- 28 LOCATIONS ----------------
   kind is implied by `acts`. `see` is the discovery rule.
   `dy` nudges the ground height off the zone base.
--------------------------------------------- */
export const LOCATIONS = [
  /* --- Rusty Row --- */
  { id: 'apartment', n: 'Your Apartment', z: 'rustyrow', x: 88, y: 556, ico: '🏚️', see: 0, kit: 'interior', tint: '#6A5744', dy: 0.5,
    hours: [0, 24], desc: 'A mattress, a folding table, and a poster of a team that loses.',
    acts: ['sleep', 'desk', 'poster', 'wardrobe'] },
  /* DISPATCH. The id stays 'trunkdepot' — it is in save files, in the
     3D placement table and in ui.js — but the name the player reads is
     "Dispatch". The TRUNK brand is untouched everywhere else (TRUNK
     Ride, Trunk Technologies, the TRUNK Delivery Fleet asset). */
  { id: 'trunkdepot', n: 'Dispatch', z: 'rustyrow', x: 198, y: 492, ico: '🚕', see: 0, kit: 'interior', tint: '#4E5666', dy: 1.2,
    hours: [6, 22], desc: 'Rideshare dispatch. The coffee is free and tastes like it.',
    acts: ['job:drive', 'job:nightdrive', 'bike'] },
  { id: 'pawnshop', n: "Vic's Pawn & Trade", z: 'rustyrow', x: 96, y: 472, ico: '🏷️', see: { stat: 'jobsDone', n: 1 }, kit: 'interior', tint: '#5E4A5C', dy: 1.8,
    hours: [9, 20], desc: 'Assets with a past. Cheaper for exactly that reason.',
    acts: ['pawn', 'bike'] },
  { id: 'noodlecart', n: 'Noodle Cart Alley', z: 'rustyrow', x: 214, y: 582, ico: '🍜', see: 0, kit: 'market', dy: -0.4,
    hours: [7, 23], desc: 'Four dollars, no questions, surprisingly good.',
    acts: ['food:4:26', 'food:9:52'] },

  /* --- Main Street --- */
  { id: 'office', n: 'Your Office', z: 'mainstreet', x: 318, y: 352, ico: '🏢', see: { office: 1 }, kit: 'interior', tint: '#6E5C48', dy: 1.0,
    hours: [0, 24], desc: 'The centre of the operation, whatever size it currently is.',
    acts: ['hub'] },
  /* see: 0 — the opening phone message tells you to meet a friend here,
     so it has to be on the map before you have done anything at all. */
  { id: 'cafe', n: 'The Bent Spoon', z: 'mainstreet', x: 392, y: 414, ico: '☕', see: 0, kit: 'interior', tint: '#7A5A42', dy: 0.2,
    hours: [6, 19], desc: 'Pastries, gossip, and a shift going spare.',
    acts: ['job:cafe', 'food:11:44'] },
  { id: 'propertyoffice', n: 'Property Office', z: 'mainstreet', x: 250, y: 414, ico: '🏘️', see: { rep: 9 }, kit: 'interior', tint: '#5C6470', dy: 0.6,
    hours: [9, 18], desc: 'Deeds, keys, and a man who sighs at paperwork.',
    acts: ['market:property'] },
  { id: 'bank', n: 'Bull Bear Mutual', z: 'mainstreet', x: 352, y: 296, ico: '🏦', see: { rep: 7 }, kit: 'learn', dy: 2.4,
    hours: [9, 17], desc: 'Marble floors. A very slow queue.',
    acts: ['bank'] },

  /* --- Learning Quarter --- */
  { id: 'school', n: 'Bull Bear Business School', z: 'learning', x: 126, y: 238, ico: '🎓', see: { stat: 'ordersDone', n: 1 }, kit: 'learn', dy: 1.5,
    hours: [8, 19], desc: 'Ten courses. Each one ends in an exam you can actually fail.',
    acts: ['school'] },
  { id: 'library', n: 'City Library', z: 'learning', x: 196, y: 308, ico: '📚', see: { rep: 5 }, kit: 'interior', tint: '#5E5240', dy: 0.8,
    hours: [8, 20], desc: 'Quiet. Free. Reputation is built here slowly.',
    acts: ['study', 'archive'] },

  /* --- Market Square --- */
  { id: 'bazaar', n: 'Culture Bazaar', z: 'marketsq', x: 406, y: 256, ico: '🎭', see: { stat: 'ordersDone', n: 1 }, kit: 'market', dy: 0.4,
    hours: [11, 21], desc: 'Sneakers, paintings, and one very loud watch dealer.',
    acts: ['market:bazaar'] },
  { id: 'broker', n: 'Business Broker', z: 'marketsq', x: 512, y: 262, ico: '🤝', see: { rep: 12 }, kit: 'interior', tint: '#6A5E48', dy: 1.1,
    hours: [9, 18], desc: 'Whole businesses, sold like second-hand cars.',
    acts: ['market:broker'] },
  { id: 'markethall', n: 'Market Hall', z: 'marketsq', x: 456, y: 346, ico: '🥘', see: { stat: 'ordersDone', n: 1 }, kit: 'market', dy: -0.3,
    hours: [7, 22], desc: 'Thirty stalls, one shared fryer.',
    acts: ['food:14:58', 'job:warehouse'] },

  /* --- Green Edge --- */
  { id: 'farm', n: "Maple's Farm", z: 'greenedge', x: 180, y: 96, ico: '🌾', see: { rep: 15 }, kit: 'farm', dy: 1.6,
    hours: [5, 19], desc: 'Good soil, broken irrigation, stubborn owner.',
    acts: ['farm'] },
  { id: 'farmcoop', n: 'Farm Cooperative', z: 'greenedge', x: 258, y: 166, ico: '🚜', see: { farm: true }, kit: 'farm', dy: 0.4,
    hours: [6, 17], desc: 'Where the valley sells what it grows.',
    acts: ['market:farmcoop'] },

  /* --- Iron Hills --- */
  { id: 'mine', n: 'Old Bull Bear Mine', z: 'ironhills', x: 436, y: 74, ico: '⛏️', see: { rep: 23 }, kit: 'mine', dy: 6.0,
    hours: [6, 18], desc: 'Closed for eleven years. The lift still works. Probably.',
    acts: ['mine'] },
  { id: 'mineral', n: 'Mineral Exchange', z: 'ironhills', x: 520, y: 150, ico: '💎', see: { mine: true }, kit: 'interior', tint: '#4E4458', dy: -3.5,
    hours: [7, 17], desc: 'Scales, loupes, and very careful handshakes.',
    acts: ['market:mineral'] },

  /* --- Waterfront --- */
  { id: 'docks', n: 'Waterfront Docks', z: 'waterfront', x: 406, y: 576, ico: '📦', see: { rep: 17 }, kit: 'water', dy: -1.4,
    hours: [5, 21], desc: 'Containers in, containers out, back permanently sore.',
    acts: ['job:warehouse', 'job:nightsort'] },
  { id: 'harbourhomes', n: 'Harbour Residences', z: 'waterfront', x: 538, y: 512, ico: '🌊', see: { rep: 20 }, kit: 'water', dy: 2.2,
    hours: [9, 19], desc: 'Balconies, salt air, and a price to match.',
    acts: ['homes'] },

  /* --- Innovation --- */
  { id: 'devlab', n: 'Trunk Technologies Lab', z: 'innovation', x: 668, y: 250, ico: '🧪', see: { rep: 26 }, kit: 'tech', dy: 1.0,
    hours: [8, 22], desc: 'Where your phone learns to hold assets.',
    acts: ['devlab'] },
  { id: 'ipooffice', n: 'Listings Office', z: 'innovation', x: 748, y: 262, ico: '📈', see: { rep: 35 }, kit: 'tech', dy: 2.0,
    hours: [9, 18], desc: 'Four companies want to go public. All four are nervous.',
    acts: ['ipo'] },
  { id: 'infra', n: 'Infrastructure Authority', z: 'innovation', x: 706, y: 364, ico: '⚡', see: { rep: 32 }, kit: 'tech', dy: -0.8,
    hours: [8, 17], desc: "Grids, bridges, ferries. The city's plumbing, for sale.",
    acts: ['market:infra'] },

  /* --- Stampede District --- */
  { id: 'stadium', n: 'Stampede Stadium', z: 'stampede', x: 718, y: 578, ico: '🏟️', see: { rep: 42 }, kit: 'stadium', dy: 0.6,
    hours: [8, 22], desc: 'Twelve thousand seats. Rust on nine thousand of them.',
    acts: ['job:cleanup', 'stampede'] },
  { id: 'stadiumoffice', n: 'Stampede Front Office', z: 'stampede', x: 806, y: 494, ico: '🎽', see: { stadium: 2 }, kit: 'interior', tint: '#7A4438', dy: 1.4,
    hours: [10, 20], desc: 'Trophies from a long time ago, dusted daily.',
    acts: ['market:stadiumoffice'] },

  /* --- Golden Heights --- */
  { id: 'exchange', n: 'Bull Bear Stock Exchange', z: 'goldenheights', x: 760, y: 80, ico: '🏛️', see: { skill: 'fundamentals' }, kit: 'gold', dy: 3.0,
    hours: [9, 16], desc: 'A trading floor that still shouts, for tradition.',
    acts: ['market:exchange'] },
  { id: 'treasury', n: 'City Treasury', z: 'goldenheights', x: 852, y: 96, ico: '🏦', see: { skill: 'fundamentals' }, kit: 'gold', dy: 1.8,
    hours: [9, 15], desc: 'Bonds. Safe, slow, and quietly the backbone of everything.',
    acts: ['market:treasury'] },
  { id: 'vance', n: 'Vance & Partners', z: 'goldenheights', x: 800, y: 184, ico: '💼', see: { rep: 62 }, kit: 'interior', tint: '#3A4050', dy: -2.5,
    hours: [8, 19], desc: 'The kind of money that never has to raise its voice.',
    acts: ['vance'] },
  { id: 'penthouse', n: 'Golden Heights Residences', z: 'goldenheights', x: 876, y: 182, ico: '🔑', see: { rep: 70 }, kit: 'gold', dy: -1.0,
    hours: [9, 19], desc: 'The top floor of the city.',
    acts: ['homes'] },
];

/* ============================================================
   THE PROJECTION — 2D map board -> 3D island.
   See the header comment. This is the only place the mapping
   is defined; everyone else reads WORLD.toWorld / loc.world.
   ============================================================ */
export const MAP = Object.freeze({ w: 1000, h: 660 });

export const WORLD = {
  units: 'metres',
  axes: '+X east, +Y up, +Z south. Right-handed (Three.js default).',
  scale: 0.9,               // metres per 2D map unit
  originMapX: 500,
  originMapY: 330,
  seaLevel: 0,
  /* Shoreline ellipse semi-axes. Sized so that the furthest-flung
     location (the apartment, in the south-west corner of Rusty Row)
     still sits ~29 m inland of the water — see tools/test-game.mjs,
     which asserts every location is on dry land. */
  islandRadiusX: 485,       // shoreline ellipse semi-axis, east-west  (970 m across)
  islandRadiusZ: 380,       // shoreline ellipse semi-axis, north-south (760 m across)
  beachWidth: 26,           // metres of sand inside the shoreline
  toWorld(mx, my) {
    return { x: (mx - WORLD.originMapX) * WORLD.scale, z: (my - WORLD.originMapY) * WORLD.scale };
  },
  toMap(wx, wz) {
    return { x: wx / WORLD.scale + WORLD.originMapX, y: wz / WORLD.scale + WORLD.originMapY };
  },
  /* Signed distance to the shoreline ellipse: <0 inland, >0 at sea. */
  shoreSDF(wx, wz) {
    const u = wx / WORLD.islandRadiusX, v = wz / WORLD.islandRadiusZ;
    return Math.hypot(u, v) - 1;
  },
};

/* footprint per kit — the world builder may scale but must not overlap */
const KIT_SIZE = {
  interior: { w: 13, d: 11, h: 9 },
  market:   { w: 17, d: 13, h: 6 },
  learn:    { w: 20, d: 16, h: 14 },
  farm:     { w: 18, d: 15, h: 8 },
  mine:     { w: 16, d: 14, h: 10 },
  water:    { w: 19, d: 14, h: 11 },
  tech:     { w: 16, d: 14, h: 16 },
  stadium:  { w: 44, d: 38, h: 22 },
  gold:     { w: 22, d: 18, h: 24 },
  rundown:  { w: 13, d: 11, h: 9 },
  city:     { w: 15, d: 13, h: 12 },
};
/* landmarks that must read from across the island */
const SIZE_OVERRIDE = {
  stadium:      { w: 62, d: 52, h: 26 },
  exchange:     { w: 26, d: 22, h: 28 },
  treasury:     { w: 22, d: 20, h: 22 },
  school:       { w: 26, d: 20, h: 17 },
  apartment:    { w: 11, d: 10, h: 12 },
  noodlecart:   { w: 8,  d: 6,  h: 4 },
  farm:         { w: 24, d: 20, h: 9 },
  mine:         { w: 20, d: 18, h: 14 },
  docks:        { w: 30, d: 18, h: 9 },
  penthouse:    { w: 20, d: 18, h: 32 },
  markethall:   { w: 26, d: 20, h: 10 },
};

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const r3 = (v) => Math.round(v * 1000) / 1000;

/* --- project the zones --- */
for (const key of Object.keys(ZONES)) {
  const z = ZONES[key];
  const p = WORLD.toWorld(z.x, z.y);
  z.world = {
    x: r3(p.x), y: z.elev, z: r3(p.z),
    min: { x: 0, z: 0 }, max: { x: 0, z: 0 }, radius: 0,
  };
  /* zone anchors face the island centre */
  z.yaw = r3(Math.atan2(-p.x, -p.z));
}

/* --- project the locations --- */
for (const l of LOCATIONS) {
  const z = ZONES[l.z];
  const p = WORLD.toWorld(l.x, l.y);
  const jitter = ((hash32(l.id) % 1000) / 1000 - 0.5) * 1.2;   // ±0.6 m, deterministic
  l.world = { x: r3(p.x), y: r3(z.elev + (l.dy || 0) + jitter), z: r3(p.z) };

  /* face the district anchor; if you ARE the anchor, face the island centre */
  let fx = z.world.x - p.x, fz = z.world.z - p.z;
  if (Math.hypot(fx, fz) < 4) { fx = -p.x; fz = -p.z; }
  l.yaw = r3(Math.atan2(fx, fz));

  const s = SIZE_OVERRIDE[l.id] || KIT_SIZE[l.kit] || KIT_SIZE.interior;
  l.size = { w: s.w, d: s.d, h: s.h };
  l.radius = r3(Math.hypot(s.w, s.d) * 0.5 + 4);
}

/* --- zone bounds from their members --- */
for (const key of Object.keys(ZONES)) {
  const z = ZONES[key];
  const mine = LOCATIONS.filter((l) => l.z === key);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const l of mine) {
    minX = Math.min(minX, l.world.x - l.radius); maxX = Math.max(maxX, l.world.x + l.radius);
    minZ = Math.min(minZ, l.world.z - l.radius); maxZ = Math.max(maxZ, l.world.z + l.radius);
  }
  const pad = 45;
  z.world.min = { x: r3(minX - pad), z: r3(minZ - pad) };
  z.world.max = { x: r3(maxX + pad), z: r3(maxZ + pad) };
  z.world.radius = r3(Math.max(60, Math.hypot(maxX - minX, maxZ - minZ) * 0.5 + pad));
  z.world.x = r3((z.world.min.x + z.world.max.x) / 2);
  z.world.z = r3((z.world.min.z + z.world.max.z) / 2);
}

export const LOC_BY_ID = {};
for (const l of LOCATIONS) LOC_BY_ID[l.id] = l;

/* ============================================================
   TRAVEL — four modes, four different currencies.

   THE TRADE-OFF EACH ONE MAKES
     WALK   trades time and energy for money. Free, always available,
            never refused — this is the floor that stops a broke,
            exhausted player from being hard-locked. See game.fares().
     BIKE   the reward for investing early. Free like walking, less
            than half the time, a third of the energy — but you have
            to OWN it (BIKE below, $180) and have it EQUIPPED.
     METRO  trades ENERGY for money. Almost free, quick, and it grinds
            Wally down: platforms, stairs, standing, crowds. Per
            MINUTE it is roughly twice as tiring as walking. No trains
            00:00–05:00.
     UBER   trades MONEY for energy and time. Always expensive, never
            cheap even for one hop, and the price climbs faster than
            the distance (a per-hop term AND a hop² surge).

   cost   = base + per·h + surge·h²
   mins   = max(3, minBase + min·h)
   energy = enBase + energy·h

   THE TABLE, at 1 / 3 / 5 / 8 hops (8 is the widest trip on the
   island — apartment to Golden Heights is 7):

     mode    1 hop            3 hops            5 hops            8 hops
     walk    $0      15m  4.2e  $0      41m 12.6e  $0      67m 21.0e  $0      106m 33.6e
     bike    $0       6m  1.5e  $0      16m  4.5e  $0      26m  7.5e  $0       41m 12.0e
     metro   $3.50    9m  5.7e  $6.50   15m 10.1e  $9.50   21m 14.5e  $14.00   30m 21.1e
     uber    $24.20   5m  0.1e  $51.80   9m  0.4e  $89.00  13m  0.8e  $162.80  19m  1.2e

   Read the columns, not the rows: walking one hop is fifteen minutes
   you did not have to pay for; the metro across town is nine dollars
   and a quarter of your day's energy; an Uber anywhere is a shift's
   pay. Money buys energy back, energy buys money back, and the bike
   quietly wins both once you have bought it.

   MODE IDS ARE STABLE. 'train' and 'trunk' keep their ids — they are
   in save files (state.travel), in ui/menus.js's icon map and in
   tools/traveltest.mjs — and only their DISPLAY names changed to
   Metro and Uber. 'walk' is promoted from a special case inside
   game.fares() to a first-class mode here. 'bike' is unchanged as an
   id but is now gated on ownership.
   ============================================================ */
export const TRAVEL = {
  walk:  { id: 'walk',  n: 'On foot', ico: '🐘', base: 0,  per: 0,   surge: 0,   minBase: 2, min: 13, enBase: 0,   energy: 4.2,  note: 'Free, always. Slow, and your legs know it.' },
  bike:  { id: 'bike',  n: 'Bicycle', ico: '🚲', base: 0,  per: 0,   surge: 0,   minBase: 1, min: 5,  enBase: 0,   energy: 1.5,  needs: 'bike', note: 'Free once it is yours. Squeaks. Worth every dollar.' },
  train: { id: 'train', n: 'Metro',   ico: '🚈', base: 2,  per: 1.5, surge: 0,   minBase: 6, min: 3,  enBase: 3.5, energy: 2.2,  hours: [5, 24], note: 'Costs almost nothing and takes it out of you. Runs 05:00–00:00.' },
  trunk: { id: 'trunk', n: 'Uber',    ico: '🚕', base: 14, per: 9,   surge: 1.2, minBase: 3, min: 2,  enBase: 0,   energy: 0.15, note: 'Door to door, no effort, and the fare grows faster than the distance.' },
};

/* THE BICYCLE — an item you buy, not a mode you are handed.
   Owning it and riding it are separate: state.bike = {owned, equipped}.
   Sold at Dispatch (a rideshare depot has beaters going spare) and at
   Vic's pawn shop — both in Rusty Row, both reachable on day one. The
   'bike' act string on those two locations is how the UI finds it. */
export const BIKE = Object.freeze({
  id: 'bike',
  n: 'Second-hand Bicycle',
  ico: '🚲',
  cost: 180,
  locs: Object.freeze(['trunkdepot', 'pawnshop']),
  desc: 'One gear, two brakes, one of which works. Halves every journey in this city and costs nothing to run.',
  line: 'It is a bicycle. It is not a good bicycle. It is, however, yours.',
});

/* distance in "hops", from the 2D map (the 3D island preserves it) */
export function hops(a, b) {
  if (a === b) return 0;
  const A = LOC_BY_ID[a], B = LOC_BY_ID[b];
  if (!A || !B) return 3;
  return Math.max(1, Math.round(Math.hypot(A.x - B.x, A.y - B.y) / 115));
}
export function fare(mode, a, b) {
  const t = TRAVEL[mode], h = hops(a, b);
  if (!t) return { cost: 0, mins: 0, energy: 0, hops: 0 };
  if (!h) return { cost: 0, mins: 0, energy: 0, hops: 0 };
  const cost = t.base + t.per * h + (t.surge || 0) * h * h;
  return {
    cost: Math.round(cost * 100) / 100,
    mins: Math.max(3, Math.round((t.minBase || 0) + t.min * h)),
    energy: +((t.enBase || 0) + t.energy * h).toFixed(1),
    hops: h,
  };
}
/* straight-line 3D walking distance, for the world module's pathing */
export function worldDistance(a, b) {
  const A = LOC_BY_ID[a], B = LOC_BY_ID[b];
  if (!A || !B) return 0;
  return Math.hypot(A.world.x - B.world.x, A.world.z - B.world.z);
}

/* ---------------- JOBS ---------------- */
export const JOBS = {
  drive:      { t: 'Drive a TRUNK shift', d: '3 hours · pays on performance', ico: '🚕', mg: 'drive',     hrs: 3, en: 16, base: 56, mult: 78 },
  nightdrive: { t: 'Night shift',         d: '4 hours · pays more, costs more', ico: '🌙', mg: 'drive',     hrs: 4, en: 26, base: 78, mult: 120, night: true },
  cafe:       { t: 'Work a café shift',   d: '3 hours · steady, friendly',    ico: '☕', mg: 'cafe',      hrs: 3, en: 14, base: 48, mult: 64 },
  warehouse:  { t: 'Sort the warehouse',  d: '3 hours · heavy, sometimes lucky', ico: '📦', mg: 'warehouse', hrs: 3, en: 20, base: 52, mult: 70 },
  nightsort:  { t: 'Night sorting',       d: '4 hours · nobody else wants it', ico: '🌃', mg: 'warehouse', hrs: 4, en: 28, base: 72, mult: 104, night: true },
  cleanup:    { t: 'Clean the stadium',   d: '3 hours · and a look around',   ico: '🧹', mg: 'cleanup',   hrs: 3, en: 18, base: 44, mult: 62 },
};

/* Where each shift is worked. Derived from the locations' own `acts`
   ("job:drive"), so the two can never drift apart — add a job to a
   location and it appears here. `loc` is the primary site; `locs` is
   everywhere it can be worked (warehouse shifts run at two places). */
for (const key of Object.keys(JOBS)) {
  const locs = LOCATIONS.filter((l) => l.acts.includes('job:' + key)).map((l) => l.id);
  JOBS[key].locs = locs;
  JOBS[key].loc = locs[0] || null;
}

/* ---------------- 10 EMPLOYEES ---------------- */
export const EMPLOYEE_POOL = [
  { id: 'pim',    n: 'Pim',    role: 'Assistant',        salary: 60,  skill: 'Adds one order slot',     line: 'I bought a plant. And another plant.' },
  { id: 'nora',   n: 'Nora',   role: 'Analyst',          salary: 110, skill: 'Shows price trends',      line: 'The chart says maybe. Charts always say maybe.' },
  { id: 'gus',    n: 'Gus',    role: 'Client manager',   salary: 130, skill: '+1 client trust weekly',  line: 'I remember every birthday. It is my whole thing.' },
  { id: 'tilda',  n: 'Tilda',  role: 'Farm manager',     salary: 120, skill: 'Farm produces daily',     line: 'The cows respect me. That took eleven months.' },
  { id: 'bruno',  n: 'Bruno',  role: 'Mine supervisor',  salary: 140, skill: 'Mine produces daily',     line: 'Safety first. Then rocks. Then more safety.' },
  { id: 'sable',  n: 'Sable',  role: 'Property manager', salary: 150, skill: 'Property pays rent',      line: 'Unit 4B has a raccoon. Unit 4B has always had a raccoon.' },
  { id: 'kite',   n: 'Kite',   role: 'Software engineer',salary: 200, skill: 'Required for Wally Swap', line: 'It works on my machine. My machine is very forgiving.' },
  { id: 'orla',   n: 'Orla',   role: 'Legal specialist', salary: 190, skill: 'Cheaper tokenization',    line: 'I read the fine print. All of it. I have seen things.' },
  { id: 'mattie', n: 'Mattie', role: 'Fund specialist',  salary: 210, skill: '+1 fund capacity',        line: 'A basket is just a promise with structure.' },
  { id: 'reg',    n: 'Reg',    role: 'Driver',           salary: 90,  skill: 'Free city travel',        line: 'I know a shortcut. It is longer, but nicer.' },
];
export const EMPLOYEE_BY_ID = {};
for (const e of EMPLOYEE_POOL) EMPLOYEE_BY_ID[e.id] = e;

/* ---------------- 4 IPOs ---------------- */
export const IPOS = [
  { id: 'trnk', n: 'Trunk Technologies', client: 'bolt',    cost: 6000, price: 42, story: 'The ride-share company that once paid you $9 an hour wants to go public.' },
  { id: 'wflw', n: 'WaffleWorks',        client: 'sunny',   cost: 2600, price: 12, story: 'One stand. Two waffle irons. One dream, slightly burnt at the edges.' },
  { id: 'orbt', n: 'Orchard Robotics',   client: 'maple',   cost: 9000, price: 46, story: 'A farm inventor with 40 patents and no accounting whatsoever.' },
  { id: 'stmd', n: 'Stampede Media',     client: 'thunder', cost: 4200, price: 19, story: 'A sports blog written in a stadium storage cupboard.' },
];
export const IPO_STEPS = [
  { t: 'Due diligence',     d: 'Go through the books properly.',    mg: 'inspect' },
  { t: 'Valuation',         d: 'Decide what the company is worth.', mg: 'valuation' },
  { t: 'Regulatory filing', d: 'Every form, in the right order.',   mg: 'documents' },
  { t: 'Investor roadshow', d: 'Convince a room full of sceptics.', mg: 'pitch' },
  { t: 'Listing day',       d: 'Open the book and set the price.',  mg: 'auction' },
];

/* ---------------- THE 10-STEP STADIUM QUESTLINE ---------------- */
export const STADIUM_STEPS = [
  { t: "Review the team's problems",     d: 'Coach Thunder shows you the books. They are damp.', cost: 0,     mg: 'cleanup' },
  { t: 'Restore the stadium',            d: 'Repair mini-game. Bring money.',                    cost: 18000, mg: 'restore' },
  { t: 'Tokenize the media rights',      d: 'Own and tokenize Stampede Media Rights.',           cost: 0,     mg: 'negotiate' },
  { t: 'Tokenize the concessions',       d: 'Own and tokenize Stadium Concessions.',             cost: 0,     mg: 'pitch' },
  { t: 'Develop the youth academy',      d: 'Own and tokenize the Youth Academy.',               cost: 0,     mg: 'valuation' },
  { t: 'Create the Supporter Fund',      d: 'A fund the whole city can hold a piece of.',        cost: 12000, mg: 'documents' },
  { t: 'Win the fan vote',               d: 'Persuasion mini-game in front of 400 people.',      cost: 0,     mg: 'fanvote' },
  { t: 'Negotiate with ownership',       d: 'The hardest negotiation of your life.',             cost: 0,     mg: 'fundasm' },
  { t: 'Assemble the client group',      d: 'You need eight trusted clients behind you.',        cost: 0,     mg: 'pitch' },
  { t: 'Tokenize the Bull Bear Stampede',d: 'Launch the team token. Give it back to the city.',  cost: 60000, mg: 'fanvote' },
];

/* ---------------- NEWS ---------------- */
export const NEWS_POOL = [
  { h: 'Waffle shortage grips downtown',      t: 'Lines around the block. WaffleWorks up.',              a: 'wflw',    e: 0.14 },
  { h: 'CloudTusk data centre hums louder',   t: 'Nobody knows what it does. Everyone wants it.',        a: 'ctsk',    e: 0.10 },
  { h: 'Rain floods the ferry ramp',          t: 'Harbour operations delayed a full day.',               a: 'ferry',   e: -0.11 },
  { h: 'Strawberry festival announced',       t: 'Green Edge expects record visitors.',                  a: 'straw',   e: 0.18 },
  { h: 'Copper theft at the ore yard',        t: 'Two spools and a very confused raccoon.',              a: 'copper',  e: -0.09 },
  { h: 'Stampede loses again, 4–1',           t: 'The mood in the stands is described as "damp".',       a: 'stmd',    e: -0.13 },
  { h: 'Stampede wins in overtime!',          t: 'The stands are described as "briefly loud".',          a: 'stmd',    e: 0.16 },
  { h: 'Mayor promises new bridge paint',     t: 'Colour to be decided by committee.',                   a: 'bridge',  e: 0.07 },
  { h: 'Gold assay comes back strong',        t: 'Goldie says he "always knew". He did not.',            a: 'gold',    e: 0.15 },
  { h: 'Bank raises the city note rate',      t: 'Savers rejoice. Borrowers do not.',                    a: 'bond3m',  e: 0.05 },
  { h: 'Gallery opening draws a crowd',       t: 'Somebody bought the fire extinguisher.',               a: 'gallery', e: 0.13 },
  { h: 'Trunk drivers demand better logo',    t: '"Too elephant-focused," says the union.',              a: 'trnk',    e: -0.08 },
  { h: 'Orchard Robotics unit escapes',       t: 'It picked every apple on Main Street. Efficiently.',   a: 'orbt',    e: 0.12 },
  { h: 'Storm knocks out the fiber ring',     t: 'Innovation District briefly returns to 2003.',         a: 'fiber',   e: -0.10 },
  { h: 'Wind ridge sets output record',       t: 'It was, in fairness, extremely windy.',                a: 'wind',    e: 0.11 },
  { h: 'Hotel occupancy hits new low',        t: 'Nadia has stopped answering the phone.',               a: 'czbr',    e: -0.12 },
  { h: 'City museum finds a second basement', t: 'Contents: crates. Contents of crates: unclear.',       a: 'museum',  e: 0.14 },
  { h: 'Bee swarm relocates to City Hall',    t: 'Honey production up. Council meetings down.',          a: 'honey',   e: 0.12 },
];

export const WALLYNET_GOOD = [
  'Small elephant delivered on time. Shocking behaviour for this city.',
  'He explained a bond to me using a sandwich. I get it now.',
  'Wally showed up on a squeaky bicycle and still closed the deal.',
  '10/10 would let this elephant manage my money again.',
  'Asked for one token. Got one token. Revolutionary.',
];
export const WALLYNET_BAD = [
  'Waited all week. Nothing. The elephant has no memory, apparently.',
  'Missed my deadline. My retirement is now a hobby.',
  'He said "soon". It has been extremely not-soon.',
  'Zero stars. The bicycle squeaked through my entire meeting.',
];

/* ---------------- STORY QUESTS ----------------
   check(S) returns true when the step is satisfied.
   `loc` is where the objective marker goes ('office' resolves to the
   apartment desk until you rent a real one).
--------------------------------------------- */
export const QUESTS = [
  /* ACT 1, THE OPENING, in the order the player lives it:
       1  read the phone            (Otto's welcome; Happy is met on the way out)
       2  work a shift at Dispatch  (the flag is set by actions.work)
       3  take your first client order — which does not exist until 2 is done
     The cafe beat sits ALONGSIDE this chain as a side quest and never
     touches the objective strip. See SIDE_QUESTS below. */
  { id: 'q_wake', act: 1, loc: 'apartment', t: 'Read the message from your friend', d: 'Open the phone and read Messages.', hint: 'Press P',
    check: (S) => !!S.flags.readMentor, rep: 1, money: 0 },
  { id: 'q_first_job', act: 1, loc: 'trunkdepot', t: 'Work a shift at Dispatch', d: 'Rideshare dispatch in Rusty Row is short of drivers.', hint: 'Dispatch',
    check: (S) => !!S.flags.dispatchShift, rep: 2, money: 0 },
  { id: 'q_first_client', act: 1, loc: 'office', t: 'Take your first client order', d: 'A shift at Dispatch put your name about. Someone will come to your desk.', hint: 'Your desk',
    check: (S) => S.orders.length > 0 || S.stats.ordersDone >= 1, rep: 2, money: 0 },
  { id: 'q_first_fee', act: 1, loc: 'office', t: 'Complete an order at your desk', d: 'Buy what the client asked for, then deliver it from your apartment desk.', hint: "Wally's Apartment",
    check: (S) => S.stats.ordersDone >= 1, rep: 4, money: 60 },
  { id: 'q_first_course', act: 1, loc: 'school', t: 'Take a class at the School of Assets', d: 'The Learning Quarter is north of Main Street.', hint: 'Business School',
    check: (S) => Object.keys(S.skills).length >= 1, rep: 4, money: 0 },
  { id: 'q_first_token', act: 1, loc: 'bazaar', t: 'Tokenize your first asset', d: 'Own something, then tokenize it at your desk.', hint: 'Desk → Tokenize',
    check: (S) => S.stats.tokenized >= 1, rep: 8, money: 120 },
  { id: 'q_shared', act: 2, loc: 'office', t: 'Upgrade to the Shared Desk', d: '$1,200 and 12 reputation gets you off the folding table.', hint: 'Office → Upgrade',
    check: (S) => S.office >= 1, rep: 6, money: 0 },
  { id: 'q_treasury', act: 2, loc: 'library', t: 'Unlock the City Treasury', d: 'Pass the bond auction paperwork at the City Library archive.', hint: 'City Library',
    check: (S) => !!S.unlocks.treasury, rep: 6, money: 0 },
  { id: 'q_maple', act: 2, loc: 'farm', t: 'Meet Auntie Maple at the farm', d: 'Green Edge, west of the Learning Quarter.', hint: "Maple's Farm",
    check: (S) => !!(S.clients.maple && S.clients.maple.met), rep: 4, money: 0 },
  { id: 'q_farm', act: 2, loc: 'farm', t: 'Partner on Maple Farm', d: 'Fix the irrigation, then buy in.', hint: "Maple's Farm",
    check: (S) => !!S.farm.owned, rep: 10, money: 0 },
  { id: 'q_fund', act: 2, loc: 'office', t: 'Build your first client fund', d: 'Take Fund Construction, then assemble a basket at the office.', hint: 'Office → Funds',
    check: (S) => S.funds.length >= 1, rep: 10, money: 200 },
  { id: 'q_exchange', act: 3, loc: 'exchange', t: 'Unlock the Stock Exchange', d: 'Market Fundamentals class, trader badge exam, access fee.', hint: 'Stock Exchange',
    check: (S) => !!S.unlocks.exchange, rep: 12, money: 0 },
  { id: 'q_mine', act: 3, loc: 'mine', t: 'Reopen the Old Bull Bear Mine', d: 'Goldie has the records. The elevator has opinions.', hint: 'Old Bull Bear Mine',
    check: (S) => !!S.mine.owned, rep: 14, money: 0 },
  { id: 'q_ipo', act: 3, loc: 'ipooffice', t: 'Take a company public', d: 'The Listings Office in the Innovation District runs four listings.', hint: 'Listings Office',
    check: (S) => S.stats.ipos >= 1, rep: 20, money: 1500 },
  { id: 'q_hq', act: 4, loc: 'office', t: 'Open a Professional Office', d: 'Stage 3. Departments, conference room, research terminal.', hint: 'Office',
    check: (S) => S.office >= 3, rep: 14, money: 0 },
  { id: 'q_hire', act: 4, loc: 'office', t: 'Hire your first employee', d: 'You cannot do all of this on a bicycle forever.', hint: 'Office → Team',
    check: (S) => S.employees.length >= 1, rep: 8, money: 0 },
  { id: 'q_swap', act: 4, loc: 'devlab', t: 'Launch Wally Swap', d: 'Advanced Market Systems, a dev partnership, and a lot of money.', hint: 'Dev Lab',
    check: (S) => !!S.unlocks.swap, rep: 25, money: 0 },
  { id: 'q_golden', act: 4, loc: 'exchange', t: 'Get into Golden Heights', d: 'Reputation 60 opens the gate.', hint: 'Golden Heights',
    check: (S) => !!S.visited.goldenheights, rep: 10, money: 0 },
  { id: 'q_stadium', act: 5, loc: 'stadium', t: 'Answer Coach Thunder', d: 'The Stampede are one bad season from leaving.', hint: 'Stampede Stadium',
    check: (S) => S.stadium.step >= 1, rep: 10, money: 0 },
  { id: 'q_team', act: 5, loc: 'stadium', t: 'Tokenize the Bull Bear Stampede', d: 'Restore, tokenize, and give the team back to the city.', hint: 'Stampede Stadium',
    check: (S) => !!S.tokenized.stampede, rep: 60, money: 0 },
  { id: 'q_pent', act: 5, loc: 'penthouse', t: 'Buy the Golden Heights Penthouse', d: 'The most expensive apartment in Bull Bear City.', hint: 'Penthouse Sales',
    check: (S) => S.home === 'penthouse', rep: 30, money: 0 },
  { id: 'q_all', act: 5, loc: 'office', t: 'Own all 69 assets', d: 'One unit or one fraction of every single thing in this city.', hint: 'Everywhere',
    check: (S) => Object.keys(S.inv).filter((k) => S.inv[k].qty > 0).length >= CONFIG.totalAssets, rep: 100, money: 0 },
  { id: 'q_city', act: 5, loc: 'office', t: 'Reach 100% City Tokenized', d: 'Every asset, tokenized. The whole city, connected.', hint: 'Everywhere',
    check: (S) => Object.keys(S.tokenized).length >= CONFIG.totalAssets, rep: 150, money: 0 },
];
export const QUEST_BY_ID = {};
for (const q of QUESTS) QUEST_BY_ID[q.id] = q;

/* ---------------- SIDE QUESTS ----------------
   A SEPARATE LIST ON PURPOSE. quests.current() walks QUESTS and only
   QUESTS, so the HUD objective strip can never be hijacked by a side
   errand — which is the whole reason this list exists. Side quests
   are dormant until something starts one (quests.startSide(id)); the
   UI reads them through quests.sideCurrent() / quests.sides().

   Same shape as a main quest, plus `side: true` and `from`, the
   person who asked.
--------------------------------------------- */
export const SIDE_QUESTS = [
  { id: 'q_side_otto', side: true, act: 1, loc: 'office', from: 'otto',
    t: "Fill Otto's order", d: 'He asked for one thing over coffee. Buy it, bring it to your desk.',
    hint: 'Your desk',
    check: (S) => !!(S.clients.otto && S.clients.otto.done >= 1), rep: 3, money: 40 },
];
export const SIDE_QUEST_BY_ID = {};
for (const q of SIDE_QUESTS) SIDE_QUEST_BY_ID[q.id] = q;

/* ---------------- THE OPENING MESSAGE ----------------
   On the phone the moment the game starts. Otto has run the Pixel
   Palace arcade in Rusty Row for years; Wally has just moved back.
   Cloned into state.msgs by newState() — never pushed by reference,
   because this table is deep-frozen and `read` has to be writable.
--------------------------------------------- */
export const OPENING_MESSAGE = Object.freeze({
  from: 'Otto',
  text: 'WALLY. You actually came back. Welcome to Bull Bear City, which is louder and broker than you left it and is now, unfortunately, yours as well. '
      + 'When you have put the mattress down, come and find me at the Bent Spoon on Main Street — the coffee is bad in a way I have grown to respect. '
      + "I am buying, and I will not be saying that again. There is also a small thing I could use your help with. Small. Bring the sunglasses.",
});

/* ---------------- TOKENIZATION MILESTONES ---------------- */
export const MILESTONES = [
  { p: 5,   t: 'A shared desk is within reach',    from: 'Main Street Lofts', msg: 'A desk opened up. $1,200.' },
  { p: 10,  t: 'Green Edge is waking up',          from: 'Auntie Maple',      msg: 'The valley looks better. Come and see.' },
  { p: 20,  t: 'The Treasury takes you seriously', from: 'Treasury Clerk',    msg: 'Your file has been upgraded. Faintly.' },
  { p: 30,  t: 'The Exchange knows your name',     from: 'Mr. Ledger',        msg: 'Membership mentioned you. Favourably, even.' },
  { p: 40,  t: 'Iron Hills is humming',            from: 'Goldie',            msg: 'The hills are loud again, Wally.' },
  { p: 50,  t: 'Half the city',                    from: 'Mayor Tusk',        msg: 'Half! I have ordered a ribbon. Do not ask what it cost.' },
  { p: 60,  t: 'The Waterfront lights up',         from: 'Pearl',             msg: 'Boats. Actual boats. That was you.' },
  { p: 70,  t: 'The Wally Swap era',               from: 'Kite',              msg: "It works on everyone's machine now. Terrifying." },
  { p: 80,  t: 'Institutional money arrives',      from: 'Silas Vance',       msg: 'Slowly, then all at once. Come and see me.' },
  { p: 90,  t: 'The Stampede need you',            from: 'Coach Thunder',     msg: 'It is time.' },
  { p: 100, t: 'BULL BEAR CITY IS WHOLE',          from: 'The City',          msg: 'Every asset, connected. Thank you, Wally.', endgame: true },
];

/* ---------------- ONE-TIME TIPS ---------------- */
export const TIPS = {
  map:      { t: 'Getting around', d: 'Four ways across town, and each one charges you differently. Walking is free and always available — it costs you the morning. The Metro costs pennies and costs energy. An Uber costs a shift’s pay and costs you nothing else.' },
  bike:     { t: 'Buy a bicycle',  d: 'A second-hand bike is $180 at Dispatch or Vic’s. Half the time of walking, a third of the energy, free forever after. It is the best money you will spend this week.' },
  ticker:   { t: 'Tickers',        d: 'Every asset in the city has a symbol — GOLD, WHEAT, B5Y, TEAM. Orders are written in them, and you can search by symbol or by name.' },
  office:   { t: 'Your office',    d: 'This is your desk. Clients turn up here through the day with a job, a budget and a deadline. Take the ones you can actually finish.' },
  order:    { t: 'Filling an order', d: 'You have an order. Travel to wherever that asset is sold, buy it, then come back here and deliver.' },
  hours:    { t: 'Opening hours',  d: 'Places open and close. Check Phone → Places if you are not sure whether it is worth the fare.' },
  hunger:   { t: 'Looking after Wally', d: 'Eating and sleeping are not optional. A cheap bowl at the noodle cart resets most of a bad morning.' },
  tokenize: { t: 'Tokenizing',     d: 'Tokenizing splits something you own into pieces anyone can hold. It is how the city gets connected — and how you reach 100%.' },
};

/* ---------------- MORNING NOTES ---------------- */
export const MORNING_NOTES = [
  { day: 2,  from: 'Otto',          msg: 'Second day. The city has not noticed you. That is normal — keep going.' },
  { day: 4,  from: 'Marcus Grimm',  msg: 'Rent, Wally. It is not personal, it is a business model.' },
  { day: 9,  from: 'Otto',          msg: 'Still the folding table? Good. Everyone starts there.', when: (S) => S.office === 0 },
  { day: 15, from: 'Fenn',          msg: 'Is the Exchange hard to get into? Asking for a friend. It is me.', when: (S) => !S.unlocks.exchange },
];

/* ---------------- freeze ---------------- */
function deepFreeze(o) {
  if (o && (typeof o === 'object' || typeof o === 'function') && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.getOwnPropertyNames(o)) {
      const v = o[k];
      if (v && (typeof v === 'object' || typeof v === 'function')) deepFreeze(v);
    }
  }
  return o;
}

export const DATA = deepFreeze({
  config: CONFIG,
  categories: CATEGORIES,
  assets: ASSETS, assetById: ASSET_BY_ID, assetByTick: ASSET_BY_TICK,
  byTicker, assetIdOf, assetLabel, tickerQty, searchAssets, normTicker,
  venues: VENUES, venueLoc: VENUE_LOC,
  clients: CLIENTS, clientById: CLIENT_BY_ID,
  courses: COURSES, courseById: COURSE_BY_ID,
  offices: OFFICE_STAGES,
  homes: HOMES, homeById: HOME_BY_ID,
  zones: ZONES,
  locations: LOCATIONS, locationById: LOC_BY_ID,
  map: MAP, world: WORLD,
  travel: TRAVEL, bike: BIKE,
  jobs: JOBS,
  employees: EMPLOYEE_POOL, employeeById: EMPLOYEE_BY_ID,
  ipos: IPOS, ipoSteps: IPO_STEPS,
  stadiumSteps: STADIUM_STEPS,
  news: NEWS_POOL,
  wallynetGood: WALLYNET_GOOD, wallynetBad: WALLYNET_BAD,
  quests: QUESTS, questById: QUEST_BY_ID,
  sideQuests: SIDE_QUESTS, sideQuestById: SIDE_QUEST_BY_ID,
  openingMessage: OPENING_MESSAGE,
  milestones: MILESTONES,
  tips: TIPS,
  morningNotes: MORNING_NOTES,
  hops, fare, worldDistance,
});

export default DATA;
