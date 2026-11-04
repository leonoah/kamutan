"""Sprint 7 — antivirus scan in the ingest / import path (service/scan.py): fail closed, quarantine, file_infected.

The scan is shelved by the owner (04.11): default off. The fake-scanner tests drive the dormant code paths; the
real-ClamAV tests run only with ``KAMUTAN_AV_TEST=1``. The EICAR test string is generated at run time, never stored."""

from __future__ import annotations

import hashlib
import os
import shutil
import socket
import stat
import struct
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field, replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kamutan_drawing.errors import IngestError
from kamutan_drawing.library_import.importer import infected_import_path, run_library_import
from kamutan_drawing.service import scan as S
from kamutan_drawing.service.app import create_app
from kamutan_drawing.service.pipeline import infected_path, process_sheet_version

from .pipeline_util import FAST, ORG, PROJ, SET, job_payload, multipage_pdf, seed, validate_job

BASE = f"orgs/{ORG}/projects/{PROJ}"


@dataclass
class FakeScanner:
    """Verdict by content: the EICAR bytes are infected, anything else clean; ``down`` = engine unavailable."""

    down: bool = False
    seen: list[int] = field(default_factory=list)
    name: str = "fake"

    def scan(self, data: bytes) -> S.ScanResult:
        self.seen.append(len(data))
        if self.down:
            raise S.ScanUnavailable("fake engine down")
        if data.startswith(S.eicar()[:20]):
            return S.ScanResult(False, "fake", "Eicar-Test-Signature")
        return S.ScanResult(True, "fake")


def _no_parse(monkeypatch):
    """Any sandbox call fails the test: nothing may parse an unscanned / infected file."""

    def boom(*a, **k):
        raise AssertionError("the sandbox ran on a file that was not cleanly scanned")

    monkeypatch.setattr("kamutan_drawing.service.pipeline.run_task", boom)
    monkeypatch.setattr("kamutan_drawing.library_import.importer.run_task", boom)


# ----------------------------------------------------------------------------- ingest
def test_infected_upload_is_quarantined_and_never_parsed(monkeypatch):
    _no_parse(monkeypatch)
    data = S.eicar()  # declared a PDF: the scan runs before the magic-byte sniff (else: unsupported_format)
    job, blobs, docs = seed(data, job_payload(data, "pdf"))
    docs.set(f"{BASE}/sheetSets/{SET}", {"status": "uploaded"})
    fake = FakeScanner()
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, replace(FAST, scanner=fake))
    assert e.value.code == "file_infected" and not e.value.retryable
    jd = docs.get("jobs/job1")
    validate_job(jd, "job1")
    assert jd["status"] == "failed" and jd["error"]["code"] == "file_infected"
    ss = docs.get(f"{BASE}/sheetSets/{SET}")
    assert ss["status"] == "failed" and ss["error"]["code"] == "file_infected"
    mark = ss["malware"]
    assert mark["status"] == "infected" and mark["signature"] == "Eicar-Test-Signature" and mark["engine"] == "fake"
    assert mark["sha256"] == job.sha256 and mark["quarantinePath"] == infected_path(job)
    # moved: the original upload is gone, the bytes sit under …/infected/ (never served as a document)
    assert job.storagePath not in blobs.blobs
    assert blobs.blobs[infected_path(job)] == data
    assert blobs.content_types[infected_path(job)] == "application/octet-stream"
    assert infected_path(job).startswith(f"{BASE}/infected/") and "/quarantine/" not in infected_path(job)
    assert fake.seen == [len(data)]
    # contracts: SheetSet.error {code: file_infected, message: <signature name>} (+ the job error, same code)
    assert jd["error"]["message"] == "Eicar-Test-Signature" and ss["error"]["message"] == "Eicar-Test-Signature"


