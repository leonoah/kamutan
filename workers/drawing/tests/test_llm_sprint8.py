"""Sprint 8 (Worker-LLM): batch purposes read_hard_text / verify_symbol, batching ≤ 10 crops, prompt caching, cost
accounting per org and call, sticky monthly budget, title-block refusal, verify never green, the two-pass hooks.
Fake provider only (no network, no key)."""

from __future__ import annotations

import gzip
import io
import json
import logging
import re
from pathlib import Path

import httpx
import pytest
from PIL import Image, ImageDraw

from kamutan_drawing.calibration import parse_table, set_default_table
from kamutan_drawing.llm_gateway import (
    MAX_BATCH,
    BatchItem,
    FakeProvider,
    LlmGateway,
    PrefixImage,
    from_env,
    hooks,
)
from kamutan_drawing.llm_gateway import hard_text as ht
from kamutan_drawing.llm_gateway.prompts import HARD_TEXT_ITEM_SCHEMA, verify_item_schema
from kamutan_drawing.ocr.dictionary import TextSpan
from kamutan_drawing.stores.memory import InMemoryBlobStore

SECRET = "מפסק-סודי-QWERTY"  # drawing text: must never reach a log line


def png(seed: int = 0, size=(48, 24)) -> bytes:
    im = Image.new("RGB", size, (255, 255, 255))
    ImageDraw.Draw(im).text((2, 2), str(seed), fill=(0, 0, 0))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


class Settings:
    def __init__(self, **orgs):
        self.orgs = orgs

    def __call__(self, org_id):
        return self.orgs.get(org_id)


def data_of(user: str) -> dict:
    m = re.search(r"<data>(.*)</data>", user, re.DOTALL)
    assert m
    return json.loads(m.group(1).replace("<\\/data>", "</data>"))


def hard_text_responder(text: str = SECRET, conf: float = 0.9):
    def r(system, user, images):
        if "Each item image is a crop of a short piece of text" not in system:
            return json.dumps({"label": "x"})
        return json.dumps({"items": [{"id": it["id"], "text": text, "confidence": conf} for it in data_of(user)["items"]]})

    return r


def make(responder=None, replies=None, budget=5.0, orgs=None, **kw):
    fake = FakeProvider(replies=list(replies or []), responder=responder, **kw)
    blobs = InMemoryBlobStore()
    s = Settings(**(orgs or {"o1": {"llmEnabled": True, "llmMonthlyBudgetUsd": budget}}))
    return LlmGateway(provider=fake, org_settings_reader=s, blobs=blobs, max_tokens=512), fake, blobs


def items(n: int, kind: str = "text_region") -> list[BatchItem]:
    return [BatchItem(f"n_{i:020x}", png(i), kind, {"kind": "note", "currentReading": "נ | ה"}) for i in range(n)]


# ------------------------------------------------------------------ on / off per org


def test_batch_is_off_per_org_and_globally():
    g, fake, _ = make(hard_text_responder(), orgs={"on": {"llmEnabled": True}, "off": {"llmEnabled": False}, "unset": {}})
    for org in ("off", "unset", "missing"):
        r = g.call_batch(org, "read_hard_text", items(3), HARD_TEXT_ITEM_SCHEMA)
        assert r.status == "disabled" and r.results == {} and r.reason == "org_disabled"
        assert not g.enabled_for(org) and hooks.prepare(g, org, None) is None
    assert fake.calls == []
    assert g.enabled_for("on") and hooks.prepare(g, "on", {"x": 1, "y": 2, "w": 3, "h": 4}) == {
        "collect": True,
        "titleBlockMm": {"x": 1, "y": 2, "w": 3, "h": 4},
    }
    assert g.call_batch("on", "read_hard_text", items(3), HARD_TEXT_ITEM_SCHEMA).status == "ok"
    off = from_env(Settings(on={"llmEnabled": True}), env={})  # no provider configured (the default today)
    assert off.call_batch("on", "read_hard_text", items(1), HARD_TEXT_ITEM_SCHEMA).status == "disabled"
    assert hooks.prepare(off, "on", None) is None


