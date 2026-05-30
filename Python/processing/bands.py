"""
bands.py

Compute per-band averages and frequency centroids from a TRF magnitude array.

Band average : mean of linear magnitude across the band, reported in dB.
Centroid     : Σ(f · |H|) / Σ(|H|) — magnitude-weighted mean frequency,
               matching the LabVIEW centroid VI (Power Spectrum input equivalent).
"""

import math
import numpy as np


def compute_bands(freq, mag_db, bands_cfg):
    """
    Parameters
    ----------
    freq       : array-like of frequency values (Hz)
    mag_db     : array-like of magnitudes (dB), same length as freq
    bands_cfg  : list of dicts, each with keys 'start', 'end', and optional 'label'
                 e.g. from config.json ["bands"]

    Returns
    -------
    list of dicts, one per band that contains at least one frequency bin:
        label     : str
        f_lo      : float  start frequency (Hz)
        f_hi      : float  end frequency (Hz)
        avg_db    : float  band-average magnitude (dB)
        centroid  : float  magnitude-weighted centroid frequency (Hz)
    """
    freq    = np.asarray(freq,   dtype=np.float64)
    mag_lin = 10.0 ** (np.asarray(mag_db, dtype=np.float64) / 20.0)

    results = []
    for band in bands_cfg:
        f_lo  = float(band['start'])
        f_hi  = float(band['end'])
        label = band.get('label', f'{f_lo:.0f}–{f_hi:.0f} Hz')

        mask = (freq >= f_lo) & (freq <= f_hi)
        if not np.any(mask):
            continue

        w        = mag_lin[mask]
        f_band   = freq[mask]
        avg_db   = 20.0 * math.log10(max(float(np.mean(w)), 1e-12))
        centroid = float(np.sum(f_band * w) / np.sum(w))

        results.append(dict(label=label, f_lo=f_lo, f_hi=f_hi,
                            avg_db=avg_db, centroid=centroid))
    return results


def print_bands(band_results):
    """Print a formatted table of band results to stdout."""
    bold, reset = '\033[1m', '\033[0m'
    print(f"\n{bold}{'Band':<16}  {'Range (Hz)':<16}  {'Avg (dB)':>9}  {'Centroid (Hz)':>14}{reset}")
    print('─' * 62)
    for r in band_results:
        print(f"  {r['label']:<14}  {r['f_lo']:>5.0f} – {r['f_hi']:<7.0f}  "
              f"{r['avg_db']:>9.2f}  {r['centroid']:>14.1f}")
    print()
