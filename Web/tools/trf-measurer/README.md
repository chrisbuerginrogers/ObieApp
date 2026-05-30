ObieWebApp2 Session Summary
TRF Measurer — what was built, decisions made, bugs fixed

What Was Built
A full impact-hammer FRF measurement tool: ObieWebApp2/trf-measurer/. It captures stereo USB audio (left = microphone, right = impact hammer), detects trigger crossings, averages H1 FRF estimates over N hits per position, and auto-saves WAV and TRF files into a structured run folder.


Final File Locations
ObieWebApp2/

  trf-measurer/

    index.html              ← HTML shell

    main.py                 ← ≤25 lines, create_proxy registrations only

  css/

    trf-measurer.css        ← layout, loading overlay, disabled-card style

  js/

    trf-measurer.js         ← thin bridge: audio, Plotly, folder API, downloads

  py/

    trf_measurer_logic.py   ← ALL intelligence (413 lines)


Architecture: Python-First (critical principle)
JS is a thin hardware/rendering bridge. Python owns everything else.

JS owns
Python owns
getUserMedia + AudioWorklet
Ring buffer (numpy)
Batch relay to Python (2048 samples)
Trigger detection (np.argmax)
Plotly.react() rendering
State machine
File System Access API writes
FRF computation (H1 estimator)
Browser download (atob → Blob)
WAV/TRF encoding
Button → Python wiring
Plot data preparation

Python → JS callback pattern
Python calls js.window.onXxx() to push data. JS never decides what or when.

js.window.onFRFUpdate(to_js(freq.tolist()), to_js(H1db.tolist()), pos, n_hits)

js.window.onStateChange(json.dumps({"state": _state, "pos": _cur_pos, ...}))

js.window.onSaveHit(b64, pos, hit_n)      # immediate per-hit file write

js.window.onSaveTRF(b64, pos)             # auto TRF when position completes

js.window.onDownload(b64, "filename.ext") # manual fallback download
Audio relay pattern (JS → Python)
const BATCH_SIZE = 2048;

// worklet chunks batched, then:

window.pyProcessAudio(batchL, batchR);  // no logic here, just relay
Fast typed-array conversion
# FAST — use this always

L = np.frombuffer(left_js.to_py(), dtype=np.float32).astype(np.float64)

# SLOW — never use

L = np.array(list(left_js), dtype=np.float64)


Bugs Fixed During This Session (important for future tools)
Bug 1: _sr = 44100 default blocked ring allocation
Symptom: No graphs, no trigger, no errors. Cause: _sr initialised to 44100. AudioContext also 44100. Condition if new_sr != _sr was false → _reallocate_ring never called → _ring_L stayed None → process_audio returned early on if _ring_L is None. Fix: _sr = 0 at module level. Any real sample rate triggers allocation.
Bug 2: Python state never left "idle" after Start
Symptom: Start button didn't toggle, Stop stayed greyed, no live plots. Cause: startAudio() called pushSettings() → apply_settings() → _emit_state() with _state = "idle". Nothing ever changed state to "armed". process_audio returned early because _state not in ("armed", "triggered"). Fix: Added arm() function in Python. JS calls window.pyArm() as the last line of startAudio(), after hardware is connected.
Bug 3: Stop button did nothing
Symptom: Clicking Stop had no effect, no console errors. Cause: stopAudio() disconnected hardware but never told Python. Python still thought it was "armed". onStateChange never fired. UI froze. Fix: Added stop_audio() in Python (sets _state = "idle", emits state + banner). JS calls window.pyStopAudio() at end of stopAudio().
Bug 4: IndexError on startup (_pos_hits empty)
Symptom: Python error on page load in _emit_banner — list index out of range. Cause: onPyReady called pushSettings before pyInitPositions. apply_settings tried to call _emit_banner() while _pos_hits = []. Fix: if new_n != _n_positions or not _pos_hits: — also call _init_internal when the list hasn't been populated yet.


Key Python Patterns Used
Ring buffer (no Python loops)
def _push_ring(L, R):

    global _ring_head

    n, space = len(L), _ring_size - _ring_head

    if n <= space:

        _ring_L[_ring_head:_ring_head+n] = L

        _ring_R[_ring_head:_ring_head+n] = R

        _ring_head = (_ring_head + n) % _ring_size

    else:

        _ring_L[_ring_head:] = L[:space];  _ring_R[_ring_head:] = R[:space]

        rem = n - space

        _ring_L[:rem] = L[space:];         _ring_R[:rem] = R[space:]

        _ring_head = rem
