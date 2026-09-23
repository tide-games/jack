// tests.js — run: node tests.js  (exits non-zero on failure)
import { createHash } from 'node:crypto';
import {
  DECKS, SHOE_SIZE, CUT, MAX_HANDS, valueOf, handValue, isBlackjack, shoeFromSeed, hiLo, runningCount,
  deal, takeInsurance, hit, stand, doubleDown, split, surrender, apply, canSplit, canDouble, canSurrender,
  legalActions, costOf, settle, verifyHand, basicStrategy, bookSays, actionEVs, pastCut, isSeed,
} from './jack.js';

let fails = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  ok ', name);
  else { fails++; console.error('  FAIL', name, detail ?? ''); }
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
function findSeed(pred, limit = 60000, cursor = 0) {
  for (let i = 0; i < limit; i++) {
    const s = sha256('find' + i);
    try { if (pred(s, cursor)) return s; } catch { /* keep looking */ }
  }
  return null;
}
// cards by value (suit ♠): 2..10, ace = 0
const C = { A: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9, J: 10, Q: 11, K: 12 };
// a hand-built state for exact scenarios (the engine's own shape)
function rig(player, dealer, bet = 10, extra = []) {
  const st = deal(sha256('rig'), bet, 0);
  st.hands = [{ cards: player, pos: [900, 902], bet, doubled: false, stood: false, busted: false, fromSplit: false, splitAces: false, surrendered: false }];
  st.dealer = dealer; st.dealerPos = [901, 903]; st.phase = 'player'; st.active = 0; st.insurance = 0; st.decisions = [];
  return st;
}

// ---- cards & totals
{
  ok(handValue([C.A, C[10]]).total === 21 && isBlackjack([C.A, C.K]), 'A + 10 is blackjack');
  ok(handValue([C.A, C.A]).total === 12 && handValue([C.A, C.A]).soft, 'A + A is soft 12');
  ok(handValue([C.A, C[5], C[10]]).total === 16 && !handValue([C.A, C[5], C[10]]).soft, 'A + 5 + 10 is hard 16');
  ok(handValue([C.A, C[6], C[4]]).total === 21, 'A + 6 + 4 rides the soft ace to 21');
  ok(hiLo(C[2]) === 1 && hiLo(C[6]) === 1 && hiLo(C[7]) === 0 && hiLo(C[9]) === 0 && hiLo(C.K) === -1 && hiLo(C.A) === -1, 'Hi-Lo tags');
}

// ---- the shoe
{
  const shoe = shoeFromSeed(sha256('a'));
  ok(shoe.length === SHOE_SIZE && SHOE_SIZE === DECKS * 52, 'six decks in the shoe');
  const counts = {};
  for (const c of shoe) counts[c] = (counts[c] || 0) + 1;
  ok(Object.keys(counts).length === 52 && Object.values(counts).every((n) => n === DECKS), 'every card appears exactly six times');
  ok(JSON.stringify(shoeFromSeed(sha256('a'))) === JSON.stringify(shoe), 'the same seed shuffles the same shoe');
  ok(JSON.stringify(shoeFromSeed(sha256('b'))) !== JSON.stringify(shoe), 'a different seed shuffles differently');
  const s1 = sha256('x'), s2 = s1.slice(0, 32) + sha256('y').slice(32);
  ok(JSON.stringify(shoeFromSeed(s1)) !== JSON.stringify(shoeFromSeed(s2)), 'all 256 bits of the seed matter');
  ok(isSeed(s1) && !isSeed('ab') && !isSeed(s1.toUpperCase()), 'seeds are exactly 64 lowercase hex');
  let threw = false; try { deal('ab', 10); } catch { threw = true; }
  ok(threw, 'a malformed seed is refused');
  threw = false; try { deal(s1, 10, CUT); } catch { threw = true; }
  ok(threw && pastCut(CUT) && !pastCut(CUT - 1), 'no hand is dealt past the cut card');
  ok(CUT === 234, 'the cut card sits at 75% (234 of 312)');
  // shoe positions are consecutive and match the cards
  const st = deal(s1, 10, 17);
  ok(st.hands[0].pos.join() === '17,19' && st.dealerPos.join() === '18,20', 'deal order: player, dealer, player, dealer');
  ok(st.hands[0].cards.every((c, i) => shoeFromSeed(s1)[st.hands[0].pos[i]] === c), 'each card knows its place in the shoe');
  const rc = runningCount(s1, 40);
  ok(rc === shoeFromSeed(s1).slice(0, 40).reduce((a, c) => a + hiLo(c), 0), 'the running count sums Hi-Lo over dealt cards');
}

