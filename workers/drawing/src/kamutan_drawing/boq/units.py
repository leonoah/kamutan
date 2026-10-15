"""A counted unit of a BOQ line (plumbing / tiling / manual corrections → aggregate contributions)."""

from __future__ import annotations

from dataclasses import dataclass, field

from .dedup import Det
from .rules import Item, Rule
from .spaces import Room


@dataclass
class Unit:
    rule: Rule | None
    members: list[tuple[Det, str | None]]
    qty: float = 1.0
    reasons: list[str] = field(default_factory=list)  # rule-level reasons (warnings: cap at yellow)
    level: str = "green"  # extra level cap (min with the evidence levels)
    item: Item | None = None  # item chosen by the module (room-specific line); else the rule's resolution
    user_code: tuple[str, str] | None = None  # (itemCode, ruleId) chosen by a user (trusted code)
    unmatched: tuple[str, str] | None = None
    order_qty: float | None = None  # qty incl. waste (tiling)
    waste: float | None = None
    ev_qty: dict[str, float] = field(default_factory=dict)  # evidence key → contributed qty
    floor: str | None = None  # override (else the members' majority floor)
    ignore_member_levels: bool = False  # suggestions: the cue's level / reasons are not the line's


def room_det(room: Room) -> Det:
    """Evidence item for a room-derived quantity (tiling, room cues): ``detectionId`` = the room id."""
    return Det(
        room.sheet_id,
        room.version_id,
        room.id,
        "room",
        room.center[0],
        room.center[1],
        room.level,
        list(room.reasons),
        room.floor,
        "new",
        None,
        room.discipline,
        1.0,
        room=room.name,
        room_id=room.id,
    )
