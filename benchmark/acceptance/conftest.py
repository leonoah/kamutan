"""Stage-10 pipeline acceptance tests (synthetic data only).

They drive the real worker pipeline (``kamutan_drawing``: sandbox, parsers, understanding, BOQ build), so they run in
the worker's environment:

    cd workers/drawing && uv run --frozen pytest ../../benchmark/acceptance -q

In the benchmark environment (CI ``uv run pytest`` collects ``tests/`` only) the module is skipped.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
