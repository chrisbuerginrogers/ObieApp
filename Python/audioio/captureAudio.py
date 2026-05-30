"""
captureAudio.py

Block on an AudioStream until Channel 1 exceeds a threshold, then return a
capture window as a numpy array of shape (pre_samples + post_samples, channels),
dtype int16.  All parameters are passed in by the caller — this module reads
no configuration files.
"""

import time
import collections
import numpy as np

from .streamAudio import AudioStream


def wait_for_trigger(
    stream: AudioStream,
    threshold: float,
    pre_samples: int,
    post_samples: int,
) -> np.ndarray:
    """
    Block until |Channel 1| exceeds `threshold`, then return an array of
    shape (pre_samples + post_samples, channels), dtype int16.

    The returned array starts pre_samples before the first crossing and ends
    post_samples after it.
    """
    pre_buf: collections.deque[np.ndarray] = collections.deque(maxlen=pre_samples)

    triggered   = False
    post_pieces = []
    post_needed = post_samples
    pre_snapshot: np.ndarray | None = None

    while True:
        chunk = stream.read_chunks()
        if chunk is None:
            time.sleep(0.001)
            continue

        if not triggered:
            ch1  = chunk[:, 0]
            hits = np.where(np.abs(ch1) > threshold)[0]

            if len(hits) == 0:
                for row in chunk:
                    pre_buf.append(row)
                continue

            trig_idx = int(hits[0])

            for row in chunk[:trig_idx]:
                pre_buf.append(row)

            pre_snapshot = np.array(pre_buf)
            triggered    = True
            remainder    = chunk[trig_idx:]

        else:
            remainder = chunk

        if len(remainder) >= post_needed:
            post_pieces.append(remainder[:post_needed])
            break
        else:
            post_pieces.append(remainder)
            post_needed -= len(remainder)

    post_data = np.concatenate(post_pieces, axis=0)

    if pre_snapshot is None or len(pre_snapshot) == 0:
        return post_data

    return np.concatenate([pre_snapshot, post_data], axis=0)
