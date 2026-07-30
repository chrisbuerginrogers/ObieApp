# Circle Fit — Code Flow

This documents how `circlefit.js` (JS/UI, TRF loading, Plotly rendering) and
`main.py` (PyScript — backed by `Web/py/circlefit.py`) work together to do
Kennedy–Pancu SDOF Nyquist circle fitting on hammer-impact FRF data.

- JS owns: the Data Folder / run picker (File System Access API), the node
  sidebar and complex-valued multi-node averaging, candidate-band management,
  and both Plotly plots (FRF magnitude + Nyquist).
- Python (`main.py`, backed by `Web/py/circlefit.py`, loaded locally per
  `pyscript.toml` alongside `trf_fileio.py`) owns all of the actual math:
  receptance conversion, the algebraic (Kåsa) circle fit, natural-frequency
  and hysteretic-damping extraction, modal-constant sign convention, residual
  (out-of-band mode) compensation, and the multi-pass global orchestrator.
- The two sides talk through `window.py*` functions (JS → Python) and
  `window.on*` callbacks (Python → JS), both wired up once at the bottom of
  `main.py` when PyScript finishes loading.
- Circle Fit has no live capture and no templates/settings modal of its own —
  it is a pure post-processing tool over TRF files already written by
  Acquire, and it hands its results off to Modal Analysis for 3D mode-shape
  viewing rather than rendering shapes itself.

## 1. Overview — Data Folder to a fitted mode

```mermaid
flowchart TD
    A["Page loads"] --> B{"Data Folder handle\nin IndexedDB and readwrite granted?"}
    B -- yes --> C["_applyDataFolder(handle)"]
    B -- no --> D["Toolbar shows empty folder name;\nuser must click Data Folder"]
    C --> E["openObieAppSettings\ncreates/reuses ObieAppSettings, Templates, etc."]
    E --> F["_refreshRunList(false)\nscans root for TRF/ subfolders,\ndoes not open the modal yet"]
    D --> G["cfSetDataFolder() —\nshowDirectoryPicker, saveDataFolderHandle"]
    G --> C
    F --> H["User clicks Load Run…"]
    H --> I["_refreshRunList(true) —\nrenders run-modal list"]
    I --> J["User clicks a run"]
    J --> K["_loadAllTRFs(run) —\nresets _frfData/_bands/_fittedModes,\nscans run.trfHandle for .trf/.trv"]
    K --> L["window.pyCFLoadTRF(pos, fname, bytes)\nper file"]
    L --> M["Python: parse_trf(raw) via trf_fileio\n-> onCFTRFLoaded(json)"]
    M --> N["_frfData[pos] = {freq, mag, re, im, coh?}"]
    N --> O{"all pending files done?"}
    O -- no --> L
    O -- yes --> P["_onAllLoaded —\nnode list, band chips, FRF plot,\nresults table all render"]
    P --> Q["User selects node(s) in sidebar\nand/or adds candidate bands"]
    Q --> R["User clicks Fit Modes"]
    R --> S["window.pyCFFitModes(freq, re, im, bandsJson, 3)"]
    S --> T["Python fit_modes() multi-pass fit\n-> onCFModesFitted(json)"]
    T --> U["Results table + Nyquist plot render"]
    U --> V["User clicks 'View in Modal Analysis'\nfor a fitted mode row"]
    V --> W["Opens ../modeshape/index.html\n?run=...&freq=..."]
```

## 2. Run discovery and TRF loading

`_refreshRunList` mirrors Modal Analysis's Load Run flow: it walks the root
Data Folder looking for any folder with a `TRF/` subfolder either directly
(single-instrument-per-folder layout) or one level down
(`instrument/run/TRF/`), and lists both shapes together, sorted by path.

```mermaid
flowchart TD
    A["_refreshRunList"] --> B["for each top-level entry"]
    B --> C{"entry has a\nTRF/ subfolder?"}
    C -- yes --> D["push {name, trfHandle, testHandle}"]
    C -- no --> E["for each entry one level deeper"]
    E --> F{"that child has\nTRF/?"}
    F -- yes --> G["push {name: parent/child, trfHandle, ...}"]
    F -- no --> H["skip"]
    D --> I["_runs.sort by path"]
    G --> I
    H --> I
    I --> J{"showModal?"}
    J -- yes --> K["_renderRunList + _showModal('run-modal')"]
    J -- no --> L["just populate _runs\n(used at startup, silent)"]
```

Inside `_loadAllTRFs`, filenames are matched with `/_(\d+)\.[^.]+$/` to pull
a 1-based node/position index out of the trailing `_NN.trf` suffix (stored
0-based as `pos = parseInt(m[1]) - 1`). Files that don't match this pattern
are silently skipped. `main.py`'s `_load_trf` calls the shared
`trf_fileio.parse_trf`, forwarding `re`/`im` only if the TRF actually carries
complex data (`fComplex` 1.0 or 2.0) and `coh` only if coherence was saved —
nodes without complex data still load (for the magnitude-only per-node FRF
view) but are marked "no cplx" and excluded from circle fitting.

