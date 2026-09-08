# NOTICE — Teno licensing and third-party attributions

## This project

Teno is licensed under the **GNU Affero General Public License v3.0
or later (AGPL-3.0-or-later)**. See `LICENSE` for the full text.

Prior to v5.16.0 the repository carried GPL-3.0 text while shipping
code ported from AGPL-3.0 sources (see below). That was non-compliant:
GPL obligations do not cover AGPL's network clause. v5.16.0 corrects
the license to AGPL-3.0-or-later. If you received an earlier version,
the AGPL-3.0 terms apply to the ported portions regardless.

## Third-party code and concepts

### Anki — AGPL-3.0 (github.com/ankitects/anki)
Scheduling-adjacent logic in Teno was developed with strong reference
to Anki's `rslib/src/scheduler` (AGPL-3.0, © Ankitects Pty Ltd and
contributors), beyond the FSRS model core:

- `src/core/fsrs.js` — fuzz (`FUZZ_RANGES`, `fuzzDelta`,
  `fuzzBounds`, `constrainedFuzzBounds`, `withReviewFuzz`) ported from
  `rslib/src/scheduler/states/fuzz.rs`. Note: `minReviewFuzzInterval`
  branch 2 deliberately returns `prevIvl + 1` where upstream returns
  `prevIvl` (strictly-greater invariant, documented in code).
- `src/engine/session-v4.js` — intraday learning queue
  (comparator `(reps == 0, due)`, now/ahead iterators, requeue +
  collapse) conceptually ported from
  `rslib/src/scheduler/queue/learning.rs`. Implementation differs
  (Array+splice+sort vs VecDeque+binary-search; no mtime tiebreak,
  no cutoff snapshot/undo).
- `src/core/fsrs.js` `parseStepsStr`, `src/core/scheduler.js`
  (bury/suspend filtering, dayCutoff, leech threshold),
  `src/lib/store.js` (`cap_answer_time`, EasyDay, simulator defaults)
  — inspired by `states/steps.rs`, `bury_and_suspend.rs`,
  `timing.rs`, `answering/mod.rs`, load balancer, simulator.

Full mapping: `_dev/notes/ANKI-COMPARISON-report.md`.

### fsrs-rs — MIT (github.com/open-spaced-repetition/fsrs-rs)
The FSRS memory model (forgetting curve, 21 default weights,
optimizer alignment with `analytic.rs`) is ported from fsrs-rs,
© Open Spaced Repetition contributors, MIT licensed.
Attribution is also kept in the `src/core/fsrs.js` header.

### SCOWL — public domain
`src/assets/words.txt` derives from SCOWL (Spell Checker Oriented
Word Lists), public domain (see `DISCLAIMER.md`).

## Source availability

The complete corresponding source of every distributed build is the
public repository itself (main branch + release tags), which satisfies
AGPL-3.0 §6 (conveying non-source forms) and §13 (network use).
