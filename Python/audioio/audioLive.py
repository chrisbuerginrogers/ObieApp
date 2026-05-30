"""
audio_plot.py — live stereo waveform plotter.

Depends on audio_stream.py being in the same directory (or on PYTHONPATH).
"""

import numpy as np
import matplotlib.pyplot as plt
import matplotlib.animation as animation
import matplotlib
matplotlib.use('TkAgg')   # or 'Qt5Agg' / 'Gtk3Agg'

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))  # add Python Code/ so fileio is findable

from fileio.obieapp_config import load

_audio   = load("audio")
_display = load("display")
DEVICE_NAME     = _audio["device_name"]
AUDIO_FORMAT    = _audio["format"]
SAMPLE_RATE     = _audio["sample_rate"]
CHUNK_SIZE      = _audio["chunk_size"]
DISPLAY_SECONDS = _display["display_seconds"]
MIN_MAX_DECAY   = _display["min_max_decay"]

from audioio.streamAudio import AudioStream

id,devices =  AudioStream.list_input_devices(DEVICE_NAME)

# ── Build the AudioStream ─────────────────────────────────────────────────────
stream = AudioStream(device_index=id, sample_rate=SAMPLE_RATE, chunk=CHUNK_SIZE, fmt=AUDIO_FORMAT)

BUFFER_SIZE = int(stream.sample_rate * DISPLAY_SECONDS)
x = np.linspace(2, DISPLAY_SECONDS * 1000, BUFFER_SIZE)  # ms

buffers     = [np.zeros(BUFFER_SIZE, dtype=stream.np_fmt) for _ in range(stream.channels)]
running_min = [0.0] * stream.channels
running_max = [0.0] * stream.channels

# ── Plot layout ───────────────────────────────────────────────────────────────
COLORS        = ["#ff4444", "#4488ff"]
MINMAX_COLORS = ["#cc2222", "#2266cc"]
LABELS        = ["Left (hammer)", "Right (microphone)"]

fig, axes = plt.subplots(2, 1, figsize=(10, 6), sharex=True)
fig.patch.set_facecolor("#0d1117")
fig.suptitle("Live Stereo Audio Input", color="#ffffff", fontsize=13)

lines      = []
hlines_min = []
hlines_max = []
txt_min    = []
txt_max    = []

for i, ax in enumerate(axes):
    ax.set_facecolor("#0d1117")

    (ln,) = ax.plot(x, buffers[i], color=COLORS[i], linewidth=0.8)
    lines.append(ln)

    hmax = ax.axhline(0, color=MINMAX_COLORS[i], linewidth=0.8, linestyle="--", alpha=0.7)
    hmin = ax.axhline(0, color=MINMAX_COLORS[i], linewidth=0.8, linestyle="--", alpha=0.7)
    hlines_max.append(hmax)
    hlines_min.append(hmin)

    bbox_props = dict(boxstyle="round,pad=0.2", fc="#0d1117",
                      ec=MINMAX_COLORS[i], alpha=0.8, linewidth=0.6)
    txt_max.append(ax.text(0.01, 0.97, "", transform=ax.transAxes,
                            color=MINMAX_COLORS[i], fontsize=7,
                            va="top", ha="left", bbox=bbox_props))
    txt_min.append(ax.text(0.01, 0.03, "", transform=ax.transAxes,
                            color=MINMAX_COLORS[i], fontsize=7,
                            va="bottom", ha="left", bbox=bbox_props))

    ax.set_xlim(0, DISPLAY_SECONDS * 1000)
    ax.set_ylim(*stream.value_range)
    ax.set_ylabel(f"{LABELS[i]}  ({stream.np_fmt.__name__})", color=COLORS[i], fontsize=10)
    ax.tick_params(colors="#aaaaaa")
    for spine in ax.spines.values():
        spine.set_edgecolor("#333333")

axes[-1].set_xlabel("Time (ms)", color="#aaaaaa")
fig.tight_layout(rect=[0, 0, 0.97, 0.95])


# ── Animation update ──────────────────────────────────────────────────────────
def update(_frame):
    new_data = stream.read_chunks()   # shape (n, channels) or None

    if new_data is not None:
        for ch in range(stream.channels):
            ch_data = new_data[:, ch]
            n = len(ch_data)

            buffers[ch] = np.roll(buffers[ch], -n)
            buffers[ch][-n:] = ch_data[:BUFFER_SIZE]
            lines[ch].set_ydata(buffers[ch])

            running_max[ch] = max(float(ch_data.max()), running_max[ch] * MIN_MAX_DECAY)
            running_min[ch] = min(float(ch_data.min()), running_min[ch] * MIN_MAX_DECAY)

    artists = list(lines)
    for ch in range(stream.channels):
        hlines_max[ch].set_ydata([running_max[ch], running_max[ch]])
        hlines_min[ch].set_ydata([running_min[ch], running_min[ch]])
        txt_max[ch].set_text(f"max: {running_max[ch]:+f}")
        txt_min[ch].set_text(f"min: {running_min[ch]:+f}")
        artists += [hlines_max[ch], hlines_min[ch], txt_max[ch], txt_min[ch]]

    return artists


print("Plotting stereo audio — close the window to stop.")
stream.start()  # must be before FuncAnimation: blit=True calls update() during __init__

# blit=False — redraws the entire figure every frame (slow)
# blit=True — only redraws the artists returned by your update() function (fast)

ani = animation.FuncAnimation(
    fig,
    update,
    interval=20,
    blit=True,
    cache_frame_data=False,
)

try:
    plt.show()
except AttributeError:
    # Matplotlib bug: FuncAnimation._resize_id may not exist if the window
    # is closed before the first draw completes. Safe to ignore.
    pass
finally:
    stream.stop()
    print("Stream closed.")