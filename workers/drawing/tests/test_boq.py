"""BOQ rules engine, composite lighting lines, de-dup, install count, build job (override preservation)."""

from __future__ import annotations

import base64
import gzip
import json
from typing import Any

import pytest

from kamutan_drawing.boq import rules as R
from kamutan_drawing.boq.aggregate import SheetInput, aggregate, code_key, effective_regions
from kamutan_drawing.boq.build import evidence_bytes, run_boq_build
from kamutan_drawing.boq.contracts import BoqBuildJob, LinkGroup
from kamutan_drawing.boq.rules import Library, Rule, default_rules, load_rules, seed_rules, similarity
from kamutan_drawing.errors import IngestError
from kamutan_drawing.library_import.importer import item_id
from kamutan_drawing.stores.memory import InMemoryBlobStore, InMemoryDocStore

SAMPLE_ITEMS = [
    ("4.00", "שקע בודד", "04"),
    ("4.01", "שקע כפול", "04"),
    ("4.02", "אביזר שלישיית שקעים", "04"),
    ("4.03", "שקע כח", "04"),
    ("4.05", "נק' תקשורת (כבלים/ טלפון/ רשת) הכנה עם חוט משיכה", "04"),
    ("4.09", "נק' מאור כוללת מפסק", "04"),
    ("4.10", "נק' מאור בעלת שני מפסקים מחליפים", "04"),
    ("4.11", "שתי נק' מאור משותפות בעלות מפסק בודד", "04"),
    ("4.12", "הוספת מפסק מחליף לנקודת מאור קיימת", "04"),
    ("4.14", "הוספת מפסק למאוורר עבור נק' מאור קייימת", "04"),
    ("4.15", "נק' מאור ללא מפסק (חיישן תנועה)", "04"),
    ("4.16", "שלוש נקודות מאור בעלות מפסק בודד", "04"),
    ("9.01", "התקנת גופי התאורה בבית", "08"),
]


def lib_rows(items=SAMPLE_ITEMS) -> list[tuple[str, dict[str, Any]]]:
    return [
        (item_id(c, d), {"code": c, "description": d, "chapter": ch, "chapterTitle": "", "unit": "יחידה", "active": True})
        for c, d, ch in items
    ]


def det(i: int | str, cls: str, x: float = 0, y: float = 0, **kw: Any) -> dict[str, Any]:
    d = {
        "id": i if isinstance(i, str) else f"d_{i}",
        "class": cls,
        "legendEntryId": None,
        "centerMm": {"x": float(x), "y": float(y)},
        "bboxMm": {"x": float(x) - 2, "y": float(y) - 2, "w": 4.0, "h": 4.0},
        "angleDeg": 0,
        "score": 0.9,
        "level": "green",
        "reasons": [],
        "roomId": None,
        "floor": "ground",
        "lifecycle": "new",
        "supply": None,
        "annotations": [],
        "clusterId": None,
    }
    d.update(kw)
    return d


def group(gid: str, kind: str, sw: list[str], lum: list[str], points: list[str] | None = None, **kw: Any) -> LinkGroup:
    return LinkGroup.model_validate(
        {
            "id": gid,
            "switchIds": sw,
            "pointIds": points if points is not None else list(lum),
            "luminaireIds": lum,
            "kind": kind,
            "confidence": kw.get("confidence", 0.9),
            "level": kw.get("level", "green"),
            "reasons": kw.get("reasons", []),
        }
    )


def sheet(sid: str, disc: str, dets: list[dict[str, Any]], links: list[LinkGroup] | None = None, **kw: Any) -> SheetInput:
    return SheetInput(
        sid,
        kw.get("version", "v1"),
        disc,
        kw.get("scale", 50),
        kw.get("floors", ["ground"]),
        kw.get("page", (420.0, 297.0, 0)),
        dets,
        links,
        kw.get("confirmed", False),
        kw.get("regions", []),
        kw.get("texts", []),
        kw.get("rooms", {}),
    )


def by_code(res) -> dict[str, Any]:
    return {ln.code: ln for ln in res.lines}


