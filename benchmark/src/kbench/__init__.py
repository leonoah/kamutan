"""kbench — accuracy benchmark harness for Kamutan (see docs/spec/07_test_plan.md)."""

__version__ = "0.1.0"


def main() -> None:
    import sys

    from .cli import main as _main

    sys.exit(_main())
