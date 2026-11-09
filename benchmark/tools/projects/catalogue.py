#!/usr/bin/env python3
"""Sprint 10 Data/QA: the designer's line catalogue — every BOQ line gets a `kind` (what the line counts) and a
`group` (lighting topology, plumbing point, feed, add-on, area …), and each kind says whether Kamutan has any rule
kind / default rule / text-item pattern that could ever produce it (`support`).

    uv run python tools/projects/catalogue.py [project ...]   # prints the kind of every GT line + unclassified count

`support` values (hand-maintained against workers/drawing boq/rules.py, boq-defaults.json, textitems/catalog.py,
suggested.py, geometry.py, tiling.py, plumbing.py as of main 18a5eed, 09.11):
  rule      a rule kind + default rule exists for exactly this line type (class_to_item / composite_lighting /
            plumbing_point / tiling_* / waterproofing / area_item / length_item / text_item / template_chapter);
  partial   a rule kind exists but does not express the designer's parameter (e.g. two-way with 2 or 3 points,
            cobra by diameter + length, 3-phase by appliance, panels by kind, profile by length);
  suggested only a `suggested_item` / `one_off_suggestion` (default quantity, needs input) can produce it;
  none      nothing in Kamutan can produce this line type today (the catalogue gap).
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

DATA = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data"))
GT = DATA / "gt"

# (kind, group, support, regex) — first match wins; order matters.
KINDS: list[tuple[str, str, str, str]] = [
    # ---- chapter 01 / 02 lump sums and construction
    ("demolition_lump", "lump sums", "rule", r"^(פירוק|ביצוע כל עבודות הריסה|הריסת|פינוי)"),
    ("concrete_pool", "construction", "none", r"^יציקת בריכה|^יציקת בריכת נוי"),
    ("concrete_lump", "construction", "suggested", r"^יציקת (מרתף|חומות|משטחים|משקוף)|^ביצוע השלמות ריצפת בטון"),
    ("concrete_slab_area", "construction", "none", r"^יציקת משטחי בטון|^סגירת פתח חצר אנגלית"),
    ("block_wall_area", "construction", "rule", r"^בניית קיר בלוק"),
    ("opening_closure_count", "construction", "partial", r"^סגירת פתח(י)? (חלון|חלונות)"),
    # ---- chapter 03 plumbing by fixture point
    ("plumb_basin", "plumbing point", "rule", r"לכיור בחדר רחצה"),
    ("plumb_kitchen_sink_out", "plumbing point", "none", r"לכיור מטבח חוץ"),
    ("plumb_kitchen_sink", "plumbing point", "rule", r"לכיור מטבח"),
    ("plumb_wc_concealed", "plumbing point", "rule", r"מיכל הדחה סמוי|ניאגרה סמויה"),
    ("plumb_wc_monoblock", "plumbing point", "rule", r"מונובלוק"),
    ("plumb_shower_3way_x3", "plumbing point", "partial", r"למקלחון.*שלוש יח' אינטרפוץ"),
    ("plumb_shower_4way", "plumbing point", "partial", r"למקלחון.*אינטרפוץ 4 דרך"),
    ("plumb_shower", "plumbing point", "rule", r"למקלחון|^נק' מים חמים קרים וניקוז למקלח"),
    ("plumb_bath", "plumbing point", "rule", r"לאמבטיה"),
    ("plumb_washing_machine", "plumbing point", "rule", r"למכונת כביסה"),
    ("plumb_garden_tap", "plumbing point", "rule", r"ברז גן"),
    ("plumb_ac_drain", "plumbing point", "rule", r"^ניקוז למזגן"),
    ("plumb_irrigation", "plumbing feed", "none", r"השקיה"),
    ("plumb_roof_heater_feed", "plumbing feed", "suggested", r"הזנת מים בגג|הזנת מים חדשה עבור דוד"),
    ("plumb_heater_feed_other", "plumbing feed", "none", r"הזנת מים למ(ערכת|כשיר) חימום"),
    ("plumb_main_line", "plumbing feed", "suggested", r"קו הזנה ראשי"),
    ("plumb_manifold", "plumbing feed", "suggested", r"מרכזיית מים|מרכזיה"),
    ("plumb_pool_feed", "plumbing feed", "none", r"הזנת מים לבריכה|הזנה לבריכת נוי"),
    ("plumb_outdoor_shower", "plumbing feed", "none", r"טוש ריצפתית"),
    ("plumb_sump_pump", "plumbing feed", "suggested", r"בור משאבה|משאבה טבולה|בור שאיבה"),
    ("plumb_planter_drain", "plumbing feed", "none", r"ניקוז לאדנית"),
    ("plumb_fire_hose_point", "plumbing feed", "none", r"נק' מים למערכת גלגלון|גלגלון כיבוי אש קיים"),
    ("plumb_fire_hose_supply", "plumbing feed", "none", r"מערכת גלגלון כיבוי אש"),
    ("plumb_sauna", "plumbing feed", "none", r"לסאונה רטובה"),
    ("plumb_sewer_lump", "plumbing feed", "none", r"מערכת ביוב"),
    # ---- chapter 04 sockets / comms / add-ons
    ("socket_single", "sockets", "rule", r"^שקע בודד$"),
    ("socket_double", "sockets", "rule", r"^שקע כפול$"),
    ("socket_power_single", "sockets", "rule", r"^שקע כח בודד$"),
    ("socket_power_double", "sockets", "rule", r"^שקע כח כפול$"),
    ("socket_triple_box6", "sockets", "partial", r"^שקע משולש"),
    ("socket_power_triple_box6", "sockets", "none", r"^שקע כח משולש"),
    ("socket_popup", "sockets", "none", r"שקע קופץ"),
    ("comms_point_aggregated", "comms", "partial", r"^נק' תקשורת"),
    ("comms_d18", "comms", "partial", r"^אביזר D18"),
    ("addon_waterproof", "add-ons", "none", r"תוספת עבור אביזר מוגן מים"),
    ("addon_usb", "add-ons", "none", r"תוספת עבור שקע USB"),
    # ---- chapter 04 feeds
    ("feed_solar_heater", "feeds", "partial", r"^הזנה משולבת לדוד שמש"),
    ("feed_heater_bathroom", "feeds", "rule", r"^הזנה לתנור חימום"),
    ("install_heater_bathroom", "feeds", "none", r"^התקנת תנור חימום"),
    ("feed_shutter", "feeds", "none", r"^הזנה לתריס חשמלי"),
    ("feed_awning", "feeds", "none", r"^הזנה לסוכך"),
    ("feed_smoke_detector", "feeds", "none", r"^הזנה לגלאי עשן"),
    ("install_smoke_detector", "feeds", "none", r"גלאי עשן"),
    ("feed_doorbell", "feeds", "rule", r"^הזנה לפעמון"),
    ("install_doorbell", "feeds", "none", r"התקנת פעמון"),
    ("feed_ventilator", "feeds", "rule", r"הזנה לונטה"),
    ("install_ventilator", "feeds", "none", r"התקנת ונטה"),
    ("feed_3phase_heat_pump", "3-phase", "partial", r"תלת פאזי למכשיר חימום|תלת פאזי.*היתרו"),
    ("feed_3phase_ac", "3-phase", "partial", r"תלת פאזי למזגן"),
    ("feed_3phase_ev", "3-phase", "partial", r"תלת פאזי עבור שקע טעינה|רכב חשמלי"),
    ("feed_3phase_pool", "3-phase", "partial", r"תלת פאזי.*(בריכה|חדר מכונות)"),
    ("feed_3phase_induction", "3-phase", "partial", r"תלת פאזי לכיריים"),
    ("feed_3phase_sauna", "3-phase", "partial", r"תלת פאזי לסאונה"),
    ("feed_3phase_jacuzzi", "3-phase", "partial", r"תלת פאזי לג'קוזי"),
    ("conduit_cobra_d_len", "conduits", "partial", r"^צינור קוברה"),
    ("conduit_free_20mm", "conduits", "partial", r"^צינור מרי(כ|ח)ב? 20"),
    ("conduit_solar_prep", "conduits", "none", r"הכנה לפאנלים סולריים"),
    ("feed_main_from_pillar", "feeds", "none", r"הזנה חדשה מהפילר|מהפילר ועד לוח"),
    ("feed_fiber_main", "feeds", "none", r"סיב אופטי"),
    ("feed_to_shed", "feeds", "none", r"עד מחסן בגינה"),
    ("panel_main", "panels", "partial", r"לוח חשמל ראשי"),
    ("panel_secondary", "panels", "partial", r"לוח חשמל משני"),
    ("panel_comms", "panels", "partial", r"לוח תקשורת"),
    ("meter_secondary", "panels", "none", r"מונה משני"),
    ("deep_boxes_count", "switch boxes", "none", r"^קופסת עומק למפסקים"),
    ("smart_home_prep_lump", "switch boxes", "none", r"^הכנה לבית חכם"),
    # ---- chapter 04 lighting
    ("light_single_with_switch", "lighting topology", "rule", r"^נק' מאור בודדה כוללת מפסק$"),
    ("light_single_bare", "lighting topology", "partial", r"^נק' מאור בודדה$"),
    ("light_no_switch", "lighting topology", "partial", r"ללא מפסק \(אפס קבוע\)"),
    ("light_two_way_1pt", "lighting topology", "rule", r"^נק' מאור בודדה כוללת שני מפסקים מחליפים"),
    ("light_cross_1pt", "lighting topology", "partial", r"^נק' מאור בודדה כוללת שלושה מפסקים מצלבים"),
    ("light_timer_1pt", "lighting topology", "none", r"^נק' מאור בודדה כוללת מפסק טיימר"),
    ("light_shared_2", "lighting topology", "rule", r"^שתי נק' מאור כוללת מפסק בודד"),
    ("light_shared_3", "lighting topology", "rule", r"^שלוש נק' מאור כוללות מפסק בודד"),
    ("light_two_way_2pt", "lighting topology", "partial", r"^שתי נק' מאור כוללות שני מפסקים מחליפים"),
    ("light_two_way_3pt_stair_auto", "lighting topology", "none", r"מחליפים עם אוטומט חדר מדרגות"),
    ("light_two_way_3pt", "lighting topology", "partial", r"^שלוש נק' מאור כוללות שני מפסקים מחליפים"),
    ("light_cross_2pt", "lighting topology", "partial", r"^שתי נק' מאור כוללות שלושה מפסקים מצלבים"),
    ("light_timer_n", "lighting topology", "none", r"נק' מאור כוללות מפסק טיימר|הזנות נק' מאור לתאורות דוקרנים"),
    ("light_chain_set", "lighting topology", "none", r"^סט: שירשור"),
    ("install_luminaire", "lighting", "rule", r"^התקנת גוף תאורה פשוט|^התקנת גופי התאורה"),
    ("install_ceiling_fan", "lighting", "none", r"^התקנת מאוורר תקרה"),
    ("light_profile_length_unit", "lighting", "none", r"^התקנת פרופיל.*באורך \d+ ס\"מ"),
    ("light_profile_m", "lighting", "none", r"^התקנת פרופיל"),
    ("install_spike_light_nft", "lighting", "none", r"דוקרן"),
    ("electric_inspection_lump", "lump sums", "none", r"אחריות להעברת ביקורת"),
    # ---- chapter 05 tiling / waterproofing
    ("tile_outdoor_floor", "areas: tiling", "none", r"^פיתוח: ריצוף|^ריצוף חוץ|^ריצוף פודסט"),
    ("tile_parquet_substrate", "areas: tiling", "none", r"סוג ב'.*(פרקט|תשתית)|תשתית לפרקט|ריצוף סוג ב'"),
    ("tile_bathroom_floor", "areas: tiling", "rule", r"^(ריצוף )?ריצפות חדרי רחצה|חדר רחצה אורחים.*ריצוף"),
    ("tile_bathroom_walls", "areas: tiling", "rule", r"^חיפוי קירות חדר(י)? רחצה"),
    (
        "tile_interior_floor",
        "areas: tiling",
        "none",
        r"^פנים קרקע: ריצוף|^ריצפות חדרי ילדים|^ריצפת חדר כביסה|^ריצוף ריצפת חדר כביסה|^ריצפת מרפסת|^ריצוף מרפסת|^חצר אנגלית: ריצוף",
    ),
    ("tile_recessed_skirting_m", "areas: tiling", "none", r"פאנל שקוע"),
    ("tile_floating_stair_edge_m", "areas: tiling", "none", r"מדרגות מרחפות"),
    ("tile_stairs_count", "areas: tiling", "partial", r"^מדרגות פנים"),
    ("stone_cladding_outdoor", "areas: cladding", "none", r"חיפוי אבן|חיפוי קיר פטיו באבן"),
    ("waterproof_bathroom_room", "waterproofing", "partial", r"איטום לחדר רחצה רטוב"),
    ("waterproof_roof_sheets", "waterproofing", "none", r"איטום (מרפסת|פטיו) .*יריעות"),
    ("waterproof_lump", "waterproofing", "none", r"^ביצוע איטום ל(כל|אדניות)|^ביצוע איטום ריצפת"),
    ("coping_window_m", "sills", "none", r"סף שיש \(קופינג\)|קופינג"),
    # ---- chapter 06 gypsum
    ("gypsum_ceiling_area", "areas: gypsum", "rule", r"^בניית תקר(ות|ת) גבס"),
    ("gypsum_partition_double_lump", "areas: gypsum", "partial", r"^בניית מחיצות גבס דו כרומי"),
    ("gypsum_partition_wet_lump", "areas: gypsum", "none", r"^חדרים רטובים: כנל"),
    ("gypsum_partition_blue_area", "areas: gypsum", "partial", r"^בניית מחיצות גבס כחול"),
    ("gypsum_partition_white_area", "areas: gypsum", "partial", r"^בניית מחיצות גבס לבן"),
    ("gypsum_valance_m", "areas: gypsum", "partial", r"^בניית סינר גבס"),
    ("gypsum_niche_count", "areas: gypsum", "none", r"^בניית נישה"),
    ("gypsum_str_profile_m", "areas: gypsum", "none", r"פרופיל ניתוק STR"),
    ("gypsum_access_panel", "areas: gypsum", "rule", r"אופן ארט|פתח שירות"),
    # ---- chapter 07 plaster & paint
    ("plaster_repairs_lump", "lump sums", "suggested", r"^תיקוני טיח"),
    ("putty_lump", "lump sums", "suggested", r"^החלקת כלל"),
    ("paint_lump", "lump sums", "suggested", r"^צביעת כלל הבית"),
    ("mineral_plaster_lump", "lump sums", "none", r"^ביצוע טיח מינרלי"),
    ("colored_plaster_lump", "lump sums", "none", r"^ביצוע שליכט"),
    ("paint_shelter_door", "lump sums", "none", r"^צביעת משקוף"),
    # ---- chapter 08 misc
    ("misc_wood_reinforcement_lump", "misc", "none", r"חיזוקי עץ"),
    ("misc_bathroom_accessories_lump", "misc", "none", r"אביזרי חדרי רחצה"),
    ("misc_pool_drain_channel_m", "misc", "none", r"תעלת ניקוז סמויה"),
    ("misc_percolation_pit", "misc", "none", r"בור חילחול"),
    ("misc_polymer_panels_area", "misc", "none", r"לוחות פולימר"),
    ("misc_air_filter", "misc", "none", r"מערכת סינון אויר"),
    ("misc_project_management_lump", "misc", "none", r"ניהול הפרויקט"),
    ("misc_steel_works_lump", "misc", "none", r"עבודת מסגרות"),
    ("misc_pvc_vent_pipe", "misc", "rule", r"צינור PVC"),
]
_COMPILED = [(k, g, s, re.compile(rx)) for k, g, s, rx in KINDS]


def classify(desc: str) -> tuple[str, str, str]:
    """(kind, group, support) of a designer line description; ("unclassified", "unclassified", "none") when unknown."""
    d = " ".join(desc.replace("״", '"').split())
    for k, g, s, rx in _COMPILED:
        if rx.search(d):
            return k, g, s
    return "unclassified", "unclassified", "none"


def main() -> int:
    projects = sys.argv[1:] or ["rubel", "achituv", "yahav"]
    bad = 0
    for p in projects:
        f = GT / p / "boq_truth.json"
        if not f.exists():
            print(f"== {p}: no {f}")
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        print(f"== {p}")
        for ln in d["lines"]:
            k, _, s = classify(ln["description"])
            if k == "unclassified":
                bad += 1
            print(f"  {ln['code']:7} {ln['unit']:7} {ln['quantity']:6g}  {k:34} {s:9} {ln['description'][:60]}")
    print("unclassified:", bad)
    return 0


if __name__ == "__main__":
    sys.exit(main())
