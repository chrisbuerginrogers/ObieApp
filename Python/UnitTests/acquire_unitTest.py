"""
acquire_unitTest.py

Replay test for the Acquire pipeline — no hardware required.

Loads the existing WAV files from SampleData/Test violin/Raw/, feeds them
through the FRF accumulator exactly as Acquire.py would, then plots per-position
FRFs and the grand-average AvC/AvR on a single figure.
"""

from test_header import ROOT, load
import re
import numpy as np
import matplotlib.pyplot as plt
from fileio.wavfileio import load_wav
from processing.frf import FRFAccumulator, add_hit, compute_frf, reset_frf, merge_accumulator

_cfg        = load()
RAW_DIR     = ROOT / _cfg['data']['base_dir'] / "Test violin" / "Raw"
SAMPLE_RATE = _cfg['audio']['sample_rate']

# ── Collect and group WAV files by position ───────────────────────────────────
wav_files = sorted(RAW_DIR.glob("*.wav"))
if not wav_files:
    raise FileNotFoundError(f"No WAV files found in {RAW_DIR}")

positions: dict[int, list[Path]] = {}
for p in wav_files:
    m = re.search(r"_(\d{3})_(\d{3})\.wav$", p.name)
    if m:
        pos = int(m.group(1))
        positions.setdefault(pos, []).append(p)

print(f"Found {len(wav_files)} WAV files across {len(positions)} positions")

# ── Run FRF pipeline ──────────────────────────────────────────────────────────
acc_global = FRFAccumulator(sample_rate=SAMPLE_RATE)
per_position: dict[int, tuple] = {}   # pos → (freqs, H_dB, coherence)

for pos, files in sorted(positions.items()):
    acc = FRFAccumulator(sample_rate=SAMPLE_RATE)
    for wav_path in sorted(files):
        data, sr = load_wav(wav_path)
        data = data.astype(np.float32) if data.dtype != np.float32 else data
        add_hit(acc, data)
        print(f"  pos {pos:03d}  hit {len(files)}  {wav_path.name}")
    freqs, _, _, H_dB, coh = compute_frf(acc)
    per_position[pos] = (freqs, H_dB, coh)
    merge_accumulator(acc_global, acc)

freqs_g, _, _, H_dB_g, _ = compute_frf(acc_global)
avg_mag_dB = 20 * np.log10(np.maximum(
    acc_global.sum_H_mag / acc_global.n_hits, np.finfo(float).eps
))

# ── Plot ──────────────────────────────────────────────────────────────────────
BG     = "#0d1117"
COLORS = ["#4488ff", "#ff4444", "#44dd88", "#ffaa33", "#cc88ff"]

fig, axes = plt.subplots(2, 1, figsize=(13, 8), sharex=True)
fig.patch.set_facecolor(BG)
fig.subplots_adjust(hspace=0.35)
fig.suptitle("Acquire replay — SampleData/Test violin", color="#ffffff", fontsize=12)

# Top: per-position FRF
ax0 = axes[0]
ax0.set_facecolor(BG)
for i, (pos, (freqs, H_dB, _)) in enumerate(sorted(per_position.items())):
    ax0.plot(freqs, H_dB, color=COLORS[i % len(COLORS)], linewidth=0.9, label=f"Pos {pos:03d}")
ax0.set_ylabel("FRF (dB)", color="#dddddd")
ax0.set_xscale("log")
ax0.tick_params(colors="#aaaaaa")
ax0.set_title("Per-position FRF (H2)", color="#cccccc", fontsize=10)
ax0.legend(facecolor="#1a1f2b", edgecolor="#444444", labelcolor="#dddddd")
for spine in ax0.spines.values():
    spine.set_edgecolor("#333333")

# Bottom: grand-average AvC and AvR
ax1 = axes[1]
ax1.set_facecolor(BG)
ax1.plot(freqs_g, H_dB_g,     color="#44dd88", linewidth=0.9, label="AvC — complex avg FRF")
ax1.plot(freqs_g, avg_mag_dB, color="#ffaa33", linewidth=0.9, label="AvR — avg magnitude")
ax1.set_ylabel("FRF (dB)", color="#dddddd")
ax1.set_xlabel("Frequency (Hz)", color="#aaaaaa")
ax1.set_xscale("log")
ax1.tick_params(colors="#aaaaaa")
ax1.set_title(f"Grand average  ({acc_global.n_hits} total hits)", color="#cccccc", fontsize=10)
ax1.legend(facecolor="#1a1f2b", edgecolor="#444444", labelcolor="#dddddd")
for spine in ax1.spines.values():
    spine.set_edgecolor("#333333")

plt.show()
