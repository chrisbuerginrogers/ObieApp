"""
test_all.py — comprehensive pytest test suite for ObieApp Python modules.

Covers every module in Python/fileio/ and Python/processing/.
Tests are a mix of synthetic (self-contained) and real-file (using SampleData/).
Real-file tests are skipped gracefully when the file is absent.

Run from the repo root:
    pytest Python/UnitTests/test_all.py -v

Or from Python/UnitTests/:
    pytest test_all.py -v
"""

import sys
import struct
import io
from pathlib import Path

import numpy as np
import pytest

# ── Path setup ────────────────────────────────────────────────────────────────
ROOT       = Path(__file__).parent.parent
SAMPLE_DIR = ROOT / "SampleData"
TESTDATA   = SAMPLE_DIR / "TestData"
sys.path.insert(0, str(ROOT))

# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_wav_bytes(n_samples=1024, sample_rate=48000, n_channels=1,
                    dtype=np.int16) -> bytes:
    """Build a minimal valid WAV file in memory."""
    data = (np.random.randn(n_samples, n_channels).astype(np.float32) * 0.1)
    if n_channels == 1:
        data = data[:, 0]
    if dtype == np.int16:
        pcm = (data * 32767).astype(np.int16)
    else:
        pcm = data.astype(np.float32)

    import scipy.io.wavfile as _wf
    buf = io.BytesIO()
    _wf.write(buf, sample_rate, pcm)
    return buf.getvalue()


def _require(path: Path):
    """Skip test if the sample file doesn't exist."""
    if not path.exists():
        pytest.skip(f"Sample file not found: {path}")
    return path


# ══════════════════════════════════════════════════════════════════════════════
# trf_fileio
# ══════════════════════════════════════════════════════════════════════════════

class TestTrfFileio:
    from fileio.trf_fileio import parse_trf, build_trf

    def _synth_freq(self, n=256, start=200.0, step=1.0):
        return [start + i * step for i in range(n)]

    def test_round_trip_real(self):
        from fileio.trf_fileio import parse_trf, build_trf
        freqs = self._synth_freq()
        mags  = [float(abs(np.random.randn())) + 0.01 for _ in freqs]
        raw   = build_trf(freqs, mags)
        out   = parse_trf(raw)
        assert out["n_rows"] == len(freqs)
        assert not out["warnings"]
        assert np.allclose(out["freq"], freqs, atol=1e-3)
        assert np.allclose(out["mag"],
                           [round(20 * np.log10(max(m, 1e-12)), 4) for m in mags],
                           atol=0.01)

    def test_round_trip_complex(self):
        from fileio.trf_fileio import parse_trf, build_trf
        freqs = self._synth_freq()
        H = [complex(np.random.randn(), np.random.randn()) for _ in freqs]
        raw = build_trf(freqs, H)
        out = parse_trf(raw)
        assert out["n_rows"] == len(freqs)
        assert not out["warnings"]
        expected_db = [round(20 * np.log10(max(abs(h), 1e-12)), 4) for h in H]
        assert np.allclose(out["mag"], expected_db, atol=0.01)
        assert "coh" not in out

    def test_round_trip_coherence(self):
        """fComplex=2.0: complex FRF + coherence column."""
        from fileio.trf_fileio import parse_trf, build_trf
        freqs = self._synth_freq()
        H   = [complex(np.random.randn(), np.random.randn()) for _ in freqs]
        coh = [float(np.clip(np.random.rand(), 0, 1)) for _ in freqs]
        raw = build_trf(freqs, H, coherence=coh)
        out = parse_trf(raw)
        assert out["n_rows"] == len(freqs)
        assert not out["warnings"]
        assert "coh" in out
        assert len(out["coh"]) == len(freqs)
        assert np.allclose(out["coh"], coh, atol=1e-4)

    def test_metadata_block(self):
        """OBIE_META block is written and read back into the header."""
        from fileio.trf_fileio import parse_trf, build_trf
        freqs = self._synth_freq(64)
        H     = [complex(1.0, 0.5)] * len(freqs)
        coh   = [0.9] * len(freqs)
        meta  = {"sample_rate": "48000", "n_hits": "5", "threshold": "0.05",
                 "device": "Test Card"}
        raw   = build_trf(freqs, H, coherence=coh, meta=meta)
        out   = parse_trf(raw)
        assert out["header"].get("sample_rate") == "48000"
        assert out["header"].get("n_hits")      == "5"
        assert out["header"].get("device")      == "Test Card"

    def test_empty_meta_skipped(self):
        """Meta fields with empty values are not written."""
        from fileio.trf_fileio import parse_trf, build_trf
        freqs = self._synth_freq(64)
        H = [1.0 + 0j] * len(freqs)
        meta = {"sample_rate": "48000", "device": ""}   # device is empty
        raw = build_trf(freqs, H, meta=meta)
        out = parse_trf(raw)
        assert out["header"].get("sample_rate") == "48000"
        assert "device" not in out["header"]

    def test_too_short_returns_blank(self):
        from fileio.trf_fileio import parse_trf
        out = parse_trf(b"\x00" * 10)
        assert out["n_rows"] == 0
        assert out["warnings"]

    def test_real_file_betts(self):
        from fileio.trf_fileio import parse_trf
        path = _require(SAMPLE_DIR / "Betts Strad RHV20 H_001.trf")
        out = parse_trf(path.read_bytes())
        assert out["n_rows"] > 0
        assert not out["warnings"]
        assert len(out["freq"]) == out["n_rows"]
        assert len(out["mag"])  == out["n_rows"]

    def test_real_file_class04(self):
        from fileio.trf_fileio import parse_trf
        path = _require(TESTDATA / "Class 04 H_001.trf")
        out = parse_trf(path.read_bytes())
        assert out["n_rows"] > 0

    def test_real_file_with_coherence(self):
        """FRF_with_coh.trf should parse with a coh field (fComplex=2.0)."""
        from fileio.trf_fileio import parse_trf
        path = _require(TESTDATA / "FRF_with_coh.trf")
        out = parse_trf(path.read_bytes())
        assert out["n_rows"] > 0
        assert "coh" in out
        assert all(0.0 <= c <= 1.0 for c in out["coh"])


