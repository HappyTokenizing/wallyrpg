/* ============================================================
   phone.js — Wally's phone. Nine apps, all driven from ctx.game.

     Messages   the mentor, clients, the city (drives quest 1)
     Places     every location you have heard of + fares
     Clients    who you have met, what they like, how much they trust you
     Wallet     cash, net worth, holdings, tokenization, the loan
     Calendar   the day, deadlines, rent, opening hours
     News       the two headlines that moved prices this morning
     WallyNet   what the city says about you
     Progress   quests, milestones, statistics, the city percentage
     Settings   audio, quality, accessibility, save / load / export

   Opening Messages calls ctx.game.actions.readMessages(), which is
   what closes the very first objective.
   ============================================================ */

import { BRAND, CATEGORY, SEA, LAND, BUILD, css } from '../core/palette.js';
import { clamp } from '../core/contracts.js';
import {
  h, clear, icon, money, money2, pad2, portrait, glyphAvatar, hueFor,
  wallyMark, rgba, mix, C, meterColour, tickerTag,
} from './style.js';
import { cityMap } from './map.js';

export function createPhone(ctx, ui) {
  const g = () => ctx.game;

  /* ---------------- shell ---------------- */
  const clockEl = h('span', { text: '07:00' });
  const dayEl = h('span', { text: 'Day 1', style: { marginLeft: 'auto' } });
  const batFill = h('i', { style: { width: '100%' } });
  /* the terminal nub is a real sibling element, so it participates in
     the flex row and can never be sliced by the screen's corner arc */
  const status = h('div.w-status', null, clockEl, dayEl,
    h('div.batwrap', null, h('div.bat', null, batFill), h('i.batnub')));

  const backBtn = h('button.w-btn.sm.ghost.w-pe', {
    type: 'button', 'aria-label': 'Back',
    style: { display: 'none', minWidth: '34px', padding: '0 8px' },
    onclick: () => { ui.sfx('ui.back'); home(); },
  }, icon('back', 16));
  /* empty on the home screen: "Phone", on a phone, is zero
     information, and dropping it lets the icon grid start higher */
  const title = h('h3', { text: '' });
  const closeBtn = h('button.w-btn.sm.ghost.w-pe', {
    type: 'button', 'aria-label': 'Close',
    style: { marginLeft: 'auto', minWidth: '34px', padding: '0 8px' },
    onclick: () => { ui.sfx('ui.close'); ui.hide('phone'); },
  }, icon('close', 16));
  const appbar = h('div.w-appbar', null, backBtn, title, closeBtn);

  const body = h('div.w-appbody');
  const screen = h('div.w-screen', null, status, appbar, body);
  const root = h('div.w-phone.w-pe', { role: 'dialog', 'aria-label': 'Phone' },
    screen, h('div.w-home-ind', null, h('i')));

  /* ---------------- apps ---------------- */
  const APPS = [
    { id: 'messages', n: 'Messages', ic: 'chat',   tint: BRAND.token,  render: renderMessages, badge: () => g().actions.unreadCount() },
    { id: 'places',   n: 'Places',   ic: 'map',    tint: BRAND.info,   render: renderPlaces },
    { id: 'clients',  n: 'Clients',  ic: 'people', tint: CATEGORY.Culture, render: renderClients, badge: () => g().state.arrivals.length },
    { id: 'wallet',   n: 'Wallet',   ic: 'wallet', tint: BRAND.good,   render: renderWallet },
    { id: 'calendar', n: 'Calendar', ic: 'cal',    tint: BRAND.gem,    render: renderCalendar },
    { id: 'news',     n: 'News',     ic: 'news',   tint: CATEGORY.Business, render: renderNews },
    { id: 'wallynet', n: 'WallyNet', ic: 'net',    tint: CATEGORY.Infrastructure, render: renderWallyNet },
    { id: 'progress', n: 'Progress', ic: 'chart',  tint: BRAND.warn,   render: renderProgress },
    { id: 'settings', n: 'Settings', ic: 'gear',   tint: BUILD.metal,  render: (b) => ui.renderSettings(b) },
  ];
  const APP_BY_ID = {};
  for (const a of APPS) APP_BY_ID[a.id] = a;

  let current = null;

  function home() {
    current = null;
    const d = g().hud();
    /* "Phone", on a phone, is zero information. The greeting is the
       one thing that belongs in this row — it carries the time of day
       and it is warm, which the rest of the screen is not. */
    const part = (d.clock.split(' · ')[1] || '').toLowerCase();
    title.textContent = part ? 'Good ' + part : '';
    backBtn.style.display = 'none';
    clear(body);
    body.classList.add('home');
    const grid = h('div.w-apps');
    for (const a of APPS) {
      const tile = h('div.tile', {
        style: {
          background: `linear-gradient(160deg,${C(mix(a.tint, 0xffffff, 0.26))},${C(mix(a.tint, BRAND.ink, 0.22))})`,
        },
      }, icon(a.ic, 27, { w: 1.85 }));
      let n = 0;
      try { n = a.badge ? a.badge() : 0; } catch (e) { n = 0; }
      if (n > 0) tile.append(h('span.bdg', { text: n > 99 ? '99+' : String(n) }));
      grid.append(h('button.w-app.w-pe', {
        type: 'button',
        onclick: () => { ui.sfx('ui.select'); openApp(a.id); },
      }, tile, h('span.nm', { text: a.n })));
    }
    body.append(grid);

    /* "At a glance" — cards, not a definition list. Cash is the number
       the player opened the phone for, so it gets a hero card with a
       26px figure; the slower stats sit under it in a three-up. */
    const here = g().here();
    body.append(h('div.w-label', { text: 'At a glance' }));
    body.append(h('div.w-hero', null,
      h('div.ic', null, icon('cash', 22, { w: 1.8 })),
      h('div.w-grow', null,
        h('div.k', { text: 'Cash in hand' }),
        h('div.v', { text: money2(d.money) })),
      h('div.w', null,
        h('div.k', { text: 'You are at' }),
        h('div.n', { text: here ? here.n : '—' }))));
    body.append(h('div.w-stats', null,
      stat('net', 'Net worth', money(d.netWorth)),
      stat('star', 'Rep', String(Math.round(d.rep))),
      stat('city', 'City', d.cityPct + '%'),
    ));

    /* the next step, as a button — the phone is where the player looks
       when they do not know what to do */
    if (d.objective) {
      const q = d.objective;
      const where = g().quests.questLoc(q.id);
      const loc = where ? g().data.locationById[where] : null;
      body.append(h('button.w-card.w-pe', {
        type: 'button',
        style: {
          marginTop: 'calc(10px * var(--w-ts))',
          background: rgba(BRAND.token, 0.14),
          boxShadow: `inset 0 0 0 1.4px ${rgba(BRAND.token, 0.36)}`,
        },
        onclick: () => {
          ui.sfx('ui.select');
          ui.hide('phone');
          if (where) ui.goto(where, q.t); else ui.toast(q.d, 'token');
        },
      },
        h('div.ic', { style: { background: rgba(BRAND.token, 0.22), color: C(BRAND.token2) } }, icon('pin', 17)),
        h('div.w-grow', null,
          h('div.t', { text: q.t }),
          h('div.d', { text: loc ? loc.n + ' · ' + g().data.zones[loc.z].n : (q.hint || q.d) }))));
    }

    /* the mark, quietly, at the bottom of the home screen */
    const mark = wallyMark(56);
    body.append(h('div.foot', {
      style: {
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
        padding: 'calc(14px * var(--w-ts)) 0 calc(4px * var(--w-ts))', opacity: '.4',
      },
    }, mark, h('div', {
      text: 'WallyNet OS',
      style: { fontSize: '9.5px', letterSpacing: '.24em', fontWeight: '800', textTransform: 'uppercase' },
    })));
  }

  function openApp(id) {
    const a = APP_BY_ID[id];
    if (!a) return home();
    current = id;
    title.textContent = a.n;
    backBtn.style.display = '';
    clear(body);
    body.classList.remove('home');
    try { a.render(body); }
    catch (e) {
      console.error('[ui] app "' + id + '" failed', e);
      body.append(h('div.w-empty', { text: 'This app is not feeling well.' }));
    }
    body.scrollTop = 0;
  }

  /* ============================================================
     Messages
     ============================================================ */
  function renderMessages(b) {
    const st = g().state;
    const before = st.msgs.map((m) => m.read);
    const r = g().actions.readMessages();
    if (r.read) ui.sfx('ui.tab');

    if (!st.msgs.length) {
      b.append(h('div.w-empty', { text: 'No messages. The city has not noticed you yet.' }));
      return;
    }
    st.msgs.forEach((m, i) => {
      const wasUnread = before[i] === false;
      const hue = hueFor(m.from);
      const av = avatarFor(m.from, 30);
      b.append(h('div.w-msg' + (wasUnread ? '.unread' : ''), null,
        h('div.hd', null, av, m.from,
          h('span.when', { text: 'Day ' + m.day + ' · ' + timeStr(m.time) })),
        h('div.bd', { text: m.text })));
    });
  }

  function avatarFor(name, size) {
    const c = Object.values(g().data.clientById).find((x) => x.n === name);
    if (c) return portrait(c, size);
    if (/^wally$/i.test(name)) return glyphAvatar('W', BRAND.token, size);
    return glyphAvatar((name[0] || '?').toUpperCase(), hueFor(name), size);
  }
  const timeStr = (mins) => pad2(Math.floor((mins / 60) % 24)) + ':' + pad2(Math.floor(mins % 60));

  /* ============================================================
     Places — AN ACTUAL MAP.

     This screen used to be a list of buttons grouped by district,
     which is a table of contents. A map answers "where is that",
     "how far", "what is near it" and "which way", and none of those
     four could be answered here before. ui/map.js draws it from the
     same board coordinates the 3D island is projected from, so the
     map and the world cannot drift apart.

     Below the map: the selected place, then every way of getting to
     it at its real price in dollars, minutes and energy — the same
     fare board menus.js shows, so a fare reads the same wherever it
     is quoted, and the bicycle is offered for sale here rather than
     sitting greyed out with no way to learn what it is.
     ============================================================ */
  let placeSel = null;

  function renderPlaces(b) {
    const game = g();
    const st = game.state;
    const known = game.data.locations.filter((l) => game.known(l.id));
    if (!placeSel || !game.known(placeSel)) placeSel = st.loc;

    const detail = h('div');
    const map = cityMap(ctx, {
      compact: true,
      selected: placeSel,
      onPick: (id) => {
        placeSel = id;
        ui.sfx('ui.tab');
        ui.setDestination(id);
        drawDetail();
      },
    });
    b.append(map.el);

    b.append(h('div', {
      style: { display: 'flex', gap: 'calc(7px * var(--w-ts))', margin: '0 0 calc(8px * var(--w-ts))' },
    },
      h('button.w-btn.sm.ghost.w-pe', {
        type: 'button', style: { flex: '1' },
        onclick: () => { ui.sfx('ui.select'); ui.hide('phone'); ui.openMap(placeSel); },
      }, icon('map', 14), 'Full map'),
      h('button.w-btn.sm.ghost.w-pe', {
        type: 'button', style: { flex: '1' },
        title: 'Point the yellow HUD arrow at it',
        onclick: () => {
          ui.sfx('ui.select');
          ui.setDestination(placeSel);
          const l = game.data.locationById[placeSel];
          ui.toast('Pointing you at ' + (l ? l.n : 'it'), 'token');
        },
      }, icon('nav', 13, { fill: 'currentColor', w: 1 }), 'Point me')));

    b.append(detail);
    drawDetail();

    function drawDetail() {
      clear(detail);
      const l = game.data.locationById[placeSel];
      if (!l) return;
      const z = game.data.zones[l.z];
      const open = game.isOpen(l.id);
      const wp = ctx.wally?.position;
      const dist = wp ? Math.round(Math.hypot(l.world.x - wp.x, l.world.z - wp.z)) : null;
      detail.append(h('div.w-label', { text: z.n + ' · ' + z.blurb, style: { color: z.tint } }));
      detail.append(h('div.w-card', null,
        h('div.ic', { style: { fontSize: '17px', background: rgba(BRAND.ink, 0.06) }, text: l.ico }),
        h('div.w-grow', null,
          h('div.t', { text: l.n }),
          h('div.d', { text: st.loc === l.id ? 'You are here' : l.desc })),
        h('div.m', { style: { color: open ? C(BRAND.good) : C(BRAND.bad) } },
          open ? 'Open' : 'Closed',
          h('small', {
            text: dist != null && st.loc !== l.id ? dist + ' m'
              : pad2(l.hours[0]) + ':00–' + pad2(l.hours[1]) + ':00',
          }))));

      ui.renderTravelModes(detail, l.id, () => ui.hide('phone'));

      /* the rest of the city, still listed — the map is for finding,
         a list is for knowing what you have found */
      detail.append(h('div.w-label', {
        text: known.length + ' of ' + game.data.locations.length + ' places found',
      }));
      const bar = h('div.w-chipbar', {
        style: { flexWrap: 'wrap', overflowX: 'visible', rowGap: 'calc(6px * var(--w-ts))' },
      });
      for (const l2 of known) {
        bar.append(h('button.w-chip.w-pe' + (l2.id === placeSel ? '.on' : ''), {
          type: 'button', text: l2.ico + ' ' + l2.n,
          onclick: () => { ui.sfx('ui.tab'); placeSel = l2.id; map.select(l2.id); drawDetail(); },
        }));
      }
      detail.append(bar);
    }
  }

  /* ============================================================
     Clients
     ============================================================ */
  function renderClients(b) {
    const game = g();
    const st = game.state;
    const met = game.data.clients.filter((c) => st.clients[c.id]?.met);
    const arrivals = st.arrivals;

    if (arrivals.length) {
      b.append(h('div.w-label', { text: 'Waiting at your desk' }));
      for (const o of arrivals) {
        const c = game.data.clientById[o.client];
        b.append(h('button.w-card.w-pe', {
          type: 'button',
          onclick: () => { ui.sfx('ui.select'); ui.hide('phone'); ui.showOrder(o); },
        },
          portrait(c, 34),
          h('div.w-grow', null,
            h('div.t', { text: c.n }),
            h('div.d', { text: orderLine(o) })),
          h('div.m', { style: { color: C(BRAND.good) }, text: money(o.budget + o.fee) },
            h('small', { text: 'day ' + o.deadline }))));
      }
    }

    if (st.orders.length) {
      b.append(h('div.w-label', { text: 'Accepted · ' + st.orders.length + '/' + game.economy.orderSlots() }));
      for (const o of st.orders) {
        const c = game.data.clientById[o.client];
        const ready = game.economy.canComplete(o);
        const left = o.deadline - st.day;
        b.append(h('div.w-card', null,
          portrait(c, 34),
          h('div.w-grow', null,
            h('div.t', { text: c.n }),
            h('div.d', { text: orderLine(o) })),
          h('div.m', { style: { color: C(ready ? BRAND.good : left <= 1 ? BRAND.bad : BRAND.warn) } },
            ready ? 'Ready' : left + 'd left',
            h('small', { text: money(o.budget + o.fee) }))));
      }
    }

    b.append(h('div.w-label', { text: 'Met · ' + met.length + ' of ' + game.data.clients.length }));
    if (!met.length) {
      b.append(h('div.w-empty', { text: 'Nobody knows you yet. Take a shift, walk the city, knock on a door.' }));
    }
    for (const c of met) {
      const cs = st.clients[c.id];
      b.append(h('div.w-card', null,
        portrait(c, 38),
        h('div.w-grow', null,
          h('div.t', { text: c.n }),
          h('div.d', { text: c.role + ' · likes ' + c.fav.join(', ') })),
        h('div.m', null, trustDots(cs.trust),
          h('small', { text: cs.done + ' done' }))));
    }
  }
  /* an order, written the way a venue would quote it */
  function orderLine(o) {
    return (o.type === 'fund' ? 'Fund · ' : '') + g().economy.ticket(o);
  }
  function trustDots(n) {
    const wrap = h('span', { style: { display: 'inline-flex', gap: '3px' } });
    for (let i = 0; i < 5; i++) {
      wrap.append(h('i', {
        style: {
          width: '6px', height: '6px', borderRadius: '99px',
          background: i < Math.min(5, n) ? C(BRAND.token) : rgba(BRAND.ink, 0.16),
        },
      }));
    }
    return wrap;
  }

  /* ============================================================
     Wallet
     ============================================================ */
  function renderWallet(b) {
    const game = g();
    const st = game.state;
    const E = game.economy;

    b.append(bigNumber(money2(st.money), 'in hand', BRAND.good));

    /* THE BUY BOX LIVES HERE. The wallet is where a player looks
       when they are thinking about money, and "buy something" was
       the one verb the phone could not do — every purchase used to
       require already knowing which of nine venues stocked the
       thing, and then walking there to find out. */
    b.append(h('button.w-card.w-pe', {
      type: 'button',
      style: {
        background: rgba(BRAND.token, 0.14),
        boxShadow: `inset 0 0 0 1.4px ${rgba(BRAND.token, 0.36)}`,
      },
      onclick: () => { ui.sfx('ui.select'); ui.hide('phone'); ui.openQuickBuy(); },
    },
      h('div.ic', { style: { background: rgba(BRAND.token, 0.22), color: C(BRAND.token2) } }, icon('search', 17)),
      h('div.w-grow', null,
        h('div.t', { text: 'Buy an asset by ticker' }),
        h('div.d', { text: 'GOLD · WHEAT · B5Y · TEAM — price, venue and total before you confirm' })),
      h('div.m', { text: 'B', style: { color: C(BRAND.token2) } })));

    put(b,
      kv('Net worth', money(E.netWorth())),
      kv('Holdings', E.invCount() + ' / ' + E.invCap() + ' units'),
      kv('Distinct assets', E.distinctOwned() + ' / ' + game.data.config.totalAssets),
      st.loan > 0 ? kv('Loan outstanding', money2(st.loan)) : null,
    );

    const ids = Object.keys(st.inv).filter((k) => st.inv[k].qty > 0);
    b.append(h('div.w-label', { text: 'Portfolio' }));
    if (!ids.length) {
      b.append(h('div.w-empty', { text: 'You own nothing yet. That is the whole game, really.' }));
      return;
    }
    ids.sort((a, c) => E.price(c) * st.inv[c].qty - E.price(a) * st.inv[a].qty);
    for (const id of ids) {
      const a = game.data.assetById[id];
      const e = st.inv[id];
      const val = E.price(id) * e.qty;
      const tok = !!st.tokenized[id];
      const chk = tok ? null : E.canTokenize(id);
      const row = h('div.w-card', null,
        h('div.ic', { style: { fontSize: '17px', background: rgba(CATEGORY[a.cat] ?? BRAND.info, 0.16) }, text: a.ico }),
        /* The symbol on its own line and the English name under it:
           on a 360 px screen a row carrying a chip, a name, a value
           and a Tokenize button has no width left, and the first
           build of this truncated the name to "Wheat …". The ticker
           is the handle, so the ticker gets the line. */
        h('div.w-grow', { style: { minWidth: '0' } },
          h('div', { style: { display: 'flex' } }, tickerTag(a, { qty: e.qty })),
          h('div.d', {
            text: a.n + ' · ' + e.qty + ' × ' + money2(E.price(id))
              + (e.locked ? ' · ' + e.locked + ' locked' : ''),
          })),
        h('div.m', { text: money(val) },
          h('small', { text: a.cat })));
      b.append(row);
      if (tok) {
        row.append(h('span', {
          text: 'TOKEN',
          style: {
            marginLeft: '8px', fontSize: '9px', fontWeight: '800', letterSpacing: '.12em',
            color: C(BRAND.token2), background: rgba(BRAND.token, 0.18),
            padding: '3px 6px', borderRadius: '6px',
          },
        }));
      } else if (chk && chk.ok) {
        const btn = h('button.w-btn.sm.prim.w-pe', {
          type: 'button', style: { marginLeft: '8px' },
          onclick: () => {
            const r = game.actions.tokenize(id);
            if (r.ok) { ui.sfx('token'); ui.refresh(); openApp('wallet'); }
            else { ui.sfx('ui.error'); ui.toast(r.why, 'bad'); }
          },
        }, 'Tokenize ' + money(chk.cost));
        row.append(btn);
      }
    }
  }

  /* ============================================================
     Calendar
     ============================================================ */
  function renderCalendar(b) {
    const game = g();
    const st = game.state;
    b.append(bigNumber('Day ' + st.day, game.time.clock(), BRAND.gem));

    b.append(h('div.w-label', { text: 'Deadlines' }));
    if (!st.orders.length) b.append(h('div.w-empty', { text: 'Nothing is due. Enjoy it.' }));
    for (const o of st.orders) {
      const c = game.data.clientById[o.client];
      const left = o.deadline - st.day;
      b.append(h('div.w-card', null,
        portrait(c, 32),
        h('div.w-grow', null,
          h('div.t', { text: c.n }),
          h('div.d', { text: orderLine(o) })),
        h('div.m', { style: { color: C(left <= 1 ? BRAND.bad : left <= 2 ? BRAND.warn : BRAND.good) } },
          left <= 0 ? 'today' : left + ' days',
          h('small', { text: 'day ' + o.deadline }))));
    }

    b.append(h('div.w-label', { text: 'Standing' }));
    const home = game.data.homeById[st.home];
    put(b,
      kv('Rent · ' + home.n, money(home.rent) + ' on day ' + st.rentDay),
      st.employees.length ? kv('Salaries', money(st.employees.reduce((t, e) => t + game.data.employeeById[e].salary, 0)) + ' / day') : null,
      st.funds.length ? kv('Management fees', st.funds.length + ' fund' + (st.funds.length > 1 ? 's' : '') + ' · weekly') : null,
    );

    b.append(h('div.w-label', { text: 'Open right now' }));
    const openNow = game.data.locations.filter((l) => game.known(l.id) && game.isOpen(l.id));
    b.append(h('div.w-chipbar', null, ...openNow.slice(0, 14).map((l) =>
      h('span.w-chip', { text: l.ico + ' ' + l.n }))));
    if (!openNow.length) b.append(h('div.w-empty', { text: 'The city is asleep.' }));
  }

  /* ============================================================
     News
     ============================================================ */
  function renderNews(b) {
    const game = g();
    const st = game.state;
    if (!st.news.length) {
      b.append(h('div.w-empty', { text: 'The presses run overnight. Come back tomorrow.' }));
      return;
    }
    b.append(h('div.w-label', { text: 'Day ' + st.day + ' · Bull Bear Bugle' }));
    for (const n of st.news) {
      const a = game.data.assetById[n.a];
      const up = n.e >= 0;
      b.append(h('div.w-msg', null,
        h('div.hd', null,
          h('span', { text: a ? a.ico : '📰', style: { fontSize: '16px' } }),
          n.h,
          h('span.when', {
            text: (up ? '▲ ' : '▼ ') + Math.abs(Math.round(n.e * 100)) + '%',
            style: { color: C(up ? BRAND.good : BRAND.bad) },
          })),
        h('div.bd', { text: n.t + (a ? '  —  ' + a.n : '') })));
    }
  }

  /* ============================================================
     WallyNet
     ============================================================ */
  function renderWallyNet(b) {
    const game = g();
    const st = game.state;
    b.append(bigNumber(String(Math.round(st.rep)), 'reputation', BRAND.token));
    if (!st.wallynet.length) {
      b.append(h('div.w-empty', { text: 'Nobody has posted about you. Yet.' }));
      return;
    }
    b.append(h('div.w-label', { text: 'What the city says' }));
    for (const p of st.wallynet) {
      b.append(h('div.w-msg', null,
        h('div.hd', null,
          avatarFor(p.who, 26),
          p.who,
          h('span.when', {
            text: p.good ? '★★★★★' : '★',
            style: { color: C(p.good ? BRAND.token : BRAND.bad), letterSpacing: '1px' },
          })),
        h('div.bd', { text: p.text })));
    }
  }

  /* ============================================================
     Progress
     ============================================================ */
  function renderProgress(b) {
    const game = g();
    const st = game.state;
    const pr = game.quests.progress();
    const pct = game.economy.cityPct();

    b.append(bigRing(pct));
    put(b,
      kv('Story', pr.done + ' / ' + pr.total + ' objectives'),
      kv('Assets owned', game.economy.distinctOwned() + ' / ' + game.data.config.totalAssets),
      kv('Tokenized', Object.keys(st.tokenized).length + ' / ' + game.data.config.totalAssets),
      kv('Clients met', game.data.clients.filter((c) => st.clients[c.id].met).length + ' / ' + game.data.clients.length),
      kv('Places found', Object.keys(st.known).length + ' / ' + game.data.locations.length),
    );

    b.append(h('div.w-label', { text: 'Objectives' }));
    let act = -1;
    for (const q of game.data.quests) {
      const done = !!st.quests[q.id];
      const cur = !done && game.quests.current()?.id === q.id;
      if (!done && !cur && act >= 0) {
        /* hide the far future — one step ahead is enough */
        if (q.act > act + 1) continue;
      }
      if (q.act !== act) { act = q.act; b.append(h('div.w-label', { text: 'Act ' + act })); }
      b.append(h('div.w-card', {
        style: cur ? { boxShadow: `inset 0 0 0 1.6px ${rgba(BRAND.token, 0.6)}` } : null,
      },
        h('div.ic', {
          style: {
            background: done ? rgba(BRAND.good, 0.2) : cur ? rgba(BRAND.token, 0.22) : rgba(BRAND.ink, 0.06),
            color: C(done ? BRAND.good : cur ? BRAND.token2 : BRAND.ink),
          },
        }, icon(done ? 'check' : cur ? 'pin' : 'info', 17)),
        h('div.w-grow', null,
          h('div.t', { text: q.t, style: done ? { opacity: '.62' } : null }),
          h('div.d', { text: done ? 'Complete' : q.d }))));
    }

    b.append(h('div.w-label', { text: 'Milestones' }));
    for (const m of game.data.milestones) {
      const hit = pct >= m.p;
      b.append(h('div.w-kv', null,
        h('span', { text: m.p + '% · ' + m.t, style: hit ? null : { opacity: '.45' } }),
        h('b', { text: hit ? '✔' : '—', style: { color: hit ? C(BRAND.good) : 'inherit' } })));
    }

    b.append(h('div.w-label', { text: 'Statistics' }));
    const s = st.stats;
    for (const [k, v] of [
      ['Days played', s.daysPlayed], ['Shifts worked', s.jobsDone],
      ['Orders delivered', s.ordersDone], ['Orders failed', s.ordersFailed],
      ['Classes passed', s.classes], ['Companies listed', s.ipos],
      ['Meals eaten', s.meals], ['Trips taken', s.trips],
      ['Earned', money(s.earned)], ['Spent', money(s.spent)],
    ]) b.append(kv(k, String(v)));
  }

  /* ============================================================
     small shared bits
     ============================================================ */
  function kv(k, v) {
    if (v == null) return null;
    return h('div.w-kv', null, h('span', { text: k }), h('b', { text: v }));
  }
  /* one small stat card: icon + tracked-caps name + figure */
  function stat(ic, k, v) {
    return h('div.w-stat', null,
      h('div.k', null, icon(ic, 11, { w: 2 }), k),
      h('div.v', { text: v }));
  }
  /* Element.append() stringifies null — always go through this. */
  const put = (parent, ...nodes) => { for (const n of nodes) if (n) parent.append(n); return parent; };
  function bigNumber(big, small, tint) {
    return h('div', {
      style: {
        textAlign: 'center', padding: '14px 0 10px',
      },
    },
      h('div', {
        text: big,
        style: {
          fontSize: 'calc(34px * var(--w-ts))', fontWeight: '800', letterSpacing: '-.02em',
          color: C(tint), lineHeight: '1.05',
        },
      }),
      h('div', {
        text: small,
        style: {
          fontSize: 'calc(10px * var(--w-ts))', letterSpacing: '.2em', textTransform: 'uppercase',
          fontWeight: '800', opacity: '.5', marginTop: '4px',
        },
      }));
  }
  function bigRing(pct) {
    const R = 40, CIRC = 2 * Math.PI * R;
    const wrap = h('div', { style: { display: 'grid', placeItems: 'center', padding: '12px 0 6px' } });
    wrap.innerHTML = `<svg viewBox="0 0 100 100" width="120" height="120">
      <circle cx="50" cy="50" r="${R}" fill="none" stroke="${rgba(BRAND.ink, 0.10)}" stroke-width="9"/>
      <circle cx="50" cy="50" r="${R}" fill="none" stroke="${C(BRAND.token)}" stroke-width="9"
        stroke-linecap="round" stroke-dasharray="${CIRC}"
        stroke-dashoffset="${CIRC * (1 - clamp(pct, 0, 100) / 100)}"
        transform="rotate(-90 50 50)"/>
      <text x="50" y="52" text-anchor="middle" font-size="24" font-weight="800"
        fill="${C(BRAND.ink)}" font-family="inherit">${pct}%</text>
      <text x="50" y="66" text-anchor="middle" font-size="7.4" font-weight="800"
        letter-spacing="1.6" fill="${rgba(BRAND.ink, 0.5)}" font-family="inherit">CITY TOKENIZED</text>
    </svg>`;
    return wrap;
  }

  /* ============================================================
     public
     ============================================================ */
  function tickStatus() {
    const game = g();
    if (!game) return;
    clockEl.textContent = timeStr(game.state.time);
    dayEl.textContent = 'Day ' + game.state.day;
    const e = clamp(game.state.energy, 0, 100);
    batFill.style.width = Math.max(6, e) + '%';
    batFill.style.background = meterColour(e);
  }

  return {
    root,
    open(app) {
      tickStatus();
      if (app && APP_BY_ID[app]) openApp(app);
      else if (current) openApp(current);
      else home();
    },
    home,
    refresh() {
      tickStatus();
      if (current) openApp(current);
      else home();
    },
    get app() { return current; },
    back() {
      if (current) { home(); return true; }
      return false;
    },
    dispose() { root.remove(); },
  };
}
