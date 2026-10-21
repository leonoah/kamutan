"""Sprint 5: upload-order dependency — re-understand MEP sheets when a wall source of their floor becomes ready
(lifecycle/dependents.py: pure decisions + the service hook on an in-memory DocStore)."""

from __future__ import annotations

import itertools

import pytest

from kamutan_drawing.lifecycle import dependents_to_reprocess, due_requests, merge_request, reprocess_reason, schedule_dependents
from kamutan_drawing.lifecycle.dependents import (
    DEBOUNCE_S,
    MAX_WAIT_S,
    REQUESTS,
    WALL_SOURCE_RANK,
    SheetState,
    borrows_from,
    project_states,
    rank,
)
from kamutan_drawing.stores.memory import InMemoryDocStore

P = "orgs/o1/projects/p1"
DISCIPLINES = ["construction", "architecture", "architecture_master", "electrical", "lighting", "plumbing", "demolition"]


def S(sid, disc, floors=("first",), *, vid="v1", status="ready", refs=None, confirmed=False):
    return SheetState(sid, disc, tuple(floors), confirmed, vid, status, frozenset(refs) if refs is not None else None)


def test_borrow_ranks_are_a_dag_so_automatic_reprocessing_cannot_loop():
    assert borrows_from("electrical", "construction") and borrows_from("plumbing", "architecture_master")
    assert borrows_from("architecture_master", "construction") and not borrows_from("construction", "architecture")
    assert not borrows_from("construction", "construction") and not borrows_from("electrical", "electrical")
    assert not borrows_from("architecture_master", "architecture_master")
    assert not borrows_from("construction", "electrical")
    # every edge strictly increases the rank: no cycle of any length
    for a, b in itertools.product(DISCIPLINES, repeat=2):
        if borrows_from(b, a):
            assert rank(a) < rank(b)
            assert not borrows_from(a, b)
    assert set(WALL_SOURCE_RANK) >= {"construction", "architecture"}


def test_dependents_of_a_new_construction_plan():
    src = S("c1", "construction", ("first",), vid="v2")
    sheets = [
        src,
        S("e1", "electrical", ("first",)),  # same floor → yes
        S("p1", "plumbing", ("first",), refs={"c1/v1"}),  # used the previous version of c1 → yes
        S("l1", "lighting", ("first",), refs={"c1/v2"}),  # already processed with c1/v2 → no
        S("e0", "electrical", ("basement",), confirmed=True),  # confirmed other floor → no
        S("e9", "electrical", ("basement",)),  # unconfirmed other floor (floor inference) → yes
        S("m1", "architecture_master", ("first",)),  # master borrows from construction → yes
        S("c2", "construction", ("first",)),  # construction borrows from nobody → no
        S("x1", "electrical", ("first",), vid=None),  # no version yet → no
        S("f1", "electrical", ("first",), status="failed"),  # failed version → no
        S("u1", "plumbing", ()),  # floors unknown → yes
        S("q1", "electrical", ("first",), status="processing"),  # in flight: recorded, the due check waits
    ]
    got = [s.sheet_id for s in dependents_to_reprocess(src, sheets)]
    assert got == ["e1", "e9", "m1", "p1", "q1", "u1"]
    # the source must be a ready wall source
    assert dependents_to_reprocess(S("c1", "construction", status="processing"), sheets) == []
    assert dependents_to_reprocess(S("e1", "electrical"), sheets) == []


def test_master_plan_triggers_only_mep_sheets():
    src = S("m1", "architecture_master")
    got = [
        s.sheet_id
        for s in dependents_to_reprocess(src, [S("c1", "construction"), S("a1", "architecture"), S("e1", "electrical")])
    ]
    assert got == ["e1"]


def test_request_is_idempotent_and_debounced():
    dep = S("e1", "electrical")
    c1, c2 = S("c1", "construction", vid="v1"), S("c2", "construction", vid="v1")
    r1 = merge_request(None, dep, c1, now=1000.0)
    assert r1 is not None and r1["status"] == "pending" and r1["sources"] == ["c1/v1"]
    assert r1["notBefore"] == 1000.0 + DEBOUNCE_S and r1["dependentVersionId"] == "v1"
    assert merge_request(r1, dep, c1, now=1010.0) is None  # same source re-delivered: unchanged
    r2 = merge_request(r1, dep, c2, now=1050.0)
    assert r2 is not None and r2["sources"] == ["c1/v1", "c2/v1"]
    assert r2["notBefore"] == 1050.0 + DEBOUNCE_S and r2["firstRequestedAt"] == 1000.0
    # a new version of the same source replaces the older one
    r3 = merge_request(r2, dep, S("c1", "construction", vid="v2"), now=1060.0)
    assert r3 is not None and r3["sources"] == ["c2/v1", "c1/v2"]
    # a stream of sources cannot postpone the request forever
    r = r1
    for k in range(40):
        r = merge_request(r, dep, S(f"c{k + 10}", "construction"), now=1000.0 + 60.0 * k) or r
    assert r["notBefore"] <= 1000.0 + MAX_WAIT_S
    # a done request starts over
    assert merge_request({**r1, "status": "done"}, dep, c1, now=5000.0)["firstRequestedAt"] == 5000.0  # type: ignore[index]


