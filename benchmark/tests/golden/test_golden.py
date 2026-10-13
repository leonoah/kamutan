"""Golden-runner tests.

* Synthetic example (always runs): the runner itself — pass, tolerances, aliases, xfail, discovery, CLI.
* Real sheets (skips without data): every expected file in $KAMUTAN_GOLDEN_DIR (default
  /home/claude/kamutan-data/gt/noah/golden) against the ingest output tree in $KAMUTAN_INGEST_OUT.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path

import pytest
from golden import (
    DEFAULT_GOLDEN_DIR,
    OutputError,
    canon_floor,
    check_sheet,
    find_output_dir,
    load_output,
    main,
    run_all,
    validate_expected,
)

HERE = Path(__file__).parent
EXAMPLE_EXPECTED = HERE / "example" / "expected" / "sheet_synth01.json"
EXAMPLE_OUTPUTS = HERE / "example" / "output"


@pytest.fixture
def expected() -> dict:
    return json.loads(EXAMPLE_EXPECTED.read_text(encoding="utf-8"))


@pytest.fixture
def output() -> dict:
    return load_output(EXAMPLE_OUTPUTS / "set-synth01-p0")


def verdicts(rep) -> dict[str, str]:
    return {c.name: c.verdict for c in rep.checks}


def test_example_expected_matches_schema(expected: dict) -> None:
    validate_expected(expected)


def test_example_passes(expected: dict, output: dict) -> None:
    rep = check_sheet(expected, output)
    assert rep.passed, rep.to_json()
    assert set(verdicts(rep).values()) == {"PASS"}
    assert len(rep.checks) >= 14


def test_floor_aliases() -> None:
    assert canon_floor("0") == canon_floor("ground") == canon_floor("קרקע") == "ground"
    assert canon_floor("-1") == "basement"
    assert canon_floor("א'") == "first"
    assert canon_floor("mezzanine") == "mezzanine"


@pytest.mark.parametrize(
    ("mutate", "failing"),
    [
        (lambda s, v: s["classification"].update(discipline="plumbing"), "classification.discipline"),
        (lambda s, v: s["classification"].update(floors=["1"]), "classification.floors"),
        (lambda s, v: s.update(scaleDenominator=100), "scale.denominator"),
        (lambda s, v: v["page"].update(widthMm=430.0), "page.widthMm"),
        (lambda s, v: v["page"].update(rotation=90), "page.rotation"),
        (lambda s, v: v["stats"].update(paths=1100), "stats.paths"),
        (lambda s, v: v["stats"].pop("segments"), "stats.segments"),
        (lambda s, v: v.update(status="failed"), "status"),
        (lambda s, v: v["artifacts"]["tiles"].update(levels=1), "tiles.levels"),
        (lambda s, v: s["classification"].update(level="red"), "classification.level"),
    ],
)
def test_each_check_can_fail(expected: dict, output: dict, mutate, failing: str) -> None:
    out = copy.deepcopy(output)
    mutate(out["sheet"], out["version"])
    rep = check_sheet(expected, out)
    assert not rep.passed
    assert verdicts(rep)[failing] == "FAIL"


def test_tolerances_are_inclusive(expected: dict, output: dict) -> None:
    out = copy.deepcopy(output)
    out["version"]["stats"]["paths"] = 1020  # exactly 2 %
    out["version"]["page"]["widthMm"] = 420.5  # exactly 0.5 mm
    assert check_sheet(expected, out).passed


def test_advisory_checks_warn_but_do_not_fail(expected: dict, output: dict) -> None:
    out = copy.deepcopy(output)
    out["version"]["stats"]["textLines"] = 5
    out["sheet"]["classification"]["sheetTitle"] = "something else"
    out["sheet"]["title"] = "something else"
    rep = check_sheet(expected, out)
    assert rep.passed
    assert verdicts(rep)["stats.textLines"] == "WARN"
    assert verdicts(rep)["classification.sheetTitle"] == "WARN"


def test_xfail_and_xpass(expected: dict, output: dict) -> None:
    exp = copy.deepcopy(expected)
    exp["xfail"] = ["scale.denominator", "classification.discipline"]
    out = copy.deepcopy(output)
    out["sheet"]["scaleDenominator"] = 100
    rep = check_sheet(exp, out)
    assert rep.passed
    assert verdicts(rep)["scale.denominator"] == "XFAIL"
    assert verdicts(rep)["classification.discipline"] == "XPASS"


def test_floors_accept_any_and_subset(expected: dict, output: dict) -> None:
    exp = copy.deepcopy(expected)
    exp["expect"]["classification"].pop("floors")
    exp["expect"]["classification"]["floorsAcceptAny"] = [["basement", "ground"], ["ground"]]
    assert check_sheet(exp, output).passed
    exp["expect"]["classification"]["floorsAcceptAny"] = [["basement", "first"]]
    assert not check_sheet(exp, output).passed
    exp["expect"]["classification"]["floorsMode"] = "subset"
    exp["expect"]["classification"]["floorsAcceptAny"] = [["ground", "first"]]
    assert check_sheet(exp, output).passed


def test_scale_from_scale_text_when_denominator_missing(expected: dict, output: dict) -> None:
    out = copy.deepcopy(output)
    out["sheet"]["scaleDenominator"] = None
    assert check_sheet(expected, out).passed
    out["sheet"]["classification"]["scaleText"] = 'קנ"מ 1:100'
    assert not check_sheet(expected, out).passed


def test_nan_and_bool_stats_never_pass(expected: dict, output: dict) -> None:
    for bad in (float("nan"), True, "1000", None):
        out = copy.deepcopy(output)
        out["version"]["stats"]["paths"] = bad
        assert verdicts(check_sheet(expected, out))["stats.paths"] == "FAIL"


def test_output_layouts(tmp_path: Path, output: dict) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "result.json").write_text(json.dumps(output), encoding="utf-8")
    assert load_output(tmp_path / "a")["version"]["status"] == "ready"
    (tmp_path / "b").mkdir()
    (tmp_path / "b" / "version.json").write_text(
        json.dumps({**output["version"], "classification": output["sheet"]["classification"]})
    )
    assert load_output(tmp_path / "b")["sheet"]["classification"]["discipline"] == "electrical"
    (tmp_path / "c").mkdir()
    with pytest.raises(OutputError):
        load_output(tmp_path / "c")
    (tmp_path / "d").mkdir()
    (tmp_path / "d" / "result.json").write_text("[1, 2]")
    with pytest.raises(OutputError):
        load_output(tmp_path / "d")


def test_discovery_and_run_all(tmp_path: Path) -> None:
    assert find_output_dir(EXAMPLE_OUTPUTS, "synth01") == EXAMPLE_OUTPUTS / "set-synth01-p0"
    assert find_output_dir(EXAMPLE_OUTPUTS, "nope") is None
    reports = run_all(EXAMPLE_EXPECTED.parent, EXAMPLE_OUTPUTS)
    assert [r.passed for r in reports] == [True]
    reports = run_all(EXAMPLE_EXPECTED.parent, tmp_path)
    assert reports[0].error and not reports[0].passed


def test_cli(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["check", str(EXAMPLE_EXPECTED), str(EXAMPLE_OUTPUTS / "set-synth01-p0")]) == 0
    rep, js = tmp_path / "r.md", tmp_path / "r.json"
    assert (
        main(
            [
                "run",
                "--expected-dir",
                str(EXAMPLE_EXPECTED.parent),
                "--outputs-root",
                str(EXAMPLE_OUTPUTS),
                "--report",
                str(rep),
                "--json",
                str(js),
            ]
        )
        == 0
    )
    assert "1/1 sheets pass" in rep.read_text(encoding="utf-8")
    assert json.loads(js.read_text(encoding="utf-8"))[0]["passed"] is True
    assert main(["run", "--expected-dir", str(EXAMPLE_EXPECTED.parent), "--outputs-root", str(tmp_path)]) == 2
    capsys.readouterr()


# ------------------------------------------------------------------------------ real golden set (outside git)
GOLDEN_DIR = Path(os.environ.get("KAMUTAN_GOLDEN_DIR", str(DEFAULT_GOLDEN_DIR)))
INGEST_OUT = os.environ.get("KAMUTAN_INGEST_OUT")
_REAL = sorted(GOLDEN_DIR.glob("*.json")) if GOLDEN_DIR.is_dir() else []


@pytest.mark.parametrize("expected_path", _REAL, ids=[p.stem for p in _REAL])
def test_real_expected_files_are_valid(expected_path: Path) -> None:
    validate_expected(json.loads(expected_path.read_text(encoding="utf-8")))


@pytest.mark.skipif(
    not _REAL or not INGEST_OUT, reason="needs $KAMUTAN_GOLDEN_DIR expectations and $KAMUTAN_INGEST_OUT ingest output"
)
@pytest.mark.parametrize("expected_path", _REAL, ids=[p.stem for p in _REAL])
def test_real_sheet_golden(expected_path: Path) -> None:
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    out_dir = find_output_dir(Path(str(INGEST_OUT)), expected.get("match", expected["sheet"]))
    assert out_dir is not None, f"no ingest output for {expected['sheet']} under {INGEST_OUT}"
    rep = check_sheet(expected, load_output(out_dir))
    assert rep.passed, json.dumps(rep.to_json(), ensure_ascii=False, indent=1)