# ----------------------------------------------------------------------------- rules / library
def test_default_rules_and_seeding():
    rules = default_rules()
    assert {r.kind for r in rules} == set(R.KINDS)
    assert rules == sorted(rules, key=lambda r: (-r.priority, r.id))
    docs = InMemoryDocStore()
    assert seed_rules(docs, "o1") == len(R.DEFAULT_RULES)
    assert seed_rules(docs, "o1") == 0  # idempotent
    # a user disables one rule; another default disappears (older worker) → only the missing one is re-added
    docs.set("orgs/o1/boqRules/r_speaker", {"enabled": False})
    docs.docs.pop("orgs/o1/boqRules/r_panel")
    assert seed_rules(docs, "o1") == 1
    loaded = load_rules(docs, "o1")
    assert "r_speaker" not in {r.id for r in loaded} and "r_panel" in {r.id for r in loaded}
    assert docs.get("orgs/o1/boqRules/r_light_two_way")["itemCode"] == "4.10"  # TEXT code
    assert docs.get("orgs/o1/boqRules/r_panel")["defaultsVersion"] == R.DEFAULT_RULES_VERSION
    # an org seeded with older defaults: outdated `default` docs are replaced, custom ones never touched
    old = {"source": "default", "defaultsVersion": 1, "kind": "install_count", "enabled": True, "itemCode": "9.01",
           "match": {"classes": ["luminaire_wall"], "excludeClasses": [], "excludeSupply": ["client"], "excludeLifecycle": ["existing"]}}  # fmt: skip
    docs.set("orgs/o1/boqRules/r_install_luminaires", old, merge=False)
    docs.set("orgs/o1/boqRules/r_socket_double", {"source": "default"}, merge=False)  # no version = 0 → outdated
    docs.set("orgs/o1/boqRules/r_socket_single", {"source": "custom", "itemCode": "E-1"})
    docs.set("orgs/o1/boqRules/r_custom_x", {"source": "custom", "kind": "class_to_item", "match": {"classes": ["speaker"]},
                                             "itemCode": "E-2", "enabled": True})  # fmt: skip
    assert seed_rules(docs, "o1") == 2
    inst = docs.get("orgs/o1/boqRules/r_install_luminaires")
    assert inst["match"]["excludeLifecycle"] == ["demolish"] and inst["defaultsVersion"] == R.DEFAULT_RULES_VERSION
    assert docs.get("orgs/o1/boqRules/r_socket_single")["itemCode"] == "E-1"
    assert docs.get("orgs/o1/boqRules/r_custom_x")["itemCode"] == "E-2"
    assert R.rule_needs_reseed(None) and not R.rule_needs_reseed({"source": "user", "defaultsVersion": 0})


def test_library_resolution():
    lib = Library.from_docs(lib_rows())
    r = lib.resolve("4.10", "נק' מאור בעלת שני מפסקים מחליפים")
    assert r is not None and r.item.code == "4.10" and r.how == "code"
    # another org's numbering: no 4.01, but the description is there → similarity, recorded
    other = Library.from_docs(lib_rows([("E-12", "שקע כפול", "04"), ("E-13", "שקע כח כפול", "04")]))
    r = other.resolve("4.01", "שקע כפול")
    assert r is not None and r.item.code == "E-12" and r.how == "similarity"
    # same code, unrelated description (another org's 4.01) → not taken, unless the code was chosen by a user
    clash = Library.from_docs(lib_rows([("4.01", "צביעת קירות פנים", "07")]))
    assert clash.resolve("4.01", "שקע כפול") is None
    assert clash.resolve("4.01", "", trust_code=True) is not None
    assert similarity("שקע כח", "שקע כח") == 1.0 and similarity("שקע", "") == 0.0
    assert code_key("4.9") < code_key("4.10") < code_key("4.11") and code_key("4.1") < code_key("4.10")


# ----------------------------------------------------------------------------- composite lighting
def test_composite_lines_from_link_groups():
    dets = [
        det(1, "switch_single", 10, 10), det(2, "luminaire_ceiling", 20, 10),  # single → 4.09
        det(3, "switch_2way", 30, 10), det(4, "switch_2way", 60, 10), det(5, "luminaire_ceiling", 45, 20),  # 4.10
        det(6, "switch_single", 10, 50), det(7, "luminaire_wall", 20, 50), det(8, "luminaire_wall", 40, 50),  # 4.11
        det(9, "switch_single", 10, 80), det(10, "luminaire_ceiling", 20, 80), det(11, "luminaire_ceiling", 30, 80),
        det(12, "luminaire_ceiling", 40, 80),  # 4.16
        det(13, "luminaire_outdoor", 100, 100, floor="basement"), det(14, "luminaire_outdoor", 110, 100, floor="basement"),  # sensor → 4.15 ×2
        det(15, "switch_2way", 200, 10), det(16, "luminaire_ceiling", 210, 10, lifecycle="existing", supply="existing"),  # 4.12
        det(17, "switch_fan", 200, 50), det(18, "ceiling_fan", 210, 50, lifecycle="existing", supply="existing"),  # 4.14
        det(19, "switch_2way", 300, 10), det(20, "switch_2way", 330, 10), det(21, "luminaire_ceiling", 310, 10),
        det(22, "luminaire_ceiling", 320, 10),  # two_way with 2 points: no rule → unmatched
        det(23, "switch_single", 300, 200, lifecycle="existing"), det(24, "luminaire_wall", 310, 200, lifecycle="existing"),  # all existing
    ]  # fmt: skip
    links = [
        group("lk_1", "single", ["d_1"], ["d_2"]),
        group("lk_2", "two_way", ["d_3", "d_4"], ["d_5"], level="yellow", reasons=[R.R_SWITCH_LINK]),
        group("lk_3", "shared", ["d_6"], ["d_7", "d_8"]),
        group("lk_4", "shared", ["d_9"], ["d_10", "d_11", "d_12"]),
        group("lk_5", "sensor", [], ["d_13", "d_14"]),
        group("lk_6", "add_to_existing", ["d_15"], ["d_16"]),
        group("lk_7", "add_to_existing", ["d_17"], ["d_18"]),
        group("lk_8", "two_way", ["d_19", "d_20"], ["d_21", "d_22"]),
        group("lk_9", "single", ["d_23"], ["d_24"]),
    ]
    res = aggregate([sheet("L", "lighting", dets, links)], default_rules(), Library.from_docs(lib_rows()))
    lines = by_code(res)
    assert {c: lines[c].qty for c in ("4.09", "4.10", "4.11", "4.16", "4.15", "4.12", "4.14")} == {
        "4.09": 1, "4.10": 1, "4.11": 1, "4.16": 1, "4.15": 1, "4.12": 1, "4.14": 1,
    }  # fmt: skip
    assert lines["4.10"].level == "yellow" and R.R_SWITCH_LINK in lines["4.10"].reasons
    assert lines["4.09"].level == "green" and lines["4.09"].rule_id == "r_light_single"
    assert lines["4.15"].by_floor == {"basement": 1}
    ev = lines["4.10"].evidence
    assert {e["detectionId"] for e in ev} == {"d_3", "d_4", "d_5"} and {e["linkGroupId"] for e in ev} == {"lk_2"}
    un = [ln for ln in res.lines if ln.chapter == R.UNMATCHED_CHAPTER]
    assert [ln.code for ln in un] == ["X-light-two-way-2"] and un[0].level == "red" and R.R_NO_RULE in un[0].reasons
    # install count (contracts default): every luminaire position incl. existing ones, fans and demolished excluded
    assert lines["9.01"].qty == 13  # d_2,5,7,8,10,11,12,13,14,16,21,22,24
    assert not any(ln.code == "X-ceiling-fan" for ln in res.lines)  # fans are lighting family, never "לא משויך"
    assert lines["9.01"].chapter == "08"


