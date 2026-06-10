"""
main.py — Modal Analysis (Mode Shape) tool entry point.
Wraps acquire_logic for multi-node FRF acquisition and adds
py_get_complex_frfs() for mode shape animation.
"""

import js, json
from pyscript.ffi import create_proxy
from config import configure, load, save
import acquire_logic as _al

configure('obieWebApp_modeshape', {
    "run": {
        "threshold":     0.05,
        "pre_trig_s":    0.01,
        "post_trig_s":   0.30,
        "ham_cut":       0.30,
        "mic_cut":       0.30,
        "taps":          5,
        "mic_cal":       1.0,
        "ham_cal":       1.0,
        "swap_channels": False,
        "sample_rate":   48000,
        "soundcard":     "",
        "frf_x_min":     200,
        "frf_x_max":     7000,
        "frf_y_min":     -10,
        "frf_y_max":     30,
        "db_spread":     38,
        "db_offset":     0,
        "line_width":    0.5,
        "ham_x_min":     0.0,
        "ham_x_max":     0.05,
        "ham_y_min":     -0.1,
        "ham_y_max":     1.0,
        "mic_x_min":     0.0,
        "mic_x_max":     0.3,
        "mic_y_min":     -1.0,
        "mic_y_max":     1.0,
        "fft_x_min":     200,
        "fft_x_max":     10000,
        "fft_y_min":     -25,
        "fft_y_max":     0,
    }
})

cfg = load()
_r  = cfg['run']


def _set(eid, val):
    el = js.document.getElementById(eid)
    if el is not None and val is not None:
        el.value = str(val)


_set('inp-threshold',   _r['threshold'])
_set('inp-pre',         _r['pre_trig_s'])
_set('inp-post',        _r['post_trig_s'])
_set('inp-ham-cut',     _r['ham_cut'])
_set('inp-mic-cut',     _r['mic_cut'])
_set('inp-taps',        _r['taps'])
_set('inp-mic-cal',     _r['mic_cal'])
_set('inp-ham-cal',     _r['ham_cal'])
_set('inp-sample-rate', _r['sample_rate'])
_el_swap = js.document.getElementById('inp-swap-channels')
if _el_swap is not None:
    _el_swap.checked = bool(_r.get('swap_channels', False))


def py_apply_settings(thr, pre, post, ham_cut, taps, n_nodes,
                      mic_cal, ham_cal, sr, swap, mic_cut, device):
    _al.apply_settings(
        thr, pre, post, ham_cut,
        taps, int(n_nodes), 'N',
        mic_cal, ham_cal, sr,
        swap, mic_cut, device
    )


_node_coords = {}   # {str(pos): {'x':float, 'y':float, 'z':float, 'label':str}}


def py_set_geometry(coords_json):
    """Called from JS whenever geometry changes; stores node coords for TRF metadata."""
    global _node_coords
    _node_coords = json.loads(str(coords_json))


def py_build_trf_with_coords(pos):
    """Build TRF bytes for a node including its x/y/z coordinates in metadata."""
    from trf_fileio import build_trf as _build_trf
    pos = int(pos)
    st = _al._frf.get(pos)
    if not st:
        return None
    H1, _H_dB, coh, freq = _al._h1_from_st(st)
    if H1 is None:
        return None
    n_hits  = len(st.get('hits_ham', []))
    coords  = _node_coords.get(str(pos), {})
    meta = {
        'sample_rate': str(_al._sr),
        'bit_depth':   '16',
        'n_hits':      str(n_hits),
        'threshold':   f'{_al._threshold:.4g}',
        'ham_cutoff':  f'{_al._ham_time_cutoff_s:.3f} s',
        'mic_cutoff':  f'{_al._mic_time_cutoff_s:.3f} s',
        'device':      _al._device_name,
        'node_x':      str(coords.get('x', 0)),
        'node_y':      str(coords.get('y', 0)),
        'node_z':      str(coords.get('z', 0)),
        'node_label':  str(coords.get('label', '')),
    }
    coh_list = coh.tolist() if coh is not None else None
    return to_js(bytearray(_build_trf(freq.tolist(), H1.tolist(), coherence=coh_list, meta=meta)))


