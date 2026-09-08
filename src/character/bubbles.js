/* ============================================================
   bubbles.js — what the city says as it walks past you.

   Bull Bear City had four hundred people in it and not one of them
   ever opened their mouth. This is the ambient half of that: short
   overheard lines — market chatter, a bullish take, a bearish one,
   gossip, a complaint about rent — floating over the heads of people
   who are going somewhere else. The player is a trader, so the
   background noise of the place is the economy, and the lines name
   real tickers and real streets so the world and the market read as
   the same object.

   FOUR THINGS IT HAS TO BE, in the order they were designed for.

   READABLE AT A GLANCE. Two lines of text, ~48 characters, drawn once
   into a canvas at a fixed pixel size and shown as a camera-facing
   sprite whose WORLD size is derived from that pixel size — so a
   letter is 0.20 m tall in the city no matter how long the line is. A
   bubble that has to be studied is a bubble that stops the game.

   NEVER SPAM. Nothing appears within `GAP` seconds of the last one,
   there are at most `MAX_LIVE` on screen at once, and a person who has
   just spoken will not speak again for a minute. The pool is small on
   purpose: a crowd where everybody is talking is not a crowd, it is a
   chorus.

   NEVER A MESS. Before a line is granted, its speaker is projected to
   screen space and rejected if the card it would draw would touch a
   card that is already up — compared as PROJECTED half-widths, not as
   a fixed pixel gap, because a bubble is a fixed size in metres and is
   four hundred pixels wide at six metres and a hundred and twenty at
   twenty. That is the whole overlap rule, it costs two matrix
   multiplies per candidate, and it is why two people passing each
   other never talk over one another.

   CHEAP ENOUGH FOR A CROWD. `POOL` sprites, each with ONE canvas and
   ONE texture, allocated at construction and reused forever. Showing a
   line is a canvas redraw and a texture upload of a 344x178 RGBA —
   about 245 kB, a fraction of a millisecond, and it happens at most
   once every couple of seconds. Per frame the cost is POOL position
   writes and an opacity ramp; nothing is allocated, nothing is
   uploaded, and a hundred silent pedestrians cost exactly zero.

   WHAT IT DOES NOT OWN. It does not decide WHEN the Mayor's scooter
   hint may fire — the rules layer owns that (game.race.hint(), bus
   'race' {kind:'hint'}) and npc.js listens for it. This file draws
   bubbles and holds the line pool. Nothing else.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BRAND, SHADOW, css } from '../core/palette.js';
import { clamp, damp } from '../core/contracts.js';
/* STATIC DATA ONLY, and the same import npc.js already takes. Nothing
   in this file reaches a subsystem; the live board arrives on ctx. */
import { ASSET_BY_TICK } from '../game/data.js';

/* ==================================================================
   1. THE LINES

   House voice: dry, affectionate, understated. Nobody in this city
   shouts and nobody explains a joke. A line is one thought long, it
   sounds like half of a conversation you are walking past, and where
   it can it names something the player can actually go and look at —
   a ticker off the board, a street, a shopfront — so that the economy
   and the map are plainly the same place.

   THE BEST PROPERTY OF THESE LINES IS THAT YOU CAN GO AND CHECK ONE,
   AND THAT IS ALSO HOW THEY FAIL. A claim the player can verify can
   be WRONG, and a wrong one costs more than a bland one because the
   player did the work of walking over to look.

   Eleven lines quoted a price as a typed number. Not one of them was
   ever true: state.js seeds day 1 at `a.v * (0.94 + rng() * 0.12)`, so
   a fresh save already disagrees with every one of them by up to six
   per cent before the first daily roll moves it again. "CTSK at
   eighty-eight" was a sentence about data.js, not about the board the
   player reads.

   SO A PRICE IS NOW A SLOT, NEVER A TYPED NUMBER. `{CTSK}` is filled
   at the moment the line is spoken from the same `economy.price()` and
   the same `economy.fmt()` the market screen prints, so the number in
   the bubble is character-for-character the number on the board and is
   true by construction rather than true by a proofreader.

   AND A LINE WHOSE NUMBER CANNOT BE READ IS NOT SAID. npc.js builds
   the bubbles before game.js exists; in that window, and in any rig
   that boots without a rules layer, a slot line is simply not offered
   (see fromGroup). It is never spoken with a hole in it and never
   falls back to the base value, because the base value is the wrong
   number this whole mechanism exists to stop quoting.
   ================================================================== */

/* THE LIVE BOARD. One function, `(ticker) -> formatted string | null`,
   registered by createBubbles() from ctx. Module-level because there
   is exactly one economy per page and the picker is constructed in
   npc.js, which has no business knowing about prices. */
let _board = null;

/** Register the live board. `null` unregisters and mutes every slot
    line. Returns the function actually installed. */
export function setPriceBoard(fn) {
  _board = typeof fn === 'function' ? fn : null;
  return _board;
}

/** Does this line quote the board? Cheap enough for the picker's
    inner loop, which is why it is an indexOf and not the regex. */
export const hasSlot = (line) => line.indexOf('{') >= 0;

const SLOT_RE = /\{([A-Z][A-Z0-9]{1,5})\}/g;

/** Every ticker a line quotes, in order. `[]` for most lines. */
export function slotTickers(line) {
  const out = [];
  if (!hasSlot(line)) return out;
  SLOT_RE.lastIndex = 0;
  let m;
  while ((m = SLOT_RE.exec(line))) out.push(m[1]);
  return out;
}

/**
 * Fill a line's price slots from the board.
 * @returns {string|null} the spoken line, or NULL if any slot could
 *   not be priced — the caller must then not say it. Returning the
 *   template, or the base value, are both ways of shipping the bug.
 */
export function fillPrices(line, board = _board) {
  if (!hasSlot(line)) return line;
  if (!board) return null;
  let ok = true;
  const out = line.replace(SLOT_RE, (m, tick) => {
    let v = null;
    try { v = board(tick); } catch (e) { v = null; }
    if (v === null || v === undefined || v === '') { ok = false; return m; }
    return String(v);
  });
  return ok ? out : null;
}

/** The widest a slot can ever render: economy.clampPrice() caps the
    board at 2.7x the base value, so this is the worst case a layout
    check has to survive. Used by measure() and by tools/voicetest.mjs
    — a fit test run against `{PTWR}` measures seven characters of
    braces instead of the six digits the player will actually read. */
export function widestFill(line) {
  return line.replace(SLOT_RE, (m, tick) => {
    const a = ASSET_BY_TICK[tick];
    if (!a) return m;
    const n = Math.round(a.v * 2.7);
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  });
}

