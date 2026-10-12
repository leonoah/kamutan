"""Title-block ground truth.

Text: read by eye from 150-300 dpi renders of each sheet's title block (montage).
Bounding boxes: taken from the detected text spans that best match each expected
string (printed for manual checking); strings with no plausible span are
reported and kept with a manual bbox when given in MANUAL_BBOX.
Run after `shx_spike.py extract label`.
"""

import json
import pickle
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import shx_spike as S

from kamutan_drawing.ocr.dictionary import text_spans
from kamutan_drawing.titleblock.classify import fuzzy_ratio

COMMON = [
    "שם הפרויקט:",
    "בית משפחת",
    "נח",
    "שם הגיליון:",
    'קנ"מ:',
    "1:50",
    "תאריך:",
    "22.12.16",
    "סטטוס:",
    "לעיון",
    "לתמחור",
    "לביצוע",
    "תאור והערות:",
]
SHEET_NAMES = {
    "08222cb2": ["ת. מאסטר", "קומת קרקע"],
    "1470f005": ["ת. בניה", "קומת קרקע"],
    "1bbe4113": ["ת.תאורה", "קומת מרתף+", "קומת קרקע"],
    "24ab0ea0": ["ת. אינסטלציה", "קומת מרתף"],
    "2a308827": ["ת. אינסטלציה", "קומה א'"],
    "6fa88f92": ["ת. מאסטר", "קומת מרתף+", "קומת קרקע"],
    "70a5c3e0": ["ת. הריסה", "קומת קרקע"],
    "8099ab2c": ["ת. בניה", "קומה א'"],
    "8d51ed5a": ["ת. אינסטלציה", "קומת קרקע"],
    "ad257a1c": ["ת. בניה", "קומת מרתף"],
    "af849ec4": ["ת. הריסה", "קומה א'"],
    "b2046277": ["ת. תאורה", "קומת קרקע"],
    "c054fd3a": ["ת. חשמל", "קומת מרתף+", "קומת קרקע"],
    "eb8be8a3": ["ת. חשמל", "קומת קרקע"],
    "f14c7573": ["ת. הריסה", "קומת מרתף"],
}

if __name__ == "__main__":
    lines = S.load_lines()
    gd = pickle.load(open(S.OUT / "gd.pkl", "rb"))
    gd.assign(lines)
    stats = json.loads((S.OUT / "extract_stats.json").read_text())
    items, missing = [], []
    for sid, names in SHEET_NAMES.items():
        W, H = stats[sid]["width_mm"], stats[sid]["height_mm"]
        sp = [
            s
            for s in text_spans([l for l in lines if l.sheet == sid], gd)
            if s.bbox[1] > H - 32 and s.bbox[0] > W - 205 and s.rotation == 0
        ]
        used = set()
        for exp in COMMON + names:
            best, br = None, 0.0
            for k, s in enumerate(sp):
                if k in used:
                    continue
                r = fuzzy_ratio(exp, s.text)
                if r > br:
                    best, br = k, r
            if best is None or br < 0.4:
                missing.append((sid, exp, br))
                continue
            used.add(best)
            b = sp[best].bbox
            items.append(
                {
                    "sheet": sid,
                    "group": "titleblock",
                    "bbox": [round(b[0] - 0.3, 1), round(b[1] - 0.3, 1), round(b[2] + 0.3, 1), round(b[3] + 0.3, 1)],
                    "text": exp,
                }
            )
            print(sid, f"{br:.2f}", exp, "<-", sp[best].text)
    print("missing:", missing)
    out = Path(__file__).with_name("shx_gt.json")
    data = json.loads(out.read_text())
    data["items"] = [i for i in data["items"] if i["group"] != "titleblock"] + items
    data["titleblock_unmatched"] = missing
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    print(len(items), "titleblock items")
