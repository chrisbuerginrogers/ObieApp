"""
main.py — Explore tool entry point.

Python-side responsibilities:
  - Parse FRF files via files.load()            → obieExploreAddDataset
  - Load & cache the default WAV                → obieExploreWavReady
  - Convolve a dataset FRF with the default WAV → onExploreConvolveResult
"""

import io
import js
import numpy as np
from pyscript.ffi import create_proxy, to_js
from files import load as _load_file
from config import configure, load as cfg_load

configure('obieWebApp_explore', {
    "settings": {
        "default_wav_url": "../../sample-data/1-Tchaikovsky-short.wav",
        "output_device_id": "",
        "y_db_range": 38,
        "x_min": 200,
        "x_max": 7000,
    },
})

# ── Default WAV state ─────────────────────────────────────────────────────
_default_wav    = None
_default_wav_sr = None


# ── File loading ──────────────────────────────────────────────────────────
def _load_frf(filename_js, data_js):
    fname = str(filename_js)
    ext   = fname.rsplit('.', 1)[-1].lower() if '.' in fname else ''
    try:
        result = _load_file(fname, data_js)
        if result['n_rows'] == 0:
            warns = result.get('warnings') or []
            js.window.obieExploreError(
                fname,
                warns[0] if warns else 'No data in file',
            )
            return
        coh = result.get('coh')
        # Detect whether the source file carries complex FRF data
        if ext in ('trf', 'trv'):
            is_complex = result.get('header', {}).get('fComplex', 'no') == 'yes'
        elif ext == 'avc':
            is_complex = True   # AVC files are complex-averaged FRFs
        else:
            is_complex = False
        js.window.obieExploreAddDataset(
            fname,
            to_js(result['freq']),
            to_js(result['mag']),
            to_js(coh) if coh else None,
            is_complex,
        )
    except Exception as exc:
        js.window.obieExploreError(fname, str(exc)[:120])


js.window.pyExploreLoadFile = create_proxy(_load_frf)


# ── Default WAV loading (bytes passed from JS) ────────────────────────────
def _set_default_wav(data_js, filename_js):
    import scipy.io.wavfile as _wavfile
    global _default_wav, _default_wav_sr
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
        if data.ndim > 1:
            data = data.mean(axis=1)
        peak = np.max(np.abs(data))
        if peak > 0:
            data /= peak
        _default_wav    = data
        _default_wav_sr = int(sr)
        name = str(filename_js).rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
        js.window.obieExploreWavReady(f'{name} · {len(data)/sr:.2f}s · {sr/1000:.1f}kHz')
    except Exception as exc:
        js.window.obieExploreWavError(str(exc)[:120])


js.window.pyExploreSetWav = create_proxy(_set_default_wav)


# ── Convolution (for per-dataset play button) ─────────────────────────────
def _convolve_explore(freqs_js, mags_js):
    from convolution import convolve_it
    if _default_wav is None:
        js.window.onExploreConvolveError('No default WAV loaded — check Settings → Preferences')
        return
    try:
        freqs = np.array(freqs_js.to_py(), dtype=np.float64)
        mags  = np.array(mags_js.to_py(),  dtype=np.float64)
        H = np.power(10.0, mags / 20.0).astype(np.complex128)
        y = convolve_it(_default_wav, freqs, H, _default_wav_sr)
        peak = np.max(np.abs(y))
        if peak > 1e-12:
            y = y / peak * 0.95
        y = np.clip(y, -1.0, 1.0).astype(np.float32)
        js.window.onExploreConvolveResult(to_js(y), _default_wav_sr)
    except Exception as exc:
        js.window.onExploreConvolveError(str(exc)[:120])
        raise


js.window.pyExploreConvolve = create_proxy(_convolve_explore)


# ── TRF writer (called by JS to get binary bytes for group-average save) ─────
def _write_trf(freqs_js, mags_js):
    from trf_fileio import build_trf
    try:
        freqs  = np.array(freqs_js.to_py(),  dtype=np.float64)
        mags   = np.array(mags_js.to_py(),   dtype=np.float64)
        linear = np.power(10.0, mags / 20.0)   # dB → linear magnitude (fComplex=0.0)
        raw    = build_trf(freqs.tolist(), linear.tolist())
        js.window.onExploreTRFReady(to_js(bytearray(raw)))
    except Exception as exc:
        js.window.onExploreTRFError(str(exc)[:120])

js.window.pyExploreWriteTRF = create_proxy(_write_trf)

# ── Signal ready ──────────────────────────────────────────────────────────
js.window.obieExploreReady()
