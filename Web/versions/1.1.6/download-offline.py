#!/usr/bin/env python3
"""
download-offline.py  ─  Make ObieWebApp permanently offline-capable.

Run ONCE while online from the ObieApp/Web/ directory:
    python3 download-offline.py

What it does
────────────
1. Downloads PyScript, Plotly, Pyodide runtime, and Python packages
   (numpy, scipy + dependencies) to Web/vendor/ — roughly 50–80 MB total.
2. Patches every HTML file so it loads PyScript and Plotly from vendor/
   instead of the internet.
3. Patches every pyscript.toml so:
     • Python source files come from the local repo instead of GitHub.
     • Pyodide loads from vendor/pyodide/ instead of jsDelivr CDN.
4. Saves Web/vendor/offline-manifest.json so the patches can be reversed.

After running, start serve.py and open http://localhost:8000 — no internet
needed, ever.

Revert all patches:
    python3 download-offline.py --revert
"""

import os
import re
import json
import sys
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

# ── constants ─────────────────────────────────────────────────────────────────

WEB      = Path(__file__).parent.resolve()
VENDOR   = WEB / 'vendor'
MANIFEST = VENDOR / 'offline-manifest.json'

PYSCRIPT_VER = '2026.3.1'
PLOTLY_VER   = '2.32.0'
GITHUB_RAW   = 'https://raw.githubusercontent.com/chrisbuerginrogers/ObieApp/main/'

# Python packages to fetch (+ their transitive deps resolved from lock file).
PACKAGES_WANTED = {'numpy', 'scipy'}

# ── download helpers ──────────────────────────────────────────────────────────

def _fetch(url: str) -> bytes:
    req = Request(url, headers={'User-Agent': 'ObieApp-offline/1.0'})
    with urlopen(req, timeout=120) as r:
        return r.read()


def _download(url: str, dest: Path, label: str | None = None) -> bool:
    """Download url → dest. Returns True if newly downloaded, False if skipped."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        size_kb = dest.stat().st_size // 1024
        print(f'  ✓  {dest.relative_to(WEB)}  ({size_kb} KB, cached)')
        return False
    name = label or dest.name
    print(f'  ↓  {name} …', end='', flush=True)
    try:
        data = _fetch(url)
    except (URLError, HTTPError) as e:
        print(f'  FAILED ({e})')
        return False
    dest.write_bytes(data)
    print(f'  {len(data) // 1024} KB')
    return True


def _try_download(url: str, dest: Path, label: str | None = None) -> bool:
    """Like _download but silently skips 404s."""
    try:
        return _download(url, dest, label)
    except Exception:
        return False

# ── step 1 — PyScript ─────────────────────────────────────────────────────────

def download_pyscript() -> Path:
    print(f'\n[1/5]  PyScript {PYSCRIPT_VER}')
    base = f'https://pyscript.net/releases/{PYSCRIPT_VER}'
    out  = VENDOR / f'pyscript/{PYSCRIPT_VER}'
    _download(f'{base}/core.js',  out / 'core.js')
    _download(f'{base}/core.css', out / 'core.css')
    return out / 'core.js'

# ── step 2 — detect Pyodide version from PyScript core.js ────────────────────

_PYODIDE_URL_RE = re.compile(
    r'https://(?:cdn\.jsdelivr\.net/pyodide/v|pyodide\.org/v)([\d.]+)/full/'
)

def detect_pyodide(core_js: Path) -> tuple[str, str]:
    """Return (base_url, version) by scanning PyScript's core.js."""
    text = core_js.read_text(encoding='utf-8', errors='replace')
    m = _PYODIDE_URL_RE.search(text)
    if m:
        ver  = m.group(1)
        base = f'https://cdn.jsdelivr.net/pyodide/v{ver}/full/'
        print(f'\n  PyScript bundles Pyodide v{ver}')
        return base, ver
    raise RuntimeError(
        'Could not detect Pyodide version from core.js.\n'
        'Set PYODIDE_BASE_URL and PYODIDE_VER manually at the top of this script.'
    )