/** Bullish. Cheerful, over-confident, occasionally correct. */
export const BULL_LINES = [
  'TRNK up again. I said it. Note that.',
  'CTSK at {CTSK} and still buying.',
  'BrightGrid wired all of Iron Hills.',
  'MMTR got the depot contract. Told you.',
  'Everyone laughed at WaffleWorks. Not now.',
  'GOLD has had a run. My uncle is thrilled.',
  'BERRY. Buy the field, not the jam.',
  'Main Street property only goes one way.',
  'Bought HERD in the spring. Cows always come back.',
  'Stampede won at home. STMD has a good week.',
  'Orchard are hiring. Nobody hires going down.',
  'HONEY is thin on the board. I have four hives.',
  'Bull Bear Mutual raised the deposit rate.',
  'BGRD pays a dividend. A real one. In money.',
  'ORBT sold nine pickers to Green Edge. Nine.',
  /* THE SAME TRUE FACT IN TWO MOUTHS, and the joke is entirely in
     which number each of them stops at. ORBT sold nine pickers and
     built four hundred: the bull says nine, the bear says four
     hundred, neither is lying, and the pair is funnier than either
     line alone because the player hears both within a walk. Three
     more of these, each grounded in a fact the player can go and read
     — LOCATIONS.stadium ("Twelve thousand seats. Rust on nine
     thousand of them."), LOCATIONS.markethall ("Thirty stalls, one
     shared fryer."), and B10Y, whose cpn is 7 and whose term is 10.
     The bear halves are in BEAR_LINES, in the same order. */
  'Twelve thousand seats. Twelve thousand.',
  'Thirty stalls in Market Hall. All thirty pay.',
  'B10Y pays seven per cent for ten years. Seven.',
  'RVRN moved the whole harvest and nobody noticed.',
  'WHEAT is cheap. August was wet. August ends.',
  'I hold CRUMB and I eat there. That is research.',
  'PIXEL is up and Otto has not raised a price yet.',
  'SOLAR, on a field that grew nothing for nine years.',
  'B5Y pays three point two. Boring is a strategy.',
  'APPLE every autumn. You can set a watch by it.',
  'NRTH has an order book out to spring.',
  'CZBR is full every weekend. Go and look.',
  'TIMBR does not care what the Mayor says.',
  'Bought FLEET before the contract. Lucky? Sure.',
  'STATN is the station. There is not another.',
  'LNTR opened a third shop. A third one.',
  'YOUTH is the only thing at that club worth owning.',
  'BRDG takes a toll whatever else happens.',
  'WATER. People drink in a downturn as well.',
  'MUSIC is a catalogue. It never turns up to work.',
  'GALRY has doubled. The painting is still ugly.',
];

/** Bearish. Weary, specific, right often enough to be irritating. */
export const BEAR_LINES = [
  'CTSK at {CTSK} is a story, not a firm.',
  'Trunk have never shipped in the quarter.',
  'Sold STMD. They lose at home as well.',
  'Golden Heights is priced for a bigger city.',
  'PBMB: a phone nobody wants. Ask them why.',
  'The Exchange is shut to me. Funny, that.',
  'GEMS at {GEMS}. For a rock. In a bag.',
  'BRBM builds scaffolding and press releases.',
  'Lovely tower view. Of a crane that never moves.',
  'The Farm index is one bad August from a haircut.',
  'Copper is down and Iron Hills has gone quiet.',
  'Two years of ACRN. Two years of tinned hope.',
  'A ten-year Restoration Bond. Restoring what?',
  'Anyone looks clever in a bull market.',
  'ORBT sold nine pickers. They built four hundred.',
  /* the other halves — see the note in BULL_LINES. The third pair's
     bear half is already below: 'B10Y locks it away for ten years.
     Ten.' The bull stops at the coupon, the bear at the term. */
  'Twelve thousand seats. Nine thousand rust.',
  'Thirty stalls in Market Hall. One shared fryer.',
  'CZBR is full in August and empty in February.',
  'FIBER is a hole in the ground with a prospectus.',
  'WATCH at {WATCH}. It does not even keep time.',
  'FILM royalties. From a film. You have not seen it.',
  'B10Y locks it away for ten years. Ten.',
  'LNTR opened a third shop and shut the first.',
  'MUSEM. Somebody has to insure all that.',
  'BRDG is a toll bridge with a crack in it.',
  'INN was full last week. Ask me about this week.',
  'PLUXE at {PLUXE} and the lift is out again.',
  'CONCS sells hot dogs at a stadium that loses.',
  'RICO is one chef. That is the whole business.',
  'SNEAK. You are buying somebody else’s feet.',
  'They renamed the depot Dispatch. Same coffee.',
  'WFLW is {WFLW}. There is a reason it is {WFLW}.',
  'Everybody owns HERD and nobody owns a field.',
  'The Listings Office has a queue. That is the tell.',
  'PIXEL is fine until the arcade needs a roof.',
];

/** The city talking about itself. Gossip, rent, the mayor, the weather. */
export const STREET_LINES = [
  'Rent is up again on Rusty Row. For weather.',
  'The Bent Spoon put the coffee up. Beans, Dot says.',
  'Mayor Ken Jones opened something. Again.',
  'Barnaby has driven Route 6 for thirty years.',
  'They dug up Market Square. Put it back the same.',
  'Two coffees, one person, and he is still waiting.',
  'The library wants its book back. Since March.',
  'Every student wants to be a trader now.',
  'That office block has been to let for a year.',
  'Someone left a scooter behind Dispatch.',
  'Auntie Maple brought marrows. Everyone has one.',
  'Crane crews go out over the third shift. So does the crane.',
  'Coach Thunder has been shouting since I was at school.',
  'The Mayor has opened the toll bridge twice now.',
  'Somebody keeps moving the bench outside the bank.',
  'Nobody knows this city like Dot does. Nobody.',
  'The clocktower has not moved a hand in nine years.',
  'They painted the railings. Only the front ones.',
  'Route 6 has a new driver and it is not the same.',
  'My landlord calls it a period feature. It is a draught.',
  'There is a cat at the Bent Spoon that pays no rent.',
  'Bin day is Tuesday. It never is.',
  'A man was out measuring the road again this morning.',
  'Vic will buy anything and pay for none of it.',
  'They put a sign up. You cannot read it from the road.',
  'The Mayor was on the radio. About parking.',
  'My cousin got into the Business School. Second go.',
  'Coach Thunder shouted at a gull last week. It left.',
  'The mine shut eleven years ago. Everybody goes in.',
  'The Treasury has bronze doors and one working pen.',
  'Auntie Maple sent soup down to the pawn shop again.',
  'The library has a leak over the good chairs.',
  'Somebody is feeding the harbour gulls. Stop it.',
  'They are putting flags up. Something is being opened.',
  'The bus is late and the timetable is a suggestion.',
];

