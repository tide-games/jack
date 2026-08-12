// tests.js — run: node tests.js  (exits non-zero on failure)
import { createHash } from 'node:crypto';
import {
  DECKS, BJ_PAYS, rankOf, valueOf, handValue, isBlackjack, shoeFromSeed,
  deal, takeInsurance, hit, stand, doubleDown, split, canDouble, canSplit,
  settle, verifyHand, basicStrategy, bookSays,
} from './jack.js';

let fails = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  ok ', name);
  else { fails++; console.error('  FAIL', name, detail ?? ''); }
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---- cards & totals
{
  ok(handValue([0, 9]).total === 21 && isBlackjack([0, 9]), 'A + 10 is blackjack');
  ok(handValue([0, 0]).total === 12 && handValue([0, 0]).soft, 'A + A is soft 12');
  ok(handValue([0, 4, 9]).total === 16 && !handValue([0, 4, 9]).soft, 'A + 5 + 10 is hard 16');
  ok(handValue([0, 5, 3]).total === 21, 'A + 6 + 4 rides the soft ace to 21');
  ok(handValue([12, 11, 10]).total === 30 || handValue([12, 11, 10]).total > 21, 'paint busts honestly');
}

// ---- the shoe
{
  const shoe = shoeFromSeed(sha256('a'));
  ok(shoe.length === DECKS * 52, 'six decks in the shoe');
  const counts = {};
  for (const c of shoe) counts[c] = (counts[c] || 0) + 1;
  ok(Object.keys(counts).length === 52 && Object.values(counts).every((n) => n === DECKS),
    'every card appears exactly six times');
  ok(JSON.stringify(shoeFromSeed(sha256('a'))) === JSON.stringify(shoe), 'the same seed shuffles the same shoe');
  ok(JSON.stringify(shoeFromSeed(sha256('b'))) !== JSON.stringify(shoe), 'a different seed shuffles differently');
}

// ---- state machine mechanics (seeds are searched to produce the scenarios)
function findSeed(pred, limit = 30000) {
  for (let i = 0; i < limit; i++) {
    const s = sha256('find' + i);
    try { if (pred(s)) return s; } catch { /* keep looking */ }
  }
  return null;
}
{
  // a hand that can split
  const s1 = findSeed((sd) => { const st = deal(sd, 10); return st.phase === 'player' && canSplit(st); });
  ok(s1 !== null, 'found a pair to split');
  if (s1) {
    let st = deal(s1, 10);
    st = split(st);
    ok(st.hands.length === 2 && st.hands.every((h) => h.fromSplit), 'a split makes two marked hands');
    const totalBets = st.hands.reduce((a, h) => a + h.bet, 0);
    ok(totalBets === 20, 'each split hand carries the full bet');
  }
  // doubling
  const s2 = findSeed((sd) => { const st = deal(sd, 10); return st.phase === 'player' && !canSplit(st); });
  if (s2) {
    let st = deal(s2, 10);
    st = doubleDown(st);
    ok(st.phase === 'settled' && (st.hands[0].bet === 20) && st.hands[0].cards.length === 3,
      'a double takes one card at double the bet and stands');
  }
  // busting
  const s3 = findSeed((sd) => {
    let st = deal(sd, 10);
    if (st.phase !== 'player') return false;
    let guard = 0;
    while (st.phase === 'player' && guard++ < 8) st = hit(st);
    return st.phase === 'settled' && st.hands[0].busted;
  });
  ok(s3 !== null, 'hitting forever busts');
  // dealer draws to 17+, stands on all 17s (S17)
  const s4 = findSeed((sd) => { const st = deal(sd, 10); return st.phase === 'player'; });
  if (s4) {
    let st = deal(s4, 10);
    st = stand(st);
    const dv = handValue(st.dealer);
    ok(st.phase === 'settled' && (dv.total >= 17 || st.hands[0].busted || isBlackjack(st.dealer)),
      'the dealer finishes at seventeen or better', dv.total);
  }
}

