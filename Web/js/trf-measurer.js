/**
 * trf-measurer.js  — thin audio bridge + Plotly renderer
 *
 * JS is responsible ONLY for:
 *   1. Audio device enumeration (Web Audio API)
 *   2. getUserMedia + AudioWorklet setup
 *   3. Batching raw audio and relaying to Python
 *   4. Rendering Plotly charts from data Python sends back
 *   5. Triggering file downloads from base64 Python sends back
 *   6. Wiring DOM buttons to Python functions
 *
 * All intelligence (trigger detection, ring buffer, FRF math,
 * state machine, WAV/TRF encoding) lives in trf_measurer_logic.py.
 */

"use strict";

// ── AudioWorklet blob: sends stereo chunks to main thread ────────────────────
const WORKLET_SRC = `
class TRFCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp[0] && inp[0].length > 0) {
      const L = inp[0];
      const R = inp.length > 1 && inp[1] && inp[1].length > 0 ? inp[1] : inp[0];
      this.port.postMessage({ l: L.slice(), r: R.slice() });
    }
    return true;
  }
}
registerProcessor('trf-capture', TRFCaptureProcessor);
`;

// ── Audio objects ─────────────────────────────────────────────────────────────
let audioCtx    = null;
let sourceNode  = null;
let workletNode = null;
let mediaStream = null;

// ── Audio batch buffer (filled from worklet, flushed to Python) ───────────────
const BATCH_SIZE = 2048;
let batchL    = new Float32Array(BATCH_SIZE);
let batchR    = new Float32Array(BATCH_SIZE);
let batchFill = 0;

// ── UI state mirrored from Python callbacks ───────────────────────────────────
let appState    = 'idle';
let currentPos  = 0;
let frfCache    = {};    // pos → { freq[], H1db[] }
let historyFRFs = [];    // [{ freq[], H1db[], label }]
let showHistory = false;
let yAutoscale  = true;

// ── Folder management (File System Access API — Chrome only) ─────────────────
const HAS_FS   = typeof window.showDirectoryPicker === 'function';
let rawHandle  = null;   // handle to run/raw/  subfolder
let trfHandle  = null;   // handle to run/TRF/  subfolder
let runName    = '';     // e.g. "Strad 02"

async function setupRunFolder() {
  const instrument = document.getElementById('inp-instrument').value.trim();
  if (!instrument) { alert('Enter an instrument name first.'); return; }

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e.name !== 'AbortError') alert(`Folder error: ${e.message}`);
    return;
  }

  // Scan existing numbered run folders to find the next number
  const pfxSpace = instrument + ' ';
  let maxNum = 0;
  for await (const [name, h] of dirHandle.entries()) {
    if (h.kind === 'directory' && name.startsWith(pfxSpace)) {
      const n = parseInt(name.slice(pfxSpace.length));
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
  }
  runName = `${instrument} ${String(maxNum + 1).padStart(2, '0')}`;

  const runHandle = await dirHandle.getDirectoryHandle(runName, { create: true });
  rawHandle = await runHandle.getDirectoryHandle('raw', { create: true });
  trfHandle = await runHandle.getDirectoryHandle('TRF', { create: true });

  const lbl = document.getElementById('run-label');
  lbl.textContent = `→ ${runName}`;
  lbl.classList.remove('unset');
}

async function _writeFile(folderHandle, filename, b64) {
  const raw   = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const fh  = await folderHandle.getFileHandle(filename, { create: true });
  const w   = await fh.createWritable();
  await w.write(bytes);
  await w.close();
}

// ── Plotly ────────────────────────────────────────────────────────────────────
const PCFG = { responsive: true, displayModeBar: false };

const MINI = {
  paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
  margin: { l: 44, r: 6, t: 22, b: 28 },
  font: { size: 9, family: 'inherit' }, showlegend: false,
  xaxis: { gridcolor: '#c9b48f', tickfont: { size: 8 }, zeroline: false },
  yaxis: { gridcolor: '#c9b48f', tickfont: { size: 8 }, zeroline: false },
};

