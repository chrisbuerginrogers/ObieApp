"""
mat_frf_unitTest.py

Load a MATLAB FRF/coherence .mat file ('yspec' format) and plot the
transfer function magnitude and coherence.
"""

from test_header import ROOT
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path
from fileio.mat_fileio import parse_mat_frf

MAT_PATH = Path("/Users/crogers/Downloads/Suemae_violin_cal copy.mat")

# ── Load ──────────────────────────────────────────────────────────────────────
mat = parse_mat_frf(MAT_PATH)
freqs     = mat["freqs"]
frf       = mat["frf"]
coherence = mat["coherence"]
sr        = mat["sample_rate"]
npts      = mat["npts"]
hz_res    = mat["hz_res"]

print(f"File:         {MAT_PATH.name}")
print(f"Sample rate:  {sr} Hz")
print(f"Block length: {npts} pts")
print(f"Freq bins:    {len(freqs)}  ({hz_res:.4f} Hz/bin)")
print(f"Freq range:   {freqs[0]:.1f} – {freqs[-1]:.1f} Hz")
print(f"Coherence:    min={coherence.min():.4f}  max={coherence.max():.4f}")

frf_dB = 20 * np.log10(np.maximum(np.abs(frf), np.finfo(float).eps))

# ── Plot ──────────────────────────────────────────────────────────────────────
BG    = "#0d1117"
FMIN  = 20      # lowest plotted frequency
FMAX  = sr / 2  # Nyquist

mask = (freqs >= FMIN) & (freqs <= FMAX)

fig, (ax0, ax1) = plt.subplots(2, 1, figsize=(13, 8), sharex=True)
fig.patch.set_facecolor(BG)
fig.suptitle(MAT_PATH.stem, color="#ffffff", fontsize=12)
fig.subplots_adjust(hspace=0.15)

# FRF magnitude
ax0.set_facecolor(BG)
ax0.plot(freqs[mask], frf_dB[mask], color="#44dd88", linewidth=0.8)
ax0.set_ylabel("FRF (dB)", color="#dddddd")
ax0.set_title("Transfer function magnitude", color="#cccccc", fontsize=10)
ax0.set_xscale("log")
ax0.tick_params(colors="#aaaaaa")
for spine in ax0.spines.values():
    spine.set_edgecolor("#333333")

# Coherence
ax1.set_facecolor(BG)
ax1.plot(freqs[mask], coherence[mask], color="#ffaa33", linewidth=0.8)
ax1.axhline(0.9, color="#666666", linewidth=0.6, linestyle="--")
ax1.set_ylim(0, 1.05)
ax1.set_ylabel("Coherence", color="#dddddd")
ax1.set_xlabel("Frequency (Hz)", color="#aaaaaa")
ax1.set_title("Coherence", color="#cccccc", fontsize=10)
ax1.set_xscale("log")
ax1.tick_params(colors="#aaaaaa")
for spine in ax1.spines.values():
    spine.set_edgecolor("#333333")

plt.show()

# ── Sanity checks ─────────────────────────────────────────────────────────────
def _check(label, ok):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        raise AssertionError(label)

print("\n=== Checks ===")
_check("kind is 'frf'",                   mat["kind"] == "frf")
_check("freqs is 1-D",                    freqs.ndim == 1)
_check("frf is complex",                  np.iscomplexobj(frf))
_check("coherence is real",               not np.iscomplexobj(coherence))
_check("freqs and frf same length",       len(freqs) == len(frf))
_check("freqs and coherence same length", len(freqs) == len(coherence))
_check("coherence in [0, 1]",             coherence.min() >= 0 and coherence.max() <= 1)
_check("bin count matches npts",          len(freqs) == npts // 2 + 1)
_check("hz_res matches sample_rate/npts", np.isclose(hz_res, sr / npts))