/* ==================================================================
   1b. THE LINES THAT ONLY FIT SOMEWHERE

   Everything above can be said anywhere, by anyone, at any hour. What
   follows cannot, and that is the whole point of it: a fisherman on
   the dock and a student in the Learning Quarter were drawing from one
   flat list, so they said the same sentence and the city stopped
   sounding like ten places.

   THE RULE THESE WERE WRITTEN UNDER. A conditional line has to be
   MORE right in its condition than any general line would be, and it
   has to be impossible to hear it in the wrong one. So the tags are
   coarse and few — where you are standing, roughly what time it is,
   whether it is actually raining ON YOU, how much of the city is in
   pieces, whether anyone knows your name, and whether you are
   currently doing something worth looking at. Nothing here keys off
   anything a player cannot see out of their own eyes.
   ================================================================== */

/** By district. The speaker's own district, not the player's — a
    person standing ten metres over the Rusty Row line does not have
    Golden Heights opinions. Keyed by ZONES id in game/data.js. */
export const DISTRICT_LINES = {
  rustyrow: [
    'Vic gave me eleven for a watch he sold me for ninety.',
    'The pipes sing at four. You get used to the tune.',
    'Dispatch coffee is free. That is the whole review.',
    'Noodle Cart Alley does not ask what kind of week it was.',
    'PFLAT is worth more than anyone here can sell it for.',
    'Otto keeps the arcade open late. For the kids.',
    'Three landlords here. One name on the paperwork.',
    'Ask Barnaby about the bridge. Bring a chair.',
  ],
  mainstreet: [
    'Dot knows what you want before you are through the door.',
    'The queue at Bull Bear Mutual is a marble tradition.',
    'The Property Office man sighed. That means yes.',
    'PSHOP is {PSHOP}. For a doorway.',
    'The Bent Spoon has a shift going spare. It always has.',
    'Everything on this street is fine. Ask anyone. Fine.',
    'Two coats of paint on that shopfront and no tenant.',
  ],
  learning: [
    'Failed Fundamentals twice. Then I read it.',
    'The library is free. Everyone in this quarter forgets.',
    'PDORM is {PDORM}. Original radiators.',
    'The exam is real. That is what nobody tells you.',
    'Everyone here has a plan and a deadline and one coat.',
    'Chalk dust on the stairs. Somebody is still teaching.',
  ],
  marketsq: [
    'Market Hall was three deep at seven.',
    'The watch dealer at the Bazaar has a voice on him.',
    'STALL pays for itself in a good August.',
    'SNEAK at {SNEAK}. For shoes somebody wore.',
    'You can buy anything here. Twice, if careless.',
    'POFFC is empty and the sign says fully let.',
    'Whatever they were digging for, it was under the fish stall.',
  ],
  greenedge: [
    'Maple has not put her prices up since the old Mayor.',
    'The Co-op takes cash and gossip. Mostly gossip.',
    'SOLAR on the top field. It never grew anything.',
    'HERD is {HERD} and the cows do not know.',
    'Rain midweek, sun at the weekend. Ask the wheat.',
    'MILK is a route, not a cow. People get that wrong.',
    'Nothing out here has been profitable since I was small.',
  ],
  ironhills: [
    'My grandfather came up that shaft. Twice a day.',
    'The Mineral Exchange still weighs by hand.',
    'The seam ran out in the seventies. The stories did not.',
    'PWHSE is full of nothing. {PWHSE}.',
    'These hills were rich once. They mention it a lot.',
    'Copper is down and you can hear it from here.',
    'They found silver in the sixties and a road after.',
  ],
  waterfront: [
    'Gulls took a whole box of pastries off the dock.',
    'PTWR is {PTWR}. One floor.',
    'Coffee goes cold here in about ninety seconds.',
    'RVRN moves this whole quay and owns none of it.',
    'Tide is wrong. Two boats waiting and the one berth.',
    'Somebody has lived on that boat since spring.',
    'It smells of diesel and money. Mostly diesel.',
  ],
  innovation: [
    'Six startups in that building. Four will not see spring.',
    'The Lab has a beanbag and no chairs.',
    'Pebble Mobile is hiring again. The same nine people.',
    'The Listings Office is full of pre-revenue calm.',
    'FIBER runs under the whole island and nobody sees it.',
    'Orchard Robotics built a picker. It picks. That is it.',
    'Everyone here is about to announce something.',
  ],
  stampede: [
    'The Stampede have not won since I had hair.',
    'CONCS makes more in a season than the team does.',
    'My father had that rookie card. My father sold it.',
    'Full house Saturday. Half of them left at sixty minutes.',
    'The youth academy is the only thing here that works.',
    'Season tickets went up. The team did not.',
    'Thunder has been at that field since before the lights.',
  ],
  goldenheights: [
    'Vance does not take meetings. He takes appointments.',
    'Everything up here is quiet. That costs extra.',
    'Bronze doors at the Treasury. Same queue.',
    'Nobody up here talks about money. They have it.',
    'Golden Heights is priced for a much bigger city.',
    'Two hundred steps up and the view is of the mine.',
  ],
};

/** By hour. There is deliberately no `day` bucket: the pool above IS
    daytime speech, and a condition that holds for two thirds of the
    clock is not a condition, it is a second general pool. */
export const HOUR_LINES = {
  /* 05–07 */
  dawn: [
    'The bakery light has been on since four. Crumb and Co.',
    'First metro. Everybody on it is going to work.',
    'Nobody sensible is up at this hour. And yet.',
    'Saw the Mayor out running at seven. In a shirt!',
    'The gulls start well before the cranes do.',
    'The Exchange opens at nine. I got up at four.',
  ],
  /* 18–21 */
  evening: [
    'The Bent Spoon shut at seven. It always does.',
    'Noodle Cart Alley after nine. Only honest place.',
    'The Bazaar is loudest at eight. Not at noon.',
    'Lights on at the Exchange. Somebody is losing.',
    'Everything shuts and then the alley opens.',
    'One more, and then the last metro.',
  ],
  /* 22–04 */
  night: [
    'The cart shuts at eleven. Everybody finds that out once.',
    'No metro until five. Walk, or do not go.',
    'The arcade is the only light on this whole street.',
    'Nothing good was ever priced at three in the morning.',
    'Night shift pays more. It takes more as well.',
    'The Exchange is dark. It looks like a bank should.',
    'Quiet enough to hear the harbour from up here.',
    'Whoever is awake at this hour wants something.',
  ],
};

