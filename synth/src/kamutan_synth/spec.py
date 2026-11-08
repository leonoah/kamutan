"""Per-sheet knobs, sampled deterministically from (seed, index) and the difficulty."""

from __future__ import annotations

import hashlib
import random
from dataclasses import asdict, dataclass, field
from typing import Any

from .catalog import CLASSES, DISCIPLINE_DOMAINS
from .symbols import STYLES
from .text import FontSpec, available_ttf

DIFFICULTIES = ("easy", "medium", "hard")
DISCIPLINES = ("electrical", "lighting", "electrical_lighting", "plumbing")

SCHEMES: dict[str, dict[str, tuple[int, int, int]]] = {
    # layer colours: walls outline / wall fill / furniture / text / symbols per domain
    "mono": {
        "wall": (0, 0, 0),
        "wall_fill": (205, 205, 205),
        "furn": (150, 150, 150),
        "text": (0, 0, 0),
        "electrical": (0, 0, 0),
        "lighting": (0, 0, 0),
        "plumbing": (0, 0, 0),
        "dim": (0, 0, 0),
    },
    "noah": {
        "wall": (0, 0, 0),
        "wall_fill": (190, 190, 190),
        "furn": (160, 160, 160),
        "text": (0, 0, 0),
        "electrical": (0, 0, 0),
        "lighting": (0, 0, 0),
        "plumbing": (0, 0, 0),
        "dim": (0, 0, 0),
    },
    "red_walls": {
        "wall": (200, 0, 0),
        "wall_fill": (110, 110, 110),
        "furn": (140, 140, 140),
        "text": (0, 0, 0),
        "electrical": (200, 0, 200),
        "lighting": (200, 0, 200),
        "plumbing": (0, 70, 200),
        "dim": (0, 0, 190),
    },
    "colour": {
        "wall": (40, 40, 40),
        "wall_fill": (170, 170, 170),
        "furn": (150, 150, 150),
        "text": (20, 20, 20),
        "electrical": (210, 0, 0),
        "lighting": (0, 0, 210),
        "plumbing": (0, 110, 200),
        "dim": (0, 120, 0),
    },
}


def sheet_rng(seed: int, index: int, salt: str = "") -> random.Random:
    h = hashlib.sha256(f"kamutan-synth/{seed}/{index}/{salt}".encode()).digest()
    return random.Random(int.from_bytes(h[:8], "big"))


@dataclass
class SheetSpec:
    sheet_id: str
    seed: int
    index: int
    difficulty: str
    discipline: str
    building: str  # apartment | house
    floors: list[str]  # floors drawn on this sheet
    text_mode: str
    ttf_name: str
    ttf_path: str
    stroke_wf: float
    scheme: str
    styles: dict[str, str]  # fine class -> style id (one style per class per sheet)
    sym_u: float  # symbol size (paper mm)
    lw: float  # symbol pen width (mm)
    title_block: str  # bottom | right
    legend_cols: int
    legend_missing: list[str] = field(default_factory=list)  # classes drawn but not in the legend
    legend_extra: int = 0  # unused legend rows
    renovation: bool = False
    p_height_label: float = 0.3
    p_mult_text: float = 0.5  # 2X text vs dedicated double-socket glyph
    p_mirror: float = 0.0
    p_exploded: float = 0.0
    rot_jitter: float = 0.0  # degrees, centre symbols
    p_leader: float = 0.0
    furniture: bool = True
    dims: bool = True
    grid: bool = False
    clouds: int = 0
    notes: bool = True
    wall_style: str = "filled"  # filled | outline | hatched
    part_kind: str = "gypsum"
    ext_t: float = 0.25
    type_tags: bool = False
    density: float = 1.0
    touch_wall: bool = True
    rasters: list[dict[str, Any]] = field(default_factory=list)

    def font(self) -> FontSpec:
        return FontSpec(self.text_mode, self.ttf_name, self.ttf_path, self.stroke_wf)

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("ttf_path")
        return d


def _pick_raster(rng: random.Random, difficulty: str) -> dict[str, Any]:
    if difficulty == "easy":
        return {"dpi": rng.choice([200, 300]), "format": "png"}
    if difficulty == "medium":
        r: dict[str, Any] = {"dpi": rng.choice([100, 150, 200]), "format": "jpg", "jpeg_quality": rng.randint(55, 85)}
        if rng.random() < 0.3:
            r["skew_deg"] = round(rng.uniform(-1.5, 1.5), 2)
        if rng.random() < 0.2:
            r["noise"] = round(rng.uniform(3, 10), 1)
        return r
    r = {"dpi": rng.choice([30, 50, 72, 100, 150]), "format": rng.choice(["jpg", "png"]), "jpeg_quality": rng.randint(30, 70)}
    for key, p in (("mirrored", 0.25), ("dark", 0.25), ("blur", 0.3), ("screenshot", 0.3), ("crop", 0.25)):
        if rng.random() < p:
            r[key] = True
    if rng.random() < 0.5:
        r["skew_deg"] = round(rng.uniform(-4, 4), 2)
    if rng.random() < 0.4:
        r["noise"] = round(rng.uniform(5, 18), 1)
    return r


