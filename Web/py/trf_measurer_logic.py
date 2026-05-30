"""
trf_measurer_logic.py
All intelligence for the TRF Measurer lives here.

Responsibilities:
  - Ring buffer (numpy) + efficient trigger detection
  - State machine: idle → armed → triggered → reviewing → complete
  - H1 FRF averaging (Σ[Gxy] / Σ[Gxx])
  - WAV encoding (stereo 16-bit PCM, pure numpy)
  - TRF binary export
  - Emit plot data and UI state back to JS via window callbacks
"""

import json, struct, base64
import numpy as np
from numpy.fft import rfft, rfftfreq
import js
from pyodide.ffi import to_js

# ── Settings ──────────────────────────────────────────────────────────────────
_sr           = 0      # 0 forces ring allocation on first apply_settings call
_threshold    = 0.05
_window_secs  = 0.30
_pre_trig_s   = 0.02
_n_taps       = 5
_n_positions  = 12
_prefix       = "H"

# ── Ring buffer ───────────────────────────────────────────────────────────────
_RING_SECS = 6
_ring_L    = None   # float64 numpy arrays
_ring_R    = None
_ring_size = 0
_ring_head = 0      # next-write index (mod ring_size)

# ── State machine ─────────────────────────────────────────────────────────────
_state           = "idle"   # idle | armed | triggered | reviewing | complete
_cur_pos         = 0
_pos_hits        = []
_trig_ring_pos   = 0        # ring index of the sample that crossed threshold
_post_trig_left  = 0        # samples still needed after trigger

# Captured window held while user reviews
_cap_hammer = None
_cap_mic    = None

# ── FRF per position ──────────────────────────────────────────────────────────
_frf = {}   # pos → { hits_Gxx, hits_Gxy, n_fft, sr }

# ── WAV accumulation ──────────────────────────────────────────────────────────
_wav_L = []   # mic windows (numpy arrays), one per accepted hit
_wav_R = []   # hammer windows

# ── Live-plot rate limit ──────────────────────────────────────────────────────
_live_counter = 0
_LIVE_EVERY   = 6   # emit live plot once every N process_audio calls


# ═══════════════════════════════════════════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════════════════════════════════════════

def apply_settings(thr_js, win_js, taps_js, npos_js, prefix_js, sr_js):
    global _threshold, _window_secs, _pre_trig_s, _n_taps, _prefix, _sr
    _threshold   = max(0.001, float(thr_js))
    _window_secs = max(0.05,  float(win_js))
    _pre_trig_s  = min(0.05,  _window_secs * 0.08)
    _n_taps      = max(1, int(taps_js))
    _prefix      = str(prefix_js).strip()[:3].upper() or "P"
    new_sr = int(sr_js)
    if new_sr != _sr:
        _reallocate_ring(new_sr)
    new_n = max(1, int(npos_js))
    if new_n != _n_positions or not _pos_hits:
        _init_internal(new_n)
    else:
        _emit_banner()
        _emit_state()


def init_positions(n_js):
    """Full reset — called at startup and when positions count changes."""
    _init_internal(int(n_js))


def stop_audio():
    """Called when the user clicks Stop — resets state to idle and updates UI."""
    global _state
    _state = "idle"
    _emit_state()
    _emit_banner()


def arm():
    """Called by JS after audio hardware is live — transitions Python to armed."""
    global _state
    if _state == "idle":
        _state = "armed"
        _emit_state()
        _emit_banner()


