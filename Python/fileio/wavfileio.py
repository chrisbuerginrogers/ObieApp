"""
wavfileio.py

Read and write WAV files for captured audio data.

Naming convention:
    SampleData/Raw/<instrument> <folder> <designation>_<pos:03d>_<hit:03d>.wav

Example:
    from fileio.wavfileio import save_wav, load_wav, make_wav_path
    from fileio.obieapp_config import load

    run = load("run")
    path = make_wav_path(run, position=1, hit=3)
    save_wav(path, data, sample_rate)
    data, sr = load_wav(path)
"""

from pathlib import Path
import numpy as np
import scipy.io.wavfile as _wavfile

_RAW_DIR = Path(__file__).parent.parent / "SampleData" / "Raw"


def make_wav_path(run: dict, position: int = 1, hit: int = 1) -> Path:
    """Build the standard output path for one capture."""
    stem = f"{run['instrument']} {run['folder']} {run['designation']}_{position:03d}_{hit:03d}"
    return _RAW_DIR / f"{stem}.wav"


def save_wav(path: Path | str, data: np.ndarray, sample_rate: int) -> None:
    """
    Write a numpy array to a WAV file.  Float data is saved as float32;
    int16 data is saved as-is.  Parent directories are created if needed.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    if np.issubdtype(data.dtype, np.floating):
        out = data.astype(np.float32)
    else:
        out = data.astype(np.int16)

    _wavfile.write(str(path), sample_rate, out)


def load_wav(path: Path | str) -> tuple[np.ndarray, int]:
    """
    Read a WAV file.  Returns (data, sample_rate) where data has shape
    (n_samples,) for mono or (n_samples, channels) for multi-channel.
    """
    sample_rate, data = _wavfile.read(str(path))
    return data, sample_rate
