/* ============================================================
   menus.js — every panel that is not the phone.

     pause          resume / phone / desk / settings / save / load
     settings       audio, quality, accessibility, persistence
     travel         the fare board for a destination
     place          "what you can do here" + the people standing there
     desk           orders, arrivals, tokenizing, office, team
     market         a venue's order book
     school, bank, pawn, homes, farm, mine, dev lab, listings,
     the Stampede questline

   Every one of these is a thin skin over ctx.game.actions — this
   module contains no game rules, only the reading of results.
   ============================================================ */

import { BRAND, CATEGORY, BUILD, SEA, LAND, css } from '../core/palette.js';
import { QUALITY_TIERS, clamp } from '../core/contracts.js';
import {
  h, clear, icon, money, money2, pad2, portrait, glyphAvatar, wallyMark, rgba, mix, C,
  tickerTag, ticketLine,
} from './style.js';
import { cityMap } from './map.js';

export function createMenus(ctx, ui) {
  const g = () => ctx.game;

  /* ============================================================
     sheet scaffolding
     ============================================================ */
  function sheet(spec, build) {
    const titleEl = h('h2', { text: spec.title });
    const subEl = h('div.hs', { text: spec.sub || '' });
    const head = h('div.w-sheet-head', null,
      spec.glyph
        ? h('div.ic', {
            style: {
              width: '38px', height: '38px', borderRadius: '12px', display: 'grid',
              placeItems: 'center', fontSize: '19px', flex: 'none',
              background: rgba(spec.tint ?? BRAND.token, 0.16),
            },
            text: spec.glyph,
          })
        : null,
      h('div.w-grow', null, titleEl, subEl),
      /* THIS PANEL'S ✕ CLOSES THIS PANEL. It used to call
         ui.popSheet(), which dismisses whatever is on TOP of the modal
         stack — so with two boxes open (travel, open a second one, go
         back to the first) the older box's ✕ shut the newer one.
         ui.closeSheet(e.currentTarget) walks up to the panel the
         button is actually printed on. */
      h('button.w-btn.sm.ghost.w-pe', {
        type: 'button', 'aria-label': 'Close',
        style: { minWidth: '34px', padding: '0 8px' },
        onclick: (e) => { ui.sfx('ui.close'); ui.closeSheet(e.currentTarget); },
      }, icon('close', 16)));

    const body = h('div.w-sheet-body');
    const el = h('div.w-sheet.w-paper.w-pe', { role: 'dialog' }, head, body);
    el._rebuild = () => {
      clear(body);
      try { build(body, el); } catch (e) { console.error('[ui] sheet failed', e); }
    };
    el._setTitle = (t, s) => { titleEl.textContent = t; subEl.textContent = s || ''; };
    /* anything inside this sheet that needs to dismiss it — a Travel
       button, "work at the desk" — closes ITSELF, never the stack */
    el._close = () => ui.closeSheet(el);
    el._rebuild();
    return el;
  }

  /* result of a game action → toast + sound + repaint */
  function res(r, okMsg) {
    if (r && r.ok) {
      ui.sfx(okMsg === 'money' ? 'coin' : 'ui.select');
      if (typeof okMsg === 'string' && okMsg !== 'money') ui.toast(okMsg, 'good');
    } else {
      ui.sfx('ui.error');
      ui.toast((r && r.why) || 'Not right now', 'bad');
      /* A TOAST IS NOT ENOUGH FOR A LOCK. The engine now refuses
         outright at maximum hunger and at a closed venue, and a
         three-second line at the bottom of the screen that says no
         and then disappears is a dead end. Those two refusals open
         the card below instead: what is blocked, why, and the
         shortest way out of it. */
      if (r && (r.kind === 'hunger' || r.kind === 'hours')) blocked(r);
    }
    ui.refresh();
    return r;
  }

  /* ============================================================
     BLOCKED — the two refusals that need a way out printed on them.

     hunger  gate() returns {kind:'hunger', why, food} where food is
             the nearest bowl: name, zone, hops, cost, whether it is
             open and whether he can pay for it.
     hours   {kind:'hours', why, loc, opens} — the venue is shut.

     Never more than one of these on screen: it is pushed by name, so
     a second refusal repaints the one that is already open.
     ============================================================ */
  function blocked(r) {
    ui.hide('blocked');            // one at a time, always the newest reason
    const el = blockedSheet(r);
    if (!el) return null;
    return ui.pushSheet(el, 'blocked');
  }
  function blockedSheet(r) {
    const game = g();
    const hunger = r.kind === 'hunger';
    return sheet({
      title: hunger ? 'Too hungry to do that' : 'Closed right now',
      sub: hunger ? 'Eat first — everything else is locked'
        : 'The doors are shut, not locked to you',
      glyph: hunger ? '🍜' : '🕔', tint: hunger ? BRAND.bad : BRAND.warn,
    }, (body, self) => {
      const st = game.state;
      body.append(h('div.w-warnbox' + (hunger ? '.bad' : ''), { text: r.why || 'Not right now' }));

      if (hunger) {
        const n = game.needs();
        const f = r.food || n.food;
        body.append(label('What is blocked'));
        body.append(h('div.w-note', { text:
          'At ' + Math.round(st.hunger) + ' hunger Wally will not work, trade, study, travel '
          + 'anywhere that is not food or a bed, or race anyone. Eating clears it instantly.' }));
        if (!f) return;
        body.append(label('The nearest food'));
        body.append(card({
          glyph: f.ico, t: f.n,
          d: [f.zone, f.here ? 'you are here' : f.hops + ' hop' + (f.hops === 1 ? '' : 's'),
            f.open ? 'open now' : 'opens at ' + f.opens].join(' · '),
          m: money(f.cost), ms: 'fills ' + f.fill,
          mColor: f.afford ? BRAND.good : BRAND.warn,
        }));
        const bar = h('div.w-row', { style: { marginTop: 'calc(10px * var(--w-ts))' } });
        if (f.here && f.open) {
          bar.append(h('button.w-btn.prim.w-pe', {
            type: 'button', style: { flex: '1' },
            onclick: () => {
              const e = game.actions.eatAct(f.act);
              if (e.ok) { ui.sfx('coin'); ui.toast('That is better', 'good'); self._close(); ui.refresh(); ui.rebuildTop(); }
              else res(e);
            },
          }, 'Eat here · ' + money(f.cost)));
        } else if (f.open) {
          bar.append(h('button.w-btn.prim.w-pe', {
            type: 'button', style: { flex: '1' },
            onclick: () => { self._close(); ui.goto(f.id, 'Eat at ' + f.n); },
          }, icon('pin', 15), 'Go to ' + f.n));
        } else {
          bar.append(h('button.w-btn.w-pe', {
            type: 'button', style: { flex: '1' },
            onclick: () => { self._close(); ui.goto(f.id, 'Eat at ' + f.n); },
          }, icon('pin', 15), 'Wait outside ' + f.n));
        }
        /* THE FLOOR. Broke and starving must never be terminal, and
           the offer only exists when it is the only way out. */
        if (n.slate && n.slate.ok) {
          bar.append(h('button.w-btn.ghost.w-pe', {
            type: 'button', title: 'They will put it on the slate',
            onclick: () => {
              const e = game.actions.slateMeal();
              if (e.ok) { ui.sfx('coin'); self._close(); ui.refresh(); ui.rebuildTop(); } else res(e);
            },
          }, 'Ask for the slate'));
        } else if (!f.afford) {
          body.append(h('div.w-note', { text:
            'You cannot pay for that yet. Get to ' + f.n
            + ' anyway — at maximum hunger and out of cash they will feed you on the slate, once a day.' }));
        }
        body.append(bar);
        return;
      }

      /* ---- closed ---- */
      const locId = r.loc || st.loc;
      const info = game.openInfo(locId);
      const loc = game.data.locationById[locId];
      body.append(label('When it opens'));
      put(body,
        kv('Hours', info ? info.span : '—'),
        kv('Now', game.hud().clock.split(' · ')[0]),
        kv('Opens in', info && info.opensInHours ? info.opensInHours + ' hour' + (info.opensInHours === 1 ? '' : 's') : 'it is open'),
      );
      body.append(label('Things to do until then'));
      /* THE HOURS ARE A CLOCK PROBLEM, so every route out spends the
         clock: sleep to the morning, work a shift, or go somewhere
         that IS open right now. */
      const bed = game.data.locations.find((l) => l.acts.includes('sleep') && game.known(l.id));
      if (bed) {
        body.append(card({
          ic: 'bed', t: bed.id === st.loc ? 'Sleep until morning' : 'Sleep at ' + bed.n,
          d: 'Ends the day. You wake in the morning with full energy, and it will be open.',
          onclick: () => {
            self._close();
            if (bed.id === st.loc) { game.actions.sleep(); ui.closeAll(); ui.refresh(); }
            else ui.goto(bed.id, 'Sleep');
          },
        }));
      }
      const openNow = game.data.locations
        .filter((l) => l.id !== locId && game.known(l.id) && game.isOpen(l.id) && l.acts.length > 1)
        .slice(0, 3);
      for (const l of openNow) {
        body.append(card({
          glyph: l.ico, t: l.n, d: game.data.zones[l.z].n + ' · open now',
          m: 'Go', mColor: BRAND.token2,
          onclick: () => { self._close(); ui.goto(l.id, l.n); },
        }));
      }
      if (loc) {
        body.append(h('button.w-btn.ghost.w-pe', {
          type: 'button', style: { width: '100%', marginTop: 'calc(9px * var(--w-ts))' },
          onclick: () => { ui.click(); ui.setDestination(loc.id); ui.toast('Pointing you at ' + loc.n, 'token'); self._close(); },
        }, icon('nav', 15, { fill: 'currentColor', w: 1 }), 'Come back to ' + loc.n + ' at ' + (info ? info.opens : '')));
      }
    });
  }

  function card(o) {
    const btn = h('button.w-card' + (o.onclick ? '.w-pe' : ''), {
      type: 'button',
      disabled: o.disabled,
      /* the event is forwarded so a card can close the sheet it is
         printed on rather than the top of the stack — ui.closeSheet() */
      onclick: o.onclick ? (e) => { ui.click(); o.onclick(e); } : null,
    },
      o.node || h('div.ic', {
        style: o.glyph ? { fontSize: '17px' } : null,
      }, o.glyph ? document.createTextNode(o.glyph) : icon(o.ic || 'info', 17)),
      /* `asset` leads the title with the symbol; `t` is the plain form */
      o.asset ? assetNode(o.asset, { sub: o.d, qty: o.qty })
        : h('div.w-grow', null,
          h('div.t', { text: o.t }),
          o.d ? h('div.d', { text: o.d }) : null),
      o.m ? h('div.m', { style: o.mColor ? { color: C(o.mColor) } : null, text: o.m },
        o.ms ? h('small', { text: o.ms }) : null) : null);
    if (!o.onclick) btn.style.cursor = 'default';
    return btn;
  }
  const label = (t) => h('div.w-label', { text: t });
  const kv = (k, v) => h('div.w-kv', null, h('span', { text: k }), h('b', { text: v }));
  /* Element.append() stringifies null — always go through this. */
  const put = (parent, ...nodes) => { for (const n of nodes) if (n) parent.append(n); return parent; };
  const hoursLine = (loc, open) => (
    loc.hours[0] === 0 && loc.hours[1] === 24 ? 'always open'
      : open ? 'open until ' + pad2(loc.hours[1]) + ':00'
        : 'closed · ' + pad2(loc.hours[0]) + ':00–' + pad2(loc.hours[1]) + ':00');
  const hoursSpan = (hrs) => pad2(hrs[0]) + ':00–' + pad2(hrs[1]) + ':00';

  /* ============================================================
     THE ASK — the answer to "why is the buy button more than the
     price?"

     It is not a bug. economy.buyPrice() is price × (1 + venue
     spread): the list quotes the MID, the button charges the ASK,
     and nothing on screen ever said so. Every surface where a price
     and a buy control sit together now leads with the ask and prints
     the mid and the spread underneath it, in cash, so the difference
     is a stated fee rather than a discrepancy.

     askBlock  the headline, for a ticket
     askSub    the same thing in one line, for a list row
     ============================================================ */
  function askBlock(a, vs, unit, mid) {
    const each = Math.round((unit - mid) * 100) / 100;
    const pct = Math.round((vs.v.spread || 0) * 100);
    return h('div.w-ask', null,
      h('div.row', null,
        h('span.k', { text: 'Ask · what you pay' }),
        h('b.v', { text: money2(unit) }),
        h('span.u', { text: 'each' })),
      h('div.brk', null,
        h('span', null, 'mid ', h('b', { text: money2(mid) })),
        h('span.op', { text: '+' }),
        h('span', null, vs.v.name + ' spread ' + pct + '% ', h('b', { text: money2(each) }))));
  }
  /* one line for a list row: "ask · mid $410.00 + 7%" */
  const askSub = (mid, pct) => 'mid ' + money2(mid) + ' + ' + pct + '% spread';

  /* ============================================================
     THE ASSET ROW — ticker first, everywhere.

     data.js says an order should read like a trade ticket, and the
     symbol is what makes it one. Every list in this file that names
     an asset goes through here so the symbol column lines up down
     the page and the eye can scan it.
     ============================================================ */
  function assetNode(a, opts = {}) {
    return h('div.w-grow', null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 'calc(7px * var(--w-ts))' } },
        tickerTag(a, { hot: opts.hot, qty: opts.qty }),
        h('span', {
          text: a.n,
          style: {
            fontSize: 'calc(12.4px * var(--w-ts))', fontWeight: '700',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        })),
      opts.sub ? h('div.d', { text: opts.sub }) : null);
  }

  /* ============================================================
     WHERE A TICKER TRADES — the one resolver every buy path uses.

     Three separate gates used to be spread across three panels and
     none of them was ever stated to the player: the venue has to be
     open to you at all, it has to be open at this hour, and you have
     to be standing in it. Answering all three in one object is what
     lets the quick-buy sheet say "the Mineral Exchange, Iron Hills,
     07:00–17:00, you are not there" instead of greying a button.
     ============================================================ */
  function venueOf(assetLike) {
    const game = g();
    const a = game.economy.assetOf(assetLike);
    if (!a) return null;
    const ven = a.ven;
    const v = game.data.venues[ven];
    const locId = game.data.venueLoc[ven];
    const loc = game.data.locationById[locId];
    const access = game.economy.venueOpen(ven);
    const openNow = game.economy.venueOpenNow(ven);
    const known = game.known(locId);
    const here = game.state.loc === locId;
    return {
      a, ven, v, locId, loc, access, openNow, known, here,
      zone: loc ? game.data.zones[loc.z] : null,
      canBuy: access && openNow && here,
      why: !known ? 'You have not heard of ' + (v ? v.name : 'that venue') + ' yet.'
        : !access ? v.name + ' does not deal with you yet.'
          : !here ? 'Traded at ' + v.name + ' — you are not there.'
            : !openNow ? v.name + ' is closed until ' + pad2(v.hours[0]) + ':00.'
              : null,
    };
  }

  /* a 62x18 price sparkline — six days of closes, no axes */
  function spark(id, wide = 62) {
    const hist = g().economy.history(id);
    if (!hist || hist.length < 3) return null;
    const pts = hist.slice(-14);
    const lo = Math.min(...pts), hi = Math.max(...pts);
    const span = hi - lo || 1;
    const H = 18;
    const d = pts.map((p, i) =>
      (i ? 'L' : 'M') + ((i / (pts.length - 1)) * wide).toFixed(1) + ' '
      + (H - 2 - ((p - lo) / span) * (H - 4)).toFixed(1)).join('');
    const up = pts[pts.length - 1] >= pts[0];
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', `0 0 ${wide} ${H}`);
    s.setAttribute('width', wide); s.setAttribute('height', H);
    s.setAttribute('class', 'w-i');
    s.innerHTML = `<path d="${d}" fill="none" stroke="${C(up ? BRAND.good : BRAND.bad)}"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
    return s;
  }

  /* ============================================================
     QUICK BUY — the whole point of the exercise.

     "It is unclear how to actually buy an asset. Buying a ticker
     should be as easy as going to the trading floor exchange."

     So: type a symbol or a name, see the price, the spread, the
     venue and whether it is open, set a quantity, read the total
     and the cash it leaves you with, and confirm. Everything the
     purchase costs is on screen BEFORE the button, and when it
     cannot happen here the sheet says where it can and offers to
     take you.
     ============================================================ */
  function quickBuy(preset) {
    const game = g();
    const E = game.economy;

    /* These live outside the build callback on purpose: the sheet's
       _rebuild() clears the body, and a search box that forgets what
       you typed every time a number changes is not a search box. */
    let query = '';
    let pickId = E.assetOf(preset) ? E.idOf(preset) : null;
    let qty = 1;
    /* assigned at the bottom; the buttons that read it only fire long
       after the sheet exists */
    let sheetEl = null;

    const input = h('input.w-pe', {
      type: 'text', spellcheck: 'false', autocomplete: 'off',
      'aria-label': 'Ticker or name',
      placeholder: 'Ticker or name — GOLD, wheat, B5Y…',
      oninput: () => { query = input.value; pickId = null; qty = 1; paint(); },
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const hit = E.findByTicker(query) || E.search(query, 1)[0];
        if (hit) { pickId = hit.id; qty = 1; paint(); }
      },
    });
    const results = h('div');
    const ticket = h('div');

    function paint() {
      renderResults();
      renderTicket();
    }

    /* ---- what to offer when the box is empty ----
       Not "all 69 assets", and not nothing: the things the player
       has a reason to buy right now. An open order they cannot yet
       fill is the single most useful row this sheet can show. */
    function suggestions() {
      const st = game.state;
      const out = [];
      const seen = new Set();
      const push = (id, tag) => {
        const a = E.assetOf(id);
        if (!a || seen.has(a.id)) return;
        seen.add(a.id);
        out.push({ a, tag });
      };
      for (const o of st.orders) {
        for (const it of o.items) {
          if (E.free(it.a) + 1e-4 >= it.q) continue;
          push(it.a, 'an open order needs it');
        }
      }
      for (const o of st.arrivals) for (const it of o.items) push(it.a, 'a waiting client wants it');
      const hereVen = (game.here()?.acts || [])
        .filter((s) => s.startsWith('market:')).map((s) => s.split(':')[1]);
      for (const v of hereVen) {
        for (const a of game.data.assets.filter((x) => x.ven === v).slice(0, 6)) push(a.id, 'sold right here');
      }
      for (const id of Object.keys(st.inv)) if (st.inv[id].qty > 0) push(id, 'you already hold some');
      return out.slice(0, 8);
    }

    function renderResults() {
      clear(results);
      if (pickId) return;                        // the ticket replaces the list
      const q = query.trim();
      const rows = q ? E.search(q, 9).map((a) => ({ a, tag: null })) : suggestions();
      results.append(label(q ? rows.length + ' match' + (rows.length === 1 ? '' : 'es') : 'Worth buying now'));
      if (!rows.length) {
        results.append(h('div.w-empty', {
          text: 'Nothing in this city is called “' + q + '”. Try a symbol: GOLD, WHEAT, B5Y, TEAM.',
        }));
        return;
      }
      for (const { a, tag } of rows) {
        const vs = venueOf(a.id);
        const held = E.owned(a.id);
        /* THE NUMBER ON A ROW WITH A BUY IN IT IS THE ASK. The venue,
           whether it is open and whether you already hold some move
           down to the subtitle so the money column can carry the mid
           and the spread that explain the figure above it. */
        const ask = E.buyPrice(a.id, vs.ven);
        const mid = E.price(a.id);
        const sub = [tag, a.cat, vs.v.name + (vs.openNow ? '' : ' · closed'),
          vs.canBuy ? 'buy here' : vs.openNow ? 'not sold here' : null,
          held ? 'you hold ' + held : null].filter(Boolean).join(' · ');
        const row = h('button.w-card.w-pe', {
          type: 'button',
          onclick: () => { ui.click(); pickId = a.id; qty = 1; paint(); },
        },
          h('div.ic', {
            style: { fontSize: '17px', background: rgba(CATEGORY[a.cat] ?? BRAND.info, 0.16) },
            text: a.ico,
          }),
          assetNode(a, { sub }),
          h('div.m', {
            text: money2(ask),
            style: { color: C(vs.canBuy ? BRAND.ink : BRAND.warn) },
          }, h('small', { text: 'ask · ' + askSub(mid, Math.round(vs.v.spread * 100)) })));
        results.append(row);
      }
    }

    function renderTicket() {
      clear(ticket);
      if (!pickId) return;
      const a = E.assetOf(pickId);
      if (!a) { pickId = null; return; }
      const st = game.state;
      const vs = venueOf(a.id);

      const unit = E.buyPrice(a.id, vs.ven);
      const mid = E.price(a.id);
      const spreadEach = Math.max(0, unit - mid);
      const space = Math.max(0, Math.floor(E.invCap() - E.invCount()));
      const canAfford = Math.floor(st.money / Math.max(0.01, unit));
      const most = Math.max(1, Math.min(space, canAfford));
      qty = clamp(Math.round(qty), 1, Math.max(1, most));
      const total = Math.round(unit * qty * 100) / 100;
      const fees = Math.round(spreadEach * qty * 100) / 100;
      const after = Math.round((st.money - total) * 100) / 100;

      const card = h('div.w-tkt');
      const sp = spark(a.id);
      card.append(h('div.hd', null,
        h('div.ic', {
          style: {
            fontSize: '20px', width: 'calc(38px * var(--w-ts))', height: 'calc(38px * var(--w-ts))',
            borderRadius: 'calc(12px * var(--w-ts))', display: 'grid', placeItems: 'center', flex: 'none',
            background: rgba(CATEGORY[a.cat] ?? BRAND.info, 0.18),
          },
          text: a.ico,
        }),
        h('div.w-grow', null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            tickerTag(a, { lg: true, hot: true })),
          h('div.nm', { text: a.n, style: { marginTop: '4px' } }),
          h('div.sb', { text: a.cat + ' · liquidity ' + a.q + '/5' })),
        sp));

      /* WHERE IT TRADES — the line that was missing, and the reason
         a player could hold an order for GOLD for three days without
         ever finding out that gold is sold in Iron Hills. Several
         venues share a name with their building, so say it once. */
      const where = [vs.v.name];
      if (vs.loc && vs.loc.n !== vs.v.name) where.push(vs.loc.n);
      if (vs.zone) where.push(vs.zone.n);
      card.append(h('div.sb', {
        style: { marginTop: 'calc(9px * var(--w-ts))', opacity: '.82' },
      }, h('b', { text: where.shift() }),
        where.length ? ' · ' + where.join(' · ') : '',
        ' · ', hoursSpan(vs.v.hours)));

      /* THE ASK, AS THE HEADLINE. "Why is the buy button more than the
         price?" — because the price everyone quotes is the MID, and
         you buy at the ASK, which is the mid plus the venue's spread.
         Where a purchase is about to happen the ask leads and the mid
         is the footnote, never the other way round. */
      card.append(askBlock(a, vs, unit, mid));

      /* ---- quantity ---- */
      const num = h('span.n', { text: String(qty) });
      const set = (n) => { qty = clamp(Math.round(n), 1, Math.max(1, most)); renderTicket(); };
      card.append(h('div.w-qty', null,
        h('button.stp.w-pe', { type: 'button', 'aria-label': 'One fewer', disabled: qty <= 1,
          onclick: () => { ui.click(); set(qty - 1); } }, icon('minus', 16, { w: 2.2 })),
        num,
        h('button.stp.w-pe', { type: 'button', 'aria-label': 'One more', disabled: qty >= most,
          onclick: () => { ui.click(); set(qty + 1); } }, icon('plus', 16, { w: 2.2 })),
        h('div.pre', null,
          ...[1, 5, 10].filter((n) => n <= most).map((n) =>
            h('button.w-chip.w-pe' + (qty === n ? '.on' : ''), {
              type: 'button', onclick: () => { ui.click(); set(n); },
            }, String(n))),
          most > 1 ? h('button.w-chip.w-pe' + (qty === most ? '.on' : ''), {
            type: 'button', title: 'As many as cash and space allow',
            onclick: () => { ui.click(); set(most); },
          }, 'MAX') : null)));

      /* ---- THE SUM, AND IT HAS TO ADD UP ON SCREEN ----
         Three lines that a player can check with their eyes: the mid
         times the quantity, plus the spread in dollars, equals the
         number printed on the button. Nothing is folded into anything
         else and nothing is left implicit. */
      const signed = (n) => (n < 0 ? '−' + money2(-n) : money2(n));
      const midTotal = Math.round(mid * qty * 100) / 100;
      put(card,
        kv('Mid price · ' + qty + ' × ' + money2(mid), money2(midTotal)),
        kv('Venue spread · ' + Math.round(vs.v.spread * 100) + '% at ' + vs.v.name,
          fees > 0 ? '+ ' + money2(fees) : '+ ' + money2(0)),
        kv('Inventory after', (Math.round((E.invCount() + qty) * 100) / 100) + ' / ' + E.invCap() + ' units'
          + (E.owned(a.id) ? ' · you hold ' + E.owned(a.id) : '')),
      );
      card.append(h('div.w-kv.tot', null,
        h('span', { text: 'Total to pay · ' + qty + ' × ' + money2(unit) + ' ask' }),
        h('b', { text: money2(total) })));
      card.append(h('div.w-kv', null,
        h('span', { text: 'Cash after' }),
        h('b', { text: signed(after), style: { color: C(after < 0 ? BRAND.bad : BRAND.ink) } })));

      /* ---- the verdict, and never a dead end ---- */
      const shortCash = total > st.money;
      const noSpace = E.invCount() + qty > E.invCap();
      if (vs.canBuy && !shortCash && !noSpace) {
        card.append(h('div.warn.ok', { text: 'You are standing in ' + vs.v.name + '. Ready to trade.' }));
        const btn = h('button.w-btn.prim.w-pe', {
          type: 'button', style: { width: '100%', marginTop: 'calc(10px * var(--w-ts))' },
          onclick: () => {
            const r = E.buy(a.id, qty, vs.ven);
            if (!r.ok) { res(r); return; }
            ui.sfx('buy');
            ui.toast('Bought ' + (qty > 1 ? qty + '× ' : '') + a.tick + ' · ' + money2(r.total), 'money');
            ui.refresh();
            qty = 1;
            renderTicket();
          },
        });
        btn.append('Buy ', tickerTag(a, { qty, sm: true }), ' · ' + money2(total));
        card.append(btn);
      } else {
        const reason = shortCash ? 'You are ' + money2(total - st.money) + ' short.'
          : noSpace ? 'No room — your office holds ' + E.invCap() + ' units.'
            : vs.why;
        card.append(h('div.warn' + (vs.canBuy ? '' : '.wait'), { text: reason }));
        /* the route out of every refusal */
        if (!vs.canBuy && vs.known && vs.loc && !vs.here) {
          const bar = h('div', { style: { display: 'flex', gap: '8px', marginTop: 'calc(10px * var(--w-ts))' } });
          bar.append(h('button.w-btn.prim.w-pe', {
            type: 'button', style: { flex: '1' },
            onclick: () => { ui.click(); if (sheetEl) sheetEl._close(); ui.goto(vs.locId, 'Buy ' + a.tick); },
          }, icon('pin', 15), 'Travel to ' + vs.loc.n));
          bar.append(h('button.w-btn.ghost.w-pe', {
            type: 'button', title: 'Point the HUD arrow at it',
            onclick: () => {
              ui.click(); ui.setDestination(vs.locId);
              ui.toast('Pointing you at ' + vs.loc.n, 'token');
            },
          }, icon('nav', 15, { fill: 'currentColor', w: 1 })));
          card.append(bar);
        } else if (!vs.canBuy && !vs.openNow && vs.here) {
          card.append(h('div.sb', {
            style: { marginTop: '8px' },
            text: 'It opens at ' + pad2(vs.v.hours[0]) + ':00. Sleep, eat, or work a shift and come back.',
          }));
        }
      }

      /* back to the search */
      card.append(h('button.w-btn.ghost.w-pe', {
        type: 'button', style: { width: '100%', marginTop: 'calc(8px * var(--w-ts))' },
        onclick: () => { ui.click(); pickId = null; paint(); },
      }, icon('back', 14), 'Search something else'));

      ticket.append(card);
    }

    sheetEl = sheet({
      title: 'Buy an asset',
      sub: 'Every asset in Bull Bear City has a symbol. Type it.',
      glyph: '🧾', tint: BRAND.token,
    }, (body) => {
      const st = game.state;
      body.append(h('div.w-srch', null,
        icon('search', 16, { w: 2 }),
        input,
        h('button.w-btn.sm.ghost.w-pe.clr', {
          type: 'button', 'aria-label': 'Clear',
          style: { minWidth: '30px', padding: '0 7px' },
          onclick: () => { input.value = ''; query = ''; pickId = null; paint(); input.focus(); },
        }, icon('close', 13))));
      body.append(h('div.w-kv', null,
        h('span', { text: 'Cash in hand' }),
        h('b', { text: money2(st.money) })));
      body.append(results, ticket);
      input.value = query;
      paint();
    });
    return sheetEl;
  }

  /* ============================================================
     THE MAP, full size — the phone's Places app expanded.
     ============================================================ */
  function bigMap(startAt) {
    const game = g();
    let sel = startAt || game.state.loc;
    return sheet({
      title: 'Bull Bear City', sub: 'One island, ten districts, 28 places',
      glyph: '🗺️', tint: BRAND.info,
    }, (body, el) => {
      const detail = h('div');
      const map = cityMap(ctx, {
        selected: sel,
        /* PICKING A PLACE IS NOT A JOURNEY, and it is not a waypoint
           either: it opens that place's fare board below the map, and
           the fare board travels. Aiming the HUD arrow is the "Point
           me" button's job and nothing else's — this is what used to
           make walk and bicycle feel like they "only moved the
           arrow". */
        onPick: (id) => { sel = id; ui.sfx('ui.tab'); draw(); },
      });
      body.append(map.el, detail);
      function draw() {
        clear(detail);
        const loc = game.data.locationById[sel];
        if (!loc) return;
        const z = game.data.zones[loc.z];
        detail.append(label(z.n + ' · ' + z.blurb));
        detail.append(card({
          glyph: loc.ico, t: loc.n, d: loc.desc,
          m: game.isOpen(loc.id) ? 'Open' : 'Closed',
          mColor: game.isOpen(loc.id) ? BRAND.good : BRAND.bad,
          ms: hoursSpan(loc.hours),
        }));
        travelModes(detail, sel, () => el._close());
      }
      draw();
    });
  }

  /* ============================================================
     PAUSE
     ============================================================ */
  function pause() {
    const el = h('div.w-pause.w-chrome.w-pe', { role: 'dialog', 'aria-label': 'Paused' });
    const mark = wallyMark(62);
    mark.style.filter = `drop-shadow(0 6px 18px ${rgba(0x05070c, 0.5)})`;
    el.append(h('div.brand', null, mark,
      h('div.wm', { text: 'WALLY RPG' }),
      h('div.sm', { text: 'Bull Bear City' })));

    const d = g().hud();
    el.append(h('div', {
      style: {
        display: 'flex', justifyContent: 'center', gap: '14px', margin: '2px 0 12px',
        fontSize: 'calc(11px * var(--w-ts))', fontWeight: '700', color: 'var(--w-dim)',
      },
    },
      h('span', { text: 'Day ' + d.day }),
      h('span', { text: money(d.money) }),
      h('span', { text: Math.round(d.rep) + ' rep' }),
      h('span', { text: d.cityPct + '% city' })));

    const b = (txt, ic, fn, cls = 'dark') => h('button.w-btn.' + cls + '.w-pe', {
      type: 'button', onclick: () => { ui.click(); fn(); },
    }, icon(ic, 16), txt);

    put(el,
      b('Resume', 'play', () => ui.hide('pause'), 'prim'),
      b('Phone', 'phone', () => { ui.hide('pause'); ui.openPhone(); }),
      b('Your desk', 'door', () => { ui.hide('pause'); ui.openDesk(); }),
      b('Settings', 'gear', () => ui.pushSheet(settings())),
      b('Save', 'save', () => { const ok = g().save(); ui.toast(ok ? 'Progress saved' : 'Could not save', ok ? 'good' : 'bad'); }),
      g().hasSave() ? b('Load last save', 'book', () => {
        if (g().load()) { ui.toast('Save loaded', 'good'); ui.closeAll(); ui.refresh(); }
        else ui.toast('No save found', 'bad');
      }) : null,
    );
    return el;
  }

  /* ============================================================
     SETTINGS  (shared by the pause menu and the phone app)
     ============================================================ */
  function settings() {
    return sheet({ title: 'Settings', sub: 'Sound, picture, comfort, saves', glyph: '⚙️', tint: BUILD.metal },
      (body) => renderSettings(body));
  }

  function renderSettings(body) {
    const st = g().state;
    const S = st.settings;

    /* ---- sound ---- */
    body.append(label('Sound'));
    body.append(slider('Music', ctx.audio?.musicVolume ?? S.music, (v) => {
      S.music = v;
      if (ctx.audio) ctx.audio.musicVolume = v;
    }));
    body.append(slider('Effects', ctx.audio?.sfxVolume ?? S.sfx, (v) => {
      S.sfx = v;
      if (ctx.audio) ctx.audio.sfxVolume = v;
      ui.sfx('ui.click');
    }));

    /* ---- picture ---- */
    body.append(label('Picture'));
    const tiers = ['low', 'med', 'high', 'ultra'];
    body.append(chips('Quality', tiers, tierName(ctx.quality?.name), (v) => {
      try {
        ctx.render?.setQuality(QUALITY_TIERS[v]);
        ui.toast('Quality: ' + v, 'info');
      } catch (e) { ui.toast('Could not change quality', 'bad'); }
    }, tiers.map((t) => t.toUpperCase())));

    /* ---- comfort ---- */
    body.append(label('Comfort'));
    const sizes = ['0.9', '1', '1.15', '1.3'];
    body.append(chips('Text size', sizes, String(S.textSize || 1), (v) => {
      S.textSize = +v;
      ui.setTextSize(+v);
    }, ['S', 'M', 'L', 'XL']));
    body.append(toggle('Reduced motion', !!S.reduced, (on) => { S.reduced = on; ui.setReducedMotion(on); }));
    body.append(toggle('High contrast', !!S.contrast, (on) => { S.contrast = on; ui.setHighContrast(on); }));
    body.append(toggle('Relaxed pace', !!S.relaxed, (on) => {
      S.relaxed = on;
      ui.toast(on ? 'Everything takes 30% less time' : 'Normal pace', 'info');
    }));
    /* Auto-on for a phone; here so a touchscreen laptop, or anyone who
       would rather thumb it than type, can have them on demand. */
    body.append(toggle('Touch controls', !!ui.touch?.enabled, (on) => {
      ui.setTouch(on);
      ui.toast(on ? 'Thumbstick on' : 'Thumbstick off', 'info');
    }));
    /* LANDSCAPE PLAY. A phone row, under Comfort with the other
       device choices rather than up in its own headline section:
       portrait is the game, this is the option somebody goes
       looking for. Absent entirely on a desktop, and on a browser
       that cannot rotate anything it arrives WITHOUT a switch —
       see landscapeRow(). */
    if (ui.orient?.handheld) body.append(landscapeRow());

    /* ---- saves ---- */
    body.append(label('Your game'));
    body.append(h('div.w-row', null,
      h('button.w-btn.prim.w-pe', { type: 'button', onclick: () => {
        const ok = g().save();
        ui.toast(ok ? 'Progress saved' : 'Could not save', ok ? 'good' : 'bad');
      } }, icon('save', 15), 'Save'),
      h('button.w-btn.ghost.w-pe', { type: 'button', disabled: !g().hasSave(), onclick: () => {
        if (g().load()) { ui.toast('Save loaded', 'good'); ui.closeAll(); ui.refresh(); }
        else ui.toast('No save found', 'bad');
      } }, icon('book', 15), 'Load'),
      h('button.w-btn.ghost.w-pe', { type: 'button', onclick: () => {
        const r = g().downloadSave();
        if (r && r.ok) ui.toast('Save file downloaded', 'good');
        else showExport();
      } }, icon('save', 15), 'Export'),
      h('button.w-btn.ghost.w-pe', { type: 'button', onclick: () => showImport() }, icon('info', 15), 'Import'),
    ));

    const io = h('div');
    body.append(io);

    function showExport() {
      clear(io);
      const ta = h('textarea.w-ta.w-pe', { readonly: true });
      ta.value = g().exportSave();
      io.append(label('Save data'), ta,
        h('button.w-btn.sm.ghost.w-pe', { type: 'button', onclick: () => { ta.select(); document.execCommand?.('copy'); ui.toast('Copied', 'good'); } }, 'Copy'));
    }
    function showImport() {
      clear(io);
      const ta = h('textarea.w-ta.w-pe', { placeholder: 'Paste a WALLY RPG save file here…' });
      io.append(label('Import a save'), ta,
        h('button.w-btn.sm.prim.w-pe', { type: 'button', onclick: () => {
          const d = g().importSave(ta.value.trim());
          if (d) { ui.toast('Save imported', 'good'); ui.closeAll(); ui.refresh(); }
          else { ui.toast('That is not a WALLY RPG save', 'bad'); ui.sfx('ui.error'); }
        } }, 'Import'));
    }

    body.append(label('Danger'));
    let armed = false;
    const nb = h('button.w-btn.ghost.w-pe', {
      type: 'button',
      style: { width: '100%', color: C(BRAND.bad), boxShadow: `inset 0 0 0 1.5px ${rgba(BRAND.bad, 0.4)}` },
      onclick: () => {
        if (!armed) { armed = true; nb.textContent = 'Tap again to erase everything'; ui.sfx('ui.error'); return; }
        g().wipeSave();
        g().newGame();
        ui.closeAll();
        ui.refresh();
        ui.banner('DAY 1', 'A folding table and a poster');
      },
    }, 'Start a new game');
    body.append(nb);

    body.append(h('div', {
      style: { textAlign: 'center', opacity: '.4', fontSize: '10px', marginTop: '16px', letterSpacing: '.1em' },
      text: 'WALLY RPG · save v' + g().data.config.version,
    }));
  }

  function tierName(n) {
    if (!n) return 'high';
    const s = String(n).replace(/\(.*\)/, '');
    return QUALITY_TIERS[s] ? s : 'high';
  }

  function slider(name, value, onInput) {
    const val = h('b', { text: Math.round(value * 100) + '%' });
    const inp = h('input.w-slider.w-pe', {
      type: 'range', min: '0', max: '1', step: '0.02', value: String(value),
      oninput: (e) => { const v = +e.target.value; val.textContent = Math.round(v * 100) + '%'; onInput(v); },
    });
    return h('div', { style: { marginBottom: '12px' } },
      h('div.w-kv', { style: { borderBottom: '0', paddingBottom: '4px' } }, h('span', { text: name }), val), inp);
  }
  function toggle(name, on, onChange) {
    const sw = h('button.w-switch.w-pe' + (on ? '.on' : ''), { type: 'button', role: 'switch' });
    sw.addEventListener('click', () => {
      const next = !sw.classList.contains('on');
      sw.classList.toggle('on', next);
      ui.click();
      onChange(next);
    });
    return h('div.w-kv', null, h('span', { text: name }), sw);
  }
  /* ============================================================
     LANDSCAPE PLAY — the row, and the two shapes it takes

     ui/orient.js decides which. Where the browser can genuinely hold
     the phone sideways (`mode: 'lock'`) this is a switch like any
     other. Where it cannot — iOS Safari has no orientation lock and
     no element fullscreen — the switch is REMOVED rather than left
     to do nothing, and the row becomes the honest instruction: turn
     the phone yourself, the game is laid out for it. That second
     sentence is only true because the landscape layout in style.js
     triggers on the viewport rather than on this preference.

     The line underneath reports what is ACTUALLY happening, not what
     was asked for, and repaints on every change — a lock dies when
     fullscreen closes or the tab is backgrounded, and the row must
     never keep claiming a state the page is not in.
     ============================================================ */
  function landscapeRow() {
    const or = ui.orient;
    const note = h('div.sub');
    let sw = null;

    const head = h('div.w-kv', null, h('span', { text: 'Landscape play' }));
    if (or.mode === 'lock') {
      sw = h('button.w-switch.w-pe', {
        type: 'button', role: 'switch', 'aria-label': 'Landscape play',
      });
      sw.addEventListener('click', () => {
        const next = !sw.classList.contains('on');
        sw.classList.toggle('on', next);
        /* STRAIGHT OUT OF THE GESTURE, first thing. requestFullscreen
           and screen.orientation.lock are both gated on user
           activation; anything that yields in front of this call
           loses the lock and the row would then have to explain a
           failure we caused ourselves. The click sound comes after. */
        ui.setLandscape(next);
        ui.click();
      });
      head.append(sw);
    } else {
      head.append(h('span.w-tagoff', { text: 'Not on this browser' }));
    }

    const wrap = h('div.w-lsrow', null, head, note);
    const paint = (s) => {
      s = s || or.status();
      if (sw) sw.classList.toggle('on', s.want);
      note.textContent = landscapeNote(s);
      wrap.classList.toggle('warn', s.why === 'refused' || s.why === 'nofullscreen');
    };
    /* Self-cancelling: a sheet body is rebuilt on every refresh and
       there is no teardown hook on a row, so the subscription drops
       itself the first time it fires after the node left the tree. */
    const stop = or.onChange((s) => {
      if (!wrap.isConnected) { stop(); return; }
      paint(s);
    });
    paint();
    return wrap;
  }

  function landscapeNote(s) {
    if (s.mode !== 'lock') {
      return s.landscape
        ? 'This browser will not turn the screen for you — but you are sideways already, and the game is laid out for it.'
        : 'This browser will not turn the screen for you. Turn the phone sideways yourself and the game lays itself out for landscape.';
    }
    if (!s.want) return 'Goes fullscreen and holds the game sideways. Portrait stays the default.';
    if (s.locked) return 'Held sideways. Switch it off here to go back to portrait.';
    if (s.why === 'refused') return 'Your phone would not turn — check its own rotation lock, then tap this again.';
    if (s.why === 'nofullscreen') return 'This browser refused fullscreen, which is where the lock lives. Turning the phone by hand still works.';
    return 'Waiting for a tap — touch the screen to hold it sideways again.';
  }

  function chips(name, values, active, onPick, labels) {
    const bar = h('div.w-chipbar');
    values.forEach((v, i) => {
      const c = h('button.w-chip.w-pe' + (String(v) === String(active) ? '.on' : ''), {
        type: 'button',
        text: (labels && labels[i]) || v,
        onclick: () => {
          for (const k of bar.children) k.classList.remove('on');
          c.classList.add('on');
          ui.click();
          onPick(v);
        },
      });
      bar.append(c);
    });
    return h('div', { style: { marginBottom: '10px' } },
      h('div.w-kv', { style: { borderBottom: '0', paddingBottom: '5px' } }, h('span', { text: name })), bar);
  }

  /* ============================================================
     TRAVEL — the mode board.

     Shared by the travel sheet, the expanded map and the phone's
     Places app, so a fare is quoted the same way wherever it is
     read. Every mode from game.fares() appears, priced in all three
     of its currencies — dollars, minutes and energy — and a mode
     that cannot be taken says why instead of vanishing.

     THE MAP IS A TRAVEL SCREEN. Every row on this board TRAVELS,
     and that is the whole contract: tap a mode, pay that mode's
     time, money and energy, arrive. Nothing here plants a waypoint
     and calls it a journey — the "Point me" button in the Places app
     is the one control that aims the HUD arrow, and it says so.

     THE RIDE ROW IS WHATEVER IS IN THE SHED. game.fares() prices the
     'bike' row at the equipped ride, or failing that at the best one
     owned, so a scooter's row says Scooter and quotes scooter
     minutes. Owned but left at home used to be a dead row with an
     Equip button beside it — two taps, and the first of them did not
     travel. It now takes the ride WITH him and goes, in one tap,
     because "get the bike and ride there" is one intention.
     Unowned, the row is replaced by the garage offer below, which
     lists everything sold at all: a price to save for, not a grey
     line saying no.
     ============================================================ */
  const MODE_ICON = { walk: 'foot', bike: 'bike', train: 'train', trunk: 'car' };

  function travelModes(body, locId, onDone) {
    const game = g();
    const st = game.state;
    const loc = game.data.locationById[locId];
    if (!loc) return;

    if (st.loc === locId) {
      body.append(h('div.w-empty', { text: 'You are already here.' }));
      body.append(h('button.w-btn.prim.w-pe', {
        type: 'button', style: { width: '100%' },
        onclick: (e) => { ui.closeSheet(e.currentTarget); ui.openPlace(locId); },
      }, 'Look around'));
      return;
    }

    const bike = game.actions.bike();
    body.append(label('How do you want to get there'));

    /* ONE PATH OUT OF THIS BOARD, so no mode can behave differently
       from any other. Every row ends here. */
    const go = (mode) => {
      const r = game.travel(locId, mode);
      if (!r.ok) { res(r); return; }
      ui.sfx(mode === 'walk' ? 'step.dirt' : mode === 'train' ? 'train.horn' : 'ui.select');
      ui.setDestination(null);
      ui.refresh();
      ui.rebuildTop();
      ui.toast('Arrived at ' + loc.n, 'token');
      onDone ? onDone() : ui.closeSheet(body);
      ui.openPlace(locId);
    };

    for (const f of game.fares(locId)) {
      if (f.mode === 'bike' && !bike.owned) continue;      // the garage, below
      const bits = [f.mins + ' min'];
      if (f.energy) bits.push(f.energy + ' energy');
      if (f.metres) bits.push(f.metres + ' m');
      /* Left at home is not a refusal, it is a step this row will
         take for you — say so rather than quoting the engine's why. */
      const fetch = f.mode === 'bike' && bike.owned && !bike.equipped;
      const detail = fetch ? bits.join(' · ') + ' · takes the ' + bike.short.toLowerCase() + ' with you'
        : f.ok ? bits.join(' · ') + (f.warn ? ' · ' + f.warn : '') : f.why;
      body.append(card({
        ic: MODE_ICON[f.mode] || 'foot',
        t: f.n,
        d: detail,
        m: f.cost ? money(f.cost) : 'Free',
        mColor: !f.ok && !fetch ? BRAND.bad : f.trudge ? BRAND.warn : f.cost ? BRAND.ink : BRAND.good,
        ms: f.hops ? f.hops + (f.hops === 1 ? ' hop' : ' hops') : null,
        disabled: !f.ok && !fetch,
        onclick: (!f.ok && !fetch) ? null : () => {
          if (fetch) {
            const e = game.actions.equipRide(bike.id);
            if (!e.ok) { res(e); return; }
          }
          go(f.mode);
        },
      }));
    }

    if (!bike.owned) for (const el of rideOffers()) body.append(el);

    body.append(h('div', {
      style: { fontSize: '11px', opacity: '.55', marginTop: '10px', lineHeight: '1.5' },
      text: 'Or close this and walk there yourself — the island is one continuous place, and the door will prompt you when you reach it.',
    }));
  }

  /* ============================================================
     THE RIDES, AS ROWS — one function, three (and later more)
     vehicles, all of them read out of data.js RIDES.

     This used to be bikeOffer(): one hard-coded bicycle in three
     states. data.js now holds a TABLE — bicycle, scooter,
     motorcycle, each with a speed, an effort and an unlock — and a
     fourth vehicle should cost nobody a new card. So there is one
     row builder, and every list that shows a ride (the fare board,
     a shop's counter, the phone's garage) feeds it rows from
     game.actions.rides() / ridesFor().

     A LOCKED RIDE IS A GOAL, NOT A DEAD ROW. It quotes its speed
     against the bicycle, and it says exactly how it is obtained: a
     price and a shop, or the quest that hands it over.
     ============================================================ */
  const RIDE_ICON = { bike: 'bike', scooter: 'bike', motorcycle: 'bike' };

  /* "×1.5 · 50% faster than the bicycle" — the one number that makes
     the whole table legible, said in both registers. */
  function speedLine(r) {
    if (r.speed === 1) return 'The baseline · half the time of walking';
    const pct = Math.round((1 - 1 / r.speed) * 100);
    return '×' + r.speed + ' the bicycle · ' + pct + '% less time on the road';
  }

  /* How you get one, in the words the player needs. `buyable` is
     canBuyRide()'s verdict: standing at the right counter with the
     money in hand, the row should say "take it", not "sold at". */
  function unlockLine(game, r, canBuy) {
    if (canBuy) return 'They have one on the floor right now';
    if (r.unlock === 'quest') {
      const q = game.data.sideQuestById?.[r.questId] || game.data.questById?.[r.questId];
      return 'Not for sale at any price · ' + (q ? q.t : 'a favour returned');
    }
    const shops = (r.locs || []).map((id) => game.data.locationById[id]).filter(Boolean);
    const known = shops.filter((l) => game.known(l.id));
    const where = (known.length ? known : shops).map((l) => l.n).join(' or ');
    return (r.rep ? 'Reputation ' + r.rep + ' · ' : '') + (where ? 'sold at ' + where : 'sold in the city');
  }

  /* ONE RIDE, ONE ROW. `opts.onChange` is called after anything that
     changes ownership or what is equipped, so the list can redraw. */
  function rideRow(r, opts = {}) {
    const game = g();
    const redraw = opts.onChange || (() => ui.rebuildTop());

    if (r.owned) {
      const on = r.equipped;
      /* No status word AND a button that says the same thing: the
         button is the status, and the row needs the width for the
         speed line more than it needs to say "Riding" twice. */
      const row = card({
        glyph: r.ico,
        t: r.n,
        d: (on ? 'With you · ' : 'In the shed · ') + speedLine(r),
      });
      row.classList.toggle('on', on);
      row.append(h('button.w-btn.sm.' + (on ? 'ghost' : 'prim') + '.w-pe', {
        type: 'button', style: { marginLeft: '8px' },
        onclick: (e) => {
          e.stopPropagation();
          const res2 = game.actions.equipRide(on ? null : r.id);
          if (!res2.ok) { res(res2); return; }
          ui.sfx('ui.select');
          ui.toast(on ? r.short + ' left behind' : r.short + ' with you', on ? 'info' : 'good');
          ui.refresh();
          redraw();
        },
      }, on ? 'Unequip' : 'Equip'));
      return row;
    }

    /* ---- locked ---- */
    const chk = r.buyable ? game.actions.canBuyRide(r.id) : { ok: false };
    const row = card({
      glyph: r.ico,
      t: r.n,
      d: speedLine(r) + ' · ' + unlockLine(game, r, chk.ok),
      m: r.buyable ? money(r.price) : 'Quest',
      mColor: chk.ok ? BRAND.good : r.buyable ? BRAND.warn : BRAND.gem,
      ms: r.buyable ? (chk.ok ? 'buy it here' : 'locked') : 'earned',
    });
    row.classList.add('locked');
    if (chk.ok) {
      row.append(h('button.w-btn.sm.prim.w-pe', {
        type: 'button', style: { marginLeft: '8px' },
        onclick: (e) => {
          e.stopPropagation();
          const bought = game.actions.buyRide(r.id);
          if (!bought.ok) { res(bought); return; }
          ui.sfx('levelup');
          ui.toast('The ' + r.short.toLowerCase() + ' is yours', 'money');
          ui.refresh();
          redraw();
        },
      }, 'Buy'));
    } else {
      /* Point at wherever it comes from — the shop, or the person
         whose quest hands it over. A goal you cannot walk towards is
         not a goal. */
      const at = r.buyable
        ? (r.locs || []).map((id) => game.data.locationById[id]).find((l) => l && game.known(l.id))
        : (() => {
          const q = game.data.sideQuestById?.[r.questId];
          const l = q && q.loc ? game.data.locationById[q.loc] : null;
          return l && game.known(l.id) ? l : null;
        })();
      /* Not when he is standing in it — an arrow pointing at your own
         feet is noise. */
      if (at && at.id !== game.state.loc) {
        row.append(h('button.w-btn.sm.ghost.w-pe', {
          type: 'button', style: { marginLeft: '8px' }, title: 'Point me at ' + at.n,
          onclick: (e) => {
            e.stopPropagation();
            ui.setDestination(at.id);
            ui.toast('Pointing you at ' + at.n, 'token');
          },
        }, icon('nav', 13, { fill: 'currentColor', w: 1 })));
      }
    }
    return row;
  }

  /* Every ride, in one list — the phone's garage. */
  function rideList(opts = {}) {
    return g().actions.rides().filter(Boolean).map((r) => rideRow(r, opts));
  }

  /* The rides worth showing under a fare board he cannot ride: what
     he owns but left behind, then the cheapest thing he could buy. */
  function rideOffers(opts = {}) {
    const all = g().actions.rides().filter(Boolean);
    const owned = all.filter((r) => r.owned);
    if (owned.length) return owned.map((r) => rideRow(r, opts));
    const buyable = all.filter((r) => r.buyable).sort((a, b) => a.price - b.price);
    return buyable.slice(0, 1).map((r) => rideRow(r, opts));
  }

  /* What this counter sells. data.js puts a 'bike' act on Dispatch
     and Vic's; Dispatch also sells the motorcycle, and the list comes
     straight off the table so a fourth vehicle needs no code here. */
  function rideShop(locId, opts = {}) {
    const game = g();
    /* Cheapest first. A counter that opens with the $16,000 machine
       is a counter that hides the $180 one he can actually buy. */
    const forSale = game.actions.ridesFor(locId).filter((r) => !r.owned)
      .sort((a, b) => a.price - b.price);
    const out = [];
    for (const r of forSale) out.push(rideRow(r, opts));
    /* anything he already owns, so "equip it" is possible at a shop */
    for (const r of game.actions.rides()) {
      if (r && r.owned && !forSale.some((x) => x.id === r.id)) out.push(rideRow(r, opts));
    }
    return out;
  }

  /* Back-compat: menus.js published bikeOffer() and the place sheet
     called it. It is now one row of the table. */
  function bikeOffer(opts = {}) {
    const rows = rideOffers(opts);
    return rows[0] || h('div.w-empty', { text: 'Nothing on wheels yet.' });
  }

  function travel(locId, why) {
    const game = g();
    const loc = game.data.locationById[locId];
    if (!loc) return null;
    return sheet({
      title: loc.n,
      sub: why || (game.data.zones[loc.z].n + ' · ' + (game.isOpen(locId) ? 'open now' : 'closed')),
      glyph: loc.ico, tint: BRAND.info,
    }, (body) => {
      body.append(h('div', { style: { fontSize: '12px', opacity: '.7', marginBottom: '4px' }, text: loc.desc }));
      travelModes(body, locId);
    });
  }

  /* ============================================================
     PLACE — "what you can do here"
     ============================================================ */
  function place(locId) {
    const game = g();
    const loc = game.data.locationById[locId];
    if (!loc) return null;
    return sheet({
      title: loc.n,
      sub: game.data.zones[loc.z].n + ' · ' + hoursLine(loc, game.isOpen(locId)),
      glyph: loc.ico, tint: BRAND.token,
    }, (body, el) => {
      body.append(h('div', { style: { fontSize: '12.5px', opacity: '.72', lineHeight: '1.5' }, text: loc.desc }));

      const q = game.quests.questAt(locId);
      if (q) {
        body.append(h('div', {
          style: {
            marginTop: '12px', padding: '11px 13px', borderRadius: '13px',
            background: rgba(BRAND.token, 0.14), boxShadow: `inset 0 0 0 1.4px ${rgba(BRAND.token, 0.34)}`,
          },
        },
          h('div', { style: { fontWeight: '800', fontSize: '13px' }, text: q.t }),
          h('div', { style: { fontSize: '11.5px', opacity: '.7', marginTop: '2px' }, text: q.d })));
      }

      /* MAYOR KEN JONES IS STANDING IN THE DOORWAY. The race is not
         one of the location's `acts` — it is a person blocking a
         door — so it is offered here, at the start line, from the
         moment he asks until the moment he is beaten. */
      const rv = raceView();
      if (rv && rv.offered && locId === rv.route[0].loc) {
        body.append(label(game.data.race.n));
        body.append(card({
          glyph: '🏁',
          t: rv.won ? 'You beat ' + game.race.mayor().n : 'Race ' + game.race.mayor().n,
          d: rv.won ? 'Best ' + rv.best + 's, against his ' + rv.pace.mayorSeconds + 's.'
            : rv.metres + ' m round the town · he does it in ' + rv.pace.mayorSeconds + 's'
              + (rv.best ? ' · your best ' + rv.best + 's' : ''),
          m: rv.won ? '✔' : 'Go', mColor: rv.won ? BRAND.good : BRAND.warn,
          onclick: () => ui.pushSheet(raceCard(), 'race'),
        }));
      }

      body.append(label('What you can do here'));
      const acts = actionsFor(loc);
      if (!acts.length) body.append(h('div.w-empty', { text: 'Nothing to do here today.' }));
      /* most actions are card specs; a few build their own row */
      for (const a of acts) body.append(a.el || card(a));

      /* people */
      const here = game.clients.at(locId);
      if (here.length) {
        body.append(label('People here'));
        for (const c of here) {
          const cs = game.state.clients[c.id];
          body.append(card({
            node: portrait(c, 34),
            t: c.n,
            d: cs.met ? c.role : c.role + ' · you have not met',
            m: cs.met ? 'trust ' + cs.trust : 'Say hello',
            mColor: cs.met ? BRAND.ink : BRAND.token2,
            onclick: () => talkTo(c),
          }));
        }
      }
    });
  }

  function talkTo(c) {
    const game = g();
    const first = !game.state.clients[c.id].met;
    if (first) game.clients.meet(c.id);
    const order = game.state.arrivals.find((o) => o.client === c.id);
    ui.dialogue({
      speaker: c.n, role: c.role, portrait: c.id,
      text: first ? [c.intro] : [c.intro],
      choices: order ? [
        { label: 'What do you need?', value: 'order', kind: 'prim', onPick: () => ui.showOrder(order) },
        { label: 'Another time', value: null, kind: 'ghost' },
      ] : [{ label: 'Good to see you', value: null, kind: 'prim' }],
    });
    ui.refresh();
  }

  /* map an `act` string from data.js onto a card */
  function actionsFor(loc) {
    const game = g();
    const st = game.state;
    const out = [];
    for (const act of loc.acts) {
      const [kind, a, b] = act.split(':');
      switch (kind) {
        case 'sleep':
          out.push({ ic: 'bed', t: 'Sleep until morning', d: 'Ends the day, restores energy, saves the game.',
            onclick: () => {
              const r = game.actions.sleep();
              ui.closeAll();
              ui.sfx('ui.close');
              ui.refresh();
            } });
          break;
        case 'desk': case 'hub':
          out.push({ ic: 'door', t: 'Work at the desk', d: 'Orders, clients, tokenizing, your office.',
            m: st.arrivals.length ? st.arrivals.length + ' waiting' : null, mColor: BRAND.token2,
            onclick: (e) => { ui.closeSheet(e && e.currentTarget); ui.openDesk(); } });
          break;
        case 'poster':
          out.push({ glyph: '🖼️', t: 'Look at the poster', d: 'The Bull Bear Stampede, some year they would rather forget.',
            onclick: () => ui.dialogue({
              speaker: 'Wally', portrait: 'wally',
              text: ['Row F, seat 12. Someone in that photograph is looking straight at the camera and grinning like the season is going to end differently.',
                     'It did not. It has not, for a while.'],
            }) });
          break;
        case 'wardrobe':
          out.push({ glyph: '🧥', t: 'Get changed', d: 'Same jacket. Cleaner, at least.',
            onclick: () => ui.dialogue({ speaker: 'Wally', portrait: 'wally', text: 'Same jacket. It is a good jacket. It has three pockets and one opinion.' }) });
          break;
        case 'job': {
          const j = game.data.jobs[a];
          if (!j) break;
          out.push({ glyph: j.ico, t: j.t, d: j.d, m: '~' + money(j.base + j.mult * 0.5), ms: j.en + ' energy',
            onclick: () => runShift(a) });
          break;
        }
        case 'food':
          out.push({ glyph: '🍜', t: 'Eat · ' + money(+a), d: 'Fills ' + b + ' points of appetite.',
            m: money(+a), mColor: BRAND.good,
            onclick: () => {
              const r = game.actions.eat(+a, +b);
              if (r.ok) { ui.sfx('coin'); ui.toast('That is better', 'good'); }
              else res(r);
              ui.refresh(); ui.rebuildTop();
            } });
          break;
        case 'market': {
          const v = game.data.venues[a];
          out.push({ ic: 'bag', t: v.name, d: game.economy.venueOpen(a) ? 'Buy and sell here.' : 'You do not have access yet.',
            disabled: !game.economy.venueOpen(a),
            onclick: () => ui.pushSheet(market(a)) });
          break;
        }
        /* THE 'bike' ACT — now the whole forecourt. data.js puts it on
           Dispatch and Vic's; Dispatch also stocks the Thunderhead, so
           the counter lists everything the table says is sold HERE
           plus anything he already owns, and a fourth vehicle in the
           table appears without a line of code changing. */
        case 'bike': for (const el of rideShop(loc.id)) out.push({ el }); break;
        case 'bank':  out.push({ ic: 'cash', t: 'Bull Bear Mutual', d: 'Borrow against your reputation, repay when you can.', onclick: () => ui.pushSheet(bank()) }); break;
        case 'pawn':  out.push({ ic: 'bag', t: "Vic's stock", d: 'Four things a day, 14% under market.', onclick: () => ui.pushSheet(pawn()) }); break;
        case 'school':out.push({ ic: 'book', t: 'Enrol in a course', d: 'Ten courses. Each ends in an exam you can fail.', onclick: () => ui.pushSheet(school()) }); break;
        case 'study': out.push({ ic: 'book', t: 'Read for two hours', d: '+1 reputation, 12 energy.', onclick: () => { res(game.actions.study(), 'Two quiet hours well spent'); ui.rebuildTop(); } }); break;
        case 'archive': out.push({ ic: 'book', t: 'File the bond archive', d: 'Unlocks City Treasury access.', onclick: () => { res(game.actions.archive()); ui.rebuildTop(); } }); break;
        case 'homes': out.push({ ic: 'key', t: 'View apartments', d: 'Somewhere better to sleep.', onclick: () => ui.pushSheet(homes()) }); break;
        case 'farm':  out.push({ ic: 'tools', t: "Maple's Farm", d: 'Irrigation, partnership, harvest.', onclick: () => ui.pushSheet(farm()) }); break;
        case 'mine':  out.push({ ic: 'tools', t: 'The old mine', d: 'Records, the elevator, the seam.', onclick: () => ui.pushSheet(mine()) }); break;
        case 'devlab':out.push({ ic: 'spark', t: 'Trunk Technologies Lab', d: 'Wallet, remote orders, Wally Swap.', onclick: () => ui.pushSheet(devlab()) }); break;
        case 'ipo':   out.push({ ic: 'chart', t: 'Listings', d: 'Four companies want to go public.', onclick: () => ui.pushSheet(ipos()) }); break;
        case 'stampede': out.push({ ic: 'trophy', t: 'The Stampede', d: 'Ten steps to give a team back to a city.', onclick: () => ui.pushSheet(stadium()) }); break;
        case 'vance': out.push({ ic: 'star', t: 'Ask Vance for a mandate', d: 'Institutional money, if he takes the meeting.',
          onclick: () => { const r = game.actions.vanceMandate(); if (r.ok) { ui.toast('A mandate is on your desk', 'token'); ui.sfx('unlock'); } else res(r); } }); break;
        default: break;
      }
    }
    return out;
  }

  function runShift(key) {
    const game = g();
    const j = game.data.jobs[key];
    const r = game.actions.work(key);
    if (!r.ok) { res(r); return; }
    ui.sfx('cash');
    ui.refresh();
    ui.rebuildTop();
    const pages = ['That is ' + money2(r.pay) + ' for ' + j.hrs + ' hours. ' +
      (r.score > 0.72 ? 'Nobody had to tell you twice.' : r.score > 0.5 ? 'Steady work.' : 'Long hours, slow clock.')];
    if (r.extra) pages.push(r.extra.text);
    ui.dialogue({ speaker: 'Wally', portrait: 'wally', text: pages });
  }

  /* ============================================================
     DESK
     ============================================================ */
  function desk() {
    const game = g();
    return sheet({ title: 'Your desk', sub: '', glyph: '🗂️', tint: BRAND.token }, (body, el) => {
      const st = game.state;
      const E = game.economy;
      const stage = game.data.offices[st.office];
      el._setTitle('Your desk', stage.n + ' · ' + st.orders.length + '/' + E.orderSlots() + ' orders');

      if (st.arrivals.length) {
        body.append(label('Waiting for you'));
        for (const o of st.arrivals) {
          const c = game.data.clientById[o.client];
          body.append(card({
            node: portrait(c, 34), t: c.n, d: describeOrder(o),
            m: money(o.budget + o.fee), mColor: BRAND.good, ms: 'day ' + o.deadline,
            onclick: () => ui.showOrder(o),
          }));
        }
      }

      body.append(label('Open orders'));
      if (!st.orders.length) body.append(h('div.w-empty', { text: 'No orders. Meet people; they will find you.' }));
      for (const o of st.orders) {
        const c = game.data.clientById[o.client];
        const ready = E.canComplete(o);
        const short = o.items.filter((it) => E.free(it.a) + 1e-4 < it.q);
        const missing = short.map((it) => E.tickerQty(it.a, Math.ceil(it.q - E.free(it.a))));
        body.append(card({
          node: portrait(c, 34), t: c.n + ' · ' + describeOrder(o),
          /* an unfilled order is not a dead row — it is the shortest
             route to the shop that fills it */
          d: ready ? 'Everything is in hand. Deliver it.'
            : 'Still need ' + missing.join(', ') + ' — tap to buy',
          m: ready ? 'Deliver' : money(o.budget + o.fee),
          mColor: ready ? BRAND.good : BRAND.warn,
          onclick: !ready ? () => ui.openQuickBuy(short[0] && short[0].a) : () => {
            const r = game.actions.deliver(o);
            if (r.ok) {
              ui.sfx('cash');
              ui.refresh();
              el._rebuild();
              ui.dialogue({
                speaker: c.n, role: c.role, portrait: c.id,
                text: r.late ? 'Late. But you came. That counts for something.'
                             : 'Exactly what I asked for. I will tell people.',
              });
            } else res(r);
          },
        }));
      }

      body.append(label('Your office'));
      const nx = game.actions.nextOffice();
      body.append(kv('Stage', stage.n));
      body.append(kv('Inventory', E.invCount() + ' / ' + E.invCap()));
      body.append(kv('Order slots', st.orders.length + ' / ' + E.orderSlots()));
      if (nx) {
        body.append(card({
          ic: 'door', t: 'Upgrade to ' + nx.n, d: nx.desc,
          m: money(nx.cost), ms: nx.rep + ' rep',
          onclick: () => { const r = game.actions.upgradeOffice(); if (r.ok) { ui.sfx('levelup'); el._rebuild(); ui.refresh(); } else res(r); },
        }));
      }

      body.append(label('Team · ' + st.employees.length + '/' + (st.office + 1)));
      for (const e of game.data.employees) {
        const hired = st.employees.includes(e.id);
        body.append(card({
          ic: 'people', t: e.n + ' · ' + e.role, d: hired ? '"' + e.line + '"' : e.skill,
          m: hired ? 'On the team' : money(e.salary) + '/d',
          mColor: hired ? BRAND.good : BRAND.ink,
          onclick: () => {
            const r = hired ? game.actions.fire(e.id) : game.actions.hire(e.id);
            if (r.ok) { ui.sfx(hired ? 'ui.back' : 'levelup'); el._rebuild(); ui.refresh(); } else res(r);
          },
        }));
      }

      if (st.funds.length) {
        body.append(label('Funds'));
        for (const f of st.funds) {
          body.append(card({ ic: 'chart', t: f.name, d: game.data.clientById[f.client].n + ' · satisfaction ' + Math.round(f.satisfaction) + '%',
            m: money(f.value), ms: money(f.weekly) + '/wk' }));
        }
      }
    });
  }
  /* AN ORDER IS A TRADE TICKET. economy.ticket() renders it in the
     symbols the venues actually quote — "2x WHEAT · GOLD" — which is
     also what the player will type into the quick-buy box, so the
     order and the purchase are written in the same language. */
  function describeOrder(o) {
    const game = g();
    return (o.type === 'fund' ? 'Fund · ' : '') + game.economy.ticket(o);
  }

  /* The accept/decline card for a single arrival.

     The client asks in symbols, because that is what the order is —
     "2x WHEAT, GOLD" — and then the third choice takes the player
     straight to the box where they can type exactly that. The gap
     between being given a job and knowing how to do it was the whole
     complaint, and it is one tap wide now. */
  function showOrder(o) {
    const game = g();
    const c = game.data.clientById[o.client];
    const first = o.items[0] && o.items[0].a;
    const vs = first ? venueOf(first) : null;
    ui.dialogue({
      speaker: c.n, role: c.role, portrait: c.id,
      text: [o.line, (o.type === 'fund' ? 'I want a basket, not a thing: ' : 'What I need is ') +
        describeOrder(o) + '. My budget is ' + money2(o.budget) + ', and there is ' +
        money2(o.fee) + ' in it for you. Day ' + o.deadline + ' at the latest.'
        + (vs ? '  (' + game.economy.ticker(first) + ' trades at ' + vs.v.name + '.)' : '')],
      choices: [
        { label: 'I will take it', value: 'accept', kind: 'prim', onPick: () => {
          const r = game.actions.accept(o);
          if (r.ok) { ui.sfx('quest.start'); ui.toast('Order accepted', 'good'); ui.refresh(); ui.rebuildTop(); }
          else res(r);
        } },
        first ? { label: 'Where do I buy ' + game.economy.ticker(first) + '?', value: 'where',
          onPick: () => ui.openQuickBuy(first) } : null,
        { label: 'Not this time', value: null, kind: 'ghost' },
      ].filter(Boolean),
    });
  }

  /* ============================================================
     MARKET
     ============================================================ */
  function market(venue) {
    const game = g();
    const v = game.data.venues[venue];
    return sheet({
      title: v.name,
      sub: game.economy.venueOpenNow(venue) ? 'Open · spread ' + Math.round(v.spread * 100) + '%'
                                            : 'Closed · ' + pad2(v.hours[0]) + ':00–' + pad2(v.hours[1]) + ':00',
      glyph: '🧾', tint: CATEGORY.Stocks,
    }, (body, el) => {
      const E = game.economy;
      const st = game.state;
      body.append(kv('Cash', money2(st.money)));
      body.append(kv('Inventory', E.invCount() + ' / ' + E.invCap()));
      /* THE HOUSE'S CUT, STATED ONCE, AT THE TOP. Every number below
         is an ask or a bid rather than the mid, and this is the line
         that says why the two are not the same. */
      const pct = Math.round(v.spread * 100);
      body.append(h('div.w-spread', null,
        h('span.k', { text: 'How ' + v.name + ' is paid' }),
        h('span.d', { text: 'A ' + pct + '% spread. You BUY at the ask — the mid price plus '
          + pct + '% — and SELL at the bid, which is under it. On a ' + money(100)
          + ' asset that is ' + money2(100 * v.spread) + ' either way.' })));
      /* the order book is a list of one-unit buttons; anything with a
         quantity, a total or a second thought goes through the ticket */
      body.append(card({
        ic: 'search', t: 'Search by ticker', d: 'Quantity, spread and the total before you confirm.',
        m: 'B', mColor: BRAND.token2,
        onclick: () => ui.openQuickBuy(),
      }));
      const list = game.data.assets.filter((a) => a.ven === venue);
      body.append(label(list.length + ' listed · ask / bid, one unit'));
      for (const a of list) {
        const owned = E.owned(a.id);
        const bp = E.buyPrice(a.id, venue), sp = E.sellPrice(a.id, venue);
        const tr = E.trend(a.id);
        const row = h('div.w-card', null,
          h('div.ic', { style: { fontSize: '17px', background: rgba(CATEGORY[a.cat] ?? BRAND.info, 0.16) }, text: a.ico }),
          /* ONE PRICE COLUMN, AND IT IS THE BUTTONS. This row used to
             print the MID in the money column and the ASK on the
             button beside it, which is exactly what made the buy
             button look more expensive than the price. The two
             buttons now carry the only two numbers you can actually
             transact at, and the mid and the spread that produce
             them sit in the subtitle underneath the name. */
          assetNode(a, { sub: (tr > 0.004 ? '▲ ' : tr < -0.004 ? '▼ ' : '')
            + askSub(E.price(a.id), pct) + ' · ' + a.q + '/5 liq'
            + (owned ? ' · you hold ' + owned : '') }));
        const buttons = h('div', { style: { display: 'flex', gap: '6px', marginLeft: '8px' } },
          h('button.w-btn.sm.prim.w-pe', {
            type: 'button', title: 'Buy one ' + a.tick + ' at the ask, ' + money2(bp),
            onclick: () => {
              const r = E.buy(a.id, 1, venue);
              if (r.ok) { ui.sfx('buy'); ui.refresh(); el._rebuild(); } else res(r);
            },
          }, 'Buy ' + money(bp)),
          h('button.w-btn.sm.ghost.w-pe', {
            type: 'button', title: 'Sell one ' + a.tick + ' at the bid, ' + money2(sp), disabled: E.free(a.id) < 1,
            onclick: () => {
              const r = E.sell(a.id, 1, venue);
              if (r.ok) { ui.sfx('sell'); ui.refresh(); el._rebuild(); } else res(r);
            },
          }, 'Sell ' + money(sp)),
          h('button.w-btn.sm.ghost.w-pe', {
            type: 'button', title: 'Buy several ' + a.tick,
            style: { minWidth: '32px', padding: '0 8px' },
            onclick: () => ui.openQuickBuy(a.id),
          }, '×n'));
        row.append(buttons);
        body.append(row);
      }
    });
  }

  /* ============================================================
     SCHOOL
     ============================================================ */
  function school() {
    const game = g();
    return sheet({ title: 'Bull Bear Business School', sub: 'Ten courses, ten exams', glyph: '🎓', tint: LAND.grassLit },
      (body, el) => {
        const st = game.state;
        body.append(kv('Cash', money2(st.money)));
        body.append(kv('Energy', Math.round(st.energy) + '%'));
        body.append(label('Courses'));
        for (const c of game.data.courses) {
          const passed = !!st.skills[c.id];
          const chk = game.actions.courseAvailable(c.id);
          body.append(card({
            ic: 'book', t: c.n, d: passed ? 'Passed' : (chk.ok ? c.desc : chk.why),
            m: passed ? '✔' : money(c.cost), ms: passed ? null : c.hours + ' h · ' + c.energy + ' en',
            mColor: passed ? BRAND.good : chk.ok ? BRAND.ink : BRAND.bad,
            disabled: passed || !chk.ok,
            onclick: () => {
              const r = game.actions.enrol(c.id);
              ui.refresh(); ui.rebuildTop(); el._rebuild();
              if (r.ok) { ui.sfx('levelup'); }
              else if (r.failed) ui.dialogue({ speaker: 'The Examiner', text: r.why });
              else res(r);
            },
          }));
        }
      });
  }

  /* ============================================================
     BANK / PAWN / HOMES
     ============================================================ */
  function bank() {
    const game = g();
    return sheet({ title: 'Bull Bear Mutual', sub: 'Marble floors, slow queue', glyph: '🏦', tint: BUILD.metal },
      (body, el) => {
        const st = game.state;
        const cap = 500 + st.rep * 120;
        body.append(kv('Cash', money2(st.money)));
        body.append(kv('Outstanding loan', money2(st.loan)));
        body.append(kv('Credit line', money(cap)));
        body.append(kv('Daily interest', '2% of the balance'));
        body.append(label('Borrow'));
        body.append(h('div.w-row', null, ...[200, 500, 1000, 2500].map((n) =>
          h('button.w-btn.prim.w-pe', {
            type: 'button',
            onclick: () => { const r = game.actions.borrow(n); if (r.ok) { ui.sfx('cash'); el._rebuild(); ui.refresh(); } else res(r); },
          }, money(n)))));
        body.append(label('Repay'));
        body.append(h('div.w-row', null, ...[100, 500, Math.min(st.loan, st.money) || 0].map((n, i) =>
          h('button.w-btn.ghost.w-pe', {
            type: 'button', disabled: !n || st.loan <= 0,
            onclick: () => { const r = game.actions.repay(n); if (r.ok) { ui.sfx('coin'); el._rebuild(); ui.refresh(); } else res(r); },
          }, i === 2 ? 'All · ' + money(n) : money(n)))));
      });
  }

  function pawn() {
    const game = g();
    return sheet({ title: "Vic's Pawn & Trade", sub: 'Assets with a past', glyph: '🏷️', tint: BRAND.gem },
      (body, el) => {
        const E = game.economy;
        body.append(label("Today's stock"));
        const stock = game.actions.pawnStock();
        if (!stock.length) body.append(h('div.w-empty', { text: 'Vic has nothing today.' }));
        for (const s of stock) {
          const a = game.data.assetById[s.id];
          body.append(card({
            glyph: a.ico, asset: a, d: a.cat + ' · 14% under market', m: money(s.price), mColor: BRAND.good,
            onclick: () => { const r = game.actions.pawnBuy(s.id); if (r.ok) { ui.sfx('buy'); el._rebuild(); ui.refresh(); } else res(r); },
          }));
        }
        const mine = Object.keys(game.state.inv).filter((k) => E.free(k) >= 1);
        body.append(label('Sell to Vic · 22% under market'));
        if (!mine.length) body.append(h('div.w-empty', { text: 'Nothing spare to sell.' }));
        for (const id of mine) {
          const a = game.data.assetById[id];
          body.append(card({
            glyph: a.ico, asset: a, d: E.free(id) + ' free', m: money(Math.round(E.price(id) * 0.78)),
            onclick: () => { const r = game.actions.pawnSell(id, 1); if (r.ok) { ui.sfx('sell'); el._rebuild(); ui.refresh(); } else res(r); },
          }));
        }
      });
  }

  function homes() {
    const game = g();
    return sheet({ title: 'Somewhere to live', sub: 'Rest, storage, standing', glyph: '🔑', tint: BUILD.roof },
      (body, el) => {
        const st = game.state;
        for (const hm of game.data.homes) {
          const cur = st.home === hm.id;
          body.append(card({
            ic: 'key', t: hm.n, d: hm.desc + ' · rest ' + hm.rest + ' · +' + hm.store + ' storage',
            m: cur ? 'Home' : money(hm.cost), ms: money(hm.rent) + '/wk',
            mColor: cur ? BRAND.good : BRAND.ink, disabled: cur,
            onclick: () => { const r = game.actions.moveHome(hm.id); if (r.ok) { ui.sfx('unlock'); el._rebuild(); ui.refresh(); } else res(r); },
          }));
        }
      });
  }

  /* ============================================================
     PRODUCER UPGRADES, IN NUMBERS, BEFORE THE MONEY LEAVES.

     "Upgrade the farm · $4,000 · Better crops appear" told the player
     nothing they could weigh. game.actions.producer(which) computes
     what a level is actually worth — the yield now and after, whether
     a richer tier opens, and the overnight income, including the part
     that pays nothing until the manager is hired. This prints all of
     it on the card, and the last line is the one nobody could find:
     an upgrade adds daily income ONLY with the manager on the payroll.
     ============================================================ */
  function producerUpgrade(which, onBuy) {
    const game = g();
    const p = game.actions.producer(which);
    if (!p || !p.owned) return null;
    const afford = game.state.money >= p.cost;
    const dy = p.nextPerAction - p.perAction;

    const wrap = h('div.w-up' + (afford ? '' : '.poor'));
    wrap.append(h('div.hd', null,
      h('div.ic', null, icon('tools', 17)),
      h('div.w-grow', null,
        h('div.t', { text: p.upgrade + ' · level ' + p.level + ' → ' + p.nextLevel }),
        h('div.d', { text: p.n })),
      h('div.m', { text: money(p.cost), style: { color: C(afford ? BRAND.ink : BRAND.bad) } },
        h('small', { text: afford ? 'to buy' : 'you are ' + money(p.cost - game.state.money) + ' short' }))));

    /* the three effects, each a number the player can check afterwards */
    const eff = h('div.eff');
    eff.append(effRow('spark',
      p.act + ' yields ' + p.perAction + ' → ' + p.nextPerAction + ' ' + p.unit + (p.nextPerAction === 1 ? '' : 's'),
      dy > 0 ? '+' + dy + ' every ' + p.act.toLowerCase() + ', for ever' : 'no change to the bucket', dy > 0));
    eff.append(effRow('chart',
      p.tierGrows ? 'Tier ' + p.tier + ' → tier ' + p.nextTier + ' ' + p.unit + 's unlock'
        : 'Tier ' + p.tier + ' is already the richest here',
      p.tierGrows ? 'the more valuable ones become findable at all' : 'no new material at this level',
      p.tierGrows));
    eff.append(effRow('cash',
      p.managerHired
        ? 'Overnight income ' + money(p.dailyIncome) + ' → ' + money(p.nextDailyIncome) + ' a day'
        : 'Overnight income stays at ' + money(0) + ' a day',
      p.managerHired
        ? '+' + money(p.nextDailyIncome - p.dailyIncome) + ' a day while ' + p.managerName + ' runs it'
        : 'this level pays nothing overnight until ' + p.managerName
          + ' is on the payroll — with ' + p.managerName + ' it would pay ' + money(p.dailyIfHired) + ' a day',
      p.managerHired));
    wrap.append(eff);

    wrap.append(h('button.w-btn.prim.w-pe', {
      type: 'button', disabled: !afford,
      style: { width: '100%', marginTop: 'calc(9px * var(--w-ts))' },
      onclick: () => { ui.click(); onBuy(); },
    }, 'Buy ' + p.upgrade + ' · ' + money(p.cost)));
    return wrap;
  }
  function effRow(ic, t, d, good) {
    return h('div.row' + (good ? '.on' : ''), null,
      icon(good ? 'check' : ic, 13, { w: 2.2 }),
      h('div.w-grow', null, h('b', { text: t }), h('span', { text: d })));
  }

  /* ============================================================
     FARM / MINE / DEV LAB / IPO / STADIUM
     ============================================================ */
  function farm() {
    const game = g();
    return sheet({ title: "Maple's Farm", sub: 'Good soil, bad paperwork', glyph: '🌾', tint: LAND.grassLit },
      (body, el) => {
        const f = game.state.farm;
        const A = game.actions;
        const step = (t, d, m, on, done) => body.append(card({
          ic: 'tools', t, d, m: done ? '✔' : m, mColor: done ? BRAND.good : BRAND.ink, disabled: done,
          onclick: done ? null : () => { const r = on(); if (r.ok) { ui.sfx('ui.select'); el._rebuild(); ui.refresh(); ui.rebuildTop(); } else res(r); },
        }));
        body.append(label('The farm'));
        step('Fix the irrigation', 'Two hours, 14 energy. Maple watches.', 'Do it', () => A.farmFixIrrigation(), f.irrigation);
        step('Buy into the partnership', 'A third of the farm and the co-op unlocked.', money(2400), () => A.farmBuyIn(), f.owned);
        if (f.owned) {
          step('Build the barn', 'One extra crate every harvest.', money(3200), () => A.farmBuild('barn'), f.barn);
          step('Build cold storage', 'Nothing spoils on the way to market.', money(6500), () => A.farmBuild('cold'), f.cold);
          put(body, label('Field expansion'), producerUpgrade('farm', () => {
            const r = A.farmUpgrade();
            if (r.ok) { ui.sfx('levelup'); ui.toast('Field Expansion · level ' + r.level, 'good'); el._rebuild(); ui.refresh(); }
            else res(r);
          }));
          body.append(card({ ic: 'spark', t: 'Harvest', d: 'Three hours, 16 energy.', m: 'Go',
            onclick: () => {
              const r = A.farmHarvest();
              if (r.ok) { ui.sfx('coin'); ui.toast('Harvested ' + r.qty + '× ' + game.data.assetById[r.asset].n, 'good'); ui.refresh(); ui.rebuildTop(); }
              else res(r);
            } }));
        }
      });
  }

  function mine() {
    const game = g();
    return sheet({ title: 'Old Bull Bear Mine', sub: 'Closed eleven years', glyph: '⛏️', tint: BRAND.gem },
      (body, el) => {
        const m = game.state.mine;
        const A = game.actions;
        const step = (t, d, mm, on, done) => body.append(card({
          ic: 'tools', t, d, m: done ? '✔' : mm, mColor: done ? BRAND.good : BRAND.ink, disabled: done,
          onclick: done ? null : () => { const r = on(); if (r.ok) { ui.sfx('ui.select'); el._rebuild(); ui.refresh(); ui.rebuildTop(); } else res(r); },
        }));
        step('Get the records from Goldie', 'Needs the Mining and Safety class.', 'Ask', () => A.mineRights(), m.rights);
        step('Certify the elevator', 'The inspector has opinions.', money(2600), () => A.mineCertifyLift(), m.elevator);
        step('Reopen the mine', 'Two and a half hours, 16 energy.', 'Open it', () => A.mineOpen(), m.owned);
        if (m.owned) {
          put(body, label('Seam development'), producerUpgrade('mine', () => {
            const r = A.mineUpgrade();
            if (r.ok) { ui.sfx('levelup'); ui.toast('Seam Development · level ' + r.level, 'good'); el._rebuild(); ui.refresh(); }
            else res(r);
          }));
          body.append(card({ ic: 'spark', t: 'Work a seam', d: 'Three hours, 20 energy.', m: 'Dig',
            onclick: () => {
              const r = A.mineDig();
              if (r.ok) { ui.sfx('coin'); ui.toast('Brought up ' + r.qty + '× ' + game.data.assetById[r.asset].n, 'good'); ui.refresh(); ui.rebuildTop(); }
              else res(r);
            } }));
        }
      });
  }

  function devlab() {
    const game = g();
    return sheet({ title: 'Trunk Technologies Lab', sub: 'Where your phone learns to hold assets', glyph: '🧪', tint: BRAND.info },
      (body, el) => {
        const st = game.state;
        const A = game.actions;
        body.append(card({ ic: 'wallet', t: 'Asset Wallet', d: 'Hold tokenized assets on the phone.',
          m: st.unlocks.wallet ? '✔' : money(900), mColor: st.unlocks.wallet ? BRAND.good : BRAND.ink,
          disabled: !!st.unlocks.wallet,
          onclick: () => { const r = A.buyWallet(); if (r.ok) { ui.sfx('unlock'); el._rebuild(); ui.refresh(); } else res(r); } }));
        body.append(card({ ic: 'net', t: 'Remote order acceptance', d: 'Take client orders without walking back.',
          m: st.unlocks.remote ? '✔' : money(2400), mColor: st.unlocks.remote ? BRAND.good : BRAND.ink,
          disabled: !!st.unlocks.remote,
          onclick: () => { const r = A.buyRemote(); if (r.ok) { ui.sfx('unlock'); el._rebuild(); ui.refresh(); } else res(r); } }));
        body.append(card({ ic: 'spark', t: 'Build Wally Swap', d: 'Automated pools for every tokenized asset.',
          m: st.swap.unlocked ? '✔' : money(45000), mColor: st.swap.unlocked ? BRAND.good : BRAND.ink,
          disabled: !!st.swap.unlocked,
          onclick: () => { const r = A.buildSwap(); if (r.ok) { ui.sfx('fanfare'); el._rebuild(); ui.refresh(); } else res(r); } }));
        if (st.swap.unlocked) {
          body.append(label('Liquidity pools'));
          for (const id of Object.keys(st.tokenized)) {
            const a = game.data.assetById[id];
            if (!a) continue;
            const has = !!st.swap.pools[id];
            body.append(card({ glyph: a.ico, asset: a, d: has ? 'Pool live' : 'Seed a pool with half its value',
              m: has ? '✔' : money(Math.round(game.economy.price(id) * 0.5)),
              mColor: has ? BRAND.good : BRAND.ink, disabled: has,
              onclick: () => { const r = A.addPool(id); if (r.ok) { ui.sfx('token'); el._rebuild(); ui.refresh(); } else res(r); } }));
          }
        }
      });
  }

  function ipos() {
    const game = g();
    return sheet({ title: 'Listings Office', sub: 'Four companies, all nervous', glyph: '📈', tint: CATEGORY.Stocks },
      (body, el) => {
        for (const ip of game.data.ipos) {
          const step = game.actions.ipoStep(ip.id);
          const total = game.data.ipoSteps.length;
          const listed = step >= total;
          const gate = game.actions.ipoGate(ip.id);
          body.append(label(ip.n + ' · ' + (listed ? 'listed' : step + '/' + total)));
          body.append(h('div', { style: { fontSize: '11.5px', opacity: '.65', marginBottom: '6px' }, text: ip.story }));
          if (listed) { body.append(h('div.w-empty', { text: 'It rang the bell. It trades on the Exchange now.' })); continue; }
          const s = game.data.ipoSteps[step];
          body.append(card({
            ic: 'chart', t: s.t, d: gate.ok ? s.d : gate.why,
            m: step === 0 ? money(ip.cost) : 'Go', disabled: !gate.ok,
            onclick: () => {
              const r = game.actions.ipoAdvance(ip.id);
              ui.refresh(); ui.rebuildTop(); el._rebuild();
              if (r.ok) ui.sfx(r.listed ? 'fanfare' : 'quest.done');
              else if (r.failed) ui.dialogue({ speaker: game.data.clientById[ip.client].n, portrait: ip.client, text: r.why });
              else res(r);
            },
          }));
        }
      });
  }

  function stadium() {
    const game = g();
    return sheet({ title: 'Bull Bear Stampede', sub: 'Twelve thousand seats', glyph: '🏟️', tint: CATEGORY.Sports },
      (body, el) => {
        const st = game.state;
        const steps = game.data.stadiumSteps;
        const gate = game.actions.stadiumGate();
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i];
          const done = st.stadium.step > i;
          const active = st.stadium.step === i;
          body.append(card({
            ic: done ? 'check' : active ? 'trophy' : 'info',
            t: (i + 1) + '. ' + s.t,
            d: done ? 'Complete' : active ? (gate.ok ? s.d : gate.why) : s.d,
            m: done ? '✔' : active ? (s.cost ? money(s.cost) : 'Go') : null,
            mColor: done ? BRAND.good : BRAND.ink,
            disabled: !active || !gate.ok,
            onclick: active && gate.ok ? () => {
              const r = game.actions.stadiumAdvance();
              ui.refresh(); ui.rebuildTop(); el._rebuild();
              if (r.ok) ui.sfx('quest.done');
              else if (r.failed) ui.dialogue({ speaker: 'Coach Thunder', portrait: 'thunder', text: r.why });
              else res(r);
            } : null,
          }));
        }
      });
  }

  /* ============================================================
     THE MAYOR'S DASH — the two cards.

     game.race owns the rules; these two own the reading of them.
     raceCard()   the start line: his route, his target, your best,
                  and one button that is either Go or a way to Go.
     raceResult() the finish: your clock against his, and — when you
                  lost — WHERE it went. The result never tells the
                  player to buy anything. It shows them the two
                  average speeds side by side and lets the arithmetic
                  do the nudging, because "he was going faster than
                  you" is a fact about this race and "get a scooter"
                  is the answer to a puzzle the game wants kept.
     ============================================================ */
  function raceView() {
    try { return g().race ? g().race.view() : null; } catch (e) { return null; }
  }
  const secs = (s) => (s == null ? '—' : Math.round(s) + 's');
  const mps = (metres, seconds) => (seconds > 0 ? (Math.round((metres / seconds) * 10) / 10) + ' m/s' : '—');

  function raceCard() {
    const game = g();
    return sheet({
      title: game.data.race.n,
      sub: 'Once round the town. His route.',
      glyph: '🏁', tint: BRAND.warn,
    }, (body, self) => {
      const v = game.race.view();
      const mayor = game.race.mayor();
      const can = v.canStart;

      body.append(h('div.w-msg', null,
        h('div.hd', null, portrait(mayor, 26), mayor.n,
          h('span.when', { text: v.won ? 'beaten' : v.attempts ? 'attempt ' + (v.attempts + 1) : 'the challenge' })),
        h('div.bd', { text: v.won ? game.data.race.lines.won : game.data.race.lines.start })));

      body.append(label('The route'));
      const track = h('div.w-route');
      for (const r of v.route) {
        track.append(h('div.leg' + (r.i <= v.cp && v.running ? '.done' : ''), null,
          h('span.n', { text: r.start ? 'START' : r.finish ? 'FINISH' : String(r.i) }),
          h('span.p', { text: r.ico + ' ' + r.n }),
          h('span.m', { text: r.metres ? r.metres + ' m' : '' })));
      }
      body.append(track);

      body.append(label('The numbers'));
      put(body,
        kv('Distance', v.metres + ' m · ' + (v.route.length - 1) + ' legs'),
        /* HIS TARGET AGAINST YOUR OWN PROJECTED LAP, not against your
           top speed. Top speed beside his average reads as "you are
           already quicker than him", which is false: nobody holds a
           top speed through five corners. pace.rideSeconds is what
           this ride is realistically worth over this route, and
           printing it beside his time is the honest comparison — and
           the only nudge the player gets. */
        kv('You are on', v.pace.rideName),
        kv('A good lap on that', secs(v.pace.rideSeconds)
          + ' · ' + (Math.round((v.metres / v.pace.rideSeconds) * 100) / 100) + ' m/s average'),
        kv(mayor.n + ' will do it in', secs(v.pace.mayorSeconds)
          + ' · ' + v.pace.mps + ' m/s average'),
        kv('Your best so far', v.best ? secs(v.best) : 'you have not raced him'),
        kv('It costs you', v.mins + ' minutes · ' + v.energy + ' energy'),
      );

      if (v.won) {
        body.append(h('div.w-warnbox.good', { text: 'You beat him in ' + secs(v.best)
          + '. The Stock Exchange door is open to you.' }));
        return;
      }

      if (can.ok) {
        body.append(h('button.w-btn.prim.w-pe', {
          type: 'button', style: { width: '100%', marginTop: 'calc(10px * var(--w-ts))' },
          onclick: () => {
            ui.click();
            const r = game.race.start();
            if (!r.ok) { res(r); return; }
            self._close();
            ui.closeAll();
          },
        }, icon('play', 15, { fill: 'currentColor', w: 1 }), 'On your marks · ' + secs(v.pace.mayorSeconds) + ' to beat'));
        body.append(h('div.w-note', { text:
          'Touch each corner in order and get back to ' + v.route[0].n + '. He starts when you do.' }));
        return;
      }

      /* refused — say why, and offer the fix rather than the wall */
      body.append(h('div.w-warnbox', { text: can.why }));
      if (can.kind === 'place' && can.loc) {
        body.append(h('button.w-btn.prim.w-pe', {
          type: 'button', style: { width: '100%', marginTop: 'calc(9px * var(--w-ts))' },
          onclick: () => { ui.click(); self._close(); ui.goto(can.loc, 'The start line'); },
        }, icon('pin', 15), 'Go to the start line'));
      } else if (can.kind === 'hunger' || can.kind === 'hours') {
        body.append(h('button.w-btn.prim.w-pe', {
          type: 'button', style: { width: '100%', marginTop: 'calc(9px * var(--w-ts))' },
          onclick: () => { ui.click(); self._close(); blocked(can); },
        }, 'What can I do about it?'));
      }
    });
  }

  function raceResult(p) {
    const game = g();
    const v = game.race.view();
    const mayor = game.race.mayor();
    const won = !!p.won;
    const gap = Math.abs(Math.round(p.seconds - p.mayorSeconds));
    const splits = Array.isArray(p.splits) ? p.splits : [];
    /* the leg that cost the most against his even pace */
    let worst = null;
    for (const s of splits) if (!worst || s.lost > worst.lost) worst = s;

    return sheet({
      title: won ? 'You beat the Mayor' : 'The Mayor got there first',
      sub: secs(p.seconds) + ' against his ' + secs(p.mayorSeconds),
      glyph: won ? '🏆' : '🏁', tint: won ? BRAND.good : BRAND.warn,
    }, (body, self) => {
      /* the two clocks, side by side, at a size you can read across
         the room — this is the whole result */
      body.append(h('div.w-versus', null,
        h('div.side' + (won ? '.win' : ''), null,
          h('span.k', { text: 'You' }), h('b', { text: secs(p.seconds) }),
          h('span.d', { text: mps(v.metres, p.seconds) + ' average' })),
        h('div.gap', null, h('b', { text: (won ? '−' : '+') + gap + 's' }),
          h('span', { text: won ? 'clear' : 'behind' })),
        h('div.side' + (won ? '' : '.win'), null,
          h('span.k', { text: mayor.n.replace('Mayor ', '') }), h('b', { text: secs(p.mayorSeconds) }),
          h('span.d', { text: v.pace.mps + ' m/s average' }))));

      body.append(h('div.w-msg', null,
        h('div.hd', null, portrait(mayor, 26), mayor.n),
        h('div.bd', { text: p.line || '' })));

      if (splits.length) {
        body.append(label('Where the race went'));
        const track = h('div.w-route');
        for (const s of splits) {
          const ahead = s.lost <= 0;
          track.append(h('div.leg' + (ahead ? '.done' : '.lost'), null,
            h('span.n', { text: String(s.i) }),
            h('span.p', { text: s.n }),
            h('span.m', { text: (ahead ? '−' : '+') + Math.abs(Math.round(s.lost)) + 's' })));
        }
        body.append(track);
      }

      if (won) {
        body.append(h('div.w-warnbox.good', { text: 'The Stock Exchange will see you now.' }));
        return;
      }

      /* THE NUDGE, AND IT IS ARITHMETIC, NOT ADVICE. Two average
         speeds and the leg that cost the most. Nothing here says buy
         anything; it says he was quicker, and where. */
      const yourMps = p.seconds > 0 ? v.metres / p.seconds : 0;
      const hisMps = v.pace.mps;
      body.append(h('div.w-note', { text:
        'You took the same corners he did' + (worst ? ', and lost most of it on the run to ' + worst.n : '')
        + '. Over ' + v.metres + ' m he averaged ' + hisMps + ' m/s and you averaged '
        + (Math.round(yourMps * 10) / 10) + ' m/s. Close the ' + gap
        + '-second gap and the Exchange door is yours.' }));
      if (p.hint) {
        body.append(h('div.w-msg', { style: { marginTop: 'calc(9px * var(--w-ts))' } },
          h('div.hd', null, glyphAvatar(p.hint.from[0], BRAND.token, 26), p.hint.from),
          h('div.bd', { text: p.hint.text })));
      }
      put(body,
        kv('Your best', v.best ? secs(v.best) : secs(p.seconds)),
        kv('Attempts', String(v.attempts)),
      );
      const bar = h('div.w-row', { style: { marginTop: 'calc(10px * var(--w-ts))' } });
      bar.append(h('button.w-btn.prim.w-pe', {
        type: 'button', style: { flex: '1' },
        onclick: () => {
          ui.click();
          self._close();
          const chk = game.race.canStart();
          if (chk.ok) { const r = game.race.start(); if (!r.ok) res(r); else ui.closeAll(); }
          else ui.pushSheet(raceCard(), 'race');
        },
      }, icon('play', 15, { fill: 'currentColor', w: 1 }), 'Race him again'));
      bar.append(h('button.w-btn.ghost.w-pe', {
        type: 'button',
        onclick: () => { ui.click(); self._close(); },
      }, 'Later'));
      body.append(bar);
    });
  }

  /* ============================================================
     public
     ============================================================ */
  return {
    pause, settings, renderSettings, travel, place, desk, market,
    school, bank, pawn, homes, farm, mine, devlab, ipos, stadium,
    showOrder, talkTo, sheet, card, label,
    /* the buy path, the map, and the fare board the phone shares */
    quickBuy, bigMap, travelModes, bikeOffer, rideRow, rideList, rideShop, venueOf, assetNode,
    /* the Mayor's Dash and the two locked-out refusals */
    raceCard, raceResult, blocked,
  };
}
