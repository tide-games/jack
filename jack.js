// jack.js — pure blackjack maths for The Jack.
//
// Fleet discipline: no DOM, no clock, no network, no crypto. Callers supply
// hex seeds; everything here is a pure function of its arguments.
//
// THE TABLE: six-deck shoe dealt to a cut card at 75%, dealer stands on
// soft 17, blackjack pays 3:2, double on any two cards, double after split,
// resplit to four hands (aces split once and take one card each), late
// surrender, dealer peeks on ace/ten, insurance (even money on a natural)
// offered against an ace. One seed shuffles the whole shoe (the fleet's
// seeded Fisher–Yates) and hands are dealt from it in order, so a finished
// hand replays bit-for-bit from (seed, cursor, bet, decisions) — and a
// whole shoe replays from its seed.
//
// Money is exact: every stake is a whole number and every payout a multiple
// of one half (3:2 on an odd bet pays x.5, surrender returns half), so the
// purse is always representable exactly in a double.
//
// THE BOOK IS DERIVED, NOT COPIED: basicStrategy() computes the whole
// hit/stand/double/split/surrender chart from first principles — a
// dealer-outcome DP plus player EV recursion over a six-deck composition
// with the player's two cards and the dealer's upcard removed — and the
// tests assert it lands on the canonical 6-deck S17 DAS book cell for cell.
// actionEVs() exposes the same maths for a live hand, so the trainer can
// say not just "wrong" but "that cost you 4.1% of the bet".

export const DECKS = 6;
export const SHOE_SIZE = DECKS * 52;
export const CUT = Math.round(SHOE_SIZE * 0.75);   // reshuffle once past the cut card
export const BJ_PAYS = 1.5;                        // 3:2, as civilization intended
export const MAX_HANDS = 4;                        // resplit to four
export const MIN_BET = 5;

// ---------------------------------------------------------------- cards
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['♠', '♥', '♦', '♣'];
// card id: 0..51 → rank r = id % 13 (0=A), suit = floor(id/13)
export const rankOf = (id) => id % 13;
export const suitOf = (id) => Math.floor(id / 13);
export const valueOf = (id) => { const r = rankOf(id); return r === 0 ? 11 : r >= 9 ? 10 : r + 1; };
export const cardName = (id) => RANKS[rankOf(id)] + SUITS[suitOf(id)];
// Hi-Lo tag: 2–6 +1, 7–9 0, tens and aces −1
export const hiLo = (id) => { const v = valueOf(id); return v <= 6 ? 1 : v >= 10 ? -1 : 0; };

// hand total: {total, soft} — aces count 11 while they fit
export function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { const v = valueOf(c); total += v; if (v === 11) aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}
export const isBlackjack = (cards) => cards.length === 2 && handValue(cards).total === 21;
export const isBust = (cards) => handValue(cards).total > 21;

// ---------------------------------------------------------------- the shoe
// The fleet's seeded PRNG (xorshift128 from hex) + Fisher–Yates.
function prng(seedHex) {
  // all 256 bits of the seed count: the second half folds onto the first
  const clean = String(seedHex).replace(/[^0-9a-fA-F]/g, '').padEnd(64, '7');
  const w = (i) => parseInt(clean.slice(i * 8, i * 8 + 8), 16) | 0;
  let a = w(0) ^ w(4), b = w(1) ^ w(5), c = w(2) ^ w(6), d = w(3) ^ w(7);
  if ((a | b | c | d) === 0) a = 0x9e3779b9;       // xorshift must not start at zero
  return function next() {
    const t = b << 9; let r = b * 5; r = ((r << 7) | (r >>> 25)) * 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
    return ((r >>> 0) / 4294967296);
  };
}
const _shoeCache = new Map();  // seed -> shoe; the state machine draws often
export function shoeFromSeed(seedHex) {
  if (_shoeCache.has(seedHex)) return _shoeCache.get(seedHex);
  const shoe = [];
  for (let d = 0; d < DECKS; d++) for (let i = 0; i < 52; i++) shoe.push(i);
  const rand = prng(seedHex);
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  if (_shoeCache.size > 64) _shoeCache.clear();
  _shoeCache.set(seedHex, shoe);
  return shoe;
}
// has the cut card come out? (checked between hands, never mid-hand)
export const pastCut = (cursor) => cursor >= CUT;

