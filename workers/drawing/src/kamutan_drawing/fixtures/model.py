"""Fixture detection record (Sprint 4). Paper millimetres, origin top-left, y down."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..types_sprint2 import BBox, Level, level_for

# plumbing classes of the Sprint-4 brief (benchmark/schema/classes.json; the last six are requested additions)
FIXTURE_CLASSES: tuple[str, ...] = (
    "fixture_wc_concealed",
    "fixture_wc_monoblock",
    "fixture_basin",
    "fixture_shower",
    "fixture_bath",
    "fixture_kitchen_sink",
    "fixture_washing_machine",
    "faucet_wall",
    "faucet_basin",
    "garden_tap",
    "ac_unit",
)
WC_CLASSES = frozenset({"fixture_wc_concealed", "fixture_wc_monoblock"})
SINK_CLASSES = frozenset({"fixture_basin", "fixture_kitchen_sink"})
FAUCET_CLASSES = frozenset({"faucet_wall", "faucet_basin"})
# fixtures that make a room a wet room (a washing machine alone does not: it often stands in a niche)
WET_CLASSES = frozenset({"fixture_wc_concealed", "fixture_wc_monoblock", "fixture_basin", "fixture_shower", "fixture_bath"})

# reasons (Hebrew UI chips)
R_TEXT_ONLY = "זוהה מכיתוב בלבד"
R_SHAPE_ONLY = "זוהה מצורה בלבד"
R_WC_TYPE_SHAPE = "סוג אסלה לפי צורה"
R_FAUCET_NEAREST = "ברז שויך לכלי הקרוב"
R_NO_LEADER = "קו הפניה לא נמצא"
R_LEADER_UNSURE = "קו הפניה לא ודאי"
R_NO_ROOM = "מחוץ לחדר"
R_SCALE = 'קנ"מ לא ודאי'
R_SHOWER_FROM_MIXER = "מקלחת לפי אינטרפוץ"
R_SHOWER_ZONE = "מקלחת במרכז תא המקלחת"
R_SHOWER_ZONE_MISSING = "תא מקלחת לא זוהה — לפי הכיתוב"
R_AC_FROM_SOCKET = "מזגן לפי שקע H=240"
R_SECONDARY_SHEET = "מופיע בכמה גיליונות"
R_ALIGN_FAILED = "יישור גיליונות נכשל — ייתכן כפל"


@dataclass
class FixtureDetection:
    """One fixture / faucet / AC position.

    ``source``: ``shape`` (drawn block), ``text`` (plumbing label only), ``shape+text`` (both agree).
    ``attached_to``: for faucets, the id of the basin / sink / shower they serve (via leader line or nearest).
    ``leader``: polyline (paper mm) of the leader line that tied the label to the fixture, if any.
    """

    id: str
    cls: str
    center: tuple[float, float]
    bbox: BBox
    angle: float = 0.0
    score: float = 0.0
    level: Level = "yellow"
    reasons: list[str] = field(default_factory=list)
    room_id: str | None = None
    floor: str | None = None
    source: str = "shape"
    annotations: list[str] = field(default_factory=list)
    attached_to: str | None = None
    label: str | None = None  # the plumbing label text that supports it
    leader: list[tuple[float, float]] = field(default_factory=list)
    sheet_id: str | None = None  # set by :func:`~.dedupe.dedupe_floor`
    duplicates: list[str] = field(default_factory=list)  # "sheetId/detectionId" of copies on other sheets

    def relevel(self) -> None:
        self.reasons = list(dict.fromkeys(self.reasons))[:16]
        self.level = level_for(self.score, self.reasons)

    def to_json(self, *, extended: bool = False) -> dict[str, Any]:
        """contracts ``Detection`` object (``lifecycle`` unknown, Worker-A's ``lifecycle.classify`` sets it).

        ``extended=True`` adds ``source``, ``attachedTo``, ``label``, ``leaderMm`` (not in the strict Sprint-2
        Detection schema — requested from the API agent as optional fields)."""
        d: dict[str, Any] = {
            "id": self.id,
            "class": self.cls,
            "legendEntryId": None,
            "centerMm": {"x": round(self.center[0], 2), "y": round(self.center[1], 2)},
            "bboxMm": self.bbox.to_json(),
            "angleDeg": round(((self.angle + 180.0) % 360.0) - 180.0, 1),
            "score": round(min(1.0, max(0.0, self.score)), 3),
            "level": self.level,
            "reasons": list(self.reasons)[:16],
            "roomId": self.room_id,
            "floor": self.floor,
            "lifecycle": "unknown",
            "supply": None,
            "annotations": [a[:32] for a in self.annotations][:16],
            "clusterId": None,
        }
        if extended:
            d["source"] = self.source
            d["attachedTo"] = self.attached_to
            d["label"] = self.label
            d["leaderMm"] = [{"x": round(x, 2), "y": round(y, 2)} for x, y in self.leader]
            if self.sheet_id is not None:
                d["sheetId"] = self.sheet_id
                d["duplicates"] = list(self.duplicates)
        return d
