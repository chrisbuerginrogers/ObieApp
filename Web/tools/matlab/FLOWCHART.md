# MAT Viewer — Code Flow

> **Naming note:** the folder is `Web/tools/matlab/`, and the original brief for
> this document assumed a "MAT Viewer" that loads and plots existing `.mat`
> FRF files via `Python/fileio/mat_fileio.py`'s `parse_mat`/`parse_mat_bytes`.
> Reading the actual source shows the opposite: this tool's on-page title and
> breadcrumb are **"Export to MATLAB"**, and it runs in reverse — it reads
> existing `.trf`/`.trv`/`.avc`/`.avr` files from a Data Folder and **writes**
> a single aggregated `.mat` file for download. There is no call to
> `parse_mat`, `parse_mat_bytes`, or `mat_fileio.py` anywhere in `matlab.js`
> or `main.py` (`pyscript.toml` only pulls in `trf_fileio.py` and
> `avc_fileio.py`). This document describes the tool as it actually exists.

This documents how `matlab.js` (JS/UI, Data Folder scan, file selection,
canvas mini-plot, download) and `main.py` (PyScript — TRF/AvC/AvR parsing,
`.mat` assembly) work together.

- JS owns: the Data Folder picker (File System Access API), the recursive
  file scan and instrument-filtered file list, the checkbox selection state
  (`_checkedPaths`), the plain-`<canvas>` mini-plot preview, and turning the
  returned `.mat` bytes into a downloaded file. There is no Plotly in this
  tool — `index.html` doesn't even load `plotly.js`.
- Python (`main.py`) owns: parsing each selected file via `parse_trf`
  (`trf_fileio.py`) or `parse_avc` / `parse_avr` (`avc_fileio.py`),
  accumulating results in a module-level `_datasets` dict, and building the
  final `.mat` bytes with `scipy.io.savemat`.
- The two sides talk through `window.pyMatlab*` functions (JS → Python,
  registered via `create_proxy`) and `window.matlab*` callbacks
  (Python → JS), the same pattern as the other tools.

## 1. Page load / init sequence

```mermaid
flowchart TD
    A["Page loads"] --> B["main.py runs top to bottom,\nregisters pyMatlabAddFile / pyMatlabFinish /\npyMatlabClear / pyMatlabPreview as JS-callable proxies"]
    B --> C["Last line of main.py:\njs.window.matlabPyReady()"]
    C --> D["JS: matlabPyReady()\n_pyReady = true, hides #loading overlay"]
    D --> E["loadDataFolderHandle()\nreads shared handle from IndexedDB"]
    E --> F{"Handle found AND\nqueryPermission('read') === granted?"}
    F -- yes --> G["_applyFolder(handle)\nscans folder, populates file list"]
    F -- no --> H["#mat-overlay stays visible:\n'Select a Data Folder above'"]
```

## 2. Data Folder scan and file list

```mermaid
flowchart TD
    A["matlabSetDataFolder() — toolbar button"] --> B["showDirectoryPicker({mode:'read'})"]
    B --> C["saveDataFolderHandle(dir)\n— shared handle, all tools stay in sync"]
    C --> D["_applyFolder(dir)"]
    D --> E["_scanDir(dir) — recursive walk\nskips 'ObieAppSettings' folder\ncollects .trf .trv .avc .avr into _allFiles"]
    E --> F["_populateInstrumentSelect()\ntop-level folder names become\n'instrument' dropdown entries with counts;\nfiles with no folder become synthetic '__root__'"]
    F --> G["_renderFileList()\ndraws one checkbox row per visible file\nwith an extension badge (TRF/AVC/AVR)"]
    G --> H["mat-output-name input defaulted to\n<folder name>.mat"]
```

Changing the instrument dropdown calls `matlabInstrumentChange()` →
`_renderFileList()`, which re-filters via `_getVisibleFiles()`.
`matlabSelectAll()` / `matlabClearAll()` add/remove from `_checkedPaths` for
only the *currently visible* (filtered) files — not the full `_allFiles` set.

## 3. Row click → preview flow

