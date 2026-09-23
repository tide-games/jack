# The Jack 🃏

**Play: https://tide-games.github.io/jack/** — twenty-one at the jackstaff.

Six-deck blackjack with a coach that knows the maths. Dealer stands on all
17s, blackjack pays 3:2, double any two and after splits, resplit to four
(aces once, one card each), late surrender, insurance and even money. The
shoe plays down to a cut card at 75%, so the cards remember.

- **The coach grades every decision in real EV, in plain words.** Stray from
  the book and it tells you what to do instead, why, and what the habit costs
  — "standing costs about 6 chips a hand like this". Every hand ends with a
  sentence on how it was decided. Book accuracy drives a rank ladder from
  Landlubber to Admiral; hints glow for your first 15 hands.
- **Drills** deal only the tough spots — stiff hands, soft hands, pairs,
  doubles, surrender — one graded decision a hand, with spaced repetition
  until every spot is mastered; **My leaks** deals the cells you miss most.
- **Count trainer**: Hi-Lo running and true count on the rail — or blind,
  with spot checks every ten hands and a quiz at every shuffle that walks
  through the true count and the bet it calls for.
- **Daily shoe**: everyone gets the same cards today — about 25 hands at a
  100-chip table. The score is the chips you gave away to mistakes (0 is
  perfect, and luck can't touch it); share it as a spoiler-free grid.
- **Every hand replays** card-for-card from its seed — press ▶ in the log.
- Stats, twenty achievements, chip betting, 4 dealing speeds, keyboard play,
  screen-reader announcements, dark mode, reduced motion, and phone layouts
  in both orientations. A hand in play survives a reload.

**The book is derived, not copied.** `basicStrategy()` computes the whole
hit/stand/double/split/surrender chart from first principles — a
dealer-outcome DP plus player EV recursion over a six-deck composition with
the three known cards removed — and [`tests.js`](tests.js) proves all **340
cells** land on the canonical 6-deck S17 DAS late-surrender chart, checks the
engine against an independent referee on 60,000 random hands, then plays
**a million hands** in whole shoes with it: the book faces ≈0.4%; "never bust"
donates 8%. `actionEVs()` exposes the same maths for the live coach.

**Money is exact**: stakes are whole, payouts are multiples of one half (3:2
on 25 pays 37.5), and the house never rounds in its own favour.

**Practice money, stated plainly**: nothing here is real money, and a public
seed would show a sharp player the hole card, so sealed stakes await a
hole-card commit/reveal protocol — a later voyage.

Pure maths in [`jack.js`](jack.js) — a serializable state machine; the table
in [`index.html`](index.html) — one file, no dependencies, no build.
`node tests.js` runs the proofs in a few seconds.

A [tide-games](https://tide-games.github.io/) boat, built in the fleet
playbook: one owner, adversarial critic passes.
