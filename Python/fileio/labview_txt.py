"""
labview_txt.py

Parser and writer for the LabVIEW Key=<value/> preference file format used
by ObieApp Settings templates, Settings.txt run snapshots, and DefaultFormat.txt.

Format rules
------------
- Single-line:   Key=<value/>
- Multi-line:    Key=<first line
                     continuation
                 />    (closing /> on its own line)
- Keys may have trailing whitespace (stripped on read).
- All values are stored as raw strings; callers coerce as needed.
"""
from pathlib import Path


def parse(text: str) -> dict[str, str]:
    """Parse LabVIEW Key=<value/> text. All values are returned as raw strings."""
    result: dict[str, str] = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        eq = line.find("=<")
        if eq == -1:
            i += 1
            continue
        key = line[:eq].strip()
        rest = line[eq + 2:]
        if rest.endswith("/>"):
            result[key] = rest[:-2]
            i += 1
        else:
            # Multi-line value: collect until a line that ends with />
            parts = [rest]
            i += 1
            while i < len(lines):
                cur = lines[i]
                if cur.rstrip() == "/>":
                    i += 1
                    break
                if cur.rstrip().endswith("/>"):
                    parts.append(cur.rstrip()[:-2])
                    i += 1
                    break
                parts.append(cur)
                i += 1
            result[key] = "\n".join(parts)
    return result


def parse_file(path) -> dict[str, str]:
    """Read a file and return its LabVIEW key/value pairs."""
    return parse(Path(path).read_text(encoding="utf-8", errors="replace"))


def write(data: dict) -> str:
    """Serialize an ordered dict to LabVIEW Key=<value/> text."""
    lines = []
    for key, val in data.items():
        val_str = str(val)
        if "\n" in val_str:
            lines.append(f"{key}=<{val_str}\n/>")
        else:
            lines.append(f"{key}=<{val_str}/>")
    return "\n".join(lines) + "\n"


def write_file(path, data: dict) -> None:
    """Write an ordered dict as LabVIEW Key=<value/> to *path*."""
    Path(path).write_text(write(data), encoding="utf-8")


__all__ = ["parse", "parse_file", "write", "write_file"]