function mL(title, xl, yl, xExtra, yExtra, shapes) {
  return {
    ...MINI,
    title: { text: title, font: { size: 9 }, x: 0.04 },
    xaxis: { ...MINI.xaxis, title: { text: xl, font: { size: 8 } }, ...(xExtra||{}) },
    yaxis: { ...MINI.yaxis, title: { text: yl, font: { size: 8 } }, ...(yExtra||{}) },
    ...(shapes ? { shapes } : {}),
  };
}

const hLine = (y, c) => ({
  type:'line', xref:'paper', yref:'y', x0:0, x1:1, y0:y, y1:y,
  line: { color: c, width: 1, dash: 'dot' }
});
const vLine = (x, c) => ({
  type:'line', xref:'x', yref:'paper', x0:x, x1:x, y0:0, y1:1,
  line: { color: c, width: 1.5, dash: 'dash' }
});


// ════════════════════════════════════════════════════════════════════════════
// Python → JS callbacks  (Python calls these to push data back to the UI)
// ════════════════════════════════════════════════════════════════════════════

/** Real-time audio display while armed */
window.onLivePlot = function(t_js, ham_js, mic_js, thr) {
  const t   = Array.from(t_js),  ham = Array.from(ham_js), mic = Array.from(mic_js);
  const thr_f = Number(thr);
  const pk  = Math.max(...ham.map(Math.abs), 0.05);

  Plotly.react('plot-hammer',
    [{ x: t, y: ham, type:'scatter', mode:'lines', line:{ color:'#c62828', width:1 } }],
    mL('Hammer (live)', 'Time (s)', 'V', {}, { range:[-pk*1.3, pk*1.3] },
       [hLine(thr_f, '#e65100'), hLine(-thr_f, '#e65100')]),
    PCFG);

  Plotly.react('plot-mic',
    [{ x: t, y: mic, type:'scatter', mode:'lines', line:{ color:'#1565c0', width:1 } }],
    mL('Microphone (live)', 'Time (s)', 'V'),
    PCFG);
};

/** Triggered window captured — show for user review */
window.onTriggered = function(t_js, ham_js, mic_js, thr) {
  const t   = Array.from(t_js), ham = Array.from(ham_js), mic = Array.from(mic_js);
  const thr_f = Number(thr);
  const pkH = Math.max(...ham.map(Math.abs), 0.05);
  const pkM = Math.max(...mic.map(Math.abs), 0.05);

  Plotly.react('plot-hammer',
    [{ x:t, y:ham, type:'scatter', mode:'lines', line:{ color:'#c62828', width:1 } }],
    mL('Hammer', 'Time (s)', 'V', {}, { range:[-pkH*1.2, pkH*1.2] },
       [hLine(thr_f,'#e65100'), hLine(-thr_f,'#e65100'), vLine(0,'#2e7d32')]),
    PCFG);

  Plotly.react('plot-mic',
    [{ x:t, y:mic, type:'scatter', mode:'lines', line:{ color:'#1565c0', width:1 } }],
    mL('Microphone', 'Time (s)', 'V', {}, { range:[-pkM*1.2, pkM*1.2] },
       [vLine(0,'#2e7d32')]),
    PCFG);
};

/** Hammer spectrum after each accepted hit */
window.onHammerFFT = function(freq_js, db_js) {
  const freq = Array.from(freq_js), db = Array.from(db_js);
  Plotly.react('plot-fft',
    [{ x:freq, y:db, type:'scatter', mode:'lines', line:{ color:'#7c4dbe', width:1 } }],
    mL('Hammer Spectrum', 'Hz', 'dB', { type:'log', range:[Math.log10(20), Math.log10(22050)] }),
    PCFG);
};

/** FRF updated — cache and re-render main plot */
window.onFRFUpdate = function(freq_js, H1db_js, pos, nHits) {
  const freq = Array.from(freq_js), H1db = Array.from(H1db_js);
  if (freq.length > 0) {
    frfCache[Number(pos)] = { freq, H1db };
  } else {
    delete frfCache[Number(pos)];
  }
  renderFRF();
};

