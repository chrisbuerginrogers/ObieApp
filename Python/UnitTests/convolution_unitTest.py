"""
convolution_unitTest.py

Verify that convolve_with_frf and convolve_it produce valid output.

Covers:
  - convolve_with_frf: mono and stereo (file-based API)
  - convolve_it: single FRF (magnitude-only → min-phase path)
  - convolve_it: FRF pair tuple → stereo output with different IRs per channel
  - convolve_it: complex H (non-zero imaginary → min-phase skipped)
"""

from test_header import ROOT, load
import numpy as np
from processing.convolution import convolve_with_frf, convolve_it, _load_frf, _read_wav

cfg      = load()
_SAMPLES = ROOT / cfg['data']['base_dir']
wav_path = _SAMPLES / 'Tchaikovsky.wav'
frf_path = _SAMPLES / 'Betts Strad RHV20 H_001.trf'

# ── Checks ────────────────────────────────────────────────────────────────────
def _check(label, ok):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        raise AssertionError(label)

# ── convolve_with_frf: mono ───────────────────────────────────────────────────
print("\n=== convolve_with_frf: mono ===")
audio_mono, sr = convolve_with_frf(wav_path, frf_path)

_check("returns float32",          audio_mono.dtype == np.float32)
_check("mono shape is 1-D",        audio_mono.ndim  == 1)
_check("sample rate is positive",  sr > 0)
_check("output has samples",       len(audio_mono) > 0)
_check("peak <= 0.9",              np.max(np.abs(audio_mono)) <= 0.9 + 1e-6)
_check("not silent",               np.max(np.abs(audio_mono)) > 1e-6)
_check("no NaN or Inf",            np.all(np.isfinite(audio_mono)))

# ── convolve_with_frf: stereo ─────────────────────────────────────────────────
print("\n=== convolve_with_frf: stereo ===")
audio_stereo, sr2 = convolve_with_frf(wav_path, (frf_path, frf_path))

_check("returns float32",           audio_stereo.dtype == np.float32)
_check("stereo shape is (N, 2)",    audio_stereo.ndim  == 2 and audio_stereo.shape[1] == 2)
_check("same sample rate",          sr2 == sr)
_check("same length as mono",       audio_stereo.shape[0] == len(audio_mono))
_check("peak <= 0.9",               np.max(np.abs(audio_stereo)) <= 0.9 + 1e-6)
_check("not silent",                np.max(np.abs(audio_stereo)) > 1e-6)
_check("no NaN or Inf",             np.all(np.isfinite(audio_stereo)))
_check("channels match (same FRF)", np.allclose(audio_stereo[:, 0], audio_stereo[:, 1]))

# ── convolve_it: single FRF, magnitude-only (min-phase path) ──────────────────
print("\n=== convolve_it: single FRF (magnitude-only → min-phase) ===")
audio_raw, sr_raw = _read_wav(wav_path)
freqs, H_mag = _load_frf(frf_path)   # .trf loads with imag == 0

_check("H has no imaginary content (confirms min-phase path)",
       np.max(np.abs(H_mag.imag)) == 0.0)

out_single = convolve_it(audio_raw, freqs, H_mag, sr_raw)

_check("returns float32",          out_single.dtype == np.float32)
_check("mono shape is 1-D",        out_single.ndim  == 1)
_check("same length as input",     len(out_single)  == len(audio_raw))
_check("not silent",               np.max(np.abs(out_single)) > 1e-6)
_check("no NaN or Inf",            np.all(np.isfinite(out_single)))

# ── convolve_it: FRF pair tuple → stereo output ───────────────────────────────
print("\n=== convolve_it: FRF pair (H_l, H_r) → stereo ===")
freqs2, H_mag2 = _load_frf(frf_path)   # same file; exercises the tuple routing
out_pair = convolve_it(audio_raw, (freqs, freqs2), (H_mag, H_mag2), sr_raw)

_check("returns float32",           out_pair.dtype == np.float32)
_check("stereo shape is (N, 2)",    out_pair.ndim  == 2 and out_pair.shape[1] == 2)
_check("same length as input",      out_pair.shape[0] == len(audio_raw))
_check("not silent",                np.max(np.abs(out_pair)) > 1e-6)
_check("no NaN or Inf",             np.all(np.isfinite(out_pair)))
_check("channels match (same FRF)", np.allclose(out_pair[:, 0], out_pair[:, 1]))

# ── convolve_it: complex H (non-zero imaginary → min-phase skipped) ───────────
print("\n=== convolve_it: complex H (full-phase path) ===")
synth_freqs = np.linspace(20, 20000, 512)
synth_phase = np.linspace(0, -np.pi, 512)
H_complex   = np.ones(512) * np.exp(1j * synth_phase)   # flat mag, linear phase

_check("H has meaningful imaginary content (confirms full-phase path)",
       np.max(np.abs(H_complex.imag)) > 1e-6)

out_complex = convolve_it(audio_raw, synth_freqs, H_complex, sr_raw)

_check("returns float32",          out_complex.dtype == np.float32)
_check("mono shape is 1-D",        out_complex.ndim  == 1)
_check("same length as input",     len(out_complex)  == len(audio_raw))
_check("not silent",               np.max(np.abs(out_complex)) > 1e-6)
_check("no NaN or Inf",            np.all(np.isfinite(out_complex)))

print()