def py_get_complex_frfs():
    """Return JSON string: nodeIdx → {freq, real, imag, n_hits}."""
    result = {}
    for i, st in _al._frf.items():
        H1, _H_dB, coh, freq = _al._h1_from_st(st)
        if H1 is not None:
            result[str(i)] = {
                'freq':   freq.tolist(),
                'real':   H1.real.tolist(),
                'imag':   H1.imag.tolist(),
                'n_hits': len(st.get('hits_ham', [])),
            }
    return json.dumps(result)


def py_save_prefs(thr, pre, post, ham_cut, mic_cut, taps, mic_cal, ham_cal,
                  sr, swap, db_spread, db_offset, line_width,
                  frf_x_min, frf_x_max, frf_y_min, frf_y_max,
                  ham_x_min, ham_x_max, ham_y_min, ham_y_max,
                  mic_x_min, mic_x_max, mic_y_min, mic_y_max,
                  fft_x_min, fft_x_max, fft_y_min, fft_y_max, soundcard):
    save('run', {
        'threshold':     float(thr),
        'pre_trig_s':    float(pre),
        'post_trig_s':   float(post),
        'ham_cut':       float(ham_cut),
        'mic_cut':       float(mic_cut),
        'taps':          int(float(taps)),
        'mic_cal':       float(mic_cal),
        'ham_cal':       float(ham_cal),
        'swap_channels': bool(swap),
        'sample_rate':   int(float(sr)),
        'soundcard':     str(soundcard),
        'frf_x_min':     float(frf_x_min),
        'frf_x_max':     float(frf_x_max),
        'frf_y_min':     float(frf_y_min),
        'frf_y_max':     float(frf_y_max),
        'db_spread':     float(db_spread),
        'db_offset':     float(db_offset),
        'line_width':    float(line_width),
        'ham_x_min':     float(ham_x_min),
        'ham_x_max':     float(ham_x_max),
        'ham_y_min':     float(ham_y_min),
        'ham_y_max':     float(ham_y_max),
        'mic_x_min':     float(mic_x_min),
        'mic_x_max':     float(mic_x_max),
        'mic_y_min':     float(mic_y_min),
        'mic_y_max':     float(mic_y_max),
        'fft_x_min':     float(fft_x_min),
        'fft_x_max':     float(fft_x_max),
        'fft_y_min':     float(fft_y_min),
        'fft_y_max':     float(fft_y_max),
    })


# Expose to JS
js.window.pyApplySettings   = create_proxy(py_apply_settings)
js.window.pyArm             = create_proxy(_al.arm)
js.window.pyProcessAudio    = create_proxy(_al.process_audio)
js.window.pyDeleteLastHit   = create_proxy(_al.delete_last_hit)
js.window.pyClearPosition   = create_proxy(_al.clear_position)
js.window.pyJumpToNode      = create_proxy(_al.jump_to_position)
js.window.pyResetAll        = create_proxy(_al.reset_all)
js.window.pyStopAudio       = create_proxy(_al.stop_audio)
js.window.pyRepeatPosition  = create_proxy(_al.repeat_position)
js.window.pyPausePosition   = create_proxy(_al.pause_after_position)
js.window.pyAdvancePosition = create_proxy(_al.advance_position)
js.window.pyGetComplexFRFs       = create_proxy(py_get_complex_frfs)
js.window.pySetGeometry          = create_proxy(py_set_geometry)
js.window.pyBuildTRFWithCoords   = create_proxy(py_build_trf_with_coords)
js.window.pySavePrefs            = create_proxy(py_save_prefs)

if getattr(js.window, 'onPyReady', None):
    js.window.onPyReady()
js.document.getElementById('loading').classList.add('gone')