# ── step 3 — Pyodide runtime ──────────────────────────────────────────────────

_PYODIDE_CORE = [
    'pyodide.js',
    'pyodide.asm.js',
    'pyodide.asm.wasm',
    'pyodide-lock.json',
]
# These may or may not exist depending on version; failures are silent.
_PYODIDE_OPTIONAL = [
    'pyodide.asm.data',
    'python_stdlib.zip',
]


def download_pyodide(base: str, ver: str) -> tuple[Path, dict]:
    print(f'\n[2/5]  Pyodide v{ver} runtime (~25 MB)')
    out = VENDOR / 'pyodide'
    for fname in _PYODIDE_CORE:
        _download(f'{base}{fname}', out / fname)
    for fname in _PYODIDE_OPTIONAL:
        _try_download(f'{base}{fname}', out / fname)

    lock = json.loads((out / 'pyodide-lock.json').read_bytes())
    return out, lock.get('packages', {})


def _resolve_deps(packages: dict, names: set) -> set:
    """Transitive dependency closure from pyodide-lock.json."""
    resolved: set[str] = set()
    def visit(n: str):
        key = n.lower().replace('-', '_')
        if key in resolved:
            return
        resolved.add(key)
        info = packages.get(key) or packages.get(key.replace('_', '-'))
        if info:
            for dep in info.get('depends', []):
                visit(dep)
    for n in names:
        visit(n)
    return resolved


def download_packages(base: str, pyodide_dir: Path, lock_packages: dict) -> set:
    deps = _resolve_deps(lock_packages, PACKAGES_WANTED)
    print(f'\n[3/5]  Python packages  ({len(deps)} wheels incl. dependencies)')
    for name in sorted(deps):
        info = lock_packages.get(name) or lock_packages.get(name.replace('_', '-'))
        if not info:
            print(f'  ⚠  {name}  — not found in lock file, skipping')
            continue
        fname = info.get('file_name') or info.get('filename')
        if not fname:
            print(f'  ⚠  {name}  — no filename in lock entry, skipping')
            continue
        _download(f'{base}{fname}', pyodide_dir / fname, label=f'{name}  ({fname})')
    return deps

# ── step 4 — Plotly ───────────────────────────────────────────────────────────

def download_plotly():
    print(f'\n[4/5]  Plotly {PLOTLY_VER}')
    _download(
        f'https://cdn.plot.ly/plotly-{PLOTLY_VER}.min.js',
        VENDOR / f'plotly-{PLOTLY_VER}.min.js',
    )

# ── step 5 — patch HTML and pyscript.toml ────────────────────────────────────

def _relpath(from_file: Path, to_vendor_subpath: str) -> str:
    """Relative URL from from_file's directory to vendor/<to_vendor_subpath>."""
    target = VENDOR / to_vendor_subpath
    return os.path.relpath(target, from_file.parent).replace('\\', '/')


def _repo_relpath(from_file: Path, repo_subpath: str) -> str:
    """Relative path from from_file's directory to ObieApp/<repo_subpath>."""
    target = WEB.parent / repo_subpath   # WEB is ObieApp/Web/
    return os.path.relpath(target, from_file.parent).replace('\\', '/')


def patch_html(path: Path, manifest: dict):
    text = path.read_text(encoding='utf-8')
    orig = text

    ps  = PYSCRIPT_VER
    pl  = PLOTLY_VER
    subs = {
        f'https://pyscript.net/releases/{ps}/core.css':
            _relpath(path, f'pyscript/{ps}/core.css'),
        f'https://pyscript.net/releases/{ps}/core.js':
            _relpath(path, f'pyscript/{ps}/core.js'),
        f'https://cdn.plot.ly/plotly-{pl}.min.js':
            _relpath(path, f'plotly-{pl}.min.js'),
    }

    for cdn, local in subs.items():
        text = text.replace(cdn, local)

    if text != orig:
        manifest[str(path.relative_to(WEB))] = orig
        path.write_text(text, encoding='utf-8')
        print(f'  patched  {path.relative_to(WEB)}')


