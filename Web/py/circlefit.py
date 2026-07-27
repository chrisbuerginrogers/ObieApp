"""
circlefit.py

SDOF Nyquist circle fitting with residual (out-of-band mode) compensation,
for extracting natural frequency, hysteretic (structural) damping loss
factor, and modal constant (residue) per mode from a measured accelerance
FRF (acceleration / force).

Method (Kennedy-Pancu / Ewins, "Modal Testing: Theory and Practice"): an
isolated SDOF resonance traces an exact circle in the Nyquist (Re vs Im)
plane for RECEPTANCE with HYSTERETIC damping — this is why accelerance is
first converted to receptance before fitting. Natural frequency is taken
as the point of maximum angular sweep rate around the fitted circle;
damping from the half-angle relation between the resonance point and
points either side of it; the modal constant from the circle's diameter.

Usage:
    from processing.circlefit import fit_modes, fit_node_residues

    result = fit_modes(freq_hz, re, im, bands=[{'f_lo':60,'f_hi':80}, ...])
    for mode in result['modes']:
        if mode['valid']:
            print(mode['freq_hz'], mode['eta_r'], mode['A_r'])
"""

import numpy as np

MIN_CIRCLE_POINTS = 5
MIN_ANGLE_DEG_DEFAULT = 5.0
MAX_PASSES = 5


# ─────────────────────────────────────────────────────────────────────────────
# Unit conversion
# ─────────────────────────────────────────────────────────────────────────────

def accelerance_to_receptance(freq_hz, re, im):
    """(re, im) of accelerance -> (re, im) of receptance, via division by -omega**2."""
    freq_hz = np.asarray(freq_hz, dtype=float)
    re      = np.asarray(re, dtype=float)
    im      = np.asarray(im, dtype=float)
    omega = 2.0 * np.pi * freq_hz
    denom = -(omega ** 2)
    denom = np.where(np.abs(denom) > 1e-12, denom, 1e-12)
    x = (re + 1j * im) / denom
    return x.real, x.imag


# ─────────────────────────────────────────────────────────────────────────────
# Residual (out-of-band mode) compensation
# ─────────────────────────────────────────────────────────────────────────────

def residual_contribution(omega, other_modes):
    """
    Real-valued approximate contribution of already-identified modes s != r
    at the given omega. Far from mode s's own resonance the hysteretic
    damping term is negligible, so each mode's contribution is approximated
    as Re(A_s) / (omega_s**2 - omega**2) — a near-constant "stiffness-like"
    term for modes above the current band, a "-1/omega**2"-like "mass-like"
    term for modes below it. other_modes: list of {'omega_r', 'A_r'}.
    """
    omega = np.asarray(omega, dtype=float)
    total = np.zeros_like(omega)
    for m in other_modes:
        omega_s = m['omega_r']
        A_s     = m['A_r']
        total  += A_s.real / (omega_s ** 2 - omega ** 2)
    return total


def subtract_residual(omega, re_x, im_x, other_modes):
    """receptance (re_x, im_x) minus the residual_contribution of other_modes."""
    re_x = np.asarray(re_x, dtype=float).copy()
    im_x = np.asarray(im_x, dtype=float).copy()
    if not other_modes:
        return re_x, im_x
    return re_x - residual_contribution(omega, other_modes), im_x


# ─────────────────────────────────────────────────────────────────────────────
# Circle fit
# ─────────────────────────────────────────────────────────────────────────────

def kasa_circle_fit(x, y):
    """
    Algebraic (Kasa) least-squares circle fit: solves for D, E, F in
    x**2+y**2+D*x+E*y+F=0 via np.linalg.lstsq on the raw [x, y, 1] design
    matrix directly (not the AtA normal-equations form, which roughly
    squares the condition number and is measurably less stable for
    near-collinear point clouds, e.g. a band with no real resonance).

    Returns {'valid', 'x0', 'y0', 'r', 'n_points', 'resid_rms_frac'} or
    {'valid': False, 'reason', 'n_points'} on failure.
    """
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    n = len(x)
    if n < MIN_CIRCLE_POINTS:
        return {'valid': False, 'reason': 'insufficient_data', 'n_points': n}

    A = np.column_stack([x, y, np.ones(n)])
    b = -(x ** 2 + y ** 2)
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    D, E, F = sol
    x0, y0 = -D / 2.0, -E / 2.0
    r2 = x0 ** 2 + y0 ** 2 - F
    if r2 <= 0:
        return {'valid': False, 'reason': 'degenerate', 'n_points': n}
    r = float(np.sqrt(r2))

    resid = np.abs(np.hypot(x - x0, y - y0) - r)
    resid_rms_frac = float(np.sqrt(np.mean(resid ** 2)) / r) if r > 0 else float('inf')

    return {
        'valid': True, 'x0': float(x0), 'y0': float(y0), 'r': r,
        'n_points': n, 'resid_rms_frac': resid_rms_frac,
    }


