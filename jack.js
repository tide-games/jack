// jack.js — pure blackjack maths for The Jack.
//
// Fleet discipline: no DOM, no clock, no network, no crypto. Callers supply
// hex seeds; everything here is a pure function of its arguments.
//
// THE TABLE: six-deck blackjack, dealer stands on soft 17, blackjack pays
// 3:2, double on any two cards, double after split allowed, split once
// (two hands), dealer peeks on ace/ten, insurance offered against an ace,
// no surrender. One seed shuffles the whole shoe (the fleet's seeded
// Fisher–Yates); every card that follows is determined, so a finished hand
// replays bit-for-bit from its seed and its decisions.
//
// THE BOOK IS DERIVED, NOT COPIED: basicStrategy() computes the full
// hit/stand/double/split chart from first principles (dealer-outcome DP +
// player EV recursion, infinite-deck approximation) — and the tests assert
// it lands on the canonical book (16v10 hits, 11 doubles, eights split,
// twelve stands against a four). The same table drives the in-game "book"
// hint. Skill is real: the book faces ≈0.6%; guesswork donates multiples
// of that. PRACTICE ONLY for now — a public seed would let a sharp player
// read the dealer's hole card, so sealed play needs a hole-card
// commit/reveal protocol (a later voyage, noted honestly).

export const DECKS = 6;
export const BJ_PAYS = 1.5;          // 3:2, as civilization intended

// ---------------------------------------------------------------- cards
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['♠', '♥', '♦', '♣'];
// card id: 0..51 → rank r = id % 13 (0=A), suit = floor(id/13)
export const rankOf = (id) => id % 13;
export const suitOf = (id) => Math.floor(id / 13);
export const valueOf = (id) => { const r = rankOf(id); return r === 0 ? 11 : r >= 9 ? 10 : r + 1; };
export const cardName = (id) => RANKS[rankOf(id)] + SUITS[suitOf(id)];

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
  const clean = String(seedHex).replace(/[^0-9a-fA-F]/g, '').padEnd(32, '7');
  let a = parseInt(clean.slice(0, 8), 16) | 0, b = parseInt(clean.slice(8, 16), 16) | 0;
  let c = parseInt(clean.slice(16, 24), 16) | 0, d = parseInt(clean.slice(24, 32), 16) | 0;
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

// ---------------------------------------------------------------- the hand
// A pure state machine. State is serializable; every transition returns a
// NEW state. Cards leave the shoe strictly in order — the replay property.
//
// state: { seedHex, cursor, bet, dealer:[up,hole,...], hands:[{cards,bet,
//          doubled,stood,busted,fromSplit}], active, phase, insurance,
//          peeked }
// phase: 'insurance'|'player'|'dealer'|'settled'

export function deal(seedHex, bet) {
  if (!Number.isInteger(bet) || bet <= 0) throw new Error('deal: bet must be a positive integer');
  const shoe = shoeFromSeed(seedHex);
  const p1 = shoe[0], d1 = shoe[1], p2 = shoe[2], d2 = shoe[3];
  const st = {
    seedHex, cursor: 4, bet,
    dealer: [d1, d2],
    hands: [{ cards: [p1, p2], bet, doubled: false, stood: false, busted: false, fromSplit: false }],
    active: 0, insurance: 0, phase: 'player',
  };
  const upV = valueOf(d1);
  if (upV === 11) { st.phase = 'insurance'; return st; }  // offer insurance first
  if (upV === 10) return peek(st);
  return maybeAutoResolve(st);
}

// dealer peek on ten/ace: a dealer blackjack ends the hand at once
function peek(st) {
  const s = clone(st);
  if (isBlackjack(s.dealer)) { s.phase = 'dealer'; return resolveDealer(s); }
  return maybeAutoResolve(s);
}

export function takeInsurance(st, take) {
  if (st.phase !== 'insurance') throw new Error('insurance: not offered');
  const s = clone(st);
  s.insurance = take ? Math.floor(s.bet / 2) : 0;
  s.phase = 'player';           // the decision is made; the peek may end it
  return peek(s);
}

