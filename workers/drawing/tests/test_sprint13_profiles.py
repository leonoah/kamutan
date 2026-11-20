"""Sprint 13 (Worker-Areas): LED lighting-profile bars → BOQ profile lines."""

from __future__ import annotations

from dataclasses import replace

import pytest

from kamutan_drawing.boq import profiles as P
from kamutan_drawing.boq.aggregate import aggregate
from kamutan_drawing.boq.rules import Library, default_rules
from kamutan_drawing.lighting.profiles import label_kind, profile_runs

from .test_boq import lib_rows
from .test_boq_s4 import lines, psheet
from .test_geometry import Sheet, text

PALE = (255, 255, 127)


def _lib(rows: list[tuple[str, str, str, str]]) -> Library:
    docs = lib_rows([(c, d, ch) for c, d, ch, _ in rows])
    for (_, d), (_, _, _, unit) in zip(docs, rows, strict=True):
        d["unit"] = unit
    return Library.from_docs(docs)


METRE = [
    ("4.42", 'התקנת פרופיל תאורה בעובי פלטת גבס 12 מ"מ- שקוע בתקרת גבס', "04", 'מ"א'),
    ("4.43", 'התקנת פרופיל תאורה חיצוני עה"ט', "04", 'מ"א'),
    ("4.48", "התקנת פרופיל מוגן מים בניתוק מדרגה מרחפת", "04", 'מ"א'),
    ("7.08", "אספקת והתקנת פרופיל ניתוק STR במפגש תקרת גבס עם קירות חדרי רחצה", "07", 'מ"א'),
]
UNITS = [
    ("4.48", 'התקנת פרופיל תאורה חיצוני עה"ט באורך 800 ס"מ', "04", "יחידה"),
    ("4.49", 'התקנת פרופיל תאורה חיצוני עה"ט באורך 500 ס"מ', "04", "יחידה"),
    ("4.52", 'התקנת פרופיל תאורה חיצוני עה"ט באורך 300 ס"מ', "04", "יחידה"),
    ("4.53", 'התקנת פרופיל תאורה שקוע גבס בעובי 12 מ"מ ובאורך 140 ס"מ', "04", "יחידה"),
]


def _sheet() -> tuple[Sheet, list]:
    s = Sheet()
    s.rect(100, 100, 100.4, 164.8, PALE)  # 64.8 mm, meets the next bar at the corner: one L profile of 8.24 m
    s.rect(100, 164.6, 200, 165, PALE)  # 100 mm
    s.rect(250, 100, 250.4, 128, PALE)  # 1.4 m, labelled recessed
    s.rect(300, 100, 300.4, 163, PALE)  # 3.15 m, no label → surface
    s.rect(330, 200, 350, 200.4, PALE)  # 1.0 m LED tape under a counter (note beside it)
    s.rect(60, 60, 80, 61, (255, 0, 0))  # another colour: not a profile
    s.line([(340, 193.5), (340, 199.6)], (230, 126, 34))  # the tape note's leader ends on that bar
    spans = [
        text("פרופיל שקוע בגבס", 251, 105, 254, 124),
        text("סרט לד", 335, 190, 346, 193),
        text("הזנה לפרופיל שקוע", 296, 90, 320, 93),  # names the feed point, not the bar
        text("שקוע", 312, 130, 317, 132),  # a recessed spot's tag 12 mm from the bar: says nothing about the bar
    ]
    return s, spans


