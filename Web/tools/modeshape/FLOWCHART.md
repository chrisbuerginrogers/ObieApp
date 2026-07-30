# Modal Analysis — Code Flow

This documents how `modeshape.js` (JS/UI, Data Folder access, Plotly rendering,
bicubic-spline interpolation, animation) and `main.py` (PyScript — TRF byte
parsing only) work together. Diagrams render natively on GitHub and in most
Markdown/Mermaid-aware editors.

Modal Analysis is **view-only** — all data acquisition happens in Acquire.
This tool is the browser counterpart of the desktop reference tool
`Python/mode_shape_viewer.py` (a PyVista viewer): both read a run's
`template.json`/`stencil.json` node stencil plus its `TRF/` complex-FRF files
and reconstruct an animated operating-deflection-shape surface via a bicubic
tensor-product spline. `mode_shape_viewer.py` uses
`scipy.interpolate.RectBivariateSpline`; `modeshape.js` reimplements the same
math (natural cubic spline, tensor-product: rows→columns then columns→rows)
directly in JS so it can run synchronously inside a `requestAnimationFrame`
loop with no Python/WASM round-trip per frame.

- JS owns: the UI, the Data Folder / File System Access API, run and stencil
  discovery, reading raw TRF bytes off disk, the bicubic-spline surface
  math, phasor/animation math, camera handling, and all Plotly rendering.
- Python (`main.py`, backed by `trf_fileio.parse_trf`, loaded locally from
  `Web/py/trf_fileio.py` per `pyscript.toml`) owns exactly one job: parsing a
  TRF file's bytes into `{freq, mag, re, im, coh}`.
- The two sides talk through a single JS → Python call
  (`window.pyMSLoadTRF`, one call per TRF file) and a single Python → JS
  callback (`window.onMSTRFLoaded`) — much thinner than Acquire's live
  bidirectional state machine, since there is no real-time capture here.

## 1. Overview — page load to a loaded run

```mermaid
flowchart TD
    A["Page loads"] --> B["DOMContentLoaded:\nloadDataFolderHandle()"]
    B --> C{"Handle found\nand readwrite granted?"}
    C -- no --> D["Idle — status:\n'Load a run folder to begin.'"]
    C -- yes --> E["_applyDataFolder(handle)"]
    E --> F["Try ObieAppSettings/Templates\n(no create) → _loadStencils()"]
    F --> G["_refreshRunList(false)\nscans root for dirs with a TRF/ subfolder\n(direct or one level deeper: Instrument/Run/TRF)"]
    G --> H["_applyStartupDeepLink()\nreads ?run=&freq= from URL"]
    H --> I{"run= param present\nand matches a scanned run?"}
    I -- no --> J["Wait for user to click\n'Load Run…' (msLoadRun)"]
    I -- yes --> K["_waitForPyReady()\npolls window.pyMSLoadTRF\nuntil PyScript finishes init"]
    K --> L["_loadAllTRFs(target)"]
    L --> M["msSyncFreq(freq) + msSetTab('mode')"]
    J --> N["msLoadRun → _refreshRunList(true)\nshows Load Run modal"]
    N --> O["User clicks a run →\n_loadAllTRFs(run)"]
```

**Why the deep link waits explicitly:** `_applyStartupDeepLink` fires
immediately from `DOMContentLoaded`, which can win the race against
Pyodide's own init (15–30 s on first load). Calling the not-yet-defined
`window.pyMSLoadTRF` would throw and leave the status stuck at
"Loading N TRF files…" forever, so `_waitForPyReady` polls every 100 ms
(60 s timeout) before proceeding. The deep link supports "View in Modal
Analysis" links from the Circle Fit tool (`?run=<path>&freq=<hz>`).

## 2. Loading a run's TRF files + stencil (old-format fallback)

