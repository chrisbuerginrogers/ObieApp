import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .labview_txt import parse_file as _lv_parse, write_file as _lv_write

ROOT  = Path(__file__).parent.parent
_PATH = ROOT / "ObieApp Settings" / "config.json"
_DEFAULTS_PATH = ROOT / "ObieApp Settings" / "DefaultFormat.txt"

# LabVIEW timestamps are seconds since 1904-01-01
_LV_EPOCH = datetime(1904, 1, 1)


def load(section: str | None = None) -> dict[str, Any]:
    with open(_PATH) as f:
        cfg = json.load(f)
    return cfg[section] if section else cfg


def save(section: str | None, data: dict[str, Any]) -> None:
    cfg = load()
    if section:
        cfg[section] = data
    else:
        cfg = data
    with open(_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


def _config_to_lv_fields(cfg: dict, defaults: dict) -> dict:
    """Merge Python config into a LabVIEW field dict, filling unknowns from defaults."""
    run     = cfg.get("run",     {})
    audio   = cfg.get("audio",   {})
    trigger = cfg.get("trigger", {})

    lv_ts = str(int((datetime.now() - _LV_EPOCH).total_seconds()))

    result = dict(defaults)
    result["Name of test"]     = run.get("instrument", "")
    result["Date"]             = lv_ts
    result["Soundcard"]        = audio.get("device_name", "")
    result["Sampling rate"]    = str(audio.get("sample_rate", 48000))
    result["Positions"]        = str(run.get("positions", 1))
    result["Taps/Position"]    = str(run.get("hits", 5))
    result["Set Names"]        = run.get("designation", "H")
    result["Hammer Threshold"] = f"{trigger.get('threshold', 0.01):.6f}"
    result["Pre-trigger (s)"]  = f"{trigger.get('pre_secs', 0.001):.6f}"
    result["Sample time (s)"]  = f"{trigger.get('post_secs', 0.3):.6f}"
    return result


def save_as_template(path, cfg: dict | None = None) -> None:
    """Export *cfg* (or the current config.json) as a LabVIEW .txt template.

    Fields that Python tracks are written from the config; all other LabVIEW
    fields are filled from DefaultFormat.txt so the file stays readable by the
    old LabVIEW software.  Edit DefaultFormat.txt to tune those defaults.
    """
    if cfg is None:
        cfg = load()
    defaults = _lv_parse(_DEFAULTS_PATH) if _DEFAULTS_PATH.exists() else {}
    _lv_write(path, _config_to_lv_fields(cfg, defaults))


__all__ = ["ROOT", "load", "save", "save_as_template"]
