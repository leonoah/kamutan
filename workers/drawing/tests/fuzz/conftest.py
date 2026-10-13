"""Parser fuzzing (SEC-16/17, 06_security "Fuzzing לפענוח", 07_test_plan upload fuzzing).

Opt-in: these tests only run with ``KAMUTAN_FUZZ=1`` (they need Hypothesis, which is not a project
dependency, and they spawn hundreds of parser processes). Plain ``uv run pytest`` ignores the folder.

    # PR budget (~60 s of Hypothesis time + the fixed regression corpus)
    KAMUTAN_FUZZ=1 KAMUTAN_FUZZ_BUDGET_S=60 uv run --frozen --with hypothesis==6.168.5 pytest -m fuzz tests/fuzz -q
    # nightly
    KAMUTAN_FUZZ=1 KAMUTAN_FUZZ_BUDGET_S=3600 KAMUTAN_FUZZ_DB=.hypothesis-fuzz uv run --frozen --with hypothesis==6.168.5 pytest -m fuzz tests/fuzz

Env:
  KAMUTAN_FUZZ_BUDGET_S   total Hypothesis wall-clock budget, split across the three generative tests (default 60)
  KAMUTAN_FUZZ_TIMEOUT_S  per-parse sandbox wall timeout (default 20)
  KAMUTAN_FUZZ_DB         Hypothesis example database dir (persist/cache it in CI to replay past failures)
  KAMUTAN_FUZZ_SEED       fixed Hypothesis seed (reproduce a CI run)
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from dataclasses import dataclass, replace
from pathlib import Path

import pytest

ENABLED = os.environ.get("KAMUTAN_FUZZ", "") not in ("", "0", "false")

if not ENABLED:
    collect_ignore_glob = ["test_*.py"]


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "fuzz: parser fuzzing (opt-in via KAMUTAN_FUZZ=1; budget KAMUTAN_FUZZ_BUDGET_S)")


TOTAL_BUDGET_S = float(os.environ.get("KAMUTAN_FUZZ_BUDGET_S", "60"))
N_GENERATIVE = 3  # pdf, dxf, png
EST_CASE_S = 0.4  # rough cost of one sandboxed parse; only used to size max_examples


@dataclass
class Budget:
    seconds: float
    started: float = 0.0
    cases: int = 0

    def start(self) -> None:
        if not self.started:
            self.started = time.monotonic()

    @property
    def exhausted(self) -> bool:
        return bool(self.started) and time.monotonic() - self.started >= self.seconds

    @property
    def max_examples(self) -> int:
        return max(10, min(1_000_000, int(self.seconds / EST_CASE_S * 3)))


def per_test_budget() -> Budget:
    return Budget(TOTAL_BUDGET_S / N_GENERATIVE)


@pytest.fixture(scope="session")
def limits():
    from .target import FuzzLimits

    base = FuzzLimits()
    t = os.environ.get("KAMUTAN_FUZZ_TIMEOUT_S")
    return replace(base, timeout_s=float(t)) if t else base


@pytest.fixture(scope="session")
def fuzz_dir(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Path]:
    d = tmp_path_factory.mktemp("fuzz")
    yield d


@pytest.fixture(scope="session", autouse=True)
def _announce_target(request: pytest.FixtureRequest) -> None:
    from .target import TARGET_NAME

    tr = request.config.pluginmanager.get_plugin("terminalreporter")
    if tr is not None:
        tr.write_line(f"[fuzz] target: {TARGET_NAME}; budget {TOTAL_BUDGET_S:.0f}s")
