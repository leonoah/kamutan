# Sprint 3: link groups, BOQ lines, Excel export (numbers only)

- **Truth:** `gt-v0.3-draft` (Noah dev project, `draft-verified`, one agent, two passes, no human check yet). Frozen
  before any worker link / BOQ output was read. BOQ truth is the customer BOQ (draft); disputed lines are not gated.
- **Predictions:** worker links `kamutan.links/1` on the two lighting sheets; BOQ build `local-b7` (with links).
- **Evaluated:** 2026-10-14 with `kbench eval-links`, `kbench eval-boq`, `kbench excel-check`. Input sha256 are in the
  metrics JSON (outside git).

## Link-group ground truth

| sheet | switches | luminaires | groups | single | shared | two-way | add-to-existing | sensor | unlinked | disputed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lighting, ground | 13 | 25 | 13 | 7 | 4 | 1 | 0 | 1 | 6 | 0 |
| lighting, basement + first | 21 | 24 | 18 | 10 | 3 | 2 | 3 | 0 | 3 | 1 |
| **total** | **34** | **49** | **31** | 17 | 7 | 3 | 3 | 1 | 9 | 1 |

Pass 1 vs pass 2: 1 disagreement (resolved on a 900-dpi crop) + 1 arc crossing kept as a dispute. 1 group is a
cross-sheet copy (counted once).

## Composite counts implied by the link truth vs the BOQ

| line | 4.09 | 4.10 | 4.11 | 4.12 | 4.14 | 4.15 | 4.16 | 9.01 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| implied (as drawn) | 17 | 2 | 5 | 3 | 1 | 1 | 2 | 43 |
| implied (existing point re-switched not charged) | 16 | 2 | 5 | 3 | 1 | 1 | 2 | 43 |
| BOQ | 16 | 2 | 5 | 3 | 1 | 1 | 2 | 43 |

9.01 = 49 positions − 5 ceiling fans − 1 cross-sheet duplicate.

## Link groups (gated: 30 truth groups)

| metric | value | Wilson LB95 |
| --- | --- | --- |
| group exact match, recall | 28/30 = 0.933 | 0.787 |
| group exact match, precision | 28/29 = 0.966 | 0.828 |
| switch → points accuracy | 30/32 = 0.938 | 0.799 |
| luminaire → switches accuracy | 37/39 = 0.949 | 0.831 |
| composite-kind accuracy | 29/30 = 0.967 | 0.833 |
| green-group precision | 12/12 = 1.000 | 0.757 |

Per sheet: ground 13/13 exact (12 green, 1 yellow); basement + first 15/17 exact (16 yellow, 2 red; both wrong groups red).

## BOQ lines (chapter 4 + 9.01; 29 truth lines, 22 gated, 7 disputed)

| set | lines | exact | ΣAE | median PE | P90 PE | lines AE > 0 | not proposed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gated | 22 | 11/22 = 0.500 (LB95 0.307) | 20 | 0.136 | 1.0 | 11 | 9 |
| gated, composite lighting 4.09–4.16 | 7 | 7/7 | 0 | 0 | 0 | 0 | 0 |
| gated, other | 15 | 4/15 | 20 | | | 11 | 9 |
| disputed (reported only) | 7 | 3/7 | 7 | 0.043 | 0.155 | 4 | 0 |

Extra lines: 0. Gated green lines: 0 (green-line precision not estimable). Composite exactness includes 2 lines that
are right by offsetting errors (4.09, 4.10).

## Excel fidelity (export sample vs customer sample format)

16/18 checks pass. Fails: currency number format on totals; quantities in the sample export differ from the worker
build on 6 lines (the sample export was not generated from the build).

## Top error patterns (counts)

1. Offsetting errors on composite lines: 2 lines (cross-sheet two-way group counted twice; one two-way read as a fan add).
2. Arc crossing: 2 groups wrong, both red.
3. Floor of the lower plan on the basement + first sheet still the ground floor: 18/18 groups on that sheet.
4. Switch bank at ~2 mm pitch: 1 switch lost.
5. Install line: −5 existing positions left out, −1 pendant read as a fan, +1 cross-sheet duplicate, +1 false positive.
6. Lines never proposed: 9 (text-only items, conduits, feeds, panels).
7. Comms points: −3.
