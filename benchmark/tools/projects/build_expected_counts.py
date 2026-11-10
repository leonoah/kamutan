#!/usr/bin/env python3
"""Sprint 10 Data/QA step 3 — cross-check GT for the symbol workers: `gt/<project>/expected_counts.json`.

The designer's per-floor block counts (sheet חשמל) and fixture matrix (sheet אינסטלציה) are Noah's in all three
workbooks (see designer_counts.json), so there is NO per-floor designer source. What this file gives instead: for
every countable BOQ line (unit יחידה / סט / חדר, not cancelled / notForTotal), the project-level expected count = the
BOQ quantity, the Kamutan detection classes (and, where it is not a plain class count, the derivation) that should
sum to it, and `per_floor: null`. Per-floor values can be added later from a manual drawing count
(`per_floor: {"basement": n, "ground": n, "first": n}`, `per_floor_source`).

    uv run python tools/projects/build_expected_counts.py [project ...]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from catalogue import GT, classify

# kind -> (classes that count 1:1, derivation note when it is not a plain class count)
CLASSES: dict[str, tuple[list[str], str | None]] = {
    "socket_single": (["socket_single"], None),
    "socket_double": (["socket_double"], None),
    "socket_power_single": (["socket_power"], "power glyph; the designer's water-heater / appliance feeds are separate lines"),
    "socket_power_double": (["socket_power_double"], None),
    "socket_triple_box6": (["socket_triple", "socket_box_6"], "triple socket = 6-place box with three sockets"),
    "socket_power_triple_box6": ([], "power triple in a 6-place box (no class yet)"),
    "socket_popup": ([], "pop-up socket in the kitchen island (text / new symbol)"),
    "comms_point_aggregated": (
        [
            "tv_point",
            "data_point",
            "phone_point",
            "bezek_point",
            "speaker",
            "intercom",
            "camera",
            "alarm_detector",
            "siren",
            "keypad",
            "thermostat",
        ],
        (
            "ALL communication points together: TV / phone / data / intercom / speaker / camera / alarm detector / siren / "
            "keypad / AC thermostat (Sprint 11: remapped to the new classes)"
        ),
    ),
    "comms_d18": (["socket_box_6"], "D18 = 6 sockets + 3 conduits to the comms panel; distinct from the plain triple"),
    "addon_waterproof": (["waterproof_marker"], "every waterproof accessory: sockets AND switches with the IP marker"),
    "addon_usb": ([], "USB + Type-C marker on a socket (text 'USB' near the symbol)"),
    "feed_heater_bathroom": (["heater_feed"], None),
    "install_heater_bathroom": (["heater_feed"], "same count as the heater feeds (install line)"),
    "feed_solar_heater": (["water_heater_feed"], "roof: דוד שמש + gas heater, one combined feed"),
    "feed_shutter": (
        ["shutter_feed"],
        "one feed per electric shutter = the circled-M motor symbol (Sprint 11: class shutter_feed)",
    ),
    "feed_awning": ([], "awning motor feed, no switch (text)"),
    "feed_smoke_detector": (["smoke_detector"], None),
    "install_smoke_detector": (["smoke_detector"], "= feed_smoke_detector count"),
    "feed_doorbell": (["doorbell"], None),
    "install_doorbell": (["doorbell"], "= feed_doorbell count"),
    "feed_ventilator": (["ventilator_feed"], "ventilator (ונטה) feed symbol, circled V (Sprint 11: class ventilator_feed)"),
    "install_ventilator": (["ventilator_feed"], "= feed_ventilator count"),
    "feed_3phase_heat_pump": (["socket_3phase"], "3-phase, by appliance text 'היתרו'"),
    "feed_3phase_ac": (["socket_3phase"], "3-phase, by appliance text 'מזגן'"),
    "feed_3phase_ev": (["socket_3phase"], "3-phase, by appliance text 'רכב חשמלי'"),
    "feed_3phase_pool": (["socket_3phase"], "3-phase, by appliance text 'בריכה / חדר מכונות'"),
    "feed_3phase_induction": (["socket_3phase"], "3-phase, by appliance text 'אינדוקציה / כיריים'"),
    "feed_3phase_sauna": (["socket_3phase"], "3-phase, by appliance text 'סאונה'"),
    "feed_3phase_jacuzzi": (["socket_3phase"], "3-phase, by appliance text 'ג'קוזי'"),
    "conduit_cobra_d_len": (["conduit_cobra"], "by diameter (32/50 mm) and length bucket (עד N מטר)"),
    "conduit_free_20mm": ([], "20 mm conduit left free from the floor (text 'צינור … 20')"),
    "panel_main": (["panel"], "panel text 'ראשי'"),
    "panel_secondary": (["panel"], "panel text 'משני'"),
    "panel_comms": (["panel"], "panel text 'תקשורת'"),
    "meter_secondary": ([], "secondary meter in the basement panel (text)"),
    "deep_boxes_count": (
        ["switch_single", "switch_2way", "switch_cross", "switch_fan", "switch_shutter"],
        "= number of switch BOXES (a multi-gang position is one box)",
    ),
    "light_single_with_switch": ([], "link graph: single switch controlling one point"),
    "light_single_bare": ([], "Rubel wording: every lighting point = 1, chains priced separately as סט"),
    "light_no_switch": ([], "lighting point with no switch (אפס קבוע)"),
    "light_two_way_1pt": ([], "two-way pair controlling one point"),
    "light_cross_1pt": ([], "three switches (cross) controlling one point"),
    "light_timer_1pt": ([], "one point on a panel timer (note)"),
    "light_shared_2": ([], "one switch, two points"),
    "light_shared_3": ([], "one switch, three points"),
    "light_two_way_2pt": ([], "two-way pair, two points"),
    "light_two_way_3pt": ([], "two-way pair, three points"),
    "light_two_way_3pt_stair_auto": ([], "two-way pair + staircase automat, three points"),
    "light_cross_2pt": ([], "cross, two points"),
    "light_timer_n": ([], "N points on a panel timer (timer circuits listed in a note)"),
    "light_chain_set": ([], "סט: chain of N points on one switching circuit (N from the description)"),
    "install_luminaire": (
        ["luminaire_ceiling", "luminaire_wall", "luminaire_pendant", "luminaire_strip", "luminaire_outdoor"],
        "all luminaire positions minus ceiling fans, minus cross-sheet duplicates",
    ),
    "install_ceiling_fan": (["ceiling_fan"], None),
    "light_profile_length_unit": ([], "one profile per line, length in the description (Yahav)"),
    "plumb_basin": (["fixture_basin"], None),
    "plumb_kitchen_sink": (["fixture_kitchen_sink"], "indoor kitchen sinks"),
    "plumb_kitchen_sink_out": (["fixture_kitchen_sink"], "outdoor kitchen sink (cold only)"),
    "plumb_wc_concealed": (["fixture_wc_concealed"], None),
    "plumb_shower": (["fixture_shower"], "showers with 2 × 3-way interpuz + channel drain"),
    "plumb_shower_3way_x3": (["fixture_shower"], "master shower: 3 × 3-way interpuz"),
    "plumb_shower_4way": (["fixture_shower"], "4-way interpuz; drain box vs channel in the text"),
    "plumb_bath": (["fixture_bath"], None),
    "plumb_washing_machine": (["fixture_washing_machine"], None),
    "plumb_garden_tap": (["garden_tap"], "garden tap or Tami-4 (cold point)"),
    "plumb_ac_drain": (["ac_unit"], "AC drain marks on the plumbing sheets (9–10 per project)"),
    "plumb_manifold": ([], "water manifold (מרכזיה) main / secondary"),
    "waterproof_bathroom_room": ([], "one per wet bathroom (unit חדר)"),
    "opening_closure_count": ([], "closed window openings (count, Achituv 2.01)"),
    "gypsum_niche_count": ([], "niche in a gypsum partition"),
    "gypsum_access_panel": ([], "access panel 60/60 (אופן ארט / פתח שירות)"),
    "misc_pvc_vent_pipe": ([], '4" PVC for ventilators = ventilator count'),
}
COUNT_UNITS = {"יחידה", "סט", "חדר"}
# Kinds whose classes are a plain 1:1 count, so the by-eye sheet GT (gt/<p>/sheets, Sprint 11) gives a per-floor count.
PER_FLOOR_KINDS = {
    "socket_single",
    "socket_double",
    "socket_power_single",
    "socket_power_double",
    "socket_triple_box6",
    "comms_point_aggregated",
    "feed_heater_bathroom",
    "feed_shutter",
    "feed_smoke_detector",
    "install_smoke_detector",
    "feed_doorbell",
    "install_doorbell",
    "feed_ventilator",
    "install_ventilator",
}


def drawn_counts(project: str) -> tuple[dict[str, dict[str, int]], list[str]]:
    """{class: {floor: n}} of NEW symbols on the electrical sheets of the by-eye GT, and the sheets used."""
    counts: dict[str, dict[str, int]] = {}
    used: list[str] = []
    for path in sorted((GT / project / "sheets").glob("*.geojson")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        meta = doc["kamutan"]
        if meta.get("discipline") != "electrical" or meta.get("completeness") != "complete":
            continue
        used.append(str(meta["sheet_id"]))
        for feat in doc["features"]:
            props = feat["properties"]
            if props.get("lifecycle") == "existing" or props.get("kind") != "symbol":
                continue
            by_floor = counts.setdefault(str(props["class"]), {})
            by_floor[str(props["floor"])] = by_floor.get(str(props["floor"]), 0) + 1
    return counts, used


def main() -> int:
    for p in sys.argv[1:] or ["rubel", "achituv", "yahav"]:
        f = GT / p / "boq_truth.json"
        if not f.exists():
            print(f"{p}: no {f}")
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        out = []
        drawn, drawn_sheets = drawn_counts(p)
        for ln in d["lines"]:
            if ln["unit"] not in COUNT_UNITS:
                continue
            k, g, s = classify(ln["description"])
            classes, note = CLASSES.get(k, ([], None))
            per_floor: dict[str, int] | None = None
            if drawn_sheets and k in PER_FLOOR_KINDS and classes:
                per_floor = {}
                for cls in classes:
                    for floor, n in drawn.get(cls, {}).items():
                        per_floor[floor] = per_floor.get(floor, 0) + n
            out.append(
                {
                    "code": ln["code"],
                    "description": ln["description"],
                    "unit": ln["unit"],
                    "expected_total": ln["quantity"],
                    "kind": k,
                    "group": g,
                    "kamutan_support": s,
                    "classes": classes,
                    "derivation": note,
                    "per_floor": per_floor,
                    "drawn_total": sum(per_floor.values()) if per_floor is not None else None,
                    "per_floor_source": (
                        f"by-eye sheet GT eye-s11-v1, electrical sheets {', '.join(drawn_sheets)} (new symbols only)"
                        if per_floor is not None
                        else None
                    ),
                    "flags": [x for x in ln["flags"] if x == "zero_quantity" or x.startswith("duplicate_code")],
                }
            )
        doc = {
            "schema": "kamutan.expected-counts/1",
            "project_id": p,
            "source": (
                "boq_truth.json (designer BOQ totals). No designer per-floor source: the חשמל / אינסטלציה sheets are "
                "Noah's copies (designer_counts.json)."
            ),
            "note": (
                "expected_total is the project total the detection classes should sum to (after lifecycle filtering and "
                "cross-sheet de-dup). per_floor / drawn_total = the manual drawing count from the Sprint 11 by-eye sheet GT "
                "(null where the line is not a plain class count or the project has no complete electrical GT)."
            ),
            "lines": out,
        }
        (GT / p / "expected_counts.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        n_cls = sum(1 for x in out if x["classes"])
        print(f"{p}: {len(out)} countable lines, {n_cls} with a direct class mapping")
    return 0


if __name__ == "__main__":
    sys.exit(main())
