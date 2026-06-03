# ObieApp — Claude Code Instructions

## Project Layout

```
ObieApp/
├── Python/              ← Canonical signal processing & I/O (the source of truth)
│   ├── processing/      ← FRF, convolution, band averaging
│   ├── fileio/          ← TRF, AvC, AvR, WAV, run I/O
│   ├── audioio/         ← Audio device enumeration, streaming, capture
│   ├── plotio/          ← Matplotlib visualization helpers
│   ├── Explore.py       ← Desktop TRF viewer (reference for tool structure)
│   └── Aquire.py        ← Desktop capture tool (reference for tool structure)
└── Web/
    ├── py/              ← PyScript (browser) versions of the Python modules
    ├── js/              ← Shared JS only (obie-settings, browser-check, audio, plotly-theme, …)
    ├── css/             ← Shared CSS only (theme.css, index.css)
    └── tools/           ← One subfolder per web tool; each folder is self-contained
        └── <tool>/      ← index.html + main.py + pyscript.toml + <tool>.js + <tool>.css
```

## Rule 1 — Always Use the Python from This Repo

For any new or modified tool — web or desktop — **all signal processing, file I/O, and DSP must come from the existing Python modules** in `Python/` (desktop) or their PyScript equivalents in `Web/py/` (browser).

**Specifically:**

| Need | Use |
|---|---|
| FRF / H1 estimation | `Python/processing/frf.py` → `FRFAccumulator`, `add_hit`, `compute_frf` |
| Convolution | `Python/processing/convolution.py` → `convolve_it`, `convolve_with_frf` |
| Band averaging | `Python/processing/bands.py` → `compute_bands` |
| TRF / AvC / AvR / WAV parsing | `Python/fileio/` or `Web/py/files.py` |
| Audio device / streaming | `Python/audioio/` |
| Visualization (desktop) | `Python/plotio/` |
| Browser-side DSP | `Web/py/dsp.py` |
| Browser-side capture state machine | `Web/py/acquire_logic.py` |
| Browser-side config (IndexedDB) | `Web/py/config.py` |

**Do not reimplement** convolution, FRF, band math, or file parsing from scratch. Import or adapt from the modules above.

### When You Cannot Use the Repo Python

If a requirement genuinely cannot be satisfied by the existing modules (e.g., a new file format not in `fileio/`, a browser API with no Python equivalent), **stop and tell the human explicitly**:

> ⚠️ This feature requires something not in the existing Python modules: [description]. Options: [A] extend Python/… [B] use a browser-only approach. Which do you prefer?

Never silently reach for a third-party library or reimplement existing logic.

---

## Rule 2 — All Tools Must Match the Explore / Acquire / Convolve Look & Feel

Every new web tool under `Web/tools/<tool-name>/` must follow the exact same structure as the existing three tools.

### Required HTML shell

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <script src="../../coi-serviceworker.js"></script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>[Tool Name] — ObieWebApp 2</title>

  <link rel="stylesheet" href="../../css/theme.css">
  <link rel="stylesheet" href="./[tool-name].css">

  <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>

  <!-- PyScript 2026.3.1 -->
  <link  rel="stylesheet" href="https://pyscript.net/releases/2026.3.1/core.css">
  <script type="module"   src="https://pyscript.net/releases/2026.3.1/core.js"></script>

  <!-- Shared JS — order matters -->
  <script src="../../js/plotly-theme.js"></script>
  <script src="../../js/audio.js"></script>
  <script src="../../js/obie-settings.js"></script>
  <script src="../../js/browser-check.js"></script>       <!-- Chrome check -->
  <script src="./[tool-name].js" defer></script>
</head>
<body>

<div id="loading" class="loading-overlay">
  <div class="spin"></div>
  <div class="load-title">Loading PyScript + NumPy…</div>
  <div class="load-sub">First load may take 15–30 s</div>
</div>