def test_bars_chain_into_profiles_and_take_the_kind_written_beside_them() -> None:
    s, spans = _sheet()
    runs = {r["id"]: r for r in profile_runs(s.build(), spans)}
    by_len = {round(r["lengthMm"] / 20.0, 2): r for r in runs.values()}  # 1:50
    assert len(runs) == 4
    assert by_len[8.24]["kind"] == "surface" and len(by_len[8.24]["parts"]) == 2 and not by_len[8.24]["labelled"]
    assert by_len[1.4]["kind"] == "recessed" and by_len[1.4]["labelled"]
    assert by_len[3.15]["kind"] == "surface"
    assert by_len[1.0]["kind"] == "tape"
    assert label_kind("פרופיל מוהן מים") == "water" and label_kind("פרופיל חיצוני") == "surface"
    assert label_kind("שקוע") == "recessed" and label_kind("הזנה לפרופיל לד") is None and label_kind("40שקוע") is None
    tagged = profile_runs(s.build(), [*spans, text("שקוע", 301, 130, 306, 132)])  # the tag written right at the bar
    assert {round(r["lengthMm"] / 20.0, 2): r["kind"] for r in tagged}[3.15] == "recessed"
    assert profile_runs(Sheet().rect(0, 0, 10, 10, (255, 0, 0)).build(), []) == []


def test_library_profile_lines_and_quantities() -> None:
    lb = _lib(METRE)
    kinds = {i.code: (pi.kind, pi.per_metre) if (pi := P.profile_item(i)) else None for i in lb.items}
    assert kinds == {"4.42": ("recessed", True), "4.43": ("surface", True), "4.48": ("water", True), "7.08": None}
    runs = [{"id": "pf_1", "kind": "surface", "lengthMm": 164.8, "labelled": False},
            {"id": "pf_2", "kind": "recessed", "lengthMm": 28.0, "labelled": True},
            {"id": "pf_3", "kind": "surface", "lengthMm": 63.0, "labelled": False},
            {"id": "pf_4", "kind": "tape", "lengthMm": 20.0, "labelled": True}]  # fmt: skip
    one = {"sheetId": "g", "floors": ["ground"], "scale": 50, "profiles": runs}
    master = {"sheetId": "all", "floors": ["ground"], "scale": 50, "profiles": runs}
    qs, st = P.profile_quantities([one], list(lb.items))
    got = {q.item.code: q.qty for q in qs}
    assert got == {"4.43": pytest.approx(11.39), "4.42": pytest.approx(1.4)} and st["tape"] == 1 and st["noLine"] == 0
    # a sheet showing several floors repeats the single-floor sheets of those floors
    both = {"sheetId": "all", "floors": ["ground", "first"], "scale": 50, "profiles": runs}
    first = {"sheetId": "f", "floors": ["first"], "scale": 50, "profiles": runs[:1]}
    assert [s["sheetId"] for s in P.source_sheets([one, first, both])] == ["g", "f"]
    assert len(P.source_sheets([one, both])) == 2 and len(P.source_sheets([one, master])) == 2
    # per-unit library: one profile per nominal length, nearest first; a profile with no line stays out
    qs, st = P.profile_quantities([{**one, "profiles": [*runs, {"id": "pf_5", "kind": "surface", "lengthMm": 112.2}]}],
                                  list(_lib(UNITS).items))  # fmt: skip
    assert {q.item.code: q.qty for q in qs} == {"4.48": 1.0, "4.52": 1.0, "4.53": 1.0}  # 8.24 → 800, 3.15 → 300, 1.4 → 140
    assert st["noLine"] == 1  # the 5.61 m profile: no line of that length (500 is 12 % away)


def test_profile_lines_in_the_boq_and_none_without_bars_or_lines() -> None:
    s, spans = _sheet()
    runs = profile_runs(s.build(), spans)
    li = replace(psheet("li", "lighting", [], []), circuits={"circuits": [], "profiles": runs})
    ln = lines(aggregate([li], default_rules(), _lib(METRE)))
    assert ln["4.43"].qty == pytest.approx(11.39) and ln["4.42"].qty == pytest.approx(1.4)
    assert ln["4.43"].origin == "geometry" and "4.48" not in ln or ln["4.48"].qty == 0
    res = aggregate([replace(li, circuits={"circuits": []})], default_rules(), _lib(METRE))
    assert res.stats["lightingProfiles"]["profiles"] == 0
    assert all(v.qty == 0 for k, v in lines(res).items() if k in ("4.42", "4.43"))
