"""
convolution.py

Convolve a WAV file with one FRF/AvC/AvR (mono output) or two (stereo output).

Supported FRF formats: .AvC (complex), .AvR (magnitude), .trf (magnitude dB)

For complex FRFs (.AvC) both magnitude and phase are used.
For magnitude-only formats (.AvR, .trf) a minimum-phase estimate is applied
automatically so the impulse response is causal rather than symmetric.

Core API
--------
convolve_it(data, freqs, H, sample_rate, ir_length=8192)
    Low-level: convolve pre-loaded audio with a pre-loaded FRF.
    Accepts mono (N,) or stereo (N, C) data.  Ideal for the web version
    where file loading is handled separately.

convolve_with_frf(wav_path, frf_paths, ir_length=8192)
    High-level: load files then call convolve_it.

Usage:
    from processing.convolution import convolve_with_frf, convolve_it

    # Mono
    audio, sr = convolve_with_frf('Tchaikovsky.wav', 'Violin.AvC')

    # Stereo
    audio, sr = convolve_with_frf('Tchaikovsky.wav', ('Left.AvC', 'Right.AvC'))

    # Web version — mono (data and H already loaded)
    out = convolve_it(data, freqs, H, sample_rate)

    # Web version — stereo (separate left/right FRFs)
    out = convolve_it(data, (freqs_l, freqs_r), (H_l, H_r), sample_rate)
"""

import numpy as np
from pathlib import Path
from scipy.signal import fftconvolve, hilbert
import scipy.io.wavfile as _wavfile


def _load_frf(path):
    """
    Load an FRF file. Returns (freqs_hz, H_complex) where H_complex is a
    complex128 array — magnitude-only files get zero imaginary part.
    """
    path = Path(path)
    ext  = path.suffix.lower()

    if ext == '.avc':
        from fileio.avc_fileio import parse_avc
        d = parse_avc(path.read_bytes())
        return d['freqs'], d['H_complex'].astype(np.complex128)

    elif ext == '.avr':
        from fileio.avc_fileio import parse_avr
        d = parse_avr(path.read_bytes())
        return d['freqs'], d['data'].astype(np.complex128)

    elif ext == '.trf':
        from fileio.trf_fileio import parse_trf
        d = parse_trf(path.read_bytes())
        freqs   = np.array(d['freq'],  dtype=np.float64)
        mag_lin = 10.0 ** (np.array(d['mag'], dtype=np.float64) / 20.0)
        return freqs, mag_lin.astype(np.complex128)

    else:
        raise ValueError(f"Unsupported FRF format '{path.suffix}' — use .AvC, .AvR, or .trf")


def _frf_to_ir(freqs, H_complex, sample_rate, ir_length):
    """
    Build a real-valued impulse response from a band-limited FRF.

    Interpolates H onto the full rfft frequency grid for ir_length samples,
    IFFTs to the time domain, and applies a Hann window to taper ringing.
    The result is normalised to unit peak.
    """
    fft_freqs = np.fft.rfftfreq(ir_length, d=1.0 / sample_rate)

    H_real = np.interp(fft_freqs, freqs, H_complex.real, left=0.0, right=0.0)
    H_imag = np.interp(fft_freqs, freqs, H_complex.imag, left=0.0, right=0.0)

    ir = np.fft.irfft(H_real + 1j * H_imag, n=ir_length)
    ir *= np.hanning(ir_length)

    peak = np.max(np.abs(ir))
    if peak > 0:
        ir /= peak
    return ir.astype(np.float32)


def _minimum_phase(H):
    """
    Estimate minimum-phase version of a magnitude-only FRF.

    Uses the Hilbert transform of the log-magnitude spectrum:
        phase(ω) = -H{ ln|H(ω)| }
    which yields a causal, minimum-phase impulse response.
    """
    mag = np.abs(H)
    log_mag = np.log(np.maximum(mag, 1e-10))
    phase = -np.imag(hilbert(log_mag))
    return mag * np.exp(1j * phase)