<div class="[tool]-page">

  <!-- Header -->
  <header class="obie-header">
    <a class="brand" href="../../index.html">
      <div class="logo-icon">🎻</div>
      <h1>ObieWebApp 2</h1>
    </a>
    <span class="crumb">· [Tool Name]</span>
    <div class="gap"></div>
    <a class="btn" href="../../index.html" style="font-size:0.75rem;padding:3px 9px">← All tools</a>
  </header>

  <!-- Toolbar — Data Folder button is ALWAYS first -->
  <div class="[tool]-toolbar">
    <button id="[tool]-folder-btn" class="tb-btn" onclick="[tool]SetDataFolder()">📁 Data Folder</button>
    <span id="folder-name-ind" class="folder-name-disp"></span>
    <div class="tb-flex"></div>
    <!-- tool-specific buttons here -->
  </div>

  <!-- Body: sidebar + resizer + plot area (omit sidebar if not needed) -->
  <div class="[tool]-body">
    <!-- ... -->
  </div>

</div>

<script type="py" src="./main.py" config="./pyscript.toml" async></script>
</body>
</html>
```

### Required UI conventions

- **Loading overlay**: always present — same spinner + "Loading PyScript + NumPy…" text.
- **Header**: always `obie-header` class with 🎻 logo, "ObieWebApp 2", tool breadcrumb, and "← All tools" link.
- **Toolbar buttons**: use class `tb-btn`; accent/primary action uses class `tb-btn accent` or `tb-btn start`.
- **Status text**: use `<span class="ex-status-txt">` or similar `*-status-txt` class, not raw paragraphs.
- **Modals**: follow the `modal-overlay → modal-box → modal-header / modal-body` pattern from Explore.
- **Sidebar + resizer**: use the `<div id="[tool]-resizer" class="[tool]-resizer">` drag-handle pattern when a sidebar is present.
- **PyScript version**: always `2026.3.1` — do not upgrade without asking the human.
- **Plotly version**: always `plotly-2.32.0.min.js` — do not upgrade without asking.

### Modal button conventions

Inside modals, use **`.act-btn`** (not `.tb-btn`, not `.btn`). The primary/save action gets class `act-btn accent`:

```html
<!-- Primary action (save, apply, confirm) -->
<button class="act-btn accent" onclick="toolSave()">Save</button>

