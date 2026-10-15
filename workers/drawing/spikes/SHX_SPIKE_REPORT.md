# SHX glyph-dictionary OCR — Sprint 0 spike report

Sample project: 15 A3 sheets (AutoCAD 2017 → PDF, no text layer; all Hebrew text is SHX stroke polylines).
Code: `kamutan_drawing.ocr.glyphs`, `kamutan_drawing.ocr.dictionary`; runner `spikes/shx_spike.py`.
Numbers below are from the final run (`spikes/results/*.json`).

## TL;DR

| method (same oracle line boxes for all) | electrical legend | lighting table | title blocks (15) | all |
| --- | --- | --- | --- | --- |
| (a) Tesseract 5 `heb`, PDF raster crop 300 dpi, psm 7/6 | 81.2 % | 80.2 % | 89.4 % | 85.9 % |
| (a') same at 400 dpi | 87.1 % | 76.6 % | 80.8 % | 80.2 % |
| (a'') Tesseract on clean vector re-render of the glyph strokes | 90.8 % | 82.9 % | 82.6 % | 83.5 % |
| **(b) glyph dictionary** (cluster → vote-label once → read) | **95.9 %** | **96.5 %** | **100 %** | **98.6 %** |

Character accuracy = 1 − CER (Levenshtein, NFC, geresh/gershayim/Ø normalised, spaces collapsed). Ground truth:
369 strings / 2,681 characters (26 electrical-legend cells, 116 lighting-table cells, 227 title-block strings).
Exact-string match: (b) 351/369, (a) 196/369. Ignoring spaces: (b) 98.6 %, (a) 85.3 %.

**Target ≥95 % on the legend: met on both legends (95.9 % / 96.5 %) — with the caveats in §5** (tuned on this same
data; blind spot-check on 29 other random spans: **95.6 %**, 24/29 exact).

**Recommendation: GO** for the glyph dictionary as the primary SHX reader, **plus** a small VLM labelling batch for the
clusters the local OCR cannot name (Latin in tiny fonts, `Ø`, symbols) — not a VLM fallback per page. DWG/DXF is
not needed to read these sheets, but when a DXF is available it makes this whole stage unnecessary (real `TEXT`).

## 1. Method

1. **Vector ingest** (pypdfium2): 126,422 path objects / 317,601 segments on 15 sheets, 17.7 s total. AutoCAD exports
   every SHX stroke as its own path (lines + 2-bezier arcs), consecutive in the stream, black, width 0.085–0.254 mm.
2. **Strokes → components**: paths with extent < 8 mm, stroked, unfilled; union of strokes that touch (≤0.06 mm, densified
   so T-junctions count) **within the same style** (colour+width) — this alone separates text from most drawing.
   Underlines/overlines touching letters are detected (long flat stroke spanning a wide component) and removed.
3. **Lines**: phase 1 links letter-sized components with vertical overlap ≥50 % and gap ≤1.3 H; phase 2 attaches small
   marks (׳ ״ : . , = -) to exactly **one** line (the one whose band contains them). Passes: horizontal, then ±90°
   (tighter gap 0.6 H so table number columns are not read as vertical text), then letter-sized singletons.
4. **Glyphs**: components of one line that overlap in x (ה/ק legs, `:`, `=`) or almost touch (<0.05 H: מ, ע in the
   title font) are merged.
5. **Signature**: stroke vertices (bezier interiors dropped), relative to (glyph left, **line baseline**), divided by line
   height, quantised to 1/8 H, direction-canonical, sorted → exact key. Baseline-relative (not bbox-relative) keeps
   ו/ן, '/י, ך/ד apart. A 24×16 blurred bitmap is kept for nearest-neighbour fallback.
6. **Dictionary**: clusters = exact keys (tolerant merging was tried — cosine 0.15 merged ה/ח/ק, ב/כ/נ, ת/מ; vote purity
   fell; so **exact keys only**).
7. **Labelling once per cluster** — by *voting*, not by a single crop: every text line is re-rendered from its vectors
   (clean, no hatching/table rules), 30 lines per Tesseract call (`makebox` gives char boxes), boxes are assigned to
   glyphs by Hungarian matching on x-IoU, each glyph votes for its cluster. Two passes: `heb` and `eng`. 4,849 lines →
   ~43 s per pass on 2 vCPU. Then geometric vetoes that OCR cannot know:
   - one-piece letter-height glyph ≠ `. : , ' " -` (votes bleeding from an adjacent colon made ך read as `.`);
   - short glyph (<0.45 H) ≠ digit/Latin;
   - median descent below baseline decides final forms (ך/ד, ן/ו, ף/פ, ץ/צ);
   - one tick = ׳, two ticks = ״;
   - Hebrew winners are never replaced by Latin at cluster level (SHX ז ≡ Latin T, ס ≈ O); the Latin reading is kept as
     `alt` and used only next to a confident Latin neighbour or before `=` (`H=120`).
   Unlabelled clusters borrow the nearest labelled cluster within cosine 0.12 (96 clusters).
8. **Reading**: labels in visual order, word break at gap > 0.55 H (1.0 H between digits/`.:/`), minimal bidi
   (Hebrew RTL, digit/Latin runs LTR, joiners attach to the LTR run only when not preceded by Hebrew).
9. **Orientation**: both normal and mirrored renders were OCR-ed; mirrored text produced garbage on every line tested
   (e.g. "שם הפרויקט:" → "ס%יז זטוז חע"). Text is **not** mirrored in the PDFs; the odd look in the 150 dpi PNGs is just
   the angular SHX font. 161 lines are rotated ±90° (dimension strings, vertical labels).

## 2. Glyph dictionary numbers

| | value |
| --- | --- |
| text lines / glyph instances | 4,849 / 15,758 (161 lines rotated) |
| unique shapes (exact keys) | **1,710** (792 seen ≥2×, 354 seen ≥5×, 918 singletons) |
| clusters labelled Hebrew letter | 600 clusters → 9,328 instances, all 27 letter forms present |
| digit / Latin clusters | 511 / 203 |
| unique shapes per sheet | 130 – 577; cumulative over sheets 257 → 1,710 (no saturation) |
| instances in clusters with label conf ≥ 0.8 | 88.8 % |
| low-confidence clusters (count ≥2, conf <0.6) | **139** → one VLM batch call of ~4 × 40 thumbnails |

Why 1,710 and not the 150–400 the architecture doc expected: (1) several text styles — heights 0.9–5 mm, two width
factors, three pen widths — each letter therefore has ~17 shapes (median), and quantisation at 1/8 H splits some more;
(2) non-text strokes of the same style (hatch dashes, stair numbers' ticks, symbol fragments) also become "glyphs".
This does not hurt accuracy — the votes still converge — but it means **the dictionary is per font *style*, not per font**.
Next step: normalise by measured cap height *and* width factor (key per style), which should collapse to a few hundred.

## 3. Accuracy detail and failure examples (glyph dictionary)

38 character errors remain on 2,681 (18 strings). By cause:

| cause | strings | example (truth → read) |
| --- | --- | --- |
| `Ø` diameter sign never produced by Tesseract | 6 | `Ø20` → `O20`, `Ø6` → `66` |
| Latin in the 0.042 mm micro-font (Hebrew-looking shapes) | 4 | `UP DOWN` → `אוסם סט`, `E1405` → `1405ס`, `W50` → `050` |
| Latin in legend cells | 3 | `TV` → `אז`, `BEZEK` → `BEZE)`, `2X` → `2x` |
| heading glued to the legend symbol under it | 1 | `מקרא:` → `ת` |
| `/` between Hebrew words lost | 1 | `לוח חשמל/לוח תקשורת` → `…חשמללוח…` |
| single letters | 2 | `מאוורר` → `מווורר`, `חיצוני/שקוע` → `…/קוע` |
| `H` of `H=130` (glyph never linked) | 1 | `…תחתון H=130` → `…תחתון 130=` |

Direct Tesseract (a) fails differently: it reads the *same* letters wrongly on every occurrence where the crop contains
table rules or hatching ("לוח חשנג /לוח תקשורתת", "אבה תחתה 120=ה ."), drops digits ("Ø15" → "5", "E1405" → "5"), and is
**worse at 400 dpi than at 300 dpi** on this font (the thin angular strokes split into fragments). The clean vector
re-render (a'') helps legends but not title blocks — the dictionary's gain comes from **voting across all occurrences**
plus the geometric constraints, not from the cleaner image.

## 4. Title block, discipline, floor, scale

Title-block text: **227/227 strings exact** (all 15 sheets, project name, sheet name, `1:50`, `22.12.16`, status labels).
Classification (`spikes/SHEET_CLASSIFICATION.md`): discipline correct on **15/15**, floor equals the title-block wording on
15/15, scale 1:50 on 15/15. The independent dimension-string check confirms 1:50 on 10 sheets (others: too few
dimension pairs), no conflicts. **Disagreement with the data agent's manifest** on floors for the three portrait
sheets (1bbe4113 lighting, c054fd3a electrical, 6fa88f92 master): title block says *קומת מרתף+ / קומת קרקע*, manifest
says basement + **first**. Content (bedrooms in the lower plan) supports the manifest — needs an owner decision; the UI
must allow per-region floor confirmation (decision #10).

## 5. Caveats — read before trusting the numbers

- **Dev-set tuning.** Every rule in §1.7 was added after looking at errors on this same ground truth. The rules are generic
  (geometry, script context), but expect lower numbers on a new office/font. Mitigation in this spike: a **blind
  spot-check after tuning** — 30 random spans outside the GT regions (`ground_truth/holdout_check.json`): 1 was hatching
  wrongly detected as text; the other 29 scored **95.6 %** (24 exact; errors: `פנלים`→`פה` + stray `- 1` from a
  dimension, `נק' קיימת`→`ל' היימת`, `יועץ`→`יועy`, stray `|`).
- **Oracle localisation.** All methods were scored inside the same hand-set (legends) / detected (title blocks) boxes. That
  favours (a): a real Tesseract pipeline must also find the lines in a cluttered sheet, which (b) gets for free from
  the vectors.
- **Title-block GT boxes come from detected spans** (text was read by eye from 150–500 dpi renders, then matched to the
  nearest detected span). A string the detector missed would be absent from GT; the generator reports none missing
  (the one "missing" string does not exist on that sheet).
- Single project, single office template. Electrical and lighting *legends* on this set are the same table (copied).
- The ground truth contains one drawing typo kept verbatim (`גוף מוגם מים משולש`).

## 6. Recommendation

1. **GO** with the vector glyph dictionary as the SHX reader (deterministic, ~1 min OCR per 15-sheet set on 2 vCPU,
   no per-page VLM cost). Persist it per org **and per text style**.
2. Add the **VLM labelling batch** for low-confidence clusters (139 here; thumbnails, no PII) and a fixed rule for `Ø`.
   Cache labels by key hash (`glyph_dictionary`), so the cost is paid once per office font.
3. Keep raster Tesseract only for raster uploads; it is not competitive on SHX vectors (≤ 87 %).
4. Don't block on DWG: these PDFs are readable. Offer DXF upload as the "green path" (real text + blocks, tested with
   ezdxf); DWG via LibreDWG CLI later (not available in this sandbox).
5. Next engineering steps: style-aware keys, legend-symbol vs heading separation (one remaining failure), integrate the
   dictionary into `process_sheet_version` per *sheet set* instead of per sheet.

## Reproduce

```bash
cd workers/drawing
KAMUTAN_DATA_DIR=/home/claude/kamutan-data uv run python spikes/shx_spike.py extract label eval
uv run python spikes/classify_sheets.py
```
`ground_truth/make_gt_legends.py` writes the legend GT; `make_gt_titleblocks.py` regenerates title-block boxes
(the committed `shx_gt.json` is the frozen version used above).
