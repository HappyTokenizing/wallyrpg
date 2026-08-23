/* 7. EVERY CLAIM IN THE data.js FARES COMMENT, checked against the code. */
import DATA, { TRAVEL, RIDES, CONFIG, LOCATIONS, LOC_BY_ID, HOP_METRES, FAST_MODES, SELF_MODES,
  hops, fare, rideFare, worldDistance, strideCost, isFastTravel } from '../../src/game/data.js';
import { readFileSync } from 'node:fs';
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '   ' + x : ''}`); return !!c; };
const near = (a, b, t = 0.051) => Math.abs(a - b) <= t;

/* ---- a pair of locations at exactly h hops apart ---- */
function pairAt(h) {
  for (const a of LOCATIONS) for (const b of LOCATIONS) if (a !== b && hops(a.id, b.id) === h) return [a.id, b.id];
  return null;
}
console.log('=== the printed 1/3/5/8-hop table ===');
const TABLE = {
  walk:  { 1: [0, 15, 4.2],  3: [0, 41, 12.6], 5: [0, 67, 21.0], 8: [0, 106, 33.6] },
  bike:  { 1: [0, 6, 1.5],   3: [0, 16, 4.5],  5: [0, 26, 7.5],  8: [0, 41, 12.0] },
  train: { 1: [3.50, 9, 5.7], 3: [6.50, 15, 10.1], 5: [9.50, 21, 14.5], 8: [14.00, 30, 21.1] },
  trunk: { 1: [24.20, 5, 0.1], 3: [51.80, 9, 0.4], 5: [89.00, 13, 0.8], 8: [162.80, 19, 1.2] },
};
for (const mode of Object.keys(TABLE)) for (const h of [1,3,5,8]) {
  const p = pairAt(h);
  const f = p ? fare(mode, p[0], p[1], mode === 'bike' ? 'bike' : undefined) : null;
  const [c, m, e] = TABLE[mode][h];
  if (!f) { ok(false, `${mode} @${h} hops — no pair at that distance`); continue; }
  ok(near(f.cost, c, 0.011) && near(f.mins, m, 0.51) && near(f.energy, e, 0.051),
    `${mode} @${h} hops = $${c} / ${m}m / ${e}e`, `got $${f.cost} / ${f.mins}m / ${f.energy}e  (${p.join('->')})`);
}
console.log('\n=== the ride-minutes table ===');
const RT = { bike: [6,16,26,41], scooter: [4,11,17,27], motorcycle: [3,5,9,14] };
for (const r of Object.keys(RT)) [1,3,5,8].forEach((h, i) => {
  const p = pairAt(h); const f = rideFare(r, p[0], p[1]);
  ok(near(f.mins, RT[r][i], 0.51), `${r} @${h} hops = ${RT[r][i]} min`, `got ${f.mins}`);
});

console.log('\n=== HOP_METRES and its flatness claim ===');
ok(near(HOP_METRES, 104, 0.6), 'HOP_METRES ~ 104 m', String(HOP_METRES));
const byHop = {};
for (let i=0;i<LOCATIONS.length;i++) for (let j=i+1;j<LOCATIONS.length;j++) {
  const a=LOCATIONS[i], b=LOCATIONS[j], h=hops(a.id,b.id), d=worldDistance(a.id,b.id);
  if (d>1) (byHop[h] ||= []).push(d/h);
}
const med = (arr)=>{const s=[...arr].sort((x,y)=>x-y);return s[s.length>>1];};
const meds = {}; for (const h of Object.keys(byHop).sort((a,b)=>a-b)) meds[h] = +med(byHop[h]).toFixed(1);
console.log('   median m/hop by hop count:', JSON.stringify(meds));
const hs = [1,2,3,4,5,6,7,8].filter(h=>meds[h]!=null);
ok(hs.every(h=>meds[h]>=100 && meds[h]<=110), 'flat 100–110 m at every hop count 1..8', JSON.stringify(meds));
ok(near(meds[1],109,0.6), 'claim: 109 at 1 hop', String(meds[1]));
ok(near(meds[8],100,0.6), 'claim: 100 at 8 hops', String(meds[8]));

console.log('\n=== strideCost table ===');
const SC = [['foot',['walk',null],0.0404,4.2,33.6],['bicycle',['bike','bike'],0.0144,1.5,12.0],
  ['scooter',['bike','scooter'],0.0043,0.45,3.6],['moto',['bike','motorcycle'],0.0036,0.38,3.0]];
for (const [n,[m,r],em,one,eight] of SC) {
  const v = strideCost(m,r);
  ok(near(v,em,0.00006), `${n} e/m = ${em}`, String(v));
  ok(near(v*HOP_METRES, one, 0.051), `${n} one hop = ${one} e`, (v*HOP_METRES).toFixed(3));
  ok(near(v*HOP_METRES*8, eight, 0.11), `${n} 8 hops = ${eight} e`, (v*HOP_METRES*8).toFixed(3));
}
ok(strideCost('train')===0 && strideCost('trunk')===0, 'zero for the Metro and the Yoober');

console.log('\n=== the identity the "not a cap" argument rests on ===');
for (const [n,[m,r]] of SC.map(x=>[x[0],x[1]])) {
  const t = TRAVEL[m]; const eff = m==='bike' ? RIDES[r].effort : 1;
  ok(Math.abs(strideCost(m,r) - (t.energy*eff)/HOP_METRES) < 1e-9,
    `${n}: strideCost === (table energy x effort) / HOP_METRES`);
}

console.log('\n=== the fast/self split ===');
ok(Object.keys(TRAVEL).length === 4, 'four modes');
ok(FAST_MODES.join(',')==='train,trunk', 'only the Metro and the Yoober are fast', FAST_MODES.join(','));
ok(SELF_MODES.join(',')==='walk,bike', 'walk and bike are self-powered', SELF_MODES.join(','));
ok(isFastTravel('train') && isFastTravel('trunk') && !isFastTravel('walk') && !isFastTravel('bike'), 'isFastTravel agrees');

console.log('\n=== prose claims ===');
ok(CONFIG.minutesPerSecond === 0.5, 'CONFIG.minutesPerSecond = 0.5', String(CONFIG.minutesPerSecond));
ok(CONFIG.forceSleepMin === 25*60, 'forceSleepMin is 25:00', String(CONFIG.forceSleepMin));
ok(TRAVEL.train.hours[0]===5 && TRAVEL.train.hours[1]===24, 'Metro runs 05:00–00:00', JSON.stringify(TRAVEL.train.hours));
const apt = LOC_BY_ID.apartment, gh = LOC_BY_ID.penthouse;
ok(hops('apartment','penthouse')===7, 'apartment to Golden Heights is 7 hops', String(hops('apartment','penthouse')));
let maxH=0, maxPair=null;
for (const a of LOCATIONS) for (const b of LOCATIONS) { const h=hops(a.id,b.id); if (h>maxH){maxH=h;maxPair=[a.id,b.id];} }
ok(maxH===8, '8 is the widest trip on the island', `${maxH} (${maxPair})`);
/* "apartment to Golden Heights is 7" is offered as the reason 8 is the
   widest; check that 8 really exists and where */
console.log('   widest pair:', maxPair.join(' -> '), '=', maxH, 'hops');

/* METRO: "per MINUTE roughly twice as tiring as walking" */
console.log('\n=== metro per-minute claim ===');
for (const h of [1,3,5,8]) {
  const p = pairAt(h);
  const w = fare('walk', p[0], p[1]), t = fare('train', p[0], p[1]);
  const rw = w.energy/w.mins, rt = t.energy/t.mins;
  console.log(`   ${h} hops: walk ${rw.toFixed(3)} e/min · metro ${rt.toFixed(3)} e/min · ratio ${(rt/rw).toFixed(2)}x`);
}
{
  const rs = [1,3,5,8].map(h=>{const p=pairAt(h);const w=fare('walk',p[0],p[1]),t=fare('train',p[0],p[1]);return (t.energy/t.mins)/(w.energy/w.mins);});
  ok(rs.every(r=>r>1.6 && r<2.6), 'the Metro is ~2x as tiring per minute as walking, at every distance', rs.map(r=>r.toFixed(2)).join(', '));
}
/* BIKE: "less than half the time, a third of the energy" */
console.log('\n=== bike claim ===');
{
  const tR=[], eR=[];
  for (const h of [1,3,5,8]) { const p=pairAt(h); const w=fare('walk',p[0],p[1]), b=rideFare('bike',p[0],p[1]);
    tR.push(b.mins/w.mins); eR.push(b.energy/w.energy); }
  console.log('   bike/walk minutes:', tR.map(r=>r.toFixed(2)).join(', '), ' energy:', eR.map(r=>r.toFixed(2)).join(', '));
  ok(tR.every(r=>r<0.5), 'less than half the time');
  ok(eR.every(r=>Math.abs(r-1/3)<0.02), 'a third of the energy');
}
/* YOOBER: hop^2 surge, never cheap */
console.log('\n=== yoober claim ===');
{
  const p1=pairAt(1); const f1=fare('trunk',p1[0],p1[1]);
  ok(f1.cost>20, 'never cheap even for one hop', `$${f1.cost}`);
  ok(TRAVEL.trunk.per>0 && TRAVEL.trunk.surge>0, 'a per-hop term AND a hop^2 surge');
  const c=[1,3,5,8].map(h=>{const p=pairAt(h);return fare('trunk',p[0],p[1]).cost;});
  ok(c[3]/c[0] > 8/1, 'the fare climbs faster than the distance', `${c.join(' / ')} for 1/3/5/8 hops`);
}
/* "the metro across town is nine dollars and a quarter of your day's energy" */
{
  const p=pairAt(8); const t=fare('train',p[0],p[1]);
  console.log(`   metro at the widest trip (8 hops): $${t.cost} / ${t.energy} e`);
  const p5=pairAt(5); const t5=fare('train',p5[0],p5[1]);
  console.log(`   metro at 5 hops: $${t5.cost} / ${t5.energy} e`);
  ok(near(t5.cost, 9.5, 0.01), '"nine dollars" is the 5-hop metro fare ($9.50)', `$${t5.cost}`);
  ok(t5.energy/100 > 0.13 && t5.energy/100 < 0.26, '…and 14.5 e is a seventh of a full bar, not a quarter — the QUARTER is the 8-hop trip at 21.1 e', `${t5.energy}e / ${t.energy}e`);
}
/* "walking one hop is fifteen minutes you did not have to pay for" */
{ const p=pairAt(1); const w=fare('walk',p[0],p[1]); ok(w.mins===15 && w.cost===0, 'walking one hop is 15 free minutes', `${w.mins} min $${w.cost}`); }
/* the m/s table read out of wally.js */
console.log('\n=== the speeds table, read out of character/wally.js ===');
const wsrc = readFileSync(new URL('../../src/character/wally.js', import.meta.url), 'utf8');
const foot = wsrc.match(/walkSpeed:\s*2\.45[\s\S]{0,40}?runSpeed:\s*5\.90/);
ok(!!foot, 'on foot 2.45 -> 5.90');
for (const [n, w, r] of [['bicycle',5.10,8.80],['scooter',7.65,13.20],['motorcycle',15.30,26.40]])
  ok(wsrc.includes(`walkSpeed: ${w.toFixed(2)}`) && wsrc.includes(`runSpeed: ${r.toFixed(2)}`), `${n} ${w} -> ${r}`);
/* derived: real seconds and game minutes for one hop */
console.log('   derived one-hop times at HOP_METRES =', HOP_METRES);
for (const [n, w, r, tbl] of [['on foot',2.45,5.90,15],['bicycle',5.10,8.80,6],['scooter',7.65,13.20,4],['motorcycle',15.30,26.40,3]]) {
  const sC = HOP_METRES/w, sF = HOP_METRES/r;
  console.log(`     ${n.padEnd(11)} ${Math.round(sC)} -> ${Math.round(sF)} real s · ${Math.round(sC*CONFIG.minutesPerSecond)} -> ${Math.round(sF*CONFIG.minutesPerSecond)} game min · table ${tbl}`);
}
{
  const rows = [['on foot',2.45,5.90,42,18,21,9],['bicycle',5.10,8.80,20,12,10,6],['scooter',7.65,13.20,14,8,7,4],['motorcycle',15.30,26.40,7,4,3,2]];
  for (const [n,w,r,sc,sf,mc,mf] of rows) {
    const SC2=HOP_METRES/w, SF=HOP_METRES/r;
    ok(Math.abs(Math.round(SC2)-sc)<=1 && Math.abs(Math.round(SF)-sf)<=1, `${n}: ${sc} -> ${sf} real s`, `${Math.round(SC2)} -> ${Math.round(SF)}`);
    ok(Math.abs(Math.round(SC2*0.5)-mc)<=1 && Math.abs(Math.round(SF*0.5)-mf)<=1, `${n}: ${mc} -> ${mf} game minutes`, `${Math.round(SC2*0.5)} -> ${Math.round(SF*0.5)}`);
  }
}
/* "~26 minutes for a five-hop [bicycle] leg that takes ~50" */
{
  const p=pairAt(5); const b=rideFare('bike',p[0],p[1]);
  const realMin = (worldDistance(p[0],p[1])/5.10)*CONFIG.minutesPerSecond;
  ok(near(b.mins,26,0.51) && realMin>45 && realMin<56, 'the 5-hop bicycle leg: board ~26 min, cruise ~50', `board ${b.mins}, cruise ${realMin.toFixed(0)}`);
}
/* "from the far side of the island a cruise-walk is ~164 minutes" */
{
  const p=pairAt(8);
  const d = worldDistance(p[0],p[1]);
  const mins = (d/2.45)*CONFIG.minutesPerSecond;
  ok(near(mins,164,6), 'a cruise-walk across the island is ~164 minutes', `${mins.toFixed(0)} min over ${d.toFixed(0)} m (${p.join('->')})`);
  const setOff = 25*60 - mins;
  ok(Math.abs(setOff - 22.25*60) < 12, 'so ~22:15 is the last safe departure', `${Math.floor(setOff/60)}:${String(Math.round(setOff%60)).padStart(2,'0')}`);
}
/* his flat is open all hours */
ok(!LOC_BY_ID.apartment.hours || (LOC_BY_ID.apartment.hours[0]===0 && LOC_BY_ID.apartment.hours[1]===24),
  'his own flat is open 00:00–24:00', JSON.stringify(LOC_BY_ID.apartment.hours));
/* "76 m to the pawnshop … then 900 m … an 11.8x discount" */
{
  const d = worldDistance('apartment','pawnshop');
  ok(near(d,76,1.0), 'the pawnshop really is 76 m from the flat', d.toFixed(1));
  ok(near(fare('walk','apartment','pawnshop').energy, 4.2, 0.01), '…and quotes 4.2 e');
  ok(near(900/76, 11.8, 0.1), '…and 900/76 is the 11.8x that was measured', (900/76).toFixed(2));
}
/* "535 m apartment-to-mine walk" */
{ const d = worldDistance('apartment','mine'); ok(near(d,535,2), 'the apartment-to-mine walk really is 535 m', d.toFixed(1)); }
/* mode ids in the places the comment says they are */
{
  const menus = readFileSync(new URL('../../src/ui/menus.js', import.meta.url),'utf8');
  const tt = readFileSync(new URL('../traveltest.mjs', import.meta.url),'utf8');
  ok(/MODE_ICON[\s\S]{0,300}train/.test(menus) && /MODE_ICON[\s\S]{0,300}trunk/.test(menus), "'train'/'trunk' are in ui/menus.js's icon map");
  ok(tt.includes("'train'")||tt.includes('"train"'), "…and in tools/traveltest.mjs");
}
console.log(`\n${fails} claim(s) failed.`);