function clone(st) {
  return JSON.parse(JSON.stringify(st));
}
function drawCard(s) {
  const shoe = shoeFromSeed(s.seedHex);
  return shoe[s.cursor++];
}
function activeHand(s) { return s.hands[s.active]; }

// player blackjack (un-split) auto-stands into settlement
function maybeAutoResolve(st) {
  const s = clone(st);
  if (s.hands.length === 1 && isBlackjack(s.hands[0].cards)) {
    s.hands[0].stood = true; s.phase = 'dealer';
    return resolveDealer(s);
  }
  return s;
}

export function canDouble(st) {
  const h = activeHand(st);
  return st.phase === 'player' && h.cards.length === 2 && !h.doubled;
}
export function canSplit(st) {
  const h = activeHand(st);
  return st.phase === 'player' && st.hands.length === 1 && h.cards.length === 2
    && valueOf(h.cards[0]) === valueOf(h.cards[1]);
}

export function hit(st) {
  if (st.phase !== 'player') throw new Error('hit: not your turn');
  const s = clone(st);
  const h = activeHand(s);
  h.cards.push(drawCard(s));
  const v = handValue(h.cards);
  if (v.total > 21) { h.busted = true; h.stood = true; }
  else if (v.total === 21) h.stood = true;
  // split aces receive one card only
  if (h.fromSplit && valueOf(h.cards[0]) === 11 && h.cards.length === 2) h.stood = true;
  return advance(s);
}

export function stand(st) {
  if (st.phase !== 'player') throw new Error('stand: not your turn');
  const s = clone(st);
  activeHand(s).stood = true;
  return advance(s);
}

export function doubleDown(st) {
  if (!canDouble(st)) throw new Error('double: not allowed');
  const s = clone(st);
  const h = activeHand(s);
  h.bet *= 2; h.doubled = true;
  h.cards.push(drawCard(s));
  if (handValue(h.cards).total > 21) h.busted = true;
  h.stood = true;
  return advance(s);
}

export function split(st) {
  if (!canSplit(st)) throw new Error('split: not allowed');
  const s = clone(st);
  const [c1, c2] = s.hands[0].cards;
  const aces = valueOf(c1) === 11;
  s.hands = [
    { cards: [c1, drawCard(s)], bet: s.bet, doubled: false, stood: false, busted: false, fromSplit: true },
    { cards: [c2], bet: s.bet, doubled: false, stood: false, busted: false, fromSplit: true },
  ];
  // second hand draws when it becomes active; split aces stand immediately
  if (aces && s.hands[0].cards.length === 2) s.hands[0].stood = true;
  s.active = s.hands[0].stood ? 1 : 0;
  if (s.active === 1 && s.hands[1].cards.length === 1) {
    s.hands[1].cards.push(drawCard(s));
    if (aces) s.hands[1].stood = true;
  }
  if (s.hands.every((h) => h.stood)) { s.phase = 'dealer'; return resolveDealer(s); }
  return s;
}

function advance(s) {
  const h = activeHand(s);
  if (h.stood) {
    if (s.active < s.hands.length - 1) {
      s.active++;
      const nh = s.hands[s.active];
      if (nh.cards.length === 1) {
        nh.cards.push(drawCard(s));
        if (nh.fromSplit && valueOf(nh.cards[0]) === 11) nh.stood = true;
        if (handValue(nh.cards).total === 21) nh.stood = true;
        if (nh.stood) return advance(s);
      }
      return s;
    }
    s.phase = 'dealer';
    return resolveDealer(s);
  }
  return s;
}

