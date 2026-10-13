# Sprint 2: understanding benchmark (numbers only)

- **Truth:** `gt-v0.2.1-draft`, Noah dev project, status `draft-verified`. One agent annotated it in two independent passes and reconciled them; no human has verified it yet.
- **Model:** `kamutan-drawing/0.2.0`.
- **Evaluated:** 2026-10-13, using `kbench eval --pred-detections`.
- **Matching:** symbols by centre distance ≤ 3 mm on paper; rooms by polygon IoU ≥ 0.5; legend rows by centre ≤ 4 mm or inside the truth box.
- **Sheets:** symbols on eb8be8a3, c054fd3a, b2046277 and 1bbe4113; rooms on the same four plus 08222cb2 and 6fa88f92.
- **Artifacts:** sha256 of every artifact used is recorded in the metrics JSON, which is stored outside git.

## Ground truth size

| sheet | discipline | floors | point items | linear (cobra) | rooms |
| --- | --- | --- | --- | --- | --- |
| eb8be8a3 | electrical | ground | 22 | 4 | 2 (translated) |
| c054fd3a | electrical | basement + first | 65 | 2 | 11 (translated) |
| b2046277 | lighting | ground | 39 | 0 | 2 (translated) |
| 1bbe4113 | lighting | basement + first | 45 | 0 | 11 (translated) |
| 08222cb2 | architecture | ground | — | — | 2 |
| 6fa88f92 | architecture | basement + first | — | — | 11 |
| **total** | | | **171** | 6 | 39 polygons (13 distinct rooms) |

- **Legend truth:** 20 rows per sheet on all 4 MEP sheets.
- **Lifecycle:** 155 new and 16 existing points.
- **Text callouts:** 3 truth items are text only, with no glyph.

## Symbol detection

| view | P | R | F1 | TP | FP | FN |
| --- | --- | --- | --- | --- | --- | --- |
| semantic class (e.g. `socket_3phase`) | 0.736 | 0.766 | **0.751** | 131 | 47 | 40 |
| legend-glyph class (text callouts excluded) | 0.781 | 0.827 | **0.803** | 139 | 39 | 29 |
| electrical domain, semantic | 0.829 | 0.707 | 0.763 | 58 | 12 | 24 |
| lighting domain, semantic | 0.760 | 0.820 | 0.789 | 73 | 23 | 16 |

Per sheet, at glyph level (F1): eb8be8a3 0.766 · c054fd3a 0.862 · b2046277 0.880 · 1bbe4113 0.809.

Per class, semantic (MVP gate: F1 ≥ 0.93 for core classes):

| class | support | P | R | F1 |
| --- | --- | --- | --- | --- |
| socket_single | 23 | 0.957 | 0.957 | 0.957 |
| socket_double | 16 | 0.938 | 0.938 | 0.938 |
| socket_triple | 5 | 1.000 | 0.600 | 0.750 |
| socket_power | 7 | 0.778 | 1.000 | 0.875 |
| socket_3phase | 3 | 0.667 | 0.667 | 0.667 |
| socket_power_double | 1 | — | 0.000 | 0.000 |
| switch_single | 30 | 0.659 | 0.900 | 0.761 |
| switch_2way | 9 | 1.000 | 0.556 | 0.714 |
| luminaire_ceiling | 22 | 0.833 | 0.909 | 0.870 |
| luminaire_wall | 6 | 0.750 | 0.500 | 0.600 |
| luminaire_outdoor | 11 | 1.000 | 1.000 | 1.000 |
| luminaire_pendant | 4 | 1.000 | 0.500 | 0.667 |
| luminaire_strip | 1 | 0.000 | 0.000 | 0.000 |
| ceiling_fan | 5 | 0.833 | 1.000 | 0.909 |
| heater_feed | 3 | 0.750 | 1.000 | 0.857 |
| tv_point | 4 | 0.400 | 1.000 | 0.571 |
| data_point | 4 | — | 0.000 | 0.000 |
| phone_point | 2 | — | 0.000 | 0.000 |
| speaker | 3 | 1.000 | 0.667 | 0.800 |
| panel | 3 | — | 0.000 | 0.000 |
| socket_box_6 | 4 | — | 0.000 | 0.000 |
| doorbell / intercom / water_heater_feed / switch_fan | 2 / 1 / 1 / 1 | — | 0.000 | 0.000 |
| unknown (predicted only) | 0 | 0.000 | — | — |