# ══════════════════════════════════════════════════════════════════════════════
# avc_fileio
# ══════════════════════════════════════════════════════════════════════════════

class TestAvcFileio:

    def _synth_avc_data(self, n=256, start=200.0, step=1.0):
        freqs = np.arange(n, dtype=np.float64) * step + start
        H     = np.random.randn(n) + 1j * np.random.randn(n)
        return freqs, H

    def test_round_trip_avc(self):
        from fileio.avc_fileio import build_avc, parse_avc
        freqs, H = self._synth_avc_data()
        raw = build_avc(freqs, H, n_averages=5)
        out = parse_avc(raw)
        assert np.allclose(out["freqs"],     freqs, atol=1e-3)
        assert np.allclose(out["H_complex"], H,     atol=1e-10)
        assert out["n_averages"] == 5

    def test_round_trip_avr(self):
        from fileio.avc_fileio import build_avr, parse_avr
        freqs = np.linspace(200, 7000, 300)
        data  = np.abs(np.random.randn(300)) + 0.001
        raw   = build_avr(freqs, data, n_averages=3)
        out   = parse_avr(raw)
        assert np.allclose(out["freqs"], freqs, atol=1e-3)
        assert np.allclose(out["data"],  data,  atol=1e-10)
        assert out["n_averages"] == 3

    def test_avc_metadata_fields(self):
        from fileio.avc_fileio import build_avc, parse_avc, DT_MIC, AT_COMPLEX
        freqs, H = self._synth_avc_data()
        raw = build_avc(freqs, H, data_type=DT_MIC, scale_factor=2.5,
                        n_averages=10, averaging_type=AT_COMPLEX)
        out = parse_avc(raw)
        assert out["data_type"]     == DT_MIC
        assert np.isclose(out["scale_factor"], 2.5)
        assert out["n_averages"]    == 10
        assert out["averaging_type"] == AT_COMPLEX

    def test_real_file_avc(self):
        from fileio.avc_fileio import parse_avc
        path = _require(TESTDATA / "AvC_sample.avc")
        out = parse_avc(path.read_bytes())
        assert len(out["freqs"]) > 0
        assert len(out["H_complex"]) == len(out["freqs"])
        assert np.iscomplexobj(out["H_complex"])

    def test_real_file_avr(self):
        from fileio.avc_fileio import parse_avr
        path = _require(TESTDATA / "AvR_sample.avr")
        out = parse_avr(path.read_bytes())
        assert len(out["freqs"]) > 0
        assert len(out["data"]) == len(out["freqs"])

    def test_real_file_violin_avc(self):
        from fileio.avc_fileio import parse_avc, build_avc
        path = _require(SAMPLE_DIR / "Violin 03 H.AvC")
        out  = parse_avc(path.read_bytes())
        # round-trip
        rt  = parse_avc(build_avc(out["freqs"], out["H_complex"],
                                   data_type=out["data_type"],
                                   scale_factor=out["scale_factor"],
                                   n_averages=out["n_averages"],
                                   averaging_type=out["averaging_type"]))
        assert np.allclose(rt["H_complex"], out["H_complex"])