def test_org_switch_is_rechecked_before_every_chunk():
    settings = {"o1": {"llmEnabled": True}}
    fake = FakeProvider()

    def responder(system, user, images):
        settings["o1"]["llmEnabled"] = False  # an admin switches it off during the job
        return hard_text_responder()(system, user, images)

    fake.responder = responder
    g = LlmGateway(provider=fake, org_settings_reader=lambda o: settings.get(o), blobs=InMemoryBlobStore())
    r = g.call_batch("o1", "read_hard_text", items(25), HARD_TEXT_ITEM_SCHEMA)
    assert r.status == "disabled" and len(fake.calls) == 1 and len(r.results) == MAX_BATCH


# ------------------------------------------------------------------ batching + per-item cache


def test_batches_of_at_most_ten_crops_with_shared_cached_prefix():
    g, fake, _ = make(hard_text_responder())
    prefix = [PrefixImage("L1", png(900), "legend_row", {"label": "מפסק"}), PrefixImage("L2", png(901), "legend_row")]
    r = g.call_batch("o1", "read_hard_text", items(23), HARD_TEXT_ITEM_SCHEMA, prefix=prefix)
    assert r.status == "ok" and len(r.results) == 23 and r.calls == 3
    assert [len(c["images"]) - 2 for c in fake.calls] == [10, 10, 3]
    assert all(c["cache"] and c["cache_prefix"] == 2 for c in fake.calls)
    # the shared prefix is identical in every chunk → cache write once, reads after (fake provider simulates)
    assert r.cache_write_tokens == fake.cache_prefix_tokens and r.cache_read_tokens == 2 * fake.cache_prefix_tokens
    assert all(set(v) == {"text", "confidence"} for v in r.results.values())  # the id is stripped
    # a re-run sends nothing: every item hits its own cache entry
    r2 = g.call_batch("o1", "read_hard_text", items(23), HARD_TEXT_ITEM_SCHEMA, prefix=prefix)
    assert r2.status == "ok" and r2.calls == 0 and r2.cached_items == 23 and len(fake.calls) == 3
    # one new crop → one call with one crop
    r3 = g.call_batch("o1", "read_hard_text", [*items(23), *items(24)[23:]], HARD_TEXT_ITEM_SCHEMA, prefix=prefix)
    assert r3.calls == 1 and len(fake.calls[-1]["images"]) == 3


def test_answers_must_name_the_chunk_ids_and_missing_answers_are_fine():
    its = items(3)
    good = json.dumps({"items": [{"id": its[0].id, "text": "H=65", "confidence": 0.9}]})
    g, _f, _ = make(replies=[good])
    r = g.call_batch("o1", "read_hard_text", its, HARD_TEXT_ITEM_SCHEMA)
    assert r.status == "ok" and list(r.results) == [its[0].id]
    bad_id = json.dumps({"items": [{"id": "n_" + "f" * 20, "text": "x", "confidence": 0.5}]})
    g, _fake, _ = make(replies=[bad_id, bad_id])
    assert g.call_batch("o1", "read_hard_text", its, HARD_TEXT_ITEM_SCHEMA).status == "error"


def test_refuses_bad_batches_before_anything_leaves():
    g, fake, _ = make(hard_text_responder())
    assert g.call_batch("o1", "legend_label", items(1), HARD_TEXT_ITEM_SCHEMA).reason == "purpose_not_allowed"
    assert g.call_batch("o1", "read_hard_text", [], HARD_TEXT_ITEM_SCHEMA).status == "refused"
    dup = [items(1)[0], items(1)[0]]
    assert g.call_batch("o1", "read_hard_text", dup, HARD_TEXT_ITEM_SCHEMA).status == "refused"
    bad = [BatchItem("../x", png(), "text_region")]
    assert g.call_batch("o1", "read_hard_text", bad, HARD_TEXT_ITEM_SCHEMA).status == "refused"
    junk = [BatchItem("n_" + "0" * 20, b"not an image", "text_region")]
    assert g.call_batch("o1", "read_hard_text", junk, HARD_TEXT_ITEM_SCHEMA).reason == "image_rejected"
    assert fake.calls == []


# ------------------------------------------------------------------ title block


