"""
bands_unitTest.py

Load the sample TRF file, compute band averages and centroids, verify the
results match expected values, and print the table.
"""

from test_header import ROOT, load
from fileio.trf_fileio import parse_trf
from processing.bands import compute_bands, print_bands

# ── Load data ─────────────────────────────────────────────────────────────────
cfg       = load()
file_path = ROOT / cfg['data']['base_dir'] / 'Betts Strad RHV20 H_001.trf'

with open(file_path, 'rb') as f:
    data = parse_trf(f.read())

bands = compute_bands(data['freq'], data['mag'], cfg['bands'])

# ── Expected values (avg to 2 dp, centroid to 1 dp) ──────────────────────────
EXPECTED = [
    {'label': 'Low body',    'f_lo': 200,  'f_hi': 400,  'avg_db': 28.56, 'centroid':  316.2},
    {'label': 'Bridge rise', 'f_lo': 400,  'f_hi': 800,  'avg_db': 33.36, 'centroid':  574.5},
    {'label': 'Bridge hill', 'f_lo': 800,  'f_hi': 1600, 'avg_db': 29.97, 'centroid': 1162.7},
    {'label': 'Upper mid',   'f_lo': 1600, 'f_hi': 3200, 'avg_db': 29.82, 'centroid': 2455.9},
    {'label': 'High',        'f_lo': 3200, 'f_hi': 7000, 'avg_db': 29.66, 'centroid': 4706.1},
]

# ── Checks ────────────────────────────────────────────────────────────────────
def _check(label, ok):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        raise AssertionError(label)

print("\n=== Band analysis ===")
_check("correct number of bands", len(bands) == len(EXPECTED))

for b, e in zip(bands, EXPECTED):
    _check(f"{e['label']:14s}  label",    b['label'] == e['label'])
    _check(f"{e['label']:14s}  f_lo",     b['f_lo']  == e['f_lo'])
    _check(f"{e['label']:14s}  f_hi",     b['f_hi']  == e['f_hi'])
    _check(f"{e['label']:14s}  avg_db",   abs(b['avg_db']  - e['avg_db'])  < 0.005)
    _check(f"{e['label']:14s}  centroid", abs(b['centroid'] - e['centroid']) < 0.05)

# ── Print table ───────────────────────────────────────────────────────────────
print_bands(bands)