```mermaid
flowchart TD
    A["_loadAllTRFs(run)"] --> B["Reset _frfData / _complexFRFs\n_trfPending / _trfDone"]
    B --> C["Scan run.trfHandle for .trf/.trv files\nposition = trailing digits before extension\n(handles both old 'prefix_001.trf'\nand current 'prefix label.trf' naming)"]
    C --> D{"run.testHandle\navailable?"}
    D -- yes --> E["Try testHandle/template.json\nread runData.stencil"]
    E --> F{"stencil found\nin template.json?"}
    F -- yes --> G["_applyStencil(stencilData)"]
    F -- no --> H["Fall back to legacy\ntestHandle/stencil.json"]
    H --> I{"valid stencil\n(type or nodes) found?"}
    I -- yes --> G
    I -- no --> J["No stencil applied —\nuser picks one manually"]
    D -- no --> J
    G --> K["For each TRF file:\nread bytes → window.pyMSLoadTRF(pos, fname, arr)"]
    J --> K
    K --> L["Python: _load_trf calls\ntrf_fileio.parse_trf(raw)"]
    L --> M["window.onMSTRFLoaded(jsonStr)\n{pos, freq, mag, re?, im?, coh?} or {pos, error}"]
    M --> N["JS stores into _frfData[pos]\nand _complexFRFs[pos] if re/im present"]
    N --> O["_trfDone++ , update ms-count badge"]
    O --> P{"_trfDone\n>= _trfPending?"}
    P -- no --> K
    P -- yes --> Q["_onAllLoaded()"]
    Q --> R["_updateNodeList() + _renderFRFPlot()"]
    Q --> S{"_geometry.nodes\nnon-empty?"}
    S -- yes --> T["_computeModeSurface(_modeFreqHz)\n_renderRefFRF() + _renderModePlot(true, 0)"]
```

## 3. Node stencil → spatial geometry model

```mermaid
flowchart TD
    A["Stencil source"] --> B["_loadStencils() scans\nObieAppSettings/Templates for\ntype=node-stencil or node-layout"]
    A --> C["msBrowseStencil()\nindividual file picker"]
    A --> D["Auto-applied from run's\ntemplate.json.stencil or stencil.json\n(during _loadAllTRFs)"]
    B --> E["msLoadStencil() shows\nstencil-modal list, click applies"]
    C --> F["_applyStencil(data)"]
    D --> F
    E --> F
    F --> G["_stencilNodes = data.nodes\n_buildGeometryFromStencil()"]
    G --> H["Nodes: xMm/10, yMm/10 → cm,\nz=0, id/label per node"]
    G --> I["Edges: connect nodes that are\nrow-adjacent or col-adjacent\n(consecutive row/col index, same other axis)"]
    H --> J["_geometry = {nodes, edges}"]
    I --> J
    F --> K{"_complexFRFs\nalready loaded?"}
    K -- yes --> L["_computeModeSurface(_modeFreqHz)\n_renderModePlot(true, 0) + _renderRefFRF()"]
```

## 4. Building the interpolated mode surface (bicubic spline)

```mermaid
flowchart TD
    A["_computeModeSurface(freqHz)\ncalled on freq change, stencil apply, new run"] --> B{"stencil nodes AND\ncomplex FRFs both present?"}
    B -- no --> Z["Clear _reFine/_imFine/_xFine/_yFine\n(no surface to draw)"]
    B -- yes --> C["Collect unique row and\ncol values from stencil"]
    C --> D{"fully degenerate?\n(rows<2 AND cols<2)"}
    D -- yes --> Z
    D -- no --> E["Per node: _interpComplexFRF(d, freqHz)\nlinear interp between two nearest freq bins"]
    E --> F["Build 2-D Re2D / Im2D grids\nindexed [row][col]"]
    F --> G{"single row or\nsingle column only?"}
    G -- yes --> H["Synthesize a second row/col offset by\nRIBBON_WIDTH_CM with identical Re/Im values\n(renders as a narrow interpolated ribbon)"]
    G -- no --> I["Use grids as-is"]
    H --> J["Build fine display grid:\naspect-ratio aware NX x NY\n(longer axis gets more samples)\nvia _linspace"]
    I --> J
    J --> K["_tensorSplineGrid(rowYs, colXs, Re2D/Im2D, yFine, xFine)"]
    K --> L["Pass 1: _fitCubicSpline across columns,\nper measurement row → mid[row][xFine]"]
    L --> M["Pass 2: _fitCubicSpline across rows,\nper fine-x column → Z[yFine][xFine]"]
    M --> N["_reFine / _imFine produced"]
    N --> O["Normalise both grids by\npeak sqrt(Re^2+Im^2) over the fine grid → 1"]
```

