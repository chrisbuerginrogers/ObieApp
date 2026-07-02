"""
main.py — WAV Viewer: load stereo WAV files, detect hits, compute FRF.
"""

import io, struct
import numpy as np
import js
from pyscript.ffi import create_proxy, to_js
from frf import FRFAccumulator, add_hit, compute_frf

# ── Settings ───────────────────────────────────────────────────────────────────
_threshold     = 0.05
_pre_trig_s    = 0.01
_post_trig_s   = 0.30
_swap_channels = False   # False → hammer on right (channel 1), mic on left (channel 0)

_MAX_DISPLAY_PTS = 4000  # envelope windows for time-domain display (output is 2× this)


# ── WAV parser ─────────────────────────────────────────────────────────────────
# AudioFormat values in the fmt chunk:
#   1  = PCM integer   (most common, what Acquire writes)
#   3  = IEEE float    (common from DAWs / audio interfaces)
#   65534 = EXTENSIBLE (look at SubFormat GUID bytes 24-39 to determine real format)
_FMT_PCM   = 1
_FMT_FLOAT = 3
_FMT_EXT   = 65534

def _parse_wav(data: bytes):
    """Return (L, R, sr) as float64 ndarrays, handling PCM int and IEEE float."""
    audio_fmt = _FMT_PCM
    sr = 44100
    channels = 1
    bits = 16
    pos = 12  # skip "RIFF" + file-size + "WAVE"
    while pos + 8 <= len(data):
        chunk_id   = data[pos:pos+4]
        chunk_size = struct.unpack_from('<I', data, pos+4)[0]
        body       = pos + 8
        if chunk_id == b'fmt ':
            audio_fmt = struct.unpack_from('<H', data, body)[0]     # body+0
            channels  = struct.unpack_from('<H', data, body+2)[0]   # body+2
            sr        = struct.unpack_from('<I', data, body+4)[0]   # body+4
            bits      = struct.unpack_from('<H', data, body+14)[0]  # body+14
            # EXTENSIBLE: real format is in SubFormat GUID (bytes 8-23 of extension)
            if audio_fmt == _FMT_EXT and chunk_size >= 40:
                audio_fmt = struct.unpack_from('<H', data, body+24)[0]
        elif chunk_id == b'data':
            raw = data[body: body + chunk_size]
            is_float = (audio_fmt == _FMT_FLOAT)
            if is_float and bits == 32:
                s = np.frombuffer(raw, dtype='<f4').astype(np.float64)
            elif is_float and bits == 64:
                s = np.frombuffer(raw, dtype='<f8').astype(np.float64)
            elif bits == 16:
                s = np.frombuffer(raw, dtype='<i2').astype(np.float64) / 32768.0
            elif bits == 24:
                n   = len(raw) // 3
                rb  = np.frombuffer(raw[:n*3], dtype=np.uint8).reshape(n, 3)
                arr = (rb[:, 2].astype(np.int32) << 16 |
                       rb[:, 1].astype(np.int32) << 8  |
                       rb[:, 0].astype(np.int32))
                arr[arr >= 0x800000] -= 0x1000000
                s   = arr.astype(np.float64) / 8388608.0
            elif bits == 32:
                s = np.frombuffer(raw, dtype='<i4').astype(np.float64) / 2147483648.0
            else:
                s = np.frombuffer(raw, dtype='<i2').astype(np.float64) / 32768.0
            step = max(channels, 1)
            L = s[0::step]
            R = s[1::step] if channels >= 2 else s
            return L, R, sr, audio_fmt, bits
        pos += 8 + chunk_size + (chunk_size & 1)  # RIFF chunks are word-aligned
    raise ValueError("No 'data' chunk found in WAV file")


# ── Hit detection ──────────────────────────────────────────────────────────────
def _find_hits(ham, sr):
    n_pre  = max(1, int(_pre_trig_s  * sr))
    n_post = max(1, int(_post_trig_s * sr))
    hits = []
    i = n_pre
    while i < len(ham) - n_post:
        if abs(ham[i]) > _threshold:
            hits.append((max(0, i - n_pre), i, min(len(ham), i + n_post)))
            i += n_post + n_pre  # skip past window
        else:
            i += 1
    return hits, n_pre, n_post


# ── Envelope downsampling ─────────────────────────────────────────────────────
# Stride-based downsampling aliases high-frequency content (hammer pulses, mic
# ringing) into visual noise. Min/max envelope per window preserves waveform
# shape correctly regardless of file length.
def _ds_envelope(t_arr, val_arr):
    N = len(val_arr)
    if N <= _MAX_DISPLAY_PTS:
        return t_arr, val_arr
    chunk = max(2, N // _MAX_DISPLAY_PTS)
    n_win = N // chunk
    idx   = np.arange(0, n_win * chunk, chunk)
    mx = np.maximum.reduceat(val_arr[:n_win * chunk], idx)
    mn = np.minimum.reduceat(val_arr[:n_win * chunk], idx)
    t_win = t_arr[idx]
    # Interleave max/min at the same time point → each window renders as a
    # vertical bar, giving the correct oscilloscope-style waveform envelope.
    t_ds  = np.repeat(t_win, 2)
    v_ds  = np.empty(n_win * 2, dtype=np.float64)
    v_ds[0::2] = mx
    v_ds[1::2] = mn
    return t_ds, v_ds


# ── Public API ─────────────────────────────────────────────────────────────────
def process_wav(data_js, filename_js):
    filename = str(filename_js)
    try:
        data                    = bytes(data_js.to_py())
        L, R, sr, audio_fmt, bits = _parse_wav(data)

        ham = L if _swap_channels else R
        mic = R if _swap_channels else L

        t_full = np.arange(len(ham), dtype=np.float64) / sr
        hits, n_pre, n_post = _find_hits(ham, sr)

        # Compute FRF from all detected hit windows
        freqs = H_dB = coh = None
        if hits:
            acc = FRFAccumulator(sr)
            for (start, trig, end) in hits:
                win_h = ham[start:end].astype(np.float64)
                win_m = mic[start:end].astype(np.float64)
                n = min(len(win_h), len(win_m))
                add_hit(acc, np.column_stack([win_h[:n], win_m[:n]]))
            freqs, _, _, H_dB, coh = compute_frf(acc)

        trig_times = np.array([t_full[trig] for (_, trig, _) in hits])

        t_disp, ham_disp = _ds_envelope(t_full, ham)
        _,      mic_disp = _ds_envelope(t_full, mic)

        fmt_label = f'{bits}-bit {"float" if audio_fmt == _FMT_FLOAT else "int"}'
        js.window.onWavLoaded(
            to_js(t_disp), to_js(ham_disp), to_js(mic_disp),
            to_js(trig_times),
            to_js(freqs) if freqs is not None else None,
            to_js(H_dB)  if H_dB  is not None else None,
            to_js(coh)   if coh   is not None else None,
            len(hits), int(sr), filename, fmt_label
        )
    except Exception as exc:
        js.window.onWavError(filename, str(exc)[:200])


def apply_settings(thr_js, pre_js, post_js, swap_js):
    global _threshold, _pre_trig_s, _post_trig_s, _swap_channels
    _threshold     = max(0.001, float(thr_js))
    _pre_trig_s    = max(0.001, float(pre_js))
    _post_trig_s   = max(0.05,  float(post_js))
    _swap_channels = bool(swap_js)


js.window.pyWavProcess       = create_proxy(process_wav)
js.window.pyWavApplySettings = create_proxy(apply_settings)

if getattr(js.window, 'onPyReady', None):
    js.window.onPyReady()
js.document.getElementById("loading").classList.add("gone")