function resolveDealer(s) {
  // dealer draws to 17, stands on soft 17; skips drawing if every player
  // hand is busted or the hand ended on a peeked/natural blackjack
  const allBust = s.hands.every((h) => h.busted);
  const playerBJ = s.hands.length === 1 && isBlackjack(s.hands[0].cards) && !s.hands[0].fromSplit;
  const dealerBJ = isBlackjack(s.dealer);
  if (!allBust && !dealerBJ && !playerBJ) {
    while (true) {
      const v = handValue(s.dealer);
      if (v.total >= 17) break;                       // S17: stand on ALL 17s
      s.dealer.push(drawCard(s));
    }
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
    const bj = isBlackjack(h.cards) && !h.fromSplit && st.hands.length === 1;
    let ret = 0, verdict;
    if (h.busted) verdict = 'bust';
    else if (dealerBJ && bj) { ret = h.bet; verdict = 'push'; }
    else if (dealerBJ) verdict = 'dealer blackjack';
    else if (bj) { ret = h.bet + Math.floor(h.bet * BJ_PAYS); verdict = 'blackjack'; }
    else if (dv.total > 21) { ret = h.bet * 2; verdict = 'dealer busts'; }
    else if (hv.total > dv.total) { ret = h.bet * 2; verdict = 'win'; }
    else if (hv.total === dv.total) { ret = h.bet; verdict = 'push'; }
    else verdict = 'lose';
    returned += ret;
    return { total: hv.total, verdict, bet: h.bet, ret };
  });
  return { outcomes, dealerTotal: dv.total, dealerBJ, staked, returned, delta: returned - staked };
}

export function verifyHand(seedHex, bet, decisions) {
  // decisions: array of 'insure'|'no-insure'|'hit'|'stand'|'double'|'split'
  let s = deal(seedHex, bet);
  for (const d of decisions) {
    if (s.phase === 'settled') break;
    if (d === 'insure') s = takeInsurance(s, true);
    else if (d === 'no-insure') s = takeInsurance(s, false);
    else if (d === 'hit') s = hit(s);
    else if (d === 'stand') s = stand(s);
    else if (d === 'double') s = doubleDown(s);
    else if (d === 'split') s = split(s);
    else throw new Error('verifyHand: unknown decision ' + d);
  }
  if (s.phase !== 'settled') throw new Error('verifyHand: decisions do not finish the hand');
  return { state: s, ...settle(s) };
}

