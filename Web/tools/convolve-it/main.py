"""
main.py — Convolve It entry point.
"""

import js
from pyscript.ffi import create_proxy
from pyscript import when
from config import configure, load, save
from dsp import load_frf, load_wav, convolve

configure('obieWebApp_convolveIt', {
    "settings": {
        "gain": 0,
    },
    "audio": {
        "output_device_id": "",
    },
})

cfg = load()

js.window.pyLoadFRF  = create_proxy(load_frf)
js.window.pyLoadWAV  = create_proxy(load_wav)
js.window.pyConvolve = create_proxy(convolve)


# ── Persist settings on every control change ──────────────────────────────

def _save_settings(_event=None):
    gain_el = js.document.getElementById('gain-sl')
    dev_el  = js.document.getElementById('out-device-sel')
    save('settings', {
        'gain': int(gain_el.value) if gain_el else 0,
    })
    save('audio', {
        'output_device_id': dev_el.value if dev_el else '',
    })


_save_proxy = create_proxy(_save_settings)

_el = js.document.getElementById('gain-sl')
if _el:
    _el.addEventListener('change', _save_proxy)

_el = js.document.getElementById('out-device-sel')
if _el:
    _el.addEventListener('change', _save_proxy)


# ── Restore saved settings ────────────────────────────────────────────────

_s = cfg['settings']

js.window.ciSavedOutputDeviceId = cfg['audio']['output_device_id']

_gain_el = js.document.getElementById('gain-sl')
if _gain_el:
    _gain_el.value = str(_s['gain'])
    _sign = '+' if _s['gain'] >= 0 else ''
    _disp = js.document.getElementById('gain-disp')
    if _disp:
        _disp.textContent = f"{_sign}{_s['gain']} dB"


# ── Gain slider readout (live update on drag) ─────────────────────────────

@when('input', '#gain-sl')
def update_gain_display(event):
    v    = int(js.document.getElementById('gain-sl').value)
    sign = '+' if v >= 0 else ''
    js.document.getElementById('gain-disp').textContent = f'{sign}{v} dB'


js.document.getElementById('loading').classList.add('gone')
js.window.onPythonReady()
