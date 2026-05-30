"""
main.py — TRF Reader entry point.
"""

import js
from pyscript.ffi import create_proxy
from pyscript import when
from config import configure, load, save
from files import on_file_data, on_clear
from dsp import on_bands_change
from dom import set_status

configure('obieWebApp_trfReader', {
    "display": {
        "freq_min":   200,
        "freq_max":   7000,
        "x_log":      True,
        "y_log":      False,
        "y_min":      None,
        "y_max":      None,
        "line_width": 1.8,
    },
    "bands": {"preset": ""},
})

cfg = load()

# ── Initialise plot + axis controls ──────────────────────────────────────
js.window.obieInitPlotControls('plot', js.JSON.parse(
    __import__('json').dumps({
        'xLabel':    'Frequency [Hz]',
        'yLabel':    'Magnitude [dB]',
        'yLog':      cfg['display']['y_log'],
        'xMin':      cfg['display']['freq_min'],
        'xMax':      cfg['display']['freq_max'],
        **({'yMin': cfg['display']['y_min']} if cfg['display']['y_min'] is not None else {}),
        **({'yMax': cfg['display']['y_max']} if cfg['display']['y_max'] is not None else {}),
        'lineWidth': cfg['display']['line_width'],
    })
))

# ── Wire file loader (drag-drop + file-picker) ────────────────────────────
_lc = js.Object.new()
_lc.dropZoneId  = 'dropzone'
_lc.pickerBtnId = 'file-pick-btn'
_lc.fileInputId = 'file-input'
_lc.onData      = create_proxy(on_file_data)
js.window.obieInitFileLoader(_lc)


# ── Persist settings on every control change ──────────────────────────────
def _active_scale(group_id):
    grp = js.document.getElementById(group_id)
    if grp is None:
        return 'log'
    btns = grp.querySelectorAll('button')
    for i in range(btns.length):
        btn = btns.item(i)
        if btn.classList.contains('active'):
            return btn.getAttribute('data-scale')
    return 'log'


def _num(elem_id):
    el = js.document.getElementById(elem_id)
    if el is None:
        return None
    try:
        v = float(el.value)
        return v if v == v else None
    except (ValueError, TypeError):
        return None


def _save_settings(_event=None):
    lw = js.document.getElementById('line-width')
    bs = js.document.getElementById('band-select')
    save('display', {
        'x_log':      _active_scale('x-scale-toggle') == 'log',
        'y_log':      _active_scale('y-scale-toggle') == 'log',
        'freq_min':   _num('x-min'),
        'freq_max':   _num('x-max'),
        'y_min':      _num('y-min'),
        'y_max':      _num('y-max'),
        'line_width': float(lw.value) if lw else 1.8,
    })
    save('bands', {'preset': bs.value if bs else ''})


_save_proxy = create_proxy(_save_settings)

for _gid in ('x-scale-toggle', 'y-scale-toggle'):
    _el = js.document.getElementById(_gid)
    if _el:
        _el.addEventListener('click', _save_proxy)

for _eid in ('x-min', 'x-max', 'y-min', 'y-max'):
    _el = js.document.getElementById(_eid)
    if _el:
        _el.addEventListener('change', _save_proxy)

for _eid, _evt in (('line-width', 'change'), ('band-select', 'change'), ('autoscale-btn', 'click')):
    _el = js.document.getElementById(_eid)
    if _el:
        _el.addEventListener(_evt, _save_proxy)

# ── Restore band preset selection (visual only — no file loaded yet) ───────
_saved_preset = cfg['bands']['preset']
if _saved_preset:
    _el = js.document.getElementById('band-select')
    if _el:
        _el.value = _saved_preset

# ── Clear button ──────────────────────────────────────────────────────────
@when('click', '#clear-btn')
def handle_clear(event):
    on_clear(event)

# ── Band preset dropdown ──────────────────────────────────────────────────
@when('change', '#band-select')
def handle_band_select(event):
    on_bands_change(event.target.value)

# ── Ready ─────────────────────────────────────────────────────────────────
js.document.getElementById('loading').classList.add('gone')
set_status('Drop TRF, AvC, AvR or TSV files here, or click to choose.', 'info')
