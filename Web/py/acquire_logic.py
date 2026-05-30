"""
acquire_logic.py — All DSP/state-machine intelligence for the Acquire tool.
"""

import json, struct, base64
import numpy as np
from numpy.fft import rfft, rfftfreq
import js
from pyscript.ffi import to_js
from frf import FRFAccumulator, add_hit, compute_frf
from trf_fileio import build_trf

# ── Settings ──────────────────────────────────────────────────────────────────
_sr             = 0
_threshold      = 0.05
_pre_trig_s     = 0.01
_post_trig_s    = 0.30
_ham_time_cutoff_s = 0.30   # hammer signal zeroed past this time post-trigger
_mic_time_cutoff_s = 0.30   # mic signal zeroed past this time post-trigger
_n_taps         = 5
_n_positions    = 12
_prefix         = "H"
_mic_cal        = 1.0
_ham_cal        = 1.0
_swap_channels  = False   # True → hammer on left input, mic on right
_last_ham_win   = None    # last hammer window stored for FFT re-rendering

# ── Ring buffer ───────────────────────────────────────────────────────────────
_RING_SECS = 6
_ring_L    = None
_ring_R    = None
_ring_size = 0
_ring_head = 0

# ── State machine ─────────────────────────────────────────────────────────────
_state          = "idle"   # idle | armed | triggered | complete
_cur_pos        = 0
_pos_hits       = []
_trig_ring_pos  = 0
_post_trig_left = 0

# ── FRF per position — stores raw time windows so cutoff can be moved later ──
_frf = {}   # pos → { hits_ham, hits_mic, n_fft, sr }

# ── WAV accumulation ──────────────────────────────────────────────────────────
_wav_L = []
_wav_R = []

# ── Live-plot rate limiter ────────────────────────────────────────────────────
_live_counter = 0
_LIVE_EVERY   = 6


# ═══════════════════════════════════════════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════════════════════════════════════════

def apply_settings(thr_js, pre_js, post_js, ham_time_cutoff_js,
                   taps_js, npos_js, prefix_js, mic_cal_js, ham_cal_js, sr_js,
                   swap_js=False, mic_time_cutoff_js=None):
    global _threshold, _pre_trig_s, _post_trig_s
    global _ham_time_cutoff_s, _mic_time_cutoff_s
    global _n_taps, _prefix, _mic_cal, _ham_cal, _sr, _swap_channels
    _threshold      = max(0.001, float(thr_js))
    _pre_trig_s        = max(0.001, float(pre_js))
    _post_trig_s       = max(0.05,  float(post_js))
    _ham_time_cutoff_s = max(0.01,  float(ham_time_cutoff_js))
    _mic_time_cutoff_s = max(0.01,  float(mic_time_cutoff_js)) if mic_time_cutoff_js is not None else _mic_time_cutoff_s
    _n_taps         = max(1,     int(taps_js))
    _prefix         = str(prefix_js).strip()[:3].upper() or "H"
    _mic_cal        = float(mic_cal_js) if float(mic_cal_js) else 1.0
    _ham_cal        = float(ham_cal_js) if float(ham_cal_js) else 1.0
    _swap_channels  = bool(swap_js)
    new_sr          = int(sr_js)
    if new_sr != _sr:
        _reallocate_ring(new_sr)
    new_n = max(1, int(npos_js))
    if new_n != _n_positions or not _pos_hits:
        _init_internal(new_n)
    else:
        for i in range(_n_positions):
            _recompute_frf(i)
        _emit_banner()
        _emit_state()


def init_positions(n_js):
    _init_internal(int(n_js))


def stop_audio():
    global _state
    _state = "idle"
    _emit_state()
    _emit_banner()


def arm():
    global _state
    if _state == "idle":
        _state = "armed"
        _emit_state()
        _emit_banner()


def process_audio(left_js, right_js):
    global _state, _trig_ring_pos, _post_trig_left, _live_counter

    if _state not in ("armed", "triggered") or _ring_L is None:
        return

    try:
        L = np.frombuffer(left_js.to_py(),  dtype=np.float32).astype(np.float64)
        R = np.frombuffer(right_js.to_py(), dtype=np.float32).astype(np.float64)
    except Exception:
        L = np.array(list(left_js),  dtype=np.float64)
        R = np.array(list(right_js), dtype=np.float64)

    n = len(R)

    if _state == "armed":
        trig = L if _swap_channels else R
        mask = np.abs(trig) > _threshold
        if np.any(mask):
            trig_idx = int(np.argmax(mask))
            _push_ring(L[:trig_idx + 1], R[:trig_idx + 1])
            _trig_ring_pos  = (_ring_head - 1) % _ring_size
            _push_ring(L[trig_idx + 1:], R[trig_idx + 1:])
            _post_trig_left = int(_post_trig_s * _sr) - (n - trig_idx - 1)
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

    _live_counter += 1
    if _live_counter >= _LIVE_EVERY:
        _live_counter = 0
        _emit_live()