### Count error per floor and class

AE is the absolute difference between the truth count and the predicted count.

| class | ground: truth / pred | basement: truth / pred | first: truth / pred |
| --- | --- | --- | --- |
| socket_single | 4 / 4 | 7 / 8 | 12 / 11 † |
| socket_double | 5 / 5 | 3 / 3 | 8 / 8 † |
| socket_triple | 2 / 1 | 2 / 1 | 1 / 1 † |
| socket_power (+3phase, power_double) | 2+3+1 / 4+3+0 | 3 / 3 | 2 / 2 † |
| tv / data / phone | 0 | 2/2/1 → 5/0/0 | 2/2/1 → 5/0/0 † |
| switches (all types, lighting sheets) | 13 / 15 | 8 / 9 | 13 / 17 † |
| luminaires incl. fans (lighting sheets) | 25 / 26 | 8 / 8 | 16 / 16 † |

† The worker labels the lower plan of c054fd3a and 1bbe4113 as `ground`, because the title block reads basement + ground. The truth floor is `first`. The predicted counts in the † column are taken from that plan, whatever floor the worker gave it.

## Confidence and review

| metric | value | target |
| --- | --- | --- |
| green items | 48 | — |
| green precision, detection-correct (matched, right class) | 81.2% (Wilson LB95 68.1%) | LB95 ≥ 98% (stage C) |
| green precision, items-correct (also lifecycle + floor) | 52.1% (LB95 38.3%) | — |
| yellow precision, detection-correct | 75.4% (n 118) | — |
| red precision, detection-correct | 0.0% (n 12) | — |
| review burden, (yellow + red) / all | 73.0% | ≤ 35% |
| yield of review | 77.2% | ≥ 90% |
| risk AUC | 0.562 | ≥ 0.85 |
| ECE / MCE / Brier | 0.307 / 0.545 / 0.334 | ECE ≤ 0.03 |
| items correct before review | 40.1% (LB95 33.4%) | ≥ 95% |
| detection roomId correct (measured, not gated) | 74.5% | — |

Items-correct error reasons (counts): floor 59, class 29, unmatched 21, lifecycle 8.

## Rooms

| metric | value |
| --- | --- |
| truth / predicted / matched | 39 / 37 / 37 (P 1.000, R 0.949) |
| mean IoU · share with IoU ≥ 0.95 | 0.904 · 40.5% |
| median area PE · within 2% | 3.6% · 6 / 37 |
| exact name · room type | 2.7% · 100% |
| worst cases | basement bedroom + salon + kitchen merged on c054fd3a and 1bbe4113 (IoU 0.55, area PE 78%) |

## Legend parsing

| metric | value |
| --- | --- |
| row recall | 100% (80 / 80) |
| entry precision | 62.5% |
| class accuracy | 70.0% |
| exact label · mean CER | 90.0% · < 1% |

- **Entry precision:** the lighting sheets' fixture-type table is reported as legend entries.
- **Class accuracy:** each sheet has 6 class misses. All of them are rows whose class did not exist in the taxonomy; the classes were added this sprint.

## Top error patterns (counts on the 4 sheets)

1. **Floor of the lower plan on two-floor sheets:** 59 floor errors. Title block versus content; see †.
2. **Comms sub-type:** every comms bracket is predicted as `tv_point`. Results: data 0/4, phone 0/2, 6 TV false positives (4 of them green).
3. **Two-way switches split in two:** a `switch_single` plus a `switch_2way` about 3 mm apart, on 5 glyphs. Also 4 two-way glyphs read as single. `switch_single` precision is 0.66.
4. **Legend rows never spotted:** the "see note" cross (0/3), the panel (0/3), and text-only detail callouts (0/3).
5. **Dense clusters with 45° labels:** sub-type text is attached to the neighbouring glyph (3 sockets in one bay), and a rotated "2X" is not read (1 double read as single, green).
6. **Luminaire type versus glyph:** wall ↔ ceiling swaps (3), track and sconce read as strip (2), strip read as ceiling (1), pendants read as ceiling or fan (2).
7. **Dense switch banks (~2 mm pitch):** one switch missed in 3 of 4 banks.
8. **Red `unknown` false positives:** 12, at cobra-conduit end circles and type-tag circles. Two speakers were detected as `unknown`, 3.5–4.8 mm off.
9. **Rooms:** names are canonicalised (abbreviations expanded, numbers dropped), and an unclosed door merges three basement rooms.
