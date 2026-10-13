"""Parser sandbox (SEC-17) — isolation and limits, "בדיקות sandbox" in docs/spec/06_security.md.

Every hostile behaviour must end as a typed :class:`SandboxError` (or a refused operation inside
the child) within the configured limits; the test process itself is never harmed.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

import pytest

from kamutan_drawing.errors import IngestError, SandboxError
from kamutan_drawing.sandbox.runner import (
    UID_POOL,
    Limits,
    landlock_available,
    net_isolation_available,
    run_task,
    safe_output_path,
    uid_drop_possible,
)

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="the parser sandbox is Linux-only")
needs_landlock = pytest.mark.skipif(not landlock_available(), reason="Landlock LSM not available on this kernel")

QUICK = Limits(memory_mb=1024, cpu_s=10, wall_s=30.0, nproc=64)


@pytest.fixture
def workdir():
    d = tempfile.mkdtemp(prefix="sbx-")
    yield d
    subprocess.run(["rm", "-rf", d], check=False)


def _sandbox_pids() -> set[int]:
    """Processes owned by a sandbox uid (UID_POOL)."""
    out = set()
    for p in Path("/proc").iterdir():
        if not p.name.isdigit():
            continue
        try:
            uid = p.stat().st_uid
        except OSError:
            continue
        if UID_POOL[0] <= uid < UID_POOL[1]:
            out.add(int(p.name))
    return out


def test_echo_env_is_scrubbed_and_cwd_is_the_workdir(workdir, monkeypatch):
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/secret/key.json")
    monkeypatch.setenv("KAMUTAN_UPLOAD_TOKEN_SECRET", "s3cr3t")
    progress = []
    res = run_task(
        "selftest.echo", {"value": "שלום"}, workdir=workdir, limits=QUICK, on_progress=lambda s, p: progress.append((s, p))
    )
    assert res["echo"] == "שלום"
    assert os.path.realpath(res["cwd"]) == os.path.realpath(workdir)
    assert not any(k.startswith("GOOGLE") or "SECRET" in k or "TOKEN" in k for k in res["env"])
    assert progress == [("ingest", 50)]


def test_network_connect_fails(workdir):
    # a server the test process CAN reach — the sandbox must not
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    try:
        assert socket.create_connection(("127.0.0.1", port), timeout=2)
        local = run_task("selftest.net", {"host": "127.0.0.1", "port": port}, workdir=workdir, limits=QUICK)
        remote = run_task("selftest.net", {"host": "1.1.1.1", "port": 53}, workdir=workdir, limits=QUICK)
    finally:
        srv.close()
    if not (net_isolation_available() or landlock_available()):
        pytest.skip("neither a network namespace nor Landlock TCP rules are available")
    assert local.startswith("blocked:") and remote.startswith("blocked:")


@needs_landlock
def test_write_outside_the_workdir_fails(workdir):
    outside = tempfile.mkdtemp(prefix="sbx-outside-")
    os.chmod(outside, 0o777)  # even a world-writable directory is closed (Landlock, not just permissions)
    targets = [
        f"{outside}/escape.txt",
        "/tmp/kamutan-sbx-escape.txt",
        "/dev/shm/kamutan-sbx-escape.txt",
        f"{Path.home()}/escape.txt",
        "/etc/escape",
    ]
    try:
        res = run_task("selftest.write", {"paths": [*targets, f"{workdir}/inside.txt"]}, workdir=workdir, limits=QUICK)
        for t in targets:
            assert res[t].startswith("blocked:"), (t, res[t])
            assert not os.path.exists(t)
        assert res[f"{workdir}/inside.txt"] == "written"
    finally:
        subprocess.run(["rm", "-rf", outside], check=False)


@needs_landlock
def test_reading_files_outside_the_allowed_roots_fails(workdir):
    secret_dir = tempfile.mkdtemp(prefix="sbx-secret-")
    os.chmod(secret_dir, 0o755)
    secret = Path(secret_dir) / "service-account.json"
    secret.write_text('{"private_key": "x"}')
    secret.chmod(0o644)  # world-readable: only the jail protects it
    try:
        res = run_task("selftest.read", {"paths": [str(secret), "/etc/hostname", sys.executable]}, workdir=workdir, limits=QUICK)
        assert res[str(secret)].startswith("blocked:")
        assert res[sys.executable] == "read"  # the interpreter stays readable
    finally:
        subprocess.run(["rm", "-rf", secret_dir], check=False)


@needs_landlock
def test_cannot_signal_processes_outside_the_sandbox(workdir):
    victim = subprocess.Popen(["sleep", "30"])
    try:
        res = run_task("selftest.kill_parent", {"pid": victim.pid}, workdir=workdir, limits=QUICK)
        assert res.startswith("blocked:")
        assert victim.poll() is None
    finally:
        victim.kill()
        victim.wait()


def test_excessive_memory_is_a_typed_memory_limit(workdir):
    t0 = time.monotonic()
    with pytest.raises(SandboxError) as e:
        run_task("selftest.alloc", {"mb": 100_000}, workdir=workdir, limits=replace(QUICK, memory_mb=512))
    assert e.value.code == "parse_memory_limit" and not e.value.retryable
    assert time.monotonic() - t0 < QUICK.wall_s


def test_cpu_loop_is_a_typed_cpu_limit(workdir):
    t0 = time.monotonic()
    with pytest.raises(SandboxError) as e:
        run_task("selftest.spin", {}, workdir=workdir, limits=replace(QUICK, cpu_s=2))
    assert e.value.code == "parse_cpu_limit"
    assert time.monotonic() - t0 < 15


def test_hang_is_a_typed_timeout(workdir):
    t0 = time.monotonic()
    with pytest.raises(SandboxError) as e:
        run_task("selftest.sleep", {"s": 600}, workdir=workdir, limits=replace(QUICK, wall_s=2.0))
    assert e.value.code == "parse_timeout"
    assert time.monotonic() - t0 < 10


def test_crash_is_typed(workdir):
    with pytest.raises(SandboxError) as e:
        run_task("selftest.crash", {}, workdir=workdir, limits=QUICK)
    assert e.value.code == "parse_crashed"


DROPS_ROOT = os.geteuid() == 0 and uid_drop_possible()


@pytest.mark.skipif(
    os.geteuid() != 0 and os.environ.get("CI") is None, reason="RLIMIT_NPROC is per uid; run as root (container) or in CI"
)
def test_fork_bomb_ends_typed_and_leaves_no_processes(workdir):
    import threading

    before = _sandbox_pids()
    peak, stop = [0], threading.Event()

    def monitor() -> None:
        while not stop.is_set():
            peak[0] = max(peak[0], len(_sandbox_pids() - before))
            time.sleep(0.05)

    mon = threading.Thread(target=monitor)
    mon.start()
    t0 = time.monotonic()
    try:
        with pytest.raises(SandboxError) as e:
            run_task("selftest.forkbomb", {}, workdir=workdir, limits=replace(QUICK, wall_s=5.0, cpu_s=4, nproc=48))
    finally:
        stop.set()
        mon.join()
    elapsed = time.monotonic() - t0
    if DROPS_ROOT:
        assert peak[0] <= 48 + 1  # RLIMIT_NPROC of the sandbox uid (+ the reaper)
    assert e.value.code in ("parse_timeout", "parse_cpu_limit", "parse_crashed")
    assert elapsed < 20
    time.sleep(0.5)
    if DROPS_ROOT:
        assert _sandbox_pids() - before == set()  # every process of the sandbox uid was killed


def test_thread_bomb_hits_the_process_limit(workdir):
    if not DROPS_ROOT:
        pytest.skip("needs the per-sandbox uid (root + world-readable interpreter)")
    with pytest.raises(SandboxError) as e:
        run_task("selftest.threads", {"n": 10_000}, workdir=workdir, limits=replace(QUICK, nproc=32))
    assert e.value.code == "parse_crashed" and "process limit" in e.value.message


def test_unknown_task_and_bad_paths(workdir):
    with pytest.raises(IngestError) as e:
        run_task("os.system", {}, workdir=workdir, limits=QUICK)
    assert e.value.code == "internal"
    with pytest.raises(SandboxError):
        run_task("probe", {"kind": "pdf", "path": "../../etc/passwd"}, workdir=workdir, limits=QUICK)
    Path(workdir, "ok.txt").write_text("x")
    os.symlink("/etc/passwd", Path(workdir, "link"))
    assert safe_output_path(workdir, "ok.txt").endswith("ok.txt")
    for rel in ("../x", "/etc/passwd", "link", "missing"):
        with pytest.raises(SandboxError):
            safe_output_path(workdir, rel)


def test_parse_tasks_check_magic_bytes(workdir):
    Path(workdir, "source.pdf").write_bytes(b"MZ\x90\x00" + b"\x00" * 100)
    with pytest.raises(SandboxError) as e:
        run_task("parse_pdf", {"path": "source.pdf"}, workdir=workdir, limits=QUICK)
    assert e.value.code == "file_type_mismatch"


def test_landlock_required_but_unavailable_fails_closed(workdir, monkeypatch):
    monkeypatch.setattr("kamutan_drawing.sandbox.runner.landlock_available", lambda: False)
    with pytest.raises(SandboxError) as e:
        run_task("selftest.echo", {}, workdir=workdir, limits=replace(QUICK, landlock="require"))
    assert e.value.code == "internal"
