# Acquire — Code Flow

This documents how `acquire.js` (JS/UI, audio capture, file I/O) and `main.py`
(PyScript — hit detection, FRF math) work together. Diagrams render natively
on GitHub and in most Markdown/Mermaid-aware editors.

- JS owns: the UI, the Data Folder / File System Access API, audio capture
  (`getUserMedia` + `AudioWorklet`), and all Plotly rendering.
- Python (`main.py`, backed by `Python/processing/frf.py`) owns: the hit
  detection state machine, windowing/calibration, FRF (H1) + coherence math,
  and per-position averaging.
- The two sides talk through `window.py*` functions (JS → Python) and
  `window.on*` callbacks (Python → JS), wired up once when PyScript finishes
  loading (`onPyReady`).

## 1. Overview — one run, start to finish

```mermaid
flowchart TD
    A["Page loads"] --> B["JS restores prefs, plots, checklist, device list"]
    B --> C{"Data Folder handle\nin IndexedDB and granted?"}
    C -- yes --> D["_applyDataFolder(handle)"]
    C -- no --> E["Show 'Select Data Folder' overlay"]
    D --> F["openObieAppSettings\ncreates ObieAppSettings/Templates,bands,colors,lists"]
    F --> G{"Instrument named?"}
    G -- no --> H["Scratch mode — measure freely, unnamed"]
    G -- yes --> I["_refreshInstrumentFolder\ncreates/reuses run folder, writes template.json"]
    H --> J["User opens Template & Settings\nto configure device, hit detection, calibration"]
    I --> J
    J --> K["User presses ▶ Start"]
    K --> L["_startAudio\ngetUserMedia → AudioContext → AudioWorklet"]
    L --> M["Python: armed\nwaiting for a hammer hit"]
    M --> N["Hit detected + captured\nFRF recomputed, TRF saved to disk"]
    N --> O{"n_taps reached\nfor this position?"}
    O -- no --> M
    O -- yes --> P["position_complete\nRepeat / Pause / Next dialog"]
    P --> Q{"More positions left?"}
    Q -- yes --> M
    Q -- no --> R["complete\nAvC + AvR written for each prefix group"]
    R --> S["_resetForNextRun\nrolls to the next numbered run folder"]
    S --> J
```

## 2. The core state machine

`appState` (JS) mirrors Python's `_state` via `window.onStateChange`.

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> armed: acqToggleAcquire → _startAudio → pyArm()
    complete --> armed: acqToggleAcquire (start next run)
    armed --> triggered: trigger channel crosses threshold
    triggered --> armed: _do_capture() — hit saved, more hits needed
    triggered --> position_complete: _do_capture() — n_taps reached
    position_complete --> armed: advance_position() — positions remain
    position_complete --> complete: advance_position() — was the last position
    complete --> [*]: _resetForNextRun rolls folder\n(state stays 'complete' until Start pressed again)
```

**Non-obvious guards worth knowing about:**
- `_post_capture_lockout` — 500 ms dead time after every capture so ringing/echo
  from the last hit can't immediately re-trigger.
- `_blockFRFUpdates` — set on a fresh run after `complete`, suppresses Python's
  FRF-history replay until the first genuine hit of the new run lands.
- Pausing capture nulls `audioCtx` **before** stopping tracks, because Chrome
  fires the track's `ended` event synchronously inside `.stop()` — the
  `ended`/`onstatechange` handlers both guard on `if (!audioCtx) return` to
  avoid double-handling their own shutdown.

## 3. Audio capture pipeline

```mermaid
flowchart TD
    A["_startAudio()"] --> B{"Saved device is\n'__simulated__'?"}
    B -- no --> C["getUserMedia(audio)"]
    C --> D["new AudioContext()"]
    D --> E["Load inline AudioWorkletProcessor\n(blob URL, WORKLET_SRC)"]
    E --> F["Worklet posts {l, r} Float32 chunks\nper audio quantum"]
    F --> G["Main thread accumulates into\nBATCH_SIZE=2048 buffers"]
    G --> H["window.pyProcessAudio(batchL, batchR)"]
    B -- yes --> I["_startSimulation(sr, swapChannels)"]
    I --> J["setInterval synthesizes a decaying hammer\nimpulse + damped-sine mic signal\n(first hit 1.5s in, then every 2.5s)"]
    J --> H
    H --> K["Python process_audio()"]
    C -.->|"device lost"| L["track 'ended' / audioCtx.onstatechange"]
    L --> M["_stopAudio()"]
```

## 4. Template & Settings modal — exit paths

```mermaid
flowchart TD
    A["acqOpenTemplateSettings()"] --> B["Loads templates + stencils from\n_templatesHandle, populates form,\nstarts stencil-file polling"]
    B --> C["User edits Run Settings / Hit Detection /\nCalibration / Audio Capture / Plot Settings"]
    C --> D["Primary button → acqTplExitPrimary()"]
    D --> E{"Template applied\nAND form edited?"}
    E -- yes --> F["acqTplExitUpdateTemplate\noverwrites the template file on disk"]
    E -- no --> G["acqTplExitUseOnce\napplies to this run only"]
    F --> H["_buildPrefsFromForm + _applyPrefsToRun"]
    G --> H
    H --> I["Saves prefs, pushes to Python,\nrestarts audio if device changed"]
    C --> J["Create New Template →\nacqTplExitCreateTemplate\nwrites a new file, then applies"]
    C --> K["Cancel → acqTplExitCancel\ncloses, discards edits, stops stencil polling"]
    J --> H