// ---------------------------------------------------------------- the hand
// A pure state machine. State is serializable; every transition returns a
// NEW state. Cards leave the shoe strictly in order — the replay property.
//
// state: { seedHex, start, cursor, bet, dealer:[up,hole,...], dealerPos,
//          hands:[{cards,pos,bet,doubled,stood,busted,fromSplit,splitAces,
//          surrendered}], active, phase, insurance, decisions }
// phase: 'insurance'|'player'|'settled'

// `pos` holds each card's index in the shoe — a stable key for animation
const newHand = (cards, pos, bet, fromSplit = false, splitAces = false) =>
  ({ cards, pos, bet, doubled: false, stood: false, busted: false, fromSplit, splitAces, surrendered: false });

export const isSeed = (x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);

export function deal(seedHex, bet, cursor = 0) {
  if (!isSeed(seedHex)) throw new Error('deal: the seed must be 64 lowercase hex characters (a SHA-256)');
  if (!Number.isInteger(bet) || bet <= 0) throw new Error('deal: bet must be a positive integer');
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= CUT) throw new Error('deal: cursor out of the shoe');
  const shoe = shoeFromSeed(seedHex);
  const p1 = shoe[cursor], d1 = shoe[cursor + 1], p2 = shoe[cursor + 2], d2 = shoe[cursor + 3];
  const st = {
    seedHex, start: cursor, cursor: cursor + 4, bet,
    dealer: [d1, d2], dealerPos: [cursor + 1, cursor + 3],
    hands: [newHand([p1, p2], [cursor, cursor + 2], bet)],
    active: 0, insurance: 0, phase: 'player', decisions: [],
  };
  const upV = valueOf(d1);
  if (upV === 11) { st.phase = 'insurance'; return st; }  // offer insurance (even money) first
  if (upV === 10) return peek(st);
  return maybeAutoResolve(st);
}

// dealer peek on ten/ace: a dealer blackjack ends the hand at once
function peek(s) {
  if (isBlackjack(s.dealer)) return resolveDealer(s);
  return maybeAutoResolve(s);
}

export function takeInsurance(st, take) {
  if (st.phase !== 'insurance') throw new Error('insurance: not offered');
  const s = clone(st);
  s.decisions.push(take ? 'insure' : 'no-insure');
  s.insurance = take ? s.bet / 2 : 0;
  s.phase = 'player';           // the decision is made; the peek may end it
  return peek(s);
}

function clone(st) {
  return JSON.parse(JSON.stringify(st));
}
// draw the next card of the shoe onto a hand (or the dealer's row)
function drawTo(s, cards, pos) {
  const shoe = shoeFromSeed(s.seedHex);
  if (s.cursor >= shoe.length) throw new Error('the shoe is empty');
  pos.push(s.cursor);
  cards.push(shoe[s.cursor++]);
}
function activeHand(s) { return s.hands[s.active]; }

// player blackjack (un-split) auto-stands into settlement
function maybeAutoResolve(s) {
  if (s.hands.length === 1 && isBlackjack(s.hands[0].cards)) {
    s.hands[0].stood = true;
    return resolveDealer(s);
  }
  return s;
}

