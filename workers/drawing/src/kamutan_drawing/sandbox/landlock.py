"""Landlock LSM filesystem/network jail for the parser child (SEC-17), via raw syscalls.

After :func:`restrict` the calling process (and everything it spawns, e.g. tesseract) can:

* read + execute only below the given read-only roots (the interpreter, the venv, the
  package, ``/usr`` …) — so a compromised parser cannot read secrets elsewhere on the host
  and smuggle them into tiles/text artifacts;
* read + write + create only below the sandbox working directory (and ``/dev/null``);
* not connect/bind TCP (ABI ≥ 4) — a second layer under ``unshare -n``;
* not signal or reach abstract unix sockets of processes outside the sandbox (ABI ≥ 6).

Landlock is unprivileged and stackable; unsupported kernels report ABI 0 and the caller
decides (``"auto"`` continues, ``"require"`` fails closed). Syscall numbers 444–446 are
the same on x86-64 and arm64 (generic syscall table).
"""

from __future__ import annotations

import ctypes
import os
from collections.abc import Iterable

SYS_CREATE_RULESET = 444
SYS_ADD_RULE = 445
SYS_RESTRICT_SELF = 446
CREATE_RULESET_VERSION = 1
RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38

EXECUTE = 1 << 0
WRITE_FILE = 1 << 1
READ_FILE = 1 << 2
READ_DIR = 1 << 3
REMOVE_DIR = 1 << 4
REMOVE_FILE = 1 << 5
MAKE_CHAR = 1 << 6
MAKE_DIR = 1 << 7
MAKE_REG = 1 << 8
MAKE_SOCK = 1 << 9
MAKE_FIFO = 1 << 10
MAKE_BLOCK = 1 << 11
MAKE_SYM = 1 << 12
REFER = 1 << 13  # ABI 2
TRUNCATE = 1 << 14  # ABI 3
IOCTL_DEV = 1 << 15  # ABI 5
NET_BIND_TCP = 1 << 0  # ABI 4
NET_CONNECT_TCP = 1 << 1
SCOPE_ABSTRACT_UNIX_SOCKET = 1 << 0  # ABI 6
SCOPE_SIGNAL = 1 << 1

FILE_RIGHTS = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV


class _RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64), ("scoped", ctypes.c_uint64)]


class _PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class LandlockError(OSError):
    pass


def _libc() -> ctypes.CDLL:
    return ctypes.CDLL(None, use_errno=True)


def abi_version() -> int:
    """Landlock ABI of the running kernel; 0 when unavailable (old kernel, disabled LSM, seccomp)."""
    try:
        v = int(_libc().syscall(SYS_CREATE_RULESET, None, ctypes.c_size_t(0), ctypes.c_uint32(CREATE_RULESET_VERSION)))
    except (OSError, AttributeError):
        return 0
    return max(0, v)


def _fs_rights(abi: int) -> int:
    rights = (MAKE_SYM << 1) - 1  # ABI 1: EXECUTE .. MAKE_SYM
    if abi >= 2:
        rights |= REFER
    if abi >= 3:
        rights |= TRUNCATE
    if abi >= 5:
        rights |= IOCTL_DEV
    return rights


def restrict(read_roots: Iterable[str], write_roots: Iterable[str], *, rw_files: Iterable[str] = ("/dev/null",)) -> int:
    """Confine the current process. Returns the ABI used (0 = not available, nothing done).

    Missing paths are skipped. Raises :class:`LandlockError` if Landlock exists but fails.
    """
    abi = abi_version()
    if abi <= 0:
        return 0
    libc = _libc()
    fs = _fs_rights(abi)
    attr = _RulesetAttr(
        fs, (NET_BIND_TCP | NET_CONNECT_TCP) if abi >= 4 else 0, (SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL) if abi >= 6 else 0
    )
    size = 24 if abi >= 6 else (16 if abi >= 4 else 8)
    rfd = int(libc.syscall(SYS_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(size), ctypes.c_uint32(0)))
    if rfd < 0:
        raise LandlockError(ctypes.get_errno(), "landlock_create_ruleset failed")
    try:
        read_dir = (EXECUTE | READ_FILE | READ_DIR) & fs
        seen: set[str] = set()

        def add(path: str, rights: int) -> None:
            real = os.path.realpath(path)
            if not os.path.exists(real):
                return
            if not os.path.isdir(real):
                rights &= FILE_RIGHTS
            key = f"{real}:{rights}"
            if key in seen:
                return
            seen.add(key)
            fd = os.open(real, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = _PathBeneathAttr(rights & fs, fd)
                if (
                    int(
                        libc.syscall(
                            SYS_ADD_RULE,
                            ctypes.c_int(rfd),
                            ctypes.c_int(RULE_PATH_BENEATH),
                            ctypes.byref(rule),
                            ctypes.c_uint32(0),
                        )
                    )
                    != 0
                ):
                    raise LandlockError(ctypes.get_errno(), f"landlock_add_rule failed for {real}")
            finally:
                os.close(fd)

        for p in read_roots:
            add(p, read_dir)
        for p in write_roots:
            add(p, fs)
        for p in rw_files:
            add(p, READ_FILE | WRITE_FILE | TRUNCATE)
        if (
            int(
                libc.prctl(
                    ctypes.c_int(PR_SET_NO_NEW_PRIVS), ctypes.c_ulong(1), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0)
                )
            )
            != 0
        ):
            raise LandlockError(ctypes.get_errno(), "prctl(NO_NEW_PRIVS) failed")
        if int(libc.syscall(SYS_RESTRICT_SELF, ctypes.c_int(rfd), ctypes.c_uint32(0))) != 0:
            raise LandlockError(ctypes.get_errno(), "landlock_restrict_self failed")
    finally:
        os.close(rfd)
    return abi