/** By weather — and by the DELIVERED weather, not the asked-for one.
    See sky.js: a change takes 150 s to arrive, so `weatherName` is a
    promise and `rainfall`/`storminess` are the fact. Someone complaining
    about rain two minutes before the first drop is the exact failure
    this pool is written to avoid. */
export const WEATHER_LINES = {
  rain: [
    'Rain. The gulls have found somewhere with a roof.',
    'He said bring a coat. He did not bring a coat.',
    'Dispatch is busy. Nobody walks in this.',
    'The market packed up at two. Cannot sell wet bread.',
    'The library is full and nobody is reading.',
    'Everything on this island leaks. Everything.',
    'Good for the wheat. Terrible for the paint.',
  ],
  storm: [
    'The harbour is shut. The crane is delighted.',
    'Lost a slate off the roof. Landlord says weather.',
    'The metro is running. It is the only thing that is.',
    'They will blame the harvest on this. They always do.',
    'Ferry is cancelled. Second time this week.',
    'Get inside. That is not going to improve.',
  ],
};

/** By how much of the city is tokenized — game.economy.cityPct(). The
    player's own work, coming back at him as small talk. */
export const CITY_LINES = {
  /* under 20 % */
  early: [
    'They say you can own a slice of a field now. A slice.',
    'One thing tokenized and the Mayor cut a ribbon for it.',
    'Nothing round here is in pieces yet. Give it a year.',
    'My brother read the leaflet. He has questions.',
  ],
  /* 20–69 % */
  half: [
    'My neighbour owns nine per cent of a bridge.',
    'You can buy a corner of the stadium. A corner.',
    'The Co-op is on the board now. The Co-op.',
    'Half of it is in pieces and the queue is still a queue.',
    'Everything is being split up. Into better pieces, they say.',
  ],
  /* 70–96 % */
  most: [
    'There is almost nothing left on this island to connect.',
    'My aunt owns part of a crane. She has never seen it.',
    'Even the toll bridge is in pieces now. The bridge.',
    'The whole island is on one board.',
    'Nobody says tokenized any more. It is just how it is.',
  ],
  /* 97 %+ */
  all: [
    'All of it. Every last thing on this island.',
    'Nothing left to connect. Someone will manage.',
    'They are talking about doing the mainland next.',
    'It all fits on one screen now. All of it.',
  ],
};

/** By reputation. The city learning your name, at the rate the rep
    ladder in data.js says it should. Written to stay dry: nobody here
    is impressed, they have simply noticed. */
export const FAME_LINES = {
  /* rep < 32 — below Trusted With Keys */
  unknown: [
    'New trader in town. Elephant. Sunglasses.',
    'Somebody new is running errands for the Co-op.',
    'There is a lad doing deliveries in sunglasses.',
    'Nobody knows his name yet. He keeps turning up.',
  ],
  /* 32–159 */
  known: [
    'That is the one Dot starts a coffee for.',
    'He did something out at the farm. Maple is pleased.',
    'He was doing deliveries two months ago.',
    'They gave him keys. Real ones.',
    'He turns up. That is most of it.',
    'Somebody vouched for him at the bank.',
  ],
  /* 160+ — Pillar Of Bull Bear and up. THE THRESHOLD IS THE LADDER'S,
     not a number of mine: data.js glosses rep 160 as "a district would
     notice if you left", and act 5 — the Stampede — opens there. A
     famous-bucket that started earlier had citizens crediting him with
     saving a football club he had not met yet. */
  famous: [
    'They say his name at the Exchange now.',
    'They say he is why the Stampede are still here.',
    'The Mayor returns his calls. Eventually.',
    'He still walks everywhere. With all that.',
    'A district would notice if he left. Two would say so.',
  ],
};

/** What he is currently doing that is worth looking up from a coffee
    for. These are OFFERED, never forced — see PREFER in the picker: an
    elephant on a motorbike is worth a remark, not a chorus. */
export const SIGHTING_LINES = {
  balloon: [
    'That is not a cloud.',
    'A balloon. Over Bull Bear City. Well.',
    'The gulls have opinions about that.',
    'First one since the fair. I was nine.',
    'He got it up. I genuinely did not think he would.',
    'Mind the wires, friend. Mind the wires.',
    'From up there the whole island is one board.',
    'Somebody go and tell Barnaby.',
  ],
  motorcycle: [
    'That is a lot of elephant for one motorbike.',
    'He will be at the docks before the bus is.',
    'The suspension held. I owe Vic five.',
    'Nobody has heard an engine on this street in years.',
  ],
  scooter: [
    'There goes Route 6. Faster than it ever went.',
    'Barnaby gave that away? He must like him.',
    'Thirty years, that scooter. And one owner.',
    'Mind the kerb on Rusty Row. Everyone forgets.',
  ],
  bike: [
    'There is a bell on that. He has never used it.',
    'Uphill both ways to Golden Heights. Good luck.',
    'He is going to lock that or he is going to lose it.',
  ],
};

/** All of it, flat — what a length audit and the old callers walk. */
export const AMBIENT_LINES = [...BULL_LINES, ...BEAR_LINES, ...STREET_LINES];

/** Every line in the file, including the conditional pools. */
export const ALL_LINES = [
  ...AMBIENT_LINES,
  ...Object.values(DISTRICT_LINES).flat(),
  ...Object.values(HOUR_LINES).flat(),
  ...Object.values(WEATHER_LINES).flat(),
  ...Object.values(CITY_LINES).flat(),
  ...Object.values(FAME_LINES).flat(),
  ...Object.values(SIGHTING_LINES).flat(),
];

