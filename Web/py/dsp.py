"""
dsp.py — DSP core for ObieWebApp2 (Convolve It tool).

Public functions
----------------
  load_frf(filename_js, data_js)   — parse FRF via files.load()  → onFRFResult
  load_wav(filename_js, data_js)   — decode WAV bytes             → onWavResult
  convolve(gain_db_js)             — IR convolution               → onConvolveResult
"""

import io
import json
import js
import numpy as np
from pyscript.ffi import to_js
from files import load as _load_file
from bands import compute_bands

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
    import scipy.io.wavfile as _wavfile
    global _wav, _wav_sr
    try:
        raw = bytes(data_js.to_py())
        sr, data = _wavfile.read(io.BytesIO(raw))
        if data.dtype == np.int16:
            data = data.astype(np.float32) / 32768.0
        elif data.dtype == np.int32:
            data = data.astype(np.float32) / 2147483648.0
        elif data.dtype == np.uint8:
            data = (data.astype(np.float32) - 128.0) / 128.0
        else:
            data = data.astype(np.float32)

        # Compute per-channel input spectrograms before mixing down
        stereo = data.ndim > 1
        if stereo:
            peak = np.max(np.abs(data))
            l_norm = (data[:, 0] / peak if peak > 0 else data[:, 0]).astype(np.float64)
            r_norm = (data[:, 1] / peak if peak > 0 else data[:, 1]).astype(np.float64)
            data = data.mean(axis=1)
        peak = np.max(np.abs(data))
        if peak > 0:
            data /= peak
        _wav    = data
        _wav_sr = int(sr)
        name = str(filename_js).rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
        info = f'✓ {name} · {len(data) / sr:.2f} s · {sr / 1000:.1f} kHz'
        js.window.onWavResult(to_js(data), _wav_sr, info)
        if stereo:
            _spectrogram(l_norm, int(sr), 'onInLSpectrogramResult')
            _spectrogram(r_norm, int(sr), 'onInRSpectrogramResult')
        else:
            _spectrogram(_wav, _wav_sr, 'onInLSpectrogramResult')
    except Exception as exc:
        js.window.onWavError(str(exc)[:120])


# ── Convolution ────────────────────────────────────────────────────────────

def convolve(gain_db_js):
    from convolution import convolve_it
    try:
        if _wav is None or _frf_freqs is None:
            js.window.onConvolveError('Load an FRF and a WAV file first')
            return
        gain = 10.0 ** (float(gain_db_js) / 20.0)

        js.window.setProgMsg('Building impulse response…')
        H_l = (np.power(10.0, _frf_dbs / 20.0) * gain).astype(np.complex128)

        js.window.setProgMsg('Convolving…')
        if _frf_freqs_r is not None and _frf_dbs_r is not None:
            H_r = (np.power(10.0, _frf_dbs_r / 20.0) * gain).astype(np.complex128)
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
            _spectrogram(y[:, 0], _wav_sr, 'onOutLSpectrogramResult')
            _spectrogram(y[:, 1], _wav_sr, 'onOutRSpectrogramResult')
        else:
            y = convolve_it(_wav, _frf_freqs, H_l, _wav_sr)
            peak = np.max(np.abs(y))
            if peak > 1e-12:
                y = y / peak * 0.95
            y = np.clip(y, -1.0, 1.0).astype(np.float32)
            js.window.onConvolveResult(to_js(y), _wav_sr, 1)
            _spectrogram(y, _wav_sr, 'onOutLSpectrogramResult')
    except Exception as exc:
        js.window.onConvolveError(str(exc)[:120])
        raise


# ── Spectrogram ────────────────────────────────────────────────────────────

def _spectrogram(sig, sr, cb):
    try:
        sig    = np.asarray(sig, dtype=np.float64)
        n_fft  = 2048
        hop    = 512
        if len(sig) < n_fft:
            return
        win      = np.hanning(n_fft)
        n_frames = max(1, (len(sig) - n_fft) // hop + 1)
        idx    = np.arange(n_frames)[:, None] * hop + np.arange(n_fft)[None, :]
        frames = sig[np.minimum(idx, len(sig) - 1)] * win
        S_db = (20.0 * np.log10(
            np.maximum(np.abs(np.fft.rfft(frames, axis=1)), 1e-10)
        )).T.astype(np.float32)
        freqs = np.fft.rfftfreq(n_fft, 1.0 / sr).astype(np.float32)
        mask  = freqs <= 8000.0
        S_db  = S_db[mask]
        times = (np.arange(n_frames) * hop / sr).astype(np.float32)
        getattr(js.window, cb)(
            to_js(times),
            to_js(freqs[mask]),
            to_js(S_db.flatten()),
            int(S_db.shape[0]),
            int(S_db.shape[1]),
        )
    except Exception as exc:
        print(f'[dsp._spectrogram → {cb}] {type(exc).__name__}: {exc}')