def test_redelivery_and_reprocess_of_a_quarantined_file_fail_without_reading_it(monkeypatch):
    _no_parse(monkeypatch)
    data = S.eicar()
    job, blobs, docs = seed(data, job_payload(data, "pdf"))
    with pytest.raises(IngestError):
        process_sheet_version(job, blobs, docs, replace(FAST, scanner=FakeScanner()))
    # reprocess of page 0 (new job, version created by the API): the version gets the error, no scan, no read
    payload = job_payload(data, "pdf", jobId="job2", sheetId=f"{SET}-p0", pageIndex=0, versionId="v2")
    job2, _, _ = seed(None, payload, docs=docs, blobs=blobs)
    docs.set(f"{BASE}/sheets/{SET}-p0/versions/v2", {"status": "queued"})
    fake = FakeScanner()
    with pytest.raises(IngestError) as e:
        process_sheet_version(job2, blobs, docs, replace(FAST, scanner=fake))
    assert e.value.code == "file_infected" and not e.value.retryable
    assert fake.seen == []  # the mark short-circuits before any read
    v = docs.get(f"{BASE}/sheets/{SET}-p0/versions/v2")
    assert v["status"] == "failed" and v["error"] == {"code": "file_infected", "message": "Eicar-Test-Signature"}


def test_quarantine_move_failure_still_blocks_parsing(monkeypatch):
    _no_parse(monkeypatch)
    data = S.eicar()
    job, blobs, docs = seed(data, job_payload(data, "pdf"))

    def broken_write(*a, **k):
        raise OSError("storage down")

    monkeypatch.setattr(blobs, "write", broken_write)
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, replace(FAST, scanner=FakeScanner()))
    assert e.value.code == "file_infected"
    assert docs.get(f"{BASE}/sheetSets/{SET}")["malware"]["status"] == "infected"  # marked first
    assert job.storagePath in blobs.blobs  # not deleted when the copy failed


def test_scanner_unavailable_fails_closed_and_retries(monkeypatch):
    _no_parse(monkeypatch)
    data = multipage_pdf(1)
    job, blobs, docs = seed(data, job_payload(data))
    opts = replace(FAST, scanner=FakeScanner(down=True))
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, opts)
    assert e.value.code == "scan_unavailable" and e.value.retryable
    assert docs.get("jobs/job1")["status"] == "queued"  # Pub/Sub redelivers
    assert job.storagePath in blobs.blobs and not any("/infected/" in p for p in blobs.blobs)
    docs.set("jobs/job1", {"attempts": 4})
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, opts)
    assert e.value.code == "scan_unavailable" and not e.value.retryable
    assert docs.get("jobs/job1")["status"] == "failed"


def test_require_mode_without_an_engine_fails_closed(monkeypatch):
    _no_parse(monkeypatch)
    monkeypatch.setenv("KAMUTAN_AV_SCAN", "require")
    monkeypatch.setattr(S, "engines_from_env", lambda env=None: [])
    data = multipage_pdf(1)
    job, blobs, docs = seed(data, job_payload(data))
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, FAST)  # scanner None → from the environment
    assert e.value.code == "scan_unavailable" and e.value.retryable


def test_clean_upload_is_scanned_then_parsed():
    data = multipage_pdf(1)
    job, blobs, docs = seed(data, job_payload(data))
    fake = FakeScanner()
    out = process_sheet_version(job, blobs, docs, replace(FAST, scanner=fake, understand=False))
    assert out.status == "succeeded" and fake.seen == [len(data)]
    assert "malware" not in (docs.get(f"{BASE}/sheetSets/{SET}") or {})


def test_push_handler_acks_infected_and_redelivers_unavailable(monkeypatch):
    import base64
    import json

    _no_parse(monkeypatch)

    def push(payload):
        return {"message": {"data": base64.b64encode(json.dumps(payload).encode()).decode(), "messageId": "m"}}

    data = S.eicar()
    payload = job_payload(data, "pdf")
    _, blobs, docs = seed(data, payload)
    r = TestClient(create_app(blobs, docs, replace(FAST, scanner=FakeScanner()))).post("/pubsub/ingest", json=push(payload))
    assert r.status_code == 200 and r.json() == {"status": "rejected", "reason": "file_infected"}
    data = multipage_pdf(1)
    payload = job_payload(data)
    _, blobs, docs = seed(data, payload)
    client = TestClient(create_app(blobs, docs, replace(FAST, scanner=FakeScanner(down=True))))
    r = client.post("/pubsub/ingest", json=push(payload))
    assert r.status_code == 500 and r.json()["code"] == "scan_unavailable"
    h = client.get("/healthz").json()["antivirus"]
    assert h["engines"] == ["fake"] and h["mode"] == "off"  # an injected engine scans whatever the env mode


