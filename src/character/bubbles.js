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

/* ==================================================================
   1. THE LINES

   House voice: dry, affectionate, understated. Nobody in this city
   shouts and nobody explains a joke. A line is one thought long, it
   sounds like half of a conversation you are walking past, and where
   it can it names something the player can actually go and look at —
   a ticker off the board, a street, a shopfront — so that the economy
   and the map are plainly the same place.
   ================================================================== */

/** Bullish. Cheerful, over-confident, occasionally correct. */
export const BULL_LINES = [
  'TRNK up again. I said it. Note that.',
  'CTSK at eighty-eight and still buying.',
  'BrightGrid wired all of Iron Hills.',
  'MMTR got the depot contract. Told you.',
  'Everyone laughed at WaffleWorks. Not now.',
  'GOLD has had a run. My uncle is thrilled.',
  'Market Hall was three deep at seven.',
  'BERRY. Buy the field, not the jam.',
  'Main Street property only goes one way.',
  'Bought HERD at 140. Cows always come back.',
  'Stampede won at home. STMD has a good week.',
  'Orchard are hiring. Nobody hires going down.',
  'New trader in town. Elephant. Sunglasses.',
  'Honey up eleven per cent. I have four hives.',
  'Bull Bear Mutual raised the deposit rate.',
];

/** Bearish. Weary, specific, right often enough to be irritating. */
export const BEAR_LINES = [
  'CTSK at eighty-eight is a story, not a firm.',
  'Trunk have never shipped in the quarter.',
  'Sold STMD. They lose at home as well.',
  'Golden Heights is priced for a bigger city.',
  'PBMB: a phone nobody wants. Ask them why.',
  'The Exchange is shut to me. Funny, that.',
  'GEMS at four twenty. For a rock. In a bag.',
  'BRBM builds scaffolding and press releases.',
  'Lovely tower view. Of a crane that never moves.',
  'The Farm index is one bad August from a haircut.',
  'Copper is down and Iron Hills has gone quiet.',
  'Two years of ACRN. Two years of tinned hope.',
  'A ten-year Restoration Bond. Restoring what?',
  'Anyone looks clever in a bull market.',
];

/** The city talking about itself. Gossip, rent, the mayor, the weather. */
export const STREET_LINES = [
  'Rent is up again on Rusty Row. For weather.',
  'The Bent Spoon put the coffee up. Beans, Dot says.',
  'Mayor Ken Jones opened something. Again.',
  'Noodle Cart Alley after nine. Only honest place.',
  'Barnaby has driven Route 6 for thirty years.',
  'They are digging up Market Square. Nobody knows why.',
  'Otto is in the cafe with two coffees. Still.',
  'The library wants its book back. Since March.',
  'Every student wants to be a trader now.',
  'That office block has been to let for a year.',
  'Someone left a scooter behind Dispatch.',
  'Auntie Maple brought marrows. Everyone has one.',
  'The harbour crane is on strike. The crane.',
  'Saw the Mayor out running at seven. In a shirt!',
  'Coach Thunder is still shouting at that field.',
];

/** All of it, which is what the picker walks. */
export const AMBIENT_LINES = [...BULL_LINES, ...BEAR_LINES, ...STREET_LINES];

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
       be read from, which defeats the whole feature. Every line in the
       pool above is written to fit in two. */
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
