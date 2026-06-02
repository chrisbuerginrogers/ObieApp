"""
mat_unitTest.py

Load a MATLAB .mat file (Obie time-domain format) and plot the time-domain
signal and its frequency spectrum.
"""

from test_header import ROOT
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path
from fileio.mat_fileio import parse_mat

MAT_PATH = Path("/Users/crogers/Documents/MATLAB/Woodhouse Stuff/cello_pluck_3.mat")

# ── Load ──────────────────────────────────────────────────────────────────────
mat = parse_mat(MAT_PATH)
signal      = mat["data"]
sr          = mat["sample_rate"]
n           = mat["n_samples"]
duration    = mat["duration_s"]
tsmax       = mat["tsmax"]

print(f"File:        {MAT_PATH.name}")
print(f"Sample rate: {sr} Hz")
print(f"Samples:     {n}")
print(f"Duration:    {duration:.3f} s")
if tsmax is not None:
    print(f"tsmax:       {tsmax:.4f} s  (time of signal maximum)")

# ── Build time axis and spectrum ──────────────────────────────────────────────
t          = np.arange(n) / sr
spectrum   = np.abs(np.fft.rfft(signal)) / n
freqs_hz   = np.fft.rfftfreq(n, d=1.0 / sr)
spec_dB    = 20 * np.log10(np.maximum(spectrum, np.finfo(float).eps))
freq_mask  = (freqs_hz >= 20) & (freqs_hz <= sr / 2)

# ── Plot ──────────────────────────────────────────────────────────────────────
BG = "#0d1117"

fig, (ax0, ax1) = plt.subplots(2, 1, figsize=(13, 8))
fig.patch.set_facecolor(BG)
fig.suptitle(MAT_PATH.stem, color="#ffffff", fontsize=12)
fig.subplots_adjust(hspace=0.45)

# Time domain
ax0.set_facecolor(BG)
ax0.plot(t, signal, color="#4488ff", linewidth=0.6)
if tsmax is not None:
    ax0.axvline(tsmax, color="#ffaa33", linewidth=0.8, linestyle="--", label=f"tsmax = {tsmax:.3f} s")
    ax0.legend(facecolor="#1a1f2b", edgecolor="#444444", labelcolor="#dddddd")
ax0.set_xlabel("Time (s)", color="#aaaaaa")
ax0.set_ylabel("Amplitude", color="#dddddd")
ax0.set_title("Time domain", color="#cccccc", fontsize=10)
ax0.tick_params(colors="#aaaaaa")
for spine in ax0.spines.values():
    spine.set_edgecolor("#333333")

# Frequency spectrum
ax1.set_facecolor(BG)
ax1.plot(freqs_hz[freq_mask], spec_dB[freq_mask], color="#44dd88", linewidth=0.7)
ax1.set_xlabel("Frequency (Hz)", color="#aaaaaa")
ax1.set_ylabel("Amplitude (dB)", color="#dddddd")
ax1.set_xscale("log")
ax1.set_title(f"Spectrum  (sr = {sr} Hz,  {n} samples)", color="#cccccc", fontsize=10)
ax1.tick_params(colors="#aaaaaa")
for spine in ax1.spines.values():
    spine.set_edgecolor("#333333")

plt.show()

# ── Basic sanity checks ───────────────────────────────────────────────────────
def _check(label, ok):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        raise AssertionError(label)

print("\n=== Checks ===")
_check("data is 1-D",            signal.ndim == 1)
_check("n_samples matches data",  n == len(signal))
_check("sample_rate > 0",         sr > 0)
_check("duration matches",        np.isclose(duration, n / sr))
_check("signal has non-zero RMS", np.sqrt(np.mean(signal ** 2)) > 0)
