"""DWG → DXF with the LibreDWG ``dwg2dxf`` CLI (decision #2: GPLv3 tool run as a separate
process inside the sandbox, never linked). The DXF is then ingested like any DXF.

The binary is looked up as ``$KAMUTAN_DWG2DXF`` or ``dwg2dxf`` on ``PATH``. Without it the
job fails with ``unsupported_kind`` (not retryable) and a bilingual message the UI can show. The worker image has an optional
build stage for it (``infra/docker/worker-drawing.Dockerfile``).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from .. import errors as E
from ..errors import IngestError

CONVERT_TIMEOUT_S = 120
DWG_UNSUPPORTED_MESSAGE = (
    "קבצי DWG עדיין אינם נתמכים — יש לייצא מ-AutoCAD ל-DXF או PDF ולהעלות שוב. "
    "(DWG is not supported on this worker: LibreDWG dwg2dxf is not installed; upload DXF or PDF.)"
)


def dwg2dxf_path() -> str | None:
    exe = os.environ.get("KAMUTAN_DWG2DXF") or "dwg2dxf"
    return shutil.which(exe)


def convert(dwg_path: str, out_path: str) -> str:
    exe = dwg2dxf_path()
    if exe is None:
        raise IngestError(E.UNSUPPORTED_KIND, DWG_UNSUPPORTED_MESSAGE)
    try:
        # fixed argv (our temp paths), no shell; runs under the sandbox's rlimits
        r = subprocess.run(  # nosemgrep
            [exe, "-y", "-o", out_path, dwg_path],
            capture_output=True,
            timeout=CONVERT_TIMEOUT_S,
            check=False,
            cwd=str(Path(out_path).parent),
        )
    except subprocess.TimeoutExpired:
        raise IngestError(E.PARSE_TIMEOUT, "DWG conversion timed out") from None
    if not Path(out_path).is_file() or Path(out_path).stat().st_size == 0:
        raise IngestError(E.FILE_UNREADABLE, f"DWG conversion failed (exit {r.returncode})")
    return out_path
