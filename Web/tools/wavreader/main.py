"""
main.py — WAV Reader

Browser port of the LabVIEW Main_WAV_Reader.vi: take one long two-channel
WAV recording (hammer + microphone), select a time window with two cursors,
threshold-detect the hammer hits inside that window, group them into
positions x taps, and export the split WAVs plus one TRF per position.

All DSP and file I/O comes from the canonical repo modules:
  wavfileio.load_wav_bytes  — WAV parsing        (Python/fileio/wavfileio.py)
  frf.FRFAccumulator/...    — H1/H2 + coherence  (Python/processing/frf.py)
  trf_fileio.build_trf      — TRF writing        (Python/fileio/trf_fileio.py)

LabVIEW mapping
---------------
  Subdivide.vi        -> _find_hits()   (threshold crossing, offset pre-trigger,
                                         Duration-long segments, min separation)
  CalculateFromWAV.vi -> _position_frf() + export_files()
  "Sqrt(H1H2)" method -> _combine() with method='hv'
"""

import json
import struct
from datetime import datetime

import numpy as np
import js
from pyscript.ffi import create_proxy, to_js

from wavfileio import load_wav_bytes
from frf import FRFAccumulator, add_hit, compute_frf
from trf_fileio import build_trf
from avc_fileio import build_avc, build_avr


# ── Loaded file state ─────────────────────────────────────────────────────────
_ham      = None    # hammer channel, float64, normalised to +/-1
_mic      = None    # microphone channel, float64, normalised to +/-1
_sr       = 0
_filename = ''

# ── Parameters (LabVIEW "Params" cluster + Settings tab) ──────────────────────
# Frequency resolution is not a parameter here: one FFT over a Duration-long
# segment fixes the bin spacing at 1/Duration, and the TRF keeps that native
# grid rather than resampling onto a coarser one. The UI shows it read-only.
_P = {
    'duration':   0.30,    # Duration (s)  — length of each extracted segment
    'offset':     0.001,   # offset (s)    — pre-trigger lead-in before the crossing
    'positions':  12,      # Positions
    'taps':       4,       # Taps/Position
    'set_type':   'H',     # Set Type      — position label prefix (H01, H02, ...)
    'threshold':  0.20,    # hammer trigger level (purple line on the hammer plot)
    'ham_cutoff': 0.002,   # Hammer Cutoff (s) — hammer zeroed past this post-trigger
    'mic_cutoff': 0.300,   # Microphone Cutoff (s) — mic zeroed past this post-trigger
    'first_mic':  True,    # First Channel == "Microphone" -> L=mic, R=hammer
    'freq_min':   100.0,   # FRF plot band, recorded in Settings.json
    'freq_max':   10000.0,
    'method':     'hv',    # 'hv' = Sqrt(H1*H2) (LabVIEW default) | 'h1'
}

# Hit list for the current window: list of (start_idx, trig_idx) into the full file.
_hits = []

# The cursor window the current _hits came from, recorded into Notes.txt so an
# exported run says which slice of the source recording it represents.
_window = (0.0, 0.0)

_MAX_DISPLAY_PTS = 4000   # envelope windows for the overview plot (output is 2x this)


# ══════════════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════════════

def _normalise(data):
    """Scale raw WAV samples to +/-1 floats, keeping channels separate.

    wavfileio.load_wav_bytes hands back the file's native dtype;
    load_wav_normalised would mix down to mono, which would throw away the
    hammer/mic separation this tool is built around — so scale here instead.
    """
    if data.dtype == np.int16:
        return data.astype(np.float64) / 32768.0
    if data.dtype == np.int32:
        return data.astype(np.float64) / 2147483648.0
    if data.dtype == np.uint8:
        return (data.astype(np.float64) - 128.0) / 128.0
    return data.astype(np.float64)