def test_due_requests():
    req = {"status": "pending", "notBefore": 100.0, "sources": ["c1/v2"], "dependentVersionId": "v1"}
    sheets = {"e1": S("e1", "electrical", vid="v1")}
    assert due_requests({"e1": req}, sheets, now=99.0) == {}
    assert due_requests({"e1": req}, sheets, now=100.0) == {"e1": "fire"}
    assert due_requests({"e1": req}, {"e1": S("e1", "electrical", vid="v1", status="processing")}, now=200.0) == {"e1": "wait"}
    # reprocessed meanwhile (new version) with the requested source → drop; without it → fire
    assert due_requests({"e1": req}, {"e1": S("e1", "electrical", vid="v3", refs={"c1/v2"})}, now=200.0) == {"e1": "drop"}
    assert due_requests({"e1": req}, {"e1": S("e1", "electrical", vid="v3", refs={"c9/v1"})}, now=200.0) == {"e1": "fire"}
    assert due_requests({"e1": req}, {}, now=200.0) == {"e1": "drop"}
    assert due_requests({"e1": {**req, "status": "done"}}, sheets, now=200.0) == {}
    reason = reprocess_reason(req)
    assert reason["kind"] == "reference_walls" and reason["sources"] == ["c1/v2"] and reason["message"]


def _project(docs):
    def put(sid, disc, floors, vid, status="ready", refs=None, confirmed=False):
        docs.set(
            f"{P}/sheets/{sid}", {"discipline": disc, "floors": list(floors), "currentVersionId": vid, "confirmed": confirmed}
        )
        v = {"status": status}
        if refs is not None:
            v["referenceSources"] = list(refs)
        docs.set(f"{P}/sheets/{sid}/versions/{vid}", v)

    put("e1", "electrical", ["first"], "v1", refs=[])
    put("p1", "plumbing", ["first"], "v1")
    put("l0", "lighting", ["ground"], "v1", confirmed=True)
    put("c1", "construction", ["first"], "v1")
    return put


def test_schedule_hook_writes_one_request_per_dependent():
    docs = InMemoryDocStore()
    put = _project(docs)
    assert schedule_dependents(docs, P, "c1", now=1000.0) == ["e1", "p1"]
    req = docs.get(f"{P}/{REQUESTS}/e1")
    assert req is not None and req["sources"] == ["c1/v1"] and req["status"] == "pending"
    # redelivery of the same job: nothing written
    n = len(docs.history)
    assert schedule_dependents(docs, P, "c1", now=1001.0) == []
    assert len(docs.history) == n
    # an MEP sheet becoming ready never schedules anything (no loop)
    assert schedule_dependents(docs, P, "e1", now=1002.0) == []
    # the electrical sheet was reprocessed with c1/v1: the request is dropped when due
    put("e1", "electrical", ["first"], "v2", refs=["c1/v1"])
    states = project_states(docs, P)
    reqs = dict(docs.list_docs(f"{P}/{REQUESTS}"))
    assert due_requests(reqs, states, now=1000.0 + DEBOUNCE_S) == {"e1": "drop", "p1": "fire"}
    # unknown sheet / no project: no-op
    assert schedule_dependents(docs, P, "nope", now=1.0) == []
    assert schedule_dependents(InMemoryDocStore(), P, "c1", now=1.0) == []


@pytest.mark.parametrize("disc", ["electrical", "lighting", "plumbing", "demolition"])
def test_non_wall_sources_never_trigger(disc):
    docs = InMemoryDocStore()
    _project(docs)
    docs.set(f"{P}/sheets/z1", {"discipline": disc, "floors": ["first"], "currentVersionId": "v1"})
    docs.set(f"{P}/sheets/z1/versions/v1", {"status": "ready"})
    assert schedule_dependents(docs, P, "z1", now=1.0) == []