@pytest.mark.parametrize("kind", ["title_block", "TitleBlock", "page", None])
def test_title_block_anywhere_in_a_batch_refuses_it(kind):
    g, fake, _ = make(hard_text_responder())
    its = [*items(2), BatchItem("n_" + "e" * 20, png(), kind)]  # type: ignore[arg-type]
    r = g.call_batch("o1", "read_hard_text", its, HARD_TEXT_ITEM_SCHEMA)
    assert r.status == "refused" and fake.calls == []
    r = g.call_batch(
        "o1", "verify_symbol", items(1, "symbol"), verify_item_schema(["a"]), prefix=[PrefixImage("L1", png(), kind)]
    )  # type: ignore[arg-type]
    assert r.status == "refused" and fake.calls == []


def test_title_block_crops_are_never_candidates_nor_sent(tmp_path):
    tb = (200.0, 200.0, 300.0, 300.0)
    sess = ht.Session(collect=True, title_block=tb)
    spans = [
        TextSpan("", (250, 250, 260, 252), "נ | ה ט", 0.79, 2, 0, 6),
        TextSpan("", (50, 50, 60, 52), "נ | ה ט", 0.79, 2, 0, 6),
    ]
    dets = [{"id": "d_0", "class": "switch_single", "bboxMm": {"x": 255, "y": 255, "w": 5, "h": 5}, "level": "yellow"},
            {"id": "d_1", "class": "switch_single", "bboxMm": {"x": 55, "y": 55, "w": 5, "h": 5}, "level": "yellow"}]  # fmt: skip
    ht.collect(sess, sheet_id="s", spans=spans, detections=dets, legend_entries=[], legend_ids=set(),
               render_many=lambda reqs: [Image.new("L", (r[3], r[4]), 255) for r in reqs])  # fmt: skip
    assert len(sess.candidates) == 1 and sess.candidates[0].bbox[0] < 100
    sess.mark((210, 210, 220, 220), Image.new("L", (20, 20), 0))
    assert all(c.kind != "mark" for c in sess.candidates)
    # the orchestrator re-checks: a manifest item in its title block is dropped (whatever the sandbox says)
    (tmp_path / "llm").mkdir()
    for i, box in enumerate(([250, 250, 260, 252], [50, 50, 60, 52])):
        (tmp_path / "llm" / f"n_{i:020x}.png").write_bytes(png(i))
    man = {"items": [{"id": f"n_{i:020x}", "kind": "note", "bboxMm": b, "file": f"llm/n_{i:020x}.png", "current": "x"}
                     for i, b in enumerate(([250, 250, 260, 252], [50, 50, 60, 52]))]}  # fmt: skip
    g, fake, _ = make(hard_text_responder(conf=0.1))
    _, rep = hooks.after_understand(
        g, "o1", {"llmRequests": man, "outDir": "x"}, llm_args={"collect": True, "titleBlockMm": {"x": 200, "y": 200, "w": 100, "h": 100}},
        read_file=lambda rel: (tmp_path / rel).read_bytes(), rerun=lambda a: None, out_path=lambda r: tmp_path,
    )  # fmt: skip
    assert rep.hard_text_sent == 1 and len(fake.calls) == 1 and len(fake.calls[0]["images"]) == 1


# ------------------------------------------------------------------ schema repair


def test_batch_schema_repair_once_then_error_and_not_cached():
    its = items(2)
    good = json.dumps({"items": [{"id": i.id, "text": "2X", "confidence": 0.8} for i in its]})
    g, fake, _ = make(replies=["not json at all", good])
    r = g.call_batch("o1", "read_hard_text", its, HARD_TEXT_ITEM_SCHEMA)
    assert r.status == "ok" and r.calls == 2 and len(r.results) == 2
    assert "previous answer was not valid" in fake.calls[1]["user_text"]
    bad = json.dumps({"items": [{"id": its[0].id, "text": "2X", "confidence": 7}]})
    g, fake, _ = make(replies=[bad, bad, good])
    r = g.call_batch("o1", "read_hard_text", its, HARD_TEXT_ITEM_SCHEMA)
    assert r.status == "error" and r.reason == "schema_invalid" and len(fake.calls) == 2 and r.results == {}
    assert g.call_batch("o1", "read_hard_text", its, HARD_TEXT_ITEM_SCHEMA).status == "ok"  # not cached: asks again


# ------------------------------------------------------------------ cost accounting + budget