def test_points_merge_rule_and_pointids():
    dets = [det(1, "switch_single", 0, 0), det(2, "luminaire_strip", 10, 0), det(3, "luminaire_strip", 12, 0)]
    # Worker-A: two luminaires wired together = one point (pointIds) → 4.09, not 4.11
    res = aggregate([sheet("L", "lighting", dets, [group("lk_1", "single", ["d_1"], ["d_2", "d_3"], points=["pt_1"])])],
                    default_rules(), Library.from_docs(lib_rows()))  # fmt: skip
    assert by_code(res)["4.09"].qty == 1 and "4.11" not in by_code(res)
    # no pointIds: a rule with pointMergeMm (real mm) clusters luminaires within 150 mm (= 3 mm at 1:50)
    rules = [r for r in default_rules() if r.id != "r_light_single"] + [
        Rule("r_light_single", "composite_lighting", {"groupKind": "single", "pointCount": 1, "pointMergeMm": 150}, "4.09",
             "נק' מאור כוללת מפסק", "יחידה", 200, "default"),
    ]  # fmt: skip
    res = aggregate([sheet("L", "lighting", dets, [group("lk_1", "single", ["d_1"], ["d_2", "d_3"], points=[])])],
                    R.sort_rules(rules), Library.from_docs(lib_rows()))  # fmt: skip
    assert by_code(res)["4.09"].qty == 1


def test_fallback_without_links_is_red():
    dets = [
        det(1, "switch_single", 0, 0),
        det(2, "switch_2way", 10, 0),
        det(3, "switch_2way", 50, 0),
        det(4, "luminaire_wall", 5, 5),
    ]
    res = aggregate([sheet("L", "lighting", dets, None)], default_rules(), Library.from_docs(lib_rows()))
    lines = by_code(res)
    assert lines["4.09"].qty == 1 and lines["4.10"].qty == 1
    assert lines["4.09"].level == "red" and R.R_NO_LINKS in lines["4.09"].reasons
    assert res.stats["fallbackSheets"] == ["L"]


def test_install_count_flags():
    dets = [
        det(1, "luminaire_ceiling", supply="client"),
        det(2, "luminaire_wall", lifecycle="demolish"),
        det(3, "ceiling_fan"),
        det(4, "luminaire_pendant", lifecycle="existing", supply="existing"),
    ]
    lib = Library.from_docs(lib_rows())
    # contracts default: client-supplied and existing positions count, demolished and fans do not
    assert by_code(aggregate([sheet("L", "lighting", dets, [])], default_rules(), lib))["9.01"].qty == 2
    rules = [r for r in default_rules() if r.kind != "install_count"] + [
        Rule("r_install", "install_count", {"classes": ["luminaire_ceiling", "luminaire_wall", "luminaire_pendant"],
             "excludeClasses": ["ceiling_fan"], "excludeLifecycle": ["existing", "demolish"], "excludeSupply": ["client"]},
             "9.01", "התקנת גופי התאורה", "יחידה", 100, "custom"),
    ]  # fmt: skip
    assert "9.01" not in by_code(aggregate([sheet("L", "lighting", dets, [])], R.sort_rules(rules), lib))


