"""
main.py — Modal Analysis tool (view-only, no acquisition).
Exposes pyMSLoadTRF(pos, filename, bytes) → calls onMSTRFLoaded(jsonStr).
"""
import js
import json
from pyscript.ffi import create_proxy
from trf_fileio import parse_trf


def _load_trf(position_js, filename_js, data_js):
    try:
        pos = int(position_js)
        raw = bytes(data_js.to_py())
        r   = parse_trf(raw)
        out = {'pos': pos, 'freq': r['freq'], 'mag': r['mag']}
        if r.get('re'):
            out['re'] = r['re']
            out['im'] = r['im']
        if r.get('coh'):
            out['coh'] = r['coh']
        js.window.onMSTRFLoaded(json.dumps(out))
    except Exception as e:
        js.window.onMSTRFLoaded(json.dumps({'pos': int(position_js), 'error': str(e)}))


js.window.pyMSLoadTRF = create_proxy(_load_trf)
js.document.getElementById('loading').classList.add('gone')
