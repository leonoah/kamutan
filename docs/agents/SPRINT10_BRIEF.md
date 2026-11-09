# Sprint 10 — Three real projects: generalize detection and the BOQ to the designer's full catalogue

Read first: AGENTS.md, docs/agents/SPRINT0_BRIEF.md (own dirs, `flock` for installs, NO git commits, NOTES.md, tests
green, mypy the CI way), SPRINT6–9 briefs, docs/sprints/sprint-8-report.md. **Git: ONE branch, `main`.** Never run
state-changing git commands. Evals need `KAMUTAN_AV_SCAN=off`. Customer files never enter git.

**Owner request (09.11):** three more complete projects from the same designer as Noah (idan mordechai), each with
drawings for every discipline AND the final priced BOQ. "Learn each set; really improve detection and quality; pay
attention to the terminology, how lines are defined in the BOQ, and to new categories."

Data (outside git): `/home/claude/kamutan-data/projects/{rubel,achituv,yahav}/` — 19 + 23 + 18 vector PDFs (A1–A3,
one page each, text layer present) + one `.xls` each (sheets: כמויות = the BOQ, חשמל = designer's AutoCAD block count
per floor, אינסטלציה = fixtures per bathroom, שינויים = change orders). Disciplines per floor: הריסה, בניה, חשמל, תאורה,
אינסטלציה, תקרה (ceilings), העמדה (furniture), בריכה (pool), אחרי טופס 4. Noah stays the regression anchor
(`/home/claude/kamutan-data/gt/noah/`, 59/61/63 lines exact/within).

## What the three BOQs teach (read all three `כמויות` sheets yourself — they are the spec)
- **Codes drift between projects** (4.10 = heater feed in one, 3-phase socket in another; duplicates 5.09/3.18/7.03;
  Excel float codes 4.23999…). Matching must be by **description**, never by code. Keep the designer's wording.
- **Units:** יחידה, קומפלט, מ"ר, מ"א, **חדר** (waterproofing per bathroom), **סט** (lighting chain), **בוטל** (cancelled
  line → qty 0, excluded), and "לא לסיכום, לספירה בסוף" lines (unit-price-only, qty 1 placeholder → not counted).
