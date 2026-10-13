import os
from pathlib import Path

import pytest

_ROOT = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data"))
# accept both the data root (…/kamutan-data) and the sample folder itself (…/kamutan-data/sample-noah)
DATA_DIR = _ROOT if list(_ROOT.glob("sheet_*.pdf")) else _ROOT / "sample-noah"


@pytest.fixture(scope="session")
def sample_dir() -> Path:
    if not DATA_DIR.is_dir() or not list(DATA_DIR.glob("sheet_*.pdf")):
        pytest.skip("sample data not available (set KAMUTAN_DATA_DIR)")
    return DATA_DIR
