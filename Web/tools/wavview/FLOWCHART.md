# WAV Viewer — Code Flow

This documents how `wavview.js` (JS/UI, Data Folder scanning, Plotly rendering)
and `main.py` (PyScript — WAV parsing, hit detection, FRF math) work together.
WAV Viewer is an **Experimental**-tier tool: a read-only inspector for stereo
WAV files, with no capture and no writing back to disk.

- JS owns: the Data Folder / File System Access API, recursive folder
  scanning for `.wav` files, the file-list sidebar, the instrument filter,
  and all Plotly rendering.
- Python (`main.py`, backed by `Python/processing/frf.py`) owns: the WAV
  byte-parsing (its own inline chunk parser, not `wavfileio.py`), threshold
  hit detection, envelope downsampling for display, and FRF (H1) + coherence
  math via `FRFAccumulator` / `add_hit` / `compute_frf`.
- The two sides talk through `window.pyWavProcess` / `window.pyWavApplySettings`
  (JS → Python) and `window.onWavLoaded` / `window.onWavError` (Python → JS),
  plus `window.onPyReady` fired once from the bottom of `main.py`.

## 1. Overview — folder to plotted file

```mermaid
flowchart TD
    A["Page loads"] --> B["_initResizer()\nrestore folder-name label from localStorage"]
    B --> C["loadDataFolderHandle() from shared IndexedDB"]
    C --> D{"Handle found\nand read permission granted?"}
    D -- yes --> E["_applyFolder(handle)"]
    D -- no --> F["Sidebar shows 'No folder selected'\nstatus: 'Select a Data Folder…'"]
    E --> G["_scanFolder recurses subfolders\ncollects all *.wav into _wavFiles"]
    G --> H["Derive _instruments from\ntop-level folder names, populate dropdown"]
    H --> I["_applyInstrumentFilter → _visFiles\n_renderFileList()"]
    I --> J["User clicks a file in the sidebar\nwavSelectFile(idx)"]
    J --> K{"PyScript ready\n(_pyReady)?"}
    K -- no --> L["Queue idx in _pendingIdx\nstatus: 'PyScript loading…'"]
    K -- yes --> M["Read file bytes,\nwindow.pyWavProcess(bytes, path)"]
    M --> N["Python: process_wav()\nparse, detect hits, compute FRF"]
    N --> O["window.onWavLoaded(...)\nJS renders Hammer/Mic/FRF plots"]
    L -.->|"onPyReady fires later"| M
```

## 2. Folder scanning & instrument filter

```mermaid
flowchart TD
    A["wavSetDataFolder()"] --> B["window.showDirectoryPicker(mode: read)"]
    B --> C["saveDataFolderHandle(handle)\n(shared across all tools)"]
    C --> D["_applyFolder(handle)"]
    D --> E["_rootDir = handle\nfolder-name-ind updated"]
    E --> F["_scanFolder(handle, '')\nrecursive, pushes {name, path, handle}\nfor every *.wav found"]
    F --> G["Sort _wavFiles by path+name"]
    G --> H["Collect unique top-level dir names\ninto _instruments, sorted"]
    H --> I["_populateInstrumentSel()\nrebuilds the 'Instrument' dropdown\n(always has an 'All' option)"]
    I --> J["_applyInstrumentFilter()"]
    J --> K{"Dropdown value set?"}
    K -- yes --> L["_visFiles = files whose path\nstarts with '<instrument>/'"]
    K -- no (All) --> M["_visFiles = all _wavFiles"]
    L --> N["_renderFileList()\nstatus: 'N WAV files — click one to view'"]
    M --> N
```

Selecting a different instrument (`wavFilterInstrument`) just re-runs
`_applyInstrumentFilter()` — it does not rescan disk.

## 3. File selection → Python round trip

```mermaid
flowchart TD
    A["wavSelectFile(idx)"] --> B["_activeIdx = idx, _renderFileList()\n(highlights the clicked row)"]
    B --> C{"_pyReady?"}
    C -- no --> D["_pendingIdx = idx\nstatus: 'PyScript loading — will open\nfile when ready…'"]
    C -- yes --> E["item.handle.getFile() → arrayBuffer()"]
    E --> F["window.pyWavProcess(new Uint8Array(buf), path+name)"]
    F --> G["Python process_wav(data_js, filename_js)"]
    G --> H["window.onWavLoaded(...) or\nwindow.onWavError(fname, msg) on exception"]
```

`window.onPyReady` (fired once by `main.py` at import time) applies the saved
preferences via `pyWavApplySettings`, then immediately opens any
`_pendingIdx` file that was queued while PyScript was still loading.

## 4. WAV parsing (Python `_parse_wav`)

`main.py` has its own minimal RIFF/WAVE chunk walker (it does not call the
shared `Python/fileio/wavfileio.py`). It walks chunks starting after the
12-byte `RIFF`/size/`WAVE` header until it finds `fmt ` and `data`:

```mermaid
flowchart TD
    A["_parse_wav(data)"] --> B["Walk chunks from offset 12"]
    B --> C{"chunk_id == 'fmt '?"}
    C -- yes --> D["Read audio_fmt, channels, sample_rate, bits"]
    D --> E{"audio_fmt == EXTENSIBLE (65534)\nand chunk_size >= 40?"}
    E -- yes --> F["Read real format from\nSubFormat GUID at body+24"]
    E -- no --> G["Continue to next chunk"]
    F --> G
    B --> H{"chunk_id == 'data'?"}
    H -- yes --> I{"Sample format?"}
    I -- "float32 / float64" --> J["np.frombuffer '<f4'/'<f8'"]
    I -- "16-bit int" --> K["'<i2' / 32768.0"]
    I -- "24-bit int" --> L["Manual 3-byte little-endian\nassembly + sign extension / 8388608.0"]
    I -- "32-bit int" --> M["'<i4' / 2147483648.0"]
    J --> N["De-interleave: L = s[0::step], R = s[1::step]\n(mono files: R = L)"]
    K --> N
    L --> N
    M --> N
    N --> O["Return L, R, sr, audio_fmt, bits"]
    B -.->|"loop exits without a 'data' chunk"| P["raise ValueError\n'No data chunk found in WAV file'"]
```

Channel assignment (`process_wav`) then applies `_swap_channels`: by default
`ham = R` (channel 1) and `mic = L` (channel 0), matching Acquire's default
wiring; the Settings modal can flip this per-file-format assumption.

## 5. Hit detection & FRF computation

```mermaid
flowchart TD
    A["_find_hits(ham, sr)"] --> B["i = n_pre"]
    B --> C{"abs(ham[i]) > _threshold?"}
    C -- no --> D["i += 1"] --> B
    C -- yes --> E["Record window\n(i-n_pre, i, i+n_post)"]
    E --> F["i += n_post + n_pre\n(skip past this window)"] --> B
    D -.->|"i reaches len(ham) - n_post"| G["Return hits list, n_pre, n_post"]
    F -.-> G

    G --> H{"Any hits found?"}
    H -- no --> I["freqs/H_dB/coh stay None\nFRF plot shows\n'No hits detected above threshold'"]
    H -- yes --> J["FRFAccumulator(sr)"]
    J --> K["For each hit window:\nadd_hit(acc, column_stack(ham_win, mic_win))"]
    K --> L["compute_frf(acc)\n→ freqs, H_dB, coherence"]
    L --> M["trig_times = t_full at each hit's\ntrigger sample"]
```

Both `ham` and `mic` are also passed through `_ds_envelope()` before sending
to JS — a min/max-per-window downsample capped at 4000 windows (8000 output
points) so long WAV files don't choke Plotly or alias into visual noise.
`process_wav` wraps all of this in a `try/except`, calling `onWavError` with
the exception text (truncated to 200 chars) on failure.

## 6. Plotting (JS `onWavLoaded`)

| Plot | Source data | Notable details |
|---|---|---|
| `wav-ham-plot` (Hammer) | `t`/`ham` (downsampled) | Dashed purple threshold lines at ±`p.threshold`; dotted purple vertical lines at each `trig_times` entry |
| `wav-mic-plot` (Microphone) | `t`/`mic` (downsampled) | Same trigger-time vertical markers, no threshold lines |
| `wav-frf-plot` | `freqs`/`Hdb` (purple line) + `coh` (blue line, no legend) | Only drawn when `nHits > 0`; coherence (0–1) is rescaled into the bottom 25% of the current Y range so it overlays without its own axis |
| `wav-frf-plot` (no hits) | — | Single empty trace with a centered annotation naming the threshold, prompting the user to adjust Settings |

Y-axis range: auto-computed from the 99th percentile of `Hdb` (values above
-200 dB only) minus `_S.yDbRange` (default 38 dB), unless the user has
panned/zoomed — `_wireRelayout()` captures `plotly_relayout` events into
`_S.xMin/xMax/yMin/yMax` so the range persists across file switches until
`wavRescaleY()` (↕Y button) resets it to auto again. `wavToggleXLog()`
(X=log/X=lin button) flips `_S.xLog` and redraws the current file.

## 7. Preferences

`wavPreferences()` opens `#prefs-modal`, populated from `_loadPrefs()`
(`localStorage['obieWavView_prefs']`, tool-private — not the shared Data
Folder settings). Fields: trigger `threshold` (V), `pre_trig_s` / `post_trig_s`
window, and `swap_channels` checkbox.

`wavSavePrefs()` — validates/defaults each field, writes to localStorage,
pushes to Python via `pyWavApplySettings(threshold, pre_trig_s, post_trig_s,
swap_channels)` (clamped again on the Python side: threshold ≥ 0.001,
pre ≥ 0.001 s, post ≥ 0.05 s), shows "Saved" in `.save-msg` for 2500 ms, and
if a file is currently open, re-runs `wavSelectFile(_activeIdx)` so the plots
reflect the new settings immediately.

## 8. Other features

| Feature | Function(s) | Notes |
|---|---|---|
| Sidebar resize | `_initResizer()` | Drag handle between `#wav-resizer` and `.wav-sidebar`, width clamped 120–420px; on release, calls `Plotly.Plots.resize()` on all three plots |
| Help / Tips | `wavHelp()`, `wavTips()` | Open `../../Docs/experimental.html` and `../../Docs/shortcuts.html` in new tabs (this tool links to the experimental-tier docs page, not `Docs/index.html`) |
| Filename display | `onWavLoaded` | Strips path down to basename for the status line (`String(fname).split('/').pop().split('\\\\').pop()`), and shows sample rate + `fmtLabel` (e.g. "16-bit int") + hit count |