def delete_last_hit():
    if _pos_hits[_cur_pos] <= 0:
        return
    _pos_hits[_cur_pos] -= 1
    if _wav_L:
        _wav_L.pop()
        _wav_R.pop()
    st = _frf[_cur_pos]
    if st["hits_ham"]:
        st["hits_ham"].pop()
        st["hits_mic"].pop()
    _recompute_frf(_cur_pos)
    _emit_banner()
    _emit_state()


def clear_position():
    _pos_hits[_cur_pos] = 0
    st = _frf[_cur_pos]
    st["hits_ham"] = []
    st["hits_mic"] = []
    _wav_L.clear()
    _wav_R.clear()
    _recompute_frf(_cur_pos)
    _emit_banner()
    _emit_state()


def reset_all():
    global _state
    _state = "idle"
    _init_internal(_n_positions)


def jump_to_position(idx_js):
    global _cur_pos
    i = int(idx_js)
    if 0 <= i < _n_positions:
        _cur_pos = i
        _recompute_frf(i)
        _emit_banner()
        _emit_state()


def export_wav():
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
    js.window.onDownload(b64, "acquire_capture.wav")


def export_trf():
    b64 = _build_trf_b64(_frf.get(_cur_pos, {}))
    if not b64:
        js.window.onDownload(None, None)
        return
    label = f"{_prefix}{_cur_pos + 1:02d}"
    js.window.onDownload(b64, f"acq_{label}.trf")


