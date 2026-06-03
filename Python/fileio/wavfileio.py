"""
wavfileio.py

Read and write WAV files for captured audio data.
Works with both file paths (desktop) and raw bytes/BytesIO (browser / PyScript).

Naming convention:
    SampleData/Raw/<instrument> <folder> <designation>_<pos:03d>_<hit:03d>.wav

Example (desktop):
    from fileio.wavfileio import save_wav, load_wav, make_wav_path
    data, sr = load_wav(path)

Example (browser — raw bytes):
    data, sr = load_wav_bytes(raw_bytes)
    # or: normalised float32 mono ready for convolution
    mono, sr = load_wav_normalised(raw_bytes)
"""

import io
from pathlib import Path
import numpy as np
import scipy.io.wavfile as _wavfile

_RAW_DIR = Path(__file__).parent.parent / "SampleData" / "Raw"


def make_wav_path(run: dict, position: int = 1, hit: int = 1) -> Path:
    """Build the standard output path for one capture."""
    stem = f"{run['instrument']} {run['folder']} {run['designation']}_{position:03d}_{hit:03d}"
    return _RAW_DIR / f"{stem}.wav"


def save_wav(path: "Path | str", data: np.ndarray, sample_rate: int) -> None:
    """Write a numpy array to a WAV file (float32 or int16).
    Parent directories are created if needed."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    out = data.astype(np.float32) if np.issubdtype(data.dtype, np.floating) else data.astype(np.int16)
    _wavfile.write(str(path), sample_rate, out)


def load_wav(path: "Path | str") -> "tuple[np.ndarray, int]":
    """Read a WAV file from a file path.
    Returns (data, sample_rate) — data shape (n_samples,) mono or (n_samples, ch) multi-channel."""
    sample_rate, data = _wavfile.read(str(path))
    return data, sample_rate


def load_wav_bytes(src: "bytes | bytearray | io.IOBase") -> "tuple[np.ndarray, int]":
    """Read a WAV file from raw bytes or a file-like object.
    Returns (data, sample_rate) with the same dtype as stored in the file."""
    if isinstance(src, (bytes, bytearray)):
        src = io.BytesIO(src)
    sample_rate, data = _wavfile.read(src)
    return data, sample_rate


def load_wav_normalised(src: "bytes | bytearray | str | Path | io.IOBase") -> "tuple[np.ndarray, int]":
    """Load a WAV file and return normalised float32 mono in [-1, 1].

    Accepts a file path (str/Path), raw bytes, or a file-like object.
    Multi-channel audio is mixed down to mono by averaging channels.
    Returns (mono_float32, sample_rate).
    """
    if isinstance(src, (bytes, bytearray, io.IOBase)):
        data, sr = load_wav_bytes(src)
    else:
        data, sr = load_wav(src)

    # Normalise to float32
    if data.dtype == np.int16:
        data = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        data = data.astype(np.float32) / 2_147_483_648.0
    elif data.dtype == np.uint8:
        data = (data.astype(np.float32) - 128.0) / 128.0
    else:
        data = data.astype(np.float32)

    # Mix down to mono
    if data.ndim > 1:
        data = data.mean(axis=1)

    # Peak-normalise
    peak = float(np.max(np.abs(data)))
    if peak > 0:
        data = data / peak

    return data, int(sr)
