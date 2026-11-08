from __future__ import annotations

import itertools
from functools import lru_cache

from kamutan_synth.sheet import SheetResult, compose
from kamutan_synth.spec import DIFFICULTIES, DISCIPLINES, make_spec

COMBOS = list(itertools.product(DIFFICULTIES, DISCIPLINES))


@lru_cache(maxsize=64)
def composed(seed: int, index: int, difficulty: str, discipline: str) -> SheetResult:
    return compose(make_spec(seed, index, difficulty, discipline))