// ---------------------------------------------------------------- the book
// Derived basic strategy (infinite-deck approximation): dealer-outcome DP
// then player EV recursion. Returns {hard, soft, pair} charts of
// 'H'|'S'|'D'|'P' (D falls back to H/S when doubling is unavailable —
// boards should show the fallback themselves).
export function basicStrategy() {
  // card draw distribution: ranks A..9 = 1/13 each, tens = 4/13
  const P10 = 4 / 13, P1 = 1 / 13;
  const draws = [];         // [value, prob] with ace as 11 handled in totals
  for (let v = 2; v <= 9; v++) draws.push([v, P1]);
  draws.push([10, P10]); draws.push([11, P1]);      // ace

  // dealer final-total distribution from (total, soft), S17
  const dmemo = new Map();
  function dealerDist(total, soft) {
    if (total > 21) { if (soft) return dealerDist(total - 10, false); return { bust: 1 }; }
    if (total >= 17) return { [total]: 1 };
    const key = total + (soft ? 's' : 'h');
    if (dmemo.has(key)) return dmemo.get(key);
    const out = {};
    for (const [v, p] of draws) {
      let t = total + v, sf = soft;
      if (v === 11) { if (t > 21) t -= 10; else sf = true; }
      if (t > 21 && sf) { t -= 10; sf = false; }
      const sub = t > 21 ? { bust: 1 } : dealerDist(t, sf);
      for (const k in sub) out[k] = (out[k] || 0) + p * sub[k];
    }
    dmemo.set(key, out);
    return out;
  }
  // upcard-conditioned: dealer starts with up + hole; we condition on NO
  // dealer blackjack (the peek) for up = A or 10
  function dealerFromUp(up) {
    // draw the hole card, excluding blackjack completions when peeked
    const out = {}; let mass = 0;
    for (const [v, p] of draws) {
      if (up === 11 && v === 10) continue;           // peeked away
      if (up === 10 && v === 11) continue;
      let t = up + v, soft = up === 11 || v === 11;
      if (t > 21) { t -= 10; }                        // A+A = 12 soft… handled: both aces
      const sub = dealerDist(t, soft && t <= 21);
      for (const k in sub) out[k] = (out[k] || 0) + p * sub[k];
      mass += p;
    }
    for (const k in out) out[k] /= mass;
    return out;
  }
  const dcache = {}; for (let up = 2; up <= 11; up++) dcache[up] = dealerFromUp(up);

  function evStand(total, up) {
    if (total > 21) return -1;
    const d = dcache[up]; let ev = 0;
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
      let t = total + v, sf = soft;
      if (v === 11) { if (t > 21) t -= 10; else sf = true; }
      if (t > 21 && sf) { t -= 10; sf = false; }
      if (t > 21) { ev -= p; continue; }
      ev += p * Math.max(evStand(t, up), evHit(t, sf, up));
    }
    hmemo.set(key, ev);
    return ev;
  }
  const evDouble = (total, soft, up) => {
    let ev = 0;
    for (const [v, p] of draws) {
      let t = total + v, sf = soft;
      if (v === 11) { if (t > 21) t -= 10; else sf = true; }
      if (t > 21 && sf) { t -= 10; }
      ev += p * 2 * (t > 21 ? -1 : evStand(t, up));
    }
    return ev;
  };

  const hard = {}, soft = {}, pair = {};
  for (let up = 2; up <= 11; up++) {
    for (let t = 5; t <= 20; t++) {
      const s = evStand(t, up), h = evHit(t, false, up), d = evDouble(t, false, up);
      hard[t + 'v' + up] = d > s && d > h ? 'D' : h > s ? 'H' : 'S';
    }
    for (let t = 13; t <= 20; t++) {
      const s = evStand(t, up), h = evHit(t, true, up), d = evDouble(t, true, up);
      soft[t + 'v' + up] = d > s && d > h ? 'D' : h > s ? 'H' : 'S';
    }
    for (let pc = 2; pc <= 11; pc++) {
      const t = pc === 11 ? 12 : pc * 2, isSoft = pc === 11;
      const noSplit = (() => {
        const s = evStand(t, up), h = evHit(t, isSoft, up), d = evDouble(t, isSoft, up);
        return Math.max(s, h, d);
      })();
      // split EV: two hands each starting (pc + draw); DAS allowed
      let se = 0;
      for (const [v, p] of draws) {
        let t2 = pc + v, sf = isSoft || v === 11;
        if (t2 > 21) t2 -= 10;
        if (pc === 11) { se += p * evStand(t2, up); continue; }   // split aces: one card
        const s = evStand(t2, up), h = evHit(t2, sf, up), d = evDouble(t2, sf, up);
        se += p * Math.max(s, h, d);
      }
      se *= 2;
      pair[pc + 'v' + up] = se > noSplit ? 'P' : null;
    }
  }
  return { hard, soft, pair };
}

// The book's advice for a live hand — what the hint button says.
export function bookSays(st, book) {
  if (st.phase !== 'player') return null;
  const h = st.hands[st.active];
  const up = valueOf(st.dealer[0]);
  const { total, soft } = handValue(h.cards);
  if (canSplit(st)) {
    const pc = valueOf(h.cards[0]) === 11 ? 11 : valueOf(h.cards[0]);
    if (book.pair[pc + 'v' + up] === 'P') return 'split';
  }
  const chart = soft ? book.soft : book.hard;
  let a = chart[total + 'v' + up] ?? (total >= 21 ? 'S' : 'H');
  if (a === 'D' && !canDouble(st)) a = soft ? (total >= 19 ? 'S' : 'H') : (total >= 12 ? 'S' : 'H');
  return a === 'H' ? 'hit' : a === 'S' ? 'stand' : a === 'D' ? 'double' : 'hit';
}