def _read_wav(path):
    """Read a WAV file and return (audio_float32_mono, sample_rate)."""
    sample_rate, data = _wavfile.read(str(path))

    if data.dtype == np.int16:
        data = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        data = data.astype(np.float32) / 2147483648.0
    elif data.dtype == np.uint8:
        data = (data.astype(np.float32) - 128.0) / 128.0
    else:
        data = data.astype(np.float32)

    if data.ndim > 1:
        data = data.mean(axis=1)

    peak = np.max(np.abs(data))
    if peak > 0:
        data /= peak
    return data, sample_rate


def _convolve_one(data, freqs, H, sample_rate, ir_length):
    """Apply one FRF to mono or multi-channel data (same IR for every channel)."""
    imag_energy = np.max(np.abs(H.imag))
    real_energy = np.max(np.abs(H.real)) + 1e-30
    if imag_energy < 1e-8 * real_energy:
        H = _minimum_phase(H)

    ir = _frf_to_ir(freqs, H, sample_rate, ir_length)

    if data.ndim == 1:
        return fftconvolve(data, ir)[:len(data)].astype(np.float32)

    n = data.shape[0]
    channels = [fftconvolve(data[:, c], ir)[:n].astype(np.float32)
                for c in range(data.shape[1])]
    return np.column_stack(channels)


def convolve_it(data, freqs, H, sample_rate, ir_length=8192):
    """
    Convolve audio data with one or two FRFs.

    If H has no meaningful imaginary content (magnitude-only), a minimum-phase
    estimate is applied automatically so the result is causal.

    Parameters
    ----------
    data        : float32 ndarray, shape (N,) or (N, C)
    freqs       : 1-D Hz array  —or—  (freqs_l, freqs_r) when H is a pair
    H           : complex128 FRF  —or—  (H_l, H_r) for stereo output
                  When a pair is supplied, data is convolved once with H_l and
                  once with H_r; the results are stacked into an (N, 2) array.
    sample_rate : int
    ir_length   : IR length in samples (default 8192 ≈ 170 ms @ 48 kHz)

    Returns
    -------
    float32 ndarray — (N,) for a single H, (N, 2) for a pair
    """
    if isinstance(H, (tuple, list)):
        H_l, H_r = H
        freqs_l, freqs_r = freqs if isinstance(freqs, (tuple, list)) else (freqs, freqs)
        ch_l = _convolve_one(data, freqs_l, H_l, sample_rate, ir_length)
        ch_r = _convolve_one(data, freqs_r, H_r, sample_rate, ir_length)
        return np.column_stack([ch_l, ch_r])

    return _convolve_one(data, freqs, H, sample_rate, ir_length)


def convolve_with_frf(wav_path, frf_paths, ir_length=8192):
    """
    Convolve a WAV file with one or two FRF files.

    Parameters
    ----------
    wav_path   : str or Path  — source audio file (.wav)
    frf_paths  : str/Path           → mono output
                 (left_path, right_path) → stereo float32 (N, 2) output
    ir_length  : impulse response length in samples

    Returns
    -------
    (audio_out, sample_rate)
    audio_out is float32 ndarray, shape (N,) mono or (N, 2) stereo, peak ≤ 0.9
    """
    audio, sample_rate = _read_wav(wav_path)

    if isinstance(frf_paths, (str, Path)):
        freqs, H = _load_frf(frf_paths)
        out = convolve_it(audio, freqs, H, sample_rate, ir_length)
    else:
        left_path, right_path = frf_paths
        freqs_l, H_l = _load_frf(left_path)
        freqs_r, H_r = _load_frf(right_path)
        out = convolve_it(audio, (freqs_l, freqs_r), (H_l, H_r), sample_rate, ir_length)

    peak = np.max(np.abs(out))
    if peak > 0:
        out = (out / peak * 0.9).astype(np.float32)

    return out, sample_rate