// ---- money is exact: odd bets pay halves, never rounded toward the house
{
  const bj = rig([C.A, C.K], [C[9], C[7]], 5);
  const st = stand(bj);                 // (rigged state; stand settles)
  const p = settle({ ...st, hands: [{ ...st.hands[0], stood: true }], phase: 'settled' });
  ok(p.outcomes[0].verdict === 'blackjack' && p.returned === 12.5 && p.delta === 7.5, 'blackjack on 5 pays 7.5 exactly', JSON.stringify(p));
  const s25 = findSeed((sd) => { const x = deal(sd, 25); return x.phase === 'settled' && x.hands[0].cards.length === 2 && isBlackjack(x.hands[0].cards) && !isBlackjack(x.dealer); });
  ok(s25 && settle(deal(s25, 25)).delta === 37.5, 'blackjack on 25 pays 37.5 (the house keeps no half chips)');
  // insurance on an odd bet
  const sIns = findSeed((sd) => { const x = deal(sd, 7); return x.phase === 'insurance' && isBlackjack(x.dealer); });
  ok(sIns !== null, 'found an ace-up dealer blackjack');
  if (sIns) {
    const x = takeInsurance(deal(sIns, 7), true);
    const p2 = settle(x);
    ok(x.insurance === 3.5 && x.phase === 'settled', 'insurance on 7 costs 3.5');
    ok(p2.delta === 0, 'insurance exactly covers the lost bet against blackjack', JSON.stringify(p2));
  }
  // even money: player natural v ace — insured result is +1 bet whatever the hole card
  const sEven = findSeed((sd) => { const x = deal(sd, 10); return x.phase === 'insurance' && isBlackjack(x.hands[0].cards); });
  ok(sEven !== null, 'found a natural against an ace');
  if (sEven) ok(settle(takeInsurance(deal(sEven, 10), true)).delta === 10, 'even money pays exactly one to one');
  // surrender gives back half
  const sSur = findSeed((sd) => { const x = deal(sd, 25); return x.phase === 'player' && canSurrender(x); });
  const sr = settle(surrender(deal(sSur, 25)));
  ok(sr.outcomes[0].verdict === 'surrender' && sr.delta === -12.5 && sr.returned === 12.5, 'surrender returns half the bet');
}

// ---- dealer peek & rules
{
  const sPeek = findSeed((sd) => { const x = deal(sd, 10); return valueOf(x.dealer[0]) === 10 && isBlackjack(x.dealer) && !isBlackjack(x.hands[0].cards); });
  const x = deal(sPeek, 10);
  ok(x.phase === 'settled' && settle(x).delta === -10, 'a ten-up dealer blackjack is peeked: the hand ends, only the bet is lost');
  const sS17 = findSeed((sd) => { let y = deal(sd, 10); if (y.phase !== 'player') return false; y = stand(y); const v = handValue(y.dealer); return v.total === 17 && v.soft; });
  const y = stand(deal(sS17, 10));
  ok(handValue(y.dealer).total === 17 && handValue(y.dealer).soft, 'the dealer stands on soft 17');
  // dealer does not draw when every player hand is busted
  const sBust = findSeed((sd) => { let z = deal(sd, 10); if (z.phase !== 'player') return false; for (let i = 0; i < 9 && z.phase === 'player'; i++) z = hit(z); return z.hands[0].busted && handValue(z.dealer).total < 17; });
  let z = deal(sBust, 10); while (z.phase === 'player') z = hit(z);
  ok(z.dealer.length === 2, 'the dealer does not draw against a busted hand');
}