export function canHit(st) {
  return st.phase === 'player' && !activeHand(st).splitAces;
}
export function canDouble(st) {
  const h = activeHand(st);
  return st.phase === 'player' && h.cards.length === 2 && !h.doubled && !h.splitAces;
}
export function canSplit(st) {
  const h = activeHand(st);
  if (st.phase !== 'player' || st.hands.length >= MAX_HANDS || h.cards.length !== 2) return false;
  if (valueOf(h.cards[0]) !== valueOf(h.cards[1])) return false;
  return !h.splitAces;          // aces split once
}
export function canSurrender(st) {
  return st.phase === 'player' && st.hands.length === 1 && st.hands[0].cards.length === 2;
}
// every legal action right now, in button order
export function legalActions(st) {
  if (st.phase === 'insurance') return ['insure', 'no-insure'];
  if (st.phase !== 'player') return [];
  const a = [];
  if (canHit(st)) a.push('hit');
  a.push('stand');
  if (canDouble(st)) a.push('double');
  if (canSplit(st)) a.push('split');
  if (canSurrender(st)) a.push('surrender');
  return a;
}
// extra money a decision puts on the table (the UI debits the purse)
export function costOf(st, action) {
  if (action === 'double') return activeHand(st).bet;
  if (action === 'split') return activeHand(st).bet;
  if (action === 'insure') return st.bet / 2;
  return 0;
}

export function hit(st) {
  if (!canHit(st)) throw new Error('hit: not allowed');
  const s = clone(st);
  s.decisions.push('hit');
  const h = activeHand(s);
  drawTo(s, h.cards, h.pos);
  const v = handValue(h.cards);
  if (v.total > 21) { h.busted = true; h.stood = true; }
  else if (v.total === 21) h.stood = true;
  return advance(s);
}

export function stand(st) {
  if (st.phase !== 'player') throw new Error('stand: not your turn');
  const s = clone(st);
  s.decisions.push('stand');
  activeHand(s).stood = true;
  return advance(s);
}

export function doubleDown(st) {
  if (!canDouble(st)) throw new Error('double: not allowed');
  const s = clone(st);
  s.decisions.push('double');
  const h = activeHand(s);
  h.bet *= 2; h.doubled = true;
  drawTo(s, h.cards, h.pos);
  if (handValue(h.cards).total > 21) h.busted = true;
  h.stood = true;
  return advance(s);
}

export function surrender(st) {
  if (!canSurrender(st)) throw new Error('surrender: not allowed');
  const s = clone(st);
  s.decisions.push('surrender');
  const h = s.hands[0];
  h.surrendered = true; h.stood = true;
  return resolveDealer(s);
}

export function split(st) {
  if (!canSplit(st)) throw new Error('split: not allowed');
  const s = clone(st);
  s.decisions.push('split');
  const h = activeHand(s);
  const aces = valueOf(h.cards[0]) === 11;
  const a = newHand([h.cards[0]], [h.pos[0]], h.bet, true, aces);
  const b = newHand([h.cards[1]], [h.pos[1]], h.bet, true, aces);
  s.hands.splice(s.active, 1, a, b);
  return fill(s);
}

// give the active hand its second card if it only has one; split aces
// and twenty-ones stand at once and play moves on
function fill(s) {
  const h = activeHand(s);
  if (h.cards.length === 1) {
    drawTo(s, h.cards, h.pos);
    if (h.splitAces || handValue(h.cards).total === 21) h.stood = true;
  }
  return advance(s);
}

function advance(s) {
  if (!activeHand(s).stood) return s;
  if (s.active < s.hands.length - 1) { s.active++; return fill(s); }
  return resolveDealer(s);
}

function resolveDealer(s) {
  // dealer draws to 17 and stands on all 17s; skips drawing when no live
  // player hand remains or the hand ended on a natural
  const live = s.hands.some((h) => !h.busted && !h.surrendered);
  const playerBJ = s.hands.length === 1 && isBlackjack(s.hands[0].cards);
  if (live && !isBlackjack(s.dealer) && !playerBJ) {
    while (handValue(s.dealer).total < 17) drawTo(s, s.dealer, s.dealerPos);
  }
  s.phase = 'settled';
  return s;
}

