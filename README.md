# The Jack 🃏

**Play: https://tide-games.github.io/jack/** — twenty-one at the jackstaff.

Six-deck blackjack, dealer stands on all 17s, blackjack pays 3:2, double on
any two, double after split, split once, peek and insurance. One seed
shuffles the shoe (the fleet's seeded Fisher–Yates), so **every finished
hand replays bit-for-bit** from its seed and its decisions.

**The book is derived, not copied.** `basicStrategy()` computes the whole
hit/stand/double/split chart from first principles — a dealer-outcome DP
plus player EV recursion — and [`tests.js`](tests.js) proves the derivation
lands on the canonical book (sixteen hits a ten, eleven doubles, eights
split, twelve stands on a four…), then plays **200,000 hands** with it:
the book faces ≈0.6%; guesswork donates multiples. The same table drives
the in-game 📖 hint, and the log tags every hand *book* or *freestyle*.

**Practice money, stated plainly**: a public seed would show a sharp player
the dealer's hole card, so sealed stakes await a hole-card commit/reveal
protocol — a later voyage.

Pure maths in [`jack.js`](jack.js) — a serializable state machine (deal,
insurance, hit, stand, double, split, peek, S17 resolution, exact 3:2 and
2:1 books). A [tide-games](https://tide-games.github.io/) boat, built in
the fleet playbook: one owner, five critic passes.
