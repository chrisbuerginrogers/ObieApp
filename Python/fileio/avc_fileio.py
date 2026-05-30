"""
avc_fileio.py

Read and write .AvC (Average Complex) and .AvR (Average Real) files in the
Stoppani/MtxVec binary format (matches NoahApp/py/av_files.py).

Header (86 bytes, little-endian):
    B       Data_Type       u8   0=Accel 1=Mob 2=Recept 3=Mic 4=Unknown
    4d      Hz_Resolution, Start_Freq, Stop_Freq, Scale_Factor   float64 each
    I       Num_Averages    u32
    B       Averaging_Type  u8   0=RMS 1=Mean 2=Complex 3=Geometric 4=None
    11f     fComplex, fLength, a[2], fConditionCheck, Precision,
            MtxVecVersion, SizeOf_TSample, Tag, MtxVecFileCount, a[9], a[10]
    4s      caption

Note: Stop_Freq is an exclusive upper bound — fLength = int((Stop_Freq - Start_Freq) / Hz_Resolution).

Data (following header):
    AvC  fLength × (re:float64, im:float64) interleaved
    AvR  fLength × float64
"""

import struct
import numpy as np

_HDR_FMT  = '<B4dIB11f4s'
_HDR_SIZE = struct.calcsize(_HDR_FMT)   # 86

# Data_Type
DT_ACCEL, DT_MOB, DT_RECEPT, DT_MIC, DT_UNKNOWN = range(5)

# Averaging_Type
AT_RMS, AT_MEAN, AT_COMPLEX, AT_GEOMETRIC, AT_NONE = range(5)


def build_avc(freqs: np.ndarray, H_complex: np.ndarray, *,
              data_type: int  = DT_RECEPT,
              scale_factor: float = 1.0,
              n_averages: int = 1,
              averaging_type: int = AT_COMPLEX) -> bytes:
    """Build .AvC bytes from a complex FRF array."""
    freqs     = np.asarray(freqs,     dtype=np.float64)
    H_complex = np.asarray(H_complex, dtype=complex)
    n         = len(freqs)
    hz_res    = float(freqs[1] - freqs[0]) if n > 1 else 1.0
    start_f   = float(freqs[0])
    stop_f    = start_f + n * hz_res    # exclusive upper bound → fLength = n exactly

    hdr = struct.pack(_HDR_FMT,
                      data_type,
                      hz_res, start_f, stop_f, float(scale_factor),
                      n_averages,
                      averaging_type,
                      1.0, float(n), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                      b'\x00\x00\x00\x00')

    out = np.empty(n * 2, dtype=np.float64)
    out[0::2] = H_complex.real
    out[1::2] = H_complex.imag
    return hdr + out.tobytes()


def build_avr(freqs: np.ndarray, real_data: np.ndarray, *,
              data_type: int  = DT_RECEPT,
              scale_factor: float = 1.0,
              n_averages: int = 1,
              averaging_type: int = AT_RMS) -> bytes:
    """Build .AvR bytes from a real-valued array (e.g., coherence)."""
    freqs     = np.asarray(freqs,     dtype=np.float64)
    real_data = np.asarray(real_data, dtype=np.float64)
    n         = len(freqs)
    hz_res    = float(freqs[1] - freqs[0]) if n > 1 else 1.0
    start_f   = float(freqs[0])
    stop_f    = start_f + n * hz_res

    hdr = struct.pack(_HDR_FMT,
                      data_type,
                      hz_res, start_f, stop_f, float(scale_factor),
                      n_averages,
                      averaging_type,
                      0.0, float(n), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                      b'\x00\x00\x00\x00')

    return hdr + real_data.tobytes()


def parse_avc(raw: bytes) -> dict:
    """Parse .AvC bytes. Returns dict with 'freqs' and 'H_complex' (numpy arrays)."""
    h = struct.unpack(_HDR_FMT, raw[:_HDR_SIZE])
    data_type, hz_res, start_f, stop_f, scale = h[0], h[1], h[2], h[3], h[4]
    n_avg, avg_type                            = h[5], h[6]
    f_complex, f_length                        = int(h[7]), int(h[8])

    freqs = start_f + np.arange(f_length) * hz_res
    n_bytes = f_length * 16 if f_complex else f_length * 8
    vals  = np.frombuffer(raw[_HDR_SIZE:_HDR_SIZE + n_bytes], dtype=np.float64)

    if f_complex:
        H = vals[0::2] + 1j * vals[1::2]
    else:
        H = vals.astype(complex)

    return {'data_type': data_type, 'hz_res': hz_res, 'start_freq': start_f,
            'stop_freq': stop_f, 'scale_factor': scale,
            'n_averages': n_avg, 'averaging_type': avg_type,
            'freqs': freqs, 'H_complex': H}


def parse_avr(raw: bytes) -> dict:
    """Parse .AvR bytes. Returns dict with 'freqs' and 'data' (numpy arrays)."""
    h = struct.unpack(_HDR_FMT, raw[:_HDR_SIZE])
    data_type, hz_res, start_f, stop_f, scale = h[0], h[1], h[2], h[3], h[4]
    n_avg, avg_type                            = h[5], h[6]
    f_length                                   = int(h[8])

    freqs = start_f + np.arange(f_length) * hz_res
    n_bytes = f_length * 8
    data  = np.frombuffer(raw[_HDR_SIZE:_HDR_SIZE + n_bytes], dtype=np.float64)

    return {'data_type': data_type, 'hz_res': hz_res, 'start_freq': start_f,
            'stop_freq': stop_f, 'scale_factor': scale,
            'n_averages': n_avg, 'averaging_type': avg_type,
            'freqs': freqs, 'data': data}