/* ==================================================================
   1c. THE PICKER — which line, and why not that one again.

   TWO JOBS, AND THE SECOND ONE IS THE HARD ONE.

   WHICH POOLS ARE OPEN. A scene — where the speaker is standing, the
   hour, what is actually falling out of the sky, how much of the city
   is tokenized, whether anyone knows the player's name, what he is
   riding — opens a set of GROUPS, each with a weight. The weights are
   the whole editorial decision and they are stated here rather than
   buried: in a district, two lines in five are about that district;
   the general pools keep the largest single share, because a city
   where every remark is site-specific is a guidebook, not a street.

   NOT THAT ONE AGAIN, and this is where the work is. The picker this
   replaces was `pool[floor(rng()*pool.length)]` — uniform, memoryless,
   over forty-four lines. Simulated over two thousand six-minute walks
   (sixty picks each), the MEDIAN smallest gap between two hearings of
   the same line was ONE. Not "sometimes repeats": back-to-back was the
   middle case, and every single run repeated something inside seven
   picks. That is what a crowd sounds like when it stops being people.

   Two mechanisms, and they do different jobs.

   THE RING is the promise. The last `RING` lines said, anywhere, by
   anyone, are simply not available. It is a hard floor, not a
   tendency, so the guarantee can be stated as a number instead of a
   distribution: at one line every 4.5–9 s, twenty-eight lines is
   between two and four minutes — a walk across two districts. A group
   with nothing outside the ring is dropped and the weight re-rolled
   among the rest, which also has the right editorial effect: a
   four-line pool spends its four lines and then goes quiet for a
   while, instead of becoming the thing you hear most.

   THE PER-GROUP MEMORY is the texture. Within a group, a line needs
   `mem` visits TO THAT GROUP since it was last used, mem being ~70 %
   of the group's size. The counter is per group and not global on
   purpose: an eight-line district pool visited once every third pick
   would have a global memory expire between two visits to it, which is
   exactly the hole this shape exists to close. Without it the ring
   alone would cycle a small pool in a fixed order.

   Neither can wedge. If every open group is ringed out, the last
   resort honours group memory and ignores the ring — with base pools
   of thirty-plus lines against a ring of twenty-eight, that branch has
   never been reached in any audited scene, and the audit reports it.
   ================================================================== */

/* Weights are relative and only compared against each other. */
const GROUP_W = {
  bull: 1.5, bear: 1.5, street: 1.5,
  district: 3.0,
  hour: 1.5,
  weather: 1.8,
  city: 1.0,
  fame: 0.7,
};

/* How often a sighting takes the line, when one is available. The
   balloon is a moment and gets more than half; the bicycle he rides
   everywhere gets almost none, because a remark you hear on every
   commute is not a remark. */
const PREFER = { balloon: 0.55, motorcycle: 0.25, scooter: 0.25, bike: 0.12 };

/** Which buckets a raw scene opens. Exported so a rig can name a
    context without reimplementing the thresholds. */
export function sceneBuckets(scene = {}) {
  const s = {};
  if (scene.zone && DISTRICT_LINES[scene.zone]) s.zone = scene.zone;
  const h = Number.isFinite(scene.hour) ? Math.floor(scene.hour) % 24 : -1;
  if (h >= 5 && h <= 7) s.hour = 'dawn';
  else if (h >= 18 && h <= 21) s.hour = 'evening';
  else if (h >= 22 || (h >= 0 && h <= 4)) s.hour = 'night';
  /* the DELIVERED sky, never the requested one */
  if ((scene.storminess ?? 0) > 0.70) s.storm = true;
  if ((scene.rainfall ?? 0) > 0.35) s.rain = true;
  const pct = Number.isFinite(scene.pct) ? scene.pct : 0;
  s.city = pct >= 97 ? 'all' : pct >= 70 ? 'most' : pct >= 20 ? 'half' : 'early';
  const rep = Number.isFinite(scene.rep) ? scene.rep : 0;
  s.fame = rep >= 160 ? 'famous' : rep >= 32 ? 'known' : 'unknown';
  if (scene.seeing && SIGHTING_LINES[scene.seeing]) s.seeing = scene.seeing;
  return s;
}

/**
 * @param {() => number} rng  a seeded stream (ctx.makeRng)
 */
