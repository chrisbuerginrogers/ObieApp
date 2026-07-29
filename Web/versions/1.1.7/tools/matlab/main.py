"""
main.py — Export to MATLAB tool.

Parses TRF / AvC / AvR files and writes a .mat file via scipy.io.savemat.

Variable naming in the output .mat:
  labels           - 1×N cell array of dataset names
  {name}_freq      - column vector of frequencies (Hz)
  {name}_mag_db    - column vector of magnitude (dB)
  {name}_H         - column vector of complex FRF (AvC files only)
"""

import io
import re
import math
import js
import numpy as np
import scipy.io
from pyscript.ffi import create_proxy, to_js
from trf_fileio import parse_trf
from avc_fileio import parse_avc, parse_avr

# Accumulated datasets: safe_label -> dict with 'freq', 'mag_db', and optionally 'H'
_datasets = {}


def _safe_name(s):
    """Make a string safe as a MATLAB variable name."""
    s = re.sub(r'[^a-zA-Z0-9_]', '_', s)
    if s and s[0].isdigit():
        s = 'f_' + s
    return s or 'dataset'


def _add_file(path_js, data_js):
    path = str(path_js)
    name = path.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
    ext  = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    stem = name.rsplit('.', 1)[0]

    try:
        raw = bytes(data_js.to_py())

        if ext in ('trf', 'trv'):
            result = parse_trf(raw)
            if result.get('n_rows', 0) == 0:
                js.window.matlabFileError(path, result.get('warnings', ['no data'])[0])
                return
            freq   = np.array(result['freq'],   dtype=np.float64)
            mag_db = np.array(result['mag'],    dtype=np.float64)
            entry  = {'freq': freq, 'mag_db': mag_db}

        elif ext == 'avc':
            p    = parse_avc(raw)
            freq = np.array(p['freqs'], dtype=np.float64)
            H    = np.array(p['H_complex'], dtype=np.complex128)
            mag_db = 20.0 * np.log10(np.maximum(np.abs(H), 1e-12))
            entry  = {'freq': freq, 'mag_db': mag_db, 'H': H}

        elif ext == 'avr':
            p    = parse_avr(raw)
            freq = np.array(p['freqs'], dtype=np.float64)
            data = np.array(p['data'],  dtype=np.float64)
            mag_db = 20.0 * np.log10(np.maximum(np.abs(data), 1e-12))
            entry  = {'freq': freq, 'mag_db': mag_db}

        else:
            js.window.matlabFileError(path, 'unsupported extension: ' + ext)
            return

        # Deduplicate variable name
        safe = _safe_name(stem)
        base, n = safe, 1
        while safe in _datasets:
            safe = f'{base}_{n}'; n += 1
        _datasets[safe] = entry

        n_pts    = len(freq)
        start_hz = float(freq[0])  if n_pts > 0 else 0.0
        stop_hz  = float(freq[-1]) if n_pts > 0 else 0.0
        js.window.matlabFileAdded(path, safe, start_hz, stop_hz, n_pts)

    except Exception as exc:
        js.window.matlabFileError(path, str(exc)[:120])


js.window.pyMatlabAddFile = create_proxy(_add_file)


def _finish(output_name_js):
    global _datasets
    if not _datasets:
        js.window.matlabExportError('No files were successfully parsed')
        return
    try:
        mat = {}

        # Cell array of all labels (1×N)
        mat['labels'] = np.array([list(_datasets.keys())], dtype=object)

        for label, d in _datasets.items():
            mat[label + '_freq']   = d['freq'].reshape(-1, 1)
            mat[label + '_mag_db'] = d['mag_db'].reshape(-1, 1)
            if 'H' in d:
                mat[label + '_H'] = d['H'].reshape(-1, 1)

        buf = io.BytesIO()
        scipy.io.savemat(buf, mat, do_compression=True)
        buf.seek(0)
        mat_bytes = bytearray(buf.read())

        _datasets.clear()
        js.window.matlabExportDone(to_js(mat_bytes), str(output_name_js))

    except Exception as exc:
        _datasets.clear()
        js.window.matlabExportError(str(exc)[:200])


js.window.pyMatlabFinish = create_proxy(_finish)


def _clear():
    _datasets.clear()


js.window.pyMatlabClear = create_proxy(_clear)


def _preview(path_js, data_js):
    """Parse one file and send freq+mag back to JS for the mini plot."""
    path = str(path_js)
    ext  = path.rsplit('.', 1)[-1].lower() if '.' in path else ''
    try:
        raw = bytes(data_js.to_py())
        if ext in ('trf', 'trv'):
            r    = parse_trf(raw)
            freq = r['freq']
            mag  = r['mag']
        elif ext == 'avc':
            p    = parse_avc(raw)
            freq = p['freqs'].tolist()
            mag  = (20.0 * np.log10(np.maximum(np.abs(p['H_complex']), 1e-12))).tolist()
        elif ext == 'avr':
            p    = parse_avr(raw)
            freq = p['freqs'].tolist()
            mag  = (20.0 * np.log10(np.maximum(np.abs(p['data']), 1e-12))).tolist()
        else:
            return
        js.window.matlabPreviewData(to_js(freq), to_js(mag))
    except Exception:
        pass  # silent fail — preview is best-effort


js.window.pyMatlabPreview = create_proxy(_preview)

js.window.matlabPyReady()
