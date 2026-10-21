"""Sprint 5 test helper: a permissive calibration table."""

from __future__ import annotations


class AllowAll:
    """Calibration table that lets every class be green (``full`` mode, no scoreMap): tests of the *heuristic*
    levels (detector, linker, floor rule) use it; the conservative cap itself is asserted separately."""

    def __new__(cls):  # build a real CalibrationTable whose green_allowed always says yes
        from dataclasses import dataclass

        from kamutan_drawing.calibration import CalibrationTable

        @dataclass(frozen=True)
        class AllowAllTable(CalibrationTable):
            def green_allowed(self, cls: str, green_threshold: float | None = None) -> tuple[bool, str | None]:
                return True, None

        return AllowAllTable(version="test-allow-all", mode="full", generated_at="", gt_version=None)
