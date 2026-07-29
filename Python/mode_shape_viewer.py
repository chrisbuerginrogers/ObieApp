#!/usr/bin/env python3
"""
mode_shape_viewer.py — PyVista animated mode-shape viewer for ObieApp runs.

Reads TRF files + stencil from a run folder, interpolates the operating
deflection shape at a chosen frequency using a bicubic tensor-product spline
(scipy.interpolate.RectBivariateSpline), and renders a smooth animated 3-D
surface in PyVista.

See README in the boss's repo for the full math — Sections 1–7.

Usage:
    python Python/mode_shape_viewer.py --run /path/to/RunFolder
    python Python/mode_shape_viewer.py --run /path/to/RunFolder \\
        --freq-min 300 --freq-max 5000 --warp 20

Requirements:
    pip install pyvista scipy numpy
"""

import argparse
import json
import math
import os
import re
import sys

import numpy as np

# ── Locate trf_fileio on the Python path ─────────────────────────────────────
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_SCRIPT_DIR, 'fileio'))
from trf_fileio import parse_trf  # noqa: E402

try:
    import pyvista as pv
except ImportError:
    sys.exit('PyVista not found. Install with:  pip install pyvista')

try:
    from scipy.interpolate import RectBivariateSpline
except ImportError:
    sys.exit('SciPy not found. Install with:  pip install scipy')

# ── Constants ─────────────────────────────────────────────────────────────────
DISPLAY_GRID_SHAPE = (60, 90)   # (ny, nx) of the fine display mesh
N_ANIM_FRAMES      = 60         # phase steps per oscillation cycle
ANIM_INTERVAL_MS   = 33         # timer interval  (~30 fps)
WARP_SCALE_MM      = 15.0       # height exaggeration (mm at amplitude=1)


# ── Stencil / TRF loading ─────────────────────────────────────────────────────

def load_stencil(run_dir):
    """Return list of node dicts from template.json or stencil.json."""
    for fname in ('template.json', 'stencil.json'):
        p = os.path.join(run_dir, fname)
        if not os.path.exists(p):
            continue
        with open(p) as f:
            data = json.load(f)
        if fname == 'template.json' and isinstance(data.get('stencil'), dict):
            data = data['stencil']
        nodes = data.get('nodes', [])
        if nodes:
            print(f'Stencil: {len(nodes)} nodes from {fname}')
            return nodes
    return []


def load_trf_files(trf_dir):
    """
    Scan TRF/ directory and return dict: 0-based pos → (freq, re, im) arrays.
    Files must have a _N suffix (1-based) in the filename.
    Magnitude-only TRF files are skipped.
    """
    result = {}
    for name in sorted(os.listdir(trf_dir)):
        if not re.search(r'\.(trf|trv)$', name, re.IGNORECASE):
            continue
        m = re.search(r'_(\d+)\.[^.]+$', name)
        if not m:
            continue
        pos = int(m.group(1)) - 1  # 0-based position index
        with open(os.path.join(trf_dir, name), 'rb') as f:
            raw = f.read()
        r = parse_trf(raw)
        if not r.get('re'):
            print(f'  [skip] {name}: magnitude-only TRF (no complex data)')
            continue
        result[pos] = (
            np.array(r['freq'], dtype=float),
            np.array(r['re'],   dtype=float),
            np.array(r['im'],   dtype=float),
        )
    print(f'Loaded {len(result)} complex TRF files')
    return result


# ── Grid construction ─────────────────────────────────────────────────────────

def build_node_grid(nodes, frfs):
    """
    Map the stencil node list + FRF data onto a 2-D rectangular grid.

    Returns:
        row_ys    : 1-D array (n_rows,)  — y-mm value for each unique grid row
        col_xs    : 1-D array (n_cols,)  — x-mm value for each unique grid col
        Re_grid   : 3-D array (n_rows, n_cols, n_freq)
        Im_grid   : 3-D array (n_rows, n_cols, n_freq)
        shared_freq: 1-D array (n_freq,)
    """
    # Unique, sorted row and col indices from the stencil
    rows = sorted(set(n['row'] for n in nodes))
    cols = sorted(set(n['col'] for n in nodes))

    row_to_y = {n['row']: n.get('yMm', 0.0) for n in nodes}
    col_to_x = {n['col']: n.get('xMm', 0.0) for n in nodes}

    row_ys = np.array([row_to_y[r] for r in rows], dtype=float)
    col_xs = np.array([col_to_x[c] for c in cols], dtype=float)

    # Shared frequency axis: use the longest available FRF
    ref_pos = max(frfs, key=lambda k: len(frfs[k][0]))
    shared_freq = frfs[ref_pos][0]
    n_freq = len(shared_freq)

    Re_grid = np.zeros((len(rows), len(cols), n_freq))
    Im_grid = np.zeros((len(rows), len(cols), n_freq))

    for idx, n in enumerate(nodes):
        if idx not in frfs:
            continue
        freq, re, im = frfs[idx]
        if len(re) != n_freq or not np.allclose(freq, shared_freq, atol=0.5):
            re = np.interp(shared_freq, freq, re)
            im = np.interp(shared_freq, freq, im)
        ri = rows.index(n['row'])
        ci = cols.index(n['col'])
        Re_grid[ri, ci, :] = re
        Im_grid[ri, ci, :] = im

    return row_ys, col_xs, Re_grid, Im_grid, shared_freq