def test_cost_per_call_and_per_org_purpose_ledger():
    g, fake, _blobs = make(hard_text_responder(), tokens_in=1000, tokens_out=100)
    r = g.call_batch("o1", "read_hard_text", items(12), HARD_TEXT_ITEM_SCHEMA, prefix=[PrefixImage("L1", png(7), "legend_row")])
    p = fake.pricing
    expect = 2 * (1000 * 3e-6 + 100 * 15e-6) + (2000 * 1.25 + 2000 * 0.1) * 3e-6
    assert r.cost_usd == pytest.approx(expect) and p.cost(1000, 100) == pytest.approx(1000 * 3e-6 + 100 * 15e-6)
    u = g.usage("o1")
    assert u["calls"] == 2 and u["costUsd"] == pytest.approx(expect, abs=1e-6)
    assert u["tokensIn"] == 2000 and u["tokensOut"] == 200 and u["cacheWriteTokens"] == 2000 and u["cacheReadTokens"] == 2000
    assert u["byPurpose"]["read_hard_text"]["calls"] == 2 and "verify_symbol" not in u["byPurpose"]
    assert g.usage("o2") == {}  # per org
    one = g.call("o1", "legend_label", [png()], {}, {"type": "object"}, region_kind="legend")  # fake replies {"items": …}
    assert one.status == "ok" and one.tokens_in == 1000 and one.tokens_out == 100 and one.cost_usd > 0
    assert g.usage("o1")["byPurpose"]["legend_label"]["calls"] == 1


def test_budget_exhaustion_turns_the_gateway_off_for_the_org_until_raised():
    # worst case of a 10-crop chunk ≈ 0.14 USD (estimate incl. one repair), actual cost 0.0195 → 2 chunks fit 0.17
    settings = {"o1": {"llmEnabled": True, "llmMonthlyBudgetUsd": 0.17}, "o2": {"llmEnabled": True}}
    fake = FakeProvider(responder=hard_text_responder(), tokens_in=4000, tokens_out=500)
    g = LlmGateway(provider=fake, org_settings_reader=lambda o: settings.get(o), blobs=InMemoryBlobStore(), max_tokens=256)
    r = g.call_batch("o1", "read_hard_text", items(40), HARD_TEXT_ITEM_SCHEMA)
    assert r.status == "budget_exceeded" and 0 < r.calls < 4 and len(r.results) == 10 * r.calls
    assert not g.enabled_for("o1") and hooks.prepare(g, "o1", None) is None
    n = len(fake.calls)
    # sticky: even a tiny call is refused now, without estimating
    tiny = g.call("o1", "legend_label", [png()], {}, {"type": "object"}, region_kind="legend")
    assert tiny.status == "budget_exceeded" and tiny.reason == "monthly_budget_exhausted" and len(fake.calls) == n
    assert g.call_batch("o1", "read_hard_text", items(1), HARD_TEXT_ITEM_SCHEMA).reason == "monthly_budget_exhausted"
    assert g.enabled_for("o2")  # other orgs are untouched
    settings["o1"]["llmMonthlyBudgetUsd"] = 5.0  # an admin raises the budget → on again
    assert g.enabled_for("o1") and g.call_batch("o1", "read_hard_text", items(1), HARD_TEXT_ITEM_SCHEMA).status == "ok"


def test_budget_hit_leaves_items_as_they_are(tmp_path):
    g, fake, _ = make(hard_text_responder(), budget=0.0)
    det = {"id": "d_0", "class": "switch_single", "bboxMm": {"x": 55, "y": 55, "w": 5, "h": 5}, "level": "yellow", "reasons": ["x"],
           "score": 0.7, "scoreRaw": 0.7}  # fmt: skip
    (tmp_path / "detections.json.gz").write_bytes(gzip.compress(json.dumps({"detections": [det]}).encode()))
    (tmp_path / "llm").mkdir()
    (tmp_path / "llm" / f"n_{0:020x}.png").write_bytes(png())
    man = {"items": [{"id": f"n_{0:020x}", "kind": "note", "bboxMm": [50, 50, 60, 52], "file": f"llm/n_{0:020x}.png"}]}
    called = []
    _res, rep = hooks.after_understand(g, "o1", {"llmRequests": man, "outDir": "x"}, llm_args={"collect": True},
                                      read_file=lambda rel: (tmp_path / rel).read_bytes(), rerun=lambda a: called.append(a),
                                      out_path=lambda r: tmp_path)  # fmt: skip
    assert rep.status == "budget_exceeded" and not called and fake.calls == []
    assert json.loads(gzip.decompress((tmp_path / "detections.json.gz").read_bytes()))["detections"] == [det]


