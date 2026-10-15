"""Sprint 4 (Worker-A): ``symbols.rematch`` — corrections re-matched to a newer version's detections."""

from __future__ import annotations

from typing import Any

from kamutan_drawing.symbols.rematch import class_family, rematch, rematch_ids


def det(i: str, cls: str, x: float, y: float, **kw: Any) -> dict[str, Any]:
    return {"id": i, "class": cls, "centerMm": {"x": x, "y": y}, **kw}


def corr(i: str, kind: str, x: float, y: float, **kw: Any) -> dict[str, Any]:
    base = {"id": i, "kind": kind, "sheetId": "s1", "versionId": "v1", "anchorMm": {"x": x, "y": y}, "radiusMm": 3,
            "detectionId": None, "signature": None, "class": None, "revertedAt": None}  # fmt: skip
    if "cls" in kw:
        kw["class"] = kw.pop("cls")
    return {**base, **kw}


NEW = [
    det("d_0", "socket_single", 101.0, 50.5),  # shifted 1.1 mm (re-export)
    det("d_1", "switch_single", 120.0, 50.0),
    det("d_2", "luminaire_ceiling", 200.0, 80.0),
    det("d_3", "socket_double", 300.0, 10.0),
]


def test_families():
    assert class_family("socket_double") == class_family("socket_3phase") == "socket"
    assert class_family("switch_2way") == "switch" and class_family("ceiling_fan") == "luminaire"
    assert class_family("fixture_wc_concealed") == class_family("fixture_wc_monoblock") == "wc"
    assert class_family("fixture_basin") == "fixture" and class_family("garden_tap") == class_family("faucet_wall") == "faucet"
    assert class_family("tv_point") == "comms" and class_family("mystery") == "mystery" and class_family(None) is None


def test_anchor_radius_and_family():
    cs = [
        corr("c1", "reject", 100.0, 50.0, detectionId="d_9", cls="socket_single"),  # → d_0 (1.1 mm)
        corr("c2", "accept", 119.0, 50.0, detectionId="d_8", cls="socket_single"),  # switch nearby: wrong family
        corr("c3", "remove", 205.0, 80.0, detectionId="d_7", cls="luminaire_ceiling"),  # 5 mm > 3 mm
        corr("c4", "remove", 205.0, 80.0, detectionId="d_6", cls="luminaire_ceiling", radiusMm=6),
    ]
    r = {x.correction_id: x for x in rematch(cs, NEW, sheet_id="s1", version_id="v2")}
    assert r["c1"].status == "matched" and r["c1"].detection_id == "d_0" and abs(r["c1"].distance_mm - 1.118) < 0.01
    assert r["c2"].status == "unmatched"
    assert r["c3"].status == "unmatched"
    assert r["c4"].status == "matched" and r["c4"].detection_id == "d_2"


def test_reclassify_matches_any_family_unless_from_class_given():
    cs = [
        corr("c1", "reclassify", 120.5, 50.0, detectionId="d_5", cls="socket_single"),  # was a switch: no constraint
        corr("c2", "reclassify", 299.0, 10.0, detectionId="d_4", cls="tv_point", fromClass="switch_single"),
    ]
    r = rematch(cs, NEW, version_id="v2")
    assert (r[0].status, r[0].detection_id) == ("matched", "d_1")
    assert r[1].status == "unmatched"  # the item there now is a socket, not the switch that was reclassified


def test_one_detection_per_item_and_shared_item_corrections_travel_together():
    cs = [
        corr("a", "reclassify", 100.2, 50.0, detectionId="d_old1", cls="socket_double"),
        corr("b", "move", 100.2, 50.0, detectionId="d_old1", geometry={"type": "point", "mm": [{"x": 103, "y": 50}]}),
        corr("c", "reject", 102.5, 50.5, detectionId="d_old2", cls="socket_single"),  # other item, same new det
    ]
    r = rematch(cs, NEW, version_id="v2")
    assert r[0].detection_id == r[1].detection_id == "d_0" and r[0].status == r[1].status == "matched"
    assert r[2].status == "unmatched"  # d_0 is taken by the closer item


def test_signature_breaks_ties():
    dets = [det("d_a", "socket_single", 10.0, 10.0, signature="aaaa"), det("d_b", "socket_single", 10.5, 10.0, signature="bbbb")]
    r = rematch([corr("c", "accept", 10.4, 10.0, detectionId="x", cls="socket_single", signature="aaaa")], dets)
    assert r[0].detection_id == "d_a"


def test_add_manual_reverted_other_sheet_and_targets():
    cs = [
        corr("add1", "add", 300.5, 10.0, cls="socket_double"),  # the detector now finds it
        corr("add2", "add", 50.0, 50.0, cls="socket_double"),  # nothing there
        corr("m1", "measure", 0, 0, itemCode="5.02", geometry={"type": "polygon", "mm": [{"x": 0, "y": 0}] * 3}, unit="m2"),
        corr("k1", "count", 0, 0, cls="garden_tap", geometry={"type": "point", "mm": [{"x": 1, "y": 1}]}),
        corr("rv", "reject", 101, 50.5, detectionId="d_x", cls="socket_single", revertedAt="2026-10-14T00:00:00Z"),
        corr("os", "reject", 101, 50.5, detectionId="d_x", cls="socket_single", sheetId="s2"),
        corr("lk", "link", 120, 50, switchIds=["d_1"], pointIds=["d_2"]),
        corr("rg", "remove", 120, 50, linkGroupId="lk_3"),
    ]
    st = {x.correction_id: (x.status, x.detection_id) for x in rematch(cs, NEW, sheet_id="s1")}
    assert st["add1"] == ("already_detected", "d_3")
    assert st["add2"] == ("added", None)
    assert st["m1"] == ("manual", None) and st["k1"] == ("manual", None)
    assert st["rv"] == ("reverted", None) and st["os"] == ("other_sheet", None)
    assert st["lk"] == ("other_target", None) and st["rg"] == ("other_target", None)


def test_same_version_keeps_detection_id():
    c = corr("c", "reject", 0.0, 0.0, detectionId="d_2", cls="luminaire_ceiling", versionId="v2")
    r = rematch([c], NEW, version_id="v2")
    assert (r[0].status, r[0].detection_id) == ("matched", "d_2")
    # on another version the id means nothing: anchor (0,0) is far from d_2
    assert rematch([c], NEW, version_id="v3")[0].status == "unmatched"


def test_deterministic_and_order_preserving():
    cs = [corr(f"c{i}", "accept", 100 + i * 0.1, 50, detectionId=f"o{i}", cls="socket_single") for i in range(4)]
    a = [x.to_json() for x in rematch(cs, NEW)]
    b = [x.to_json() for x in rematch(cs, list(reversed(NEW)))]
    assert a == b and [x["correctionId"] for x in a] == ["c0", "c1", "c2", "c3"]
    assert sum(1 for x in a if x["status"] == "matched") == 1


def test_rematch_ids_for_link_corrections():
    old = [det("o_1", "switch_single", 119.5, 50.0), det("o_2", "luminaire_ceiling", 201.0, 80.0), det("o_3", "speaker", 5, 5)]
    assert rematch_ids(["o_1", "o_2", "o_3", "o_missing"], old, NEW) == {
        "o_1": "d_1",
        "o_2": "d_2",
        "o_3": None,
        "o_missing": None,
    }