# ── Interpolation ─────────────────────────────────────────────────────────────

def pick_initial_frequency(Re_grid, Im_grid, shared_freq, f_min, f_max):
    """
    Return the frequency (Hz) with the maximum summed FRF magnitude across
    all nodes — a simple proxy for the dominant resonance in the band.
    """
    mask = (shared_freq >= f_min) & (shared_freq <= f_max)
    if not np.any(mask):
        return float(np.clip((f_min + f_max) / 2, shared_freq[0], shared_freq[-1]))
    mag     = np.sqrt(Re_grid**2 + Im_grid**2)   # (n_rows, n_cols, n_freq)
    summed  = mag.sum(axis=(0, 1))                # (n_freq,)
    summed[~mask] = 0.0
    return float(shared_freq[np.argmax(summed)])


def interpolate_mode_shape(row_ys, col_xs, Re_grid, Im_grid, shared_freq, freq_hz):
    """
    Bicubic tensor-product spline interpolation of the mode shape at freq_hz.

    Uses RectBivariateSpline (not scattered griddata) so there are no diagonal
    crease artifacts — the surface curvature is C² everywhere.

    Returns:
        Re_fine, Im_fine : 2-D arrays of shape DISPLAY_GRID_SHAPE, normalised
                           so peak displacement magnitude = 1.
        y_fine, x_fine   : 1-D coordinate arrays for the fine grid (mm).
    """
    # Nearest frequency bin
    fi = int(np.argmin(np.abs(shared_freq - freq_hz)))

    Re_slice = Re_grid[:, :, fi]   # (n_rows, n_cols)
    Im_slice = Im_grid[:, :, fi]

    n_rows, n_cols = Re_slice.shape
    kx = min(3, n_rows - 1)   # spline degree ≤ n_pts - 1
    ky = min(3, n_cols - 1)

    re_spl = RectBivariateSpline(row_ys, col_xs, Re_slice, kx=kx, ky=ky)
    im_spl = RectBivariateSpline(row_ys, col_xs, Im_slice, kx=kx, ky=ky)

    ny_fine, nx_fine = DISPLAY_GRID_SHAPE
    y_fine = np.linspace(row_ys[0], row_ys[-1], ny_fine)
    x_fine = np.linspace(col_xs[0], col_xs[-1], nx_fine)

    Re_fine = re_spl(y_fine, x_fine)   # (ny_fine, nx_fine)
    Im_fine = im_spl(y_fine, x_fine)

    # Normalise: peak magnitude → 1  (§4 in README)
    peak = np.max(np.sqrt(Re_fine**2 + Im_fine**2))
    if peak > 1e-12:
        Re_fine /= peak
        Im_fine /= peak

    return Re_fine, Im_fine, y_fine, x_fine


def compute_disp(Re_fine, Im_fine, theta):
    """
    u(x,y,θ) = Re·cos(θ) − Im·sin(θ)   (§6 in README)
    One frame of harmonic oscillation at phase angle theta.
    """
    return Re_fine * math.cos(theta) - Im_fine * math.sin(theta)


# ── PyVista viewer ────────────────────────────────────────────────────────────

