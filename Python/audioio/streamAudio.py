"""
audio_stream.py — reusable stereo audio capture class.

Usage:
    stream = AudioStream(device_index=0)
    stream.start()
    chunks = stream.read_chunks()   # call repeatedly in your render loop
    stream.stop()

Or use as a context manager:
    with AudioStream(device_index=0) as stream:
        chunks = stream.read_chunks()
"""

import numpy as np
import pyaudio

class AudioStream:
    """
    Wraps a PyAudio input stream for multi-channel audio capture.

    Parameters
    ----------
    device_index : int | None
        PyAudio device index to open. None = system default.
    sample_rate : int
        Samples per second (Hz). Must match device capability.
    channels : int
        Number of input channels (1 = mono, 2 = stereo, …).
    chunk : int
        Frames read per PyAudio call. Smaller = lower latency, higher CPU.
    fmt : str
        Audio sample format: '16' (default), '32', '8', '24', or 'float'.
        Determines PyAudio format constant, NumPy dtype, and value range.
    """

    def __init__(
        self,
        device_index: int = 0,
        sample_rate: int = 48000,
        channels: int = 2,
        chunk: int = 1024,
        fmt: str = '16',
    ):
        self.device_index = device_index
        self.sample_rate = sample_rate
        self.channels = channels
        self.chunk = chunk
        # Define all configurations together in one place
        formats = {
            '8':     {'pa': pyaudio.paInt8,    'np': np.int8,    'range': (-128,        127)},
            '16':    {'pa': pyaudio.paInt16,   'np': np.int16,   'range': (-32768,      32767)},
            '24':    {'pa': pyaudio.paInt24,   'np': np.int32,   'range': (-8388608,    8388607)},
            '32':    {'pa': pyaudio.paInt32,   'np': np.int32,   'range': (-2147483648, 2147483647)},
            'float': {'pa': pyaudio.paFloat32, 'np': np.float32, 'range': (-1.0,        1.0)},
        }

        # Fetch the specific config, defaulting to 16-bit if the key is missing
        config = formats.get(fmt, formats['16'])

        self.fmt = config['pa']
        self.np_fmt = config['np']
        self.value_range: tuple = config['range']
        self._pa: pyaudio.PyAudio | None = None
        self._stream: pyaudio.Stream | None = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Open the PyAudio interface and start the input stream."""
        if self._stream is not None:
            raise RuntimeError("Stream is already running. Call stop() first.")

        self._pa = pyaudio.PyAudio()
        self._stream = self._pa.open(
            format=self.fmt,
            channels=self.channels,
            rate=self.sample_rate,
            input=True,
            frames_per_buffer=self.chunk,
            input_device_index=self.device_index,
        )

    def stop(self) -> None:
        """Stop and close the stream, releasing hardware resources."""
        if self._stream is not None:
            self._stream.stop_stream()
            self._stream.close()
            self._stream = None
        if self._pa is not None:
            self._pa.terminate()
            self._pa = None

    # ── Data retrieval ────────────────────────────────────────────────────────

    def read_chunks(self) -> np.ndarray | None:
        """
        Drain all currently available audio from the device buffer.

        Reads every complete chunk that is ready without blocking, then
        concatenates them into a single array.

        Returns
        -------
        np.ndarray of shape (n_samples, channels), dtype np_fmt, with values in value_range
        or None if no new data was available this call.
        """
        if self._stream is None:
            raise RuntimeError("Stream is not running. Call start() first.")

        frames = []
        while self._stream.get_read_available() >= self.chunk:
            raw = self._stream.read(self.chunk, exception_on_overflow=False)
            if self.fmt == pyaudio.paInt24:
                # paInt24 packs 3 bytes/sample; pad to 4 bytes with sign-extension before viewing as int32
                b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
                sign = np.where(b[:, 2] & 0x80, np.uint8(0xFF), np.uint8(0x00))
                interleaved = np.column_stack([b, sign]).view('<i4').reshape(-1)
            else:
                interleaved = np.frombuffer(raw, dtype=self.np_fmt)
            frames.append(interleaved.reshape(-1, self.channels))

        if not frames:
            return None

        return np.concatenate(frames, axis=0)

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def list_input_devices(device_name: str = None) -> list[dict]:
        """
        Return a list of available input devices as dicts with keys:
        index, name, channels, sample_rate.
        """
        pa = pyaudio.PyAudio()
        devices = []
        device_id = 0
        for i in range(pa.get_device_count()):
            info = pa.get_device_info_by_index(i)
            if info["maxInputChannels"] > 0:
                print(f"[{i}] {info['name']} — {info['maxInputChannels']}ch @ {info['defaultSampleRate']}Hz")
                if device_name is not None and device_name in info["name"]:
                    print('found device '+ device_name)
                    device_id = i
                devices.append({
                    "index":       i,
                    "name":        info["name"],
                    "channels":    int(info["maxInputChannels"]),
                    "sample_rate": int(info["defaultSampleRate"]),
                })
        pa.terminate()
        return device_id, devices

    # ── Context manager ───────────────────────────────────────────────────────

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *_):
        self.stop()

    def __repr__(self) -> str:
        state = "running" if self._stream else "stopped"
        return (
            f"AudioStream(device={self.device_index}, "
            f"rate={self.sample_rate}, ch={self.channels}, "
            f"chunk={self.chunk}, state={state})"
        )