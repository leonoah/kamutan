# Sprint 4 — benchmark summary (numbers only)

GT `gt-v0.4.1-draft` (frozen before reading worker output). Worker artifacts: local dev run, build id in eval JSON.

## Plumbing fixtures + AC (centre distance 3 mm)

| class | support | TP | FP | FN | P | R | F1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ac_unit | 18 | 14 | 2 | 4 | 0.875 | 0.778 | 0.824 |
| faucet_wall | 3 | 3 | 0 | 0 | 1.000 | 1.000 | 1.000 |
| fixture_basin | 9 | 9 | 1 | 0 | 0.900 | 1.000 | 0.947 |
| fixture_bath | 2 | 2 | 0 | 0 | 1.000 | 1.000 | 1.000 |
| fixture_kitchen_sink | 4 | 3 | 0 | 1 | 1.000 | 0.750 | 0.857 |
| fixture_shower | 4 | 0 | 2 | 4 | 0.000 | 0.000 | 0.000 |
| fixture_washing_machine | 2 | 2 | 0 | 0 | 1.000 | 1.000 | 1.000 |
| fixture_wc_concealed | 6 | 6 | 1 | 0 | 0.857 | 1.000 | 0.923 |
| fixture_wc_monoblock | 2 | 1 | 0 | 1 | 1.000 | 0.500 | 0.667 |
| garden_tap | 2 | 2 | 0 | 0 | 1.000 | 1.000 | 1.000 |
| **micro** | 52 | 42 | 6 | 10 | 0.875 | 0.808 | 0.840 |

Green detection-correct 11/11; review burden 0.771; items correct before review 0.491 (errors {'class': 1, 'floor': 10, 'lifecycle': 11, 'unmatched': 5})

At 8 mm: micro P 0.896 R 0.827 F1 0.860

## Rooms for tiling

- matched 26/28 truth rooms; predicted rooms with a type 0; type accuracy 0.000 (name fallback 1.000); wet P - R 0.000 F1 0.000 (TP 0 FP 0 FN 8)
- wet rooms matched 8; area median PE 0.108; perimeter median PE 0.087; corners exact 0 (ΣAE 0)
- openings recall 0.000 precision -; width within 5 cm -

| sheet | truth room | IoU | type t/p | wet t/p | area PE | perim PE | corners t/p | openings t/p/m |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 08222cb2 | ground-wc | 0.94 | wc / None | 1/0 | 0.057 | 0.031 | 2/None | 2/0/0 |
| 08222cb2 | ground-open | 0.93 | corridor/kitchen/living/stairs / None | 0/0 | - | - | -/- | -/-/- |
| 1470f005 | ground-wc | 0.94 | wc / None | 1/0 | 0.057 | 0.029 | 2/None | 2/0/0 |
| 1470f005 | ground-open | 0.93 | corridor/kitchen/living/stairs / None | 0/0 | - | - | -/- | -/-/- |
| 6fa88f92 | basement-bath | 0.80 | bathroom / None | 1/0 | 0.198 | 0.189 | 3/None | 1/0/0 |
| 6fa88f92 | first-bath | 0.86 | bathroom / None | 1/0 | 0.143 | 0.144 | 3/None | 2/0/0 |
| 6fa88f92 | first-master-bath | 0.93 | bathroom / None | 1/0 | 0.074 | 0.023 | 1/None | 2/0/0 |
| 6fa88f92 | basement-bedroom | 0.79 | bedroom/stairs / None | 0/0 | - | - | -/- | -/-/- |
| 6fa88f92 | basement-open | 0.89 | kitchen/living / None | 0/0 | - | - | -/- | -/-/- |
| 6fa88f92 | first-bed2 | 0.98 | bedroom / None | 0/0 | - | - | -/- | -/-/- |
| 6fa88f92 | first-bed1 | 0.95 | bedroom / None | 0/0 | - | - | -/- | -/-/- |
| 6fa88f92 | first-master | 0.98 | bedroom / None | 0/0 | - | - | -/- | -/-/- |
| 6fa88f92 | first-closet | 0.96 | storage / None | 0/0 | - | - | -/- | -/-/- |
| 6fa88f92 | first-open | 0.97 | corridor/living/stairs / None | 0/0 | - | - | -/- | -/-/- |
| 6fa88f92 | first-bed3 | 0.98 | bedroom / None | 0/0 | - | - | -/- | -/-/- |
| 8099ab2c | first-bath | 0.86 | bathroom / None | 1/0 | 0.143 | 0.145 | 3/None | 2/0/0 |
| 8099ab2c | first-master-bath | 0.90 | bathroom / None | 1/0 | 0.039 | 0.016 | 1/None | 2/0/0 |
| 8099ab2c | first-bed2 | 0.98 | bedroom / None | 0/0 | - | - | -/- | -/-/- |
| 8099ab2c | first-bed1 | 0.95 | bedroom / None | 0/0 | - | - | -/- | -/-/- |
| 8099ab2c | first-master | 0.97 | bedroom / None | 0/0 | - | - | -/- | -/-/- |
| 8099ab2c | first-closet | 0.96 | storage / None | 0/0 | - | - | -/- | -/-/- |
| 8099ab2c | first-open | 0.97 | corridor/living/stairs / None | 0/0 | - | - | -/- | -/-/- |
| 8099ab2c | first-bed3 | 0.98 | bedroom / None | 0/0 | - | - | -/- | -/-/- |
| ad257a1c | basement-bath | 0.80 | bathroom / None | 1/0 | 0.195 | 0.188 | 3/None | 1/0/0 |
| ad257a1c | basement-bedroom | 0.79 | bedroom/stairs / None | 0/0 | - | - | -/- | -/-/- |
| ad257a1c | basement-open | 0.85 | kitchen/living / None | 0/0 | - | - | -/- | -/-/- |

