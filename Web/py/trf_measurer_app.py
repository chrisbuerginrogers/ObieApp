"""trf_measurer_app.py — entry point. ≤ 20 lines."""
import js
from pyodide.ffi import create_proxy
from trf_measurer_logic import (
    apply_settings, init_positions, process_audio,
    accept_hit, reject_hit, delete_last_hit,
    clear_position, jump_to_position,
    export_wav, export_trf,
)

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
js.window.onPyReady and js.window.onPyReady()
js.document.getElementById("loading").classList.add("gone")