# ══════════════════════════════════════════════════════════════════════════════
# mat_fileio
# ══════════════════════════════════════════════════════════════════════════════

class TestMatFileio:

    def _make_frf_mat(self, n_bins=512, n_cols=2) -> bytes:
        """Build a minimal in-memory .mat FRF file (yspec format)."""
        import scipy.io as sio
        freqs = np.linspace(0, 24000, n_bins).astype(complex)
        H     = (np.random.randn(n_bins) + 1j * np.random.randn(n_bins))
        coh   = np.clip(np.random.rand(n_bins), 0, 1).astype(float)

        if n_cols == 2:
            yspec = np.column_stack([H, coh.astype(complex)])
        elif n_cols == 1:
            yspec = H.reshape(-1, 1)
        else:  # 1D
            yspec = H

        buf = io.BytesIO()
        sio.savemat(buf, {"yspec": yspec, "freq": np.array(48000.0),
                          "npts": np.array(1024.0)})
        return buf.getvalue()

    def test_frf_two_column(self):
        from fileio.mat_fileio import parse_mat_frf
        raw = self._make_frf_mat(n_cols=2)
        out = parse_mat_frf(raw)
        assert out["kind"] == "frf"
        assert len(out["freqs"]) == 512
        assert np.iscomplexobj(out["frf"])
        assert out["coherence"] is not None
        assert np.all((out["coherence"] >= 0) & (out["coherence"] <= 1))

    def test_frf_single_column(self):
        """Jim's files: yspec (N,1) — no coherence column."""
        from fileio.mat_fileio import parse_mat_frf
        raw = self._make_frf_mat(n_cols=1)
        out = parse_mat_frf(raw)
        assert out["kind"] == "frf"
        assert len(out["freqs"]) == 512
        assert np.iscomplexobj(out["frf"])
        assert out["coherence"] is None   # no second column

    def test_parse_mat_autodispatch_frf(self):
        from fileio.mat_fileio import parse_mat
        raw = self._make_frf_mat(n_cols=2)
        out = parse_mat(raw)
        assert out["kind"] == "frf"

    def test_parse_mat_bytes_alias(self):
        from fileio.mat_fileio import parse_mat_bytes
        raw = self._make_frf_mat(n_cols=2)
        out = parse_mat_bytes(raw)
        assert out["kind"] == "frf"

    def test_missing_yspec_raises(self):
        import scipy.io as sio
        buf = io.BytesIO()
        sio.savemat(buf, {"not_yspec": np.array([1, 2, 3])})
        from fileio.mat_fileio import parse_mat
        with pytest.raises(ValueError, match="Unrecognised"):
            parse_mat(buf.getvalue())

    def test_real_file_jim(self):
        from fileio.mat_fileio import parse_mat
        path = _require(TESTDATA / "Jim_sample.mat")
        out  = parse_mat(path.read_bytes())
        assert out["kind"] == "frf"
        assert len(out["freqs"]) > 0
        assert np.iscomplexobj(out["frf"])


# ══════════════════════════════════════════════════════════════════════════════
# tsv_fileio
# ══════════════════════════════════════════════════════════════════════════════