// ---- splits: resplit to four, aces once and one card each, 21 after split stands
{
  const sPair = findSeed((sd) => { const x = deal(sd, 10); return x.phase === 'player' && canSplit(x) && valueOf(x.hands[0].cards[0]) !== 11; });
  let st = split(deal(sPair, 10));
  ok(st.hands.length === 2 && st.hands.every((h) => h.fromSplit && h.bet === 10), 'a split makes two hands each carrying the bet');
  ok(st.hands[0].cards.length === 2 && st.hands[1].cards.length === 1, 'the second split hand draws when it comes up');
  // resplit hunt: find a shoe that resplits to four
  const s4 = findSeed((sd) => {
    let x = deal(sd, 10); if (x.phase !== 'player' || !canSplit(x) || valueOf(x.hands[0].cards[0]) === 11) return false;
    while (x.phase === 'player' && canSplit(x)) x = split(x);
    return x.hands.length === 4;
  }, 200000);
  ok(s4 !== null, 'found a shoe that resplits to four');
  if (s4) {
    let x = deal(s4, 10); while (x.phase === 'player' && canSplit(x)) x = split(x);
    ok(x.hands.length === MAX_HANDS && (x.phase !== 'player' || !canSplit(x)), 'resplits stop at four hands');
    let guard = 0; while (x.phase === 'player' && guard++ < 40) x = stand(x);
    ok(x.phase === 'settled' && settle(x).staked === 40, 'four hands, four bets');
  }
  const sAces = findSeed((sd) => { const x = deal(sd, 10); return x.phase === 'player' && canSplit(x) && valueOf(x.hands[0].cards[0]) === 11; });
  ok(sAces !== null, 'found a pair of aces');
  if (sAces) {
    const x = split(deal(sAces, 10));
    ok(x.phase === 'settled' && x.hands.every((h) => h.cards.length === 2 && h.splitAces), 'split aces take one card each and stand');
    const p = settle(x);
    ok(p.outcomes.every((o) => o.verdict !== 'blackjack'), 'ace + ten after a split is 21, not blackjack');
  }
  // split hand making 21 stands automatically (hand one and hand two alike)
  const s21 = findSeed((sd) => { const x = deal(sd, 10); if (x.phase !== 'player' || !canSplit(x) || valueOf(x.hands[0].cards[0]) !== 10) return false; const y = split(x); return handValue(y.hands[0].cards).total === 21; });
  ok(s21 !== null, 'found a split ten that draws an ace');
  if (s21) { const y = split(deal(s21, 10)); ok(y.active === 1 || y.phase === 'settled', 'a split hand that makes 21 stands itself'); }
  if (sAces) {
    let threw = 0; const x = deal(sAces, 10);
    // split aces are done: no hit, no double, no resplit — and the hand has already settled
    ok(split(x).phase === 'settled', 'split aces leave nothing to decide');
    for (const f of [hit, doubleDown, split]) { try { f(split(x)); } catch { threw++; } }
    ok(threw === 3, 'no hitting, doubling or resplitting split aces');
  }
  // double after split
  const sDas = findSeed((sd) => { const x = deal(sd, 10); if (x.phase !== 'player' || !canSplit(x) || valueOf(x.hands[0].cards[0]) === 11) return false; return canDouble(split(x)); });
  const d = doubleDown(split(deal(sDas, 10)));
  ok(d.hands[0].doubled && d.hands[0].bet === 20 && d.hands[0].cards.length === 3, 'double after split is allowed');
  ok(!canSurrender(split(deal(sDas, 10))), 'no surrender after a split');
}

// ---- insurance lost, surrender against an ace, the hidden hole in the count, the last deal before the cut
{
  const sNo = findSeed((sd) => { const x = deal(sd, 10); return x.phase === 'insurance' && !isBlackjack(x.dealer) && !isBlackjack(x.hands[0].cards); });
  ok(sNo !== null, 'found an ace up with no dealer blackjack');
  const x = takeInsurance(deal(sNo, 10), true);
  ok(x.phase === 'player' && x.insurance === 5, 'the peek finds nothing: play goes on with insurance on the felt');
  const sx = settle(stand(x));
  ok(sx.insuranceNet === -5 && sx.staked === 15, 'insurance is lost when the dealer has no blackjack');
  ok(canSurrender(x) && settle(surrender(x)).delta === -10, 'surrender against an ace (after the peek) returns half; insurance still lost');
  const hole = deal(sNo, 10).dealer[1];
  ok(runningCount(sNo, 4, hole) === runningCount(sNo, 4) - hiLo(hole), 'the running count leaves out a hidden hole card');
  let deep = 0;
  for (let i = 0; i < 400; i++) {
    let st = deal(sha256('deep' + i), 10, CUT - 1);
    while (st.phase !== 'settled') { const la = legalActions(st); st = apply(st, st.phase === 'insurance' ? 'no-insure' : la.includes('split') ? 'split' : la.includes('hit') ? 'hit' : 'stand'); }
    if (st.cursor <= SHOE_SIZE) deep++;
  }
  ok(deep === 400, 'a hand dealt just before the cut card always finishes inside the shoe');
}

