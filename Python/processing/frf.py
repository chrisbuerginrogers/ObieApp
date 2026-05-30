"""
frf.py

Frequency Response Function (FRF) and coherence estimation via averaged
cross/auto-spectral densities (H1 estimator).

Ch 0 = hammer (input), Ch 1 = microphone (output).

Usage:
    from math.frf import FRFAccumulator, add_hit, compute_frf, reset_frf

    acc = FRFAccumulator(sample_rate=48000)
    for hit_data in hits:
        add_hit(acc, hit_data)
    freqs, H1, H2, H_dB, coherence = compute_frf(acc)
    reset_frf(acc)
"""

import numpy as np
from dataclasses import dataclass, field

p0 = 2.0e-5  # reference sound pressure in air (20 µPa)

@dataclass
class FRFAccumulator:
    sample_rate:  int
    n_samples:    int        = 0
    n_hits:       int        = 0
    S_ff:         np.ndarray = field(default_factory=lambda: np.array([]))  # input auto-spectrum
    S_pp:         np.ndarray = field(default_factory=lambda: np.array([]))  # output auto-spectrum
    S_fp:         np.ndarray = field(default_factory=lambda: np.array([]))  # cross-spectrum (complex)
    sum_H_mag:    np.ndarray = field(default_factory=lambda: np.array([]))  # running sum of per-hit |H|


def add_hit(acc: FRFAccumulator, data: np.ndarray) -> None:
    """Accumulate one hit. data shape: (n_samples, 2)."""
    f = data[:, 0]  # hammer — input
    p = data[:, 1]  # mic — output

    F = np.fft.rfft(f)
    P = np.fft.rfft(p)

    S_ff = (F * np.conj(F)).real  # should be real, but use .real to avoid small numerical imaginary part and save memory by saving as real dtype
    S_pp = (P * np.conj(P)).real
    S_fp = F * np.conj(P)           # complex cross-spectrum

    eps   = np.finfo(float).eps
    H_mag = np.abs(S_fp / np.where(S_ff > eps, S_ff, eps))  # per-hit |H1| for AvR

    if acc.n_hits == 0:
        acc.S_ff       = S_ff.copy()
        acc.S_pp       = S_pp.copy()
        acc.S_fp       = S_fp.copy()
        acc.sum_H_mag  = H_mag.copy()
        acc.n_samples  = len(f)
    else:
        acc.S_ff      += S_ff
        acc.S_pp      += S_pp
        acc.S_fp      += S_fp
        acc.sum_H_mag += H_mag

    acc.n_hits += 1


def compute_frf(acc: FRFAccumulator) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Returns (freqs, H1, H2, H_dB, coherence) from the accumulated spectral densities.

    freqs:     frequency axis in Hz
    H1:        H1 estimator (complex)
    H2:        H2 estimator (complex)
    H_dB:      H1 magnitude in dB  (20 * log10 |H1|)
    coherence: ordinary coherence 0–1
    """
    freqs = np.fft.rfftfreq(acc.n_samples, d=1.0 / acc.sample_rate)

    eps = np.finfo(float).eps # small constant to avoid division by zero

    # H1 estimator: minimises output noise
    H    = acc.S_fp / np.where(acc.S_ff > eps, acc.S_ff, eps) 
    H_dB = 20.0 * np.log10(np.maximum(np.abs(H), p0))

   # H2 estimator: minimises output noise
    H2    = np.where(acc.S_pp > eps, acc.S_pp, eps) /acc.S_fp 
    H2_dB = 20.0 * np.log10(np.maximum(np.abs(H2), p0))

    # Ordinary coherence
    denom = acc.S_ff * acc.S_pp
    coh   = np.abs(acc.S_fp) ** 2 / np.where(denom > eps, denom, eps)
    coh   = np.clip(coh, 0.0, 1.0)

    return freqs, H, H2, H_dB, coh


def reset_frf(acc: FRFAccumulator) -> None:
    """Clear accumulator for the next position."""
    acc.S_ff      = np.array([])
    acc.S_pp      = np.array([])
    acc.S_fp      = np.array([])
    acc.sum_H_mag = np.array([])
    acc.n_hits    = 0
    acc.n_samples = 0


def merge_accumulator(dest: FRFAccumulator, src: FRFAccumulator) -> None:
    """Add all accumulated spectral densities from src into dest (used for grand average)."""
    if dest.n_hits == 0:
        dest.S_ff      = src.S_ff.copy()
        dest.S_pp      = src.S_pp.copy()
        dest.S_fp      = src.S_fp.copy()
        dest.sum_H_mag = src.sum_H_mag.copy()
        dest.n_samples = src.n_samples
    else:
        dest.S_ff      += src.S_ff
        dest.S_pp      += src.S_pp
        dest.S_fp      += src.S_fp
        dest.sum_H_mag += src.sum_H_mag
    dest.n_hits += src.n_hits