def _ds_envelope(t_arr, val_arr):
    """Min/max envelope downsample for the overview plot.

    Plain stride decimation aliases the hammer spikes away entirely; a per-window
    min/max pair renders as a vertical bar and keeps the oscilloscope look.
    """
    n = len(val_arr)
    if n <= _MAX_DISPLAY_PTS:
        return t_arr, val_arr
    chunk = max(2, n // _MAX_DISPLAY_PTS)
    n_win = n // chunk
    idx   = np.arange(0, n_win * chunk, chunk)
    mx    = np.maximum.reduceat(val_arr[:n_win * chunk], idx)
    mn    = np.minimum.reduceat(val_arr[:n_win * chunk], idx)
    t_ds  = np.repeat(t_arr[idx], 2)
    v_ds  = np.empty(n_win * 2, dtype=np.float64)
    v_ds[0::2] = mx
    v_ds[1::2] = mn
    return t_ds, v_ds


def _pos_label(i):
    """Position label, matching Acquire's _pos_label(): H01, H02, ... """
    return f"{_P['set_type']}{i + 1:02d}"


# ══════════════════════════════════════════════════════════════════════════════
# Hit detection — Subdivide.vi
# ══════════════════════════════════════════════════════════════════════════════

def _find_hits(t0, t1):
    """Rising threshold crossings of |hammer| inside [t0, t1].

    Each hit yields a segment of `duration` seconds starting `offset` seconds
    before the crossing. A new crossing is only accepted once the previous
    segment has finished, which is LabVIEW's minimum-separation rule.
    """
    if _ham is None or _sr <= 0:
        return []

    n_total = len(_ham)
    i0 = max(0, int(round(t0 * _sr)))
    i1 = min(n_total, int(round(t1 * _sr)))
    if i1 - i0 < 2:
        return []

    n_dur = max(1, int(round(_P['duration'] * _sr)))
    n_off = max(0, int(round(_P['offset']   * _sr)))
    thr   = _P['threshold']

    seg   = np.abs(_ham[i0:i1])
    above = seg > thr
    # Rising edges only — a crossing is a sample above threshold whose
    # predecessor was below it.
    rising = np.flatnonzero(above[1:] & ~above[:-1]) + 1
    if above.size and above[0]:
        rising = np.concatenate(([0], rising))

    hits = []
    next_ok = -1
    for k in rising:
        if k < next_ok:
            continue
        trig  = i0 + int(k)
        start = trig - n_off
        if start < 0:
            continue
        if start + n_dur > n_total:
            break
        hits.append((start, trig))
        next_ok = k + n_dur
    return hits


def _segment(idx):
    """Return (hammer, mic) for hit `idx`, with the time cutoffs applied.

    Cutoffs are measured from the trigger, matching acquire_logic._h1_from_st:
    everything past the cutoff is zeroed rather than truncated, so every
    segment keeps the same length and the same FFT bin spacing.
    """
    start, _trig = _hits[idx]
    n_dur = max(1, int(round(_P['duration'] * _sr)))
    n_off = max(0, int(round(_P['offset']   * _sr)))
    h = _ham[start:start + n_dur].copy()
    m = _mic[start:start + n_dur].copy()

    ham_cut = n_off + int(round(_P['ham_cutoff'] * _sr))
    mic_cut = n_off + int(round(_P['mic_cutoff'] * _sr))
    if 0 < ham_cut < len(h):
        h[ham_cut:] = 0.0
    if 0 < mic_cut < len(m):
        m[mic_cut:] = 0.0
    return h, m


def _hit_indices(pos):
    """Indices into _hits belonging to position `pos`."""
    taps = max(1, _P['taps'])
    return [i for i in range(pos * taps, min((pos + 1) * taps, len(_hits)))]


# ══════════════════════════════════════════════════════════════════════════════
# FRF — frf.py plus the LabVIEW Sqrt(H1H2) combination
# ══════════════════════════════════════════════════════════════════════════════

def _combine(H1, H2):
    """Apply the selected estimator to the H1/H2 pair returned by compute_frf.

    frf.py defines S_fp = F*conj(P), which makes H1 the conjugate of the true
    mic/hammer transfer function and H2 = S_pp/S_fp = P/F the true one. Acquire
    exports H2 for exactly that reason, so the phase here comes from H2.

    'hv' reproduces LabVIEW's Sqrt(H1H2): the magnitude is the geometric mean of
    the two estimators (it sits between them and is less biased by noise on
    either channel), carried on H2's phase.

    H2 = S_pp/S_fp has no guard on its denominator in frf.py, so it goes inf/nan
    at any bin where the hammer spectrum vanishes — a real occurrence near the
    nulls of a short impulse. Those bins fall back to H1, which is guarded.
    """
    H1_true = np.conj(H1)          # frf.py's H1 is the conjugate of mic/hammer
    if _P['method'] == 'h1':
        return H1_true

    ok  = np.isfinite(H2)
    mag = np.where(ok, np.sqrt(np.abs(H1) * np.abs(np.where(ok, H2, 0.0))),
                   np.abs(H1))
    ph  = np.where(ok, np.angle(np.where(ok, H2, 1.0)), np.angle(H1_true))
    return mag * np.exp(1j * ph)


def _accumulate(indices):
    """Build an FRFAccumulator over the given hit indices."""
    if not indices:
        return None
    acc = FRFAccumulator(sample_rate=_sr)
    for i in indices:
        h, m = _segment(i)
        add_hit(acc, np.column_stack([h, m]))
    return acc


def _frf_of(indices):
    """Return (freq, H_complex, H_dB, coh, n_hits) for the given hits."""
    acc = _accumulate(indices)
    if acc is None or acc.n_hits == 0:
        return None, None, None, None, 0
    freq, H1, H2, _H_dB, coh = compute_frf(acc)
    H    = _combine(H1, H2)
    H_dB = 20.0 * np.log10(np.maximum(np.abs(H), 1e-12))
    return freq, H, H_dB, coh, acc.n_hits


# ══════════════════════════════════════════════════════════════════════════════
# Exposed API
# ══════════════════════════════════════════════════════════════════════════════

def set_params(json_str):
    """Merge a JSON parameter blob from the UI into _P."""
    try:
        incoming = json.loads(str(json_str))
    except Exception:
        return
    for key, val in incoming.items():
        if key not in _P:
            continue
        if key in ('positions', 'taps'):
            _P[key] = max(1, int(val))
        elif key in ('set_type', 'method'):
            _P[key] = str(val)
        elif key == 'first_mic':
            _P[key] = bool(val)
        else:
            _P[key] = float(val)


def load_file(data_js, filename_js):
    """Parse a WAV file and emit the overview waveform."""
    global _ham, _mic, _sr, _filename, _hits
    _filename = str(filename_js).rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
    try:
        raw, sr = load_wav_bytes(bytes(data_js.to_py()))
        data    = _normalise(np.asarray(raw))

        if data.ndim == 1:
            js.window.onWrError(_filename,
                                'Mono file — WAV Reader needs a two-channel '
                                '(hammer + microphone) recording')
            return

        ch_a = data[:, 0]
        ch_b = data[:, 1]
        # "First Channel" picks which of the two is the microphone.
        _mic, _ham = (ch_a, ch_b) if _P['first_mic'] else (ch_b, ch_a)
        _sr   = int(sr)
        _hits = []

        t_full = np.arange(len(_ham), dtype=np.float64) / _sr
        t_ds, ham_ds = _ds_envelope(t_full, _ham)
        _,    mic_ds = _ds_envelope(t_full, _mic)

        js.window.onWrLoaded(
            to_js(t_ds), to_js(ham_ds), to_js(mic_ds),
            _sr, float(len(_ham)) / _sr, _filename, int(data.shape[1]),
        )
    except Exception as exc:
        js.window.onWrError(_filename, str(exc)[:200])


def analyze(t0_js, t1_js):
    """Detect hits in [t0, t1], group into positions, emit summary + FRF."""
    global _hits, _window
    if _ham is None:
        return
    try:
        _window = (float(t0_js), float(t1_js))
        _hits = _find_hits(_window[0], _window[1])

        trig_times = [(_hits[i][1]) / _sr for i in range(len(_hits))]
        taps  = max(1, _P['taps'])
        n_pos = (len(_hits) + taps - 1) // taps

        # Per-position tap counts, up to the declared number of positions.
        counts = []
        for p in range(max(n_pos, _P['positions'])):
            counts.append(len(_hit_indices(p)))

        freq, _H, H_dB, coh, n_used = _frf_of(list(range(len(_hits))))

        js.window.onWrAnalyzed(
            to_js(trig_times),
            to_js(counts),
            len(_hits), n_pos,
            to_js(freq.tolist())  if freq is not None else None,
            to_js(H_dB.tolist())  if H_dB is not None else None,
            to_js(coh.tolist())   if coh  is not None else None,
            n_used,
        )
    except Exception as exc:
        js.window.onWrError(_filename, str(exc)[:200])


def select_hit(idx_js):
    """Emit the hammer/mic time traces and hammer spectrum for one hit."""
    idx = int(idx_js)
    if not (0 <= idx < len(_hits)):
        return
    try:
        h, m  = _segment(idx)
        n_off = max(0, int(round(_P['offset'] * _sr)))
        # Time axis is relative to the trigger, so the pre-trigger lead-in is negative.
        t = (np.arange(len(h), dtype=np.float64) - n_off) / _sr

        # No window function: the hammer pulse already decays to zero inside the
        # segment, and a Hann window would suppress the spike itself.
        H    = np.fft.rfft(h)
        fH   = np.fft.rfftfreq(len(h), d=1.0 / _sr)
        H_dB = 20.0 * np.log10(np.abs(H) + 1e-12)
        H_dB = H_dB - np.max(H_dB)          # normalise to 0 dB peak, like LabVIEW

        taps = max(1, _P['taps'])
        js.window.onWrHit(
            to_js(t.tolist()), to_js(h.tolist()), to_js(m.tolist()),
            to_js(fH.tolist()), to_js(H_dB.tolist()),
            idx, idx // taps, idx % taps, _pos_label(idx // taps),
        )
    except Exception as exc:
        js.window.onWrError(_filename, str(exc)[:200])


def select_position(pos_js):
    """Emit the averaged FRF for one position (-1 = all hits)."""
    pos = int(pos_js)
    try:
        indices = list(range(len(_hits))) if pos < 0 else _hit_indices(pos)
        freq, _H, H_dB, coh, n_used = _frf_of(indices)
        label = 'All hits' if pos < 0 else _pos_label(pos)
        js.window.onWrFRF(
            to_js(freq.tolist()) if freq is not None else None,
            to_js(H_dB.tolist()) if H_dB is not None else None,
            to_js(coh.tolist())  if coh  is not None else None,
            label, n_used,
        )
    except Exception as exc:
        js.window.onWrError(_filename, str(exc)[:200])


def get_audio(t0_js, t1_js):
    """Hand the mic channel for [t0, t1] to JS for playback."""
    if _mic is None:
        return
    i0 = max(0, int(round(float(t0_js) * _sr)))
    i1 = min(len(_mic), int(round(float(t1_js) * _sr)))
    if i1 <= i0:
        js.window.onWrAudio(None, 0)
        return
    js.window.onWrAudio(to_js(_mic[i0:i1].astype(np.float32).tolist()), _sr)


# ── WAV writing ───────────────────────────────────────────────────────────────

def _encode_wav_bytes(L, R, sr):
    """16-bit stereo WAV bytes. Same encoder as acquire_logic._encode_wav_bytes,
    so split segments read back identically to Acquire's own raw/ captures."""
    L = np.clip(L, -1.0, 1.0)
    R = np.clip(R, -1.0, 1.0)
    n = len(L); nch = 2; bps = 2; db = n * nch * bps
    buf = bytearray(44 + db)
    def _s(o, v):   buf[o:o + len(v)] = v.encode()
    def _u32(o, v): struct.pack_into('<I', buf, o, v)
    def _u16(o, v): struct.pack_into('<H', buf, o, v)
    _s(0, 'RIFF'); _u32(4, 36 + db); _s(8, 'WAVE'); _s(12, 'fmt '); _u32(16, 16)
    _u16(20, 1); _u16(22, nch); _u32(24, sr); _u32(28, sr * nch * bps)
    _u16(32, nch * bps); _u16(34, 16); _s(36, 'data'); _u32(40, db)
    iv = np.empty(n * 2, dtype=np.int16)
    iv[0::2] = (L * 0x7FFF).astype(np.int16)
    iv[1::2] = (R * 0x7FFF).astype(np.int16)
    buf[44:] = iv.tobytes()
    return buf


def _emit_text(name, text):
    """Send a UTF-8 text file to the test-folder root."""
    js.window.onWrFile('root', name, to_js(bytearray(text.encode('utf-8'))))


def _build_settings_json(instrument, test, n_pos):
    """Run-settings snapshot, mirroring the Settings.json a desktop Acquire run
    writes alongside Notes.txt (see Python/SampleData/Test violin/)."""
    return json.dumps({
        'data': {'base_dir': instrument},
        'audio': {
            'device_name': f'WAV Reader — {_filename}',
            'format':      'int',
            'sample_rate': _sr,
            'chunk_size':  0,
        },
        'display': {
            'display_seconds': _P['duration'],
            'min_max_decay':   0.995,
            'freq_min':        _P['freq_min'],
            'freq_max':        _P['freq_max'],
        },
        'trigger': {
            'threshold': _P['threshold'],
            'pre_secs':  _P['offset'],
            'post_secs': _P['duration'],
        },
        'run': {
            'instrument':  instrument,
            'folder':      test,
            'designation': _P['set_type'],
            'hits':        _P['taps'],
            'positions':   n_pos,
        },
        'source': {
            'translated_from': _filename,
            'tool':            'WAV Reader',
            'method':          'Sqrt(H1H2)' if _P['method'] == 'hv' else 'H1',
            'ham_cutoff':      _P['ham_cutoff'],
            'mic_cutoff':      _P['mic_cutoff'],
            'window_start':    _window[0],
            'window_end':      _window[1],
        },
    }, indent=2)


def _build_notes_txt(instrument, test, n_pos, n_hits):
    """Notes.txt in the same shape a desktop run writes, with the provenance
    line the split run needs — these hits came out of an existing recording."""
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    return (
        '================================================\n'
        f'Date/Time:   {now}\n'
        f'Instrument:  {instrument}\n'
        f'Folder:      {test}\n'
        f'Designation: {_P["set_type"]}\n'
        f'Positions:   {n_pos}   Hits/pos: {_P["taps"]}\n'
        f'Sample rate: {_sr} Hz\n'
        f'Threshold:   {_P["threshold"]:.4g}   '
        f'Pre: {_P["offset"]:g} s   Post: {_P["duration"]:g} s\n'
        '\n'
        f'Translated from {_filename} by WAV Reader.\n'
        f'Section used: {_window[0]:.3f} s to {_window[1]:.3f} s   '
        f'({n_hits} hits found)\n'
    )


def export_files(test_name_js, instrument_js):
    """Build every output file and hand them to JS one at a time.

    Layout matches Acquire, so the exported run drops straight into Explore /
    Modal Analysis:
        Notes.txt                       provenance — which WAV this came from
        Settings.json                   run-settings snapshot
        <test> <designation>.avc        complex mean across positions
        <test> <designation>.avr        magnitude mean across positions
        raw/<test> <label>_<nnn>.wav    one per tap, L=mic R=hammer, 16-bit
        TRF/<test> <label>.trf          one per position, fComplex=2.0 + coherence
    """
    test       = str(test_name_js).strip() or 'run'
    instrument = str(instrument_js).strip() or test
    if not _hits:
        js.window.onWrExportDone(0, 0, 'No hits to export')
        return

    taps  = max(1, _P['taps'])
    n_pos = (len(_hits) + taps - 1) // taps
    n_wav = n_trf = 0
    freq_ref = None
    pos_H    = []          # one complex FRF per position, for the AvC/AvR means

    try:
        for pos in range(n_pos):
            indices = _hit_indices(pos)
            if not indices:
                continue
            label = _pos_label(pos)

            # One WAV per tap — hit numbering restarts at 1 for each position.
            for tap, i in enumerate(indices):
                h, m = _segment(i)
                name = f"{test} {label}_{tap + 1:03d}.wav"
                js.window.onWrFile('raw', name,
                                   to_js(bytearray(_encode_wav_bytes(m, h, _sr))))
                n_wav += 1

            # One TRF per position, averaged over that position's taps.
            freq, H, _H_dB, coh, n_used = _frf_of(indices)
            if freq is None:
                continue
            if freq_ref is None:
                freq_ref = freq
            pos_H.append(H)
            meta = {
                'sample_rate': str(_sr),
                'bit_depth':   '16',
                'n_hits':      str(n_used),
                'threshold':   f"{_P['threshold']:.4g}",
                'ham_cutoff':  f"{_P['ham_cutoff']:.3f} s",
                'mic_cutoff':  f"{_P['mic_cutoff']:.3f} s",
                'device':      f'WAV Reader ({_filename})',
                'method':      'Sqrt(H1H2)' if _P['method'] == 'hv' else 'H1',
                'source_wav':  _filename,
            }
            trf = build_trf(freq.tolist(), H.tolist(),
                            coherence=coh.tolist(), meta=meta)
            js.window.onWrFile('TRF', f"{test} {label}.trf", to_js(bytearray(trf)))
            n_trf += 1

        # ── Averages across positions ────────────────────────────────────────
        # Same pair acquire_logic._emit_averages writes: AvC is the complex mean
        # (phase-coherent), AvR the mean of the magnitudes. WAV Reader has a
        # single prefix group (Set Type), so there is exactly one pair.
        if pos_H and freq_ref is not None:
            H_stack = np.array(pos_H)                    # (n_pos, n_freqs) complex
            avc = build_avc(freq_ref, H_stack.mean(axis=0), n_averages=len(pos_H))
            avr = build_avr(freq_ref, np.abs(H_stack).mean(axis=0), n_averages=len(pos_H))
            grp = _P['set_type']
            js.window.onWrFile('root', f"{test} {grp}.avc", to_js(bytearray(avc)))
            js.window.onWrFile('root', f"{test} {grp}.avr", to_js(bytearray(avr)))

        # ── Run metadata ─────────────────────────────────────────────────────
        _emit_text('Settings.json', _build_settings_json(instrument, test, n_pos))
        _emit_text('Notes.txt', _build_notes_txt(instrument, test, n_pos, len(_hits)))

        js.window.onWrExportDone(n_wav, n_trf, '')
    except Exception as exc:
        js.window.onWrExportDone(n_wav, n_trf, str(exc)[:200])


# ── Wire up ───────────────────────────────────────────────────────────────────
js.window.pyWrSetParams      = create_proxy(set_params)
js.window.pyWrLoad           = create_proxy(load_file)
js.window.pyWrAnalyze        = create_proxy(analyze)
js.window.pyWrSelectHit      = create_proxy(select_hit)
js.window.pyWrSelectPosition = create_proxy(select_position)
js.window.pyWrGetAudio       = create_proxy(get_audio)
js.window.pyWrExport         = create_proxy(export_files)

if getattr(js.window, 'onPyReady', None):
    js.window.onPyReady()
js.document.getElementById('loading').classList.add('gone')
