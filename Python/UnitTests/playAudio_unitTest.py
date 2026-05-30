"""
playAudio_unitTest.py

Verify that output devices can be listed and that a short test tone plays
without error through the system default device.
choose_device() is interactive so is not tested here.
Uses PyAudio (already a project dependency — no extra install needed).
"""

from test_header import ROOT, load
import numpy as np
from audioio.playAudio import list_output_devices, play

# ── Checks ────────────────────────────────────────────────────────────────────
def _check(label, ok):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        raise AssertionError(label)

# ── Device listing ────────────────────────────────────────────────────────────
print("\n=== playAudio: device listing ===")
devices = list_output_devices()

_check("at least one output device found",  len(devices) > 0)
_check("each entry is a 3-tuple",           all(len(d) == 3 for d in devices))
_check("device indices are ints",           all(isinstance(d[0], int) for d in devices))
_check("device names are strings",          all(isinstance(d[1], str) for d in devices))
_check("channel counts are positive ints",  all(isinstance(d[2], int) and d[2] > 0 for d in devices))

print("\n  Output devices:")
for idx, name, ch in devices:
    print(f"    [{idx}]  {name}  ({ch}ch)")

# ── Playback: short 440 Hz tone through the default device ────────────────────
print("\n=== playAudio: playback (0.5 s tone, default device) ===")
SR     = 44100
t      = np.linspace(0, 0.5, int(SR * 0.5), endpoint=False)
tone   = (np.sin(2 * np.pi * 440 * t) * 0.4).astype(np.float32)

try:
    play(tone, SR, device=None)
    _check("play completed without error", True)
except Exception as e:
    _check(f"play completed without error  ({e})", False)

print()