`_fitCubicSpline` builds a natural cubic spline (second derivatives zero at
the endpoints) via the standard tridiagonal Thomas-algorithm solve;
`_evalCubicSpline` evaluates it (clamped linear extrapolation past the
endpoints). This is the from-scratch JS equivalent of
`scipy.interpolate.RectBivariateSpline` used by `mode_shape_viewer.py`.

## 5. Mode-shape reconstruction / animation pipeline

```mermaid
stateDiagram-v2
    [*] --> Static
    Static --> Static: msSyncFreq/msSyncAmp/msSyncAxis\n_computeModeSurface + _renderModePlot(false,0)
    Static --> Animating: msToggleAnimation → _startAnimation
    Animating --> Animating: _animLoop (rAF, ~30fps cap)\nphase = 2*pi*_ANIM_HZ*t\n_renderModePlot(false,t,true)
    Animating --> Paused: user drag/wheel on 3-D scene\n(_userInteracting true) — frame skipped\nuntil gesture ends
    Paused --> Animating: gesture ends, _animStart\nshifted forward by gesture duration
    Animating --> Static: msToggleAnimation → _stopAnimation\nredraw at the paused phase (no time-jump)
```

One animation frame evaluates the phasor formula
`disp[y][x] = amp * (Re_fine[y][x]*cos(phase) - Im_fine[y][x]*sin(phase))`
(`_applyPhasorGrid`, see math.html §6.1 for the derivation). Per-frame updates
during real playback (`isAnimFrame && plotEl._msBranch === 'surface'`) use a
fast-path `Plotly.restyle` of only the `z` and `marker.color` arrays on
traces `[0, 1]` — a full `Plotly.react()` every ~33 ms would pin the main
thread and rebuild the gl3d scene's interaction layer, blocking camera
drags/zoom/modebar clicks mid-animation. `_wireInteractionGuard` listens for
`mousedown`/`touchstart`/`wheel`/`plotly_relayouting` (the last is Plotly's
own event for an active gl3d camera drag, which bypasses normal DOM bubbling)
to set `_userInteracting`, so the animation loop never fights the user's own
camera gesture. When `_reFine`/`_xFine`/`_yFine` are unset (fully degenerate
stencil — no real row or column), `_renderModePlot` falls back to a
`scatter3d` ghost-lattice + deformed-lattice rendering instead of the
bicubic surface.

## 6. Rendering — FRF View tab vs. Mode Shape tab

| Trigger | What redraws |
|---|---|
| Node clicked in sidebar (`_updateNodeList`), avg toggle, frequency-band set/reset, new run loaded | `_renderFRFPlot()` — full node-by-node dB-vs-Hz plot on the **FRF View** tab, grayed/highlighted by selection, or collapsed to a single average trace (`_computeAverageFRF`) with peak markers when Average mode is on |
| Switching to the **Mode Shape** tab (`msSetTab('mode')`), avg toggle, new data | `_renderRefFRF()` — compact reference FRF plot with a draggable vertical frequency line; `plotly_click` on this plot calls `msSyncFreq(x)` |
| Frequency/amplitude/axis control change, view-mode toggle, stencil applied, run loaded | `_renderModePlot(resetCamera, t)` — dispatches to the 3-D animated `surface` branch, the `scatter3d` degenerate-lattice fallback, or (`_viewMode==='2d'`) `_renderContourPlot()`, a static Plotly `contour` trace using `_applyPhasorGrid(0)` (phase-0 snapshot) |
| Clicking a view-cube face | `_snapCameraToView()` — `Plotly.relayout` of `scene.camera` only, preserving the current zoom distance (`_currentCameraDistance`) |
| Camera icon / modebar `exportAnimation` button | `msExportAnimationVideo()` — captures one full oscillation cycle by blitting Plotly's live WebGL canvas directly (not `Plotly.toImage()`, which is too slow per-frame) into an offscreen canvas, recorded with `MediaRecorder` to a `.webm` |
| Resizing the FRF side panel, window resize | `_resizeModePlotPreservingCamera()` — captures `_liveCamera()` before `Plotly.Plots.resize()` and re-applies it after, since resize can itself reset a gl3d camera |