def process_audio(left_js, right_js):
    """
    Called by JS for every audio batch (~46 ms at 44.1 kHz / 2048 batch).
    Fills the numpy ring buffer; uses vectorised numpy for trigger detection.
    All intelligence (trigger, window extraction, state transitions) is here.
    """
    global _state, _trig_ring_pos, _post_trig_left, _live_counter

    if _state not in ("armed", "triggered") or _ring_L is None:
        return

    # Convert JS Float32Arrays to numpy — frombuffer is much faster than list()
    try:
        L = np.frombuffer(left_js.to_py(),  dtype=np.float32).astype(np.float64)
        R = np.frombuffer(right_js.to_py(), dtype=np.float32).astype(np.float64)
    except Exception:
        L = np.array(list(left_js),  dtype=np.float64)
        R = np.array(list(right_js), dtype=np.float64)

    n = len(R)

    if _state == "armed":
        # np.argmax on bool array finds FIRST True in O(n) without a Python loop
        mask = np.abs(R) > _threshold
        if np.any(mask):
            trig_idx = int(np.argmax(mask))
            # Fill ring up to and including the trigger sample
            _push_ring(L[:trig_idx + 1], R[:trig_idx + 1])
            _trig_ring_pos = (_ring_head - 1) % _ring_size
            # Fill remainder of batch
            _push_ring(L[trig_idx + 1:], R[trig_idx + 1:])
            _post_trig_left = int(_window_secs * _sr) - (n - trig_idx - 1)
            if _post_trig_left <= 0:
                _do_capture()
                return
            _state = "triggered"
            _emit_state()
        else:
            _push_ring(L, R)

    elif _state == "triggered":
        _push_ring(L, R)
        _post_trig_left -= n
        if _post_trig_left <= 0:
            _do_capture()
            return

    # Throttled live-plot update
    _live_counter += 1
    if _live_counter >= _LIVE_EVERY:
        _live_counter = 0
        _emit_live()


def accept_hit():
    global _state
    if _state != "reviewing" or _cap_hammer is None:
        return
    _wav_L.append(_cap_mic.copy())
    _wav_R.append(_cap_hammer.copy())
    _pos_hits[_cur_pos] += 1

    # Encode this single hit and push to JS immediately for folder save.
    # (Left = mic, Right = hammer — stereo 16-bit PCM.)
    b64 = _encode_wav_b64(_cap_mic, _cap_hammer, _sr)
    js.window.onSaveHit(b64, _cur_pos, _pos_hits[_cur_pos])

    _add_to_frf(_cur_pos, _cap_hammer, _cap_mic)
    _emit_banner()
    if _pos_hits[_cur_pos] >= _n_taps:
        _complete_position()
    else:
        _rearm()


def reject_hit():
    global _state
    if _state != "reviewing":
        return
    _rearm()


def delete_last_hit():
    if _pos_hits[_cur_pos] <= 0 or _state == "reviewing":
        return
    _pos_hits[_cur_pos] -= 1
    if _wav_L:
        _wav_L.pop()
        _wav_R.pop()
    st = _frf[_cur_pos]
    if st["hits_Gxx"]:
        st["hits_Gxx"].pop()
        st["hits_Gxy"].pop()
    _recompute_frf(_cur_pos)
    _emit_banner()
    _emit_state()


def clear_position():
    _pos_hits[_cur_pos] = 0
    st = _frf[_cur_pos]
    st["hits_Gxx"] = []
    st["hits_Gxy"] = []
    _wav_L.clear()
    _wav_R.clear()
    _recompute_frf(_cur_pos)
    _emit_banner()
    _emit_state()


def jump_to_position(idx_js):
    global _cur_pos
    i = int(idx_js)
    if 0 <= i < _n_positions:
        _cur_pos = i
        _recompute_frf(i)
        _emit_banner()
        _emit_state()


def export_wav():
    """Manual fallback: download all accepted hits as one concatenated WAV."""
    if not _wav_L:
        js.window.onDownload(None, None)
        return
    silence = np.zeros(int(0.1 * _sr))
    pL, pR = [], []
    for i, (m, h) in enumerate(zip(_wav_L, _wav_R)):
        pL.append(m); pR.append(h)
        if i < len(_wav_L) - 1:
            pL.append(silence); pR.append(silence)
    b64 = _encode_wav_b64(np.concatenate(pL), np.concatenate(pR), _sr)
    js.window.onDownload(b64, "trf_capture.wav")


def export_trf():
    """Manual fallback: download current position's averaged TRF."""
    b64 = _build_trf_b64(_frf.get(_cur_pos, {}))
    if not b64:
        js.window.onDownload(None, None)
        return
    label = f"{_prefix}{_cur_pos + 1:02d}"
    js.window.onDownload(b64, f"frf_{label}.trf")


# ═══════════════════════════════════════════════════════════════════════════════
# Internal helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _init_internal(n):
    global _n_positions, _cur_pos, _pos_hits, _frf, _state, _wav_L, _wav_R
    _n_positions = n
    _cur_pos     = 0
    _pos_hits    = [0] * n
    _frf         = {i: {"hits_Gxx": [], "hits_Gxy": [], "n_fft": None, "sr": None}
                    for i in range(n)}
    _wav_L = []; _wav_R = []
    if _state == "complete":
        _state = "idle"
    _emit_banner()
    _emit_state()