/** State machine changed — update status bar, buttons, and settings grey-out */
window.onStateChange = function(jsonStr) {
  const s  = JSON.parse(jsonStr);
  appState = s.state;
  currentPos = s.pos;

  const bar = document.getElementById('status-bar');
  let txt = '', cls = '';
  if (s.state === 'idle')       { txt = 'Idle — configure settings and click Start'; }
  else if (s.state === 'armed') { txt = `● Armed  ·  ${s.label}  ·  Hit ${s.hit_n}/${s.n_taps}`; cls = 'armed'; }
  else if (s.state === 'triggered') { txt = `⚡ Triggered  ·  ${s.label}  —  capturing…`; cls = 'triggered'; }
  else if (s.state === 'reviewing') {
    txt = `⚡ Hit captured  ·  ${s.label}  ·  ${s.hit_n}/${s.n_taps}  —  Accept or Reject?`;
    cls = 'triggered';
  }
  else if (s.state === 'complete') { txt = `✓ Run complete — ${s.n_positions} positions measured`; cls = 'complete'; }

  bar.textContent = txt;
  bar.className   = `status-bar ${cls}`;

  // Grey out the settings card while audio is running
  const card = document.getElementById('settings-card');
  if (card) card.classList.toggle('disabled', s.state !== 'idle');

  updateButtons(s);
};

/** Banner data from Python — re-render position tabs */
window.onBannerUpdate = function(jsonStr) {
  const data = JSON.parse(jsonStr);
  const el   = document.getElementById('pos-banner');
  el.innerHTML = data.map((p, i) => {
    const dots = Array.from({length: p.n_taps}, (_,j) => j < p.hits ? '●' : '○').join('');
    let cls = 'pos-tab';
    if (p.current)                        cls += ' current';
    if (p.hits > 0 && p.hits < p.n_taps) cls += ' partial';
    if (p.hits >= p.n_taps)               cls += ' complete';
    return `<div class="${cls}" onclick="window.pyJumpToPosition(${i})">
      <span class="pos-label">${p.label}</span>
      <span class="pos-dots">${dots}</span>
    </div>`;
  }).join('');
  setTimeout(() => {
    const cur = el.querySelector('.pos-tab.current');
    if (cur) cur.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
  }, 30);
};

/** Completed position — stash FRF for history overlay */
window.onHistoryAdd = function(freq_js, H1db_js, label) {
  historyFRFs.push({ freq: Array.from(freq_js), H1db: Array.from(H1db_js), label });
};

/** Python calls this after each accepted hit — write WAV to run/raw/ */
window.onSaveHit = async function(b64, pos, hitN) {
  if (!rawHandle) return;
  const pfx = (document.getElementById('inp-prefix').value || 'H').trim();
  const p   = String(Number(pos) + 1).padStart(3, '0');
  const h   = String(Number(hitN)).padStart(3, '0');
  await _writeFile(rawHandle, `${runName} ${pfx}_${p}_${h}.wav`, b64);
};

/** Python calls this when a position is complete — write TRF to run/TRF/ */
window.onSaveTRF = async function(b64, pos) {
  if (!trfHandle) return;
  const pfx = (document.getElementById('inp-prefix').value || 'H').trim();
  const p   = String(Number(pos) + 1).padStart(3, '0');
  await _writeFile(trfHandle, `${runName} ${pfx}_${p}.trf`, b64);
};

/** Python finished encoding — trigger browser download (manual fallback) */
window.onDownload = function(b64, filename) {
  if (!b64) { alert('No data to export.'); return; }
  const raw   = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const blob = new Blob([bytes]);
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};


// ════════════════════════════════════════════════════════════════════════════
// FRF plot renderer
// ════════════════════════════════════════════════════════════════════════════