export function createLinePicker(rng = Math.random, opts = {}) {
  /* THE RING. Twenty-eight lines is two to four minutes of walking at
     the scheduler's 4.5–9 s spacing — long enough to cross two
     districts, which is the "short walk" the guarantee is written
     against. */
  const RING = Math.max(0, opts.ring ?? 28);
  const ring = [];
  const ringSet = new Set();
  let desperate = 0;          // times the ring had to be ignored
  function remember(line) {
    ring.push(line);
    ringSet.add(line);
    while (ring.length > RING) {
      const old = ring.shift();
      if (!ring.includes(old)) ringSet.delete(old);
    }
  }

  /* name -> { lines, at: Map<line, visit>, n } */
  const groups = new Map();
  function group(name, lines) {
    let g = groups.get(name);
    if (!g) { g = { name, lines, at: new Map(), n: 0 }; groups.set(name, g); }
    return g;
  }

  /**
   * One line out of one group, or null if the group has nothing that
   * clears both filters. A visit is only spent on a success — a group
   * that could not answer must not age everyone else's memory.
   */
  function fromGroup(g, blocked) {
    const C = g.lines.length;
    if (!C) return null;
    const mem = C <= 4 ? C - 1 : Math.min(24, Math.ceil(C * 0.70));
    const n = g.n + 1;
    let fresh = null, nfresh = 0;
    /* one pass, reservoir-style: no allocation on the common path */
    for (let i = 0; i < C; i++) {
      const l = g.lines[i];
      if (blocked && blocked.has(l)) continue;
      /* A LINE WHOSE NUMBER CANNOT BE READ IS NOT OFFERED. This is a
         filter and not a fallback on purpose: the alternatives are a
         bubble with `{PSHOP}` in it and a bubble quoting the base
         value, and the base value is the wrong number the slot exists
         to stop quoting. Costs one indexOf per candidate on a pool of
         at most thirty-four, and only calls the board for the dozen
         lines that have a slot in them. */
      if (hasSlot(l) && fillPrices(l) === null) continue;
      const last = g.at.get(l);
      if (last !== undefined && n - last <= mem) continue;
      nfresh++;
      if (rng() * nfresh < 1) fresh = l;
    }
    if (fresh === null) return null;
    g.n = n;
    g.at.set(fresh, n);
    return fresh;
  }

  const api = {
    /** The open groups for a scene, as {name, weight, size}. Debug. */
    groupsFor(scene) {
      const s = sceneBuckets(scene);
      const out = [
        { name: 'bull', w: GROUP_W.bull, lines: BULL_LINES },
        { name: 'bear', w: GROUP_W.bear, lines: BEAR_LINES },
        { name: 'street', w: GROUP_W.street, lines: STREET_LINES },
      ];
      if (s.zone) out.push({ name: 'z:' + s.zone, w: GROUP_W.district, lines: DISTRICT_LINES[s.zone] });
      if (s.hour) out.push({ name: 'h:' + s.hour, w: GROUP_W.hour, lines: HOUR_LINES[s.hour] });
      if (s.rain) out.push({ name: 'w:rain', w: GROUP_W.weather, lines: WEATHER_LINES.rain });
      if (s.storm) out.push({ name: 'w:storm', w: GROUP_W.weather, lines: WEATHER_LINES.storm });
      if (s.city) out.push({ name: 'c:' + s.city, w: GROUP_W.city, lines: CITY_LINES[s.city] });
      if (s.fame) out.push({ name: 'f:' + s.fame, w: GROUP_W.fame, lines: FAME_LINES[s.fame] });
      return out;
    },

    /**
     * One line for one speaker.
     * @param {{zone?:string, hour?:number, rainfall?:number,
     *          storminess?:number, pct?:number, rep?:number,
     *          seeing?:string, forceSeeing?:boolean}} scene
     * @param {{detail?:boolean}} o
     */
    pick(scene = {}, o = {}) {
      const s = sceneBuckets(scene);
      /* THE RING REMEMBERS THE TEMPLATE, the speaker says the fill.
         Identity has to be the template or `{CTSK}` would count as a
         different line every time the board moved and the repeat
         guarantee would quietly stop guaranteeing anything. */
      const out = (line, name) => {
        remember(line);
        const said = fillPrices(line) ?? line;
        return o.detail ? { line: said, raw: line, group: name } : said;
      };
      /* THE SIGHTING FIRST, and as a probability rather than a weight:
         it is the only pool that is about the player instead of about
         the city, so it should either take the remark outright or
         stand aside cleanly. If everything it has is still in the ring
         it stands aside — the balloon does not get to repeat itself
         just because the balloon is up. */
      if (s.seeing && (scene.forceSeeing || rng() < (PREFER[s.seeing] ?? 0.2))) {
        const g = group('see:' + s.seeing, SIGHTING_LINES[s.seeing]);
        const line = fromGroup(g, ringSet);
        if (line) return out(line, g.name);
      }
      /* weighted choice among the open groups, re-rolled without the
         ones that have nothing left to say */
      const pool = api.groupsFor(scene).filter((e) => e.lines.length);
      while (pool.length) {
        let total = 0;
        for (const e of pool) total += e.w;
        let r = rng() * total, idx = pool.length - 1;
        for (let i = 0; i < pool.length; i++) { r -= pool[i].w; if (r <= 0) { idx = i; break; } }
        const e = pool[idx];
        const g = group(e.name, e.lines);
        const line = fromGroup(g, ringSet);
        if (line) return out(line, g.name);
        pool.splice(idx, 1);
      }
      /* LAST RESORT: every open group is inside the ring. Honour the
         per-group memory and ignore the ring. Counted, and reported by
         the audit, because reaching it means the ring is too long for
         the pools — not something to discover from a player. */
      desperate++;
      const first = api.groupsFor(scene).find((e) => e.lines.length);
      const g = group(first.name, first.lines);
      /* even here, never a line the board cannot fill */
      const sayable = first.lines.find((l) => !hasSlot(l) || fillPrices(l) !== null);
      return out(fromGroup(g, null) || sayable || first.lines[0], g.name);
    },

    /** Per-group state, for the audit. */
    stats() {
      return [...groups.values()].map((g) => ({
        group: g.name, size: g.lines.length, visits: g.n,
      }));
    },
    /** How many picks had to ignore the ring. Must be 0. */
    get desperate() { return desperate; },
    get ring() { return RING; },
    reset() { groups.clear(); ring.length = 0; ringSet.clear(); desperate = 0; },
  };
  return api;
}

/* ==================================================================
   2. The pool
   ================================================================== */

/* Canvas pixels. 344 x 178 holds three lines of 30 px text plus the
   tail and the padding, and the world size below is scaled with it so
   that the letters stay the same physical height whatever the card
   does — which is the number that decides whether this is readable at
   eight metres on a 900 px viewport, and the first pass got wrong: at
   288 px wide a line fitted thirteen characters and every one of the
   overheard lines came out as three words and an ellipsis. */
const CW = 344, CH = 178;
const PAD = 16;
const FONT = "800 30px ui-rounded, 'SF Pro Rounded', Nunito, Quicksand, "
  + "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const _v = new THREE.Vector3();
const _c = new THREE.Vector3();

