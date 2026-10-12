import os
from pathlib import Path

import pytest

DATA_DIR = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data")) / "sample-noah"


@pytest.fixture(scope="session")
def sample_dir() -> Path:
    if not DATA_DIR.is_dir() or not list(DATA_DIR.glob("sheet_*.pdf")):
        pytest.skip("sample data not available (set KAMUTAN_DATA_DIR)")
    return DATA_DIR
