"""
mat_fileio.py (browser / PyScript edition)

Browser-compatible reader for MATLAB .mat files (v4 – v7.2).
Accepts raw bytes rather than a file path — use parse_mat_bytes(raw).

Formats supported:
  Format A — time-domain  ('indata' variable present)
  Format B — FRF          ('yspec' variable present)

See Python/fileio/mat_fileio.py for full field documentation.
"""

import io
import numpy as np
import scipy.io as _sio


def _load(raw: bytes) -> dict:
    return _sio.loadmat(io.BytesIO(raw))


def parse_mat_timedomain_bytes(raw: bytes) -> dict:
    d = _load(raw)
    if "indata" not in d:
        raise ValueError("No 'indata' variable found")
    if "freq" not in d:
        raise ValueError("No 'freq' variable found")
    data = d["indata"].flatten().astype(np.float64)
    sample_rate = int(d["freq"].flat[0])
    n_samples = int(d["buflen"].flat[0]) if "buflen" in d else len(data)
    data = data[:n_samples]
    tsmax = float(d["tsmax"].flat[0]) if "tsmax" in d else None
    return {
        "data":        data,
        "sample_rate": sample_rate,
        "n_samples":   n_samples,
        "duration_s":  n_samples / sample_rate,
        "tsmax":       tsmax,
        "kind":        "timedomain",
        "raw":         d,
    }


def parse_mat_frf_bytes(raw: bytes) -> dict:
    d = _load(raw)
    if "yspec" not in d:
        raise ValueError("No 'yspec' variable found")
    if "freq" not in d:
        raise ValueError("No 'freq' variable found")
    yspec = d["yspec"]
    if yspec.ndim != 2 or yspec.shape[1] < 2:
        raise ValueError(f"'yspec' must have at least 2 columns, got shape {yspec.shape}")
    sample_rate = int(d["freq"].flat[0])
    npts = int(d["npts"].flat[0]) if "npts" in d else (yspec.shape[0] - 1) * 2
    hz_res = sample_rate / npts
    freqs = np.arange(yspec.shape[0]) * hz_res
    frf = yspec[:, 0]
    coherence = yspec[:, 1].real
    return {
        "freqs":       freqs,
        "frf":         frf,
        "coherence":   coherence,
        "sample_rate": sample_rate,
        "npts":        npts,
        "hz_res":      hz_res,
        "kind":        "frf",
        "raw":         d,
    }


def parse_mat_bytes(raw: bytes) -> dict:
    """Auto-detect format. Returns dict with 'kind' == 'frf' or 'timedomain'."""
    d = _load(raw)
    if "yspec" in d:
        return parse_mat_frf_bytes(raw)
    if "indata" in d:
        return parse_mat_timedomain_bytes(raw)
    raise ValueError("Unrecognised .mat format: expected 'yspec' (FRF) or 'indata' (time-domain)")


__all__ = ["parse_mat_bytes", "parse_mat_frf_bytes", "parse_mat_timedomain_bytes"]