## 3. Node sidebar and the complex-valued reference FRF

Circle fitting needs phase, so the reference curve fed to `fit_modes` is a
genuinely new complex average — `_computeComplexAverageFRF` — distinct from
Modal Analysis's magnitude-only averaging (which discards phase and can't be
used here).

```mermaid
flowchart TD
    A["User clicks a node dot\n(only enabled if node has re/im)"] --> B["Toggle idx in\n_selectedNodes Set"]
    B --> C["_updateNodeList() redraws sidebar"]
    C --> D["_renderFRFPlot()"]
    D --> E{"_selectedNodes.size === 0?"}
    E -- yes --> F["Show every usable node's own\nreal single-measurement magnitude\n(nothing averaged/cancelled)"]
    E -- no --> G["Gray out unselected nodes;\ncall _referenceFRF()"]
    G --> H["_computeComplexAverageFRF(selected idx list)\nsums re/im across nodes, divides by count"]
    H --> I["Draw bold 'Reference FRF (n nodes)' trace\non top of the grayed-out nodes"]
```

`_referenceFRF()` deliberately returns `null` when nothing is selected rather
than silently defaulting to an average of every node — averaging arbitrary
nodes' complex FRFs can partially cancel where they're out of phase (normal
for real mode shapes), so which nodes feed the fit must be an explicit user
choice, per the comment above `_referenceFRF` in `circlefit.js`.

## 4. Candidate bands

```mermaid
flowchart TD
    A["User enters Min/Max Hz\nand clicks + Add Band"] --> B{"min/max valid?\n(min>0, max>min)"}
    B -- no --> C["_setStatus warning, no-op"]
    B -- yes --> D["_bands.push({id, fLo, fHi})"]
    D --> E["_renderBandChips() + _renderFRFPlot()"]
    E --> F["Shaded rect shape drawn on\nthe FRF plot for each band"]
    G["User clicks a band chip's ✕"] --> H["_removeBand(id) filters _bands"]
    H --> E
```

## 5. Fit Modes — the actual circle-fit pipeline

`cfFitModes()` requires at least one band and at least one selected node
(so a reference FRF exists), then calls
`window.pyCFFitModes(ref.freq, ref.re, ref.im, JSON.stringify(bandsPayload), 3)`
— always 3 passes from the UI today, though `fit_modes` itself accepts
`n_passes` up to `MAX_PASSES = 5`.

```mermaid
flowchart TD
    A["fit_modes(freq_hz, re, im, bands, n_passes=3)"] --> B["accelerance_to_receptance\nX = (re+i*im) / -omega**2, once for the whole spectrum"]
    B --> C["band_masks = freq within each band's f_lo..f_hi"]
    C --> D["Pass loop (up to n_passes,\nhard-capped at MAX_PASSES=5)"]
    D --> E["For each band i:\nother = latest valid fits of every OTHER band"]
    E --> F["fit_single_mode(omega_b, re_b, im_b, other)"]
    F --> G["subtract_residual —\nresidual_contribution(omega, other_modes)\nsum of Re(A_s)/(omega_s^2-omega^2), subtracted from Re only"]
    G --> H["kasa_circle_fit(re_r, im_r) —\nalgebraic least squares on [x,y,1],\nx0=-D/2, y0=-E/2, r=sqrt(x0^2+y0^2-F)"]
    H --> I{"circle valid?\n(n>=5 points, r^2>0)"}
    I -- no --> J["mode invalid: reason\n'insufficient_data' or 'degenerate'"]
    I -- yes --> K["circle_angles —\nunwrap(atan2(y-y0, x-x0))"]
    K --> L["find_natural_frequency —\nmax abs(d theta/d omega) via central difference,\n3-point parabolic refinement unless at_edge"]
    L --> M{"frequency found?\n(n>=3 points)"}
    M -- no --> N["mode invalid: 'insufficient_data'\nor freq_fit_failed"]
    M -- yes --> O["hysteretic_loss_factor —\nfor every below/above point pair,\neta_ab = (omega_b^2-omega_a^2) / (omega_r^2 * (tan(theta_a/2)+tan(theta_b/2)));\npairs with either half-angle under 5 deg discarded;\neta_r = median of surviving pairs"]
    O --> P{"at least 2 pairs survived?"}
    P -- no --> Q["mode invalid: 'insufficient_pairs'"]
    P -- yes --> R["modal_constant —\nmagnitude = diameter * eta_r * omega_r^2;\nsign = +1 if y0<0 else -1\n(from the receptance denominator's fixed-sign horizontal-line argument)"]
    R --> S["mode valid: freq_hz, eta_r, A_r,\ncircle, quality {resid_rms_frac, at_edge,\nn_pairs_used/total}, fit_freq_hz/fit_re/fit_im"]
    D --> T{"pass>0 AND max relative\nfrequency change < tol (1e-4)\nacross all modes?"}
    T -- yes --> U["converged=true, stop early"]
    T -- no --> D
    U --> V["return {modes, n_passes_run, converged}"]
    S --> D
```

