"""
files.py
────────
File reading, parsing dispatch, and reader callbacks for ObieWebApp2.

Supported formats:
  .trf/.trv — binary Rational Acoustics / MtxVec transfer function
  .avc      — Stoppani/MtxVec complex-averaged FRF
  .avr      — Stoppani/MtxVec real-averaged data (e.g. coherence)
  .tsv      — tab-separated (2-col real or 3-col complex)

Imports are flat (no 'py.' prefix) because the py-config maps all shared
modules to the VFS root: "../../py/foo.py" → "./foo.py".
"""

import math
import js
from pyscript.ffi import to_js
from trf_fileio import parse_trf
from avc_fileio import parse_avc, parse_avr
from tsv_parser import parse_tsv
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


def _parse_csv(text):
    """Parse two-column Frequency,dB CSV (comma-separated)."""
    freqs, dbs = [], []
    for ln in text.strip().split('\n'):
        ln = ln.strip()
        if not ln or (ln[0].isalpha() and ln[0] not in 'eE'):
            continue
        parts = ln.split(',')
        if len(parts) >= 2:
            try:
                f, d = float(parts[0]), float(parts[1])
                if f > 0 and math.isfinite(f) and math.isfinite(d):
                    freqs.append(f)
                    dbs.append(d)
            except ValueError:
                pass
    if len(freqs) < 4:
        raise ValueError('Too few valid rows — check CSV format (Frequency,dB)')
    return {
        'header':   {'Format': 'CSV', 'Columns': '2 (Frequency, Magnitude dB)'},
        'columns':  ['Frequency [Hz]', 'Magnitude [dB]'],
        'freq':     [round(f, 6) for f in freqs],
        'mag':      [round(d, 4) for d in dbs],
        'n_rows':   len(freqs),
        'warnings': [],
    }


def load(filename, js_uint8array):
    """Parse a file from a JS Uint8Array. Returns standard result dict."""
    ext = filename.rsplit('.', 1)[-1].lower()
    raw = bytes(js_uint8array.to_py())
    if ext == 'tsv':
        return parse_tsv(raw.decode('utf-8', errors='replace'))
    if ext in ('trf', 'trv'):
        return parse_trf(raw)
    if ext == 'avc':
        p = parse_avc(raw)
        return _av_standard(p, p['H_complex'])
    if ext == 'avr':
        p = parse_avr(raw)
        return _av_standard(p, p['data'])
    if ext == 'csv':
        return _parse_csv(raw.decode('utf-8', errors='replace'))
    return parse_tsv(raw.decode('utf-8', errors='replace'))  # unknown: try text


def trace_label(filename):
    """Strip path and known extensions to get a clean trace label."""
    label = filename.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
    for suffix in ('.trf', '.trv', '.avc', '.avr', '.tsv'):
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