def make_spec(seed: int, index: int, difficulty: str, discipline: str, n_rasters: int = 1) -> SheetSpec:
    rng = sheet_rng(seed, index, "spec")
    ttfs = available_ttf()
    modes = {"easy": ["ttf"], "medium": ["ttf", "outline", "stroke"], "hard": ["stroke", "stroke", "outline", "ttf"]}[difficulty]
    mode = rng.choice(modes)
    if mode != "stroke" and not ttfs:
        mode = "stroke"
    ttf_name = rng.choice(sorted(ttfs)) if ttfs else ""
    building = "house" if rng.random() < 0.35 else "apartment"
    floors = ["ground", "first"] if building == "house" else [rng.choice(["ground", "first", "second", "third"])]
    if building == "house" and not (difficulty == "hard" or rng.random() < 0.3):
        floors = [rng.choice(floors)]
    domains = DISCIPLINE_DOMAINS[discipline]
    styles: dict[str, str] = {}
    for fine, info in sorted(CLASSES.items()):
        sts = STYLES[fine]
        if difficulty == "easy":
            styles[fine] = sts[0].sid
        else:
            styles[fine] = rng.choice(sts).sid
        del info
    drawn = sorted(f for f, c in CLASSES.items() if c.domain in domains)
    spec = SheetSpec(
        sheet_id=f"syn{seed}-{index:04d}",
        seed=seed,
        index=index,
        difficulty=difficulty,
        discipline=discipline,
        building=building,
        floors=floors,
        text_mode=mode,
        ttf_name=ttf_name,
        ttf_path=ttfs.get(ttf_name, ""),
        stroke_wf=round(rng.uniform(0.75, 1.0), 2),
        scheme={
            "easy": "mono",
            "medium": rng.choice(["mono", "noah", "colour"]),
            "hard": rng.choice(["noah", "colour", "red_walls"]),
        }[difficulty],
        styles=styles,
        sym_u={"easy": rng.uniform(4.2, 5.0), "medium": rng.uniform(3.4, 4.6), "hard": rng.uniform(2.8, 3.8)}[difficulty],
        lw={"easy": 0.3, "medium": rng.choice([0.25, 0.3, 0.35]), "hard": rng.choice([0.18, 0.25, 0.35, 0.5])}[difficulty],
        title_block=rng.choice(["bottom", "right"]),
        legend_cols=1 if difficulty == "easy" else rng.choice([1, 2]),
        renovation=difficulty != "easy" and rng.random() < (0.25 if difficulty == "medium" else 0.5),
        p_height_label={"easy": 0.0, "medium": 0.35, "hard": 0.6}[difficulty],
        p_mult_text={"easy": 0.0, "medium": 0.5, "hard": 0.7}[difficulty],
        p_mirror={"easy": 0.0, "medium": 0.15, "hard": 0.4}[difficulty],
        p_exploded={"easy": 0.0, "medium": 0.3, "hard": 0.6}[difficulty],
        rot_jitter={"easy": 0.0, "medium": 0.0, "hard": 30.0}[difficulty],
        p_leader={"easy": 0.0, "medium": 0.1, "hard": 0.35}[difficulty],
        furniture=difficulty != "easy" or rng.random() < 0.5,
        dims=difficulty != "easy" or rng.random() < 0.5,
        grid=difficulty == "hard" and rng.random() < 0.5,
        clouds={"easy": 0, "medium": rng.choice([0, 0, 1]), "hard": rng.choice([0, 1, 2])}[difficulty],
        notes=difficulty != "easy" or rng.random() < 0.5,
        wall_style={
            "easy": "filled",
            "medium": rng.choice(["filled", "outline"]),
            "hard": rng.choice(["filled", "hatched", "outline"]),
        }[difficulty],
        part_kind=rng.choice(["gypsum", "block"]),
        ext_t=rng.choice([0.2, 0.25, 0.3]),
        type_tags=discipline in ("lighting", "electrical_lighting") and difficulty != "easy" and rng.random() < 0.6,
        density={"easy": 0.6, "medium": 1.0, "hard": 1.3}[difficulty],
        touch_wall=difficulty == "hard" or rng.random() < 0.5,
    )
    if difficulty == "hard":
        k = rng.choice([0, 1, 1, 2])
        spec.legend_missing = sorted(rng.sample(drawn, k)) if k else []
        spec.legend_extra = rng.randint(0, 3)
    elif difficulty == "medium":
        spec.legend_extra = rng.randint(0, 2)
    spec.rasters = [_pick_raster(sheet_rng(seed, index, f"raster{i}"), difficulty) for i in range(n_rasters)]
    return spec
