#!/usr/bin/env python3
"""
run_tests.py — ObieApp test runner.

Runs the full test suite and prints a per-module summary table.

Usage (from anywhere in the repo):
    python Python/run_tests.py

Or make it executable and run directly:
    chmod +x Python/run_tests.py
    ./Python/run_tests.py
"""

import subprocess
import sys
import re
from pathlib import Path

PYTHON  = sys.executable
SCRIPT  = Path(__file__).parent / "UnitTests" / "test_all.py"

# Maps test class names to human-readable module names and source paths
MODULES = [
    ("TestTrfFileio",    "trf_fileio",    "fileio/trf_fileio.py"),
    ("TestAvcFileio",    "avc_fileio",    "fileio/avc_fileio.py"),
    ("TestMatFileio",    "mat_fileio",    "fileio/mat_fileio.py"),
    ("TestTsvFileio",    "tsv_fileio",    "fileio/tsv_fileio.py"),
    ("TestWavFileio",    "wavfileio",     "fileio/wavfileio.py"),
    ("TestLabviewTxt",   "labview_txt",   "fileio/labview_txt.py"),
    ("TestObieappConfig","obieapp_config","fileio/obieapp_config.py"),
    ("TestRunio",        "runio",         "fileio/runio.py"),
    ("TestFrf",          "frf",           "processing/frf.py"),
    ("TestBands",        "bands",         "processing/bands.py"),
    ("TestConvolution",  "convolution",   "processing/convolution.py"),
    ("TestSpectrogram",  "spectrogram",   "processing/spectrogram.py"),
]


def run_tests():
    import os
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    result = subprocess.run(
        [PYTHON, "-m", "pytest", str(SCRIPT), "-v", "--tb=short",
         "--no-header", "-p", "no:cacheprovider"],
        capture_output=True, text=True,
        cwd=Path(__file__).parent.parent,
        env=env,
    )
    return result.stdout + result.stderr, result.returncode


def parse_results(output: str) -> dict[str, dict]:
    """Return {class_name: {passed, failed, skipped, errors: [str]}}."""
    stats = {cls: {"passed": 0, "failed": 0, "skipped": 0, "errors": []}
             for cls, _, _ in MODULES}

    current_failure = []
    in_failure = False

    for line in output.splitlines():
        # Test result lines:  PASSED / FAILED / SKIPPED / ERROR
        m = re.match(r"^(PASSED|FAILED|SKIPPED|ERROR)\s+\S+::(\w+)::", line)
        if not m:
            m = re.match(r"^\S+::(\w+)::(\w+)\s+(PASSED|FAILED|SKIPPED|ERROR)", line)
            if m:
                status, cls_name = m.group(3), m.group(1)
            else:
                # pytest -v format:  "path::Class::method PASSED"
                m2 = re.search(r"::(\w+)::(\w+)\s+(PASSED|FAILED|SKIPPED|ERROR)", line)
                if m2:
                    cls_name, _, status = m2.group(1), m2.group(2), m2.group(3)
                else:
                    continue
        else:
            status, cls_name = m.group(1), m.group(2)

        if cls_name not in stats:
            continue
        key = status.lower()
        if key in stats[cls_name]:
            stats[cls_name][key] += 1

    # Pick up failure messages
    fail_re = re.compile(r"^FAILED .+::(\w+)::")
    for line in output.splitlines():
        m = fail_re.match(line)
        if m and m.group(1) in stats:
            # trim to just the test name
            test_name = re.search(r"::(\w+)$", line.rstrip())
            if test_name:
                stats[m.group(1)]["errors"].append(test_name.group(1))

    return stats


def print_table(stats: dict, returncode: int):
    COL = ["Module", "Source", "Pass", "Fail", "Skip", "Status"]
    W   = [20,       28,        4,      4,       4,       8]

    def row(*cells):
        return "  ".join(str(c).ljust(w) for c, w in zip(cells, W))

    sep = "  ".join("─" * w for w in W)

    print()
    print("  " + row(*COL))
    print("  " + sep)

    total_p = total_f = total_s = 0
    for cls, mod, src in MODULES:
        s = stats.get(cls, {"passed": 0, "failed": 0, "skipped": 0, "errors": []})
        p, f, sk = s["passed"], s["failed"], s["skipped"]
        total_p += p; total_f += f; total_s += sk
        if f > 0:
            status = f"✗ FAIL ({f})"
        elif p == 0 and sk == 0:
            status = "— no tests"
        elif sk > 0 and p == 0:
            status = f"~ skip ({sk})"
        else:
            status = "✓ pass"
        print("  " + row(mod, src, p or "", f or "", sk or "", status))
        if f > 0:
            for err in s["errors"]:
                print(f"      ↳ {err}")

    print("  " + sep)
    overall = "ALL PASS" if total_f == 0 else f"{total_f} FAILED"
    print("  " + row("TOTAL", "", total_p, total_f or "", total_s or "", overall))
    print()


def main():
    print(f"\nRunning ObieApp test suite…\n  {SCRIPT}\n")

    output, returncode = run_tests()

    # Show any unexpected errors (import failures, etc.)
    error_lines = [l for l in output.splitlines()
                   if "ERROR" in l and "::Test" not in l and l.startswith("E ")]
    if error_lines:
        print("── Errors ──────────────────────────────")
        for l in error_lines[:10]:
            print(" ", l)
        print()

    stats = parse_results(output)
    print_table(stats, returncode)

    # If any failures, show the full pytest output for debugging
    if returncode != 0:
        print("── Detailed output ──────────────────────────────────────────────")
        print(output)

    return returncode


if __name__ == "__main__":
    sys.exit(main())
