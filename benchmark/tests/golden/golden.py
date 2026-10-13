"""Golden tests for the ingest pipeline (07_test_plan §2 "Golden / Snapshot", ING-01/02/15).

Compares the ingest output of ONE sheet (the files the ingest CLI / worker writes for a sheet version)
with an expected JSON (schema: ``golden_expected.schema.json``) using tolerances, and reports every
check. Expected files for real drawings live OUTSIDE git (``$KAMUTAN_GOLDEN_DIR``, default
``/home/claude/kamutan-data/gt/noah/golden``); the repo holds only this runner, the schema, the generator
for the Noah expectations and a synthetic example.

Ingest output layout accepted for a sheet directory (first match wins):
  1. ``sheet.json`` (sheet doc) + ``version.json`` (version doc) — mirrors Firestore 1:1
  2. ``result.json`` / ``ingest.json`` with ``{"sheet": {...}, "version": {...}}``
  3. ``version.json`` alone (classification fields may sit inside it)

CLI:
  python golden.py check EXPECTED.json SHEET_OUTPUT_DIR [--json]
  python golden.py run --expected-dir DIR --outputs-root DIR [--report out.md] [--json out.json]
Exit codes: 0 all pass, 1 a check failed, 2 an expected sheet has no output (or bad input).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

SCHEMA_PATH = Path(__file__).with_name("golden_expected.schema.json")
DEFAULT_GOLDEN_DIR = Path("/home/claude/kamutan-data/gt/noah/golden")

# Canonical floor ids <- spellings seen in classifier output, contracts and manifests.
FLOOR_ALIASES: dict[str, set[str]] = {
    "basement": {"basement", "-1", "מרתף", "קומת מרתף"},
    "ground": {"ground", "0", "קרקע", "קומת קרקע"},
    "first": {"first", "1", "א'", "א", "קומה א'"},
    "second": {"second", "2", "ב'", "ב", "קומה ב'"},
    "roof": {"roof", "r", "גג"},
}
_FLOOR_INDEX = {alias.lower(): canon for canon, aliases in FLOOR_ALIASES.items() for alias in aliases}


def canon_floor(f: str) -> str:
    return _FLOOR_INDEX.get(str(f).strip().lower(), str(f).strip().lower())


def parse_scale_text(text: str | None) -> int | None:
    if not text:
        return None
    m = re.search(r"1\s*[:/]\s*(\d{1,5})", text)
    return int(m.group(1)) if m else None


# ------------------------------------------------------------------------------------------ loading
class OutputError(Exception):
    pass


def load_output(d: Path) -> dict[str, dict[str, Any]]:
    d = Path(d)
    if (d / "sheet.json").is_file() and (d / "version.json").is_file():
        return {"sheet": _read(d / "sheet.json"), "version": _read(d / "version.json")}
    for name in ("result.json", "ingest.json"):
        if (d / name).is_file():
            obj = _read(d / name)
            if not isinstance(obj.get("version"), dict):
                raise OutputError(f"{d / name}: missing 'version' object")
            return {"sheet": obj.get("sheet") or {}, "version": obj["version"]}
    if (d / "version.json").is_file():
        v = _read(d / "version.json")
        return {"sheet": v.get("sheet") if isinstance(v.get("sheet"), dict) else v, "version": v}
    raise OutputError(f"{d}: no sheet.json+version.json, result.json, ingest.json or version.json")


def _read(p: Path) -> dict[str, Any]:
    try:
        obj = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise OutputError(f"{p}: {e}") from e
    if not isinstance(obj, dict):
        raise OutputError(f"{p}: top level must be an object")
    return obj


def validate_expected(expected: dict[str, Any]) -> None:
    """jsonschema validation when available (kbench depends on it); structural minimum otherwise."""
    try:
        import jsonschema
    except ImportError:  # pragma: no cover
        if expected.get("schemaVersion") != 1 or "expect" not in expected:
            raise ValueError("expected file: schemaVersion 1 and 'expect' required") from None
        return
    jsonschema.validate(expected, json.loads(SCHEMA_PATH.read_text(encoding="utf-8")))


# ------------------------------------------------------------------------------------------ checks
@dataclass
class Check:
    name: str
    ok: bool
    expected: Any
    actual: Any
    detail: str = ""
    advisory: bool = False  # reported, never fails the sheet
    xfail: bool = False  # known/disputed: failure tolerated, a pass is flagged as XPASS

    @property
    def verdict(self) -> str:
        if self.ok:
            return "XPASS" if self.xfail else "PASS"
        if self.xfail:
            return "XFAIL"
        return "WARN" if self.advisory else "FAIL"

    @property
    def failing(self) -> bool:
        return not self.ok and not self.advisory and not self.xfail


@dataclass
class SheetReport:
    sheet: str
    checks: list[Check] = field(default_factory=list)
    error: str | None = None

    @property
    def passed(self) -> bool:
        return self.error is None and not any(c.failing for c in self.checks)

    def to_json(self) -> dict[str, Any]:
        return {
            "sheet": self.sheet,
            "passed": self.passed,
            "error": self.error,
            "checks": [{**asdict(c), "verdict": c.verdict} for c in self.checks],
        }


def _num_ok(actual: Any, value: float, abs_tol: float = 0.0, rel_tol: float = 0.0) -> bool:
    if not isinstance(actual, (int, float)) or isinstance(actual, bool) or not math.isfinite(actual):
        return False
    return abs(actual - value) <= max(abs_tol, rel_tol * abs(value))


def check_sheet(expected: dict[str, Any], output: dict[str, dict[str, Any]]) -> SheetReport:
    exp = expected["expect"]
    xfails = set(expected.get("xfail", []))
    sheet, version = output["sheet"], output["version"]
    cls = sheet.get("classification") or version.get("classification") or {}
    rep = SheetReport(sheet=expected["sheet"])

    def add(name: str, ok: bool, e: Any, a: Any, detail: str = "", advisory: bool = False) -> None:
        rep.checks.append(Check(name, bool(ok), e, a, detail, advisory, name in xfails))

    if "status" in exp:
        add("status", version.get("status") == exp["status"], exp["status"], version.get("status"))

    if "classification" in exp:
        ec = exp["classification"]
        if "discipline" in ec:
            want = {ec["discipline"].lower(), *(a.lower() for a in ec.get("disciplineAliases", []))}
            got = cls.get("discipline", sheet.get("discipline"))
            got_s = got.lower() if isinstance(got, str) else got
            add("classification.discipline", got_s in want, sorted(want), got)
        if "floors" in ec or "floorsAcceptAny" in ec:
            got_raw = cls.get("floors", sheet.get("floors"))
            got = sorted({canon_floor(f) for f in got_raw}) if isinstance(got_raw, list) else got_raw
            options = [sorted({canon_floor(f) for f in opt}) for opt in ec.get("floorsAcceptAny", [ec.get("floors", [])])]
            mode = ec.get("floorsMode", "exact")
            if mode == "subset" and isinstance(got, list):
                ok = any(set(got) <= set(o) and got for o in options)
            else:
                ok = got in options
            add("classification.floors", ok, options if len(options) > 1 else options[0], got, f"mode={mode}")
        if "minConfidence" in ec:
            conf = cls.get("confidence")
            add(
                "classification.confidence",
                isinstance(conf, (int, float)) and conf >= ec["minConfidence"],
                f">= {ec['minConfidence']}",
                conf,
                advisory=ec.get("confidenceAdvisory", False),
            )
        if "levels" in ec:
            add("classification.level", cls.get("level") in ec["levels"], ec["levels"], cls.get("level"))
        if "sheetTitleContains" in ec:
            title = cls.get("sheetTitle") or sheet.get("title") or ""
            missing = [t for t in ec["sheetTitleContains"] if t not in title]
            add(
                "classification.sheetTitle",
                not missing,
                ec["sheetTitleContains"],
                title,
                f"missing={missing}" if missing else "",
                advisory=ec.get("sheetTitleAdvisory", True),
            )

    if "scale" in exp:
        es = exp["scale"]
        got = sheet.get("scaleDenominator")
        if got is None:
            got = parse_scale_text(cls.get("scaleText"))
        want = es["denominator"]
        if want is None:
            add("scale.denominator", got is None, None, got)
        else:
            add("scale.denominator", _num_ok(got, want, abs_tol=es.get("tolerance", 0)), want, got)

    if "page" in exp:
        ep, page = exp["page"], version.get("page") or {}
        tol = ep.get("toleranceMm", 0.5)
        for k in ("widthMm", "heightMm"):
            if k in ep:
                add(f"page.{k}", _num_ok(page.get(k), ep[k], abs_tol=tol), ep[k], page.get(k), f"±{tol} mm")
        if "rotation" in ep:
            add("page.rotation", page.get("rotation") == ep["rotation"], ep["rotation"], page.get("rotation"))

    stats = version.get("stats") or {}
    for key, spec in (exp.get("stats") or {}).items():
        got = stats.get(key)
        add(
            f"stats.{key}",
            _num_ok(got, spec["value"], abs_tol=spec.get("absTol", 0), rel_tol=spec.get("relTol", 0)),
            spec["value"],
            got,
            f"relTol={spec.get('relTol', 0)} absTol={spec.get('absTol', 0)}",
            advisory=spec.get("advisory", False),
        )

    if "tiles" in exp:
        et = exp["tiles"]
        tiles = (version.get("artifacts") or {}).get("tiles") or version.get("tiles") or {}
        for k in ("format", "tileSize", "dpi"):
            if k in et:
                add(f"tiles.{k}", tiles.get(k) == et[k], et[k], tiles.get(k))
        if "minLevels" in et:
            lv = tiles.get("levels")
            add("tiles.levels", isinstance(lv, int) and lv >= et["minLevels"], f">= {et['minLevels']}", lv)
    return rep


# ------------------------------------------------------------------------------------------ discovery
def find_output_dir(outputs_root: Path, match: str) -> Path | None:
    """Sheet output dir under ``outputs_root`` whose path contains ``match`` and holds a result file."""
    hits: list[Path] = []
    for name in ("version.json", "result.json", "ingest.json"):
        for p in Path(outputs_root).rglob(name):
            if match in str(p.parent.relative_to(outputs_root)):
                hits.append(p.parent)
    if not hits:
        return None
    return min(set(hits), key=lambda p: (len(p.parts), str(p)))


def run_all(expected_dir: Path, outputs_root: Path) -> list[SheetReport]:
    reports = []
    for ep in sorted(Path(expected_dir).glob("*.json")):
        expected = json.loads(ep.read_text(encoding="utf-8"))
        validate_expected(expected)
        out_dir = find_output_dir(outputs_root, expected.get("match", expected["sheet"]))
        if out_dir is None:
            reports.append(
                SheetReport(
                    sheet=expected["sheet"], error=f"no ingest output under {outputs_root} matching {expected.get('match')!r}"
                )
            )
            continue
        try:
            reports.append(check_sheet(expected, load_output(out_dir)))
        except OutputError as e:
            reports.append(SheetReport(sheet=expected["sheet"], error=str(e)))
    return reports


def markdown(reports: list[SheetReport]) -> str:
    n_pass = sum(r.passed for r in reports)
    lines = [
        f"# Golden ingest report: {n_pass}/{len(reports)} sheets pass",
        "",
        "| sheet | result | failing / notable checks |",
        "| --- | --- | --- |",
    ]
    for r in reports:
        if r.error:
            lines.append(f"| {r.sheet} | ERROR | {r.error} |")
            continue
        notable = [f"{c.name}: {c.verdict} (want {c.expected}, got {c.actual})" for c in r.checks if c.verdict != "PASS"]
        lines.append(f"| {r.sheet} | {'PASS' if r.passed else 'FAIL'} | {'<br>'.join(notable) or '—'} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", help="compare one sheet output dir with one expected file")
    c.add_argument("expected", type=Path)
    c.add_argument("output_dir", type=Path)
    c.add_argument("--json", action="store_true")
    r = sub.add_parser("run", help="all expected files in a dir against an outputs root")
    r.add_argument("--expected-dir", type=Path, default=DEFAULT_GOLDEN_DIR)
    r.add_argument("--outputs-root", type=Path, required=True)
    r.add_argument("--report", type=Path)
    r.add_argument("--json", type=Path, dest="json_out")
    a = ap.parse_args(argv)

    if a.cmd == "check":
        expected = json.loads(a.expected.read_text(encoding="utf-8"))
        validate_expected(expected)
        try:
            rep = check_sheet(expected, load_output(a.output_dir))
        except OutputError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 2
        print(json.dumps(rep.to_json(), ensure_ascii=False, indent=2) if a.json else markdown([rep]))
        return 0 if rep.passed else 1

    reports = run_all(a.expected_dir, a.outputs_root)
    md = markdown(reports)
    print(md)
    if a.report:
        a.report.write_text(md, encoding="utf-8")
    if a.json_out:
        a.json_out.write_text(json.dumps([x.to_json() for x in reports], ensure_ascii=False, indent=2), encoding="utf-8")
    if any(x.error for x in reports):
        return 2
    return 0 if all(x.passed for x in reports) else 1


if __name__ == "__main__":
    sys.exit(main())
