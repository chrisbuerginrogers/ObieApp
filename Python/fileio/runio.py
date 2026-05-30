"""
runio.py

Run folder management: creates the directory structure for a measurement run,
saves a Settings.json snapshot, appends to Notes.txt, and saves per-position
FRF and coherence as .trf files.

Folder layout:
    <data.base_dir>/<instrument>/
    ├── Raw/          ← WAV captures
    ├── trf/          ← FRF + coherence .trf files per position
    ├── Settings.json ← snapshot of config at run time
    └── Notes.txt     ← appended entry for each run
"""

import json
import numpy as np
from datetime import datetime
from pathlib import Path

from .trf_fileio import build_trf


def run_dir(cfg: dict) -> Path:
    """Returns <base_dir>/<instrument>, resolving relative paths from project root."""
    base = Path(cfg["data"]["base_dir"])
    if not base.is_absolute():
        base = Path(__file__).parent.parent / base
    return base / cfg["run"]["instrument"] / cfg["run"]["folder"]


def setup_run(cfg: dict) -> None:
    """Create folder structure, write Settings.json, and append a Notes.txt entry."""
    rd = run_dir(cfg)
    (rd / "Raw").mkdir(parents=True, exist_ok=True)
    (rd / "trf").mkdir(parents=True, exist_ok=True)

    with open(rd / "Settings.json", "w") as f:
        json.dump(cfg, f, indent=2)

    run     = cfg["run"]
    audio   = cfg["audio"]
    trigger = cfg["trigger"]
    now     = datetime.now()

    entry = (
        f"{'='*48}\n"
        f"Date/Time:   {now.strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"Instrument:  {run['instrument']}\n"
        f"Folder:      {run['folder']}\n"
        f"Designation: {run['designation']}\n"
        f"Positions:   {run['positions']}   Hits/pos: {run['hits']}\n"
        f"Sample rate: {audio['sample_rate']} Hz\n"
        f"Threshold:   {trigger['threshold']}   "
        f"Pre: {trigger['pre_secs']} s   Post: {trigger['post_secs']} s\n"
        f"\n"
    )
    with open(rd / "Notes.txt", "a") as f:
        f.write(entry)


def make_wav_path(cfg: dict, position: int, hit: int) -> Path:
    """Build the WAV path for one capture: <run_dir>/Raw/<stem>.wav"""
    run  = cfg["run"]
    stem = f"{run['instrument']} {run['folder']} {run['designation']}_{position:03d}_{hit:03d}"
    return run_dir(cfg) / "Raw" / f"{stem}.wav"


def save_position_trf(cfg: dict, position: int, acc) -> None:
    """
    Save FRF and coherence as .trf files for one position.

    Writes two files to <run_dir>/trf/:
        <stem>.trf      — complex H1 FRF (compatible with plotIt.py)
        <stem>_coh.trf  — real coherence 0–1
    """
    from processing.frf import compute_frf

    run  = cfg["run"]
    stem = f"{run['instrument']} {run['folder']} {run['designation']}_{position:03d}"
    trf_dir = run_dir(cfg) / "trf"

    freqs, H_complex, _, _, coherence = compute_frf(acc)

    (trf_dir / f"{stem}.trf").write_bytes(
        build_trf(freqs.tolist(), H_complex.tolist())
    )
    (trf_dir / f"{stem}_coh.trf").write_bytes(
        build_trf(freqs.tolist(), coherence.tolist())
    )


def save_test_avg(cfg: dict, acc) -> None:
    """
    Save grand-average FRF and coherence as .AvC and .AvR in the test folder.

    File names:  <instrument> <folder> <designation>.AvC / .AvR
    These are overwritten after each accepted position so they always reflect
    the cumulative average across all accepted positions and their hits.
    """
    from .avc_fileio import build_avc, build_avr

    run  = cfg["run"]
    stem = f"{run['instrument']} {run['folder']} {run['designation']}"
    rd   = run_dir(cfg)

    eps       = np.finfo(float).eps
    freqs     = np.fft.rfftfreq(acc.n_samples, d=1.0 / acc.sample_rate)
    H_complex = acc.S_fp / np.where(acc.S_ff > eps, acc.S_ff, eps)
    avg_H_mag = acc.sum_H_mag / acc.n_hits

    (rd / f"{stem}.AvC").write_bytes(
        build_avc(freqs, H_complex, n_averages=acc.n_hits)
    )
    (rd / f"{stem}.AvR").write_bytes(
        build_avr(freqs, avg_H_mag, n_averages=acc.n_hits)
    )