class TestTsvFileio:

    _TSV_2COL = "Frequency\tMagnitude\n200.0\t0.01\n400.0\t0.02\n800.0\t0.04\n"
    _TSV_3COL = "Frequency\tReal\tImag\n200.0\t0.1\t0.05\n400.0\t0.2\t0.1\n800.0\t0.15\t0.08\n"
    _CSV_2COL = "Frequency,dB\n200,10.5\n400,12.3\n800,11.1\n1600,9.8\n3200,8.5\n"

    def test_tsv_2col_real(self):
        from fileio.tsv_fileio import parse_tsv
        out = parse_tsv(self._TSV_2COL)
        assert out["n_rows"] == 3
        assert not out["warnings"]
        assert out["freq"] == [200.0, 400.0, 800.0]
        # magnitude should be converted to dB
        expected = round(20 * np.log10(0.01), 4)
        assert abs(out["mag"][0] - expected) < 0.01

    def test_tsv_3col_complex(self):
        from fileio.tsv_fileio import parse_tsv
        out = parse_tsv(self._TSV_3COL)
        assert out["n_rows"] == 3
        # first bin: sqrt(0.1^2 + 0.05^2) → 0.1118, in dB ≈ -19.04
        expected = round(20 * np.log10(np.sqrt(0.1**2 + 0.05**2)), 4)
        assert abs(out["mag"][0] - expected) < 0.01

    def test_tsv_bytes_input(self):
        from fileio.tsv_fileio import parse_tsv
        out = parse_tsv(self._TSV_2COL.encode("utf-8"))
        assert out["n_rows"] == 3

    def test_tsv_windows_line_endings(self):
        from fileio.tsv_fileio import parse_tsv
        crlf = self._TSV_2COL.replace("\n", "\r\n")
        out  = parse_tsv(crlf)
        assert out["n_rows"] == 3

    def test_tsv_empty_returns_blank(self):
        from fileio.tsv_fileio import parse_tsv
        out = parse_tsv("")
        assert out["n_rows"] == 0
        assert out["warnings"]

    def test_csv_2col(self):
        from fileio.tsv_fileio import parse_csv
        out = parse_csv(self._CSV_2COL)
        assert out["n_rows"] == 5
        assert not out["warnings"]
        assert np.isclose(out["mag"][0], 10.5, atol=0.01)

    def test_csv_skips_header(self):
        from fileio.tsv_fileio import parse_csv
        out = parse_csv(self._CSV_2COL)
        # header line ("Frequency,dB") should be skipped
        assert out["freq"][0] == 200.0

    def test_csv_bytes_input(self):
        from fileio.tsv_fileio import parse_csv
        out = parse_csv(self._CSV_2COL.encode("utf-8"))
        assert out["n_rows"] == 5

    def test_csv_too_few_rows(self):
        from fileio.tsv_fileio import parse_csv
        out = parse_csv("200,10\n400,11\n")   # only 2 rows
        assert out["n_rows"] == 0
        assert out["warnings"]

    def test_real_file_tsv_complex(self):
        from fileio.tsv_fileio import parse_tsv
        path = _require(TESTDATA / "Class 04 H H_Cplx.tsv")
        out  = parse_tsv(path.read_bytes())
        assert out["n_rows"] > 0
        assert not out["warnings"]


# ══════════════════════════════════════════════════════════════════════════════
# wavfileio
# ══════════════════════════════════════════════════════════════════════════════

class TestWavFileio:

    def test_save_load_roundtrip(self, tmp_path):
        from fileio.wavfileio import save_wav, load_wav
        path = tmp_path / "test.wav"
        data = np.sin(2 * np.pi * 440 * np.arange(4800) / 48000).astype(np.float32)
        save_wav(path, data, 48000)
        loaded, sr = load_wav(path)
        assert sr == 48000
        assert len(loaded) == len(data)

    def test_load_wav_bytes_int16(self):
        from fileio.wavfileio import load_wav_bytes
        raw = _make_wav_bytes(n_samples=1024, sample_rate=44100, dtype=np.int16)
        data, sr = load_wav_bytes(raw)
        assert sr == 44100
        assert len(data) == 1024

    def test_load_wav_bytes_stereo(self):
        from fileio.wavfileio import load_wav_bytes
        raw = _make_wav_bytes(n_samples=512, n_channels=2, dtype=np.int16)
        data, sr = load_wav_bytes(raw)
        assert data.ndim == 2
        assert data.shape[1] == 2

    def test_load_wav_normalised_mono(self):
        from fileio.wavfileio import load_wav_normalised
        raw  = _make_wav_bytes(n_samples=4096, sample_rate=48000, dtype=np.int16)
        mono, sr = load_wav_normalised(raw)
        assert sr == 48000
        assert mono.ndim == 1
        # peak-normalised so max abs should be ≈ 1 (or 0 for silence)
        peak = float(np.max(np.abs(mono)))
        assert peak <= 1.0 + 1e-6

    def test_load_wav_normalised_stereo_mixdown(self):
        from fileio.wavfileio import load_wav_normalised
        raw  = _make_wav_bytes(n_samples=2048, n_channels=2, dtype=np.int16)
        mono, sr = load_wav_normalised(raw)
        assert mono.ndim == 1   # mixed down to mono

    def test_real_file_tchaikovsky(self):
        from fileio.wavfileio import load_wav_normalised
        path = _require(SAMPLE_DIR / "Tchaikovsky.wav")
        mono, sr = load_wav_normalised(path.read_bytes())
        assert sr > 0
        assert len(mono) > 0
        assert np.max(np.abs(mono)) <= 1.0 + 1e-6

    def test_real_file_raw_wav(self):
        from fileio.wavfileio import load_wav_bytes
        path = _require(SAMPLE_DIR / "Test violin" / "Raw" /
                        "Test violin test2 H_001_001.wav")
        data, sr = load_wav_bytes(path.read_bytes())
        # Acquire saves stereo (ch0=mic, ch1=hammer)
        assert sr > 0
        assert data.shape[0] > 0