Vectorised trigger detection
mask = np.abs(right_chunk) > _threshold

if np.any(mask):

    trig_idx = int(np.argmax(mask))   # first crossing, no Python loop
H1 FRF estimator
# Per hit:

H = rfft(hammer * win) * scale

M = rfft(mic    * win) * scale

hits_Gxx.append(np.abs(H)**2)

hits_Gxy.append(M * np.conj(H))

# Average:

H1   = sum(hits_Gxy) / (sum(hits_Gxx) + 1e-30)

H1db = 20 * np.log10(np.abs(H1) + 1e-12)
WAV encoding (numpy, no loops)
iv = np.empty(n * 2, dtype=np.int16)

iv[0::2] = (L * 0x7FFF).astype(np.int16)

iv[1::2] = (R * 0x7FFF).astype(np.int16)

buf[44:] = iv.tobytes()

return base64.b64encode(bytes(buf)).decode("ascii")


File Saving Architecture
Uses the File System Access API (showDirectoryPicker) — Chrome only.
User workflow
Type instrument name ("Strad")
Click 📁 Choose Folder… → pick parent directory
JS scans existing Strad 01, Strad 02… creates next (Strad 03)
Creates raw/ and TRF/ subfolders automatically
File naming convention
Individual hit WAVs: Strad 03 H_001_001.wav (position, hit — both 3-digit)
Averaged TRF per position: Strad 03 H_001.trf
Save timing
WAV per hit: Python calls js.window.onSaveHit(b64, pos, hit_n) inside accept_hit() — saves immediately
TRF per position: Python calls js.window.onSaveTRF(b64, pos) inside _complete_position() — saves when all taps complete
Manual fallback: 💾 WAV and 💾 TRF buttons still work via onDownload if no folder was selected


Settings Card Grey-Out
When audio is running, the settings card is disabled:

// In onStateChange:

document.getElementById('settings-card').classList.toggle('disabled', s.state !== 'idle');

.sidebar-card.disabled { opacity: 0.45; pointer-events: none; }


SharedArrayBuffer / CORS Note
Pyodide uses SharedArrayBuffer, which Chrome requires cross-origin isolation headers for. GitHub Pages can't set headers, so use coi-serviceworker.js:

Download from github.com/gzuidhof/coi-serviceworker
Place at ObieWebApp2/coi-serviceworker.js
Add as first tag in <head> of every tool page:

<script src="../../coi-serviceworker.js"></script>

(path depth depends on tool location)


Project Instructions Update
The project instructions were updated this session. The authoritative version is ObieWebApp2-project-instructions.md. Key changes from the version at session start:

Folder structure: Each tool now gets its own subfolder <tool>/ with index.html + main.py. The old html/<tool>.html + py/<tool>_app.py pattern is retired.
Paths: All asset references from tool pages use ../../ prefix (two levels deep)
py-config files: "../../py/foo.py": "./foo.py" pattern
New Python-First Architecture section added
New AudioWorklet blob pattern added
New numpy patterns (frombuffer, ring buffer, trigger detection, WAV encoding)
What Not To Do expanded from 8 to 17 items


State Machine States
idle → (Start clicked + pyArm()) → armed

armed → (trigger detected) → triggered

triggered → (window complete) → reviewing

reviewing → (Accept) → armed  [or → complete if last tap of last position]

reviewing → (Reject) → armed

armed/reviewing → (Stop clicked + pyStopAudio()) → idle

any → (all positions complete) → complete


Python Proxy Registrations (main.py)
js.window.pyApplySettings  = create_proxy(apply_settings)

js.window.pyInitPositions  = create_proxy(init_positions)

js.window.pyProcessAudio   = create_proxy(process_audio)

js.window.pyAcceptHit      = create_proxy(accept_hit)

js.window.pyRejectHit      = create_proxy(reject_hit)

js.window.pyDeleteLastHit  = create_proxy(delete_last_hit)

js.window.pyClearPosition  = create_proxy(clear_position)

js.window.pyJumpToPosition = create_proxy(jump_to_position)

js.window.pyExportWAV      = create_proxy(export_wav)

js.window.pyExportTRF      = create_proxy(export_trf)

js.window.pyStopAudio      = create_proxy(stop_audio)

js.window.pyArm            = create_proxy(arm)