```

## 5. Per-hit capture loop (Python side)

```mermaid
flowchart TD
    A["process_audio(L, R) — state armed"] --> B{"abs(trigger channel)\n> threshold?"}
    B -- no --> A
    B -- yes --> C["Find trigger sample, compute\n_post_trig_left → state triggered"]
    C --> D["Countdown _post_trig_left\nas more audio arrives"]
    D --> E["_do_capture()\npulls pre/post window from ring buffer"]
    E --> F["Apply calibration + swap-channels\nemit onTriggered (mini plots update)"]
    F --> G["Append hit to _wav_L/_wav_R and _frf[pos]\nsend hammer FFT → onHammerFFT"]
    G --> H["_recompute_frf over ALL hits so far\nH1 = S_fp/S_ff, coherence = abs(S_fp)^2 / (S_ff times S_pp)"]
    H --> I["_save_trf → onSaveTRF\n(JS overwrites the position's .trf on disk)"]
    I --> J{"hits at this position\n== n_taps?"}
    J -- no --> K["500ms lockout, then back to armed"]
    J -- yes --> L["_complete_position()\nonHistoryAdd + onPositionComplete"]
```

## 6. Node Stencil subsystem

```mermaid
flowchart TD
    A["_loadStencilsFromFolder scans\n_templatesHandle for type=node-stencil"] --> B["_renderStencilList\n(always includes a synthetic 'None' entry)"]
    B --> C["acqSelectStencil(i) — click applies immediately"]
    C --> D{"i === -1 (None)?"}
    D -- yes --> E["Clear _currentStencilData,\nstop polling, _saveStencilToRun()"]
    D -- no --> F["Set _currentStencilData,\nmaybe fill positions field,\nstart polling"]
    F --> G["_renderStencilThumb\ndraws nodes[] onto a small canvas"]
    F --> H["_startStencilPoll / _pollAppliedStencilFile\nre-reads the file every 2s while modal is open"]
    H -.->|"file changed on disk\n(edited in Stencil Builder)"| G
    G --> I["Click thumbnail →\nacqOpenStencilBuilder()\nopens template/index.html?file=... "]
    F --> J["_saveStencilToRun\nmerges stencil into this run's template.json"]
```

## 7. Live plotting

| Trigger | What redraws |
|---|---|
| `onFRFUpdate`, `onTapFRF`, palette/opacity change, axis-range edit | `renderFRF()` — rebuilds the main FRF plot from `frfCache` (per-position averages) + `tapCache` (individual hits, if "Show History" is on) + coherence overlay |
| `window.onTriggered` (a real hit) | `_drawTrigPlots()` — Hammer + Mic time-domain mini plots, with threshold/cutoff lines |
| `window.onHammerFFT` | Hammer FFT mini plot, normalized to 0 dB peak |
| `window.onLivePlot` (continuous, non-triggered audio) | Intentionally a no-op — live audio doesn't redraw the mini plots, only real hits do |
| Clicking the FRF plot's camera icon | `_pngWhiteButton()` — temporarily swaps the transparent paper/plot background to white, downloads the PNG, restores the theme |

## 8. Other side systems

| System | Key functions | What it does |
|---|---|---|
| **LiveView** | `acqLiveView`, `_lvToggleCapture`, `_lvComputeH1`, `_lvFft*` | A separate mini audio pipeline (own worklet, own ring buffer, own H1/FFT math in JS) for previewing a device/threshold before committing to the real run. Can also pop out standalone via `acqOpenLiveViewStandalone`. On close, offers to sync its threshold/pre/post back into the real settings if they differ. |
| **Notes** | `acqNotes`, `acqSaveNotes`, `acqDeleteNotes`, `acqAddNotesPhotos` | Reads/writes `notes.txt` in the instrument folder, with a localStorage draft fallback; photos save to a `photos/` subfolder. |
| **Checklist** | `acqToggleChecklist`, `acqAgendaToggle`, `_restoreAgendaUI`, `_resetAgenda` | Per-item localStorage-persisted checkboxes; auto-resets on Start. |
| **Device picker** | `acqOpenDevicePicker`, `_enumerateDevicesInto`, `_updateSoundcardDisplay` | Lists real input devices plus a synthetic "⚡ Simulated Input"; shared by the modal's dropdown and the quick blue status-row picker. |
| **Undo / Clear / Start Over** | `acqDeleteLastHit`, `acqClearPosition`, `acqStartOver` | Pop the last hit (and delete its saved WAV), clear all hits at the current position, or wipe the entire run's `raw/`/`TRF/` contents and start a fresh run folder. |