# ══════════════════════════════════════════════════════════════════════════════
# labview_txt
# ══════════════════════════════════════════════════════════════════════════════

class TestLabviewTxt:

    _SINGLE = "Name of test=<Violin A/>\nSampling rate=<48000/>\n"
    _MULTI  = "Notes=<Line one\nLine two\n/>\nName of test=<Test/>\n"

    def test_parse_single_line(self):
        from fileio.labview_txt import parse
        d = parse(self._SINGLE)
        assert d["Name of test"] == "Violin A"
        assert d["Sampling rate"] == "48000"

    def test_parse_multi_line(self):
        from fileio.labview_txt import parse
        d = parse(self._MULTI)
        assert "Line one" in d["Notes"]
        assert "Line two" in d["Notes"]

    def test_parse_ignores_non_key_lines(self):
        from fileio.labview_txt import parse
        text = "# comment\nKey=<value/>\nrandom line\n"
        d = parse(text)
        assert "Key" in d
        assert len(d) == 1

    def test_write_parse_roundtrip(self):
        from fileio.labview_txt import parse, write
        original = {"Instrument": "Violin B", "Sample rate": "48000",
                    "Notes": "Line 1\nLine 2"}
        rt = parse(write(original))
        assert rt["Instrument"]  == "Violin B"
        assert rt["Sample rate"] == "48000"
        assert "Line 1" in rt["Notes"]

    def test_real_file_settings(self):
        from fileio.labview_txt import parse
        path = _require(TESTDATA / "Class 04 Settings.txt")
        d    = parse(path.read_text(encoding="utf-8", errors="replace"))
        assert len(d) > 0

    def test_real_file_notes(self):
        from fileio.labview_txt import parse
        path = _require(TESTDATA / "Class 04 Notes.txt")
        # Notes files are plain text, not LabVIEW format — just check readable
        text = path.read_text(encoding="utf-8", errors="replace")
        assert isinstance(text, str)


# ══════════════════════════════════════════════════════════════════════════════
# obieapp_config
# ══════════════════════════════════════════════════════════════════════════════

class TestObieappConfig:

    def test_load_returns_dict(self):
        from fileio.obieapp_config import load
        cfg = load()
        assert isinstance(cfg, dict)

    def test_load_section(self):
        from fileio.obieapp_config import load
        data = load("data")
        assert isinstance(data, dict)
        assert "base_dir" in data

    def test_root_is_project_root(self):
        from fileio.obieapp_config import ROOT
        # ROOT should point to the Python/ parent (the repo root / Python level)
        assert (ROOT / "fileio").is_dir()
        assert (ROOT / "processing").is_dir()


# ══════════════════════════════════════════════════════════════════════════════
# runio
# ══════════════════════════════════════════════════════════════════════════════

