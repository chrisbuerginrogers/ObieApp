"""
tsv_parser.py
─────────────
Parses tab-separated transfer function files.

Format (tab-delimited):
  2-column:  Frequency, Magnitude          (real)
  3-column:  Frequency, Real, Imaginary    (complex)

Returns the standard result dict:
  { header, columns, freq, mag, n_rows, warnings }

Magnitude is returned as dB (20*log10(|H|)) to match trf_fileio output.
"""

import math


def parse_tsv(text):
    if not text:
        return _blank(['empty input'])

    lines = text.strip().split('\n')
    if len(lines) < 2:
        return _blank(['file too short'])

    # Strip carriage returns (Windows line endings)
    lines = [l.rstrip('\r') for l in lines]

    headers = lines[0].split('\t')
    is_complex = len(headers) >= 3

    freq, mag = [], []
    warnings = []

    for line in lines[1:]:
        parts = line.split('\t')
        if not parts or not parts[0].strip():
            continue
        try:
            f = float(parts[0])
            if is_complex:
                re = float(parts[1])
                im = float(parts[2])
                m  = math.sqrt(re * re + im * im)
            else:
                m = abs(float(parts[1]))
            freq.append(round(f, 6))
            mag.append(round(20.0 * math.log10(max(m, 1e-12)), 4))
        except (ValueError, IndexError) as e:
            warnings.append('skipped: ' + line[:60])

    if not freq:
        return _blank(warnings + ['no numeric data found'])

    return {
        'header'  : {'Format': 'TSV', 'Columns': '3 (complex)' if is_complex else '2 (real)'},
        'columns' : ['Frequency [Hz]', 'Magnitude [dB]'],
        'freq'    : freq,
        'mag'     : mag,
        'n_rows'  : len(freq),
        'warnings': warnings,
    }


def _blank(warnings):
    return {
        'header': {}, 'columns': [], 'freq': [], 'mag': [],
        'n_rows': 0,  'warnings': warnings,
    }
