""" 
mat_fileio.py

Reader for MATLAB .mat files (v4 – v7.2) in the two Obie formats.
Works with both file paths (desktop) and raw bytes/BytesIO (browser / PyScript).

Format A — time-domain  (variable 'indata' present)
----------------------------------------------------
    indata   — (N, 1) or (1, N) float64  signal samples
    freq     — scalar                     sample rate in Hz
    buflen   — scalar                     number of valid samples (optional)
    tsmax    — scalar                     time of signal maximum, s (optional)
    dt2      — (1, 3) uint8               recording flags (optional)

Returns dict:
    data        np.ndarray (N,) float64
    sample_rate int                      Hz
    n_samples   int
    duration_s  float                    n_samples / sample_rate
    tsmax       float | None
    kind        'timedomain'
    raw         dict

Format B — FRF / coherence  (variable 'yspec' present)
-------------------------------------------------------
    yspec    — (N_bins, 2) complex128     col 0 = complex FRF,
                                          col 1 = coherence (real, stored complex)
    freq     — scalar                     sample rate in Hz
    npts     — scalar                     original time-domain block length
    tfun     — scalar uint8               flag: 1 = transfer function
    dt2      — (1, 3) uint8               recording flags (optional)

Returns dict:
    freqs       np.ndarray (N_bins,) float64   frequency axis, Hz
    frf         np.ndarray (N_bins,) complex128
    coherence   np.ndarray (N_bins,) float64   0 – 1
    sample_rate int                            Hz
    npts        int                            original block length
    hz_res      float                          Hz per bin
    kind        'frf'
    raw         dict

parse_mat(src) auto-detects the format; src may be a file path (str/Path) or raw bytes.
parse_mat_bytes is an alias for parse_mat — provided for browser / PyScript callers.
"""
import io
from pathlib import Path

import numpy as np

try:
    import scipy.io as _sio
except ImportError as _e:
    raise ImportError(
        "scipy is required to read .mat files: pip install scipy"
    ) from _e


def _load(src) -> dict:
    """Accept a file path (str/Path), raw bytes, or a file-like object."""
    if isinstance(src, (bytes, bytearray)):
        return _sio.loadmat(io.BytesIO(src))
    if hasattr(src, 'read'):
        return _sio.loadmat(src)
    return _sio.loadmat(str(Path(src)))


def _name(src) -> str:
    if isinstance(src, (str, Path)):
        return Path(src).name
    return '<bytes>'


def parse_mat_timedomain(src) -> dict:
    """Load a time-domain Obie .mat file ('indata' format).
    src: file path (str/Path), raw bytes, or file-like object."""
    raw = _load(src)
    name = _name(src)

    if "indata" not in raw:
        raise ValueError(f"No 'indata' variable found in {name}")
    if "freq" not in raw:
        raise ValueError(f"No 'freq' variable found in {name}")

    data = raw["indata"].flatten().astype(np.float64)
    sample_rate = int(raw["freq"].flat[0])
    n_samples = int(raw["buflen"].flat[0]) if "buflen" in raw else len(data)
    data = data[:n_samples]
    tsmax = float(raw["tsmax"].flat[0]) if "tsmax" in raw else None

    return {
        "data":        data,
        "sample_rate": sample_rate,
        "n_samples":   n_samples,
        "duration_s":  n_samples / sample_rate,
        "tsmax":       tsmax,
        "kind":        "timedomain",
        "raw":         raw,
    }


def parse_mat_frf(src) -> dict:
    """Load an FRF/coherence Obie .mat file ('yspec' format).
    src: file path (str/Path), raw bytes, or file-like object.

    yspec layout (MATLAB saves spectral data in various shapes):
      1-D or (N, 1) — single complex FRF channel, no coherence
      (N, 2)        — complex FRF in col 0, coherence (real) in col 1
      (N, k>2)      — FRF in col 0, coherence in col 1, extra cols ignored

    dt2 (optional (1,3) uint8 recording flags) is read if present but not
    required — column count is the authoritative source of channel layout.
    """
    raw = _load(src)
    name = _name(src)

    if "yspec" not in raw:
        raise ValueError(f"No 'yspec' variable found in {name}")
    if "freq" not in raw:
        raise ValueError(f"No 'freq' variable found in {name}")

    yspec = raw["yspec"]

    # Normalise to 2-D — MATLAB may store a single vector as 1-D or (N, 1)
    if yspec.ndim == 1:
        yspec = yspec.reshape(-1, 1)
    if yspec.ndim != 2:
        raise ValueError(f"Unexpected 'yspec' shape {yspec.shape} in {name}")

    n_bins, n_cols = yspec.shape
    sample_rate = int(raw["freq"].flat[0])
    npts = int(raw["npts"].flat[0]) if "npts" in raw else (n_bins - 1) * 2
    hz_res = sample_rate / npts
    freqs = np.arange(n_bins) * hz_res

    frf = yspec[:, 0]
    # Coherence is real by definition; only present when a second column exists
    coherence = yspec[:, 1].real if n_cols >= 2 else None

    return {
        "freqs":       freqs,
        "frf":         frf,
        "coherence":   coherence,
        "sample_rate": sample_rate,
        "npts":        npts,
        "hz_res":      hz_res,
        "kind":        "frf",
        "raw":         raw,
    }


def parse_mat(src) -> dict:
    """Auto-detect format and load a MATLAB .mat file.

    src: file path (str/Path), raw bytes, or file-like object.
    Returns a dict whose 'kind' key is 'timedomain' or 'frf'.
    See module docstring for the full key list for each format.
    """
    raw = _load(src)
    name = _name(src)

    if "yspec" in raw:
        return parse_mat_frf(src)
    if "indata" in raw:
        return parse_mat_timedomain(src)
    raise ValueError(
        f"Unrecognised .mat format in {name}: "
        "expected 'yspec' (FRF) or 'indata' (time-domain)"
    )


# Browser / PyScript alias — accepts raw bytes, same return value as parse_mat
parse_mat_bytes = parse_mat

__all__ = ["parse_mat", "parse_mat_timedomain", "parse_mat_frf", "parse_mat_bytes"]