function renderFRF() {
  const traces = [];
  if (showHistory) {
    historyFRFs.forEach((h, i) => {
      traces.push({ x: h.freq, y: h.H1db, type:'scatter', mode:'lines',
        name: h.label,
        line: { color: `rgba(90,65,30,${Math.min(0.25 + 0.12*i, 0.65)})`, width: 1 } });
    });
  }
  const cur = frfCache[currentPos];
  if (cur) {
    traces.push({ x: cur.freq, y: cur.H1db, type:'scatter', mode:'lines',
      name: `Pos ${currentPos+1}`,
      line: { color: '#e65100', width: 2.5 } });
  }
  if (!traces.length) traces.push({ x:[], y:[], type:'scatter' });

  let yRange;
  if (yAutoscale && cur) {
    const valid = cur.H1db.filter(v => isFinite(v) && v > -200);
    if (valid.length) { const mx = Math.max(...valid); yRange = [mx-30, mx+5]; }
  }

  Plotly.react('plot-frf', traces, {
    paper_bgcolor:'transparent', plot_bgcolor:'transparent',
    margin:{l:55,r:15,t:30,b:45}, font:{size:10,family:'inherit'},
    showlegend: showHistory && historyFRFs.length > 0,
    legend: { font:{size:9}, x:1, xanchor:'right', y:1 },
    xaxis: { type:'log', title:{text:'Frequency (Hz)',font:{size:10}},
             range:[Math.log10(100),Math.log10(10000)],
             gridcolor:'#c9b48f', tickfont:{size:9} },
    yaxis: { title:{text:'Intensity (dB)',font:{size:10}},
             range: yRange, gridcolor:'#c9b48f', tickfont:{size:9} },
    autosize: true,
  }, PCFG);
}


// ════════════════════════════════════════════════════════════════════════════
// Audio setup  (only hardware-interface code stays here)
// ════════════════════════════════════════════════════════════════════════════

async function startAudio() {
  if (appState !== 'idle') return;
  const deviceId = document.getElementById('device-sel').value;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId:          deviceId ? { exact: deviceId } : undefined,
        channelCount:      { ideal: 2 },
        sampleRate:        { ideal: 44100 },
        echoCancellation:  false,
        noiseSuppression:  false,
        autoGainControl:   false,
      }
    });

    audioCtx = new AudioContext();
    const sr = audioCtx.sampleRate;

    // Push sample-rate + all settings to Python so it can allocate its ring
    pushSettings(sr);

    const blob    = new Blob([WORKLET_SRC], { type:'application/javascript' });
    const blobURL = URL.createObjectURL(blob);
    await audioCtx.audioWorklet.addModule(blobURL);
    URL.revokeObjectURL(blobURL);

    sourceNode  = audioCtx.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioCtx, 'trf-capture', {
      numberOfInputs: 1, numberOfOutputs: 0,
      channelCount: 2, channelCountMode: 'explicit',
    });

    // Batch worklet chunks; relay to Python only every BATCH_SIZE samples
    batchFill = 0;
    workletNode.port.onmessage = e => {
      const l = e.data.l, r = e.data.r;
      let offset = 0;
      while (offset < l.length) {
        const n = Math.min(l.length - offset, BATCH_SIZE - batchFill);
        batchL.set(l.subarray(offset, offset + n), batchFill);
        batchR.set(r.subarray(offset, offset + n), batchFill);
        batchFill += n;
        offset    += n;
        if (batchFill >= BATCH_SIZE) {
          // Hand full batch to Python for trigger detection + ring buffer
          window.pyProcessAudio(batchL, batchR);
          batchFill = 0;
        }
      }
    };
    sourceNode.connect(workletNode);
    window.pyArm();   // Python: idle → armed, fires onStateChange → buttons/status update
  } catch (err) {
    alert(`Audio error: ${err.message}`);
  }
}