# ----------------------------------------------------------------------------- classes / legend / floors
def test_class_lines_legend_and_mappings():
    entries = {
        "le_a": {"status": "confirmed", "class": "socket_double", "itemCode": None, "signature": "sigA0000"},
        "le_b": {"status": "ignored", "signature": "sigB0000"},
        "le_c": {"status": "confirmed", "class": "socket_power", "itemCode": "4.05", "signature": "sigC0000"},
        "le_d": {"status": "suggested", "signature": "sigD0000"},
    }
    mappings = {"sigD0000": {"ignored": True}}
    dets = [
        det(1, "socket_single", legendEntryId="le_a"),  # confirmed class wins → 4.01
        det(2, "socket_single", legendEntryId="le_b"),  # ignored entry → dropped
        det(3, "socket_single", legendEntryId="le_c"),  # user item code → 4.05
        det(4, "socket_single", legendEntryId="le_d"),  # ignored signature → dropped
        det(5, "socket_single", lifecycle="existing", supply="existing"),  # existing socket: not new work
        det(6, "socket_single", level="yellow", reasons=["ביטחון נמוך"]),
        det(7, "socket_prep"),  # no rule → לא משויך
        det(8, "unknown", clusterId="u_1", level="red", reasons=["סמל לא במקרא"]),
        det(9, "waterproof_marker"),  # marker: no line
        det(10, "speaker"),  # rule, but the library has no such item → לא משויך, red
    ]
    res = aggregate([sheet("E", "electrical", dets)], default_rules(), Library.from_docs(lib_rows()), entries, mappings)
    lines = by_code(res)
    assert lines["4.01"].qty == 1 and lines["4.05"].qty == 1 and lines["4.05"].rule_id == "legend_le_c"
    assert lines["4.00"].qty == 1 and lines["4.00"].level == "yellow" and lines["4.00"].reasons == ["ביטחון נמוך"]
    assert res.stats["skipped"] == {"ignoredEntry": 1, "ignoredSignature": 1} and res.stats["excludedByLifecycle"] == 1
    un = {ln.code: ln for ln in res.lines if ln.chapter == R.UNMATCHED_CHAPTER}
    assert set(un) == {"X-socket-prep", "X-unknown", "X-4-07"}
    assert all(ln.level == "red" for ln in un.values())
    assert R.R_NO_ITEM in un["X-4-07"].reasons and un["X-4-07"].rule_id == "r_speaker"
    assert R.R_UNKNOWN_SYMBOL in un["X-unknown"].reasons
    assert un["X-socket-prep"].description == "הכנה לשקע"
    # ordering: chapters, natural codes, unmatched last
    assert [ln.code for ln in res.lines][-3:] == sorted(un, key=code_key)


def test_confirmed_floors_remove_uncertainty():
    regions = [
        {
            "id": "r0",
            "floor": "basement",
            "polygonMm": [{"x": 0, "y": 0}, {"x": 100, "y": 0}, {"x": 100, "y": 100}, {"x": 0, "y": 100}],
        },
        {
            "id": "r1",
            "floor": "ground",
            "polygonMm": [{"x": 0, "y": 100}, {"x": 100, "y": 100}, {"x": 100, "y": 200}, {"x": 0, "y": 200}],
        },
    ]
    assert [r["floor"] for r in effective_regions(["basement", "first"], regions)] == ["basement", "first"]
    assert [r["floor"] for r in effective_regions(["ground", "basement"], regions)] == ["basement", "ground"]
    dets = [
        det(1, "socket_single", 50, 150, floor="ground", level="yellow", reasons=[R.R_FLOOR_UNSURE], score=0.9),
        det(2, "socket_single", 50, 50, floor="basement", level="yellow", reasons=[R.R_FLOOR_UNSURE, "פריטים חופפים"]),
    ]
    lib = Library.from_docs(lib_rows())
    raw = by_code(
        aggregate([sheet("E", "electrical", dets, floors=["basement", "ground"], regions=regions)], default_rules(), lib)
    )
    assert raw["4.00"].level == "yellow" and R.R_FLOOR_UNSURE in raw["4.00"].reasons
    conf = by_code(
        aggregate(
            [sheet("E", "electrical", dets, floors=["basement", "first"], regions=regions, confirmed=True)], default_rules(), lib
        )
    )["4.00"]
    assert conf.by_floor == {"basement": 1, "first": 1}
    # Sprint 5 (Worker-Cal): an item whose only chip was the floor goes back to green *through the calibration
    # table* — in conservative mode socket_single may not be green, so it stays yellow with the conservative chip
    from kamutan_drawing.calibration import R_CONSERVATIVE

    assert R.R_FLOOR_UNSURE not in conf.reasons and conf.reasons == [R_CONSERVATIVE, "פריטים חופפים"]