def patch_toml(path: Path, manifest: dict):
    text = path.read_text(encoding='utf-8')
    orig = text

    # 1. Replace raw.githubusercontent.com URLs with local repo paths.
    def _replace_github(m):
        repo_rel = m.group(1)   # e.g. Python/fileio/trf_fileio.py
        local    = _repo_relpath(path, repo_rel)
        return f'"{local}"'

    text = re.sub(
        r'"' + re.escape(GITHUB_RAW) + r'([^"]+)"',
        _replace_github,
        text,
    )

    # 2. Add [interpreter] block pointing to local Pyodide (if not present).
    if '[interpreter]' not in text and '[[interpreter]]' not in text:
        pyodide_js = _relpath(path, 'pyodide/pyodide.js')
        block = (
            f'[interpreter]\n'
            f'name = "pyodide"\n'
            f'lang = "python"\n'
            f'src  = "{pyodide_js}"\n\n'
        )
        text = block + text

    if text != orig:
        manifest[str(path.relative_to(WEB))] = orig
        path.write_text(text, encoding='utf-8')
        print(f'  patched  {path.relative_to(WEB)}')


def _skip(path: Path) -> bool:
    parts = path.relative_to(WEB).parts
    return 'vendor' in parts or 'versions' in parts


def patch_all(manifest: dict):
    print('\n[5/5]  Patching source files')
    for html in sorted(WEB.rglob('*.html')):
        if not _skip(html):
            patch_html(html, manifest)
    for toml in sorted(WEB.rglob('pyscript.toml')):
        if not _skip(toml):
            patch_toml(toml, manifest)

# ── revert ────────────────────────────────────────────────────────────────────

def revert():
    if not MANIFEST.exists():
        print('vendor/offline-manifest.json not found — nothing to revert.')
        return
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    for rel, original in manifest.items():
        p = WEB / rel
        p.write_text(original, encoding='utf-8')
        print(f'  reverted  {rel}')
    MANIFEST.unlink()
    print(f'\nReverted {len(manifest)} file(s). Back to CDN mode.')

# ── main ──────────────────────────────────────────────────────────────────────

def main():
    if '--revert' in sys.argv:
        print('Reverting to CDN URLs…')
        revert()
        return

    print('ObieWebApp — offline asset downloader')
    print('═══════════════════════════════════════')
    print(f'Downloading to: {VENDOR}')

    VENDOR.mkdir(exist_ok=True)

    core_js = download_pyscript()

    try:
        pyodide_base, pyodide_ver = detect_pyodide(core_js)
    except RuntimeError as e:
        print(f'\n⚠  {e}')
        sys.exit(1)

    pyodide_dir, lock_packages = download_pyodide(pyodide_base, pyodide_ver)
    download_packages(pyodide_base, pyodide_dir, lock_packages)
    download_plotly()

    manifest: dict = {}
    patch_all(manifest)
    MANIFEST.write_text(json.dumps(manifest, indent=2), encoding='utf-8')

    print('\n═══════════════════════════════════════')
    total_mb = sum(
        f.stat().st_size for f in VENDOR.rglob('*') if f.is_file()
    ) // (1024 * 1024)
    print(f'vendor/  total: {total_mb} MB  ({len(manifest)} files patched)')
    print()
    print('All set! To use ObieWebApp with no internet:')
    print()
    print('    python3 serve.py')
    print('    → http://localhost:8000  (Chrome or Edge)')
    print()
    print('To switch back to CDN mode:')
    print('    python3 download-offline.py --revert')


if __name__ == '__main__':
    main()