# ----------------------------------------------------------------------------- library import
def test_infected_library_import_is_quarantined(monkeypatch):
    from .test_library_import import IMP, LIMITS, _job

    _no_parse(monkeypatch)
    data = S.eicar()
    job, blobs, docs = _job(data)
    with pytest.raises(IngestError) as e:
        run_library_import(job, blobs, docs, limits=LIMITS, scanner=FakeScanner())
    assert e.value.code == "file_infected" and not e.value.retryable
    sha = hashlib.sha256(data).hexdigest()
    for p in ("jobs/j1", f"orgs/o1/libraryImports/{IMP}"):
        d = docs.get(p)
        assert d["status"] == "failed" and d["error"]["code"] == "file_infected" and d["malware"]["sha256"] == sha
    assert job.storagePath not in blobs.blobs and blobs.blobs[infected_import_path(job, sha)] == data
    # a redelivery after the ack never reads the (moved) object again
    docs.set("jobs/j1", {"status": "queued"})
    fake = FakeScanner()
    with pytest.raises(IngestError) as e:
        run_library_import(job, blobs, docs, limits=LIMITS, scanner=fake)
    assert e.value.code == "file_infected" and e.value.message == "Eicar-Test-Signature" and fake.seen == []
    assert S.infected_error(None).message == "unknown" and S.infected_error("a b\x00").message == "a_b_"


def test_library_import_scanner_unavailable_is_retryable(monkeypatch):
    from .test_library_import import LIMITS, _job, synth_xlsx

    _no_parse(monkeypatch)
    job, blobs, docs = _job(synth_xlsx())
    with pytest.raises(IngestError) as e:
        run_library_import(job, blobs, docs, limits=LIMITS, scanner=FakeScanner(down=True))
    assert e.value.code == "scan_unavailable" and e.value.retryable and docs.get("jobs/j1")["status"] == "queued"