// ---------------------------------------------------------------- settling
export function settle(st) {
  if (st.phase !== 'settled') throw new Error('settle: the hand is still live');
  const dealerBJ = isBlackjack(st.dealer);
  const dv = handValue(st.dealer);
  let staked = st.insurance, returned = 0;
  if (st.insurance > 0 && dealerBJ) returned += st.insurance * 3; // pays 2:1 + stake
  const outcomes = st.hands.map((h) => {
    staked += h.bet;
    const hv = handValue(h.cards);
    const bj = isBlackjack(h.cards) && st.hands.length === 1;
    let ret = 0, verdict;
    if (h.surrendered) { ret = h.bet / 2; verdict = 'surrender'; }
    else if (h.busted) verdict = 'bust';
    else if (dealerBJ && bj) { ret = h.bet; verdict = 'push'; }
    else if (dealerBJ) verdict = 'dealer blackjack';
    else if (bj) { ret = h.bet + h.bet * BJ_PAYS; verdict = 'blackjack'; }
    else if (dv.total > 21) { ret = h.bet * 2; verdict = 'dealer busts'; }
    else if (hv.total > dv.total) { ret = h.bet * 2; verdict = 'win'; }
    else if (hv.total === dv.total) { ret = h.bet; verdict = 'push'; }
    else verdict = 'lose';
    returned += ret;
    return { total: hv.total, verdict, bet: h.bet, ret, net: ret - h.bet };
  });
  return { outcomes, dealerTotal: dv.total, dealerBJ, staked, returned, delta: returned - staked,
    insuranceNet: st.insurance ? (dealerBJ ? st.insurance * 2 : -st.insurance) : 0 };
}

// apply one named decision — the one door the UI, replays and bots share
export function apply(st, d) {
  if (d === 'insure') return takeInsurance(st, true);
  if (d === 'no-insure') return takeInsurance(st, false);
  if (d === 'hit') return hit(st);
  if (d === 'stand') return stand(st);
  if (d === 'double') return doubleDown(st);
  if (d === 'split') return split(st);
  if (d === 'surrender') return surrender(st);
  throw new Error('unknown decision ' + d);
}

export function verifyHand(seedHex, bet, decisions, cursor = 0) {
  let s = deal(seedHex, bet, cursor);
  for (const d of decisions) {
    if (s.phase === 'settled') throw new Error('verifyHand: decisions run past the end of the hand');
    s = apply(s, d);
  }
  if (s.phase !== 'settled') throw new Error('verifyHand: decisions do not finish the hand');
  return { state: s, ...settle(s) };
}

// cards the player has seen leave the shoe, for the Hi-Lo running count:
// everything before `cursor`, minus the dealer's hole card while it hides
export function runningCount(seedHex, cursor, hiddenHole = null) {
  const shoe = shoeFromSeed(seedHex);
  let rc = 0;
  for (let i = 0; i < cursor; i++) rc += hiLo(shoe[i]);
  if (hiddenHole != null) rc -= hiLo(hiddenHole);
  return rc;
}
export const decksLeft = (cursor) => Math.max(0.5, (SHOE_SIZE - cursor) / 52);