# ----------------------------------------------------------------------------- de-dup
def test_cross_sheet_dedup_by_aligned_position():
    lib = Library.from_docs(lib_rows())
    sockets = [(50, 60), (120, 80), (200, 40), (260, 150)]
    el = [det(i, "socket_double", x, y) for i, (x, y) in enumerate(sockets)]
    # the lighting sheet repeats the sockets, shifted by (+15, -7) (another viewport), plus one only it has
    li = [det(100 + i, "socket_double", x + 15, y - 7, level="yellow", reasons=["x"]) for i, (x, y) in enumerate(sockets)]
    li.append(det(200, "socket_double", 330, 250))
    # and the electrical sheet repeats two switches of the lighting sheet (identity: same layout)
    sw_l = [det(300, "switch_single", 30, 30), det(301, "switch_single", 90, 30), det(302, "switch_single", 150, 30)]
    sw_e = [det(400, "switch_single", 30.5, 30.4), det(401, "switch_single", 150, 29.5)]
    res = aggregate([sheet("E", "electrical", el + sw_e), sheet("L", "lighting", li + sw_l, None)], default_rules(), lib)
    lines = by_code(res)
    assert lines["4.01"].qty == 5  # 4 + the lighting-only one
    assert res.stats["duplicatesRemoved"] == 6
    ids = {e["detectionId"] for e in lines["4.01"].evidence}
    assert "d_200" in ids and not any(i.startswith("d_10") for i in ids)
    assert R.R_SECONDARY in lines["4.01"].reasons
    assert lines["4.09"].qty == 3  # fallback groups from the lighting sheet's switches only
    hows = {a["rule"]: a["how"] for a in res.stats["alignments"]}
    assert hows == {"r_auth_sockets": "votes", "r_auth_switches": "identity"}


def test_dedup_no_alignment_keeps_items_with_reason():
    lib = Library.from_docs(lib_rows())
    el = [det(1, "socket_double", 10, 10)]
    li = [det(2, "socket_double", 300, 200)]
    res = aggregate(
        [sheet("E", "electrical", el), sheet("L", "lighting", li, [], page=(297.0, 420.0, 270))], default_rules(), lib
    )
    ln = by_code(res)["4.01"]
    assert ln.qty == 2 and ln.level == "yellow" and R.R_ALIGN_FAILED in ln.reasons
    # different floors are never compared
    res = aggregate([sheet("E", "electrical", el), sheet("L", "lighting", [det(2, "socket_double", 10, 10, floor="first")], [],
                                                          floors=["first"])], default_rules(), lib)  # fmt: skip
    assert by_code(res)["4.01"].qty == 2 and res.stats["duplicatesRemoved"] == 0


def test_aggregate_is_deterministic():
    dets = [
        det(i, c, i * 7 % 50, i * 13 % 40)
        for i, c in enumerate(["socket_single", "socket_double", "switch_single", "luminaire_wall"] * 5)
    ]
    s1 = [sheet("E", "electrical", list(dets)), sheet("L", "lighting", list(reversed(dets)), None)]
    s2 = [sheet("L", "lighting", list(reversed(dets)), None), sheet("E", "electrical", list(reversed(dets)))]
    lib = Library.from_docs(lib_rows())
    a, b = aggregate(s1, default_rules(), lib), aggregate(s2, default_rules(), lib)
    assert evidence_bytes(a.lines, "b") == evidence_bytes(b.lines, "b")
    assert [ln.computed_fields() for ln in a.lines] == [ln.computed_fields() for ln in b.lines]


# ----------------------------------------------------------------------------- build job
P = "orgs/o1/projects/p1"


def _gz(obj: Any) -> bytes:
    return gzip.compress(json.dumps(obj).encode(), mtime=0)


def seed_project(dets_e: list[dict[str, Any]], dets_l: list[dict[str, Any]], links: list[dict[str, Any]] | None):
    blobs, docs = InMemoryBlobStore(), InMemoryDocStore()
    for rid, d in lib_rows():
        docs.set(f"orgs/o1/itemLibrary/{rid}", d)
    for sid, disc, dets in (("se", "electrical", dets_e), ("sl", "lighting", dets_l)):
        pre = f"{P}/sheets/{sid}/versions/v1/"
        docs.set(
            f"{P}/sheets/{sid}",
            {"discipline": disc, "floors": ["ground"], "scaleDenominator": 50, "currentVersionId": "v1", "confirmed": False},
        )
        arts = {"detections": pre + "detections.json.gz"}
        blobs.write(
            pre + "detections.json.gz",
            _gz({"schema": "kamutan.detections/1", "detections": dets, "unknownClusters": []}),
            "application/gzip",
        )
        if disc == "lighting" and links is not None:
            blobs.write(pre + "links.json.gz", _gz({"schema": "kamutan.links/1", "groups": links}), "application/gzip")
        docs.set(
            f"{pre[:-1]}",
            {"status": "ready", "artifacts": arts, "regions": [], "page": {"widthMm": 420, "heightMm": 297, "rotation": 0}},
        )
    docs.set(f"{P}/sheets/sx", {"discipline": "plumbing", "currentVersionId": "v1"})  # not built
    docs.set(P, {"name": "p", "boq": {"latestBuildId": None, "stale": True, "staleAt": "t0"}})
    return blobs, docs