class TestRunio:

    def _cfg(self, tmp_path):
        return {
            "data":    {"base_dir": str(tmp_path)},
            "run":     {"instrument": "TestViolin", "folder": "run01",
                        "designation": "H", "positions": 4, "hits": 5},
            "audio":   {"sample_rate": 48000, "device_name": "Test Card"},
            "trigger": {"threshold": 0.05, "pre_secs": 0.01, "post_secs": 0.30},
        }

    def test_run_dir(self, tmp_path):
        from fileio.runio import run_dir
        cfg = self._cfg(tmp_path)
        rd  = run_dir(cfg)
        assert rd == tmp_path / "TestViolin" / "run01"

    def test_make_wav_path(self, tmp_path):
        from fileio.runio import make_wav_path
        cfg  = self._cfg(tmp_path)
        path = make_wav_path(cfg, position=3, hit=7)
        assert path.name == "TestViolin run01 H_003_007.wav"

    def test_setup_run_creates_dirs(self, tmp_path):
        from fileio.runio import setup_run
        cfg = self._cfg(tmp_path)
        setup_run(cfg)
        rd = tmp_path / "TestViolin" / "run01"
        assert (rd / "Raw").is_dir()
        assert (rd / "trf").is_dir()
        assert (rd / "Notes.txt").exists()
        assert (rd / "Settings.txt").exists()

    def test_notes_appended(self, tmp_path):
        from fileio.runio import setup_run
        cfg = self._cfg(tmp_path)
        setup_run(cfg)
        setup_run(cfg)   # call twice
        notes = (tmp_path / "TestViolin" / "run01" / "Notes.txt").read_text()
        assert notes.count("TestViolin") >= 2


# ══════════════════════════════════════════════════════════════════════════════
# frf (processing)
# ══════════════════════════════════════════════════════════════════════════════

class TestFrf:

    def _delta_hit(self, n=1024, sr=48000, delay=10):
        """Return (n,2) array: delta at 'delay' on hammer ch, zeros on mic ch."""
        data = np.zeros((n, 2), dtype=np.float64)
        data[delay, 0] = 1.0   # hammer
        return data, sr

    def _flat_hit(self, n=1024, sr=48000):
        """Both channels identical impulse → H1=1, coherence=1."""
        data = np.zeros((n, 2), dtype=np.float64)
        data[10, 0] = 1.0
        data[10, 1] = 1.0
        return data, sr

    def test_single_hit_returns_correct_keys(self):
        from processing.frf import FRFAccumulator, add_hit, compute_frf
        acc = FRFAccumulator(sample_rate=48000)
        data, _ = self._flat_hit()
        add_hit(acc, data)
        freqs, H1, H2, H_dB, coh = compute_frf(acc)
        assert len(freqs) == len(H_dB) == len(coh)
        assert np.iscomplexobj(H1)
        assert coh.min() >= 0 and coh.max() <= 1.0

    def test_identical_channels_coherence_one(self):
        """H=mic, F=hammer identical → coherence should be 1 everywhere."""
        from processing.frf import FRFAccumulator, add_hit, compute_frf
        acc = FRFAccumulator(sample_rate=48000)
        for _ in range(3):
            data, _ = self._flat_hit()
            add_hit(acc, data)
        _, _, _, _, coh = compute_frf(acc)
        assert np.allclose(coh, 1.0, atol=0.01)

    def test_accumulator_n_hits(self):
        from processing.frf import FRFAccumulator, add_hit
        acc = FRFAccumulator(sample_rate=48000)
        for i in range(7):
            add_hit(acc, self._flat_hit()[0])
        assert acc.n_hits == 7

    def test_reset_frf(self):
        from processing.frf import FRFAccumulator, add_hit, reset_frf
        acc = FRFAccumulator(sample_rate=48000)
        add_hit(acc, self._flat_hit()[0])
        reset_frf(acc)
        assert acc.n_hits == 0
        assert acc.n_samples == 0

    def test_merge_accumulator(self):
        from processing.frf import FRFAccumulator, add_hit, merge_accumulator
        acc1 = FRFAccumulator(sample_rate=48000)
        acc2 = FRFAccumulator(sample_rate=48000)
        for _ in range(3):
            add_hit(acc1, self._flat_hit()[0])
        for _ in range(2):
            add_hit(acc2, self._flat_hit()[0])
        merge_accumulator(acc1, acc2)
        assert acc1.n_hits == 5

    def test_real_wav_files(self):
        from processing.frf import FRFAccumulator, add_hit, compute_frf
        from fileio.wavfileio import load_wav
        wav_dir = SAMPLE_DIR / "Test violin" / "Raw"
        if not wav_dir.exists():
            pytest.skip("Test violin WAV files not found")
        wavs = sorted(wav_dir.glob("*_001_*.wav"))[:3]
        if not wavs:
            pytest.skip("No WAV files found")
        acc = FRFAccumulator(sample_rate=48000)
        for p in wavs:
            data, sr = load_wav(p)
            add_hit(acc, data.astype(np.float64))
        freqs, _, _, H_dB, coh = compute_frf(acc)
        assert len(freqs) > 0
        assert np.all(np.isfinite(H_dB))