Unmatched truth rooms: 6fa88f92:basement-english-yard, ad257a1c:basement-english-yard

## BOQ chapters 03 + 05

| set | lines | exact | within tol | ΣAE | median PE | not proposed |
| --- | --- | --- | --- | --- | --- | --- |
| gated | 19 | 15/19 | 15/19 | 27.56 | 0.000 | 5.08 |
| disputed | 4 | 4/4 | 4/4 | 0.00 | 0.000 | - |

Green-line precision 5/5; ΣAE by chapter {"3": 5.0, "5": 22.56}

| code | BOQ | pred | AE | PE | exact / within tol | GT-rule expected | level | dispute |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3.01 | 9 | 14 | 5 | 0.556 | no | - | yellow |  |
| 3.02 | 3 | 3 | 0 | 0.000 | exact | - | yellow | GT-D-004 |
| 3.03 | 4 | 4 | 0 | 0.000 | exact | - | yellow | GT-D-004 |
| 3.04 | 3 | 3 | 0 | 0.000 | exact | - | yellow | GT-D-003 |
| 3.05 | 2 | 2 | 0 | 0.000 | exact | - | yellow |  |
| 3.06 | 2 | 2 | 0 | 0.000 | exact | - | yellow |  |
| 3.07 | 1 | 1 | 0 | 0.000 | exact | - | green | GT-D-003 |
| 3.08 | 1 | 1 | 0 | 0.000 | exact | - | yellow |  |
| 3.09 | 1 | 1 | 0 | 0.000 | exact | - | yellow |  |
| 3.10 | 1 | 1 | 0 | 0.000 | exact | - | yellow |  |
| 3.11 | 1 | 1 | 0 | 0.000 | exact | - | green |  |
| 3.12 | 1 | 1 | 0 | 0.000 | exact | - | green |  |
| 3.13 | 1 | 1 | 0 | 0.000 | exact | - | yellow |  |
| 3.14 | 1 | 1 | 0 | 0.000 | exact | - | yellow |  |
| 3.15 | 1 | 1 | 0 | 0.000 | exact | - | yellow |  |
| 5.01 | 57 | 62.956 | 5.956 | 0.104 | no | 57.63 | yellow |  |
| 5.02 | 18.1 | 18.1 | 0 | 0.000 | exact | 18.11 | yellow |  |
| 5.03 | 15.6 | 0 | 15.6 | 1.000 | no | 17 | yellow |  |
| 5.04 | 11 | 11 | 0 | 0.000 | exact | - | green |  |
| 5.05 | 3 | 3 | 0 | 0.000 | exact | 3 | yellow |  |
| 5.06 | 2 | 2 | 0 | 0.000 | exact | - | green |  |
| 5.07 | 1.2 | 1.2 | 0 | 0.000 | exact | - | green |  |
| 5.08 | 1 | 0 | 1 | 1.000 | no | - | None |  |

## BOQ chapter 04 + 9.01 (regression)

| set | lines | exact | within tol | ΣAE | median PE | not proposed |
| --- | --- | --- | --- | --- | --- | --- |
| gated | 22 | 12/22 | 12/22 | 19.00 | 0.000 | 4.06, 4.08, 4.19, 4.20, 4.25, 4.26, 4.27, 4.28 |
| disputed | 7 | 4/7 | 4/7 | 3.00 | 0.000 | - |

Green-line precision 0/0; ΣAE by chapter {"4": 19.0}

## Tiling calibration (GT geometry vs sample BOQ)

Recommended rule -> {"5.01": 57.63, "5.02": 18.11, "5.03": 17.0, "5.05": 3}; PE vs sample {"5.01": 1.11, "5.02": 0.06, "5.03": 8.97, "5.05": 0.0}

| floor candidate | m² | PE |
| --- | --- | --- |
| F1 | 18.109 | +0.05% |
| F2 | 17.749 | -1.94% |
| F3 | 19.12 | +5.64% |
| F4 | 16.776 | -7.31% |
| F5 | 18.851 | +4.15% |
| F6 | 17.48 | -3.43% |

| h (m) | niche walls clad | 5.01 | PE | 5.03 | PE |
| --- | --- | --- | --- | --- | --- |
| 2.0 | True | 55.43 | -2.8% | 14.0 | -10.3% |
| 2.05 | True | 56.77 | -0.4% | 14.35 | -8.0% |
| 2.1 | True | 58.11 | +1.9% | 14.7 | -5.8% |
| 2.2 | True | 61.2 | +7.4% | 15.4 | -1.3% |
| 2.4 | True | 65.29 | +14.5% | 16.2 | +3.9% |
| 2.5 | True | 67.33 | +18.1% | 16.6 | +6.4% |
| 2.6 | True | 69.38 | +21.7% | 17.0 | +9.0% |
| 2.0 | False | 45.59 | -20.0% | 14.0 | -10.3% |
| 2.05 | False | 46.68 | -18.1% | 14.35 | -8.0% |
| 2.1 | False | 47.77 | -16.2% | 14.7 | -5.8% |
| 2.2 | False | 50.37 | -11.6% | 15.4 | -1.3% |
| 2.4 | False | 54.0 | -5.3% | 16.2 | +3.9% |
| 2.5 | False | 55.82 | -2.1% | 16.6 | +6.4% |
| 2.6 | False | 57.63 | +1.1% | 17.0 | +9.0% |