def build(blobs, docs, bid: str):
    docs.set(f"jobs/j-{bid}", {"orgId": "o1", "projectId": "p1", "type": "boq.build", "status": "queued", "attempts": 0})
    docs.set(f"{P}/boqBuilds/{bid}", {"status": "queued", "jobId": f"j-{bid}"})
    job = BoqBuildJob(
        schemaVersion=1, type="boq.build", jobId=f"j-{bid}", orgId="o1", projectId="p1", buildId=bid, traceparent=None
    )
    return run_boq_build(job, blobs, docs)


def lines_of(docs) -> dict[str, dict[str, Any]]:
    return {d["code"]: {**d, "id": i} for i, d in docs.list_docs(f"{P}/boqLines")}


def test_build_job_writes_lines_evidence_and_summary():
    links = [group("lk_1", "single", ["d_1"], ["d_2"]).model_dump()]
    blobs, docs = seed_project(
        [det(i, "socket_single", i * 20, 0) for i in range(3)],
        [det(1, "switch_single"), det(2, "luminaire_ceiling", 5, 5)],
        links,
    )
    out = build(blobs, docs, "b1")
    assert out.status == "succeeded"
    ls = lines_of(docs)
    assert ls["4.00"]["qty"] == 3 and ls["4.00"]["status"] == "draft" and ls["4.00"]["byFloor"] == {"ground": 3}
    assert ls["4.09"]["ruleId"] == "r_light_single" and ls["9.01"]["qty"] == 1
    assert ls["4.00"]["evidenceRef"] == f"{P}/boq/b1/evidence.json.gz" and ls["4.00"]["sourceVersions"] == [
        {"sheetId": "se", "versionId": "v1"}
    ]
    ev = json.loads(gzip.decompress(blobs.read(f"{P}/boq/b1/evidence.json.gz")))
    assert ev["schema"] == "kamutan.boq-evidence/1" and len(ev["lines"][ls["4.09"]["id"]]) == 2
    b = docs.get(f"{P}/boqBuilds/b1")
    assert b["status"] == "succeeded" and b["stats"]["lines"] == 3 and b["evidenceRef"].endswith("evidence.json.gz")
    assert docs.get(P)["boq"]["latestBuildId"] == "b1" and docs.get(P)["boq"]["stale"] is False
    assert docs.get("jobs/j-b1")["status"] == "succeeded"
    assert len(docs.list_docs("orgs/o1/boqRules")) == len(R.DEFAULT_RULES)  # seeded
    # redelivery of a succeeded build: no-op
    n = len(docs.history)
    job = BoqBuildJob(schemaVersion=1, type="boq.build", jobId="j-b1", orgId="o1", projectId="p1", buildId="b1", traceparent=None)
    assert run_boq_build(job, blobs, docs).status == "skipped"
    assert all(not p.startswith(f"{P}/boqLines") for p, _ in docs.history[n:])


def test_rebuild_preserves_human_fields_and_flags_changed_approvals():
    blobs, docs = seed_project([det(i, "socket_single", i * 20, 0) for i in range(3)] + [det(9, "socket_double")], [], [])
    build(blobs, docs, "b1")
    ls = lines_of(docs)
    lid_s, lid_d = ls["4.00"]["id"], ls["4.01"]["id"]
    # reviewer approves 4.00; editor overrides 4.01 with a note (API writes)
    docs.set(
        f"{P}/boqLines/{lid_s}", {"status": "approved", "approvedBy": "u1", "approvedAt": "2026-10-14T10:00:00Z", "note": "ok"}
    )
    docs.set(f"{P}/boqLines/{lid_d}", {"qtyOverride": 4, "qtyOverrideReason": "ספירה ידנית", "status": "reviewed"})
    docs.set(f"{P}/boqLines/ln_manual", {"code": "99.1", "chapter": "99", "qty": 2, "status": "draft"})  # manual line
    # same input → same qty: approval untouched, no flag
    build(blobs, docs, "b2")
    s = lines_of(docs)["4.00"]
    assert s["status"] == "approved" and s["note"] == "ok" and R.R_QTY_CHANGED not in s["reasons"] and s["buildId"] == "b2"
    # one single socket removed from the drawing → qty 2: status kept, flagged red
    pre = f"{P}/sheets/se/versions/v1/"
    blobs.write(
        pre + "detections.json.gz",
        _gz({"schema": "kamutan.detections/1", "detections": [det(0, "socket_single"), det(1, "socket_single", 20, 0)]}),
        "x",
    )
    build(blobs, docs, "b3")
    ls = lines_of(docs)
    s = ls["4.00"]
    assert s["qty"] == 2 and s["status"] == "approved" and s["approvedBy"] == "u1" and s["level"] == "red"
    assert s["reasons"][0] == R.R_QTY_CHANGED and s["approvedQty"] == 3
    # the overridden 4.01 is obsolete now (no double sockets) but has an override → kept at qty 0, red
    d = ls["4.01"]
    assert d["qty"] == 0 and d["qtyOverride"] == 4 and d["qtyOverrideReason"] == "ספירה ידנית" and d["status"] == "reviewed"
    assert d["reasons"] == [R.R_OBSOLETE] and d["level"] == "red"
    assert docs.get(f"{P}/boqLines/ln_manual")["qty"] == 2  # manual line untouched
    # the flag survives further rebuilds until re-approval
    build(blobs, docs, "b4")
    assert lines_of(docs)["4.00"]["reasons"][0] == R.R_QTY_CHANGED
    docs.set(f"{P}/boqLines/{lid_s}", {"approvedAt": "2026-10-15T09:00:00Z"})  # re-approved at qty 2
    build(blobs, docs, "b5")
    s = lines_of(docs)["4.00"]
    assert R.R_QTY_CHANGED not in s["reasons"] and s["level"] != "red" and s["approvedQty"] == 2
    # an obsolete draft line without override is deleted
    docs.set(f"{P}/boqLines/{lid_d}", {"qtyOverride": None, "status": "draft", "note": None})
    build(blobs, docs, "b6")
    assert docs.get(f"{P}/boqLines/{lid_d}") is None


