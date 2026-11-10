"""Sprint 10 (Perf): what the sandboxed task knows about its input, for the failure message.

A task records plain counts here (``note(paths=…, images=…)``) as soon as it has them; when the
child dies of ``MemoryError`` the error frame carries them, so the UI can say *"הגיליון כבד מדי"*
with the sheet's size instead of a bare limit. Counts only — never drawing content or file names.
"""

from __future__ import annotations

COUNTS: dict[str, int] = {}
STAGE: list[str] = [""]  # last progress stage reported by the task (``child.main`` keeps it current)
_ORDER = ("paths", "segments", "images", "textLines")


def reset() -> None:
    COUNTS.clear()


def note(**counts: int) -> None:
    for k, v in counts.items():
        COUNTS[k] = int(v)


def describe() -> str:
    """``"sheet: 116270 paths, 258817 segments, 363 images"`` or ``""`` when nothing was recorded."""
    parts = [f"{COUNTS[k]} {k}" for k in _ORDER if k in COUNTS]
    parts += [f"{v} {k}" for k, v in sorted(COUNTS.items()) if k not in _ORDER]
    return ("sheet: " + ", ".join(parts)) if parts else ""


def memory_limit_message(memory_mb: int) -> str:
    d = describe()
    return f"parser exceeded the memory limit ({memory_mb} MB" + (f"; {d})" if d else ")")


def cpu_limit_message(cpu_s: int) -> str:
    """``parser exceeded the CPU limit (120s; stage legend; sheet: …)`` — where the budget ran out."""
    extra = [f"stage {STAGE[0]}"] if STAGE[0] else []
    if d := describe():
        extra.append(d)
    return f"parser exceeded the CPU limit ({cpu_s}s" + ("; " + "; ".join(extra) if extra else "") + ")"
