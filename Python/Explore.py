"""
Explore.py — load a TRF file and visualise it with band analysis.
"""

from fileio.obieapp_config import ROOT, load
from fileio.trf_fileio import parse_trf
from processing.bands import compute_bands, print_bands
from processing.convolution import convolve_with_frf
from plotio.plotIt import plot_trf_bands
from audioio.playAudio import choose_device, play, play

cfg       = load()
file_path = ROOT / cfg['data']['base_dir'] / 'Betts Strad RHV20 H_001.trf'
with open(file_path, 'rb') as f:
    data = parse_trf(f.read())

wav_path      = ROOT / cfg['data']['base_dir'] / 'Tchaikovsky.wav'
audio, sr     = convolve_with_frf(wav_path, file_path)
device        = choose_device()
play(audio, sr, device)

bands = compute_bands(data['freq'], data['mag'], cfg.get('bands', []))
print_bands(bands)
plot_trf_bands(data, bands, file_path.name)


