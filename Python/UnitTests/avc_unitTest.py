"""
avc_unitTest.py

Read the sample .AvC and .AvR files from SampleData and plot them.
"""

from test_header import ROOT, load
import numpy as np
import matplotlib.pyplot as plt
from fileio.avc_fileio import parse_avc, parse_avr, build_avc, build_avr

_SAMPLE_DIR = ROOT / load('data')['base_dir']
#_SAMPLE_DIR = Path('/Users/crogers/Rogers Dropbox/Chris Rogers/Violin Stuff/Old/AVR read')

avc_path = _SAMPLE_DIR / "Violin 03 H.AvC"
avr_path = _SAMPLE_DIR / "Violin 03 H.AvR"
#avc_path = _SAMPLE_DIR / "Titian Strad All groups.AvC"
#avr_path = _SAMPLE_DIR / "Titian Strad All groups.AvR"

avc = parse_avc(avc_path.read_bytes())
avr = parse_avr(avr_path.read_bytes())

# ── Print headers ─────────────────────────────────────────────────────────────
print("=== .AvC header ===")
for k, v in avc.items():
    if k not in ("freqs", "H_complex"):
        print(f"  {k:20s} {v}")
print(f"  {'freqs':20s} {avc['freqs'][0]:.2f} – {avc['freqs'][-1]:.2f} Hz  ({len(avc['freqs'])} bins)")
print(f"  {'H_complex':20s} {len(avc['H_complex'])} complex values")

print("\n=== .AvR header ===")
for k, v in avr.items():
    if k not in ("freqs", "data"):
        print(f"  {k:20s} {v}")
print(f"  {'freqs':20s} {avr['freqs'][0]:.2f} – {avr['freqs'][-1]:.2f} Hz  ({len(avr['freqs'])} bins)")

# ── Plot ──────────────────────────────────────────────────────────────────────
BG = "#0d1117"

fig, ax = plt.subplots(figsize=(12, 5))
fig.patch.set_facecolor(BG)
fig.suptitle(avc_path.stem, color="#ffffff", fontsize=12)

H_dB   = 20 * np.log10(np.maximum(np.abs(avc["H_complex"]), np.finfo(float).eps))
avr_dB = 20 * np.log10(np.maximum(avr["data"],              np.finfo(float).eps))

ax.set_facecolor(BG)
ax.plot(avc["freqs"], H_dB,   color="#44dd88", linewidth=0.9, label=".AvC — complex avg FRF")
ax.plot(avr["freqs"], avr_dB, color="#ffaa33", linewidth=0.9, label=".AvR — avg magnitude")
ax.set_ylabel("FRF (dB)", color="#dddddd")
ax.set_xlabel("Frequency (Hz)", color="#aaaaaa")
ax.set_xscale("log")
ax.tick_params(colors="#aaaaaa")
ax.legend(facecolor="#1a1f2b", edgecolor="#444444", labelcolor="#dddddd")
for spine in ax.spines.values():
    spine.set_edgecolor("#333333")

plt.show()

# ── Round-trip tests ──────────────────────────────────────────────────────────
def _check(label, ok):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        raise AssertionError(label)

print("\n=== Round-trip: .AvC ===")
avc_rt_path = _SAMPLE_DIR / "test.AvC"
avc_rt_path.write_bytes(build_avc(
    avc["freqs"], avc["H_complex"],
    data_type=avc["data_type"], scale_factor=avc["scale_factor"],
    n_averages=avc["n_averages"], averaging_type=avc["averaging_type"],
))
avc2 = parse_avc(avc_rt_path.read_bytes())
_check("data_type",      avc2["data_type"]     == avc["data_type"])
_check("n_averages",     avc2["n_averages"]    == avc["n_averages"])
_check("averaging_type", avc2["averaging_type"]== avc["averaging_type"])
_check("hz_res",         np.isclose(avc2["hz_res"],    avc["hz_res"]))
_check("start_freq",     np.isclose(avc2["start_freq"],avc["start_freq"]))
_check("scale_factor",   np.isclose(avc2["scale_factor"], avc["scale_factor"]))
_check("freqs array",    np.allclose(avc2["freqs"],    avc["freqs"]))
_check("H_complex array",np.allclose(avc2["H_complex"],avc["H_complex"]))

print("\n=== Round-trip: .AvR ===")
avr_rt_path = _SAMPLE_DIR / "test.AvR"
avr_rt_path.write_bytes(build_avr(
    avr["freqs"], avr["data"],
    data_type=avr["data_type"], scale_factor=avr["scale_factor"],
    n_averages=avr["n_averages"], averaging_type=avr["averaging_type"],
))
avr2 = parse_avr(avr_rt_path.read_bytes())
_check("data_type",      avr2["data_type"]     == avr["data_type"])
_check("n_averages",     avr2["n_averages"]    == avr["n_averages"])
_check("averaging_type", avr2["averaging_type"]== avr["averaging_type"])
_check("hz_res",         np.isclose(avr2["hz_res"],    avr["hz_res"]))
_check("start_freq",     np.isclose(avr2["start_freq"],avr["start_freq"]))
_check("scale_factor",   np.isclose(avr2["scale_factor"], avr["scale_factor"]))
_check("freqs array",    np.allclose(avr2["freqs"],    avr["freqs"]))
_check("data array",     np.allclose(avr2["data"],     avr["data"]))

avc_rt_path.unlink()
avr_rt_path.unlink()