export function createBubbles(ctx, opts = {}) {
  const POOL = Math.max(2, opts.pool ?? (ctx.quality?.particles >= 0.9 ? 4 : 3));
  const MAX_LIVE = Math.max(1, opts.maxLive ?? (POOL - 1));
  const FAR = opts.far ?? 30;        // no bubble past this
  const NEAR_MIN = 1.2;
  const FADE = 0.28;
  /* the nominal card, in metres — what a line is assumed to occupy
     before it has been drawn and measured */
  const NOM_W = CW * 0.0066, NOM_H = CH * 0.0066;

  /* THE LIVE BOARD, READ LAZILY. npc.js constructs this before game.js
     exists, so ctx.game is looked up per call rather than captured —
     and `economy.fmt` is used rather than a formatter of my own, so a
     citizen quoting PSHOP says character-for-character what the market
     screen prints for it. Anything missing returns null, which mutes
     the slot lines rather than inventing a number for them. */
  setPriceBoard((tick) => {
    const e = ctx.game?.economy;
    if (!e || typeof e.price !== 'function' || typeof e.fmt !== 'function') return null;
    try {
      const v = e.price(tick);
      return Number.isFinite(v) && v > 0 ? e.fmt(v) : null;
    } catch (err) { return null; }
  });

  const group = new THREE.Group();
  group.name = 'npc.bubbles';
  group.renderOrder = 20;
  ctx.scene.add(group);

  const slots = [];
  for (let i = 0; i < POOL; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = CW; canvas.height = CH;
    const g2 = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.anisotropy = 1;
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0, depthTest: true, depthWrite: false,
      toneMapped: false,
    });
    const sp = new THREE.Sprite(mat);
    sp.name = 'bubble' + i;
    /* A SPRITE IS NOT A SURFACE and the deferred passes must not treat
       it as one: it has no normal, it writes no depth, and the DOF and
       the ground-shadow pass both read that buffer. */
    sp.userData.noPrepass = true;
    sp.userData.noOutline = true;
    sp.castShadow = false;
    sp.receiveShadow = false;
    sp.visible = false;
    sp.frustumCulled = false;
    sp.renderOrder = 20 + i;
    group.add(sp);
    slots.push({
      sp, mat, tex, g2, canvas,
      live: false, target: null, offset: 1.1, t: 0, ttl: 0, fade: 0, key: '',
    });
  }

  /* ---- drawing ----
     Everything is measured before anything is drawn, so the balloon is
     the size of the words rather than the words being squeezed into a
     fixed balloon. */
  function wrap(g2, text, maxW) {
    g2.font = FONT;
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (g2.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; }
      else cur = t;
      if (lines.length >= 3) break;
    }
    if (cur && lines.length < 4) lines.push(cur);
    /* FOUR LINES IS A PARAGRAPH AND A PARAGRAPH IS NOT OVERHEARD.
       Anything that does not fit in three is elided rather than shrunk
       — a smaller font is unreadable at the distance this is meant to
       be read from, which defeats the whole feature.

       AND THE POOL IS WRITTEN TO FIT IN THREE, NOT TWO. This comment
       said two for a long time and it was never true: maxW is 290 px
       at 30 px bold, which is about nineteen characters, so 228 of the
       255 lines take three rows and always have. It matters because
       "fits in two" is what makes a character count feel like a safe
       proxy for the real layout — it is not, the last row is where the
       punchline is, and the only honest check is measure() with this
       font. Two lines written this round were 54 and 57 characters,
       shorter than lines already in the pool, and both elided. */
    if (lines.length > 3) {
      lines.length = 3;
      lines[2] = lines[2].replace(/[,.;:!?]?$/, '') + '…';
    }
    return lines;
  }

  const PAPER = css(BRAND.paper);
  /* NOT BRAND.ink (#12141C). §7 forbids pure black in frame and this
     card is IN the frame — it is a lit object standing in the street,
     not a HUD layer over the top of one. A warm near-black keeps a hue
     in the letterforms the way every other dark surface in the game
     does. */
  const INK = css(0x2b2620);
  const EDGE = css(SHADOW.tint);

  function draw(slot, text, tint) {
    const g2 = slot.g2;
    g2.clearRect(0, 0, CW, CH);
    const maxW = CW - PAD * 2 - 22;
    const lines = wrap(g2, text, maxW);
    let w = 0;
    for (const l of lines) w = Math.max(w, g2.measureText(l).width);
    w = Math.min(CW - 12, w + PAD * 2 + 10);
    const lh = 34;
    const h = lines.length * lh + PAD * 2 - 6;
    const x = (CW - w) / 2, y = 6;
    const r = 22;
    const tailW = 17, tailH = 20;

    /* the balloon: a rounded card in the same paper the UI is drawn on,
       with a soft blue-violet edge (§2.1 — shadows are coloured) and a
       tail pointing down at whoever said it */
    g2.save();
    g2.beginPath();
    g2.moveTo(x + r, y);
    g2.arcTo(x + w, y, x + w, y + h, r);
    g2.arcTo(x + w, y + h, x, y + h, r);
    g2.lineTo(CW / 2 + tailW, y + h);
    g2.lineTo(CW / 2 - 2, y + h + tailH);
    g2.lineTo(CW / 2 - tailW, y + h);
    g2.arcTo(x, y + h, x, y, r);
    g2.arcTo(x, y, x + w, y, r);
    g2.closePath();
    /* A DROP SHADOW, NOT AN OUTLINE. The bubble is read against grass,
       stucco and sky in the same second; a stroke that survives all
       three is heavy enough to look like a sticker, and a soft dark
       offset does not. */
    g2.shadowColor = 'rgba(28,34,58,0.34)';
    g2.shadowBlur = 12;
    g2.shadowOffsetY = 4;
    g2.fillStyle = PAPER;
    g2.fill();
    g2.shadowColor = 'transparent';
    g2.lineWidth = 3;
    g2.strokeStyle = tint || EDGE;
    g2.globalAlpha = 0.55;
    g2.stroke();
    g2.globalAlpha = 1;
    g2.restore();

    g2.font = FONT;
    g2.fillStyle = INK;
    g2.textAlign = 'center';
    g2.textBaseline = 'middle';
    const y0 = y + PAD - 3 + lh / 2;
    for (let i = 0; i < lines.length; i++) g2.fillText(lines[i], CW / 2, y0 + i * lh);

    slot.tex.needsUpdate = true;
    /* World size. 0.78 m of bubble height per 152 canvas pixels is a
       card about as wide as a person is tall — big enough to read
       across a street, small enough that two of them are not the whole
       frame. */
    /* WORLD SIZE FOLLOWS CANVAS SIZE. 0.0066 m per canvas pixel keeps a
       30 px letter 0.20 m tall in the world at every card size, which
       is what actually decides legibility; sizing the card in metres
       and letting the text scale inside it is how a two-line bubble
       ends up unreadable and a one-line bubble ends up enormous. */
    const s = (opts.scale ?? 1) * 0.0066;
    slot.sp.scale.set(s * CW, s * CH, 1);
    slot.wide = s * CW; slot.tall = s * CH;
  }

  /* ---- screen-space separation ---- */
  function screenOf(p, out) {
    _c.copy(p).project(ctx.camera);
    out.x = (_c.x * 0.5 + 0.5) * (ctx.canvas?.width || 1600);
    out.y = (0.5 - _c.y * 0.5) * (ctx.canvas?.height || 900);
    out.z = _c.z;
    return out;
  }
  const _s1 = { x: 0, y: 0, z: 0 }, _s2 = { x: 0, y: 0, z: 0 };

  /* SEPARATION IS MEASURED IN THE CARD'S OWN PROJECTED SIZE, not in a
     fixed number of pixels. A bubble is a fixed size in METRES, so at
     six metres it is four hundred pixels wide and at twenty it is a
     hundred and twenty: one constant cannot serve both, and the pass
     that used one drew three overlapping balloons over three people
     standing together (shots/x-bubbles.png, second attempt). Projecting
     the half-widths and comparing them is exact, costs two multiplies,
     and needs no tuning. */
  function halfPx(worldSize, dist) {
    const cam = ctx.camera;
    const fov = (cam.fov || 50) * Math.PI / 180;
    const h = ctx.canvas?.height || 900;
    return (worldSize * 0.5 / (2 * Math.max(dist, 0.5) * Math.tan(fov * 0.5))) * h;
  }
  function tooClose(p) {
    screenOf(p, _s1);
    if (_s1.z > 1) return true;               // behind the camera
    const cam = ctx.camera;
    cam.getWorldPosition(_c);
    const dc = _c.distanceTo(p);
    const w1 = halfPx(NOM_W, dc), h1 = halfPx(NOM_H, dc);
    for (const s of slots) {
      if (!s.live) continue;
      /* A BUBBLE THAT HAS NOT HAD A FRAME YET IS STILL A BUBBLE. `fade`
         is ramped in update(), so one shown this tick still reads 0 —
         and skipping it here is why three lines granted inside one call
         drew three overlapping balloons over three people standing
         together. Only a bubble that has been up for a frame AND is
         nearly gone is ignored. */
      if (s.t > 0.02 && s.fade < 0.05) continue;
      screenOf(s.sp.position, _s2);
      cam.getWorldPosition(_c);
      const db = _c.distanceTo(s.sp.position);
      const w2 = halfPx(s.wide || NOM_W, db), h2 = halfPx(s.tall || NOM_H, db);
      /* 1.12 is a stride of air between two cards. Touching is not
         overlapping, but two balloons whose edges kiss read as one
         wide balloon with a seam in it. */
      if (Math.abs(_s1.x - _s2.x) < (w1 + w2) * 1.12
        && Math.abs(_s1.y - _s2.y) < (h1 + h2) * 1.12) return true;
    }
    return false;
  }

  let liveCount = 0;
  let lastAt = -99;
  let elapsed = 0;

  const api = {
    group,
    lines: AMBIENT_LINES,
    bull: BULL_LINES,
    bear: BEAR_LINES,
    street: STREET_LINES,

    get live() { return liveCount; },

    /**
     * Put a line over somebody.
     * @param {{root:THREE.Object3D, height:number}|THREE.Object3D} who
     * @param {string} text
     * @param {{ttl?:number, tint?:string, force?:boolean, key?:string}} o
     * @returns {boolean} whether it was granted
     */
    show(who, text, o = {}) {
      if (!who || !text) return false;
      const node = who.root || who;
      if (!node || !node.isObject3D) return false;
      const height = who.height ?? 1.7;
      node.getWorldPosition(_v);
      _v.y += height * 1.14;

      if (!o.force) {
        const cam = ctx.camera;
        cam.getWorldPosition(_c);
        const d = _v.distanceTo(_c);
        if (d > FAR || d < NEAR_MIN) return false;
        if (liveCount >= MAX_LIVE) return false;
        if (tooClose(_v)) return false;
      }
      let slot = slots.find((s) => !s.live);
      if (!slot) {
        if (!o.force) return false;
        slot = slots.reduce((a, b) => (a.t / a.ttl > b.t / b.ttl ? a : b));
        liveCount--;
      }
      draw(slot, text, o.tint);
      slot.live = true;
      slot.target = node;
      slot.offset = height * 1.14 + 0.30;
      slot.ttl = o.ttl ?? clamp(2.6 + String(text).length * 0.035, 3.0, 6.4);
      slot.t = 0;
      slot.fade = 0;
      slot.key = o.key || '';
      slot.sp.position.copy(_v);
      slot.sp.visible = true;
      liveCount++;
      lastAt = elapsed;
      return true;
    },

    /** Seconds since the last granted line — the anti-spam clock. */
    get sinceLast() { return elapsed - lastAt; },

    /**
     * Lay out lines with the REAL font and the REAL wrap and report
     * what they cost, without drawing anything.
     *
     * WHY IT EXISTS. `wrap()` silently elides at three rows, and every
     * line in this file is written to fit in two — which is an
     * assertion about a proportional font at 30 px that a human
     * counting characters cannot actually make. Two hundred and forty
     * lines went in this round; measuring them is one call and
     * guessing at them is a bubble ending in an ellipsis in somebody's
     * screenshot.
     * @param {string[]} lines
     * @returns {{n:number, rows3:string[], elided:string[], widest:{t:string,w:number}}}
     */
    measure(lines) {
      const g2 = slots[0].g2;
      const maxW = CW - PAD * 2 - 22;
      const rows3 = [], elided = [];
      let widest = { t: '', w: 0 };
      for (const raw of lines) {
        /* MEASURE WHAT THE PLAYER READS, AND THE WORST OF IT. A fit
           test run against `{PTWR}` measures seven characters of
           braces; the board can print six digits there. widestFill()
           substitutes the 2.7x clamp ceiling, so a line that passes
           here passes at every price the economy can reach. */
        const t = widestFill(raw);
        const ls = wrap(g2, t, maxW);
        if (ls.length >= 3) rows3.push(t);
        if (ls[ls.length - 1]?.endsWith('…')) elided.push(t);
        for (const l of ls) {
          const w = g2.measureText(l).width;
          if (w > widest.w) widest = { t: l, w: Math.round(w) };
        }
      }
      return { n: lines.length, rows3, elided, widest, maxW };
    },

    /** Is anything of this key already up? */
    hasKey(k) { return slots.some((s) => s.live && s.key === k); },

    update(dt, t) {
      elapsed = t ?? (elapsed + dt);
      if (!liveCount) return;
      const cam = ctx.camera;
      cam.getWorldPosition(_c);
      for (const s of slots) {
        if (!s.live) continue;
        s.t += dt;
        /* follow whoever said it, so a line spoken by somebody walking
           travels with them rather than hanging in the street */
        if (s.target && s.target.parent) {
          s.target.getWorldPosition(_v);
          _v.y += s.offset;
          s.sp.position.copy(_v);
        }
        const d = s.sp.position.distanceTo(_c);
        const inN = clamp(s.t / FADE, 0, 1);
        const out = clamp((s.ttl - s.t) / FADE, 0, 1);
        /* and it goes politely when it goes: the far fade is a distance
           ramp, not a cut, so a bubble on somebody walking away from you
           thins out instead of blinking off */
        const far = 1 - clamp((d - (FAR - 6)) / 6, 0, 1);
        s.fade = damp(s.fade, Math.min(inN, out) * far, 14, dt);
        s.mat.opacity = s.fade;
        s.sp.visible = s.fade > 0.01;
        if (s.t >= s.ttl + FADE) {
          s.live = false;
          s.target = null;
          s.sp.visible = false;
          s.mat.opacity = 0;
          liveCount--;
        }
      }
    },

    clear() {
      for (const s of slots) {
        s.live = false; s.target = null; s.sp.visible = false; s.mat.opacity = 0;
      }
      liveCount = 0;
    },

    dispose() {
      for (const s of slots) { s.tex.dispose(); s.mat.dispose(); }
      group.removeFromParent();
    },
  };
  return api;
}

export default createBubbles;