def _reallocate_ring(new_sr):
    global _sr, _ring_L, _ring_R, _ring_size, _ring_head
    _sr        = new_sr
    _ring_size = int(_RING_SECS * _sr)
    _ring_L    = np.zeros(_ring_size, dtype=np.float64)
    _ring_R    = np.zeros(_ring_size, dtype=np.float64)
    _ring_head = 0


def _push_ring(L, R):
    """Write chunk into ring using numpy slicing — no Python sample loop."""
    global _ring_head
    n = len(L)
    if n == 0:
        return
    space = _ring_size - _ring_head
    if n <= space:
        _ring_L[_ring_head:_ring_head + n] = L
        _ring_R[_ring_head:_ring_head + n] = R
        _ring_head = (_ring_head + n) % _ring_size
    else:
        _ring_L[_ring_head:] = L[:space];  _ring_R[_ring_head:] = R[:space]
        rem = n - space
        _ring_L[:rem] = L[space:];         _ring_R[:rem] = R[space:]
        _ring_head = rem


def _ring_window_at(center, pre, post):
    """Extract a contiguous window from ring: [center-pre … center+post)."""
    total = pre + post
    start = (center - pre) % _ring_size
    if start + total <= _ring_size:
        return _ring_L[start:start+total].copy(), _ring_R[start:start+total].copy()
    part = _ring_size - start
    L = np.concatenate([_ring_L[start:], _ring_L[:total - part]])
    R = np.concatenate([_ring_R[start:], _ring_R[:total - part]])
    return L, R


def _ring_tail(n):
    """Return last n samples from ring as contiguous numpy arrays."""
    n    = min(n, _ring_size)
    tail = (_ring_head - n) % _ring_size
    if tail + n <= _ring_size:
        return _ring_L[tail:tail+n].copy(), _ring_R[tail:tail+n].copy()
    part = _ring_size - tail
    return (np.concatenate([_ring_L[tail:], _ring_L[:n-part]]),
            np.concatenate([_ring_R[tail:], _ring_R[:n-part]]))


def _do_capture():
    global _state, _cap_hammer, _cap_mic
    pre = int(_pre_trig_s  * _sr)
    post= int(_window_secs * _sr)
    mic_win, ham_win = _ring_window_at(_trig_ring_pos, pre, post)
    _cap_hammer = ham_win
    _cap_mic    = mic_win
    _state = "reviewing"
    _emit_state()
    t = np.linspace(-_pre_trig_s, _window_secs, pre+post, endpoint=False)
    js.window.onTriggered(to_js(t.tolist()), to_js(ham_win.tolist()),
                          to_js(mic_win.tolist()), float(_threshold))


def _rearm():
    global _state
    _state = "armed"
    _emit_state()


def _add_to_frf(pos, hammer, mic):
    st  = _frf[pos]
    win = np.hanning(len(hammer))
    sc  = 2.0 / win.sum()
    H   = rfft(hammer * win) * sc
    M   = rfft(mic    * win) * sc
    st["hits_Gxx"].append(np.abs(H) ** 2)
    st["hits_Gxy"].append(M * np.conj(H))
    st["n_fft"] = len(hammer)
    st["sr"]    = _sr
    _recompute_frf(pos)
    freq = rfftfreq(len(hammer), d=1.0 / _sr)
    Hdb  = 20.0 * np.log10(np.abs(H) + 1e-12)
    js.window.onHammerFFT(to_js(freq.tolist()), to_js(Hdb.tolist()))


def _recompute_frf(pos):
    st = _frf.get(pos, {})
    if not st.get("hits_Gxx"):
        js.window.onFRFUpdate(to_js([]), to_js([]), pos, 0); return
    H1   = sum(st["hits_Gxy"]) / (sum(st["hits_Gxx"]) + 1e-30)
    freq = rfftfreq(st["n_fft"], d=1.0 / st["sr"])
    H1db = 20.0 * np.log10(np.abs(H1) + 1e-12)
    js.window.onFRFUpdate(to_js(freq.tolist()), to_js(H1db.tolist()),
                          pos, len(st["hits_Gxx"]))