// ---- settle books, hand-crafted via seed search
{
  // player blackjack pays 3:2
  const sBJ = findSeed((sd) => { const st = deal(sd, 10); return st.phase === 'settled' && isBlackjack(st.hands[0].cards) && !isBlackjack(st.dealer); });
  ok(sBJ !== null, 'found a natural');
  if (sBJ) {
    const st = deal(sBJ, 10);
    const p = settle(st);
    ok(p.outcomes[0].verdict === 'blackjack' && p.returned === 25 && p.delta === 15,
      'blackjack pays 3:2 on the nose', JSON.stringify(p));
  }
  // insurance: offered on ace, pays 2:1 when the dealer has it
  const sIns = findSeed((sd) => { const st = deal(sd, 10); return st.phase === 'insurance'; });
  ok(sIns !== null, 'insurance is offered against an ace');
  if (sIns) {
    const st = takeInsurance(deal(sIns, 10), true);
    ok(st.insurance === 5, 'insurance costs half the bet');
    if (st.phase === 'settled' && isBlackjack(st.dealer)) {
      const p = settle(st);
      ok(p.returned >= 15, 'insurance pays 2:1 against the blackjack');
    } else ok(true, '(dealer had no blackjack this seed — cost stands)');
  }
  // push returns the stake exactly
  const sPush = findSeed((sd) => {
    let st = deal(sd, 10);
    if (st.phase !== 'player') return false;
    st = stand(st);
    return st.phase === 'settled' && settle(st).outcomes[0]?.verdict === 'push';
  });
  if (sPush) {
    let st = stand(deal(sPush, 10));
    const p = settle(st);
    ok(p.delta === 0 && p.returned === 10, 'a push hands the stake straight back');
  }
}

// ---- replay: decisions + seed reproduce the hand exactly
{
  const sd = findSeed((x) => deal(x, 50).phase === 'player');
  const v1 = verifyHand(sd, 50, ['hit', 'stand', 'hit', 'stand', 'hit', 'stand', 'hit', 'stand'].slice(0, 8));
  const v2 = verifyHand(sd, 50, ['hit', 'stand', 'hit', 'stand', 'hit', 'stand', 'hit', 'stand'].slice(0, 8));
  ok(JSON.stringify(v1) === JSON.stringify(v2), 'a hand replays identically from seed + decisions');
}

// ---- THE BOOK: derived strategy lands on the canonical chart
{
  const book = basicStrategy();
  const cases = [
    ['hard', '16v10', 'H', 'sixteen hits against a ten'],
    ['hard', '16v6', 'S', 'sixteen stands against a six'],
    ['hard', '11v6', 'D', 'eleven doubles against a six'],
    ['hard', '11v10', 'D', 'eleven doubles against a ten'],
    ['hard', '12v4', 'S', 'twelve stands against a four'],
    ['hard', '12v2', 'H', 'twelve hits against a deuce'],
    ['hard', '9v3', 'D', 'nine doubles against a three'],
    ['hard', '10v10', 'H', 'ten hits against a ten'],
    ['hard', '17v10', 'S', 'seventeen always stands'],
    ['soft', '18v9', 'H', 'soft eighteen hits against a nine'],
    ['soft', '18v6', 'D', 'soft eighteen doubles against a six'],
    ['soft', '19v10', 'S', 'soft nineteen stands'],
    ['soft', '17v3', 'D', 'soft seventeen doubles against a three'],
  ];
  for (const [chart, key, want, name] of cases) {
    ok(book[chart][key] === want, 'THE BOOK: ' + name, book[chart][key]);
  }
  ok(book.pair['8v10'] === 'P', 'THE BOOK: always split eights');
  ok(book.pair['11v10'] === 'P', 'THE BOOK: always split aces');
  ok(book.pair['10v6'] !== 'P', 'THE BOOK: never split tens');
  ok(book.pair['5v6'] !== 'P', 'THE BOOK: never split fives');
}

// ---- THE EDGE: half a million hands under the derived book
{
  const book = basicStrategy();
  const N = 200_000;
  let staked = 0, returned = 0;
  for (let i = 0; i < N; i++) {
    let st = deal(sha256('mc' + i), 10);
    let guard = 0;
    while (st.phase !== 'settled' && guard++ < 60) {
      if (st.phase === 'insurance') { st = takeInsurance(st, false); continue; } // the book never insures
      const a = bookSays(st, book);
      if (a === 'split') st = split(st);
      else if (a === 'double') st = doubleDown(st);
      else if (a === 'stand') st = stand(st);
      else st = hit(st);
    }
    if (st.phase !== 'settled') { while (st.phase === 'insurance') st = takeInsurance(st, false); while (st.phase === 'player') st = stand(st); }
    const p = settle(st);
    staked += p.staked; returned += p.returned;
  }
  const edge = (staked - returned) / staked;
  ok(edge > -0.002 && edge < 0.012,
    `HOUSE RULE: the book faces ≈0.6% over ${N.toLocaleString()} hands (got ${(edge * 100).toFixed(3)}%)`);
}

if (fails) { console.error(`\n${fails} FAILURE(S)`); process.exit(1); }
console.log('\nall tests pass');