<!-- Secondary actions (cancel, reset, close) -->
<button class="act-btn" onclick="toolClose()">Cancel</button>
```

Do **not** use inline `style=` overrides on buttons to achieve the accent color — always use `act-btn accent`.

### Settings button convention

The "Settings" toolbar button always opens the preferences modal **directly** — no dropdown menu. Call `toolPreferences()` directly from `onclick`, not a wrapper that toggles a menu.

### Status message timing

Save/success confirmation messages shown via `.save-msg` spans must time out after **2500 ms** consistently across all tools and all modals within a tool.

### Preferences form layout

`.pref-row label` must have `min-width: 150px` in every tool's CSS. `.pref-hint` indent must be `160px` (matching the label width + gap). Do not increase these to accommodate longer labels — shorten the label text instead.

### Help button

Every tool must include a **Help** button in the toolbar (right side, before the primary action). It opens `../../Docs/index.html` in a new tab:
```html
<button class="tb-btn" onclick="toolHelp()">Help</button>
```
```js
window.toolHelp = function() { window.open('../../Docs/index.html', '_blank'); };
```

---

## Rule 3 — Chrome Check (Automatic)

`browser-check.js` must be included in every tool's `<head>` (see shell above). It alerts the user if they are not on Chrome or Edge, which is required for the File System Access API and SharedArrayBuffer.

Do **not** inline this logic or duplicate it — always load the shared `../../js/browser-check.js`.

---

## Rule 4 — Data Folder Check (Ask the Human First)

Before implementing any file-loading feature in a new tool, **ask the human**:

> Should this tool include a "📁 Data Folder" button so the user can pick a folder and browse/search files within it (like Explore does), or will files be loaded one at a time via individual file pickers (like Convolve)?

- If yes → add the `📁 Data Folder` toolbar button as the first element, wired to `window.showDirectoryPicker()`, and implement folder scanning consistent with `explore.js`.
- If no → use individual `<input type="file">` pickers as in Convolve.

**Never assume** — always ask before wiring up folder access.

---

## Startup Checks (Desktop Python Tools)

Every desktop Python tool must perform these checks before doing any real work, following `Aquire.py` and `Explore.py`:

1. Load config via `fileio/config.py → load()` — fail loudly if `config.json` is missing.
2. Validate any input file paths before opening them.
3. Enumerate audio devices via `audioio.AudioStream.list_input_devices()` if audio is needed.

---

## File Format Reference

| Extension | Parser |
|---|---|
| `.trf` / `.trv` | `Python/fileio/trf_fileio.py` · `Web/py/trf_fileio.py` · `Web/py/files.py` |
| `.avc` | `Python/fileio/avc_fileio.py` · `Web/py/files.py` |
| `.avr` | `Python/fileio/avc_fileio.py` · `Web/py/files.py` |
| `.wav` | `Python/fileio/wavfileio.py` · `Web/py/dsp.py` |
| `.tsv` / `.csv` | `Web/py/tsv_parser.py` · `Web/py/files.py` |
| `.mat` | `Python/fileio/mat_fileio.py` · `Web/py/files.py` |

All parsers return a standard dict `{freq, mag, header, warnings}` — match that contract when adding new formats.

The standard dict may also carry an optional **`coh`** field (coherence, 0–1 array, same length as `freq`). Present for `.trf` files saved by Acquire (`fComplex=2.0`) and for `.mat` FRF files. Explore plots coherence as a dotted right-axis overlay when present.

### TRF format extension (Acquire-written files)

`Python/fileio/trf_fileio.py` (and `Web/py/trf_fileio.py`) supports three `fComplex` values:

| `fComplex` | Data layout per bin | Notes |
|---|---|---|
| `0.0` | 1× float64 (real magnitude) | Legacy / read-only tools |
| `1.0` | 2× float64 (re, im) | Complex FRF, older Acquire |
| `2.0` | 3× float64 (re, im, γ²) | **Acquire now writes this** — complex FRF + coherence |

After the binary data, Acquire appends an optional metadata block starting with `b'\x00OBIE_META\n'` (UTF-8 key: value lines). Fields: `sample_rate`, `bit_depth`, `n_hits`, `threshold`, `ham_cutoff`, `mic_cutoff`, `device`. Old readers stop at the data section and ignore the block — backward compatible.

### mat_fileio — browser compatible

`Python/fileio/mat_fileio.py` now accepts **file paths or raw bytes** (the browser needs bytes). `parse_mat_bytes` is an alias for `parse_mat`. Both are in `__all__`. Do **not** create a separate `Web/py/mat_fileio.py` — load the canonical Python version from GitHub in `pyscript.toml`.

---

## Data Folder — Shared Handle Pattern

All tools share a single data-folder handle stored in the `ObieWebApp` IndexedDB and `obieDataFolderName` localStorage key via two functions in `Web/js/obie-settings.js`:

```javascript
await saveDataFolderHandle(handle);   // write — called when any tool picks a folder
const handle = await loadDataFolderHandle();  // read — called on every tool startup
```

**Rules:**
- Every tool's startup must call `loadDataFolderHandle()` to restore the last folder. Never read from a tool-private IDB for the folder handle.
- Every tool's folder-picker must call `saveDataFolderHandle(handle)` after a successful pick. This keeps all tools in sync.
- Tools may keep their own `localStorage` key (e.g., `obieExplore_folderName`) as a display cache, but the authoritative handle always comes from the shared store.
- `_IDB` (a tool-private IndexedDB) is only for data that belongs exclusively to that tool, such as Explore's `'wavData'` sound snippet. Never store `'dataFolderHandle'` in a private IDB.

**New folder detection:**
`openObieAppSettings(dirHandle)` returns `{ settingsHandle, templatesHandle, bandsHandle, colorsHandle, isNew }`. When `isNew` is true, show:
> "This is a new Data Folder and I moved over the default settings folder."

Call `openObieAppSettings` wherever a folder is applied (home page, Explore, Acquire) so this alert fires consistently.

---

---

## pyscript.toml — Local vs. GitHub Sources

Tools load Python modules either from a local path (`../../py/module.py`) or from a GitHub raw URL. **Critical rule:**

> If a Python module in `Python/fileio/` or `Python/processing/` has been **modified locally but not yet pushed to GitHub**, its `pyscript.toml` entry MUST point to a local copy in `Web/py/`, not the GitHub URL. Using a GitHub URL for an unpushed file silently loads the old version and breaks the tool with cryptic errors (e.g. `TypeError: unexpected keyword argument`).

Current state of `trf_fileio.py`: **local** (`../../py/trf_fileio.py`) in all three tools — it has extensions not yet on GitHub (`fComplex=2.0`, `coherence=`, `meta=` params).

When the canonical Python files are pushed to GitHub, the `pyscript.toml` entries can be switched back to GitHub URLs. Prefer GitHub URLs for stable modules so tools always get the latest without a local copy to maintain.

---

## Acquire — Key Implementation Details

### Plot axis ranges

All six plot axes are stored in `localStorage` prefs and in template JSON. The module-level variables in `acquire.js` are:

| Variable | Default | Meaning |
|---|---|---|
| `_S.xMin / _S.xMax` | 200 / 7000 Hz | FRF x axis |
| `_S.yMin / _S.yMax` | -10 / 30 dB | FRF y axis (null = auto via `db_spread`) |
| `_hamXRange` | [0, 0.05] s | Hammer time-domain x |
| `_hamYRange` | [-0.1, 1] V | Hammer time-domain y |
| `_micXRange` | [0, 0.3] s | Mic time-domain x |
| `_micYRange` | [-1, 1] V | Mic time-domain y |
| `_fftXRange` | [200, 10000] Hz | Hammer FFT x |
| `_fftYRange` | [-25, 0] dB | Hammer FFT y |

`_resetAxisRanges(prefs)` resets all eight from a prefs object (or to hard-coded defaults when `prefs` is null). Call it before `_populatePrefsForm(prefs, true)` whenever resetting — this prevents stale localStorage zoom values bleeding into the new session.

`_populatePrefsForm(overridePrefs, skipPlotSync)` — pass `skipPlotSync=true` when resetting to defaults or loading a template, to skip syncing the current Plotly zoom back into the module vars.

### Template prefs keys for axes

Templates should include: `frf_x_min/max`, `frf_y_min/max`, `ham_x_min/max`, `ham_y_min/max`, `mic_x_min/max`, `mic_y_min/max`, `fft_x_min/max`, `fft_y_min/max`.

### Instrument overlay

`_refreshOverlays()` shows a "name your instrument" cover over the plot area **only** when:
1. A data folder is connected (`_rootDirHandle` set), AND
2. No instrument folder is set up yet (`_rawHandle` is null), AND
3. A template has been loaded (`_currentTemplateName` is non-empty)

Without a loaded template the user can run in scratch/unnamed mode freely. Never gate on the banner text saying "scratch" — that would block instruments actually named "scratch".

### State variables

- `_currentTemplateName` — last template applied. Saved into `settings.json` per test run. Used to gate the instrument overlay.
- `_rawHandle` / `_trfHandle` — null until `_refreshInstrumentFolder` completes. The instrument overlay uses `!_rawHandle` to detect "no instrument set up."
- `_appliedPrefix` / `_appliedPerGroup` — tracks what Python's state machine actually has (not stale localStorage). Always read from these for the info panel, not from `_loadPrefs()`.

---

## CSS / Theming

- Global design tokens live in `Web/css/theme.css` — do not hardcode colours or font sizes.
- Each tool gets its own stylesheet (e.g., `explore.css`, `convolve.css`) for layout-specific rules only.
- Shared component styles (modals, toolbars, sidebars) go in `theme.css`, not per-tool files.
