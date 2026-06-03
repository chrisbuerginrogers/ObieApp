"""
files.py
────────
File reading, parsing dispatch, and reader callbacks for ObieWebApp2.

Supported formats:
  .trf/.trv — binary Rational Acoustics / MtxVec transfer function
  .avc      — Stoppani/MtxVec complex-averaged FRF
  .avr      — Stoppani/MtxVec real-averaged data (e.g. coherence)
  .tsv      — tab-separated (2-col real or 3-col complex)
  .csv      — two-column CSV (Frequency, Magnitude dB)
  .mat      — MATLAB FRF ('yspec' format only; time-domain skipped)

All format parsers live in Python/fileio/ on GitHub and are loaded via
pyscript.toml — this file is only the dispatch/orchestration layer.
"""

import math
import numpy as np
import js
from pyscript.ffi import to_js
from trf_fileio import parse_trf
from avc_fileio import parse_avc, parse_avr
from tsv_fileio import parse_tsv, parse_csv
from mat_fileio import parse_mat_bytes as _parse_mat
from dom import set_status, render_header, render_fileinfo

_DATA_TYPE = ['Accel', 'Mobility', 'Receptance', 'Mic', 'Unknown']
_AVG_TYPE  = ['RMS', 'Mean', 'Complex', 'Geometric', 'None']


def _av_standard(parsed, values):
    """Convert parse_avc / parse_avr output to the standard result dict."""
    freq = [round(float(f), 4) for f in parsed['freqs']]
    mag  = [round(20.0 * math.log10(max(abs(complex(v)), 1e-12)), 4) for v in values]
    dt, at = parsed['data_type'], parsed['averaging_type']
    return {
        'header': {
            'Hz_Resolution': f"{parsed['hz_res']:.6g} Hz",
            'Start_Freq':    f"{parsed['start_freq']:.4g} Hz",
            'Stop_Freq':     f"{parsed['stop_freq']:.4g} Hz",
            'Data_Type':     _DATA_TYPE[dt] if dt < len(_DATA_TYPE) else str(dt),
            'N_Averages':    str(parsed['n_averages']),
            'Avg_Type':      _AVG_TYPE[at]  if at < len(_AVG_TYPE)  else str(at),
        },
        'columns':  ['Frequency [Hz]', 'Magnitude [dB]'],
        'freq':     freq,
        'mag':      mag,
        'n_rows':   len(freq),
        'warnings': [],
    }




def _mat_standard(raw: bytes) -> dict:
    """Convert a .mat FRF file to the standard result dict. Time-domain returns n_rows=0."""
    p = _parse_mat(raw)
    if p['kind'] == 'timedomain':
        return {'freq': [], 'mag': [], 'n_rows': 0,
                'warnings': ['.mat time-domain files cannot be shown as FRF']}
    # FRF format
    freqs = p['freqs']
    mag_db = [round(20.0 * math.log10(max(abs(complex(v)), 1e-12)), 4) for v in p['frf']]
    hz_res = p['hz_res']
    result = {
        'header': {
            'Hz_Resolution': f"{hz_res:.6g} Hz",
            'Start_Freq':    f"{float(freqs[0]):.4g} Hz",
            'Stop_Freq':     f"{float(freqs[-1]):.4g} Hz",
            'Sample_Rate':   f"{p['sample_rate']} Hz",
            'N_pts':         str(p['npts']),
            'Format':        'MATLAB FRF (.mat)',
        },
        'columns':  ['Frequency [Hz]', 'Magnitude [dB]'],
        'freq':     [round(float(f), 4) for f in freqs],
        'mag':      mag_db,
        'n_rows':   len(freqs),
        'warnings': [],
    }
    coh = p.get('coherence')
    if coh is not None and len(coh):
        result['coh'] = [round(float(c), 5) for c in coh]
    return result


def load(filename, js_uint8array):
    """Parse a file from a JS Uint8Array. Returns standard result dict."""
    ext = filename.rsplit('.', 1)[-1].lower()
    raw = bytes(js_uint8array.to_py())
    if ext == 'tsv':
        return parse_tsv(raw)
    if ext in ('trf', 'trv'):
        return parse_trf(raw)
    if ext == 'avc':
        p = parse_avc(raw)
        return _av_standard(p, p['H_complex'])
    if ext == 'avr':
        p = parse_avr(raw)
        return _av_standard(p, p['data'])
    if ext == 'csv':
        return parse_csv(raw)
    if ext == 'mat':
        return _mat_standard(raw)
    label = f'.{ext}' if ext else '(no extension)'
    return {'freq': [], 'mag': [], 'n_rows': 0,
            'warnings': [f'{label} is not a supported file type — use TRF, TRV, AvC, AvR, TSV, CSV, or MAT']}


def trace_label(filename):
    """Strip path and known extensions to get a clean trace label."""
    label = filename.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
    for suffix in ('.trf', '.trv', '.avc', '.avr', '.tsv', '.mat'):
        if label.lower().endswith(suffix):
            return label[:-len(suffix)]
    return label


def on_file_data(filename, size_bytes, js_uint8array):
    """Called from JS once per file dropped or picked."""
    render_fileinfo(filename, size_bytes)
    if js_uint8array is None:
        set_status('Could not read: ' + filename, 'err')
        return

    parsed = load(filename, js_uint8array)
    render_header(parsed.get('header', {}))

    n = parsed.get('n_rows', 0)
    if n == 0:
        warns = parsed.get('warnings') or []
        set_status(warns[0] if warns else 'No data: ' + filename, 'err')
        return

    from dsp import add_trace
    label = trace_label(filename)
    js.window.obieAddTrace(to_js(parsed['freq']), to_js(parsed['mag']), label)
    add_trace(label, parsed['freq'], parsed['mag'])
    set_status('Loaded ' + label, 'ok')


def on_clear(event):
    """Called when the Clear button is clicked."""
    from dsp import clear_traces
    clear_traces()
    js.window.obieClearPlot()
    js.window.obieClearBands()
    box = js.document.getElementById('hdr-box')
    if box:
        box.innerHTML = '<span class="muted">no file loaded</span>'
    set_status('Drop TRF, AvC, AvR or TSV files here, or click to choose.', 'info')
