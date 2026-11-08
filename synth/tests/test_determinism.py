"""Same seed -> byte-identical outputs (PDF, DXF, GT, BOQ, rasters)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from kamutan_synth.generate import Job, run_job


def _digest(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob("*")) if p.is_file()}


@pytest.mark.parametrize(("difficulty", "discipline"), [("hard", "electrical_lighting"), ("medium", "plumbing")])
def test_same_seed_same_bytes(tmp_path: Path, difficulty: str, discipline: str) -> None:
    a, b = tmp_path / "a", tmp_path / "b"
    for root in (a, b):
        row = run_job(Job(77, 3, difficulty, discipline, str(root), 1, True, True))
        row.pop("_timing")
    da, db = _digest(a), _digest(b)
    assert da == db
    assert any(k.endswith(".pdf") for k in da) and any(k.endswith(".dxf") for k in da)


def test_different_seed_differs(tmp_path: Path) -> None:
    rows = [run_job(Job(s, 0, "medium", "electrical", str(tmp_path / str(s)), 0, False, False)) for s in (1, 2)]
    assert rows[0]["sha256"] != rows[1]["sha256"]


def test_independent_of_hash_seed(tmp_path: Path) -> None:
    """Two fresh interpreters with different PYTHONHASHSEED (set / dict order of str) give the same bytes."""
    import os
    import subprocess  # nosec B404 - runs our own CLI
    import sys

    outs = []
    for hs in ("1", "2"):
        out = tmp_path / hs
        env = dict(os.environ, PYTHONHASHSEED=hs)
        cmd = [sys.executable, "-m", "kamutan_synth.cli", "generate", "--n", "3", "--seed", "8", "--out", str(out), "--jobs", "1"]
        subprocess.run(cmd, check=True, env=env, capture_output=True)  # nosec B603 - fixed argv
        files = {k: v for k, v in _digest(out).items() if k not in ("timings.json", "manifest.json")}
        man = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        man.pop("data_location")
        outs.append((files, man))
    assert outs[0] == outs[1]
