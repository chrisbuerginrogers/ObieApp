"""
main.py — TRF Measurer entry point.
"""

import js
from pyodide.ffi import create_proxy
from config import configure, load, save
from trf_measurer_logic import (
    apply_settings as _apply_settings_impl,
    init_positions, process_audio,
    accept_hit, reject_hit, delete_last_hit,
    clear_position, jump_to_position,
    export_wav, export_trf, stop_audio, arm,
)

configure('obieWebApp_trfMeasurer', {
    "run": {
        "threshold":  0.05,
        "window":     0.30,
        "taps":       5,
        "positions":  12,
        "prefix":     "H",
        "instrument": "",
    },
})

cfg = load()


# ── Persist run settings when Apply is clicked ────────────────────────────
def _save_run_settings():
    def _get(eid):
        el = js.document.getElementById(eid)
        return el.value if el else ''

    save('run', {
        'threshold':  float(_get('inp-threshold') or 0.05),
        'window':     float(_get('inp-window')    or 0.30),
        'taps':       int(float(_get('inp-taps')  or 5)),
        'positions':  int(float(_get('inp-positions') or 12)),
        'prefix':     _get('inp-prefix')     or 'H',
        'instrument': _get('inp-instrument') or '',
    })


def apply_settings(*args, **kwargs):
    _apply_settings_impl(*args, **kwargs)
    _save_run_settings()


# Save instrument name separately whenever it changes
_save_proxy = create_proxy(_save_run_settings)
_el = js.document.getElementById('inp-instrument')
if _el:
    _el.addEventListener('change', _save_proxy)


# ── Restore saved input values ────────────────────────────────────────────
def _set(eid, val):
    el = js.document.getElementById(eid)
    if el is not None and val is not None:
        el.value = str(val)


_r = cfg['run']
_set('inp-threshold', _r['threshold'])
_set('inp-window',    _r['window'])
_set('inp-taps',      _r['taps'])
_set('inp-positions', _r['positions'])
_set('inp-prefix',    _r['prefix'])
_set('inp-instrument', _r['instrument'])


# ── Expose Python functions to JS ─────────────────────────────────────────
js.window.pyApplySettings  = create_proxy(apply_settings)
js.window.pyInitPositions  = create_proxy(init_positions)
js.window.pyProcessAudio   = create_proxy(process_audio)
js.window.pyAcceptHit      = create_proxy(accept_hit)
js.window.pyRejectHit      = create_proxy(reject_hit)
js.window.pyDeleteLastHit  = create_proxy(delete_last_hit)
js.window.pyClearPosition  = create_proxy(clear_position)
js.window.pyJumpToPosition = create_proxy(jump_to_position)
js.window.pyExportWAV      = create_proxy(export_wav)
js.window.pyExportTRF      = create_proxy(export_trf)
js.window.pyStopAudio      = create_proxy(stop_audio)
js.window.pyArm            = create_proxy(arm)
js.window.onPyReady and js.window.onPyReady()
js.document.getElementById("loading").classList.add("gone")
