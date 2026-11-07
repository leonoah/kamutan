"""DEV ONLY: Noah with the LLM gateway **on vs off** (Sprint 8, Worker-LLM) — per BOQ line before / after, and
calls, tokens and USD per sheet and per project.

    cd workers/drawing
    export KAMUTAN_LLM_API_KEY=…            # required (secret; never printed, never written)
    uv run python scripts/llm_measure.py [--only 1bbe4113,c054fd3a] [--model claude-sonnet-5-5] [--budget-usd 30]
                                         [--out DIR] [--tag NAME] [--reuse-off]
    uv run python scripts/llm_measure.py --dry-run   # no key: a fake provider that answers nothing — counts the
                                                     # crops / calls that would be sent; no line changes, $ are fake

What it does (each mode into its own fresh artifacts root under ``--out/--tag``, default
``/home/claude/kamutan-data/llm-measure/<UTC time>``; the sample PDFs are never copied):

1. ``off``: ``scripts/ingest_local.py --force`` with ``KAMUTAN_LLM_PROVIDER=disabled`` (the product default), then
   ``scripts/boq_local.py --no-corrections`` with empty room settings (= ``gt/noah/tools/run_s6_eval.sh`` "nors");
2. ``on``: the same with ``KAMUTAN_LLM_PROVIDER=anthropic`` and the org ``org-demo`` set to ``llmEnabled: true``,
   ``llmMonthlyBudgetUsd: --budget-usd`` (cold LLM cache: a fresh root);
3. ``report.md`` + ``report.json`` next to the roots: every BOQ line (code, sample qty, off, on, Δ, level off → on,
   closer / further / same vs the sample), the LLM report of every sheet (``llm.json``: crops sent / read /
   applied, verify verdicts, calls, tokens in / out / cache write / cache read, USD, seconds, second pass) and the
   project totals (also the org's usage ledger ``orgs/org-demo/llm-cache/usage/YYYY-MM.json``).

Both runs need ``KAMUTAN_AV_SCAN=off`` (set here) and take ≈ 5–8 min each on the 2-vCPU box (the ``on`` run adds a
second sandbox pass on the sheets where a reading was usable). Prices: ``KAMUTAN_LLM_PRICE_IN_PER_MTOK`` /
``…_OUT_PER_MTOK`` (defaults 3 / 15 USD) and ``KAMUTAN_LLM_CACHE_WRITE_MULT`` / ``…_READ_MULT`` (1.25 / 0.1) —
set them to the contracted prices before reading the $ columns.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
WORKER = HERE.parent
DATA = Path("/home/claude/kamutan-data")
ORG, PROJECT = "org-demo", "p-noah"
KEY_ENV = "KAMUTAN_LLM_API_KEY"
CHAPTERS = [f"{i}." for i in range(1, 10)]
DEFAULT_MODEL = "claude-sonnet-5-5"

NO_KEY = f"""llm_measure: {KEY_ENV} is not set — nothing measured.

