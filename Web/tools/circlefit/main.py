"""
main.py — Circle Fit tool.
Exposes pyCFLoadTRF(pos, filename, bytes) -> onCFTRFLoaded(jsonStr),
pyCFFitModes(freq, re, im, bandsJson, nPasses) -> onCFModesFitted(jsonStr),
pyCFFitNodeResidues(freq, re, im, modesJson) -> onCFNodeResiduesFitted(jsonStr).
"""
import js
import json
from pyscript.ffi import create_proxy
from trf_fileio import parse_trf
from circlefit import fit_modes, fit_node_residues


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
        js.window.onCFTRFLoaded(json.dumps(out))
    except Exception as e:
        js.window.onCFTRFLoaded(json.dumps({'pos': int(position_js), 'error': str(e)}))


def _complex_to_jsonable(z):
    return {'re': z.real, 'im': z.imag}


def _mode_to_jsonable(m):
    out = dict(m)
    if 'A_r' in out and out['A_r'] is not None:
        out['A_r'] = _complex_to_jsonable(out['A_r'])
    return out


def _fit_modes(freq_js, re_js, im_js, bands_js, n_passes_js):
    try:
        freq  = freq_js.to_py()
        re    = re_js.to_py()
        im    = im_js.to_py()
        bands = json.loads(bands_js)
        result = fit_modes(freq, re, im, bands, n_passes=int(n_passes_js))
        out = {
            'modes': [_mode_to_jsonable(m) for m in result['modes']],
            'n_passes_run': result['n_passes_run'],
            'converged': result['converged'],
        }
        js.window.onCFModesFitted(json.dumps(out))
    except Exception as e:
        js.window.onCFModesFitted(json.dumps({'error': str(e)}))


def _fit_node_residues(freq_js, re_js, im_js, modes_js):
    try:
        freq  = freq_js.to_py()
        re    = re_js.to_py()
        im    = im_js.to_py()
        modes = json.loads(modes_js)
        result = fit_node_residues(freq, re, im, modes)
        out = {
            'A_r': [_complex_to_jsonable(z) for z in result['A_r']],
            'residual_const': _complex_to_jsonable(result['residual_const']),
            'residual_mass': _complex_to_jsonable(result['residual_mass']),
        }
        js.window.onCFNodeResiduesFitted(json.dumps(out))
    except Exception as e:
        js.window.onCFNodeResiduesFitted(json.dumps({'error': str(e)}))


js.window.pyCFLoadTRF         = create_proxy(_load_trf)
js.window.pyCFFitModes        = create_proxy(_fit_modes)
js.window.pyCFFitNodeResidues = create_proxy(_fit_node_residues)
js.document.getElementById('loading').classList.add('gone')