// ---------------------------------------------------------------- the maths
// EV model for one starting situation. `comp` is the count of each value
// 2..11 left in the shoe (ace = 11); the model treats draws as coming from
// that fixed composition — the six-deck "removal of the first three cards"
// correction on top of an infinite-deck recursion, which is what moves a
// handful of cells (11 v A, soft 18 v 2, 12 v 4 …) onto the real 6-deck book.
function fullComp() {
  const c = {}; for (let v = 2; v <= 11; v++) c[v] = v === 10 ? 16 * DECKS : 4 * DECKS;
  return c;
}
function model(comp) {
  const n = Object.values(comp).reduce((a, b) => a + b, 0);
  const draws = [];
  for (let v = 2; v <= 11; v++) if (comp[v] > 0) draws.push([v, comp[v] / n]);

  const step = (total, soft, v) => {
    let t = total + v, sf = soft;
    if (v === 11) { if (t > 21) t -= 10; else sf = true; }
    if (t > 21 && sf) { t -= 10; sf = false; }
    return [t, sf];
  };

  const dmemo = new Map();
  function dealerDist(total, soft) {
    if (total > 21) return { bust: 1 };
    if (total >= 17) return { [total]: 1 };
    const key = total + (soft ? 's' : 'h');
    if (dmemo.has(key)) return dmemo.get(key);
    const out = {};
    for (const [v, p] of draws) {
      const [t, sf] = step(total, soft, v);
      const sub = dealerDist(t, sf);
      for (const k in sub) out[k] = (out[k] || 0) + p * sub[k];
    }
    dmemo.set(key, out);
    return out;
  }
  // the dealer's final total given the upcard, conditioned on the peek
  // (no blackjack) when the upcard is a ten or an ace
  const dcache = {};
  function dealerFromUp(up) {
    if (dcache[up]) return dcache[up];
    const out = {}; let mass = 0;
    for (const [v, p] of draws) {
      if ((up === 11 && v === 10) || (up === 10 && v === 11)) continue;
      const [t, sf] = step(up, up === 11, v);
      const sub = dealerDist(t, sf);
      for (const k in sub) out[k] = (out[k] || 0) + p * sub[k];
      mass += p;
    }
    for (const k in out) out[k] /= mass;
    return (dcache[up] = out);
  }
  function evStand(total, up) {
    if (total > 21) return -1;
    const d = dealerFromUp(up); let ev = 0;
    for (const k in d) {
      if (k === 'bust') ev += d[k];
      else { const t = Number(k); ev += t < total ? d[k] : t > total ? -d[k] : 0; }
    }
    return ev;
  }
  const hmemo = new Map();
  function evHit(total, soft, up) {
    const key = total + (soft ? 's' : 'h') + '|' + up;
    if (hmemo.has(key)) return hmemo.get(key);
    let ev = 0;
    for (const [v, p] of draws) {
      const [t, sf] = step(total, soft, v);
      if (t > 21) { ev -= p; continue; }
      ev += p * (t === 21 ? evStand(21, up) : Math.max(evStand(t, up), evHit(t, sf, up)));
    }
    hmemo.set(key, ev);
    return ev;
  }
  function evDouble(total, soft, up) {
    let ev = 0;
    for (const [v, p] of draws) {
      const [t] = step(total, soft, v);
      ev += p * 2 * (t > 21 ? -1 : evStand(t, up));
    }
    return ev;
  }
  const bestPlay = (t, sf, up, dbl) =>
    Math.max(evStand(t, up), t >= 21 ? -Infinity : evHit(t, sf, up), dbl ? evDouble(t, sf, up) : -Infinity);
  // split EV: each hand starts as the pair card plus one draw; DAS; aces
  // take one card. Resplits are approximated by the value of a fresh
  // split hand (one level), which is all the book's cells need.
  function evSplit(pc, up, handsLeft = MAX_HANDS - 1) {
    let one = 0;
    const pairP = draws.find(([v]) => v === pc)?.[1] ?? 0;
    for (const [v, p] of draws) {
      const [t, sf] = step(pc, pc === 11, v);
      if (pc === 11) { one += p * evStand(t, up); continue; }
      one += p * bestPlay(t, sf, up, true);
    }
    // resplit correction: when the drawn card pairs again and a hand is
    // free, the hand may split once more instead of playing pc+pc
    if (pc !== 11 && handsLeft > 1) {
      const [t, sf] = step(pc, false, pc);
      const played = bestPlay(t, sf, up, true);
      const again = 2 * one;
      if (again > played) one += pairP * (again - played) * 0.5;
    }
    return 2 * one;
  }
  return { evStand, evHit, evDouble, evSplit, bestPlay, dealerFromUp };
}
// composition with some cards (values) taken out
function without(values) {
  const c = fullComp();
  for (const v of values) c[v]--;
  return c;
}
const _models = new Map();
function modelFor(values) {
  const key = values.slice().sort((a, b) => a - b).join(',');
  if (!_models.has(key)) { if (_models.size > 400) _models.clear(); _models.set(key, model(without(values))); }
  return _models.get(key);
}

