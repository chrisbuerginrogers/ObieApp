"""
main.py — Spectrum Monitor entry point.

Live microphone scope: waveform + an averaged magnitude spectrum (block
average of the last N snippets, linear-power averaged then converted to dB —
see _process_snippet) plus an on-demand spectrogram using the canonical
processing/spectrogram.py (loaded from GitHub — see pyscript.toml).

Audio capture itself (getUserMedia / AudioWorklet) has no Python equivalent
and lives entirely in spectrum.js, matching the LiveView precedent (see
CLAUDE.md notes on tools/liveview). This module only does the FFT math.
"""

import js
import numpy as np
from pyscript.ffi import create_proxy, to_js
from spectrogram import compute_spectrogram

# ── Running-average state (power spectra, linear units) ────────────────────
_power_hist = []   # list[np.ndarray], most recent last
_hist_bins  = None


def reset_average(_event=None):
    global _power_hist, _hist_bins
    _power_hist = []
    _hist_bins  = None


def _process_snippet(samples_js, sr_js, n_avg_js):
    global _power_hist, _hist_bins
    try:
        samples = np.asarray(samples_js.to_py(), dtype=np.float64)
        sr      = float(sr_js)
        n_avg   = max(1, int(n_avg_js))
        n       = len(samples)
        if n < 8:
            return

        win     = np.hanning(n)
        windowed = samples * win
        spec    = np.fft.rfft(windowed)
        norm    = np.sum(win) / 2.0 or 1.0
        power   = (np.abs(spec) / norm) ** 2
        freqs   = np.fft.rfftfreq(n, 1.0 / sr)

        if _hist_bins is not None and _hist_bins != len(power):
            _power_hist = []
        _hist_bins = len(power)

        _power_hist.append(power)
        if len(_power_hist) > n_avg:
            _power_hist = _power_hist[-n_avg:]

        avg_power = np.mean(_power_hist, axis=0)
        db = 10.0 * np.log10(np.maximum(avg_power, 1e-12))

        js.window.onSpectrumResult(to_js(freqs), to_js(db), len(_power_hist))
    except Exception as exc:
        print(f'[spectrum._process_snippet] {type(exc).__name__}: {exc}')


def _process_spectrogram_window(samples_js, sr_js):
    try:
        samples = np.asarray(samples_js.to_py(), dtype=np.float64)
        sr      = float(sr_js)
        times, freqs, S_db = compute_spectrogram(samples, sr)
        if S_db.size == 0:
            return
        js.window.onSpectrogramResult(
            to_js(times), to_js(freqs), to_js(S_db.flatten()),
            int(S_db.shape[0]), int(S_db.shape[1]),
        )
    except Exception as exc:
        print(f'[spectrum._process_spectrogram_window] {type(exc).__name__}: {exc}')


js.window.pySpectrum       = create_proxy(_process_snippet)
js.window.pySpectrogram    = create_proxy(_process_spectrogram_window)
js.window.pyResetAverage   = create_proxy(reset_average)

js.document.getElementById('loading').classList.add('gone')
