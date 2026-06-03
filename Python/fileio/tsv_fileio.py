"""
tsv_fileio.py
─────────────
Parsers for plain-text FRF files: tab-separated (TSV) and comma-separated (CSV).

TSV format (tab-delimited):
  2-column:  Frequency [Hz]  Magnitude          (real, converted to dB)
  3-column:  Frequency [Hz]  Real  Imaginary     (complex, converted to dB)

CSV format (comma-delimited):
  2-column:  Frequency [Hz], Magnitude [dB]      (already in dB)

Both parsers return the standard result dict:
  { header, columns, freq, mag, n_rows, warnings }

Magnitude is always returned as dB (20*log10(|H|)).
"""

import math


def parse_tsv(text: str) -> dict:
    """Parse a tab-separated FRF text file.

    Accepts str or bytes (bytes are decoded as UTF-8).
    """
    if isinstance(text, (bytes, bytearray)):
        text = text.decode('utf-8', errors='replace')
    if not text:
        return _blank(['empty input'])

    lines = [l.rstrip('\r') for l in text.strip().split('\n')]
    if len(lines) < 2:
        return _blank(['file too short'])

    headers   = lines[0].split('\t')
    is_complex = len(headers) >= 3

    freq, mag, warnings = [], [], []

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
        except (ValueError, IndexError):
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


def parse_csv(text: str) -> dict:
    """Parse a two-column CSV file: Frequency [Hz], Magnitude [dB].

    Accepts str or bytes (bytes are decoded as UTF-8).
    Values are expected to already be in dB (unlike TSV which carries linear).
    """
    if isinstance(text, (bytes, bytearray)):
        text = text.decode('utf-8', errors='replace')

    freqs, dbs = [], []
    for ln in text.strip().split('\n'):
        ln = ln.strip()
        if not ln or (ln[0].isalpha() and ln[0] not in 'eE'):
            continue
        parts = ln.split(',')
        if len(parts) >= 2:
            try:
                f, d = float(parts[0]), float(parts[1])
                if f > 0 and math.isfinite(f) and math.isfinite(d):
                    freqs.append(f)
                    dbs.append(d)
            except ValueError:
                pass

    if len(freqs) < 4:
        return _blank(['Too few valid rows — check CSV format (Frequency, dB)'])

    return {
        'header'  : {'Format': 'CSV', 'Columns': '2 (Frequency, Magnitude dB)'},
        'columns' : ['Frequency [Hz]', 'Magnitude [dB]'],
        'freq'    : [round(f, 6) for f in freqs],
        'mag'     : [round(d, 4) for d in dbs],
        'n_rows'  : len(freqs),
        'warnings': [],
    }


def _blank(warnings):
    return {
        'header': {}, 'columns': [], 'freq': [], 'mag': [],
        'n_rows': 0,  'warnings': warnings,
    }


__all__ = ['parse_tsv', 'parse_csv']