# ----------------------------------------------------------------------------- policy
def test_mode_and_engine_selection(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DEFAULT_SOCKETS", (str(tmp_path / "nope.ctl"),))
    monkeypatch.setattr(S.shutil, "which", lambda name: None)
    # shelved by the owner (04.11): off unless explicitly turned on — Cloud Run included
    assert S.scan_mode({}) == "off" and S.scan_mode({"KAMUTAN_AV_SCAN": "bogus"}) == "off"
    assert S.scan_mode({"K_SERVICE": "kamutan-worker"}) == "off"
    assert S.scan_mode({"KAMUTAN_AV_SCAN": "require", "K_SERVICE": "kamutan-worker"}) == "require"
    assert S.scan_mode({"KAMUTAN_AV_SCAN": "auto"}) == "auto"
    assert S.scan_mode({"KAMUTAN_AV_SCAN": "require", "KAMUTAN_AV": "off"}) == "off"
    assert isinstance(S.scanner_from_env({}), S.SkipScanner) and S.scanner_from_env({}).quiet
    # explicitly on: fail closed without an engine (require), skip with warnings (auto)
    assert isinstance(S.scanner_from_env({"KAMUTAN_AV_SCAN": "require"}), S.UnavailableScanner)
    auto = S.scanner_from_env({"KAMUTAN_AV_SCAN": "auto"})
    assert isinstance(auto, S.SkipScanner) and not auto.quiet
    on = {"KAMUTAN_AV_SCAN": "require"}
    one = S.scanner_from_env({**on, "KAMUTAN_CLAMD": "tcp:127.0.0.1:3310", "KAMUTAN_AV_TIMEOUT_S": "7"})
    assert isinstance(one, S.ClamdScanner) and one.timeout_s == 7.0
    both = S.scanner_from_env({**on, "KAMUTAN_CLAMD": "unix:/x.ctl", "KAMUTAN_CLAMSCAN": "/usr/bin/clamscan"})
    assert isinstance(both, S.FallbackScanner) and [e.name for e in both.engines] == ["clamd", "clamscan"]
    # engine env (KAMUTAN_AV with the scan turned on)
    env = {**on, "KAMUTAN_AV": "clamd", "KAMUTAN_CLAMD_SOCKET": "/run/clamav/clamd.sock",
           "KAMUTAN_CLAMSCAN_BIN": "/usr/bin/clamscan", "KAMUTAN_CLAMAV_DB": "/var/lib/clamav"}  # fmt: skip
    sc = S.scanner_from_env(env)
    assert isinstance(sc, S.ClamdScanner) and sc.address == "unix:/run/clamav/clamd.sock"  # clamd only, no fallback
    cs = S.scanner_from_env({**env, "KAMUTAN_AV": "clamscan"})
    assert isinstance(cs, S.ClamscanScanner) and cs.binary == "/usr/bin/clamscan" and cs.database == "/var/lib/clamav"
    sock = tmp_path / "clamd.ctl"
    sock.write_text("")
    monkeypatch.setattr(S, "DEFAULT_SOCKETS", (str(sock),))
    found = S.scanner_from_env(on)
    assert isinstance(found, S.ClamdScanner) and found.address == f"unix:{sock}"


def test_off_logs_once_at_startup_not_per_job(caplog, monkeypatch):
    monkeypatch.setattr(S, "_off_logged", False)
    with caplog.at_level("DEBUG", logger="kamutan_drawing.service.scan"):
        for _ in range(3):
            r = S.scan_upload(S.scanner_from_env({}), b"abc", what="t")
            assert r.clean and r.skipped
    infos = [x for x in caplog.records if x.levelname == "INFO"]
    assert len(infos) == 1 and "KAMUTAN_AV_SCAN=require" in infos[0].getMessage()
    assert not [x for x in caplog.records if x.levelname in ("WARNING", "ERROR")]
    caplog.clear()
    with caplog.at_level("WARNING"):  # auto without an engine: the scan was asked for, every skip is logged
        S.scan_upload(S.SkipScanner("auto, no engine"), b"abc", what="t")
    assert any("SKIPPED" in m for m in caplog.messages)


def test_healthz_with_the_scan_off_is_not_degraded(monkeypatch):
    from kamutan_drawing.stores import InMemoryBlobStore, InMemoryDocStore

    monkeypatch.delenv("KAMUTAN_AV_SCAN", raising=False)
    monkeypatch.setattr(S.shutil, "which", lambda name: None)
    r = TestClient(create_app(InMemoryBlobStore(), InMemoryDocStore(), FAST)).get("/healthz")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert r.json()["antivirus"] == {"mode": "off", "engines": []}


def test_verdict_parsing_and_signature_sanitising():
    t0 = 0.0
    assert S._verdict("stream: OK\0", "clamd", t0).clean
    r = S._verdict("stream: Win.Test.EICAR_HDB-1 FOUND\0", "clamd", t0)
    assert not r.clean and r.signature == "Win.Test.EICAR_HDB-1"
    assert S.clean_signature(" Evil <script>\n") == "Evil__script_"
    with pytest.raises(S.ScanUnavailable):
        S._verdict("INSTREAM size limit exceeded. ERROR\0", "clamd", t0)
    with pytest.raises(S.ScanUnavailable):
        S._verdict("", "clamd", t0)


def test_eicar_is_generated_not_stored():
    assert hashlib.md5(S.eicar(), usedforsecurity=False).hexdigest() == "44d88612fea8a8f36de82e1278abb02f"
    here = Path(__file__).resolve()
    repo_src = [here, *Path(S.__file__).resolve().parent.glob("*.py")]
    needle = S.eicar()[:24]
    assert all(needle not in p.read_bytes() for p in repo_src)


# ----------------------------------------------------------------------------- clamd protocol (fake daemon)
class FakeClamd(threading.Thread):
    """Minimal clamd on a unix socket: PING → PONG; INSTREAM → reassembles chunks, FOUND for EICAR."""

    def __init__(self, path: str, *, mode: str = "ok", max_len: int = 1 << 30) -> None:
        super().__init__(daemon=True)
        self.path, self.mode, self.max_len = path, mode, max_len
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(path)
        self.srv.listen(4)
        self.received: list[bytes] = []
        self.stop = threading.Event()

    def _read(self, c: socket.socket, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            part = c.recv(n - len(buf))
            if not part:
                raise ConnectionError
            buf += part
        return buf

    def run(self) -> None:
        self.srv.settimeout(0.2)
        while not self.stop.is_set():
            try:
                c, _ = self.srv.accept()
            except TimeoutError:
                continue
            with c:
                try:
                    self._serve(c)
                except (ConnectionError, OSError):
                    pass

    def _serve(self, c: socket.socket) -> None:
        cmd = b""
        while not cmd.endswith(b"\0"):
            cmd += self._read(c, 1)
        if cmd == b"zPING\0":
            c.sendall(b"PONG\0")
            return
        assert cmd == b"zINSTREAM\0"
        data = b""
        while True:
            (n,) = struct.unpack("!I", self._read(c, 4))
            if n == 0:
                break
            data += self._read(c, n)
            if len(data) > self.max_len:
                c.sendall(b"INSTREAM size limit exceeded. ERROR\0")
                return
        self.received.append(data)
        if self.mode == "hang":
            self.stop.wait(5)
            return
        c.sendall(b"stream: Win.Test.EICAR_HDB-1 FOUND\0" if data.startswith(S.eicar()) else b"stream: OK\0")


@pytest.fixture
def clamd_sock():
    d = Path(tempfile.mkdtemp(prefix="kc"))  # short path (AF_UNIX ≤ 108 bytes)
    servers: list[FakeClamd] = []

    def start(**kw) -> str:
        p = str(d / f"c{len(servers)}.ctl")
        s = FakeClamd(p, **kw)
        s.start()
        servers.append(s)
        return p

    yield start, servers
    for s in servers:
        s.stop.set()
        s.join(2)
        s.srv.close()
    for p in d.iterdir():
        p.unlink()
    d.rmdir()


def test_clamd_instream_protocol(clamd_sock, monkeypatch):
    start, servers = clamd_sock
    monkeypatch.setattr(S, "CHUNK", 7)  # several chunks for a small buffer
    sc = S.ClamdScanner("unix:" + start(), timeout_s=5)
    assert sc.ping()
    big = b"%PDF-1.4\n" + bytes(range(256)) * 3
    assert sc.scan(big).clean and servers[0].received[-1] == big
    r = sc.scan(S.eicar())
    assert not r.clean and r.signature == "Win.Test.EICAR_HDB-1" and r.engine == "clamd"
    assert S.describe(sc) == {"engines": ["clamd"], "clamdPing": True}


def test_clamd_errors_are_unavailable(clamd_sock):
    start, _ = clamd_sock
    with pytest.raises(S.ScanUnavailable):
        S.ClamdScanner("unix:" + start(max_len=10), timeout_s=5).scan(b"x" * 100)  # StreamMaxLength
    with pytest.raises(S.ScanUnavailable):
        S.ClamdScanner("unix:" + start(mode="hang"), timeout_s=1).scan(b"x")  # timeout
    with pytest.raises(S.ScanUnavailable):
        S.ClamdScanner("unix:/nonexistent/clamd.ctl", timeout_s=1).scan(b"x")
    assert not S.ClamdScanner("unix:/nonexistent/clamd.ctl").ping()


def _fake_clamscan(tmp_path: Path, body: str) -> str:
    p = tmp_path / f"clamscan-{hashlib.sha256(body.encode()).hexdigest()[:8]}"
    p.write_text("#!/bin/sh\ncat >/dev/null\n" + body)
    p.chmod(p.stat().st_mode | stat.S_IXUSR)
    return str(p)


def test_clamscan_fallback(tmp_path):
    found = _fake_clamscan(tmp_path, 'echo "stdin: Eicar-Signature FOUND"\nexit 1\n')
    r = S.ClamscanScanner(found, timeout_s=10).scan(S.eicar())
    assert not r.clean and r.signature == "Eicar-Signature" and r.engine == "clamscan"
    ok = _fake_clamscan(tmp_path, "exit 0\n")
    assert S.ClamscanScanner(ok, timeout_s=10).scan(b"x").clean
    err = _fake_clamscan(tmp_path, "exit 2\n")
    with pytest.raises(S.ScanUnavailable):
        S.ClamscanScanner(err, timeout_s=10).scan(b"x")
    slow = _fake_clamscan(tmp_path, "sleep 5\n")
    with pytest.raises(S.ScanUnavailable):
        S.ClamscanScanner(slow, timeout_s=1).scan(b"x")
    # clamd down → clamscan gives the verdict; both down → unavailable
    fb = S.FallbackScanner((S.ClamdScanner("unix:/nonexistent.ctl", 1), S.ClamscanScanner(found, 10)))
    assert fb.scan(S.eicar()).engine == "clamscan"
    with pytest.raises(S.ScanUnavailable):
        S.FallbackScanner((S.ClamdScanner("unix:/nonexistent.ctl", 1), S.ClamscanScanner(err, 10))).scan(b"x")


def test_selftest_exit_codes():
    assert S.selftest(FakeScanner()) == 0
    assert S.selftest(FakeScanner(down=True)) == 2
    assert S.selftest(S.SkipScanner()) == 3


# ----------------------------------------------------------------------------- real engine (EICAR)
# Real ClamAV binaries, three ways: (1) the installed engine with its own signature DB (CI image / a dev box with
# freshclam), (2) the real `clamscan` and (3) the real `clamd` with a signature DB generated here — one MD5 hash
# signature of the EICAR string (`.hdb`), so the test needs no network. Skipped without ClamAV; KAMUTAN_AV_TEST=1
# (CI's ClamAV job) turns a missing engine into a failure.
def _need_clamav(binary: str) -> str:
    if os.environ.get("KAMUTAN_AV_TEST") != "1":
        pytest.skip("real-ClamAV tests run only with KAMUTAN_AV_TEST=1 (the scan is shelved)")
    found = shutil.which(binary) or next((p for p in (f"/usr/sbin/{binary}", f"/usr/bin/{binary}") if Path(p).exists()), None)
    if found is None:
        if os.environ.get("KAMUTAN_AV_TEST") == "1":
            pytest.fail(f"KAMUTAN_AV_TEST=1 but {binary} is not installed")
        pytest.skip(f"ClamAV {binary} not installed")
    return found


@pytest.fixture
def eicar_db():
    d = Path(tempfile.mkdtemp(prefix="kdb"))
    e = S.eicar()
    (d / "kamutan-test.hdb").write_text(f"{hashlib.md5(e, usedforsecurity=False).hexdigest()}:{len(e)}:Kamutan-Test-EICAR\n")
    yield d
    shutil.rmtree(d, ignore_errors=True)


def _assert_engine(sc: S.Scanner, signature_part: str) -> None:
    bad = sc.scan(S.eicar())
    assert not bad.clean and bad.signature and signature_part in bad.signature.lower(), bad
    assert sc.scan(multipage_pdf(1)).clean
    assert S.selftest(sc) == 0


def test_real_installed_engine_with_its_own_signatures():
    _need_clamav("clamscan")
    engines = S.engines_from_env({**os.environ, "KAMUTAN_AV_SCAN": "require"})
    sc = S.FallbackScanner(tuple(engines))
    try:
        sc.scan(b"probe")
    except S.ScanUnavailable as e:  # e.g. clamscan installed but no signature DB
        pytest.fail(f"KAMUTAN_AV_TEST=1 but the engine gives no verdict: {e}")
    _assert_engine(sc, "eicar")


def test_real_clamscan_detects_eicar(eicar_db):
    _assert_engine(S.ClamscanScanner(_need_clamav("clamscan"), timeout_s=120, database=str(eicar_db)), "kamutan-test-eicar")


def test_real_clamd_detects_eicar(eicar_db):
    clamd = _need_clamav("clamd")
    run = Path(tempfile.mkdtemp(prefix="kcd"))
    sock = run / "clamd.ctl"
    conf = run / "clamd.conf"
    conf.write_text(
        f"Foreground yes\nLocalSocket {sock}\nDatabaseDirectory {eicar_db}\nLogFile {run / 'clamd.log'}\n"
        "StreamMaxLength 101M\nMaxFileSize 101M\nMaxScanSize 400M\nPidFile " + str(run / "clamd.pid") + "\n"
    )
    p = subprocess.Popen([clamd, "-c", str(conf)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        sc = S.ClamdScanner(f"unix:{sock}", timeout_s=30)
        deadline = time.monotonic() + 60
        while not sc.ping():
            if p.poll() is not None or time.monotonic() > deadline:
                err = (p.stderr.read() if p.stderr else b"").decode(errors="replace")[-500:]
                log = (run / "clamd.log").read_text(errors="replace")[-500:] if (run / "clamd.log").exists() else ""
                pytest.fail(f"clamd did not start: {err} {log}")
            time.sleep(0.2)
        _assert_engine(sc, "kamutan-test-eicar")
        assert S.describe(sc)["clamdPing"] is True
    finally:
        p.terminate()
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill()
        shutil.rmtree(run, ignore_errors=True)
