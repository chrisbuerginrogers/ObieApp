import json
from pathlib import Path
from typing import Any

ROOT  = Path(__file__).parent.parent
_PATH = ROOT / "ObieApp Settings" / "config.json"


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


__all__ = ["ROOT", "load", "save"]