```mermaid
flowchart TD
    A["User clicks a file row\n(_matlabRowClick) or its checkbox\n(_matlabChkClick)"] --> B{"checkbox now checked?"}
    B -- yes --> C["_checkedPaths.add(path)"]
    C --> D["_triggerPreview(path)\nhandle.getFile() -> arrayBuffer()"]
    D --> E["window.pyMatlabPreview(path, Uint8Array)"]
    E --> F["Python _preview() — dispatch by extension"]
    F --> F1["trf/trv -> parse_trf\nfreq, mag straight from result dict"]
    F --> F2["avc -> parse_avc\nmag_db = 20*log10(abs(H_complex))"]
    F --> F3["avr -> parse_avr\nmag_db = 20*log10(abs(data))"]
    F1 --> G["js.window.matlabPreviewData(freq, mag)"]
    F2 --> G
    F3 --> G
    G --> H["_drawMiniPlot(freq, mag)\ncanvas 2D, log-x 200-7000 Hz,\n40 dB window pinned to the trace's max"]
    B -- no --> I["_checkedPaths.delete(path)\n— no preview redraw"]
```

Note: the right-panel preview table's "Freq range" / "Points" columns
(`pr-freq-<path>` / `pr-pts-<path>`) are **not** filled in by this preview
step — they stay `—` until Export actually runs and Python's `_add_file`
fires `matlabFileAdded` (see section 4). Clicking a row only draws the
bottom-left canvas mini-plot and updates the selection count.

## 4. Export flow

```mermaid
flowchart TD
    A["User clicks '⬇ Export .mat'\nmatlabExport()"] --> B{"any files selected?"}
    B -- no --> C["setStatus('No files selected', err)"]
    B -- yes --> D["window.pyMatlabClear()\nclears Python's _datasets dict"]
    D --> E["For each selected file:\nread bytes, call\nwindow.pyMatlabAddFile(path, Uint8Array)"]
    E --> F["Python _add_file() — dispatch by extension"]
    F --> F1["trf/trv -> parse_trf\nentry = {freq, mag_db}"]
    F --> F2["avc -> parse_avc\nentry = {freq, mag_db, H}\n(complex FRF kept for export)"]
    F --> F3["avr -> parse_avr\nentry = {freq, mag_db}"]
    F1 --> G["_safe_name(stem)\nsanitizes to a MATLAB-legal identifier,\ndedupes if already used, stores in _datasets"]
    F2 --> G
    F3 --> G
    G --> H["js.window.matlabFileAdded(path, safeName,\nstartHz, stopHz, nPts)\nfills preview table's Freq range / Points cells"]
    E --> I["After the loop: read #mat-output-name,\nappend '.mat' if missing"]
    I --> J["window.pyMatlabFinish(outName)"]
    J --> K["Python _finish()\nlabels = cell array of dataset keys;\nfor each: name_freq, name_mag_db,\nplus name_H if the entry has one\nscipy.io.savemat(..., do_compression=True)"]
    K --> L["js.window.matlabExportDone(matBytes, outName)"]
    L --> M["JS: Blob -> object URL ->\ntemporary <a download> -> click -> revoke\nsetStatus('✓ <file> downloaded')"]
    K -.->|"exception"| N["js.window.matlabExportError(msg)\nstatus shows error, export button re-enabled"]
```

Output `.mat` variable naming (from the `main.py` docstring): a 1×N cell
array `labels`, plus per dataset `{name}_freq`, `{name}_mag_db`, and
`{name}_H` (AvC files only, complex FRF).

## 5. Other side features

| Feature | Functions | Notes |
|---|---|---|
| Instrument filter | `_populateInstrumentSelect`, `matlabInstrumentChange`, `_getVisibleFiles` | Top-level folder name = "instrument"; files with no parent folder are grouped under a synthetic `__root__` / "(no folder)" entry. |
| Select All / None | `matlabSelectAll`, `matlabClearAll` | Only affects the currently visible (filtered) file set, not every scanned file. |
| Sidebar resizer | inline `mousedown`/`mousemove`/`mouseup` listeners on `#mat-resizer` | Clamps `#matlab-files-panel` width to 180–520 px; plain JS, not a shared helper. |
| Help / Tips | `matlabHelp`, `matlabTips` | Open `../../Docs/experimental.html` and `../../Docs/shortcuts.html` in a new tab — differs from the project convention of a single Help button opening `../../Docs/index.html`, consistent with this tool's Experimental tier. |
| Mini plot | `_drawMiniPlot` | Plain `<canvas>` 2D drawing (no Plotly anywhere in this tool) — fixed log-frequency x-axis (200–7000 Hz), y-axis auto-ranges to a 40 dB window pinned to the selected trace's max value. |
| Data Folder handle | `matlabSetDataFolder`, `matlabPyReady` | Uses the shared `saveDataFolderHandle` / `loadDataFolderHandle` pattern from `obie-settings.js`, same as other tools. |