def test_build_job_rejects_foreign_and_missing():
    blobs, docs = seed_project([], [], None)
    docs.set("jobs/j-x", {"orgId": "other", "projectId": "p1"})
    docs.set(f"{P}/boqBuilds/bx", {"status": "queued"})
    job = BoqBuildJob(schemaVersion=1, type="boq.build", jobId="j-x", orgId="o1", projectId="p1", buildId="bx", traceparent=None)
    with pytest.raises(IngestError) as ei:
        run_boq_build(job, blobs, docs)
    assert ei.value.code == "invalid_payload"
    docs.set("jobs/j-y", {"orgId": "o1", "projectId": "p1"})
    job = BoqBuildJob(
        schemaVersion=1, type="boq.build", jobId="j-y", orgId="o1", projectId="p1", buildId="missing", traceparent=None
    )
    with pytest.raises(IngestError):
        run_boq_build(job, blobs, docs)


def test_build_keeps_stale_when_changed_during_build(monkeypatch):
    blobs, docs = seed_project([det(1, "socket_single")], [], [])
    import kamutan_drawing.boq.build as B

    real = B.build_project

    def racing(*a: Any, **kw: Any):
        out = real(*a, **kw)
        docs.set(P, {"boq": {"stale": True, "staleAt": "t1", "staleReason": "legend"}})  # API marks a change meanwhile
        return out

    monkeypatch.setattr(B, "build_project", racing)
    build(blobs, docs, "b1")
    boq = docs.get(P)["boq"]
    assert boq["latestBuildId"] == "b1" and boq["stale"] is True and boq["staleReason"] == "legend"


def test_push_routing_boq_build():
    from fastapi.testclient import TestClient

    from kamutan_drawing.service.app import create_app

    blobs, docs = seed_project([det(1, "socket_single")], [], [])
    docs.set("jobs/j1", {"orgId": "o1", "projectId": "p1", "type": "boq.build", "status": "queued", "attempts": 0})
    docs.set(f"{P}/boqBuilds/b1", {"status": "queued"})
    client = TestClient(create_app(blobs, docs))

    def push(payload: dict[str, Any]) -> Any:
        data = base64.b64encode(json.dumps(payload).encode()).decode()
        return client.post("/pubsub/ingest", json={"message": {"data": data, "messageId": "1"}})

    payload = {
        "schemaVersion": 1,
        "type": "boq.build",
        "jobId": "j1",
        "orgId": "o1",
        "projectId": "p1",
        "buildId": "b1",
        "traceparent": None,
    }
    assert push(payload).status_code == 204
    assert docs.get(f"{P}/boqBuilds/b1")["status"] == "succeeded"
    r = push({**payload, "buildId": "b 1"})
    assert r.status_code == 200 and r.json()["reason"] == "invalid_payload"
    r = push({**payload, "extra": 1})
    assert r.status_code == 200 and r.json()["reason"] == "invalid_payload"
    r = push({**payload, "jobId": "nope"})
    assert r.status_code == 200 and r.json()["reason"] == "invalid_payload"
    u = "0b3c1f6e-1234-4abc-8def-0123456789ab"
    r = push({"schemaVersion": 1, "type": "library.import", "jobId": "j2", "orgId": "o1", "projectId": None, "importId": u,
              "storagePath": f"orgs/o2/imports/{u}.xls", "sourceKind": "xls", "traceparent": None})  # fmt: skip
    assert r.status_code == 200 and r.json()["reason"] == "invalid_payload"  # foreign import path