def _complete_position():
    global _cur_pos
    st = _frf.get(_cur_pos, {})
    if st.get("hits_Gxx"):
        H1   = sum(st["hits_Gxy"]) / (sum(st["hits_Gxx"]) + 1e-30)
        freq = rfftfreq(st["n_fft"], d=1.0 / st["sr"])
        H1db = 20.0 * np.log10(np.abs(H1) + 1e-12)
        label = f"{_prefix}{_cur_pos+1:02d} ({_n_taps} hits)"
        js.window.onHistoryAdd(to_js(freq.tolist()), to_js(H1db.tolist()), label)
        # Auto-save TRF to the run folder (JS handles the actual write)
        trf_b64 = _build_trf_b64(st)
        if trf_b64:
            js.window.onSaveTRF(trf_b64, _cur_pos)
    _cur_pos += 1
    if _cur_pos >= _n_positions:
        global _state
        _state = "complete"
        _emit_banner(); _emit_state(); return
    _rearm(); _emit_banner()


def _emit_live():
    n    = int(_window_secs * _sr)
    L, R = _ring_tail(n)
    t    = np.linspace(0.0, n / _sr, len(R), endpoint=False)
    js.window.onLivePlot(to_js(t.tolist()), to_js(R.tolist()),
                         to_js(L.tolist()), float(_threshold))


def _emit_state():
    js.window.onStateChange(json.dumps({
        "state": _state, "pos": _cur_pos,
        "label": f"{_prefix}{_cur_pos+1:02d}",
        "hit_n": _pos_hits[_cur_pos] if _cur_pos < len(_pos_hits) else 0,
        "n_taps": _n_taps, "n_positions": _n_positions,
    }))


def _emit_banner():
    js.window.onBannerUpdate(json.dumps([
        {"hits": _pos_hits[i], "n_taps": _n_taps,
         "label": f"{_prefix}{i+1:02d}", "current": i == _cur_pos}
        for i in range(_n_positions)
    ]))


def _build_trf_b64(st):
    """Encode one position's averaged FRF as TRF binary, return base64 or None."""
    if not st.get("hits_Gxx"):
        return None
    N      = st["n_fft"]
    H1     = sum(st["hits_Gxy"]) / (sum(st["hits_Gxx"]) + 1e-30)
    freq   = rfftfreq(N, d=1.0 / st["sr"])
    n_pts  = len(freq)
    hz_res = float(freq[1] - freq[0]) if n_pts > 1 else 1.0
    hdr = bytearray(110)
    struct.pack_into("<I", hdr,  0, 1)
    struct.pack_into("<d", hdr, 38, hz_res)
    struct.pack_into("<d", hdr, 46, float(freq[0]))
    struct.pack_into("<d", hdr, 54, float(freq[-1]))
    struct.pack_into("<f", hdr, 62, 1.0)
    struct.pack_into("<f", hdr, 66, float(n_pts))
    data = bytearray(n_pts * 16)
    for i in range(n_pts):
        struct.pack_into("<d", data, i*16,    float(H1.real[i]))
        struct.pack_into("<d", data, i*16+8,  float(H1.imag[i]))
    return base64.b64encode(bytes(hdr) + bytes(data)).decode("ascii")


def _encode_wav_b64(L, R, sr):
    L = np.clip(L, -1.0, 1.0); R = np.clip(R, -1.0, 1.0)
    n = len(L); nch = 2; bps = 2; db = n * nch * bps
    buf = bytearray(44 + db)
    def _s(o, v): buf[o:o+len(v)] = v.encode()
    def _u32(o, v): struct.pack_into("<I", buf, o, v)
    def _u16(o, v): struct.pack_into("<H", buf, o, v)
    _s(0,"RIFF"); _u32(4,36+db); _s(8,"WAVE"); _s(12,"fmt "); _u32(16,16)
    _u16(20,1); _u16(22,nch); _u32(24,sr); _u32(28,sr*nch*bps)
    _u16(32,nch*bps); _u16(34,16); _s(36,"data"); _u32(40,db)
    iv = np.empty(n*2, dtype=np.int16)
    iv[0::2] = (L * 0x7FFF).astype(np.int16)
    iv[1::2] = (R * 0x7FFF).astype(np.int16)
    buf[44:] = iv.tobytes()
    return base64.b64encode(bytes(buf)).decode("ascii")