The measurement calls the real Anthropic API (the org's gateway on), so it needs the owner's key:

    cd workers/drawing
    export {KEY_ENV}=<key from the secret store>
    uv run python scripts/llm_measure.py                 # all 15 Noah sheets, ≈ 15 min, a few USD at most
    uv run python scripts/llm_measure.py --only 1bbe4113 # just the lighting sheet of the 4.10 note

Without a key, `--dry-run` counts the crops / calls that would be sent (fake provider, no line changes)."""


def _env(mode: str, root: Path, a: argparse.Namespace) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("KAMUTAN_LLM_") or k.startswith("KAMUTAN_LLM_PRICE")}
    for k in ("KAMUTAN_LLM_CACHE_WRITE_MULT", "KAMUTAN_LLM_CACHE_READ_MULT"):
        if k in os.environ:
            env[k] = os.environ[k]
    env.update(KAMUTAN_DEV_ARTIFACTS=str(root), KAMUTAN_AV_SCAN="off", PYTHONUNBUFFERED="1")
    env.setdefault("KAMUTAN_DATA_DIR", str(DATA / "sample-noah"))
    if mode == "off":
        env["KAMUTAN_LLM_PROVIDER"] = "disabled"
    elif a.dry_run:
        env.update(KAMUTAN_LLM_PROVIDER="fake", KAMUTAN_LLM_FAKE_REPLY="empty")
    else:
        env.update(KAMUTAN_LLM_PROVIDER="anthropic", KAMUTAN_LLM_API_KEY=os.environ[KEY_ENV], KAMUTAN_LLM_MODEL=a.model)
        if os.environ.get("KAMUTAN_LLM_BASE_URL"):
            env["KAMUTAN_LLM_BASE_URL"] = os.environ["KAMUTAN_LLM_BASE_URL"]
    return env


def _enable_org(root: Path, budget: float) -> None:
    from kamutan_drawing.stores.local import LocalDocStore

    docs = LocalDocStore(root)
    doc = docs.get(f"orgs/{ORG}") or {}
    settings = dict(doc.get("settings") or {})
    settings.update(llmEnabled=True, llmMonthlyBudgetUsd=budget)
    docs.set(f"orgs/{ORG}", {**doc, "settings": settings})


def _run(cmd: list[str], env: dict[str, str], log: Path, timeout: int) -> int:
    with log.open("w") as f:
        try:
            return subprocess.run(
                cmd, cwd=WORKER, env=env, stdout=f, stderr=subprocess.STDOUT, timeout=timeout, check=False
            ).returncode
        except subprocess.TimeoutExpired:
            return 124


def run_mode(mode: str, base: Path, a: argparse.Namespace) -> dict[str, Any]:
    root = base / mode / "artifacts"
    root.mkdir(parents=True, exist_ok=True)
    if mode == "on":
        _enable_org(root, a.budget_usd)
    env = _env(mode, root, a)
    py = sys.executable
    ingest = [py, "scripts/ingest_local.py", "--force", *(["--only", a.only] if a.only else [])]
    t0 = time.monotonic()
    print(f"[{mode}] ingest → {root}", flush=True)
    rc = _run(ingest, env, base / mode / "ingest.log", 3600)
    t_ingest = round(time.monotonic() - t0, 1)
    empty = base / mode / "empty_room_settings.json"
    empty.write_text("{}")
    boq_json = base / mode / "boq.json"
    boq = [py, "scripts/boq_local.py", "--root", str(root), "--no-corrections", "--room-settings", str(empty),
           "--build-id", f"llm-{mode}", "--json", str(boq_json), "--chapters", *CHAPTERS]  # fmt: skip
    print(f"[{mode}] ingest rc={rc} ({t_ingest} s); boq.build", flush=True)
    rc_b = _run(boq, {**env, "KAMUTAN_LLM_PROVIDER": "disabled"}, base / mode / "boq.log", 1200)
    rows = json.loads(boq_json.read_text()) if boq_json.exists() else []
    return {"root": str(root), "ingestRc": rc, "boqRc": rc_b, "ingestSeconds": t_ingest, "rows": rows}


def compare(off: list[dict[str, Any]], on: list[dict[str, Any]]) -> list[dict[str, Any]]:
    a = {r["code"]: r for r in off}
    b = {r["code"]: r for r in on}

    def err(r: dict[str, Any] | None) -> float | None:
        if not r or r.get("ours") is None or r.get("sample") is None:
            return None
        return abs(float(r["ours"]) - float(r["sample"]))

    out = []
    for code in sorted({*a, *b}, key=lambda c: [int(p) if p.isdigit() else p for p in c.split(".")]):
        ra, rb = a.get(code), b.get(code)
        ea, eb = err(ra), err(rb)
        verdict = "same"
        if ea is not None and eb is not None and abs(ea - eb) > 1e-9:
            verdict = "closer" if eb < ea else "further"
        elif (ra or {}).get("ours") != (rb or {}).get("ours"):
            verdict = "changed"
        out.append({
            "code": code,
            "description": str((ra or rb or {}).get("description") or "")[:60],
            "sample": (ra or rb or {}).get("sample"),
            "off": (ra or {}).get("ours"),
            "on": (rb or {}).get("ours"),
            "levelOff": (ra or {}).get("level"),
            "levelOn": (rb or {}).get("level"),
            "verdict": verdict,
        })  # fmt: skip
    return out


def llm_sheets(root: Path) -> list[dict[str, Any]]:
    rows = []
    for p in sorted((root / "orgs" / ORG / "projects" / PROJECT / "sheets").glob("*/versions/*/llm.json")):
        try:
            d = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        rows.append({"sheet": p.parts[-4], **{k: v for k, v in d.items() if k != "schema"}})
    return rows


def usage(root: Path) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for p in sorted((root / "orgs" / ORG / "llm-cache" / "usage").glob("*.json")):
        try:
            out[p.stem] = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
    return out


SUM_KEYS = ("calls", "tokens_in", "tokens_out", "cache_write_tokens", "cache_read_tokens", "cost_usd", "hard_text_sent",
            "hard_text_read", "hard_text_applied", "verify_sent", "verify_agree", "verify_other", "verify_unsure", "llm_capped",
            "seconds")  # fmt: skip


def report(base: Path, res: dict[str, Any], a: argparse.Namespace) -> str:
    lines = res["lines"]
    sheets = res["sheets"]
    tot = {k: round(sum(float(s.get(k) or 0) for s in sheets), 6) for k in SUM_KEYS}
    tot["sheets_second_pass"] = sum(1 for s in sheets if s.get("second_pass"))
    res["total"] = tot
    n = {v: sum(1 for ln in lines if ln["verdict"] == v) for v in ("closer", "further", "changed", "same")}
    exact = {m: sum(1 for ln in lines if ln[m] is not None and ln["sample"] is not None and abs(ln[m] - ln["sample"]) < 1e-6)
             for m in ("off", "on")}  # fmt: skip
    md = [
        f"# LLM gateway on vs off — Noah ({res['startedAt']})",
        "",
        (
            f"model `{res['model']}`{' — **DRY RUN** (fake provider, answers nothing; $ are not real)' if a.dry_run else ''}; "
            f"budget {a.budget_usd} USD; sheets: {a.only or 'all'}; roots `{base}`"
        ),
        (
            f"ingest off {res['off']['ingestSeconds']} s (rc {res['off']['ingestRc']}), on {res['on']['ingestSeconds']} s "
            f"(rc {res['on']['ingestRc']})"
        ),
        "",
        (
            f"**Lines**: {len(lines)}; exact vs sample off {exact['off']} → on {exact['on']}; closer {n['closer']}, further "
            f"{n['further']}, changed (no sample) {n['changed']}, same {n['same']}"
        ),
        "",
        "## Per line (changed lines first)",
        "| code | description | sample | off | on | level off → on | verdict |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for ln in sorted(lines, key=lambda r: r["verdict"] == "same"):
        md.append(f"| {ln['code']} | {ln['description']} | {ln['sample']} | {ln['off']} | {ln['on']} | {ln['levelOff']} → "
                  f"{ln['levelOn']} | {ln['verdict']} |")  # fmt: skip
    md += [
        "",
        "## Per sheet (LLM)",
        (
            "| sheet | status | calls | tok in | tok out | cache w | cache r | $ | hard text sent/read/applied | verify sent "
            "(agree/other/unsure) | capped | pass 2 | s |"
        ),
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for s in sheets:
        md.append(f"| {s['sheet']} | {s.get('status')} | {s.get('calls')} | {s.get('tokens_in')} | {s.get('tokens_out')} | "
                  f"{s.get('cache_write_tokens')} | {s.get('cache_read_tokens')} | {float(s.get('cost_usd') or 0):.4f} | "
                  f"{s.get('hard_text_sent')}/{s.get('hard_text_read')}/{s.get('hard_text_applied')} | {s.get('verify_sent')} "
                  f"({s.get('verify_agree')}/{s.get('verify_other')}/{s.get('verify_unsure')}) | {s.get('llm_capped')} | "
                  f"{'yes' if s.get('second_pass') else 'no'} | {s.get('seconds')} |")  # fmt: skip
    md += [
        "",
        "## Project",
        (
            f"calls {int(tot['calls'])}, tokens in {int(tot['tokens_in'])} / out {int(tot['tokens_out'])} / cache write "
            f"{int(tot['cache_write_tokens'])} / cache read {int(tot['cache_read_tokens'])}, **{tot['cost_usd']:.4f} USD**, "
            f"{len(sheets)} sheets with LLM work, {tot['sheets_second_pass']} with a second pass, LLM time {tot['seconds']} s"
        ),
        "",
        f"org usage ledger: `{json.dumps(res['usage'], sort_keys=True)}`",
    ]
    return "\n".join(md) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", default="", help="comma separated Noah file ids (default: all 15 sheets)")
    ap.add_argument("--model", default=os.environ.get("KAMUTAN_LLM_MODEL") or DEFAULT_MODEL)
    ap.add_argument("--budget-usd", type=float, default=30.0, help="org monthly budget for the 'on' run")
    ap.add_argument("--out", default=str(DATA / "llm-measure"))
    ap.add_argument("--tag", default=dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ"))
    ap.add_argument("--reuse-off", action="store_true", help="keep an existing 'off' run under the same --tag")
    ap.add_argument("--dry-run", action="store_true", help="no key needed: fake provider that answers nothing")
    a = ap.parse_args()
    if not a.dry_run and not os.environ.get(KEY_ENV, "").strip():
        print(NO_KEY, file=sys.stderr)
        return 2
    base = Path(a.out) / a.tag
    base.mkdir(parents=True, exist_ok=True)
    res: dict[str, Any] = {"startedAt": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"), "model": a.model,
                           "dryRun": a.dry_run, "only": a.only}  # fmt: skip
    off_json = base / "off" / "boq.json"
    if a.reuse_off and off_json.exists():
        res["off"] = {"root": str(base / "off" / "artifacts"), "ingestRc": 0, "boqRc": 0, "ingestSeconds": None,
                      "rows": json.loads(off_json.read_text())}  # fmt: skip
    else:
        res["off"] = run_mode("off", base, a)
    res["on"] = run_mode("on", base, a)
    on_root = Path(res["on"]["root"])
    res["lines"] = compare(res["off"].pop("rows"), res["on"].pop("rows"))
    res["sheets"] = llm_sheets(on_root)
    res["usage"] = usage(on_root)
    md = report(base, res, a)
    (base / "report.md").write_text(md)
    (base / "report.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(md)
    print(f"written: {base / 'report.md'} and report.json")
    return 0 if res["off"]["ingestRc"] == 0 and res["on"]["ingestRc"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