# ------------------------------------------------------------------ verify never green


@pytest.fixture
def green_table():
    from kamutan_drawing.calibration import TABLE_PATH

    doc = json.loads(TABLE_PATH.read_text())
    doc["version"] = "t-green"
    doc["classes"]["socket_single"] = {"n": 500, "tp": 500, "fp": 0, "precision": 1.0, "wilsonLb": 0.992, "greenAllowed": True,
                                       "scoreMap": None}  # fmt: skip
    doc["domains"] = {k: {**v, "scoreMap": None} for k, v in doc.get("domains", {}).items()}
    table = parse_table(doc)
    set_default_table(table)
    yield table
    set_default_table(None)


def _verify_case(tmp_path, verdict: str, conf: float, level: str = "yellow"):
    det = {"id": "d_3", "class": "socket_single", "legendEntryId": "le_s_1", "bboxMm": {"x": 10, "y": 10, "w": 4, "h": 4},
           "level": level, "reasons": [] if level == "green" else ["דמיון נמוך"], "score": 0.99, "scoreRaw": 0.99}  # fmt: skip
    (tmp_path / "detections.json.gz").write_bytes(gzip.compress(json.dumps({"detections": [det]}).encode()))
    (tmp_path / "llm").mkdir(exist_ok=True)
    (tmp_path / "legend").mkdir(exist_ok=True)
    vid = f"v_{1:020x}"
    (tmp_path / "llm" / f"{vid}.png").write_bytes(png(1))
    (tmp_path / "legend" / "le_s_1.webp").write_bytes(png(2))
    man = {"items": [{"id": vid, "kind": "verify", "bboxMm": [10, 10, 14, 14], "file": f"llm/{vid}.png", "detectionId": "d_3",
                      "cls": "socket_single", "legendEntryId": "le_s_1"}]}  # fmt: skip
    legend = {"entries": [{"id": "le_s_1", "thumb": "legend/le_s_1.webp", "label": "שקע", "suggestedClass": "socket_single"},
                          {"id": "le_s_2", "thumb": "legend/le_s_2.webp", "label": "שקע כפול", "suggestedClass": "socket_double"}]}  # fmt: skip

    def responder(system, user, images):
        cls = "socket_double" if verdict == "other_class" else None
        return json.dumps(
            {"items": [{"id": it["id"], "verdict": verdict, "class": cls, "confidence": conf} for it in data_of(user)["items"]]}
        )

    g, fake, _ = make(responder)
    _, rep = hooks.after_understand(g, "o1", {"llmRequests": man, "legend": legend, "outDir": "x"}, llm_args={"collect": True},
                                    read_file=lambda rel: (tmp_path / rel).read_bytes(), rerun=lambda a: None,
                                    out_path=lambda r: tmp_path)  # fmt: skip
    out = json.loads(gzip.decompress((tmp_path / "detections.json.gz").read_bytes()))["detections"][0]
    return out, rep, fake


@pytest.mark.parametrize(
    ("verdict", "conf", "level", "reason"),
    [
        ("agree", 0.95, "yellow", hooks.R_VERIFIED),
        ("other_class", 0.9, "red", hooks.R_VERIFY_OTHER),
        ("other_class", 0.65, "yellow", hooks.R_VERIFY_OTHER),
        ("unsure", 0.9, "yellow", hooks.R_VERIFY_UNSURE),
    ],
)
def test_verify_goes_through_calibration_and_never_makes_green(tmp_path, green_table, verdict, conf, level, reason):
    out, _rep, fake = _verify_case(tmp_path, verdict, conf)
    assert out["level"] == level and reason in out["reasons"] and out["level"] != "green"
    # the class is green-allowed and the score is 0.99: only the verify cap keeps it yellow
    assert out["score"] == pytest.approx(0.99)
    c = fake.calls[0]
    assert c["cache"] and c["cache_prefix"] == 1 and len(c["images"]) == 2  # legend row first (cached), then the symbol


