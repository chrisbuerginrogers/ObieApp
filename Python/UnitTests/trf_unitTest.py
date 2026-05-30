"""
trf_unitTest.py

Parse a sample .trf file from SampleData and print the header.
"""

from test_header import ROOT, load
import numpy as np
from fileio.trf_fileio import parse_trf, build_trf

file_path = ROOT / load('data')['base_dir'] / "Betts Strad RHV20 H_001.trf"
#file_path = Path("/Users/crogers/Rogers Dropbox/Chris Rogers/Violin Stuff/My Violin - GS/GS Huberman 2020/GS Huberman Rad with chinrest/GS_Huberman_21 with ch rst H_012.trf")

with open(file_path, "rb") as f:
    raw_data = f.read()

data = parse_trf(raw_data)

header_text = "\n".join([f"{key}: {value}" for key, value in data["header"].items()])
print(header_text)

if data["warnings"]:
    print("Warnings:")
    for warning in data["warnings"]:
        print(f"  - {warning}")

# ── Round-trip test ───────────────────────────────────────────────────────────
def _check(label, ok):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        raise AssertionError(label)

print("\n=== Round-trip: .trf ===")
hz_res = float(data["header"]["Hz_Resolution"].split()[0])
mag_linear = [10 ** (m / 20.0) for m in data["mag"]]

rt_path = file_path.parent / "test.trf"
rt_path.write_bytes(build_trf(data["freq"], mag_linear, Hz_Resolution=hz_res))

data2 = parse_trf(rt_path.read_bytes())
_check("no warnings",   not data2["warnings"])
_check("n_rows",        data2["n_rows"] == data["n_rows"])
_check("freq array",    np.allclose(data2["freq"], data["freq"]))
_check("mag array",     np.allclose(data2["mag"],  data["mag"], atol=1e-6))

rt_path.unlink()
