"""
trf_fileio.py
─────────────
Parse and build binary .trf files (Rational Acoustics / MtxVec format).

Header format (little-endian, 110 bytes total):
  I       index
  4d      Xr, Yr, Xactual, YActual
  2s      char_str
  3d      Hz_Resolution, Start_Freq, End_Freq
  11f     fComplex, fLength, ... (9 unused floats)
  4s      caption

fComplex flag:
  0.0 → real magnitude only  (1 double per bin)
  1.0 → complex re/im        (2 doubles per bin)
  2.0 → complex + coherence  (3 doubles per bin: re, im, γ²)

Data from byte 110: doubles as described above.

Metadata extension: after the data bytes, an optional block starting with
the 11-byte marker b'\\x00OBIE_META\\n' followed by UTF-8 "key: value" lines.
Older readers stop at the end of the data section and ignore this block.
"""

import struct
import math

_HEADER_FMT  = '<I4d2s3d11f4s'
_HEADER_SIZE = struct.calcsize(_HEADER_FMT)   # 110
_META_MARKER = b'\x00OBIE_META\n'


def parse_trf(data):
    """Parse raw bytes of a .trf file. Returns result dict."""
    if not data or len(data) < _HEADER_SIZE + 8:
        return _blank(['file too short'])

    try:
        h = struct.unpack(_HEADER_FMT, data[:_HEADER_SIZE])
    except struct.error as e:
        return _blank(['header unpack failed: ' + str(e)])

    Hz_Resolution = h[6]
    Start_Freq    = h[7]
    End_Freq      = h[8]
    fComplex      = h[9]
    fLength       = int(h[10])

    fc = round(fComplex)
    if fc == 1:
        dpm = 2          # complex: re + im
    elif fc == 2:
        dpm = 3          # complex + coherence: re + im + γ²
    else:
        dpm = 1          # real magnitude

    is_complex = fc in (1, 2)

    header = {
        'Hz_Resolution': str(round(Hz_Resolution, 6)) + ' Hz',
        'Start_Freq':    str(round(Start_Freq, 4))    + ' Hz',
        'End_Freq':      str(round(End_Freq, 4))      + ' Hz',
        'fComplex':      'yes' if is_complex else 'no',
        'fLength':       str(fLength),
    }

    data_bytes    = data[_HEADER_SIZE:]
    expected_size = fLength * dpm * 8

    if len(data_bytes) < expected_size:
        return _blank(['data section too short'])

    raw = struct.unpack('<' + str(fLength * dpm) + 'd', data_bytes[:expected_size])

    # Metadata block (Obie extension — ignored by older readers)
    remainder = data_bytes[expected_size:]
    if remainder.startswith(_META_MARKER):
        meta_text = remainder[len(_META_MARKER):].decode('utf-8', errors='ignore')
        for line in meta_text.splitlines():
            if ':' in line:
                k, v = line.split(':', 1)
                header[k.strip()] = v.strip()

    freq, mag, coh = [], [], []
    for i in range(fLength):
        f = Start_Freq + i * Hz_Resolution
        if fc == 1:
            re, im = raw[i * 2], raw[i * 2 + 1]
            m = math.sqrt(re * re + im * im)
        elif fc == 2:
            re, im, c = raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]
            m = math.sqrt(re * re + im * im)
            coh.append(round(c, 5))
        else:
            m = abs(raw[i])
        freq.append(round(f, 4))
        mag.append(round(20.0 * math.log10(max(m, 1e-12)), 4))

    result = {
        'header'  : header,
        'columns' : ['Frequency [Hz]', 'Magnitude [dB]'],
        'freq'    : freq,
        'mag'     : mag,
        'n_rows'  : fLength,
        'warnings': [],
    }
    if coh:
        result['coh'] = coh
    return result


def build_trf(freq, data, *,
              coherence=None,
              meta=None,
              index=0,
              Xr=0.0, Yr=0.0, Xactual=0.0, YActual=0.0,
              char_str=b'\x00\x00',
              caption=b'\x00\x00\x00\x00',
              Hz_Resolution=None):
    """Return binary .trf bytes for the given freq and data arrays.

    Args:
        freq:       sequence of frequency values (Hz)
        data:       sequence of float, complex, or (re, im) tuples
        coherence:  optional sequence of γ² values (0–1), same length as freq;
                    when provided with complex data, sets fComplex=2.0
        meta:       optional dict of key/value metadata appended as text block
        Hz_Resolution: override frequency step; inferred from freq if omitted
    """
    n = len(freq)
    if n == 0:
        raise ValueError('freq must not be empty')
    if len(data) != n:
        raise ValueError('freq and data must have the same length')

    pairs = []
    is_complex = False
    for v in data:
        if isinstance(v, complex):
            pairs.append((v.real, v.imag))
            is_complex = True
        elif isinstance(v, (list, tuple)) and len(v) == 2:
            pairs.append((float(v[0]), float(v[1])))
            is_complex = True
        else:
            pairs.append((float(v), 0.0))

    has_coh = coherence is not None and len(coherence) == n

    Start_Freq = float(freq[0])
    End_Freq   = float(freq[-1])

    if Hz_Resolution is None:
        Hz_Resolution = ((End_Freq - Start_Freq) / (n - 1)) if n > 1 else 0.0

    if has_coh and is_complex:
        fComplex_flag = 2.0
        flat = []
        for (re, im), c in zip(pairs, coherence):
            flat.extend([re, im, float(c)])
    elif is_complex:
        fComplex_flag = 1.0
        flat = [v for re, im in pairs for v in (re, im)]
    else:
        fComplex_flag = 0.0
        flat = [re for re, _ in pairs]

    header = struct.pack(
        _HEADER_FMT,
        index,
        Xr, Yr, Xactual, YActual,
        char_str[:2].ljust(2, b'\x00'),
        Hz_Resolution, Start_Freq, End_Freq,
        fComplex_flag,
        float(n),
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        caption[:4].ljust(4, b'\x00'),
    )

    body = struct.pack('<' + str(len(flat)) + 'd', *flat)

    meta_block = b''
    if meta:
        lines = '\n'.join(f"{k}: {v}" for k, v in meta.items() if v not in (None, ''))
        meta_block = _META_MARKER + lines.encode('utf-8')

    return header + body + meta_block


def _blank(warnings):
    return {
        'header': {}, 'columns': [], 'freq': [], 'mag': [],
        'n_rows': 0,  'warnings': warnings,
    }