def test_verify_low_confidence_or_green_items_unchanged(tmp_path, green_table):
    out, _r, _ = _verify_case(tmp_path, "agree", 0.3)
    assert out["reasons"] == ["דמיון נמוך"] and out["level"] == "yellow"
    out, _rep, _ = _verify_case(tmp_path, "other_class", 0.99, level="green")
    assert out["level"] == "green" and hooks.R_VERIFY_OTHER not in out["reasons"]


def test_llm_derived_items_capped_at_yellow(tmp_path):
    before = {"detections.json.gz": {"detections": [{"id": "d_0", "class": "switch_single", "level": "green", "reasons": []}]},
              "links.json.gz": {"groups": [{"id": "lk_1", "kind": "single", "switchIds": ["d_0"], "level": "green", "reasons": []}]}}  # fmt: skip
    after_dets = {"detections": [{"id": "d_0", "class": "switch_2way", "level": "green", "reasons": []},
                                 {"id": "d_1", "class": "luminaire", "level": "green", "reasons": []}]}  # fmt: skip
    (tmp_path / "detections.json.gz").write_bytes(gzip.compress(json.dumps(after_dets).encode()))
    (tmp_path / "links.json.gz").write_bytes(gzip.compress(json.dumps(before["links.json.gz"]).encode()))
    before["detections.json.gz"]["detections"].append({"id": "d_1", "class": "luminaire", "level": "green", "reasons": []})
    n = hooks.cap_llm_derived(tmp_path, before)
    dets = json.loads(gzip.decompress((tmp_path / "detections.json.gz").read_bytes()))["detections"]
    groups = json.loads(gzip.decompress((tmp_path / "links.json.gz").read_bytes()))["groups"]
    assert n == 2
    assert dets[0]["level"] == "yellow" and hooks.R_LLM_TEXT in dets[0]["reasons"]
    assert dets[1]["level"] == "green"  # unchanged by the reading
    assert groups[0]["level"] == "yellow" and hooks.R_LLM_TEXT in groups[0]["reasons"]  # its switch changed


# ------------------------------------------------------------------ sandbox side: candidates and readings


def test_noisy_spans_and_note_blocks():
    s = lambda b, t, c=0.79: TextSpan("", b, t, c, b[3] - b[1], 0, len(t))
    assert (
        ht.noisy(s((0, 0, 5, 1), "נ | ה ט ע ן")) and ht.noisy(s((0, 0, 5, 1), "7ן?", 0.0)) and ht.noisy(s((0, 0, 1, 1), "ה", 0.6))
    )
    assert not ht.noisy(s((0, 0, 5, 1), "שנאי+פס לד", 0.82)) and not ht.noisy(s((0, 0, 1, 1), "65", 1.0))
    assert not ht.noisy(s((0, 0, 0.2, 3), "|")) and not ht.noisy(s((0, 0, 1, 1), "-|", 0.79))  # wall / leader strokes
    spans = [s((258.8, 237.5, 263.4, 238.6), "נ | | | ע"), s((265.9, 237.5, 273.0, 239.0), "נ | ה ט ע ן"),
             s((265.6, 239.2, 266.9, 241.1), "ה", 0.6), s((270.0, 239.2, 273.0, 241.1), "65", 1.0),
             s((255.2, 237.5, 256.5, 239.0), "-|"), s((250.9, 237.5, 252.8, 239.0), "7ן?", 0.0),
             s((100, 100, 110, 101), "נ | ה"), s((150, 100, 150.2, 400), "|")]  # fmt: skip
    blocks = ht.note_blocks(spans, [(272.1, 245.8, 276.9, 250.9)])
    assert len(blocks) == 1  # the far noisy span has no detection near it
    box, crop, text = blocks[0]
    # the whole garbled line (bridged over the "-|" fragment) + the readable "65" under it; the wall "|" is no seed
    assert box[0] == pytest.approx(250.9) and box[3] == pytest.approx(241.1)
    assert crop[1] <= box[1] - 4.0  # padded upwards: the glyph tops PDFium drops
    assert "65" in text