def test_parse_links_tolerates_extra_fields_and_drops_bad_groups():
    from kamutan_drawing.boq.contracts import parse_links

    good = {**group("lk_1", "single", ["d_1"], ["d_2"]).model_dump(), "floor": "ground", "arcIds": ["a_1"], "fan": False}
    bad = {**good, "id": "nope"}
    assert [g.id for g in parse_links({"schema": "kamutan.links/1", "groups": [good, bad, "x"]})] == ["lk_1"]
    assert parse_links({"schema": "other", "groups": [good]}) == []


def test_fan_group_detected_from_controlled_points():
    dets = [det(1, "switch_single"), det(2, "ceiling_fan", lifecycle="existing", supply="existing"),
            det(3, "switch_2way", 50, 0), det(4, "ceiling_fan", 50, 5, lifecycle="existing", supply="existing")]  # fmt: skip
    links = [group("lk_1", "add_to_existing", ["d_1"], ["d_2"]), group("lk_2", "add_to_existing", ["d_3"], ["d_4"])]
    lines = by_code(aggregate([sheet("L", "lighting", dets, links)], default_rules(), Library.from_docs(lib_rows())))
    assert lines["4.14"].qty == 1 and lines["4.12"].qty == 1


def test_feed_next_to_boiler_label_is_water_heater():
    lib = Library.from_docs(lib_rows([*SAMPLE_ITEMS, ("4.17", "הזנה לתנור חימום+ מפסק", "04"),
                                      ("4.23", "הזנה לדוד חשמל יחידת דיור כולל התקנת מפסק טיימר של גוויס", "04")]))  # fmt: skip
    texts = [
        {"text": "הזנה לדוד", "bboxMm": [16, 186, 31, 188]},  # 7 mm from d_1
        {"text": "מפסק דוד קיים", "bboxMm": [100, 303, 120, 305]},  # another item: excluded word
        {"text": "220", "bboxMm": [200, 10, 203, 12]},
    ]
    dets = [det(1, "heater_feed", 32, 182), det(2, "heater_feed", 110, 300), det(3, "heater_feed", 200, 14),
            det(4, "heater_feed", 300, 300, legendEntryId="le_c")]  # fmt: skip
    entries = {"le_c": {"status": "confirmed", "class": "heater_feed", "signature": "sigC0000", "label": "הזנה לדוד"}}
    s = SheetInput("E", "v1", "electrical", 50, ["ground"], (420.0, 297.0, 0), dets, None, texts=texts)
    lines = by_code(aggregate([s], default_rules(), lib, entries))
    assert lines["4.23"].qty == 1 and lines["4.17"].qty == 3  # the user-confirmed class is never relabelled
    assert R.R_RELABELED in lines["4.23"].reasons and {e["detectionId"] for e in lines["4.23"].evidence} == {"d_1"}


def test_shared_stair_group_on_two_sheets_counted_once():
    lib = Library.from_docs(lib_rows())

    def stair(sid: str, floor: str, x: float) -> SheetInput:
        dets = [det(1, "switch_2way", x, 10, floor=floor), det(2, "switch_2way", x + 50, 10, floor=floor),
                det(3, "luminaire_outdoor", x + 10, 5, floor=floor, annotations=["סוג 9"]),
                det(4, "switch_single", x, 100, floor=floor, roomId="r_1"), det(5, "luminaire_ceiling", x, 110, floor=floor, roomId="r_1")]  # fmt: skip
        links = [group("lk_1", "two_way", ["d_1", "d_2"], ["d_3"]), group("lk_2", "single", ["d_4"], ["d_5"])]
        return sheet(sid, "lighting", dets, links, floors=[floor], rooms={"r_1": "סלון"})

    res = aggregate([stair("A", "ground", 200), stair("B", "basement", 100)], default_rules(), lib)
    lines = by_code(res)
    assert lines["4.10"].qty == 1 and lines["4.09"].qty == 2 and res.stats["sharedGroups"] == 1
    assert R.R_SHARED in lines["4.10"].reasons and lines["4.10"].level == "yellow"
    assert lines["9.01"].qty == 3  # the stair fixture once + two ceiling lights
    gids = {(e["sheetId"], e["linkGroupId"]) for e in lines["4.10"].evidence}
    assert gids == {("A", "lk_1")} and len(lines["4.10"].evidence) == 3  # switches + point of the one group
    # non-adjacent floors or different fixture types are not merged
    res = aggregate([stair("A", "first", 200), stair("B", "basement", 100)], default_rules(), lib)
    assert by_code(res)["4.10"].qty == 2


def test_fallback_groups_carry_group_ids():
    dets = [det(1, "switch_single", 0, 0), det(2, "switch_2way", 10, 0), det(3, "switch_2way", 50, 0)]
    lines = by_code(aggregate([sheet("L", "lighting", dets, None)], default_rules(), Library.from_docs(lib_rows())))
    assert {e["linkGroupId"] for e in lines["4.10"].evidence} == {"lk_fb2"} and lines["4.10"].qty == 1