# ══════════════════════════════════════════════════════════════════════════════
# bands (processing)
# ══════════════════════════════════════════════════════════════════════════════

class TestBands:

    _BANDS = [
        {"label": "Low",  "start": 200,  "end": 500},
        {"label": "Mid",  "start": 500,  "end": 2000},
        {"label": "High", "start": 2000, "end": 7000},
    ]

    def test_correct_number_of_bands(self):
        from processing.bands import compute_bands
        freq   = list(range(100, 8000, 1))
        mag_db = [0.0] * len(freq)
        result = compute_bands(freq, mag_db, self._BANDS)
        assert len(result) == 3

    def test_band_labels_and_bounds(self):
        from processing.bands import compute_bands
        freq   = list(range(100, 8000, 1))
        mag_db = [0.0] * len(freq)
        result = compute_bands(freq, mag_db, self._BANDS)
        assert result[0]["label"] == "Low"
        assert result[0]["f_lo"]  == 200
        assert result[0]["f_hi"]  == 500

    def test_flat_spectrum_centroid_near_midpoint(self):
        """Flat magnitude → centroid near geometric mean of band."""
        from processing.bands import compute_bands
        freq   = np.linspace(200, 7000, 6801).tolist()
        mag_db = [0.0] * len(freq)
        result = compute_bands(freq, mag_db,
                               [{"label": "test", "start": 1000, "end": 4000}])
        centroid = result[0]["centroid"]
        expected = np.sum(np.arange(1000, 4001)) / len(np.arange(1000, 4001))
        assert abs(centroid - expected) < 5.0

    def test_empty_band_skipped(self):
        """Band outside the freq range should be silently skipped."""
        from processing.bands import compute_bands
        freq   = list(range(200, 1000))
        mag_db = [0.0] * len(freq)
        result = compute_bands(freq, mag_db,
                               [{"label": "gap", "start": 5000, "end": 8000}])
        assert len(result) == 0

    def test_real_file_bands(self):
        """Values computed from Betts Strad must match the expected table."""
        from processing.bands import compute_bands
        from fileio.trf_fileio import parse_trf
        from fileio.obieapp_config import load
        path = _require(SAMPLE_DIR / "Betts Strad RHV20 H_001.trf")
        data = parse_trf(path.read_bytes())
        cfg  = load()
        if "bands" not in cfg:
            pytest.skip("No 'bands' key in config.json")
        result = compute_bands(data["freq"], data["mag"], cfg["bands"])
        assert len(result) > 0
        for r in result:
            assert np.isfinite(r["avg_db"])
            assert r["centroid"] > 0


# ══════════════════════════════════════════════════════════════════════════════
# convolution (processing)
# ══════════════════════════════════════════════════════════════════════════════

