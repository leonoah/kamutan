"""contracts ``itemIdFor`` (pure, import-light: used by the importer, the price import and the BOQ lines snapshot)."""

from __future__ import annotations

import hashlib
import re

from .parse import norm


def item_id(code: str, description: str) -> str:
    """contracts ``itemIdFor`` (byte-identical; tested against the TS implementation's output)."""
    slug = re.sub(r"[^A-Za-z0-9_-]", "-", code.strip())
    h = hashlib.sha256(f"{code.strip()}\n{norm(description)}".encode()).hexdigest()[:16]
    return f"it_{slug}_{h}"
