"""
dsp.py — Browser orchestration for the Convolve tool (PyScript / JS callbacks).

All heavy computation delegates to canonical Python modules loaded from GitHub:
  wavfileio.py      → WAV reading + normalisation
  spectrogram.py    → STFT spectrogram
  convolution.py    → frequency-domain convolution
  bands.py          → band averaging
"""

import json
import js
import numpy as np
from pyscript.ffi import to_js
from files import load as _load_file
from bands import compute_bands
from wavfileio import load_wav_normalised, load_wav_bytes
from spectrogram import compute_spectrogram

# ── Band presets ──────────────────────────────────────────────────────────
BAND_PRESETS = {
    'violin': [
        {'label': 'Low body',  'start':  200, 'end':  600},
        {'label': 'Mid body',  'start':  600, 'end': 1200},
        {'label': 'Upper mid', 'start': 1200, 'end': 2500},
        {'label': 'Bridge',    'start': 2500, 'end': 4000},
        {'label': 'Brilliant', 'start': 4000, 'end': 7000},
    ],
}

# ── Module-level state ────────────────────────────────────────────────────
_traces      = {}     # label → {'freq': list, 'mag': list}
_preset      = ''     # active band preset key, '' = none
_frf_freqs   = None   # np.ndarray float64, Hz  (left / mono)
_frf_dbs     = None   # np.ndarray float64, dB  (left / mono)
_frf_freqs_r = None   # np.ndarray float64, Hz  (right — stereo only)
_frf_dbs_r   = None   # np.ndarray float64, dB  (right — stereo only)
_wav         = None   # np.ndarray float32, normalised mono
_wav_sr      = None   # int


# ── Band / trace helpers ──────────────────────────────────────────────────

def add_trace(label, freq, mag):
    _traces[label] = {'freq': freq, 'mag': mag}
    _update_bands()


def clear_traces():
    global _traces
    _traces = {}


def _update_bands():
    if not _preset or not _traces:
        js.window.obieClearBands()
        return
    last = list(_traces.values())[-1]
    results = compute_bands(last['freq'], last['mag'], BAND_PRESETS[_preset])
    js.window.obieSetBands(js.JSON.parse(json.dumps(results)))


def on_bands_change(preset_key):
    global _preset
    _preset = preset_key
    _update_bands()


# ── FRF loading ───────────────────────────────────────────────────────────

def load_frf(channel_js, filename_js, data_js):
    global _frf_freqs, _frf_dbs, _frf_freqs_r, _frf_dbs_r
    ch = str(channel_js).upper()
    try:
        result = _load_file(str(filename_js), data_js)
        if result['n_rows'] == 0:
            warns = result.get('warnings') or []
            js.window.onFRFError(ch, warns[0] if warns else 'No data in file')
            return
        freqs = result['freq']
        dbs   = result['mag']
        if ch == 'R':
            _frf_freqs_r = np.array(freqs, dtype=np.float64)
            _frf_dbs_r   = np.array(dbs,   dtype=np.float64)
        else:
            _frf_freqs = np.array(freqs, dtype=np.float64)
            _frf_dbs   = np.array(dbs,   dtype=np.float64)
        info = f'✓ {result["n_rows"]} pts · {freqs[0]:.0f}–{freqs[-1]:.0f} Hz'
        js.window.onFRFResult(ch, to_js(freqs), to_js(dbs), info)
    except Exception as exc:
        js.window.onFRFError(ch, str(exc)[:120])


# ── WAV loading ───────────────────────────────────────────────────────────

def load_wav(filename_js, data_js):
    global _wav, _wav_sr
    try:
        raw = bytes(data_js.to_py())
        # Per-channel spectrograms before mix-down
        raw_data, sr = load_wav_bytes(raw)
        stereo = raw_data.ndim > 1
        if stereo:
            peak = float(np.max(np.abs(raw_data))) or 1.0
            l_norm = (raw_data[:, 0] / peak).astype(np.float64)
            r_norm = (raw_data[:, 1] / peak).astype(np.float64)
        mono, sr = load_wav_normalised(raw)
        _wav    = mono
        _wav_sr = sr
        name = str(filename_js).rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
        info = f'✓ {name} · {len(mono) / sr:.2f} s · {sr / 1000:.1f} kHz'
        js.window.onWavResult(to_js(mono), sr, info)
        if stereo:
            _send_spectrogram(l_norm, sr, 'onInLSpectrogramResult')
            _send_spectrogram(r_norm, sr, 'onInRSpectrogramResult')
        else:
            _send_spectrogram(mono, sr, 'onInLSpectrogramResult')
    except Exception as exc:
        js.window.onWavError(str(exc)[:120])


# ── Convolution ────────────────────────────────────────────────────────────

def convolve():
    from convolution import convolve_it
    try:
        if _wav is None or _frf_freqs is None:
            js.window.onConvolveError('Load an FRF and a WAV file first')
            return

        js.window.setProgMsg('Building impulse response…')
        H_l = np.power(10.0, _frf_dbs / 20.0).astype(np.complex128)

        js.window.setProgMsg('Convolving…')
        if _frf_freqs_r is not None and _frf_dbs_r is not None:
            H_r = np.power(10.0, _frf_dbs_r / 20.0).astype(np.complex128)
            y = convolve_it(_wav, (_frf_freqs, _frf_freqs_r), (H_l, H_r), _wav_sr)
            # y is (N, 2); normalise jointly then interleave for JS
            peak = np.max(np.abs(y))
            if peak > 1e-12:
                y = y / peak * 0.95
            y = np.clip(y, -1.0, 1.0).astype(np.float32)
            interleaved = np.empty(y.shape[0] * 2, dtype=np.float32)
            interleaved[0::2] = y[:, 0]
            interleaved[1::2] = y[:, 1]
            js.window.onConvolveResult(to_js(interleaved), _wav_sr, 2)
            _send_spectrogram(y[:, 0], _wav_sr, 'onOutLSpectrogramResult')
            _send_spectrogram(y[:, 1], _wav_sr, 'onOutRSpectrogramResult')
        else:
            y = convolve_it(_wav, _frf_freqs, H_l, _wav_sr)
            peak = np.max(np.abs(y))
            if peak > 1e-12:
                y = y / peak * 0.95
            y = np.clip(y, -1.0, 1.0).astype(np.float32)
            js.window.onConvolveResult(to_js(y), _wav_sr, 1)
            _send_spectrogram(y, _wav_sr, 'onOutLSpectrogramResult')
    except Exception as exc:
        js.window.onConvolveError(str(exc)[:120])
        raise


# ── Spectrogram ────────────────────────────────────────────────────────────

def _send_spectrogram(sig, sr, cb):
    """Compute spectrogram via canonical module and fire a JS callback."""
    try:
        times, freqs, S_db = compute_spectrogram(sig, sr)
        if S_db.size == 0:
            return
        getattr(js.window, cb)(
            to_js(times),
            to_js(freqs),
            to_js(S_db.flatten()),
            int(S_db.shape[0]),
            int(S_db.shape[1]),
        )
    except Exception as exc:
        print(f'[dsp._send_spectrogram → {cb}] {type(exc).__name__}: {exc}')