// EV (in units of the original bet) of every legal action for a live hand
export function actionEVs(st) {
  if (st.phase !== 'player') return null;
  const h = activeHand(st);
  const up = valueOf(st.dealer[0]);
  const vals = h.cards.slice(0, 2).map(valueOf);
  const m = modelFor([...vals, up]);
  const { total, soft } = handValue(h.cards);
  const out = {};
  out.stand = m.evStand(total, up);
  if (canHit(st)) out.hit = total >= 21 ? -1 : m.evHit(total, soft, up);
  if (canDouble(st)) out.double = m.evDouble(total, soft, up);
  if (canSplit(st)) out.split = m.evSplit(valueOf(h.cards[0]), up, MAX_HANDS - st.hands.length);
  if (canSurrender(st)) out.surrender = -0.5;
  return out;
}

// ---------------------------------------------------------------- the book
// The chart: every two-card starting hand against every upcard, each cell
// decided by the EV model above with those three cards out of the shoe.
// Cells: 'H' hit, 'S' stand, 'D' double (else hit), 'Ds' double (else
// stand), 'P' split, 'R' surrender (else hit). Hard totals use a
// representative non-pair two-card hand.
const HARD_REP = { 5: [2, 3], 6: [2, 4], 7: [2, 5], 8: [3, 5], 9: [3, 6], 10: [4, 6], 11: [5, 6],
  12: [10, 2], 13: [10, 3], 14: [10, 4], 15: [10, 5], 16: [10, 6], 17: [10, 7], 18: [10, 8],
  19: [10, 9], 20: [10, 10], 21: [10, 11] };
function cell(vals, up, allowSplit) {
  const m = modelFor([...vals, up]);
  let total = vals[0] + vals[1], soft = vals.includes(11);
  if (total > 21) total -= 10;
  const s = m.evStand(total, up), h = m.evHit(total, soft, up), d = m.evDouble(total, soft, up);
  const r = -0.5;
  if (allowSplit) {
    const sp = m.evSplit(vals[0], up);
    if (sp > Math.max(s, h, d, r)) return 'P';
  }
  if (r > Math.max(s, h, d)) return 'R';
  if (d > Math.max(s, h)) return s > h ? 'Ds' : 'D';
  return h > s ? 'H' : 'S';
}
let _book = null;
export function basicStrategy() {
  if (_book) return _book;
  const hard = {}, soft = {}, pair = {};
  for (let up = 2; up <= 11; up++) {
    for (let t = 5; t <= 20; t++) hard[t + 'v' + up] = cell(HARD_REP[t], up, false);
    for (let t = 13; t <= 20; t++) soft[t + 'v' + up] = cell([11, t - 11], up, false);
    for (let pc = 2; pc <= 11; pc++) pair[pc + 'v' + up] = cell([pc, pc], up, true) === 'P' ? 'P' : null;
  }
  return (_book = { hard, soft, pair });
}

// The book's advice for a live hand — what the hint button says.
export function bookSays(st, book = basicStrategy()) {
  if (st.phase === 'insurance') return 'no-insure';          // the book never insures
  if (st.phase !== 'player') return null;
  const h = activeHand(st);
  const up = valueOf(st.dealer[0]);
  const { total, soft } = handValue(h.cards);
  if (!canHit(st)) return 'stand';
  if (canSplit(st)) {
    if (book.pair[valueOf(h.cards[0]) + 'v' + up] === 'P') return 'split';
  }
  if (total >= 21) return 'stand';
  if (soft && total === 12) return 'hit';                    // A-A that can no longer split
  const chart = soft ? book.soft : book.hard;
  const a = chart[total + 'v' + up] ?? (total <= 8 ? 'H' : 'S');
  if (a === 'R') return canSurrender(st) ? 'surrender' : 'hit';
  if (a === 'D') return canDouble(st) ? 'double' : 'hit';
  if (a === 'Ds') return canDouble(st) ? 'double' : 'stand';
  return a === 'H' ? 'hit' : 'stand';
}