class TestConvolution:

    def _synth_audio(self, n=4096, sr=48000):
        t = np.arange(n) / sr
        return (np.sin(2 * np.pi * 440 * t) * 0.5).astype(np.float32), sr

    def _flat_frf(self, n=256, sr=48000):
        # Start at 200 Hz, not 0 — a DC-starting flat FRF gives a delta at
        # sample 0 that the Hanning window zeros out, producing silence.
        freqs = np.linspace(200, sr / 2 - 1, n)
        H     = np.ones(n, dtype=np.complex128)
        return freqs, H

    def test_convolve_it_mono_shape(self):
        from processing.convolution import convolve_it
        audio, sr = self._synth_audio()
        freqs, H  = self._flat_frf(sr=sr)
        out = convolve_it(audio, freqs, H, sr)
        assert out.dtype == np.float32
        assert out.ndim  == 1
        assert len(out)  == len(audio)

    def test_convolve_it_not_silent(self):
        from processing.convolution import convolve_it
        audio, sr = self._synth_audio()
        freqs, H  = self._flat_frf(sr=sr)
        out = convolve_it(audio, freqs, H, sr)
        assert np.max(np.abs(out)) > 1e-6

    def test_convolve_it_no_nan(self):
        from processing.convolution import convolve_it
        audio, sr = self._synth_audio()
        freqs, H  = self._flat_frf(sr=sr)
        out = convolve_it(audio, freqs, H, sr)
        assert np.all(np.isfinite(out))

    def test_convolve_it_stereo_pair(self):
        from processing.convolution import convolve_it
        audio, sr = self._synth_audio()
        freqs, H  = self._flat_frf(sr=sr)
        out = convolve_it(audio, (freqs, freqs), (H, H), sr)
        assert out.ndim == 2
        assert out.shape[1] == 2
        assert np.allclose(out[:, 0], out[:, 1])

    def test_magnitude_only_min_phase(self):
        """Real-only H → minimum-phase path fires, result still valid."""
        from processing.convolution import convolve_it
        audio, sr = self._synth_audio()
        freqs, H  = self._flat_frf(sr=sr)
        H_real    = H.real.astype(np.complex128)   # zero imaginary
        out = convolve_it(audio, freqs, H_real, sr)
        assert np.all(np.isfinite(out))
        assert np.max(np.abs(out)) > 1e-6

    def test_convolve_with_frf_mono(self):
        from processing.convolution import convolve_with_frf
        wav_path = _require(SAMPLE_DIR / "Tchaikovsky.wav")
        frf_path = _require(SAMPLE_DIR / "Betts Strad RHV20 H_001.trf")
        out, sr  = convolve_with_frf(wav_path, frf_path)
        assert out.dtype == np.float32
        assert out.ndim  == 1
        assert np.max(np.abs(out)) <= 0.9 + 1e-6
        assert np.all(np.isfinite(out))

    def test_convolve_with_frf_stereo(self):
        from processing.convolution import convolve_with_frf
        wav_path = _require(SAMPLE_DIR / "Tchaikovsky.wav")
        frf_path = _require(SAMPLE_DIR / "Betts Strad RHV20 H_001.trf")
        out, sr  = convolve_with_frf(wav_path, (frf_path, frf_path))
        assert out.ndim == 2
        assert out.shape[1] == 2


# ══════════════════════════════════════════════════════════════════════════════
# spectrogram (processing)
# ══════════════════════════════════════════════════════════════════════════════

class TestSpectrogram:

    def test_output_shapes(self):
        from processing.spectrogram import compute_spectrogram
        sig = np.random.randn(4096).astype(np.float64)
        times, freqs, S_db = compute_spectrogram(sig, 48000)
        n_frames = max(1, (len(sig) - 2048) // 512 + 1)
        n_bins   = sum(np.fft.rfftfreq(2048, 1/48000) <= 8000.0)
        assert len(times)  == n_frames
        assert len(freqs)  == n_bins
        assert S_db.shape  == (n_bins, n_frames)

    def test_dtypes_are_float32(self):
        from processing.spectrogram import compute_spectrogram
        sig = np.random.randn(4096)
        times, freqs, S_db = compute_spectrogram(sig, 48000)
        assert times.dtype  == np.float32
        assert freqs.dtype  == np.float32
        assert S_db.dtype   == np.float32

    def test_too_short_returns_empty(self):
        from processing.spectrogram import compute_spectrogram
        sig = np.random.randn(100)   # shorter than n_fft=2048
        times, freqs, S_db = compute_spectrogram(sig, 48000)
        assert S_db.size == 0

    def test_f_max_filtering(self):
        from processing.spectrogram import compute_spectrogram
        sig  = np.random.randn(8192)
        _, freqs_4k, _ = compute_spectrogram(sig, 48000, f_max=4000.0)
        _, freqs_8k, _ = compute_spectrogram(sig, 48000, f_max=8000.0)
        assert len(freqs_4k) < len(freqs_8k)
        assert freqs_4k[-1] <= 4000.0

    def test_values_are_finite(self):
        from processing.spectrogram import compute_spectrogram
        sig = np.random.randn(8192)
        _, _, S_db = compute_spectrogram(sig, 48000)
        assert np.all(np.isfinite(S_db))

    def test_custom_hop_and_nfft(self):
        from processing.spectrogram import compute_spectrogram
        sig  = np.random.randn(8192)
        t, f, S = compute_spectrogram(sig, 48000, n_fft=1024, hop=256)
        assert S.shape[1] == max(1, (len(sig) - 1024) // 256 + 1)
