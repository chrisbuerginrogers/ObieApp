"""
spectrogram.py

Short-time Fourier transform spectrogram for display purposes.

Returns magnitude in dB clipped to a useful display range.

Example:
    from processing.spectrogram import compute_spectrogram
    times, freqs, S_db = compute_spectrogram(signal, sample_rate)
"""

import numpy as np


def compute_spectrogram(
    sig: np.ndarray,
    sample_rate: int,
    n_fft: int = 2048,
    hop: int = 512,
    f_max: float = 8000.0,
) -> "tuple[np.ndarray, np.ndarray, np.ndarray]":
    """Compute a magnitude spectrogram in dB.

    Args:
        sig:         1-D float array (mono signal, any dtype — converted internally)
        sample_rate: sample rate in Hz
        n_fft:       FFT window size
        hop:         hop size in samples
        f_max:       highest frequency bin to return (Hz); bins above are dropped

    Returns:
        times   — 1-D float32 array of frame centre times (s), length n_frames
        freqs   — 1-D float32 array of frequency bin centres (Hz), length n_bins
        S_db    — 2-D float32 array (n_bins × n_frames) of magnitude in dB
    """
    sig = np.asarray(sig, dtype=np.float64)
    if len(sig) < n_fft:
        empty = np.zeros(0, dtype=np.float32)
        return empty, empty, np.zeros((0, 0), dtype=np.float32)

    win      = np.hanning(n_fft)
    n_frames = max(1, (len(sig) - n_fft) // hop + 1)
    idx      = np.arange(n_frames)[:, None] * hop + np.arange(n_fft)[None, :]
    frames   = sig[np.minimum(idx, len(sig) - 1)] * win

    S_db = (20.0 * np.log10(
        np.maximum(np.abs(np.fft.rfft(frames, axis=1)), 1e-10)
    )).T.astype(np.float32)   # shape: (n_freq_bins, n_frames)

    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate).astype(np.float32)
    mask  = freqs <= f_max
    times = (np.arange(n_frames) * hop / sample_rate).astype(np.float32)

    return times, freqs[mask], S_db[mask]
