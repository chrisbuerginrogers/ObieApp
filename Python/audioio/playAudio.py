"""
playAudio.py

List output audio devices, let the user choose one interactively, and play
a numpy audio array through it.  Uses PyAudio (already a project dependency).

Usage:
    from audioio.playAudio import choose_device, play

    device = choose_device()
    play(audio, sample_rate, device)
"""

import numpy as np
import pyaudio


def list_output_devices():
    """
    Return a list of (device_index, name, max_output_channels) for every
    device that has at least one output channel.
    """
    pa      = pyaudio.PyAudio()
    devices = []
    for i in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(i)
        if info['maxOutputChannels'] > 0:
            devices.append((i, info['name'], int(info['maxOutputChannels'])))
    pa.terminate()
    return devices


def choose_device():
    """
    Print available output devices, prompt the user to pick one, and return
    the PyAudio device index.
    """
    pa      = pyaudio.PyAudio()
    default = pa.get_default_output_device_info()['index']
    pa.terminate()

    devices = list_output_devices()
    print("\nAvailable output devices:")
    for n, (idx, name, ch) in enumerate(devices):
        marker = '  ← default' if idx == default else ''
        print(f"  [{n}]  {name}  ({ch}ch){marker}")
    print()

    while True:
        raw = input(f"Choose device [0–{len(devices) - 1}]: ").strip()
        try:
            n = int(raw)
            if 0 <= n < len(devices):
                idx, name, _ = devices[n]
                print(f"  Using: {name}\n")
                return idx
        except ValueError:
            pass
        print(f"  Please enter a number between 0 and {len(devices) - 1}.")


def play(audio, sample_rate, device=None):
    """
    Play a numpy audio array through the given output device.

    Parameters
    ----------
    audio       : float32 ndarray, shape (N,) mono or (N, 2) stereo
    sample_rate : int
    device      : PyAudio device index from choose_device(), or None for
                  the system default
    """
    audio = np.asarray(audio, dtype=np.float32)
    n_ch  = 1 if audio.ndim == 1 else audio.shape[1]
    dur   = len(audio) / sample_rate

    print(f"Playing {'stereo' if n_ch == 2 else 'mono'}  "
          f"{dur:.1f}s @ {sample_rate} Hz ...")

    pa     = pyaudio.PyAudio()
    stream = pa.open(
        format             = pyaudio.paFloat32,
        channels           = n_ch,
        rate               = sample_rate,
        output             = True,
        output_device_index= device,
    )

    # Write in chunks to avoid a single giant buffer
    chunk  = 1024
    flat   = audio.flatten() if n_ch == 1 else audio.reshape(-1)
    for i in range(0, len(flat), chunk * n_ch):
        stream.write(flat[i : i + chunk * n_ch].tobytes())

    stream.stop_stream()
    stream.close()
    pa.terminate()
    print("Done.")
