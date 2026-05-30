"""
Aquire.py

Reads settings from "ObieApp Settings/config.json", captures triggered audio
across all positions and hits, computes averaged FRF and coherence, and exits.
"""

from fileio.obieapp_config import load
from fileio.wavfileio import save_wav
from fileio.runio import setup_run, make_wav_path, save_position_trf, save_test_avg
from plotio.plotCapture import init_capture_plot, update_capture_plot, keep_capture_plot_open
from plotio.dialogs import ask_keep_or_delete
from audioio.streamAudio import AudioStream
from audioio.captureAudio import wait_for_trigger
from processing.frf import FRFAccumulator, add_hit, compute_frf, reset_frf, merge_accumulator

# ── Load config ───────────────────────────────────────────────────────────────
cfg = load()

audio   = cfg["audio"]
trigger = cfg["trigger"]
run     = cfg["run"]
display = cfg["display"]

DEVICE_NAME  = audio["device_name"]
SAMPLE_RATE  = audio["sample_rate"]
FORMAT       = audio["format"]
THRESHOLD    = trigger["threshold"]
PRE_SAMPLES  = int(SAMPLE_RATE * trigger["pre_secs"])
POST_SAMPLES = int(SAMPLE_RATE * trigger["post_secs"])

# ── Set up run folder, Settings.json, Notes.txt ───────────────────────────────
setup_run(cfg)

# ── Capture ───────────────────────────────────────────────────────────────────
device_id, devices = AudioStream.list_input_devices(DEVICE_NAME)
print(devices)

print(f"Waiting for trigger (threshold={THRESHOLD}, device='{DEVICE_NAME}')...")

capture_plot = init_capture_plot(SAMPLE_RATE,
                                 freq_min=display["freq_min"],
                                 freq_max=display["freq_max"])
acc        = FRFAccumulator(sample_rate=SAMPLE_RATE)
acc_global = FRFAccumulator(sample_rate=SAMPLE_RATE)

with AudioStream(device_index=device_id, sample_rate=SAMPLE_RATE, channels=2, fmt=FORMAT) as stream:
    for position in range(1, run["positions"] + 1):
        while True:
            reset_frf(acc)
            print(f"\nPosition {position} of {run['positions']} — waiting for {run['hits']} hits...")
            for hit in range(1, run["hits"] + 1):
                data = wait_for_trigger(stream, threshold=THRESHOLD, pre_samples=PRE_SAMPLES, post_samples=POST_SAMPLES)
                save_wav(make_wav_path(cfg, position=position, hit=hit), data, SAMPLE_RATE)
                add_hit(acc, data)
                freqs, _, _, H_dB, coherence = compute_frf(acc)
                update_capture_plot(capture_plot, data, hit=hit,
                                    freqs=freqs, H_dB=H_dB, coherence=coherence)

            if ask_keep_or_delete(position):
                save_position_trf(cfg, position, acc)
                merge_accumulator(acc_global, acc)
                save_test_avg(cfg, acc_global)
                break  # keep → advance to next position
            else:
                for hit in range(1, run["hits"] + 1):
                    p = make_wav_path(cfg, position=position, hit=hit)
                    if p.exists():
                        p.unlink() # delete the file
                print(f"Position {position} deleted — retrying...")

keep_capture_plot_open()
