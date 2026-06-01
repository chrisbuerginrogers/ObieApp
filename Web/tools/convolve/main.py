"""
main.py — Convolve entry point.
"""

import js
from pyscript.ffi import create_proxy
from config import configure, load, save
from dsp import load_frf, load_wav, convolve

configure('obieWebApp_convolveIt', {
    "settings": {},
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
    dev_el = js.document.getElementById('out-device-sel')
    save('settings', {})
    save('audio', {
        'output_device_id': dev_el.value if dev_el else '',
    })


_save_proxy = create_proxy(_save_settings)

_el = js.document.getElementById('out-device-sel')
if _el:
    _el.addEventListener('change', _save_proxy)


# ── Restore saved settings ────────────────────────────────────────────────

js.window.ciSavedOutputDeviceId = cfg['audio']['output_device_id']


js.document.getElementById('loading').classList.add('gone')
js.window.onPythonReady()