def circle_angles(x, y, x0, y0):
    """Angle of each (x,y) point relative to the circle centre, unwrapped —
    unwrap is required since a real resonance sweep commonly crosses the
    atan2 branch cut."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    return np.unwrap(np.arctan2(y - y0, x - x0))


# ─────────────────────────────────────────────────────────────────────────────
# Natural frequency — point of maximum angular sweep rate
# ─────────────────────────────────────────────────────────────────────────────

def find_natural_frequency(omega, theta):
    """
    Central-difference d(theta)/d(omega) over interior points; the natural
    frequency is where this rate peaks in magnitude. 3-point parabolic
    interpolation around the discrete max for sub-bin precision (assumes
    evenly-spaced frequency bins, guaranteed by the TRF format's fixed
    Hz_Resolution).

    Returns {'valid': True, 'omega_r', 'idx', 'at_edge'} or
    {'valid': False, 'reason': 'insufficient_data'}.
    at_edge=True means the discrete peak fell at a band boundary — the true
    resonance is likely outside the selected band; parabolic refinement is
    skipped in that case (no interior point to interpolate around).
    """
    omega = np.asarray(omega, dtype=float)
    theta = np.asarray(theta, dtype=float)
    n = len(omega)
    if n < 3:
        return {'valid': False, 'reason': 'insufficient_data'}

    domega = omega[2:] - omega[:-2]
    dtheta = theta[2:] - theta[:-2]
    rate = dtheta / domega          # rate[k] is centred at omega[k+1]

    k = int(np.argmax(np.abs(rate)))
    idx = k + 1
    at_edge = (k == 0) or (k == len(rate) - 1)
    omega_r = omega[idx]

    if not at_edge:
        y_m1, y_0, y_p1 = abs(rate[k - 1]), abs(rate[k]), abs(rate[k + 1])
        denom = y_m1 - 2 * y_0 + y_p1
        if abs(denom) > 1e-15:
            delta = 0.5 * (y_m1 - y_p1) / denom
            delta = max(-1.0, min(1.0, delta))
            if delta >= 0:
                bin_width = omega[idx + 1] - omega[idx]
            else:
                bin_width = omega[idx] - omega[idx - 1]
            omega_r = omega[idx] + delta * bin_width

    return {'valid': True, 'omega_r': float(omega_r), 'idx': idx, 'at_edge': bool(at_edge)}


# ─────────────────────────────────────────────────────────────────────────────
# Damping — hysteretic loss factor via the half-angle relation
# ─────────────────────────────────────────────────────────────────────────────

def hysteretic_loss_factor(omega, theta, omega_r, idx, min_angle_deg=MIN_ANGLE_DEG_DEFAULT):
    """
    For every pair (a below resonance, b above resonance):
      eta_ab = (omega_b**2 - omega_a**2) / (omega_r**2 * (tan(theta_a/2) + tan(theta_b/2)))
    where theta_a, theta_b are the half-angles subtended at the circle
    centre between the resonance point and points a/b. Pairs where either
    half-angle is below min_angle_deg are discarded (tan(theta/2) -> 0 in
    the denominator is numerically unstable close to resonance — a single
    such pair can otherwise dominate a plain mean). Returns the MEDIAN
    across surviving pairs (robust to the occasional outlier pair with real,
    noisy hammer data).

    Returns {'valid': True, 'eta_r', 'eta_mad', 'n_pairs_used', 'n_pairs_total'}
    or {'valid': False, 'reason': 'insufficient_pairs', 'n_pairs_used'}.
    """
    omega = np.asarray(omega, dtype=float)
    theta = np.asarray(theta, dtype=float)
    theta_r = theta[idx]
    min_angle_rad = np.deg2rad(min_angle_deg)

    below = np.where(omega < omega[idx])[0]
    above = np.where(omega > omega[idx])[0]

    etas = []
    for a in below:
        theta_a = abs(theta[a] - theta_r)
        if theta_a < min_angle_rad:
            continue
        for b in above:
            theta_b = abs(theta[b] - theta_r)
            if theta_b < min_angle_rad:
                continue
            denom = omega_r ** 2 * (np.tan(theta_a / 2) + np.tan(theta_b / 2))
            if denom <= 0:
                continue
            eta_ab = (omega[b] ** 2 - omega[a] ** 2) / denom
            if eta_ab > 0:
                etas.append(eta_ab)

    if len(etas) < 2:
        return {'valid': False, 'reason': 'insufficient_pairs', 'n_pairs_used': len(etas)}

    etas = np.array(etas)
    return {
        'valid': True,
        'eta_r': float(np.median(etas)),
        'eta_mad': float(np.median(np.abs(etas - np.median(etas)))),
        'n_pairs_used': int(len(etas)),
        'n_pairs_total': int(len(below) * len(above)),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Modal constant / residue
# ─────────────────────────────────────────────────────────────────────────────

def modal_constant(diameter, eta_r, omega_r, y0):
    """
    |A_r| = diameter * eta_r * omega_r**2 (standard hysteretic-receptance
    circle relation).

    Sign convention, derived directly from the model rather than assumed:
    with hysteretic damping, X(omega) = A_r / ((omega_r**2-omega**2) + i*eta_r*omega_r**2)
    has a denominator that traces a horizontal line at CONSTANT positive
    imaginary part eta_r*omega_r**2 (since eta_r>0) as omega varies — and
    inverting a horizontal line not through the origin (z -> 1/z) always
    produces a circle lying entirely on the OPPOSITE side of the real axis
    from that line. So for a positive real A_r, the fitted circle's centre
    always has y0 < 0; for negative A_r, y0 > 0. (An earlier version tried
    to infer the sign from the circle's traversal direction/sweep sense —
    that's wrong: scaling by a positive or negative real A_r does not
    change traversal direction at all, only which half-plane the circle
    sits in, so sweep sense can never distinguish the two. Confirmed against
    synthetic ground-truth data in test_all.py's TestCircleFit, including a
    case with a known-negative modal constant.) Residual subtraction only
    ever touches the real part of the data (see subtract_residual), so it
    never disturbs y0 — this sign rule holds with or without residual
    compensation applied.
    """
    magnitude = diameter * eta_r * omega_r ** 2
    sign = 1.0 if y0 < 0 else -1.0
    return complex(sign * magnitude, 0.0)


# ─────────────────────────────────────────────────────────────────────────────
# Per-mode orchestrator
# ─────────────────────────────────────────────────────────────────────────────

def fit_single_mode(omega, re_x, im_x, other_modes=None):
    """Fit one candidate mode band: residual subtraction -> circle fit ->
    natural frequency -> damping -> modal constant, with a combined quality
    summary. omega/re_x/im_x are already sliced to the candidate band."""
    other_modes = other_modes or []
    re_r, im_r = subtract_residual(omega, re_x, im_x, other_modes)

    circle = kasa_circle_fit(re_r, im_r)
    if not circle['valid']:
        return {'valid': False, 'reason': circle['reason'], 'circle': circle}

    theta = circle_angles(re_r, im_r, circle['x0'], circle['y0'])
    freq_result = find_natural_frequency(omega, theta)
    if not freq_result['valid']:
        return {'valid': False, 'reason': freq_result.get('reason', 'freq_fit_failed'),
                'circle': circle}

    damping = hysteretic_loss_factor(omega, theta, freq_result['omega_r'], freq_result['idx'])
    if not damping['valid']:
        return {'valid': False, 'reason': damping['reason'], 'circle': circle,
                'natural_frequency': freq_result}

    diameter = 2.0 * circle['r']
    A_r = modal_constant(diameter, damping['eta_r'], freq_result['omega_r'], circle['y0'])

    return {
        'valid': True,
        'omega_r': freq_result['omega_r'],
        'freq_hz': freq_result['omega_r'] / (2.0 * np.pi),
        'eta_r': damping['eta_r'],
        'A_r': A_r,
        'circle': circle,
        'quality': {
            'resid_rms_frac': circle['resid_rms_frac'],
            'at_edge': freq_result['at_edge'],
            'n_pairs_used': damping['n_pairs_used'],
            'n_pairs_total': damping['n_pairs_total'],
        },
        # Residual-subtracted (omega, re, im) actually used for this fit — kept
        # around so a UI can plot exactly what the circle was fit to, not just
        # the raw band data (which would visually mismatch the circle whenever
        # residual compensation from other modes is active).
        'fit_freq_hz': (omega / (2.0 * np.pi)).tolist(),
        'fit_re': re_r.tolist(),
        'fit_im': im_r.tolist(),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Multi-pass global orchestrator
# ─────────────────────────────────────────────────────────────────────────────

def fit_modes(freq_hz, re, im, bands, n_passes=3, tol=1e-4):
    """
    bands: list of {'f_lo', 'f_hi'} candidate mode bands (already user-picked).
    Converts accelerance -> receptance once, then for up to n_passes rounds
    (hard-capped at MAX_PASSES) refits every band using the other bands'
    latest fitted (omega, A) for residual compensation, stopping early once
    the max relative frequency change across modes falls below tol.

    Returns {'modes': [...], 'n_passes_run', 'converged'}.
    """
    n_passes = min(max(int(n_passes), 1), MAX_PASSES)
    freq_hz = np.asarray(freq_hz, dtype=float)
    omega_full = 2.0 * np.pi * freq_hz
    re_x_full, im_x_full = accelerance_to_receptance(freq_hz, re, im)

    band_masks = [(freq_hz >= b['f_lo']) & (freq_hz <= b['f_hi']) for b in bands]

    modes = [None] * len(bands)
    converged = False
    n_run = 0

    for p in range(n_passes):
        n_run = p + 1
        new_modes = []
        max_rel_change = 0.0
        for i, mask in enumerate(band_masks):
            omega_b = omega_full[mask]
            re_b = re_x_full[mask]
            im_b = im_x_full[mask]
            other = [{'omega_r': m['omega_r'], 'A_r': m['A_r']}
                     for j, m in enumerate(modes) if j != i and m is not None and m.get('valid')]
            fit = fit_single_mode(omega_b, re_b, im_b, other)
            fit['band'] = bands[i]
            if fit.get('valid') and modes[i] is not None and modes[i].get('valid'):
                prev = modes[i]['omega_r']
                if prev > 0:
                    max_rel_change = max(max_rel_change, abs(fit['omega_r'] - prev) / prev)
            new_modes.append(fit)
        modes = new_modes
        if p > 0 and max_rel_change < tol:
            converged = True
            break

    return {'modes': modes, 'n_passes_run': n_run, 'converged': converged}


# ─────────────────────────────────────────────────────────────────────────────
# Per-node residue extraction (frequencies/damping already fixed)
# ─────────────────────────────────────────────────────────────────────────────

def fit_node_residues(freq_hz, re, im, modes):
    """
    Given finalized {'omega_r', 'eta_r'} per mode, solve one linear complex
    least-squares system for this node's unknown complex residues A_r (one
    column per mode) plus a constant + a 1/omega**2 residual column —
    appropriate here since frequencies/damping are now fixed, so the model
    is linear in the residues and the whole spectrum can be used in one
    solve rather than band-by-band.

    Returns {'A_r': [complex, ...], 'residual_const', 'residual_mass'}.
    """
    freq_hz = np.asarray(freq_hz, dtype=float)
    omega = 2.0 * np.pi * freq_hz
    re_x, im_x = accelerance_to_receptance(freq_hz, re, im)
    H = re_x + 1j * im_x

    n_modes = len(modes)
    cols = []
    for m in modes:
        omega_s, eta_s = m['omega_r'], m['eta_r']
        cols.append(1.0 / (omega_s ** 2 - omega ** 2 + 1j * eta_s * omega_s ** 2))
    cols.append(np.ones_like(omega, dtype=complex))
    safe_omega2 = np.where(np.abs(omega) > 1e-12, omega ** 2, 1e-12)
    cols.append(1.0 / safe_omega2.astype(complex))

    A = np.column_stack(cols)
    sol, *_ = np.linalg.lstsq(A, H, rcond=None)

    return {
        'A_r': [complex(sol[i]) for i in range(n_modes)],
        'residual_const': complex(sol[n_modes]),
        'residual_mass': complex(sol[n_modes + 1]),
    }