The FRF View plot and reference FRF plot are both plain 2-D Plotly line
charts (`scattergl`); the Mode Shape tab's main view is Plotly's `surface`
(gl3d) or `scatter3d`, never a raw canvas/WebGL app of its own — all
rendering goes through Plotly.

## 7. Peak detection + frequency selection

```mermaid
flowchart TD
    A["_renderFRFPlot() / _renderRefFRF()\nalways computes _computeAverageFRF"] --> B["_findPeaks(freq, mag)\nprominence-based, like scipy find_peaks"]
    B --> C["Candidate = strict local maximum;\nprominence = height above the taller\nof its two flanking valleys"]
    C --> D["Keep peaks with prominence\n>= PEAK_MIN_PROMINENCE_DB (3 dB)"]
    D --> E["Rank by prominence, accept\nhighest first, skipping any within\nPEAK_MIN_SPACING_OCTAVES (0.1 octave)\nof an already-accepted peak"]
    E --> F["Triangle markers drawn on both\nthe FRF View average trace\nand the Mode Shape ref FRF plot"]
    F --> G["Click a peak marker, or anywhere\non the ref FRF plot → msSyncFreq(x)"]
    G --> H["Updates slider + number input +\nvertical freq line + recomputes\nmode surface at the new frequency"]
```

## 8. Other side systems

| System | Key functions | What it does |
|---|---|---|
| **Data Folder** | `msSetDataFolder`, `_applyDataFolder` | Standard `showDirectoryPicker()` + shared `saveDataFolderHandle`/`loadDataFolderHandle` pattern; on apply, re-scans stencils and run list |
| **Run discovery** | `_refreshRunList`, `msLoadRun`, `msRefreshRunList` | Scans the Data Folder root for any directory with a `TRF/` subfolder, either directly (`Root/Run/TRF`) or one level deeper (`Root/Instrument/Run/TRF`) |
| **Stencil modal** | `msLoadStencil`, `_renderStencilList`, `msBrowseStencil`, `msCloseStencilModal` | Lists stencils found in `ObieAppSettings/Templates/` (type `node-stencil`/`node-layout`), or lets the user browse to an arbitrary JSON file |
| **Deep link from Circle Fit** | `_applyStartupDeepLink`, `_waitForPyReady` | `?run=&freq=` URL params auto-load a run and jump straight to a frequency on the Mode Shape tab |
| **Average-only display** | `msToggleAverageOnly`, `_computeAverageFRF` | Toggles both the FRF View and reference FRF plots between per-node traces and a single averaged trace (linear-magnitude mean, converted back to dB) with gray context traces for the nodes that fed it |
| **Frequency band zoom** | `msSetFRFBand`, `msResetFRFBand` | Restricts the FRF View x-axis to a Hz range and renormalizes the y-axis to just the data inside that band (unlike Plotly's own zoom, which keeps the full-sweep y-range) |
| **View cube** | `_wireViewCube`, `msRotateViewCube`, `_snapCameraToView`, `_liveCamera` | A small CSS 3-D cube (independent of the real Plotly camera) whose arrow buttons spin its own display; clicking a face snaps the actual scene camera to that direction while preserving zoom distance |
| **Reference FRF panel toggle** | `msToggleRefFRF` | Shows/hides the absolute-positioned FRF overlay panel on the Mode Shape tab |
| **Video export** | `msExportAnimationVideo` | Renders exactly one oscillation cycle frame-by-frame (pacing to real wall-clock time via `setTimeout`), captured off the live WebGL canvas and encoded client-side with `MediaRecorder` — title/axis/colorbar text is not included since those are drawn in a separate Plotly layer from the WebGL canvas |