async function stopAudio() {
  if (workletNode)  { workletNode.disconnect(); workletNode = null; }
  if (sourceNode)   { sourceNode.disconnect();  sourceNode  = null; }
  if (audioCtx)     { await audioCtx.close();   audioCtx   = null; }
  if (mediaStream)  { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  // Tell Python to reset its state machine — it then calls onStateChange → updateButtons
  window.pyStopAudio();
}


// ════════════════════════════════════════════════════════════════════════════
// Settings relay  (read DOM, push to Python)
// ════════════════════════════════════════════════════════════════════════════

function pushSettings(sr) {
  const thr   = document.getElementById('inp-threshold').value;
  const win   = document.getElementById('inp-window').value;
  const taps  = document.getElementById('inp-taps').value;
  const npos  = document.getElementById('inp-positions').value;
  const pfx   = document.getElementById('inp-prefix').value;
  window.pyApplySettings(thr, win, taps, npos, pfx, sr || audioCtx?.sampleRate || 44100);
}


// ════════════════════════════════════════════════════════════════════════════
// Initialisation
// ════════════════════════════════════════════════════════════════════════════

function initPlots() {
  const empty = { x:[], y:[], type:'scatter', mode:'lines' };
  Plotly.newPlot('plot-hammer',[{...empty,line:{color:'#c62828',width:1}}],
    mL('Hammer','Time (s)','V'),PCFG);
  Plotly.newPlot('plot-mic',  [{...empty,line:{color:'#1565c0',width:1}}],
    mL('Microphone','Time (s)','V'),PCFG);
  Plotly.newPlot('plot-fft',  [{...empty,line:{color:'#7c4dbe',width:1}}],
    mL('Hammer Spectrum','Hz','dB',{type:'log'}),PCFG);
  renderFRF();
}

async function enumerateDevices() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
  } catch (_) {}
  const devices = await navigator.mediaDevices.enumerateDevices();
  const sel = document.getElementById('device-sel');
  sel.innerHTML = '';
  devices.filter(d => d.kind === 'audioinput').forEach(d => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Microphone (${d.deviceId.slice(0,8)}…)`;
    sel.appendChild(o);
  });
  if (!sel.options.length) sel.innerHTML = '<option value="">No audio devices found</option>';
}

function updateButtons(s) {
  const st = s || { state: appState, hit_n: 0, pos: currentPos };
  const reviewing = st.state === 'reviewing';
  const idle      = st.state === 'idle';
  const complete  = st.state === 'complete';
  const hits      = st.hit_n || 0;
  function sd(id, v) { const el=document.getElementById(id); if(el) el.disabled=v; }
  sd('btn-start',  !idle);
  sd('btn-stop',   idle || complete);
  sd('btn-accept', !reviewing);
  sd('btn-reject', !reviewing);
  sd('btn-delete', hits <= 0 || reviewing);
  sd('btn-clear',  hits <= 0);
}

// Called once from Python after proxies are registered
window.onPyReady = function() {
  pushSettings(44100);
  window.pyInitPositions(parseInt(document.getElementById('inp-positions').value) || 12);
};

window.addEventListener('load', async () => {
  await enumerateDevices();
  initPlots();

  // Wire buttons
  document.getElementById('btn-start') .onclick = startAudio;
  document.getElementById('btn-stop')  .onclick = stopAudio;
  document.getElementById('btn-accept').onclick = () => window.pyAcceptHit();
  document.getElementById('btn-reject').onclick = () => window.pyRejectHit();
  document.getElementById('btn-delete').onclick = () => window.pyDeleteLastHit();
  document.getElementById('btn-clear') .onclick = () => window.pyClearPosition();
  document.getElementById('btn-apply') .onclick = () => pushSettings();
  document.getElementById('btn-yscale').onclick = () => {
    yAutoscale = !yAutoscale;
    document.getElementById('btn-yscale').classList.toggle('active', yAutoscale);
    renderFRF();
  };
  document.getElementById('btn-history').onclick = () => {
    showHistory = !showHistory;
    document.getElementById('btn-history').classList.toggle('active', showHistory);
    renderFRF();
  };
  document.getElementById('btn-save-wav').onclick = () => window.pyExportWAV();
  document.getElementById('btn-save-trf').onclick = () => window.pyExportTRF();

  // Folder button — requires File System Access API (Chrome)
  const folderBtn = document.getElementById('btn-folder');
  const runLbl    = document.getElementById('run-label');
  if (HAS_FS) {
    folderBtn.onclick = setupRunFolder;
    runLbl.textContent = 'No folder selected';
    runLbl.classList.add('unset');
  } else {
    folderBtn.disabled = true;
    folderBtn.title    = 'Requires Chrome — use the WAV/TRF download buttons instead';
    runLbl.textContent = 'Auto-save unavailable (use download buttons)';
    runLbl.classList.add('unset');
  }

  updateButtons({ state: 'idle', hit_n: 0 });
});
