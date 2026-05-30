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

Data from byte 110: alternating float64 real/imag pairs if complex,
or plain float64 values if real.
"""

import struct
import math

_HEADER_FMT  = '<I4d2s3d11f4s'
_HEADER_SIZE = struct.calcsize(_HEADER_FMT)   # 110


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
    is_complex    = round(fComplex) == 1

    header = {
        'Hz_Resolution': str(round(Hz_Resolution, 6)) + ' Hz',
        'Start_Freq':    str(round(Start_Freq, 4))    + ' Hz',
        'End_Freq':      str(round(End_Freq, 4))      + ' Hz',
        'fComplex':      'yes' if is_complex else 'no',
        'fLength':       str(fLength),
    }

    data_bytes = data[_HEADER_SIZE:]
    n_doubles  = len(data_bytes) // 8
    expected   = fLength * (2 if is_complex else 1)

    if n_doubles < expected:
        return _blank(['data section too short'])

    raw = struct.unpack('<' + str(n_doubles) + 'd', data_bytes)

    freq, mag = [], []
    for i in range(fLength):
        f = Start_Freq + i * Hz_Resolution
        if is_complex:
            re, im = raw[i * 2], raw[i * 2 + 1]
            m = math.sqrt(re * re + im * im)
        else:
            m = abs(raw[i])
        freq.append(round(f, 4))
        mag.append(round(20.0 * math.log10(max(m, 1e-12)), 4))

    return {
        'header'  : header,
        'columns' : ['Frequency [Hz]', 'Magnitude [dB]'],
        'freq'    : freq,
        'mag'     : mag,
        'n_rows'  : fLength,
        'warnings': [],
    }


def build_trf(freq, data, *,
              index=0,
              Xr=0.0, Yr=0.0, Xactual=0.0, YActual=0.0,
              char_str=b'\x00\x00',
              caption=b'\x00\x00\x00\x00',
              Hz_Resolution=None):
    """Return binary .trf bytes for the given freq and data arrays.

    Args:
        freq:          sequence of frequency values (Hz)
        data:          sequence of float, complex, or (re, im) tuples
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

    Start_Freq = float(freq[0])
    End_Freq   = float(freq[-1])

    if Hz_Resolution is None:
        Hz_Resolution = ((End_Freq - Start_Freq) / (n - 1)) if n > 1 else 0.0

    header = struct.pack(
        _HEADER_FMT,
        index,
        Xr, Yr, Xactual, YActual,
        char_str[:2].ljust(2, b'\x00'),
        Hz_Resolution, Start_Freq, End_Freq,
        1.0 if is_complex else 0.0,
        float(n),
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        caption[:4].ljust(4, b'\x00'),
    )

    if is_complex:
        flat = [v for re, im in pairs for v in (re, im)]
    else:
        flat = [re for re, _ in pairs]

    body = struct.pack('<' + str(len(flat)) + 'd', *flat)

    return header + body


def _blank(warnings):
    return {
        'header': {}, 'columns': [], 'freq': [], 'mag': [],
        'n_rows': 0,  'warnings': warnings,
    }