def test_span_readings_replace_the_block_and_add_qualifiers():
    spans = [TextSpan("", (258.8, 237.5, 263.4, 238.6), "נ | | | ע", 0.79, 1.1, 0, 7),
             TextSpan("", (270.0, 239.2, 273.0, 241.1), "65", 1.0, 1.9, 0, 2), TextSpan("", (10, 10, 20, 12), "סלון", 1.0, 2, 0, 4)]  # fmt: skip
    sess = ht.session_from_args(
        {"readings": {"n_" + "a" * 20: {"kind": "note", "text": "מפסק מחליף קיים H=65", "confidence": 0.95, "bboxMm": [258.8, 237.5, 273.0, 241.1]},
                      "q_" + "b" * 20: {"kind": "qualifier", "text": "2X", "confidence": 0.9, "bboxMm": [50, 50, 54, 54]},
                      "../evil": {"kind": "note", "text": "x", "confidence": 1, "bboxMm": [0, 0, 1, 1]},
                      "n_" + "c" * 20: {"kind": "prompt", "text": "x", "confidence": 1, "bboxMm": [0, 0, 1, 1]}}}
    )  # fmt: skip
    assert sess is not None and set(sess.readings) == {"n_" + "a" * 20, "q_" + "b" * 20} and not sess.collect
    out = ht.apply_span_readings(spans, sess)
    texts = sorted(x.text for x in out)
    assert texts == sorted(["סלון", "65", "מפסק מחליף קיים H=65", "2X"])  # the readable "65" keeps its span
    assert all(x.conf <= ht.READING_CONF_MAX for x in out if x.text not in ("סלון", "65"))
    assert sorted(sess.used) == sorted(["n_" + "a" * 20, "q_" + "b" * 20])
    assert ht.session_from_args(None) is None and ht.session_from_args({"readings": "x"}) is None


def test_mark_hook_round_trip_through_geometry_marks():
    from kamutan_drawing.geometry import marks as MK

    img = Image.new("L", (60, 120), 255)
    ImageDraw.Draw(img).line([(5, 5), (50, 100)], fill=0, width=4)
    sess = ht.Session(collect=True)
    with ht.active(sess):
        assert MK._llm_mark(__import__("numpy").array([[0.0, 0.0, 1.0, 1.0]] * 9), (0.0, 0.0, 2.0, 2.0)) is None
    assert [c.kind for c in sess.candidates] == ["mark"]
    cid = sess.candidates[0].id
    sess2 = ht.session_from_args(
        {"readings": {cid: {"kind": "mark", "text": "U.K=75 O.K=210", "confidence": 0.9, "bboxMm": [0, 0, 2, 2]}}}
    )
    with ht.active(sess2):
        mk = MK._llm_mark(__import__("numpy").array([[0.0, 0.0, 1.0, 1.0]] * 9), (0.0, 0.0, 2.0, 2.0))
    assert mk is not None and mk.opening_m == pytest.approx(1.35) and sess2 is not None and sess2.used == [cid]
    assert MK._llm_mark(__import__("numpy").zeros((1, 4)), (0.0, 0.0, 2.0, 2.0)) is None  # no session: no-op


# ------------------------------------------------------------------ provider: cache_control + cache pricing, logs


def test_anthropic_cache_control_shape_and_cache_tokens():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        its = data_of(seen["body"]["messages"][0]["content"][-1]["text"])["items"]
        text = json.dumps({"items": [{"id": i["id"], "verdict": "agree", "confidence": 0.9} for i in its]})
        usage = {"input_tokens": 300, "output_tokens": 50, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 2500}
        return httpx.Response(200, json={"content": [{"type": "text", "text": text}], "usage": usage})

    env = {"KAMUTAN_LLM_PROVIDER": "anthropic", "KAMUTAN_LLM_API_KEY": "sk-test"}
    g = from_env(Settings(o1={"llmEnabled": True}), env=env, transport=httpx.MockTransport(handler))
    r = g.call_batch("o1", "verify_symbol", items(2, "symbol"), verify_item_schema(["socket_single"]),
                     prefix=[PrefixImage("L1", png(5), "legend_row"), PrefixImage("L2", png(6), "legend_row")])  # fmt: skip
    body = seen["body"]
    assert body["model"] == "claude-sonnet-5-5"
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
    content = body["messages"][0]["content"]
    assert [c.get("cache_control") for c in content[:4]] == [None, {"type": "ephemeral"}, None, None]
    assert content[-1]["type"] == "text" and "tools" not in body
    assert r.status == "ok" and len(r.results) == 2
    assert r.cache_read_tokens == 2500 and r.cost_usd == pytest.approx((300 + 2500 * 0.1) * 3e-6 + 50 * 15e-6)