- **Chapter 04 is organised by circuit, not by symbol:**
  - sockets: שקע בודד / כפול / כח בודד / כח כפול / משולש (קופסא שש מקום) / כח משולש; "תוספת עבור אביזר מוגן מים"
    (16–28 per project: every waterproof accessory, sockets AND switches); "תוספת עבור שקע USB+TYPE C".
  - one aggregated "נק' תקשורת" line (TV/phone/data/intercom/speaker/camera/thermostat all together) + "אביזר D18".
  - feeds with/without switch: תריס חשמלי, תנור חימום, גלאי עשן (הזנה + אספקה), פעמון, ונטה, סוכך, דוד+גז, 3-phase per
    appliance (מזגן / אינדוקציה / ג'קוזי / רכב חשמלי / היתרו / סאונה / חדר מכונות בריכה), קוברה by diameter + length,
    "צינור מריכף 20 מ"מ חופשי מהריצפה", solar prep conduit, panels (ראשי / משני / תקשורת, תה"ט), מונה משני,
    "קופסת עומק למפסקים כוללת קו אפס נוסף" (= number of switch boxes) or the "הכנה לבית חכם" קומפלט variant.
  - **lighting points by switching topology:** נק' מאור בודדה כוללת מפסק / ללא מפסק (אפס קבוע) / שתי|שלוש|שש|שבע נק'
    מאור כוללות מפסק משותף / שני מפסקים מחליפים / שלושה מצלבים / טיימר בלוח / אוטומט חדר מדרגות — OR (Rubel) "נק' מאור
    בודדה" + "סט: שירשור N נק' מאור במעגל הדלקה אחד". Then separately "התקנת גוף תאורה פשוט" (fixture count), מאוורר
    תקרה, lighting profiles (מ"א, or per unit with length; recessed in gypsum vs surface). The lighting sheets carry
    circuit tags (A1, B2, D6 …) on every fixture and "A1-A4 / B1-B5" at the switch positions; timer circuits are listed
    in a note. This is countable.
- **Chapter 03 plumbing by fixture point:** כיור רחצה, כיור מטבח (פנים/חוץ), מיכל הדחה סמוי, מקלחון (2 or 3 interpuz,
  3-way/4-way, קופסת ניקוז vs תעלה), אמבטיה, מכונת כביסה, ברז גן/תמי 4, **ניקוז למזגן** (9–10 per project), מרכזיית
  מים ראשית/משנית, הזנת דוד בגג, גלגלון כיבוי אש (נק' + אספקה), בור משאבה, השקיה, בריכה, אדנית, סאונה, ביוב קומפלט.
- **02 / 05 / 06 / 07 / 08:** block walls m², closing openings (count), concrete complets; tiling by location + tile
  size + thickness (outdoor/indoor/bathroom floors/walls/parquet substrate סוג ב'), waterproofing per חדר, קופינג מ"א,
  stone cladding m²; gypsum partitions white/blue by thickness + insulation weight, ceilings m² (one BOQ says "יחידה"
  by mistake), סינר מ"א, נישה, פרופיל ניתוק STR מ"א, אופן ארט; plaster/paint complets; misc (חיזוקי עץ, אביזרי חדרי
  רחצה, PVC 4" לונטה, בור חילחול).

## Deliverables
1. **GT + baseline (Data/QA):** parse the three BOQs into `boq_truth.json` (+ `disputes.json` seeds) per project under
   `/home/claude/kamutan-data/gt/{rubel,achituv,yahav}/`, handling every quirk above (float codes, duplicates, בוטל,
   לא-לסיכום, סט/חדר units). Clean full ingest of each project (tools like Noah's `run_s6_eval.sh`; parametrise by
   project), `kbench eval-boq` per project → baseline report: present / exact / within / missing per chapter, and a
   **catalogue diff**: BOQ lines that have no rule/library item in Kamutan at all. Also extract the designer's block
   counts (sheet חשמל) and fixtures (אינסטלציה) as cross-check GT where they match the BOQ.
2. **Lighting circuits (Worker-Lighting, new `lighting/`):** read circuit tags on fixtures and at switches (letters +
   numbers, ranges "A1-A4"), pair fixtures ↔ switches, detect two-way (same circuit at two switch positions), cross
   (three), timer/שעון שבת (note or panel), אפס קבוע (no switch). Output `circuits.json.gz` per version (circuit → fixture
   ids, switch ids, kind, floor) and BOQ rule kind `lighting_circuit` producing the "נק' מאור …" lines in BOTH wordings
   (per-topology lines, or בודדה + סט שירשור N — chosen by the org's library wording), plus fixture count, ceiling fans,
   profile lengths. Noah must not regress.
3. **Catalogue generalisation (Worker-BOQ):** description-based library matching across projects (normalised Hebrew,
   synonyms, parameters like "עד 6 מטר", "50 מ"מ", "3 דרך"); new rule kinds / params for every chapter-04 and
   chapter-03 line type above (waterproof add-on = count of waterproof sockets+switches; triple = 6-box; D18; USB add-on;
   feeds by target text; 3-phase by appliance text; cobra by diameter+length; deep boxes = switch boxes; panels; plumbing
   points by fixture + interpuz count + drain type; AC drains; מרכזיה); units חדר/סט; import: בוטל → cancelled, לא-לסיכום
   → `notForTotal`, float/duplicate codes repaired, designer-wording preserved. Default library gains the generic items.
4. **Detection generalisation (Worker-Accuracy):** run detection on all three projects; fix misses/false positives
   (new symbol variants: AC drain, שקע קופץ, USB marker, waterproof marker, 3-phase variants, thermostat, camera,
   ventilator, smoke detector, bell, shutter motor, pool/garden fixtures); plumbing fixtures on אינסטלציה sheets
   (interpuz 3/4-way, rain head, hand shower, drains); ceiling/gypsum areas from תקרה + בניה sheets (ceilings m²,
   partitions by colour/thickness, סינר, STR, נישה); block-wall areas. Coordinate with Worker-Legend (Sprint 9, still in
   `legend/`, `classify/`, `ingest/`, `raster_symbols/`) — do not edit those dirs until its NOTES section says done.
5. **Calibration input (orchestrator):** with four real projects, re-evaluate the green rule (≥ 200 items at precision
   1.0 per class). Agents report per-class precision on the four projects; no calibration change without the numbers.

## Shared interfaces (additive; API agent is not in this sprint — publish requests in packages/contracts/NOTES.md,
mirror locally; the orchestrator adds contracts)
- Artifact `circuits.json.gz`; BOQ line additive: `circuit?: {id, kind: 'single'|'shared'|'two_way'|'cross'|'timer'|
  'no_switch', fixtures: number}`; library item additive: `notForTotal?: boolean`, `cancelled?: boolean`; unit enum
  gains `חדר`, `סט`.

## Ownership
| agent | owns | delivers |
| --- | --- | --- |
| Data/QA | gt (outside git), `benchmark/manifests`, eval tools under kamutan-data | item 1 (first: baseline report within the first hours, so the others know where to look) |
| Worker-Lighting | workers/drawing: new `lighting/`, `links/` | item 2 |
| Worker-BOQ | workers/drawing: `boq/`, `library_import/`, `textitems/` | item 3 |
| Worker-Accuracy | workers/drawing: `symbols/`, `fixtures/`, `geometry/`, `rooms/`, `ocr/` | item 4 |

Final report per agent: what was built, per-project before → after per line, tests, open issues, and the questions
for the owner (disputes between drawing and BOQ, like Noah's GT-D-*).