# ═══════════════════════════════════════════════════════════════════════════════
# Internal helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _init_internal(n):
    global _n_positions, _cur_pos, _pos_hits, _frf, _state, _wav_L, _wav_R
    _n_positions = n
    _cur_pos     = 0
    _pos_hits    = [0] * n
    _frf         = {i: {"hits_ham": [], "hits_mic": [], "n_fft": None, "sr": None}
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
        _ring_L[_ring_head:] = L[:space]
        _ring_R[_ring_head:] = R[:space]
        rem = n - space
        _ring_L[:rem] = L[space:]
        _ring_R[:rem] = R[space:]
        _ring_head = rem


def _ring_window_at(center, pre, post):
    total = pre + post
    start = (center - pre) % _ring_size
    if start + total <= _ring_size:
        return _ring_L[start:start+total].copy(), _ring_R[start:start+total].copy()
    part = _ring_size - start
    Lw = np.concatenate([_ring_L[start:], _ring_L[:total - part]])
    Rw = np.concatenate([_ring_R[start:], _ring_R[:total - part]])
    return Lw, Rw


def _ring_tail(n):
    n    = min(n, _ring_size)
    tail = (_ring_head - n) % _ring_size
    if tail + n <= _ring_size:
        return _ring_L[tail:tail+n].copy(), _ring_R[tail:tail+n].copy()
    part = _ring_size - tail
    return (np.concatenate([_ring_L[tail:], _ring_L[:n-part]]),
            np.concatenate([_ring_R[tail:], _ring_R[:n-part]]))


def _h1_from_st(st):
    """Compute H1 FRF from stored raw hits, applying both time and freq cutoffs.
    Returns (H1_complex, freq_array) or (None, None) if no data."""
    if not st.get("hits_ham"):
        return None, None, None, None
    pre_n   = int(_pre_trig_s * _sr)
    ham_cut = int(_ham_time_cutoff_s * _sr)
    mic_cut = int(_mic_time_cutoff_s * _sr)
    acc = FRFAccumulator(sample_rate=st["sr"])
    for ham, mic in zip(st["hits_ham"], st["hits_mic"]):
        h = ham.copy(); m = mic.copy()
        if pre_n + ham_cut < len(h):
            h[pre_n + ham_cut:] = 0.0
        if pre_n + mic_cut < len(m):
            m[pre_n + mic_cut:] = 0.0
        add_hit(acc, np.column_stack([h, m]))
    # H2 = S_pp/S_fp = P/F = mic/hammer = standard FRF (correct phase for TRF export)
    # H_dB is 20·log10|H1| from the library (same magnitude as H2)
    freq, _, H2, H_dB, coh = compute_frf(acc)
    return H2, H_dB, coh, freq


def _do_capture():
    """Extract triggered window, apply calibration, auto-accept hit."""
    global _state
    pre  = int(_pre_trig_s  * _sr)
    post = int(_post_trig_s * _sr)
    L_win, R_win = _ring_window_at(_trig_ring_pos, pre, post)
    if _swap_channels:
        ham_win, mic_win = L_win, R_win
    else:
        mic_win, ham_win = L_win, R_win

    ham_win = ham_win * _ham_cal
    mic_win = mic_win * _mic_cal

    t = np.linspace(-_pre_trig_s, _post_trig_s, pre + post, endpoint=False)
    js.window.onTriggered(to_js(t.tolist()), to_js(ham_win.tolist()),
                          to_js(mic_win.tolist()), float(_threshold))

    _wav_L.append(mic_win.copy())
    _wav_R.append(ham_win.copy())
    _pos_hits[_cur_pos] += 1

    b64 = _encode_wav_b64(mic_win, ham_win, _sr)
    js.window.onSaveHit(b64, _cur_pos, _pos_hits[_cur_pos])

    _add_to_frf(_cur_pos, ham_win, mic_win)
    _emit_banner()

    if _pos_hits[_cur_pos] >= _n_taps:
        _complete_position()
    else:
        _state = "armed"
        _emit_state()


def _send_hammer_fft(hammer):
    """Compute and send hammer FFT mini plot using current cutoffs."""
    global _last_ham_win
    _last_ham_win = hammer
    # No window needed: hammer is a short impulse that naturally decays to zero.
    # Hanning would suppress the spike (which is near the start of the window)
    # and make noise dominate the spectrum.
    H    = rfft(hammer)
    freq = rfftfreq(len(hammer), d=1.0 / _sr)
    Hdb  = 20.0 * np.log10(np.abs(H) + 1e-12)
    js.window.onHammerFFT(to_js(freq.tolist()), to_js(Hdb.tolist()))


def _add_to_frf(pos, hammer, mic):
    st = _frf[pos]
    st["hits_ham"].append(hammer.copy())
    st["hits_mic"].append(mic.copy())
    st["n_fft"] = len(hammer)
    st["sr"]    = _sr
    _recompute_frf(pos)
    _send_hammer_fft(hammer)


def _recompute_frf(pos):
    st = _frf.get(pos, {})
    H1, H_dB, coh, freq = _h1_from_st(st)
    if H1 is None:
        js.window.onFRFUpdate(to_js([]), to_js([]), to_js([]), pos, 0)
        return
    js.window.onFRFUpdate(to_js(freq.tolist()), to_js(H_dB.tolist()),
                          to_js(coh.tolist()), pos, len(st["hits_ham"]))


def _complete_position():
    global _cur_pos, _state
    st = _frf.get(_cur_pos, {})
    H1, H_dB, _, freq = _h1_from_st(st)
    if H1 is not None:
        label = f"{_prefix}{_cur_pos+1:02d} ({_n_taps} hits)"
        js.window.onHistoryAdd(to_js(freq.tolist()), to_js(H_dB.tolist()), label)
        trf_b64 = _build_trf_b64(st)
        if trf_b64:
            js.window.onSaveTRF(trf_b64, _cur_pos)
    _cur_pos += 1
    if _cur_pos >= _n_positions:
        _state = "complete"
        _emit_banner()
        _emit_state()
        return
    _state = "armed"
    _emit_banner()
    _emit_state()


def _emit_live():
    n    = int(_post_trig_s * _sr)
    Lw, Rw = _ring_tail(n)
    t    = np.linspace(0.0, n / _sr, len(Rw), endpoint=False)
    js.window.onLivePlot(to_js(t.tolist()), to_js(Rw.tolist()),
                         to_js(Lw.tolist()), float(_threshold))


def _emit_state():
    js.window.onStateChange(json.dumps({
        "state":       _state,
        "pos":         _cur_pos,
        "label":       f"{_prefix}{_cur_pos+1:02d}",
        "hit_n":       _pos_hits[_cur_pos] if _cur_pos < len(_pos_hits) else 0,
        "n_taps":      _n_taps,
        "n_positions": _n_positions,
    }))


def _emit_banner():
    js.window.onBannerUpdate(json.dumps([
        {"hits": _pos_hits[i], "n_taps": _n_taps,
         "label": f"{_prefix}{i+1:02d}", "current": i == _cur_pos}
        for i in range(_n_positions)
    ]))


def _build_trf_b64(st):
    _r = _h1_from_st(st); H1, freq = _r[0], _r[3]
    if H1 is None:
        return None
    raw = build_trf(freq.tolist(), H1.tolist())
    return base64.b64encode(raw).decode("ascii")


def _encode_wav_b64(L, R, sr):
    L = np.clip(L, -1.0, 1.0)
    R = np.clip(R, -1.0, 1.0)
    n = len(L); nch = 2; bps = 2; db = n * nch * bps
    buf = bytearray(44 + db)
    def _s(o, v):   buf[o:o+len(v)] = v.encode()
    def _u32(o, v): struct.pack_into("<I", buf, o, v)
    def _u16(o, v): struct.pack_into("<H", buf, o, v)
    _s(0, "RIFF"); _u32(4, 36+db); _s(8, "WAVE"); _s(12, "fmt "); _u32(16, 16)
    _u16(20, 1); _u16(22, nch); _u32(24, sr); _u32(28, sr*nch*bps)
    _u16(32, nch*bps); _u16(34, 16); _s(36, "data"); _u32(40, db)
    iv = np.empty(n * 2, dtype=np.int16)
    iv[0::2] = (L * 0x7FFF).astype(np.int16)
    iv[1::2] = (R * 0x7FFF).astype(np.int16)
    buf[44:] = iv.tobytes()
    return base64.b64encode(bytes(buf)).decode("ascii")