`fit_single_mode` keeps the residual-subtracted `(omega, re, im)` it actually
fit (`fit_freq_hz`/`fit_re`/`fit_im`) specifically so the Nyquist plot can
show the same points the circle was fit to — not the raw band data, which
would visually mismatch the circle whenever residual compensation from
another mode is active.

On the JS side, `onCFModesFitted` reshapes each mode's `A_r` from
`{re, im}` into `{real, imag}`, picks the first valid row as
`_selectedModeRow`, and re-renders both the results table and the Nyquist
plot.

## 6. Plotting — what triggers redraws

| Trigger | What redraws |
|---|---|
| TRF load finishing (`_onAllLoaded`) | `_renderFRFPlot()` — every usable node's own magnitude trace (log-x, dB), `_renderResultsTable()` reset to empty, `Plotly.purge('cf-nyquist-plot')` |
| Clicking a node dot | `_updateNodeList()` + `_renderFRFPlot()` — switches between per-node traces and grayed-nodes-plus-bold-reference view |
| Add Band / remove a band chip | `_renderBandChips()` + `_renderFRFPlot()` — adds/removes a shaded `rect` shape over the band's frequency span |
| `onCFModesFitted` (fit finishes) | `_renderResultsTable()` + `_renderNyquistPlot()` |
| Clicking a results-table row | `_selectedModeRow` changes → `_renderResultsTable()` (highlight) + `_renderNyquistPlot()` (switches which mode's circle is shown) |
| Nyquist plot content | Built only from the currently selected mode's `fit_re`/`fit_im` (residual-subtracted data points), the fitted circle traced as 128 points around `(x0,y0,r)`, and a star marker at the point nearest `mode.freq_hz` in `fit_freq_hz` |

Both plots use `Plotly.react` with `PCFG_HOVER` (`displayModeBar: 'hover'`);
neither plot has axis-range persistence, templates, or a white-background PNG
export button — unlike Acquire/Explore, Circle Fit has no preferences modal
at all.

## 7. Per-node residue extraction — exposed but not wired into the UI

`Web/py/circlefit.py`'s `fit_node_residues(freq_hz, re, im, modes)` and its
`main.py` wrapper `_fit_node_residues` (registered as
`window.pyCFFitNodeResidues`, calling back through
`js.window.onCFNodeResiduesFitted`) implement a per-node linear
least-squares solve for each node's own complex residue once a mode's
`omega_r`/`eta_r` are fixed — see `math.html` §7.7. This would let Modal
Analysis eventually show damping-corrected, per-mode residue mode shapes
instead of raw interpolated FRF magnitude.

**Neither `window.pyCFFitNodeResidues` nor `window.onCFNodeResiduesFitted`
is referenced anywhere in `circlefit.js` or `index.html`** (confirmed by
grep) — the function is fully implemented and exposed to the browser, but
nothing in Circle Fit's UI calls it yet. It is available for a future
feature, exactly as `math.html`'s callout states.

```mermaid
flowchart TD
    A["circlefit.py: fit_node_residues()"] --> B["main.py: _fit_node_residues\nwindow.pyCFFitNodeResidues"]
    B -.->|"never called"| C["circlefit.js — no caller exists"]
    B --> D["would call back:\nwindow.onCFNodeResiduesFitted"]
    D -.->|"never defined"| C
```

## 8. Other side systems

| System | Key functions | What it does |
|---|---|---|
| **Data Folder** | `cfSetDataFolder`, `_applyDataFolder` | Standard shared-handle pattern via `saveDataFolderHandle`/`loadDataFolderHandle` and `openObieAppSettings`; same "new Data Folder" alert convention as other tools, including a note if seed downloads failed. |
| **Handoff to Modal Analysis** | `_viewInModalAnalysis` | Opens `../modeshape/index.html?run=<path>&freq=<rounded Hz>` in a new tab for the selected fitted mode's row — Circle Fit itself never renders a 3D mode shape. |
| **Status line** | `_setStatus` | Single `<span id="cf-status">` textual status; no timed `.save-msg` (no save actions exist in this tool — nothing else to time out at 2500 ms). |
| **Help** | `cfHelp` | Opens `../../Docs/index.html` in a new tab, per the standard Help-button convention. |