def run_viewer(row_ys, col_xs, Re_grid, Im_grid, shared_freq,
               f_min, f_max, warp_scale):
    # ── Initial frequency ──────────────────────────────────────────────────────
    init_freq = pick_initial_frequency(Re_grid, Im_grid, shared_freq, f_min, f_max)
    Re_fine, Im_fine, y_fine, x_fine = interpolate_mode_shape(
        row_ys, col_xs, Re_grid, Im_grid, shared_freq, init_freq)

    ny, nx = DISPLAY_GRID_SHAPE
    X, Y = np.meshgrid(x_fine, y_fine)   # (ny, nx) — mm coordinates

    # ── Build initial mesh ─────────────────────────────────────────────────────
    disp0 = compute_disp(Re_fine, Im_fine, 0.0)
    Z0    = disp0 * warp_scale

    mesh = pv.StructuredGrid(X, Y, Z0)
    mesh.point_data['displacement'] = disp0.ravel()

    # ── Plotter ────────────────────────────────────────────────────────────────
    pl = pv.Plotter(window_size=(1280, 800), title='ObieApp — Mode Shape Viewer')
    pl.set_background('#1a1a2e')

    pl.add_mesh(
        mesh,
        scalars='displacement',
        cmap='coolwarm',
        clim=[-1.0, 1.0],
        smooth_shading=True,
        show_edges=False,
        scalar_bar_args={
            'title': 'Norm.\nDisp.',
            'n_labels': 5,
            'fmt': '%.1f',
            'color': 'white',
            'width': 0.07,
            'height': 0.4,
            'position_x': 0.91,
            'position_y': 0.3,
        },
    )

    # Camera: slightly above and to the front, looking down at the plate
    pl.view_isometric()
    pl.camera.elevation = 25

    # ── Mutable state (shared across callbacks) ────────────────────────────────
    state = {
        'frame':   0,
        'Re_fine': Re_fine,
        'Im_fine': Im_fine,
        'freq_hz': init_freq,
    }

    # ── Frequency label ────────────────────────────────────────────────────────
    freq_actor = pl.add_text(
        f'{init_freq:.0f} Hz',
        position='upper_left',
        font_size=16,
        color='white',
        name='freq_label',
    )

    pl.add_text(
        'ObieApp — Mode Shape Viewer\n'
        'Drag slider to change frequency   |   Click+drag to rotate',
        position='upper_right',
        font_size=9,
        color=(0.6, 0.6, 0.6),
    )

    # ── Frequency slider ───────────────────────────────────────────────────────
    def on_freq_change(value):
        freq_hz     = float(value)
        Re_f, Im_f, _, _ = interpolate_mode_shape(
            row_ys, col_xs, Re_grid, Im_grid, shared_freq, freq_hz)
        state['Re_fine'] = Re_f
        state['Im_fine'] = Im_f
        state['freq_hz'] = freq_hz
        state['frame']   = 0
        pl.add_text(
            f'{freq_hz:.0f} Hz',
            position='upper_left',
            font_size=16,
            color='white',
            name='freq_label',
        )

    pl.add_slider_widget(
        callback=on_freq_change,
        rng=[float(shared_freq[0]), float(shared_freq[-1])],
        value=init_freq,
        title='Frequency (Hz)',
        pointa=(0.04, 0.06),
        pointb=(0.55, 0.06),
        style='modern',
        color='white',
        pass_widget=False,
    )

    # ── Animation timer ────────────────────────────────────────────────────────
    def animate():
        theta = state['frame'] * 2.0 * math.pi / N_ANIM_FRAMES
        disp  = compute_disp(state['Re_fine'], state['Im_fine'], theta)
        z     = disp * warp_scale
        # Update mesh in-place: points z-coordinate + scalar field
        pts = mesh.points.copy()
        pts[:, 2] = z.ravel()
        mesh.points = pts
        mesh.point_data['displacement'] = disp.ravel()
        state['frame'] = (state['frame'] + 1) % N_ANIM_FRAMES

    pl.add_timer_event(max_steps=0, duration=ANIM_INTERVAL_MS, callback=animate)

    pl.show()


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='PyVista mode-shape viewer for ObieApp runs',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument('--run',      required=True,
                        help='Path to run folder (must contain TRF/ subfolder)')
    parser.add_argument('--freq-min', type=float, default=200.0,
                        help='Lower frequency bound for initial-resonance search (Hz)')
    parser.add_argument('--freq-max', type=float, default=7000.0,
                        help='Upper frequency bound for initial-resonance search (Hz)')
    parser.add_argument('--warp',     type=float, default=WARP_SCALE_MM,
                        help='Height exaggeration in mm at unit normalized amplitude')
    args = parser.parse_args()

    run_dir = os.path.abspath(args.run)
    trf_dir = os.path.join(run_dir, 'TRF')

    if not os.path.isdir(run_dir):
        sys.exit(f'Error: run folder not found: {run_dir}')
    if not os.path.isdir(trf_dir):
        sys.exit(f'Error: no TRF/ subfolder in {run_dir}')

    # Load stencil
    nodes = load_stencil(run_dir)
    if not nodes:
        sys.exit('Error: no stencil found (template.json or stencil.json)')

    n_rows_stencil = len(set(n['row'] for n in nodes))
    n_cols_stencil = len(set(n['col'] for n in nodes))
    if n_rows_stencil < 2 or n_cols_stencil < 2:
        sys.exit(
            f'Error: stencil needs at least 2 distinct rows and 2 distinct cols for '
            f'surface interpolation (got {n_rows_stencil}×{n_cols_stencil})')

    # Load TRF files
    frfs = load_trf_files(trf_dir)
    if not frfs:
        sys.exit('Error: no complex TRF files found (files need fComplex=1 or 2)')

    # Build grid arrays
    row_ys, col_xs, Re_grid, Im_grid, shared_freq = build_node_grid(nodes, frfs)

    print(f'Grid:  {len(row_ys)} rows × {len(col_xs)} cols')
    print(f'Freq:  {shared_freq[0]:.1f} – {shared_freq[-1]:.1f} Hz  '
          f'({len(shared_freq)} bins)')
    print(f'Warp:  {args.warp} mm at unit amplitude')
    print()

    run_viewer(row_ys, col_xs, Re_grid, Im_grid, shared_freq,
               args.freq_min, args.freq_max, args.warp)


if __name__ == '__main__':
    main()