// ---- legality & cost
{
  const s = findSeed((sd) => { const x = deal(sd, 10); return x.phase === 'player' && !canSplit(x); });
  let x = deal(s, 10);
  ok(JSON.stringify(legalActions(x)) === '["hit","stand","double","surrender"]', 'two-card legal actions', legalActions(x));
  ok(costOf(x, 'double') === 10 && costOf(x, 'hit') === 0, 'a double costs one more bet');
  x = hit(x);
  if (x.phase === 'player') ok(!legalActions(x).includes('double') && !legalActions(x).includes('surrender'), 'no double or surrender after a hit');
  let threw = false; try { split(deal(s, 10)); } catch { threw = true; }
  ok(threw, 'an illegal split throws');
}

// ---- an independent referee: a second, plainly written blackjack table that
// shares nothing with the engine but the shoe. Random play (splits favoured)
// must agree on every legal-action set, every net result and every cursor.
{
  const v = (c) => { const r = c % 13; return r === 0 ? 11 : r >= 9 ? 10 : r + 1; };
  const tot = (cs) => { let t = 0, a = 0; for (const c of cs) { t += v(c); if (v(c) === 11) a++; } while (t > 21 && a) { t -= 10; a--; } return t; };
  const nat = (cs) => cs.length === 2 && tot(cs) === 21;
  function referee(shoe, cur, bet, choose) {
    let i = cur; const draw = () => shoe[i++];
    const p1 = draw(), d1 = draw(), p2 = draw(), d2 = draw();
    const dealer = [d1, d2], hands = [{ c: [p1, p2], b: bet, done: false, sa: false }];
    let ins = 0, sur = false; const dec = [], legal = [];
    if (v(d1) === 11) { const L = ['insure', 'no-insure']; legal.push(L); const a = choose(L); dec.push(a); if (a === 'insure') ins = bet / 2; }
    if (!(nat(dealer) && v(d1) >= 10) && !nat(hands[0].c)) {
      for (let h = 0; h < hands.length; h++) {
        const H = hands[h];
        if (H.c.length === 1) { H.c.push(draw()); if (H.sa || tot(H.c) === 21) H.done = true; }
        while (!H.done) {
          const L = [];
          if (!H.sa) L.push('hit');
          L.push('stand');
          if (H.c.length === 2 && !H.sa) L.push('double');
          if (H.c.length === 2 && v(H.c[0]) === v(H.c[1]) && hands.length < 4 && !H.sa) L.push('split');
          if (hands.length === 1 && H.c.length === 2) L.push('surrender');
          legal.push(L);
          const a = choose(L); dec.push(a);
          if (a === 'hit') { H.c.push(draw()); if (tot(H.c) >= 21) H.done = true; }
          else if (a === 'stand') H.done = true;
          else if (a === 'double') { H.b *= 2; H.c.push(draw()); H.done = true; }
          else if (a === 'surrender') { sur = true; H.done = true; }
          else { const aces = v(H.c[0]) === 11; hands.splice(h, 1, { c: [H.c[0]], b: H.b, done: false, sa: aces }, { c: [H.c[1]], b: H.b, done: false, sa: aces }); h--; break; }
        }
      }
    }
    if (hands.some((H) => tot(H.c) <= 21) && !sur && !nat(dealer) && !(hands.length === 1 && nat(hands[0].c))) while (tot(dealer) < 17) dealer.push(draw());
    let net = ins ? (nat(dealer) ? ins * 2 : -ins) : 0;
    const dt = tot(dealer);
    for (const H of hands) {
      const t = tot(H.c), n = hands.length === 1 && nat(H.c);
      if (sur) net -= H.b / 2; else if (t > 21) net -= H.b; else if (nat(dealer)) net += n ? 0 : -H.b;
      else if (n) net += H.b * 1.5; else if (dt > 21 || t > dt) net += H.b; else if (t < dt) net -= H.b;
    }
    return { net, dec, legal, cursor: i };
  }
  let bad = 0, splits = 0, fours = 0;
  for (let k = 0; k < 60000; k++) {
    const seed = sha256('ref' + k), cur = (k * 53) % CUT, bet = 1 + (k % 37);
    let r = (k * 2654435761) >>> 0; const R = () => ((r = (r * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const choose = (L) => (L.includes('split') && R() < 0.8 ? 'split' : L[Math.floor(R() * L.length)]);
    const ref = referee(shoeFromSeed(seed), cur, bet, choose);
    try {
      let st = deal(seed, bet, cur); const legal = [];
      for (const d of ref.dec) { legal.push(legalActions(st)); st = apply(st, d); }
      if (st.phase !== 'settled' || settle(st).delta !== ref.net || st.cursor !== ref.cursor || JSON.stringify(legal) !== JSON.stringify(ref.legal)) bad++;
      if (st.hands.length > 1) splits++; if (st.hands.length === 4) fours++;
    } catch { bad++; }
  }
  ok(bad === 0 && splits > 5000 && fours > 500, `an independent referee agrees on 60,000 random hands (${splits.toLocaleString()} split, ${fours} to four)`, bad);
}

// ---- the coach and the chart agree: on every two-card hand the book's play is
// within 0.1% of the EV-best play for those exact cards (the one known gap:
// 8,7 v 10, where hitting edges surrender by 0.04% — the coach accepts both)
{
  let bad = 0, n = 0;
  for (let i = 0; i < 20000; i++) {
    const st = deal(sha256('ev' + i), 10, 0);
    if (st.phase !== 'player') continue;
    const evs = actionEVs(st), b = bookSays(st);
    n++;
    if (Object.values(evs).some((e) => e > evs[b] + 1e-3)) bad++;
  }
  ok(bad === 0 && n > 15000, `on ${n.toLocaleString()} two-card hands the book's play is within 0.1% of the EV-best`, bad);
}

// ---- replay: seed + cursor + decisions reproduce the hand exactly (fuzzed)
{
  let bad = 0;
  for (let i = 0; i < 3000; i++) {
    const seed = sha256('rp' + i), cursor = (i * 37) % CUT;
    let st = deal(seed, 10, cursor);
    let g = 0;
    while (st.phase !== 'settled' && g++ < 60) {
      const la = legalActions(st);
      st = apply(st, la[(i * 7 + g * 13) % la.length]);
    }
    const v = verifyHand(seed, 10, st.decisions, cursor);
    if (JSON.stringify(v.state) !== JSON.stringify(st)) bad++;
    // money conservation: every staked chip is accounted for
    const p = settle(st);
    const stakedByHand = st.hands.reduce((a, h) => a + h.bet, 0) + st.insurance;
    if (p.staked !== stakedByHand || (p.returned * 2) % 1 !== 0) bad++;
  }
  ok(bad === 0, 'three thousand random hands replay exactly and settle in exact halves', bad);
}

// ---- THE BOOK: every one of 340 cells matches the canonical 6-deck S17 DAS late-surrender chart
{
  const book = basicStrategy();
  const row = (s) => s.split(' ');
  const HARD = {
    5: row('H H H H H H H H H H'), 6: row('H H H H H H H H H H'), 7: row('H H H H H H H H H H'), 8: row('H H H H H H H H H H'),
    9: row('H D D D D H H H H H'), 10: row('D D D D D D D D H H'), 11: row('D D D D D D D D D H'),
    12: row('H H S S S H H H H H'), 13: row('S S S S S H H H H H'), 14: row('S S S S S H H H H H'),
    15: row('S S S S S H H H R H'), 16: row('S S S S S H H R R R'), 17: row('S S S S S S S S S S'),
    18: row('S S S S S S S S S S'), 19: row('S S S S S S S S S S'), 20: row('S S S S S S S S S S') };
  const SOFT = {
    13: row('H H H D D H H H H H'), 14: row('H H H D D H H H H H'), 15: row('H H D D D H H H H H'), 16: row('H H D D D H H H H H'),
    17: row('H D D D D H H H H H'), 18: row('S Ds Ds Ds Ds S S H H H'), 19: row('S S S S S S S S S S'), 20: row('S S S S S S S S S S') };
  const PAIR = {
    2: row('P P P P P P - - - -'), 3: row('P P P P P P - - - -'), 4: row('- - - P P - - - - -'), 5: row('- - - - - - - - - -'),
    6: row('P P P P P - - - - -'), 7: row('P P P P P P - - - -'), 8: row('P P P P P P P P P P'), 9: row('P P P P P - P P - -'),
    10: row('- - - - - - - - - -'), 11: row('P P P P P P P P P P') };
  const ups = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const miss = [];
  let n = 0;
  for (const [name, canon, chart] of [['hard', HARD, book.hard], ['soft', SOFT, book.soft], ['pair', PAIR, book.pair]]) {
    for (const t in canon) ups.forEach((u, i) => {
      n++;
      const got = name === 'pair' ? (chart[t + 'v' + u] || '-') : chart[t + 'v' + u];
      if (got !== canon[t][i]) miss.push(`${name} ${t}v${u}: ${got} ≠ ${canon[t][i]}`);
    });
  }
  ok(n === 340 && miss.length === 0, `THE BOOK: all ${n} cells land on the canonical chart`, miss.join('; '));
  // spot checks in words, for the humans
  ok(book.hard['16v10'] === 'R' && book.hard['11vA'] === undefined && book.hard['11v11'] === 'H', 'THE BOOK: surrender 16 v 10; eleven hits an ace (six decks, S17)');
  ok(book.hard['12v4'] === 'S' && book.soft['18v2'] === 'S' && book.soft['18v3'] === 'Ds', 'THE BOOK: twelve stands on a four; soft 18 doubles 3–6 else stands');
}

// ---- the live hint: falls back correctly when doubling or surrender is gone
{
  // soft 18 of three cards against a 5: the chart says Ds, can't double → stand
  const st = rig([C.A, C[3], C[4]], [C[5], C.K]);
  ok(bookSays(st) === 'stand', 'soft 18 of three cards v 5 stands (Ds fallback)', bookSays(st));
  const st2 = rig([C[5], C[3], C[3]], [C[6], C.K]);
  ok(bookSays(st2) === 'hit', 'eleven of three cards hits (D fallback)', bookSays(st2));
  const st3 = rig([C[10], C[3], C[3]], [C[10], C[7]]);
  ok(bookSays(st3) === 'hit', 'three-card 16 v 10 hits (R fallback)', bookSays(st3));
  const st4 = rig([C[10], C[6]], [C[10], C[7]]);
  ok(bookSays(st4) === 'surrender', 'two-card 16 v 10 surrenders', bookSays(st4));
  const ins = findSeed((sd) => deal(sd, 10).phase === 'insurance');
  ok(bookSays(deal(ins, 10)) === 'no-insure', 'the book declines insurance');
  // actionEVs agree with the chart on two-card hands
  const evs = actionEVs(st4);
  ok(evs && evs.surrender === -0.5 && evs.surrender > evs.hit && evs.hit > evs.stand, 'EVs: 16 v 10 — surrender > hit > stand', JSON.stringify(evs));
  const e11 = actionEVs(rig([C[5], C[6]], [C[6], C.K]));
  ok(e11.double > e11.hit && e11.double > 0.3, 'EVs: eleven v six doubles for a fat edge', JSON.stringify(e11));
}

// ---- THE EDGE: whole shoes to the cut card under the derived book
{
  const N = 1_000_000;
  let staked = 0, returned = 0, hands = 0, initial = 0;
  for (let sh = 0; hands < N; sh++) {
    const seed = sha256('shoe' + sh); let cursor = 0;
    while (!pastCut(cursor)) {
      let st = deal(seed, 10, cursor);
      while (st.phase !== 'settled') st = apply(st, bookSays(st));
      const p = settle(st);
      staked += p.staked; returned += p.returned; initial += 10; hands++; cursor = st.cursor;
    }
  }
  const edge = (staked - returned) / initial;          // per initial bet, the usual measure
  ok(edge > 0.0005 && edge < 0.0065,
    `HOUSE RULE: the book faces ≈0.4% over ${hands.toLocaleString()} hands in whole shoes (got ${(edge * 100).toFixed(3)}%)`);
  // guesswork does worse: "never bust" (stand on 12+) donates far more
  let s2 = 0, r2 = 0, i2 = 0;
  for (let sh = 0; i2 < 100_000 * 10; sh++) {
    const seed = sha256('nb' + sh); let cursor = 0;
    while (!pastCut(cursor)) {
      let st = deal(seed, 10, cursor);
      while (st.phase !== 'settled') st = apply(st, st.phase === 'insurance' ? 'no-insure' : handValue(st.hands[st.active].cards).total >= 12 ? 'stand' : 'hit');
      const p = settle(st); s2 += p.staked; r2 += p.returned; i2 += 10; cursor = st.cursor;
    }
  }
  const edge2 = (s2 - r2) / i2;
  ok(edge2 > edge * 5, `"never bust" donates ${(edge2 * 100).toFixed(2)}% — many times the book`);
}

if (fails) { console.error(`\n${fails} FAILURE(S)`); process.exit(1); }
console.log('\nall tests pass');