def test_batch_logs_carry_counts_never_text_or_images(caplog):
    g, _, _ = make(hard_text_responder(SECRET))
    its = [BatchItem("n_" + "1" * 20, png(), "text_region", {"currentReading": SECRET})]
    with caplog.at_level(logging.DEBUG, logger="kamutan.llm_gateway"):
        r = g.call_batch("o1", "read_hard_text", its, HARD_TEXT_ITEM_SCHEMA)
    assert r.results[its[0].id]["text"] == SECRET
    lines = [rec for rec in caplog.records if rec.name == "kamutan.llm_gateway"]
    assert lines
    for rec in lines:
        msg = rec.getMessage()
        assert SECRET not in msg and "iVBOR" not in msg and "PNG" not in msg
        assert SECRET not in json.dumps(getattr(rec, "llm", {}), ensure_ascii=False)
    f = lines[-1].llm  # type: ignore[attr-defined]
    assert f["purpose"] == "read_hard_text" and f["batch"] and "tokensIn" in f and "costUsd" in f


def test_report_json_has_no_content():
    rep = hooks.PageReport(status="ok", hard_text_sent=3, calls=1, cost_usd=0.01, reasons=["budget_exceeded:monthly_budget"])
    d = hooks.report_json(rep, "claude-sonnet-5-5")
    assert d["schema"] == "kamutan.llm/1" and d["hard_text_sent"] == 3 and d["model"] == "claude-sonnet-5-5"


# ------------------------------------------------------------------ end to end through the worker pipeline


def test_two_pass_pipeline_with_fake_gateway(monkeypatch):
    """Synthetic legend sheet through process_sheet_version: pass 1 crops → read_hard_text + verify_symbol →
    pass 2; llm.json written (counts only); nothing green carries an LLM reason; usage booked for the org."""
    from dataclasses import replace

    from kamutan_drawing.llm_gateway import docstore_settings_reader
    from kamutan_drawing.service.pipeline import process_sheet_version
    from tests.test_understand_pipeline import FAST, ORG, _gz, _vpath, job_payload, legend_sheet_pdf, seed

    data = legend_sheet_pdf()
    job, blobs, docs = seed(data, job_payload(data))
    docs.set(f"orgs/{ORG}", {"settings": {"llmEnabled": True, "llmMonthlyBudgetUsd": 5.0}})

    def responder(system, user, images):
        if "Each item image is a crop of a short piece of text" in system:
            return json.dumps({"items": [{"id": it["id"], "text": "2X", "confidence": 0.9} for it in data_of(user)["items"]]})
        if "detected on the plan" in system:
            return json.dumps(
                {"items": [{"id": it["id"], "verdict": "agree", "confidence": 0.9} for it in data_of(user)["items"]]}
            )
        return json.dumps({"label": "x"})

    fake = FakeProvider(responder=responder)
    gw = LlmGateway(provider=fake, org_settings_reader=docstore_settings_reader(docs), blobs=InMemoryBlobStore(), max_tokens=256)
    process_sheet_version(job, blobs, docs, replace(FAST, llm=gw))
    v = docs.get(_vpath())
    pre = v["artifacts"]["detections"].rsplit("/", 1)[0] + "/"
    rep = json.loads(blobs.read(pre + "llm.json"))
    assert (
        rep["schema"] == "kamutan.llm/1"
        and rep["hard_text_sent"] + rep["verify_sent"] > 0
        and rep["calls"] == len([c for c in fake.calls if c["cache"]])
    )
    assert "2X" not in json.dumps(rep)
    dets = _gz(blobs, v["artifacts"]["detections"])["detections"]
    for d in dets:
        if hooks.R_LLM_TEXT in d["reasons"] or hooks.R_VERIFIED in d["reasons"]:
            assert d["level"] != "green"
    assert all(len(c["images"]) <= MAX_BATCH + 12 for c in fake.calls)
    assert not any(Path(k).parts[-2:-1] == ("llm",) for k in blobs.list(pre))  # crops are never uploaded
    assert gw.usage(ORG)["calls"] >= 1
