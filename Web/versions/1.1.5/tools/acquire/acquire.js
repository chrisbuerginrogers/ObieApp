/**
 * acquire.js — Acquire tool: audio bridge + Plotly renderers
 *
 * JS responsibilities:
 *  1. AudioWorklet setup and streaming to Python
 *  2. Rendering 3 mini plots (FFT, Hammer, Mic) via Plotly
 *  3. Rendering main FRF plot (all positions overlaid)
 *  4. Cutoff bar interaction on FFT mini plot
 *  5. Position banner rendering
 *  6. Data-folder management (File System Access API)
 *  7. Modals: preferences, notes, template
 *  8. All UI state wiring
 *
 * All DSP intelligence lives in acquire_logic.py.
 */

'use strict';

// ── AudioWorklet blob ─────────────────────────────────────────────────────────
const WORKLET_SRC = `
class AcqCaptureProcessor extends AudioWorkletProcessor {
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
registerProcessor('acq-capture', AcqCaptureProcessor);
`;

// ── Audio state ───────────────────────────────────────────────────────────────
let audioCtx    = null;
let sourceNode  = null;
let workletNode = null;
let mediaStream = null;
let _appliedPrefix   = 'H';   // prefix actually sent to Python (may differ from saved prefs)
let _appliedPerGroup = 12;    // positions-per-group actually sent to Python
let _simInterval = null;   // non-null when running in simulated-input mode
let _simSample   = 0;      // running sample counter for simulation
let _simNextHit  = 0;      // sample index of the next synthetic hit

const BATCH_SIZE = 2048;
let batchL    = new Float32Array(BATCH_SIZE);
let batchR    = new Float32Array(BATCH_SIZE);
let batchFill = 0;

// ── UI state ──────────────────────────────────────────────────────────────────
let appState      = 'idle';
let currentPos    = 0;
let frfCache      = {};     // pos → { freq[], H1db[], coh[], nHits }
let _hamTimeCutoffS = 0.30;  // green line on hammer plot (s after trigger)
let _micTimeCutoffS = 0.30;  // green line on mic plot (s after trigger)
let _preTrigS       = 0.01;  // pre-trigger duration — added to cutoff positions since t=0 is window start
let _lineWidth    = 0.5;    // FRF trace width in px
let _S = {
  xLog: true, xMin: 100, xMax: 12000,
  yMin: null, yMax: null,
  yDbRange: 38,
  dbOffset: 0,
};

// Per-mini-plot y-range locks (null = auto)
let _fftYRange  = [-25, 0];
let _hamYRange  = [-0.1, 1];
let _micYRange  = [-1, 1];

// Hammer FFT x-range (Hz)
let _fftXRange  = [200, 10000];

let _yTrueAutorange = false;      // true while Plotly.react is running (suppress re-entrant relayout)
let _blockFRFUpdates = false;     // true after new-run Start — suppresses Python's history replay until first real hit

// Individual tap FRF traces
let tapCache        = {};     // pos → [{freq, H1db}, ...]
let _showTaps       = true;
let _tapOpacity     = 0.40;
let _prevPosOpacity = 0.70;   // opacity for non-current positions; ↑/↓ keys adjust

// Mini-plot x-ranges (time domain)
let _hamXRange = [0, 0.05];
let _micXRange = [0, 0.3];

// ── Colour palettes (same as Explore) ────────────────────────────────────────
const PALETTES = {
  default:  ['#ff6f00','#2196f3','#4caf50','#e91e63','#9c27b0','#00bcd4','#ff5722','#8bc34a','#ffc107','#607d8b'],
  warm:     ['#b71c1c','#c62828','#d32f2f','#e64a19','#f57c00','#ff8f00','#f9a825','#f57f17'],
  cool:     ['#0d47a1','#1565c0','#0277bd','#00838f','#006064','#1b5e20','#33691e','#827717'],
  contrast: ['#000000','#e53935','#1e88e5','#43a047','#fb8c00','#8e24aa','#00acc1','#6d4c41'],
};
let _palette = PALETTES.default;

// ── Plotly config ─────────────────────────────────────────────────────────────
const PCFG = { responsive: true, displayModeBar: false };

const MINI_BASE = {
  paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
  margin: { l: 44, r: 8, t: 18, b: 28 },
  font: { size: 9, family: 'inherit' }, showlegend: false,
  xaxis: { gridcolor: '#c9cdd5', tickfont: { size: 8 }, zeroline: false },
  yaxis: { gridcolor: '#c9cdd5', tickfont: { size: 8 }, zeroline: false },
};

function miniLayout(title, xl, yl, xExtra, yExtra, shapes) {
  return {
    ...MINI_BASE,
    title: { text: title, font: { size: 9 }, x: 0.04 },
    xaxis: { ...MINI_BASE.xaxis, title: { text: xl, font: { size: 8 } }, ...(xExtra || {}) },
    yaxis: { ...MINI_BASE.yaxis, title: { text: yl, font: { size: 8 } }, ...(yExtra || {}) },
    ...(shapes ? { shapes } : {}),
  };
}

const hDot = (y, c) => ({
  type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: y, y1: y,
  line: { color: c, width: 1.5, dash: 'dot' },
});
const vLine = (x, c, dash) => ({
  type: 'line', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: 1,
  line: { color: c, width: 2, dash: dash || 'solid' },
});


// ════════════════════════════════════════════════════════════════════════════
// Python → JS callbacks
// ════════════════════════════════════════════════════════════════════════════

/** Live audio — no-op: signal plots only update on trigger */
window.onLivePlot = function(_t, _h, _m, _thr) {};

// Cache last triggered window so the green line can be redrawn when cutoff moves
let _lastTrigData = null;

/** Triggered window — show captured hammer + mic with green time-cutoff line */
window.onTriggered = function(t_js, ham_js, mic_js, thr) {
  const t = Array.from(t_js), ham = Array.from(ham_js), mic = Array.from(mic_js);
  const thrF = Number(thr);
  _lastTrigData = { t, ham, mic, thr: thrF };
  _drawTrigPlots(t, ham, mic, thrF);
};

function _drawTrigPlots(t, ham, mic, thrF) {
  // Y autoscale uses only data within the visible x range
  const hamVis = ham.filter((_, i) => t[i] >= _hamXRange[0] && t[i] <= _hamXRange[1]);
  const micVis = mic.filter((_, i) => t[i] >= _micXRange[0] && t[i] <= _micXRange[1]);
  const pkH = Math.max(0.05, ...hamVis.map(Math.abs));
  const pkM = Math.max(0.05, ...micVis.map(Math.abs));

  // Cutoff lines only drawn when the cutoff falls within the visible x range
  const hamShapes = [hDot(thrF, '#7c2bc8')];
  const hamCutX = _preTrigS + _hamTimeCutoffS;
  if (hamCutX >= _hamXRange[0] && hamCutX <= _hamXRange[1])
    hamShapes.push(vLine(hamCutX, '#2e7d32'));
  const micShapes = [];
  const micCutX = _preTrigS + _micTimeCutoffS;
  if (micCutX >= _micXRange[0] && micCutX <= _micXRange[1])
    micShapes.push(vLine(micCutX, '#2e7d32'));

  Plotly.react('plot-hammer',
    [{ x: t, y: ham, type: 'scatter', mode: 'lines', line: { color: '#c62828', width: 1 } }],
    miniLayout('Hammer', 'Time (s)', 'V',
      { range: _hamXRange },
      _hamYRange ? { range: _hamYRange } : { range: [-pkH*1.2, pkH*1.2] },
      hamShapes),
    PCFG);

  Plotly.react('plot-mic',
    [{ x: t, y: mic, type: 'scatter', mode: 'lines', line: { color: '#1565c0', width: 1 } }],
    miniLayout('Microphone', 'Time (s)', 'V',
      { range: _micXRange },
      _micYRange ? { range: _micYRange } : { range: [-pkM*1.2, pkM*1.2] },
      micShapes),
    PCFG);
}


/** Hammer FFT — normalized to 0 dB peak within the display window */
window.onHammerFFT = function(freq_js, db_js) {
  const freqAll  = Array.from(freq_js).map(Number);
  const dbAll    = Array.from(db_js).map(Number);
  const fMax     = Math.min(_fftXRange[1], freqAll[freqAll.length - 1] || _fftXRange[1]);
  const fMin     = _fftXRange[0];

  // Build arrays, skip DC bin (freq=0 breaks log axis)
  const freq = [], db = [];
  for (let i = 0; i < freqAll.length; i++) {
    if (freqAll[i] > 0) { freq.push(freqAll[i]); db.push(dbAll[i]); }
  }
  if (!freq.length) return;

  // Normalize by the peak within the displayed band
  let peak = -1e9;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= fMin && freq[i] <= fMax && isFinite(db[i]) && db[i] > peak)
      peak = db[i];
  }
  if (!isFinite(peak)) {
    for (let i = 0; i < db.length; i++) if (isFinite(db[i]) && db[i] > peak) peak = db[i];
  }
  if (!isFinite(peak)) return;

  const dbNorm = db.map(v => isFinite(v) ? v - peak : null);

  Plotly.react('plot-fft',
    [{ x: freq, y: dbNorm, type: 'scatter', mode: 'lines', line: { color: '#7c4dbe', width: 1 } }],
    miniLayout('Hammer FFT', 'Hz', 'dB',
      { type: 'log', range: [Math.log10(Math.max(fMin, 1)), Math.log10(fMax)] },
      { range: _fftYRange }),
    PCFG);
};

/** FRF updated for one position — cache and re-render main plot */
window.onFRFUpdate = function(freq_js, H1db_js, coh_js, pos, nHits) {
  const p = Number(pos), n = Number(nHits);
  // After starting a new run, suppress Python's history replay until the first real hit.
  if (_blockFRFUpdates) {
    if (n === 1 && p === 0) {
      _blockFRFUpdates = false;   // first genuine hit of the new run — allow through
    } else {
      return;
    }
  }
  const freq = Array.from(freq_js), H1db = Array.from(H1db_js);
  const coh  = Array.from(coh_js);
  if (freq.length > 0) {
    // First hit of a new position — clear any stale data left over from a Pause
    if (n === 1) {
      Object.keys(frfCache).forEach(k => { if (Number(k) !== p) { delete frfCache[k]; delete tapCache[k]; } });
    }
    frfCache[p] = { freq, H1db, coh, nHits: n };
    // Trim tap cache if a hit was deleted
    if (tapCache[p] && tapCache[p].length > n)
      tapCache[p].length = n;
  } else {
    delete frfCache[p];
    delete tapCache[p];
  }
  renderFRF();
};

/** Individual tap FRF from Python — one per hammer strike */
window.onTapFRF = function(freq_js, H1db_js, pos, hitIdx) {
  const p = Number(pos), idx = Number(hitIdx);
  if (!tapCache[p]) tapCache[p] = [];
  tapCache[p][idx] = { freq: Array.from(freq_js), H1db: Array.from(H1db_js) };
  if (_showTaps) renderFRF();
};

/** State machine changed */
window.onStateChange = function(jsonStr) {
  const s = JSON.parse(jsonStr);
  appState   = s.state;
  currentPos = s.pos;

  const bar = document.getElementById('status-bar');
  let txt = '', cls = '';
  if      (s.state === 'idle')      { txt = 'Idle — press Start to begin acquisition'; }
  else if (s.state === 'armed')     { txt = `● Armed  ·  ${s.label}  ·  Hit ${s.hit_n}/${s.n_taps}`; cls = 'armed'; }
  else if (s.state === 'triggered') { txt = `⚡ Triggered  ·  ${s.label}  —  capturing…`; cls = 'triggered'; }
  else if (s.state === 'position_complete') { txt = `✓ ${s.label} complete — choose Repeat or Next`; cls = 'complete'; }
  else if (s.state === 'complete')  { txt = `✓ Run complete — ${s.n_positions} positions measured`; cls = 'complete'; _resetForNextRun(); }
  if (bar) { bar.textContent = txt; bar.className = `acq-status-txt ${cls}`; }

  _updateStopBtn();
  _updateEditBtns(s);
  _updateSoundcardDisplay();
};

/** Position banner from Python */
window.onBannerUpdate = function(jsonStr) {
  const data = JSON.parse(jsonStr);
  const el   = document.getElementById('pos-banner');
  if (!el) return;
  el.innerHTML = data.map((p, i) => {
    const dots = Array.from({length: p.n_taps}, (_, j) => j < p.hits ? '●' : '○').join('');
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

/** Completed position — used for history overlay */
window.onHistoryAdd = function(freq_js, H1db_js, label) {
  // frfCache already has this; onHistoryAdd is just informational here
};

/** Python finished the last hit — show Repeat / Next dialog */
window.onPositionComplete = function(label, isLast) {
  const dlg = document.getElementById('pos-complete-modal');
  if (!dlg) return;
  const msg = document.getElementById('pos-complete-label');
  if (msg) msg.textContent = label + ' Complete';
  const nextBtn = document.getElementById('pos-complete-next-btn');
  if (nextBtn) nextBtn.textContent = isLast ? 'Finish Run' : 'Next Position →';
  dlg.classList.add('open');
  nextBtn?.focus();
};

window.acqRepeatPosition = function() {
  document.getElementById('pos-complete-modal')?.classList.remove('open');
  _clearTrigPlots();
  window.pyRepeatPosition?.();
};

window.acqPausePosition = async function() {
  document.getElementById('pos-complete-modal')?.classList.remove('open');
  // Stop audio hardware (or simulation) — plot is intentionally left showing the completed position's data
  _stopSimulation();
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (sourceNode)  { sourceNode.disconnect();  sourceNode  = null; }
  if (audioCtx)    { await audioCtx.close();   audioCtx    = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  // Advance the position in Python so Start resumes on the next position
  window.pyAdvancePosition?.();
  appState = 'idle';
  _updateStopBtn();
};

window.acqNextPosition = function() {
  document.getElementById('pos-complete-modal')?.classList.remove('open');
  delete frfCache[currentPos];
  delete tapCache[currentPos];
  renderFRF();
  _clearTrigPlots();
  window.pyAdvancePosition?.();
};

function _setSaveStatus(saving, detail) {
  const el = document.getElementById('save-status-ind');
  if (!el) return;
  if (saving === null) {
    el.textContent = '🔸 scratch — not saved';
    el.style.color = 'var(--muted)';
  } else if (saving) {
    el.textContent = `💾 ${detail}`;
    el.style.color = 'var(--accent)';
  } else {
    el.textContent = `⚠️ Not saved${detail ? ': ' + detail : ''}`;
    el.style.color = '#b71c1c';
  }
}

let _lastSavedWav = null;   // filename of most-recently saved hit WAV

/** Auto-save hit WAV to run folder */
window.onSaveHit = async function(b64, pos, hitN) {
  if (!_rawHandle) { _setSaveStatus(false); return; }
  const pfx = (document.getElementById('inp-prefix')?.value || 'H').trim();
  const p   = String(Number(pos) + 1).padStart(3, '0');
  const h   = String(Number(hitN)).padStart(3, '0');
  const inst = _runName || 'run';
  const filename = `${inst} ${pfx}_${p}_${h}.wav`;
  _lastSavedWav = filename;
  await _writeFile(_rawHandle, filename, b64);
};

/** Overwrite TRF on disk after every hit for the given position */
window.onSaveTRF = async function(b64, pos) {
  if (!_trfHandle) { _setSaveStatus(false); return; }
  const pfx = (document.getElementById('inp-prefix')?.value || 'H').trim();
  const p   = String(Number(pos) + 1).padStart(3, '0');
  const inst = _runName || 'run';
  await _writeFile(_trfHandle, `${inst} ${pfx}_${p}.trf`, b64);
};

/** Save AvC (complex average) to the test folder root at session end */
window.onSaveAvC = async function(b64) {
  const h    = _testHandle;
  const name = _runName || 'run';
  if (!h) return;
  await _writeFile(h, `${name} AvC.avc`, b64);
};

/** Save AvR (magnitude average) to the test folder root at session end */
window.onSaveAvR = async function(b64) {
  const h    = _testHandle;
  const name = _runName || 'run';
  if (!h) return;
  await _writeFile(h, `${name} AvR.avr`, b64);
};

/** Manual download fallback */
window.onDownload = function(bytes, filename) {
  if (!bytes) { alert('No data to export.'); return; }
  const blob = new Blob([bytes]);
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};


// ════════════════════════════════════════════════════════════════════════════
// Main FRF plot
// ════════════════════════════════════════════════════════════════════════════

function renderFRF() {
  const frfTraces = [];
  const tapTraces = [];
  const pendingCoh = [];  // collected with color, mapped after yRange is known
  const positions = Object.keys(frfCache).map(Number).sort((a,b)=>a-b);

  // Latest position in frfCache = "current" → full opacity; earlier = faded
  const maxPos = positions.length ? positions[positions.length - 1] : -1;

  const pfx = document.getElementById('inp-prefix')?.value || 'H';
  let globalTapIdx = 0;
  positions.forEach((pos) => {
    const d = frfCache[pos];
    if (!d || !d.freq.length) return;
    const offset = _S.dbOffset || 0;
    const mags  = offset ? d.H1db.map(v => v + offset) : d.H1db;
    const valid = mags.filter(v => isFinite(v) && v > -200);
    if (!valid.length) return;
    const color = _palette[pos % _palette.length];
    const label = `${pfx}${String(pos+1).padStart(2,'0')} (${d.nHits} hits)`;
    frfTraces.push({
      x: d.freq, y: mags,
      type: 'scatter', mode: 'lines',
      name: label, yaxis: 'y',
      line: { color, width: _lineWidth },
      opacity: pos === maxPos ? 1.0 : _prevPosOpacity,
      showlegend: true,
    });
    if (d.coh?.length) pendingCoh.push({ freq: d.freq, coh: d.coh, color });

    // Individual tap traces — each tap gets a unique color across all positions
    if (_showTaps && tapCache[pos]?.length) {
      tapCache[pos].forEach((tap) => {
        if (!tap) return;
        const tapColor = _palette[globalTapIdx % _palette.length];
        globalTapIdx++;
        tapTraces.push({
          x: tap.freq, y: tap.H1db,
          type: 'scatter', mode: 'lines', yaxis: 'y',
          line: { color: tapColor, width: _lineWidth },
          opacity: _tapOpacity,
          showlegend: false, hoverinfo: 'skip',
        });
      });
    }
  });

  // Coherence behind taps, taps behind FRF averages
  let traces = [...tapTraces, ...frfTraces];
  if (!traces.length) {
    traces = [{ x: [], y: [], type: 'scatter', mode: 'lines', showlegend: false }];
  }

  // Y range — fit to data using 1st/99th percentile (avoids spikes and noise-floor dips).
  let yRange;
  if (_S.yMin != null && _S.yMax != null) {
    yRange = [_S.yMin, _S.yMax];
  } else {
    const allY = [];
    for (const t of frfTraces)
      for (const v of t.y)
        if (isFinite(v) && v > -200) allY.push(v);
    if (allY.length) {
      allY.sort((a, b) => a - b);
      const pMax = allY[Math.floor(allY.length * 0.99)];
      const pMin = allY[Math.floor(allY.length * 0.01)];
      // Bottom = whichever is higher: data-fit floor OR top-anchored span from yDbRange.
      // This prevents showing excessive empty space below when data span < yDbRange.
      const bottom = Math.max(pMin - 3, pMax + 3 - _S.yDbRange);
      yRange = [bottom, pMax + 3];
    }
  }

  // Map coherence (0–1) into the middle 50% of the y range, centered vertically.
  // Coherence traces are prepended so they render BEHIND FRF and tap traces.
  if (pendingCoh.length && yRange) {
    const coBottom = yRange[0] + (yRange[1] - yRange[0]) * 0.25;
    const coTop    = yRange[0] + (yRange[1] - yRange[0]) * 0.75;
    const cohTraces = pendingCoh.map(({ freq, coh, color }) => ({
      x: freq,
      y: coh.map(c => coBottom + Math.max(0, Math.min(1, c)) * (coTop - coBottom)),
      type: 'scatter', mode: 'lines',
      yaxis: 'y',
      line: { color, width: Math.max(_lineWidth, 0.8) },
      opacity: 0.25,
      showlegend: false,
      hoverinfo: 'skip',
    }));
    traces = [...cohTraces, ...traces];
  }

  const xRange = _S.xLog
    ? [Math.log10(Math.max(_S.xMin, 1)), Math.log10(_S.xMax)]
    : [_S.xMin, _S.xMax];

  _yTrueAutorange = true;
  Plotly.react('acq-plot', traces, {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    margin: { l: 58, r: 20, t: 12, b: 50 },
    font: { size: 11, family: 'inherit' },
    showlegend: frfTraces.length > 0,
    legend: { font: { size: 9 }, x: 1, xanchor: 'right', y: 1 },
    xaxis: {
      type: _S.xLog ? 'log' : 'linear',
      title: { text: 'Frequency (Hz)', font: { size: 11 } },
      range: xRange,
      gridcolor: '#c0c4cc', tickfont: { size: 10 },
    },
    yaxis: {
      title: { text: 'Intensity (dB)', font: { size: 11 } },
      ...(yRange ? { range: yRange, autorange: false } : { autorange: true }),
      gridcolor: '#c0c4cc', tickfont: { size: 10 },
    },
    autosize: true,
  }, { ...PCFG, displayModeBar: true, displaylogo: false,
       modeBarButtonsToRemove: ['sendDataToCloud'] });
  // Clear the guard via setTimeout so any deferred relayout events Plotly fires
  // after react() (e.g. after a prior double-click autoscale) are also suppressed.
  setTimeout(() => { _yTrueAutorange = false; }, 0);
}


// ════════════════════════════════════════════════════════════════════════════
// Toolbar controls
// ════════════════════════════════════════════════════════════════════════════

window.acqToggleTaps = function(checked) {
  _showTaps = (checked === undefined) ? !_showTaps : !!checked;
  const chk = document.getElementById('taps-chk');
  if (chk) chk.checked = _showTaps;
  renderFRF();
};

// ↑/↓ arrows adjust opacity of previous positions relative to the current one
document.addEventListener('keydown', e => {
  // Space advances through the position-complete dialog from anywhere
  if ((e.key === ' ' || e.code === 'Space') &&
      document.getElementById('pos-complete-modal')?.classList.contains('open')) {
    e.preventDefault();
    window.acqNextPosition();
    return;
  }
  if (document.activeElement?.tagName === 'INPUT' ||
      document.activeElement?.tagName === 'SELECT' ||
      document.activeElement?.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (_showTaps) _tapOpacity = Math.min(1.0, +(_tapOpacity + 0.05).toFixed(2));
    else           _prevPosOpacity = Math.min(1.0, +(_prevPosOpacity + 0.05).toFixed(2));
    renderFRF();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (_showTaps) _tapOpacity = Math.max(0.05, +(_tapOpacity - 0.05).toFixed(2));
    else           _prevPosOpacity = Math.max(0.05, +(_prevPosOpacity - 0.05).toFixed(2));
    renderFRF();
  }
});

window.acqRescaleY = function() {
  _S.yMin = null; _S.yMax = null;
  renderFRF();
};

window.acqSetYDbRange = function(val) {
  _S.yDbRange = parseFloat(val) || 38;
  _patchPrefs({ db_spread: _S.yDbRange });
  if (_S.yMin == null) renderFRF();
};

window.acqToggleXLog = function() {
  _S.xLog = !_S.xLog;
  const b = document.getElementById('x-log-btn');
  if (b) { b.textContent = _S.xLog ? 'X=log' : 'X=lin'; b.classList.toggle('active', _S.xLog); }
  renderFRF();
};

window.acqRescaleFFT = function() {
  Plotly.relayout('plot-fft', {
    'xaxis.range': [Math.log10(200), Math.log10(10000)],
    'yaxis.range': [-25, 0],
  });
};

function _clearTemplateName() {
  _currentTemplateName = '';
  const tplInd = document.getElementById('tpl-ind');
  if (tplInd) tplInd.textContent = '';
}

window.acqApplyThreshold = function(val) {
  const v = Math.max(0.001, parseFloat(val) || 0.05);
  const el = document.getElementById('inp-thr-disp');
  if (el) el.value = v.toFixed(3);
  const pref = document.getElementById('inp-threshold');
  if (pref) pref.value = v;
  if (_lastTrigData) {
    _lastTrigData.thr = v;
    const { t, ham, mic } = _lastTrigData;
    _drawTrigPlots(t, ham, mic, v);
  }
  _patchPrefs({ threshold: v });
  _callPyApplySettings();
  _clearTemplateName();
};

window.acqApplyHamCutoff = function(val) {
  const v = Math.max(0.01, parseFloat(val) || 0.30);
  const el = document.getElementById('inp-ham-cut-disp');
  if (el) el.value = v.toFixed(3);
  const pref = document.getElementById('inp-time-cutoff');
  if (pref) pref.value = v;
  _hamTimeCutoffS = v;
  if (_lastTrigData) { const { t, ham, mic, thr } = _lastTrigData; _drawTrigPlots(t, ham, mic, thr); }
  _patchPrefs({ time_cutoff_s: v });
  _callPyApplySettings();
  _clearTemplateName();
};

window.acqApplyMicCutoff = function(val) {
  const v = Math.max(0.01, parseFloat(val) || 0.30);
  const el = document.getElementById('inp-mic-cut-disp');
  if (el) el.value = v.toFixed(3);
  const pref = document.getElementById('inp-mic-time-cutoff');
  if (pref) pref.value = v;
  _micTimeCutoffS = v;
  if (_lastTrigData) { const { t, ham, mic, thr } = _lastTrigData; _drawTrigPlots(t, ham, mic, thr); }
  _patchPrefs({ mic_time_cutoff_s: v });
  _callPyApplySettings();
  _clearTemplateName();
};

function _updateSoundcardDisplay() {
  const el = document.getElementById('soundcard-ind');
  if (!el) return;
  const label = _loadPrefs().deviceLabel || '';
  el.textContent = label ? `Device: ${label}` : '';
}

window.acqRescaleHammer = function() {
  _hamYRange = null;
  if (_lastTrigData) {
    const { t, ham, mic, thr } = _lastTrigData;
    _drawTrigPlots(t, ham, mic, thr);
  }
};

window.acqRescaleMic = function() {
  _micYRange = null;
  if (_lastTrigData) {
    const { t, ham, mic, thr } = _lastTrigData;
    _drawTrigPlots(t, ham, mic, thr);
  }
};

window.acqDeleteLastHit = function() {
  if (window.pyDeleteLastHit) window.pyDeleteLastHit();
  if (_rawHandle && _lastSavedWav) {
    _rawHandle.removeEntry(_lastSavedWav).catch(() => {});
    _lastSavedWav = null;
  }
};

window.acqStartOver = async function() {
  if (!confirm('Are you sure you want to start over?\n\nThis will permanently delete all saved WAV and TRF files for this session from your Data Folder and clear all hit data. This cannot be undone.')) return;

  // Capture handles before _stopAudio resets them
  const rawDir = _rawHandle;
  const trfDir = _trfHandle;

  if (appState !== 'idle' && appState !== 'complete') await _stopAudio();

  // Delete all files in raw/ and TRF/ on disk
  const clearDir = async (dh) => {
    if (!dh) return;
    try {
      for await (const [name] of dh.entries())
        await dh.removeEntry(name, { recursive: true }).catch(() => {});
    } catch (_) {}
  };
  await clearDir(rawDir);
  await clearDir(trfDir);

  frfCache = {};
  tapCache = {};
  renderFRF();
  _clearTrigPlots();
  if (window.pyResetAll) window.pyResetAll();
  acqToggleAcquire();
};

window.acqClearPosition = function() {
  if (window.pyClearPosition) window.pyClearPosition();
};

function _updateStopBtn() {
  const btn = document.getElementById('acq-start-btn');
  if (!btn) return;
  if (appState === 'idle' || appState === 'complete') {
    btn.textContent = '▶ Start';
    btn.className   = 'tb-btn start';
  } else {
    btn.textContent = '■ Stop';
    btn.className   = 'tb-btn stop';
  }
}

function _updateEditBtns(s) {
  function sd(id, v) { const el = document.getElementById(id); if (el) el.disabled = v; }
  sd('delete-btn', !s || s.hit_n <= 0);
  sd('clear-btn',  !s || s.hit_n <= 0);
  const clrBtn = document.getElementById('clear-btn');
  if (clrBtn) clrBtn.textContent = s?.label ? `🗑 Clear ${s.label}` : '🗑 Clear';
}


window.acqPreferences = function() {
  document.getElementById('prefs-modal')?.classList.add('open');
  _populatePrefsForm();
};

window.acqHelp = function() { window.open('../../Docs/index.html', '_blank'); };
window.acqTips = function() { window.open('../../Docs/shortcuts.html', '_blank'); };


// ── Color palette ─────────────────────────────────────────────────────────────

function _acqLsLoadPalettes() {
  try { return JSON.parse(localStorage.getItem('obieAcquire_customPalettes') || '[]'); }
  catch(_) { return []; }
}
function _acqLsSavePalettes(list) {
  try { localStorage.setItem('obieAcquire_customPalettes', JSON.stringify(list)); } catch(_) {}
}

let _acqCpColors = [...PALETTES.default];

function _renderAcqPaletteBuilder() {
  const row = document.getElementById('acq-cp-swatches'); if (!row) return;
  row.innerHTML = _acqCpColors.map((c, i) =>
    `<input type="color" class="cp-color-inp" value="${c}" data-idx="${i}">`
  ).join('');
  row.querySelectorAll('.cp-color-inp').forEach(inp =>
    inp.addEventListener('input', e => { _acqCpColors[+e.target.dataset.idx] = e.target.value; })
  );
}

function _renderAcqColorModal() {
  const box = document.getElementById('acq-custom-palettes-list'); if (!box) return;
  const list = _acqLsLoadPalettes();
  if (!list.length) {
    box.innerHTML = `<p style="font-size:10px;color:var(--muted);margin:0">No saved custom palettes yet.</p>`;
    return;
  }
  box.innerHTML = `<div class="palette-grid">${
    list.map((p, i) => {
      const safeName = p.name.replace(/&/g,'&amp;').replace(/</g,'&lt;');
      return `<div style="position:relative">
        <button class="palette-btn" onclick="acqPickCustomPalette(${i})" style="width:100%;text-align:left">
          <div class="palette-name">${safeName}</div>
          <div class="palette-swatches">${p.colors.map(c=>`<div class="palette-sw" style="background:${c}"></div>`).join('')}</div>
        </button>
        <button class="cp-del-btn" onclick="acqDeleteCustomPalette(${i})" title="Delete"
                style="position:absolute;top:3px;right:3px">✕</button>
      </div>`;
    }).join('')
  }</div>`;
}

window.acqColors = function() {
  _acqCpColors = [..._palette];
  _renderAcqColorModal();
  _renderAcqPaletteBuilder();
  document.getElementById('acq-colors-modal')?.classList.add('open');
};

window.acqCloseColors = function() {
  document.getElementById('acq-colors-modal')?.classList.remove('open');
};

window.acqPickPalette = function(name) {
  _palette = [...(PALETTES[name] || PALETTES.default)];
  renderFRF();
  window.acqCloseColors();
};

window.acqPickCustomPalette = function(idx) {
  const list = _acqLsLoadPalettes();
  const p = list[idx]; if (!p) return;
  _palette = [...p.colors];
  renderFRF();
  window.acqCloseColors();
};

window.acqDeleteCustomPalette = function(idx) {
  const list = _acqLsLoadPalettes();
  list.splice(idx, 1);
  _acqLsSavePalettes(list);
  _renderAcqColorModal();
};

window.acqCustomPaletteAdd = function() {
  if (_acqCpColors.length >= 12) return;
  _acqCpColors.push('#888888');
  _renderAcqPaletteBuilder();
};

window.acqCustomPaletteRemove = function() {
  if (_acqCpColors.length <= 2) return;
  _acqCpColors.pop();
  _renderAcqPaletteBuilder();
};

window.acqApplyCustomPalette = function() {
  _palette = [..._acqCpColors];
  renderFRF();
  window.acqCloseColors();
};

window.acqSaveCustomPalette = function() {
  const name = (document.getElementById('acq-cp-name')?.value || '').trim();
  if (!name) { alert('Enter a name for this palette first.'); return; }
  const entry = { name, colors: [..._acqCpColors] };
  const list = _acqLsLoadPalettes();
  list.push(entry);
  _acqLsSavePalettes(list);
  _palette = [..._acqCpColors];
  renderFRF();
  _renderAcqColorModal();
  const inp = document.getElementById('acq-cp-name');
  if (inp) inp.value = '';
  window.acqCloseColors();
};


window.acqClosePrefs = function() {
  document.getElementById('prefs-modal')?.classList.remove('open');
};

window.acqLoadSettingsTxt = async function(input) {
  const file = input.files[0];
  if (!file) return;
  const text = await file.text();
  if (window.pyLoadSettingsTxt) {
    window.pyLoadSettingsTxt(text);
    const msg = document.getElementById('prefs-load-msg');
    if (msg) { msg.textContent = `Loaded: ${file.name}`; setTimeout(() => msg.textContent = '', 3000); }
  }
  // Copy Default Notes into the run notes if present in the file
  if (!window.pyParseLabviewTxt) {
    alert('Python is still loading — settings file loaded but notes could not be extracted. Try again in a moment.');
    input.value = ''; return;
  }
  try {
    const fields = JSON.parse(window.pyParseLabviewTxt(text));
    const notes  = (fields['Default Notes'] || '').trim();
    if (notes) {
      localStorage.setItem(_notesKey(), notes);
      const ta = document.getElementById('notes-textarea');
      if (ta) ta.value = notes;
    }
  } catch (e) {
    alert('Could not parse settings file: ' + e.message);
  }
  input.value = '';
};

function _populatePrefsForm(overridePrefs, skipPlotSync) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el && val != null) el.value = val;
  };
  const prefs = overridePrefs || _loadPrefs();
  // Sync _S.xMin/_S.xMax from the plot's actual displayed range so the form shows
  // the current zoom. Skipped when resetting to defaults (skipPlotSync=true).
  if (!skipPlotSync) {
    const acqDiv = document.getElementById('acq-plot');
    if (acqDiv?._fullLayout?.xaxis?.range?.length === 2) {
      const isLog = acqDiv._fullLayout.xaxis.type === 'log';
      const xr = acqDiv._fullLayout.xaxis.range;
      _S.xMin = isLog ? Math.pow(10, xr[0]) : xr[0];
      _S.xMax = isLog ? Math.pow(10, xr[1]) : xr[1];
    }
  }
  set('inp-threshold',   prefs.threshold);
  set('inp-thr-disp',    Number(prefs.threshold ?? 0.05).toFixed(3));
  set('inp-frf-x-min',   Math.round(_S.xMin ?? prefs.frf_x_min ?? 100));
  set('inp-frf-x-max',   Math.round(_S.xMax ?? prefs.frf_x_max ?? 12000));
  set('inp-pre',         prefs.pre_trig_s);
  set('inp-post',        prefs.post_trig_s);
  set('inp-time-cutoff',     prefs.time_cutoff_s);
  set('inp-mic-time-cutoff', prefs.mic_time_cutoff_s);
  set('inp-ham-cut-disp',    Number(prefs.time_cutoff_s     ?? 0.30).toFixed(3));
  set('inp-mic-cut-disp',    Number(prefs.mic_time_cutoff_s ?? 0.30).toFixed(3));
  set('inp-taps',        prefs.taps);
  set('inp-positions',   prefs.positions);
  set('inp-prefix',      prefs.prefix);
  set('inp-mic-cal',     prefs.mic_cal);
  set('inp-ham-cal',     prefs.ham_cal);
  const swapEl = document.getElementById('inp-swap-channels');
  if (swapEl) swapEl.checked = prefs.swap_channels ?? false;
  const instrVal = prefs.instrument || 'scratch';
  const instrDisp = document.getElementById('inp-instrument-banner');
  if (instrDisp) instrDisp.textContent = instrVal;
  set('inp-line-width',  prefs.line_width);
  // Read mini-plot ranges from Plotly's layout — ground truth after user zoom.
  const hamDiv = document.getElementById('plot-hammer');
  if (hamDiv?._fullLayout?.xaxis?.range?.length === 2)
    _hamXRange = [...hamDiv._fullLayout.xaxis.range];
  const micDiv = document.getElementById('plot-mic');
  if (micDiv?._fullLayout?.xaxis?.range?.length === 2)
    _micXRange = [...micDiv._fullLayout.xaxis.range];
  set('inp-ham-x-min',   _hamXRange[0]);
  set('inp-ham-x-max',   _hamXRange[1]);
  set('inp-ham-y-min',   _hamYRange ? _hamYRange[0] : (prefs.ham_y_min ?? -0.1));
  set('inp-ham-y-max',   _hamYRange ? _hamYRange[1] : (prefs.ham_y_max ?? 1));
  set('inp-mic-x-min',   _micXRange[0]);
  set('inp-mic-x-max',   _micXRange[1]);
  set('inp-mic-y-min',   _micYRange ? _micYRange[0] : (prefs.mic_y_min ?? -1));
  set('inp-mic-y-max',   _micYRange ? _micYRange[1] : (prefs.mic_y_max ?? 1));
  set('inp-fft-x-min',   _fftXRange[0]);
  set('inp-fft-x-max',   _fftXRange[1]);
  set('inp-fft-y-min',   _fftYRange[0]);
  set('inp-fft-y-max',   _fftYRange[1]);
  const frfYMinEl = document.getElementById('inp-frf-y-min');
  const frfYMaxEl = document.getElementById('inp-frf-y-max');
  if (frfYMinEl) frfYMinEl.value = (_S.yMin != null) ? _S.yMin : (prefs.frf_y_min != null ? prefs.frf_y_min : '');
  if (frfYMaxEl) frfYMaxEl.value = (_S.yMax != null) ? _S.yMax : (prefs.frf_y_max != null ? prefs.frf_y_max : '');
  set('inp-db-spread',   prefs.db_spread  ?? 38);
  set('inp-db-offset',   prefs.db_offset  ?? 0);
  set('inp-bit-depth',   prefs.bit_depth  ?? 24);
  set('inp-sample-rate', prefs.sample_rate ?? 48000);
  // populate device selector
  _enumeratePrefsDevices();
}

// Patch only the specified keys into the saved prefs — leaves everything else untouched.
function _patchPrefs(updates) {
  const p = { ..._loadPrefs(), ...updates };
  localStorage.setItem('obieAcquire_prefs', JSON.stringify(p));
  _saveAcqSettings();   // persist to acquire.json in Data Folder
  _updateInfoPanel();
}

// Push the current saved prefs to Python without touching any JS state variables.
function _callPyApplySettings() {
  if (!window.pyApplySettings) return;
  const p  = _loadPrefs();
  const sr = audioCtx?.sampleRate || 44100;
  window.pyApplySettings(
    p.threshold, p.pre_trig_s, p.post_trig_s,
    p.time_cutoff_s ?? p.post_trig_s ?? 0.30,
    p.taps, p.positions, p.prefix,
    p.mic_cal, p.ham_cal, sr,
    p.swap_channels ?? false,
    p.mic_time_cutoff_s ?? p.time_cutoff_s ?? p.post_trig_s ?? 0.30,
    p.deviceLabel || ''
  );
}

function _loadPrefs() {
  const defaults = {
    threshold: 0.05, pre_trig_s: 0.01, post_trig_s: 0.30,
    time_cutoff_s: 0.30, mic_time_cutoff_s: 0.30,
    taps: 5, positions: 12, prefix: 'H',
    mic_cal: 1.0, ham_cal: 1.0, swap_channels: false,
    frf_x_min: 200, frf_x_max: 7000, frf_y_min: -10, frf_y_max: 30,
    deviceLabel: '', instrument: 'scratch', deviceId: '', line_width: 0.5,
    ham_x_min: 0, ham_x_max: 0.05, ham_y_min: -0.1, ham_y_max: 1,
    mic_x_min: 0, mic_x_max: 0.3,  mic_y_min: -1,   mic_y_max: 1,
    fft_x_min: 200, fft_x_max: 10000, fft_y_min: -25, fft_y_max: 0,
    db_spread: 38, db_offset: 0, bit_depth: 24, sample_rate: 48000,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('obieAcquire_prefs') || '{}') };
  } catch (_) {
    return defaults;
  }
}

window.acqSavePrefs = function() {
  const g = id => document.getElementById(id)?.value ?? '';
  // Only read device fields from the select when the list has been populated
  // (options.length > 1 means real devices were enumerated, not just the placeholder).
  // If the select is unpopulated — e.g. when called from an inline control without
  // the prefs modal ever having been opened — preserve the previously saved values
  // so we never accidentally overwrite a valid deviceId with ''.
  const existing   = _loadPrefs();
  const deviceSel  = document.getElementById('prefs-device');
  const devReady   = deviceSel && deviceSel.options.length > 1;
  const deviceId   = devReady ? g('prefs-device') : existing.deviceId;
  const deviceLabel = devReady
    ? (deviceSel.value ? (deviceSel.selectedOptions[0]?.text || '') : '')
    : existing.deviceLabel;
  // If the Settings modal form has valid x-range values, adopt them into the in-memory
  // state — this is the path when the user types a new value directly in the modal.
  // Using _hamXRange/_micXRange as the authoritative source prevents stale form values
  // from reverting a user's interactive plot zoom.
  const formHamMin = parseFloat(g('inp-ham-x-min'));
  const formHamMax = parseFloat(g('inp-ham-x-max'));
  if (!isNaN(formHamMin) && !isNaN(formHamMax) && formHamMax > 0.001) {
    if (formHamMin < 0 || formHamMin >= formHamMax) {
      alert('Hammer time range is invalid: Min must be ≥ 0 and less than Max.'); return;
    }
    _hamXRange = [formHamMin, formHamMax];
  }
  const formMicMin = parseFloat(g('inp-mic-x-min'));
  const formMicMax = parseFloat(g('inp-mic-x-max'));
  if (!isNaN(formMicMin) && !isNaN(formMicMax) && formMicMax > 0.001) {
    if (formMicMin < 0 || formMicMin >= formMicMax) {
      alert('Mic time range is invalid: Min must be ≥ 0 and less than Max.'); return;
    }
    _micXRange = [formMicMin, formMicMax];
  }
  const formFrfMin = parseFloat(g('inp-frf-x-min'));
  const formFrfMax = parseFloat(g('inp-frf-x-max'));
  if (!isNaN(formFrfMin) && !isNaN(formFrfMax)) {
    if (formFrfMin <= 0 || formFrfMin >= formFrfMax) {
      alert('FRF frequency range is invalid: Min must be > 0 and less than Max.'); return;
    }
  }
  if (!isNaN(formFrfMin) && formFrfMin > 0) _S.xMin = formFrfMin;
  if (!isNaN(formFrfMax) && formFrfMax > 0) _S.xMax = formFrfMax;
  const formHamYMin = parseFloat(g('inp-ham-y-min')), formHamYMax = parseFloat(g('inp-ham-y-max'));
  if (!isNaN(formHamYMin) && !isNaN(formHamYMax)) _hamYRange = [formHamYMin, formHamYMax];
  const formMicYMin = parseFloat(g('inp-mic-y-min')), formMicYMax = parseFloat(g('inp-mic-y-max'));
  if (!isNaN(formMicYMin) && !isNaN(formMicYMax)) _micYRange = [formMicYMin, formMicYMax];
  const formFftXMin = parseFloat(g('inp-fft-x-min')), formFftXMax = parseFloat(g('inp-fft-x-max'));
  if (!isNaN(formFftXMin) && !isNaN(formFftXMax) && formFftXMin > 0 && formFftXMax > formFftXMin)
    _fftXRange = [formFftXMin, formFftXMax];
  const formFftYMin = parseFloat(g('inp-fft-y-min')), formFftYMax = parseFloat(g('inp-fft-y-max'));
  if (!isNaN(formFftYMin) && !isNaN(formFftYMax)) _fftYRange = [formFftYMin, formFftYMax];
  const formFrfYMin = parseFloat(g('inp-frf-y-min')), formFrfYMax = parseFloat(g('inp-frf-y-max'));
  if (!isNaN(formFrfYMin) && !isNaN(formFrfYMax)) { _S.yMin = formFrfYMin; _S.yMax = formFrfYMax; }
  const micCal = parseFloat(g('inp-mic-cal'));
  const hamCal = parseFloat(g('inp-ham-cal'));
  if (!isFinite(micCal) || micCal === 0) { alert('Mic calibration must be a non-zero number.'); return; }
  if (!isFinite(hamCal) || hamCal === 0) { alert('Hammer calibration must be a non-zero number.'); return; }
  const prefs = {
    threshold:     parseFloat(g('inp-threshold'))   || 0.05,
    frf_x_min:     Math.round(_S.xMin ?? 100),
    frf_x_max:     Math.round(_S.xMax ?? 12000),
    pre_trig_s:    parseFloat(g('inp-pre'))         || 0.01,
    post_trig_s:   parseFloat(g('inp-post'))        || 0.30,
    time_cutoff_s:     parseFloat(g('inp-time-cutoff'))     || 0.30,
    mic_time_cutoff_s: parseFloat(g('inp-mic-time-cutoff')) || 0.30,
    taps:          parseInt(g('inp-taps'))          || 5,
    positions:     parseInt(g('inp-positions'))     || 12,
    prefix:        g('inp-prefix')                  || 'H',
    mic_cal:       micCal,
    ham_cal:       hamCal,
    swap_channels: document.getElementById('inp-swap-channels')?.checked ?? false,
    deviceLabel,
    instrument:    (document.getElementById('inp-instrument-banner')?.textContent || '').trim() || 'scratch',
    deviceId,
    line_width:    parseFloat(g('inp-line-width'))  || 0.5,
    ham_x_min:     _hamXRange[0],
    ham_x_max:     _hamXRange[1],
    ham_y_min:     _hamYRange ? _hamYRange[0] : parseFloat(g('inp-ham-y-min')) ?? -0.1,
    ham_y_max:     _hamYRange ? _hamYRange[1] : parseFloat(g('inp-ham-y-max')) ?? 1,
    mic_x_min:     _micXRange[0],
    mic_x_max:     _micXRange[1],
    mic_y_min:     _micYRange ? _micYRange[0] : parseFloat(g('inp-mic-y-min')) ?? -1,
    mic_y_max:     _micYRange ? _micYRange[1] : parseFloat(g('inp-mic-y-max')) ?? 1,
    fft_x_min:     _fftXRange[0],
    fft_x_max:     _fftXRange[1],
    fft_y_min:     _fftYRange[0],
    fft_y_max:     _fftYRange[1],
    frf_y_min:     (() => { const v = parseFloat(g('inp-frf-y-min')); return isNaN(v) ? null : v; })(),
    frf_y_max:     (() => { const v = parseFloat(g('inp-frf-y-max')); return isNaN(v) ? null : v; })(),
    db_spread:     parseFloat(g('inp-db-spread'))   || 38,
    db_offset:     parseFloat(g('inp-db-offset'))   || 0,
    bit_depth:     parseInt(g('inp-bit-depth'))     || 24,
    sample_rate:   parseInt(g('inp-sample-rate'))   || 48000,
  };
  const deviceChanged = devReady && deviceId !== existing.deviceId;
  localStorage.setItem('obieAcquire_prefs', JSON.stringify(prefs));
  _saveAcqSettings();
  _pushSettingsFromPrefs(prefs);
  _updateSoundcardDisplay();
  _clearTemplateName();
  acqClosePrefs();
  // If the audio device changed while the stream was open, restart it immediately.
  if (deviceChanged && audioCtx) {
    _stopAudio().then(() => _startAudio());
  }
};

function _resetAxisRanges(prefs) {
  const p = prefs || {};
  _S.xMin     = p.frf_x_min  ?? 200;   _S.xMax     = p.frf_x_max  ?? 7000;
  _S.yMin     = p.frf_y_min  ?? -10;   _S.yMax     = p.frf_y_max  ?? 30;
  _hamXRange  = [p.ham_x_min ?? 0,    p.ham_x_max ?? 0.05];
  _hamYRange  = [p.ham_y_min ?? -0.1, p.ham_y_max ?? 1];
  _micXRange  = [p.mic_x_min ?? 0,    p.mic_x_max ?? 0.3];
  _micYRange  = [p.mic_y_min ?? -1,   p.mic_y_max ?? 1];
  _fftXRange  = [p.fft_x_min ?? 200,  p.fft_x_max ?? 10000];
  _fftYRange  = [p.fft_y_min ?? -25,  p.fft_y_max ?? 0];
}

window.acqResetPrefs = async function() {
  const st = document.getElementById('prefs-save-msg');
  if (_settingsHandle) {
    try {
      const file  = await (await _settingsHandle.getFileHandle('acquire.json')).getFile();
      const prefs = JSON.parse(await file.text());
      localStorage.setItem('obieAcquire_prefs', JSON.stringify(prefs));
      _resetAxisRanges(prefs);
      _populatePrefsForm(prefs, true);
      _pushSettingsFromPrefs(prefs);
      if (st) { st.textContent = '✓ Restored from disk'; setTimeout(() => st.textContent = '', 2500); }
      return;
    } catch (_) {}
  }
  localStorage.removeItem('obieAcquire_prefs');
  _resetAxisRanges(null);
  _populatePrefsForm(null, true);
  _pushSettingsFromPrefs(_loadPrefs());
  if (st) { st.textContent = '✓ Reset to defaults'; setTimeout(() => st.textContent = '', 2500); }
};

function _pushSettingsFromPrefs(prefs) {
  _hamTimeCutoffS  = prefs.time_cutoff_s     ?? prefs.post_trig_s ?? 0.30;
  _micTimeCutoffS  = prefs.mic_time_cutoff_s ?? prefs.time_cutoff_s ?? prefs.post_trig_s ?? 0.30;
  _preTrigS        = prefs.pre_trig_s        ?? 0.01;
  _lineWidth       = prefs.line_width        ?? 0.5;
  _S.xMin          = prefs.frf_x_min        ?? 200;
  _S.xMax          = prefs.frf_x_max        ?? 7000;
  _S.yMin          = prefs.frf_y_min        ?? -10;
  _S.yMax          = prefs.frf_y_max        ?? 30;
  _hamXRange       = [prefs.ham_x_min ?? 0,    prefs.ham_x_max ?? 0.05];
  _hamYRange       = [prefs.ham_y_min ?? -0.1, prefs.ham_y_max ?? 1];
  _micXRange       = [prefs.mic_x_min ?? 0,    prefs.mic_x_max ?? 0.3];
  _micYRange       = [prefs.mic_y_min ?? -1,   prefs.mic_y_max ?? 1];
  _fftXRange       = [prefs.fft_x_min ?? 200,  prefs.fft_x_max ?? 10000];
  _fftYRange       = [prefs.fft_y_min ?? -25,  prefs.fft_y_max ?? 0];
  _S.yDbRange      = prefs.db_spread         ?? 38;
  _S.dbOffset      = prefs.db_offset         ?? 0;
  const yDbEl = document.getElementById('y-db-range');
  if (yDbEl) yDbEl.value = _S.yDbRange;
  renderFRF();
  if (!window.pyApplySettings) return;
  _appliedPrefix   = (prefs.prefix || 'H').trim();
  _appliedPerGroup = Math.max(1, parseInt(prefs.positions) || 12);
  const sr = audioCtx?.sampleRate || 44100;
  window.pyApplySettings(
    prefs.threshold, prefs.pre_trig_s, prefs.post_trig_s,
    prefs.time_cutoff_s ?? prefs.post_trig_s ?? 0.30,
    prefs.taps, prefs.positions, prefs.prefix,
    prefs.mic_cal, prefs.ham_cal, sr,
    prefs.swap_channels ?? false,
    prefs.mic_time_cutoff_s ?? prefs.time_cutoff_s ?? prefs.post_trig_s ?? 0.30
  );
  // Redraw green lines immediately if a hit is already displayed
  if (_lastTrigData) {
    const { t, ham, mic, thr } = _lastTrigData;
    _drawTrigPlots(t, ham, mic, thr);
  }
  _updateInfoPanel();
}

function _updateInfoPanel() {
  const el = document.getElementById('info-items');
  if (!el) return;
  const p = _loadPrefs();
  const rows = [
    ['Device',     p.deviceLabel || '—'],
    ['Sample rate', `${p.sample_rate ?? 48000} Hz`],
    ['Bit depth',  `${p.bit_depth ?? 24} bit`],
    ['Ham trigger', p.threshold],
    ['Hits/pos',   p.taps],
    ['Prefix',     _appliedPrefix || 'H'],
    ['Positions',  (function(){ const g = _appliedPrefix.split(',').filter(s=>s.trim()).length; return g > 1 ? `${_appliedPerGroup} × ${g} = ${_appliedPerGroup * g}` : _appliedPerGroup; })()],
    ['Ham cal',    `${p.ham_cal} N/V`],
    ['Mic cal',    `${p.mic_cal} Pa/V`],
    ['Pre-trig',   `${p.pre_trig_s} s`],
    ['Post-trig',  `${p.post_trig_s} s`],
    ['Ham cutoff', `${p.time_cutoff_s} s`],
    ['Mic cutoff', `${p.mic_time_cutoff_s} s`],
    ['Swap ch',    p.swap_channels ? 'Yes' : 'No'],
  ];
  el.innerHTML = rows.map(([k, v]) =>
    `<div class="info-row"><span class="info-lbl">${k}</span><span class="info-val">${v}</span></div>`
  ).join('');
}

async function _enumeratePrefsDevices() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const sel = document.getElementById('prefs-device');
    if (!sel) return;
    const saved = _loadPrefs().deviceId;
    sel.innerHTML = '<option value="">Default device</option>';
    let savedFound = false;
    { const o = document.createElement('option');
      o.value = '__simulated__';
      o.textContent = '⚡ Simulated Input';
      if (saved === '__simulated__') { o.selected = true; savedFound = true; }
      sel.appendChild(o); }
    // Filter Windows virtual entries (default / communications) — same physical
    // device appears three times on Windows; keep only the real hardware ID.
    const SKIP = new Set(['default', 'communications']);
    devices.filter(d => d.kind === 'audioinput' && !SKIP.has(d.deviceId)).forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Mic (${d.deviceId.slice(0, 8)}…)`;
      if (d.deviceId === saved) { o.selected = true; savedFound = true; }
      sel.appendChild(o);
    });
    // Saved device is no longer available — clear the stale label so the blue
    // indicator doesn't show a hardware ID instead of "Default device".
    if (saved && !savedFound) {
      _patchPrefs({ deviceId: '', deviceLabel: '' });
      _updateSoundcardDisplay();
    }
  } catch (_) {}
}


// ════════════════════════════════════════════════════════════════════════════
// Notes modal
// ════════════════════════════════════════════════════════════════════════════

function _notesKey() { return 'obieAcquire_notes_' + (_pendingTestName || _runName || 'default'); }

window.acqNotes = function() {
  document.getElementById('notes-modal')?.classList.add('open');
  const ta = document.getElementById('notes-textarea');
  if (ta) ta.value = localStorage.getItem(_notesKey()) || '';
};

window.acqCloseNotes = function() {
  document.getElementById('notes-modal')?.classList.remove('open');
};

window.acqSaveNotes = function() {
  const val = document.getElementById('notes-textarea')?.value || '';
  localStorage.setItem(_notesKey(), val);
  acqCloseNotes();
};


// ════════════════════════════════════════════════════════════════════════════
// Template modal
// ════════════════════════════════════════════════════════════════════════════

window.acqTemplate = async function() {
  document.getElementById('template-modal')?.classList.add('open');
  _selectedTpl = null;
  const pre = document.getElementById('tpl-json');
  const lbl = document.getElementById('tpl-json-lbl');
  if (pre) pre.textContent = '';
  if (lbl) lbl.textContent = 'Select a template above to preview its settings';
  // Reload from disk every time the modal opens so newly saved files appear immediately
  _templates = [];
  if (_templatesHandle) await _loadTemplatesFromFolder(_templatesHandle);
  else _renderTemplateList();
};

window.acqCloseTemplate = function() {
  document.getElementById('template-modal')?.classList.remove('open');
};

let _templates = [];
let _selectedTpl = null;

function _tplMeta(s) {
  const bits = [];
  if (s.positions  != null) bits.push(`${s.positions} pos`);
  if (s.taps       != null) bits.push(`${s.taps} hits`);
  if (s.frf_x_max  != null) bits.push(`≤${s.frf_x_max} Hz`);
  if (s.threshold  != null) bits.push(`thr ${s.threshold}`);
  if (s.ham_cal    != null && s.ham_cal !== 1) bits.push(`ham×${s.ham_cal}`);
  if (s.mic_cal    != null && s.mic_cal !== 1) bits.push(`mic×${s.mic_cal}`);
  return bits.join(' · ');
}

// JS port of Python/fileio/labview_txt.py — parse LabVIEW Key=<value/> format

function _lvFieldsToSettings(fields) {
  return {
    positions:         parseInt(fields['Positions']          ?? '12'),
    taps:              parseInt(fields['Taps/Position']      ?? '5'),
    threshold:         parseFloat(fields['Hammer Threshold'] ?? '0.05'),
    pre_trig_s:        parseFloat(fields['Pre-trigger (s)']  ?? '0.01'),
    post_trig_s:       parseFloat(fields['Sample time (s)']  ?? '0.30'),
    time_cutoff_s:     parseFloat(fields['Hammer cutoff']    ?? '0.30'),
    mic_time_cutoff_s: parseFloat(fields['Mic cutoff']       ?? '0.30'),
    ham_cal:           parseFloat(fields['Hammer Cal']       ?? '1'),
    mic_cal:           parseFloat(fields['Mic Cal']          ?? '1'),
    prefix:            (fields['Set Names'] || 'H').split(',')[0].trim(),
    soundcard:         (fields['Soundcard'] || '').trim(),
    swap_channels:     (fields['flip?'] || '').trim().toLowerCase() === 'true',
  };
}

function _renderTemplateList() {
  const container = document.getElementById('tpl-list');
  if (!container) return;

  // Synthetic "Current Settings" entry always at the top
  const curSel = _selectedTpl === -1;
  const currentItem = `
    <div class="tpl-item${curSel ? ' selected' : ''}" onclick="acqSelectTpl(-1)"
         style="border-color:#1565c0;${curSel ? 'background:#e8f0fe;' : ''}">
      <div class="tpl-name" style="color:#1565c0">Current Settings</div>
      <div class="tpl-desc">${_tplMeta(_loadPrefs())}</div>
    </div>`;

  const list = _templates.length
    ? _templates.map((t, i) => {
        const s = t.settings || t.run || t;
        const meta = _tplMeta(s);
        return `
          <div class="tpl-item${_selectedTpl === i ? ' selected' : ''}" style="display:flex;align-items:center;gap:6px" onclick="acqSelectTpl(${i})">
            <div style="flex:1;min-width:0">
              <div class="tpl-name">${t.name || 'Unnamed'}</div>
              ${meta ? `<div class="tpl-desc">${meta}</div>` : ''}
            </div>
            <button class="tpl-del-btn" title="Delete template" onclick="acqDeleteTpl(${i},event)">🗑</button>
          </div>`;
      }).join('')
    : '<div style="font-size:11px;color:var(--muted);padding:4px 0">No saved templates — set a Data Folder to load from <code>ObieAppSettings/Templates/</code>, or use Browse.</div>';

  container.innerHTML = currentItem + list;
}

window.acqDeleteTpl = async function(i, event) {
  event.stopPropagation();  // don't select the row
  const t = _templates[i];
  if (!t) return;
  if (!confirm(`Delete template "${t.name}"?`)) return;
  if (_templatesHandle && t._file) {
    try {
      await _templatesHandle.removeEntry(t._file);
    } catch (e) {
      alert('Could not delete file: ' + e.message);
      return;
    }
  }
  _templates.splice(i, 1);
  if (_selectedTpl === i)       _selectedTpl = null;
  else if (_selectedTpl > i)    _selectedTpl--;
  _renderTemplateList();
};

window.acqSelectTpl = function(i) {
  _selectedTpl = i;
  _renderTemplateList();
  const pre = document.getElementById('tpl-json');
  const lbl = document.getElementById('tpl-json-lbl');
  if (!pre) return;

  if (i === -1) {
    // Current Settings
    const p = { ..._loadPrefs() };
    delete p.deviceLabel; delete p.deviceId;
    pre.textContent = JSON.stringify(p, null, 2);
    if (lbl) lbl.textContent = 'Current Settings (device excluded):';
  } else if (_templates[i]) {
    const t = _templates[i];
    const s = { ...(t.settings || t.run || t) };
    delete s.deviceLabel; delete s.deviceId;
    const display = { name: t.name || 'Unnamed' };
    if (t.description) display.description = t.description;
    display.settings = s;
    pre.textContent = JSON.stringify(display, null, 2);
    if (lbl) lbl.textContent = `${t.name || 'Template'} — settings (device excluded):`;
  } else {
    pre.textContent = '';
    if (lbl) lbl.textContent = 'Select a template above to preview its settings';
  }
};

window.acqBrowseTemplate = async function() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.txt,.json';
  input.onchange = async () => {
    const file = input.files[0]; if (!file) return;
    try {
      const text = await file.text();
      let tpl;
      if (file.name.toLowerCase().endsWith('.txt')) {
        const fields   = JSON.parse(window.pyParseLabviewTxt(text));
        const tplName  = file.name.replace(/_template\.txt$/i, '').replace(/_/g, ' ').trim();
        const tplNotes = (fields['Default Notes'] || '').trim();
        tpl = { name: tplName, settings: _lvFieldsToSettings(fields),
                ...(tplNotes ? { notes: tplNotes } : {}) };
      } else {
        const data = JSON.parse(text);
        tpl = Array.isArray(data) ? data[0] : data;
      }
      _templates = [tpl];
      _selectedTpl = 0;
      _renderTemplateList();
    } catch (e) {
      alert('Could not load template: ' + e.message);
    }
  };
  input.click();
};

window.acqApplyTemplate = function() {
  if (_selectedTpl === null) { alert('Select a template first.'); return; }
  if (_selectedTpl === -1) { window.acqCloseTemplate(); return; }  // Current Settings = no-op
  if (!_templates[_selectedTpl]) { alert('Select a template first.'); return; }
  const t = _templates[_selectedTpl];
  const s = t.settings || t.run || t;
  // Apply to prefs form
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el && val != null) el.value = val;
  };
  if (s.threshold   != null) set('inp-threshold',  s.threshold);
  if (s.frf_x_min   != null) set('inp-frf-x-min',  s.frf_x_min);
  if (s.frf_x_max   != null) set('inp-frf-x-max',  s.frf_x_max);
  if (s.pre_trig_s  != null) set('inp-pre',        s.pre_trig_s);
  if (s.post_trig_s != null) set('inp-post',       s.post_trig_s);
  if (s.taps        != null) set('inp-taps',       s.taps);
  if (s.positions   != null) set('inp-positions',  s.positions);
  if (s.prefix      != null) set('inp-prefix',     s.prefix);
  if (s.mic_cal     != null) set('inp-mic-cal',    s.mic_cal);
  if (s.ham_cal     != null) set('inp-ham-cal',    s.ham_cal);
  if (s.frf_x_min   != null) set('inp-frf-x-min',  s.frf_x_min);
  if (s.frf_x_max   != null) set('inp-frf-x-max',  s.frf_x_max);
  if (s.line_width  != null) set('inp-line-width',  s.line_width);
  if (s.ham_x_min   != null) set('inp-ham-x-min',   s.ham_x_min);
  if (s.ham_x_max   != null) set('inp-ham-x-max',   s.ham_x_max);
  if (s.ham_y_min   != null) set('inp-ham-y-min',   s.ham_y_min);
  if (s.ham_y_max   != null) set('inp-ham-y-max',   s.ham_y_max);
  if (s.mic_x_min   != null) set('inp-mic-x-min',   s.mic_x_min);
  if (s.mic_x_max   != null) set('inp-mic-x-max',   s.mic_x_max);
  if (s.mic_y_min   != null) set('inp-mic-y-min',   s.mic_y_min);
  if (s.mic_y_max   != null) set('inp-mic-y-max',   s.mic_y_max);
  if (s.fft_x_min   != null) set('inp-fft-x-min',   s.fft_x_min);
  if (s.fft_x_max   != null) set('inp-fft-x-max',   s.fft_x_max);
  if (s.fft_y_min   != null) set('inp-fft-y-min',   s.fft_y_min);
  if (s.fft_y_max   != null) set('inp-fft-y-max',   s.fft_y_max);
  if (s.frf_x_min   != null) set('inp-frf-x-min',   s.frf_x_min);
  if (s.frf_x_max   != null) set('inp-frf-x-max',   s.frf_x_max);
  const frfYMinEl = document.getElementById('inp-frf-y-min');
  const frfYMaxEl = document.getElementById('inp-frf-y-max');
  if (frfYMinEl) frfYMinEl.value = s.frf_y_min != null ? s.frf_y_min : '';
  if (frfYMaxEl) frfYMaxEl.value = s.frf_y_max != null ? s.frf_y_max : '';
  if (s.db_spread   != null) set('inp-db-spread',   s.db_spread);
  if (s.db_offset   != null) set('inp-db-offset',   s.db_offset);
  if (s.bit_depth   != null) set('inp-bit-depth',   s.bit_depth);
  if (s.sample_rate != null) set('inp-sample-rate', s.sample_rate);
  // device selection intentionally skipped — keep the current device on import
  _currentTemplateName = t.name || '';
  const tplInd = document.getElementById('tpl-ind');
  if (tplInd) tplInd.textContent = _currentTemplateName;
  window.acqSavePrefs();
  // Copy template's default notes into the run notes, if present
  if (t.notes) {
    localStorage.setItem(_notesKey(), t.notes);
    const ta = document.getElementById('notes-textarea');
    if (ta) ta.value = t.notes;
  }
  window.acqCloseTemplate();
  frfCache = {}; tapCache = {};
  renderFRF(); _clearTrigPlots();
  window.pyResetAll?.();
  _refreshOverlays();
  document.getElementById('prefs-modal')?.classList.add('open');
};

window.acqSaveAsTemplate = async function() {
  if (!_templatesHandle) {
    alert('Set a Data Folder first — templates are saved to ObieAppSettings/Templates/ inside it.');
    return;
  }
  const name = prompt('Template name:');
  if (!name?.trim()) return;
  const prefs = _loadPrefs();
  const currentNotes = (document.getElementById('notes-textarea')?.value ||
                        localStorage.getItem(_notesKey()) || '').trim();
  const tpl = {
    name:        name.trim(),
    description: `${prefs.instrument || ''}  ${new Date().toISOString().slice(0, 10)}`.trim(),
    settings:    prefs,
    ...(currentNotes ? { notes: currentNotes } : {}),
  };
  const safeName = name.trim().replace(/[\\/:*?"<>|]/g, '_') + '.json';
  try {
    const fh = await _templatesHandle.getFileHandle(safeName, { create: true });
    const w  = await fh.createWritable();
    await w.write(JSON.stringify(tpl, null, 2));
    await w.close();
    _templates.push(tpl);
    _renderTemplateList();
  } catch (e) { alert('Failed to save template: ' + e.message); }
};

// Build a LabVIEW Key=<value/> string from current settings
function _buildLVTxt() {
  const p = _loadPrefs();
  const notes = (document.getElementById('notes-textarea')?.value ||
                 localStorage.getItem(_notesKey()) || '').trim();
  const instrName = (document.getElementById('inp-instrument-banner')?.textContent || '').trim();
  const runName   = _runName || _pendingTestName || '';
  const testName  = instrName ? `${instrName}--${runName}` : runName;
  const fields = {
    'Name of test':     testName,
    'Date':             new Date().toISOString().slice(0, 10),
    'Template':         _currentTemplateName || '',
    'Soundcard':        p.deviceLabel || '',
    'resolution':       p.bit_depth    ?? 24,
    'Sampling rate':    p.sample_rate  ?? 48000,
    'Sample time (s)':  p.post_trig_s  ?? 0.30,
    'Pre-trigger (s)':  p.pre_trig_s   ?? 0.01,
    'Hammer Threshold': p.threshold    ?? 0.05,
    'Positions':        p.positions    ?? 12,
    'Taps/Position':    p.taps         ?? 5,
    'Set Names':        p.prefix       ?? 'H',
    'Hammer cutoff':    p.time_cutoff_s     ?? 0.30,
    'Mic cutoff':       p.mic_time_cutoff_s ?? 0.30,
    'Hammer Cal':       p.ham_cal      ?? 1.0,
    'Mic Cal':          p.mic_cal      ?? 1.0,
    'dB Offset':        p.db_offset    ?? 0,
    'dB Spread':        p.db_spread    ?? 38,
    'flip?':            p.swap_channels ? 'true' : 'false',
    'Default Notes':    notes,
  };
  return Object.entries(fields).map(([k, v]) => {
    const s = String(v);
    return s.includes('\n') ? `${k}=<${s}\n/>` : `${k}=<${s}/>`;
  }).join('\n') + '\n';
}

window.acqExportLVTemplate = async function() {
  const txt  = _buildLVTxt();
  const instr = (document.getElementById('inp-instrument-banner')?.textContent || '').trim() || 'template';
  const defaultName = (instr + '_template.txt').replace(/[\\/:*?"<>|]/g, '_');
  try {
    if (window.showSaveFilePicker) {
      const fh = await window.showSaveFilePicker({
        suggestedName: defaultName,
        types: [{ description: 'LabVIEW Template (.txt)', accept: { 'text/plain': ['.txt'] } }],
      });
      const w = await fh.createWritable();
      await w.write(txt);
      await w.close();
    } else {
      // Fallback for browsers without save picker
      const blob = new Blob([txt], { type: 'text/plain' });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), { href: url, download: defaultName });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    if (e.name !== 'AbortError') alert('Could not export: ' + e.message);
  }
};

// ════════════════════════════════════════════════════════════════════════════
// Data folder management (File System Access API)
// ════════════════════════════════════════════════════════════════════════════

const HAS_FS = typeof window.showDirectoryPicker === 'function';
let _rawHandle       = null;
let _trfHandle       = null;
let _testHandle      = null;   // current test folder (root of raw/ and TRF/)
let _runName         = '';
let _settingsHandle  = null;   // ObieAppSettings/ dir inside the data folder
let _templatesHandle = null;   // ObieAppSettings/Templates/ dir
let _testsHandle     = null;   // <instrument>/test/ dir (set when data folder chosen)
let _rootDirHandle   = null;   // root data folder handle
let _folderGoneShown = false;  // debounce — only show the gone-folder UI once per event
let _pendingTestName = '';  // proposed test folder name, editable before first Start
let _currentTemplateName = '';  // template last applied

window.acqRenameTest = async function() {
  if (!_rootDirHandle) { alert('Set a Data Folder first.'); return; }
  const instrument = (document.getElementById('inp-instrument-banner')?.textContent || '').trim() || 'scratch';
  if (instrument === 'scratch') { alert('Please name your instrument first — click the 🎻 Instrument button in the toolbar.'); return; }
  const current = _runName || _pendingTestName || '';
  const newName = prompt('Rename this test:', current);
  if (!newName || !newName.trim() || newName.trim() === current) return;
  const name = newName.trim();
  try {
    const instrHandle = _testsHandle || await _rootDirHandle.getDirectoryHandle(instrument);

    // Reject if target name already exists
    try { await instrHandle.getDirectoryHandle(name); alert(`A test named "${name}" already exists.`); return; } catch (_) {}

    // Find the old folder (may not exist yet if user renames before first Start)
    let oldHandle = null;
    if (current) { try { oldHandle = await instrHandle.getDirectoryHandle(current); } catch (_) {} }

    if (oldHandle) {
      // Copy all files (top-level + one level of subdirectories) to new folder, then delete old
      const newHandle = await instrHandle.getDirectoryHandle(name, { create: true });
      for await (const [entryName, entry] of oldHandle.entries()) {
        if (entry.kind === 'file') {
          const buf = await (await entry.getFile()).arrayBuffer();
          const fw = await (await newHandle.getFileHandle(entryName, { create: true })).createWritable();
          await fw.write(buf); await fw.close();
        } else if (entry.kind === 'directory') {
          const newSub = await newHandle.getDirectoryHandle(entryName, { create: true });
          for await (const [subName, subEntry] of entry.entries()) {
            if (subEntry.kind === 'file') {
              const buf = await (await subEntry.getFile()).arrayBuffer();
              const fw = await (await newSub.getFileHandle(subName, { create: true })).createWritable();
              await fw.write(buf); await fw.close();
            }
          }
        }
      }
      _testHandle = newHandle;
      _rawHandle  = await newHandle.getDirectoryHandle('raw', { create: true });
      _trfHandle  = await newHandle.getDirectoryHandle('TRF', { create: true });
      try { await instrHandle.removeEntry(current, { recursive: true }); } catch (_) {}
    } else {
      // No existing folder yet — just create the new one
      const newHandle = await instrHandle.getDirectoryHandle(name, { create: true });
      _testHandle = newHandle;
      _rawHandle  = await newHandle.getDirectoryHandle('raw', { create: true });
      _trfHandle  = await newHandle.getDirectoryHandle('TRF', { create: true });
    }

    _runName = name;
    _pendingTestName = name;
    const testDisp = document.getElementById('inp-test-banner');
    if (testDisp) testDisp.textContent = name;
    const ind = document.getElementById('folder-name-ind');
    if (ind) ind.textContent = name;
    _setSaveStatus(true, name);
  } catch (e) {
    alert('Could not rename: ' + e.message);
  }
};

window.acqSetInstrument = function() {
  if (!_rootDirHandle) { alert('Set a Data Folder first.'); return; }
  const current = (document.getElementById('inp-instrument-banner')?.textContent || '').trim();
  const inp = document.getElementById('instrument-inp');
  if (inp) { inp.value = current === '—' ? '' : current; }
  document.getElementById('instrument-modal')?.classList.add('open');
  requestAnimationFrame(() => document.getElementById('instrument-inp')?.focus());
};

window.acqCloseInstrument = function() {
  document.getElementById('instrument-modal')?.classList.remove('open');
};

window.acqConfirmInstrument = async function() {
  const inp  = document.getElementById('instrument-inp');
  const name = inp?.value.trim();
  if (!name) return;
  const prev = (document.getElementById('inp-instrument-banner')?.textContent || '').trim();
  const msg = document.getElementById('instrument-modal-msg');
  if (msg) msg.textContent = 'Setting up…';
  await _refreshInstrumentFolder(name);
  if (msg) msg.textContent = '';
  document.getElementById('instrument-modal')?.classList.remove('open');
  _refreshOverlays();
  if (name !== prev && prev !== '—') {
    frfCache = {}; tapCache = {};
    renderFRF(); _clearTrigPlots();
    window.pyResetAll?.();
  }
};

async function _refreshInstrumentFolder(instrumentName) {
  if (!_rootDirHandle || !instrumentName || instrumentName === 'scratch') return;
  try {
    const instrHandle = await _rootDirHandle.getDirectoryHandle(instrumentName, { create: true });
    _testsHandle = instrHandle;

    // Find the highest existing run number to auto-name the next one.
    let maxNum = 0, maxNumName = null;
    try {
      for await (const [name, h] of instrHandle.entries()) {
        if (h.kind === 'directory') {
          const m = name.match(/_(\d+)$/);
          if (m) { const n = parseInt(m[1]); if (n > maxNum) { maxNum = n; maxNumName = name; } }
        }
      }
    } catch (_) {}

    // Check whether the highest-numbered folder contains any real measurement data
    // (files inside raw/ or TRF/). If it's empty we reuse it; otherwise increment.
    let lastFolderHasData = false;
    if (maxNum > 0 && maxNumName) {
      try {
        const lastH = await instrHandle.getDirectoryHandle(maxNumName);
        for (const subdir of ['raw', 'TRF']) {
          try {
            const sdH = await lastH.getDirectoryHandle(subdir);
            for await (const _ of sdH.entries()) { lastFolderHasData = true; break; }
          } catch (_) {}
          if (lastFolderHasData) break;
        }
      } catch (_) {}
    }

    _pendingTestName = (maxNum > 0 && maxNumName && !lastFolderHasData)
      ? maxNumName
      : `${instrumentName}_${String(maxNum + 1).padStart(2, '0')}`;

    // Create (or reopen) the test subfolder so Start never has to.
    const testHandle = await instrHandle.getDirectoryHandle(_pendingTestName, { create: true });
    _testHandle = testHandle;
    _rawHandle  = await testHandle.getDirectoryHandle('raw', { create: true });
    _trfHandle  = await testHandle.getDirectoryHandle('TRF', { create: true });
    _runName    = _pendingTestName;

    // Write settings snapshot into the test folder
    try {
      const fh = await testHandle.getFileHandle('settings.json', { create: true });
      const w  = await fh.createWritable();
      const snapshot = {
        date:        new Date().toISOString().slice(0, 10),
        ...((_currentTemplateName) ? { template: _currentTemplateName } : {}),
        ..._loadPrefs(),
        sample_rate: audioCtx?.sampleRate || _loadPrefs().sample_rate || 48000,
      };
      await w.write(JSON.stringify(snapshot, null, 2));
      await w.close();
    } catch (_) {}

    const instrDisp = document.getElementById('inp-instrument-banner');
    if (instrDisp) instrDisp.textContent = instrumentName;
    _patchPrefs({ instrument: instrumentName });
    const testDisp = document.getElementById('inp-test-banner');
    if (testDisp) testDisp.textContent = _pendingTestName;
    const ind = document.getElementById('folder-name-ind');
    if (ind) ind.textContent = _pendingTestName;
    _setSaveStatus(true, _pendingTestName);
  } catch (e) {
    console.error('_refreshInstrumentFolder:', e);
    alert(`⚠️ Could not set up folder for "${instrumentName}":\n${e.message}`);
    _setSaveStatus(false, e.message);
  }
}

// Show/hide the instrument overlay based on current state.
// Instrument overlay only appears when a data folder IS connected but no instrument is named.
function _refreshOverlays() {
  // Only show the instrument overlay when a template has been loaded but no
  // instrument folder is set up yet. Without a template, scratch/unnamed mode is fine.
  const needsInstrument = !!_rootDirHandle && !_rawHandle && !!_currentTemplateName;
  document.getElementById('instrument-overlay')?.classList.toggle('hidden', !needsInstrument);
}

// Core folder-setup logic, callable with any directory handle (manual pick or auto-restore)
async function _applyDataFolder(dirHandle) {
  _rootDirHandle = dirHandle;

  // ObieAppSettings first — gives us the saved instrument name
  let _acqFolderIsNew, _acqSeedsFailed;
  ({ settingsHandle: _settingsHandle, templatesHandle: _templatesHandle,
     isNew: _acqFolderIsNew, seedsFailed: _acqSeedsFailed } =
      await openObieAppSettings(dirHandle));
  if (_acqFolderIsNew) {
    const seedNote = _acqSeedsFailed
      ? '\n\nNote: some default templates and band presets could not be downloaded — check your internet connection and try reselecting the folder.'
      : '';
    alert('This is a new Data Folder and I moved over the default settings folder.' + seedNote);
  }

  // Load saved prefs (instrument name comes from here)
  let savedPrefs = null;
  try {
    const file = await (await _settingsHandle.getFileHandle('acquire.json')).getFile();
    savedPrefs  = JSON.parse(await file.text());
    _populatePrefsForm(savedPrefs);
    _pushSettingsFromPrefs(savedPrefs);
  } catch (_) {
    // No saved prefs — reset axes to clean defaults so stale localStorage zoom
    // values from previous sessions don't bleed into this new folder.
    _resetAxisRanges(null);
    _populatePrefsForm(null, true);
    _pushSettingsFromPrefs(_loadPrefs());
  }

  // Determine instrument name: prefs > 'scratch'
  const instrument = (savedPrefs?.instrument || '') || 'scratch';

  // Load templates
  _templates = [];
  await _loadTemplatesFromFolder(_templatesHandle);

  const btn = document.getElementById('data-folder-btn');
  if (btn) btn.textContent = '📁 ' + dirHandle.name;

  // Set up instrument folder (creates test subfolder + raw/TRF, sets _rawHandle)
  const instrBannerEl = document.getElementById('inp-instrument-banner');
  if (instrBannerEl) instrBannerEl.textContent = instrument;
  if (instrument !== 'scratch') {
    await _refreshInstrumentFolder(instrument);
  } else {
    _setSaveStatus(null);
    const testDisp = document.getElementById('inp-test-banner');
    if (testDisp) testDisp.textContent = '—';
  }

  // Hide the no-folder overlay, then show instrument overlay if still unnamed
  document.getElementById('folder-overlay')?.classList.add('hidden');
  _refreshOverlays();
}

let _folderApplying = false;
window.acqSetDataFolder = async function() {
  if (_folderApplying) return;
  if (!HAS_FS) {
    alert('Directory picker requires Chrome/Edge. Use the download buttons for manual export.');
    return;
  }
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e.name !== 'AbortError') alert('Folder error: ' + e.message);
    return;
  }
  _folderApplying = true;
  const btn = document.querySelector('#folder-overlay .tb-btn');
  if (btn) { btn.textContent = 'Setting up folder…'; btn.disabled = true; }
  try {
    await _applyDataFolder(dirHandle);
    await saveDataFolderHandle(dirHandle);
  } finally {
    _folderApplying = false;
    if (btn) { btn.textContent = 'Select Data Folder…'; btn.disabled = false; }
  }
};

// Called whenever a file-system write fails with a "not found" error (e.g. user deleted
// the data folder in Finder while acquisition was running). Stops audio, clears all
// handles, and shows the folder overlay so the user can reselect.
function _handleFolderGone() {
  if (_folderGoneShown) return;   // don't fire multiple times for one batch of writes
  _folderGoneShown = true;
  setTimeout(() => { _folderGoneShown = false; }, 4000);

  // Null root first so _resetForNextRun (called inside _stopAudio) won't try to refresh
  _rootDirHandle   = null;
  _rawHandle       = null;
  _trfHandle       = null;
  _testHandle      = null;
  _settingsHandle  = null;
  _templatesHandle = null;

  // Stop audio capture — fire-and-forget, errors are irrelevant here
  _stopAudio().catch(() => {});

  // Show the folder overlay with a helpful message
  document.getElementById('folder-overlay')?.classList.remove('hidden');
  const sub = document.getElementById('folder-overlay-sub');
  if (sub) sub.textContent = 'Data folder was removed — click to reselect';

  // Update the status bar
  const bar = document.getElementById('status-bar');
  if (bar) {
    bar.textContent = '⚠️ Data folder was removed — please reselect';
    bar.className   = 'acq-status-txt triggered';
  }
}

// Detect whether a caught DOMException means the directory/file no longer exists.
function _isFolderGoneError(e) {
  if (!(e instanceof DOMException)) return false;
  return e.name === 'NotFoundError'
      || e.name === 'InvalidStateError'
      || e.name === 'NoModificationAllowedError';
}

async function _writeFile(folderHandle, filename, bytes) {
  try {
    const fh = await folderHandle.getFileHandle(filename, { create: true });
    const w  = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  } catch (e) {
    if (_isFolderGoneError(e)) _handleFolderGone();
    else console.warn('_writeFile failed:', filename, e.name, e.message);
    // Never re-throw — prevents "PyodideFuture exception was never retrieved"
    // when Python calls onSaveHit / onSaveTRF / onSaveAvC and the write fails.
  }
}

async function _saveAcqSettings() {
  if (!_settingsHandle) return;
  try {
    const json = JSON.stringify(_loadPrefs(), null, 2);
    const fh   = await _settingsHandle.getFileHandle('acquire.json', { create: true });
    const w    = await fh.createWritable();
    await w.write(json);
    await w.close();
  } catch (e) {
    if (_isFolderGoneError(e)) _handleFolderGone();
    else console.warn('_saveAcqSettings:', e);
  }
}

async function _loadTemplatesFromFolder(dir) {
  try {
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file') continue;
      const lower = name.toLowerCase();
      try {
        const text = await (await h.getFile()).text();
        if (lower.endsWith('.txt')) {
          const fields   = JSON.parse(window.pyParseLabviewTxt(text));
          const tplName  = name.replace(/_template\.txt$/i, '').replace(/_/g, ' ').trim();
          const tplNotes = (fields['Default Notes'] || '').trim();
          _templates.push({ name: tplName, settings: _lvFieldsToSettings(fields), _file: name,
                            ...(tplNotes ? { notes: tplNotes } : {}) });
        } else if (lower.endsWith('.json')) {
          const data = JSON.parse(text);
          const arr  = Array.isArray(data) ? data : [data];
          _templates.push(...arr.map(t => ({ ...t, _file: name })));
        }
      } catch (_) {}
    }
  } catch (_) {}
  _renderTemplateList();
}


// ════════════════════════════════════════════════════════════════════════════
// LiveView dialog — embedded, toggled by the LiveView toolbar button
// ════════════════════════════════════════════════════════════════════════════

const LV_WORKLET_SRC = `
class LVCaptureProcessor extends AudioWorkletProcessor {
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
registerProcessor('lv-capture', LVCaptureProcessor);
`;

let _lvAudioCtx    = null;
let _lvWorkletNode = null;
let _lvSource      = null;
let _lvStream      = null;
let _lvRunning     = false;
let _lvRafId       = null;
let _lvSr          = 44100;

const LV_RING_SECS = 4;
let _lvRingH  = new Float32Array(LV_RING_SECS * 44100);
let _lvRingM  = new Float32Array(LV_RING_SECS * 44100);
let _lvRingSz = LV_RING_SECS * 44100;
let _lvRingWr = 0;

function _lvReallocRing(sr) {
  _lvSr    = sr;
  _lvRingSz = LV_RING_SECS * sr;
  _lvRingH  = new Float32Array(_lvRingSz);
  _lvRingM  = new Float32Array(_lvRingSz);
  _lvRingWr = 0;
}
function _lvPushRing(L, R) {
  for (let i = 0; i < L.length; i++) {
    _lvRingH[_lvRingWr] = _lvSwap ? R[i] : L[i];
    _lvRingM[_lvRingWr] = _lvSwap ? L[i] : R[i];
    _lvRingWr = (_lvRingWr + 1) % _lvRingSz;
  }
}
function _lvRingTail(n) {
  n = Math.min(n, _lvRingSz);
  const H = new Float32Array(n), M = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const idx = (_lvRingWr - n + i + _lvRingSz) % _lvRingSz;
    H[i] = _lvRingH[idx]; M[i] = _lvRingM[idx];
  }
  return { H, M };
}
function _lvRingWindowAt(center, pre, post) {
  const n = pre + post;
  const H = new Float32Array(n), M = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const idx = (center - pre + i + _lvRingSz) % _lvRingSz;
    H[i] = _lvRingH[idx]; M[i] = _lvRingM[idx];
  }
  return { H, M };
}

let _lvMode = 'live';

window.lvSetMode = function(m) {
  _lvMode = m;
  document.getElementById('lv-mode-live')?.classList.toggle('active',    m === 'live');
  document.getElementById('lv-mode-trigger')?.classList.toggle('active', m === 'trigger');
  const t = document.getElementById('lv-frf-title');
  if (t) t.textContent = m === 'live' ? 'FRF (live estimate)' : 'FRF (H1 from triggered hits)';
  const cb = document.getElementById('lv-clear-btn');
  if (cb) cb.style.display = m === 'trigger' ? '' : 'none';
  const h = document.getElementById('lv-hits');
  if (h) h.textContent = '';
  if (m === 'trigger') _lvTrigState = 'armed';
  _lvFrfGxx = null; _lvFrfGxy_re = null; _lvFrfGxy_im = null; _lvFrfCount = 0;
  _lvCapturedH = null; _lvCapturedM = null; _lvCapturedFRF = null;
};

let _lvSwap         = false;
let _lvTrigState    = 'armed';
let _lvTrigRingPos  = 0;
let _lvPostLeft     = 0;
let _lvCapturedH    = null;
let _lvCapturedM    = null;
let _lvCapturedFRF  = null;
let _lvCapturedPreN = 0;
let _lvFrfGxx    = null;
let _lvFrfGxy_re = null;
let _lvFrfGxy_im = null;
let _lvFrfFreqs  = null;
let _lvFrfCount  = 0;

window.lvClearFRF = function() {
  _lvFrfGxx = null; _lvFrfGxy_re = null; _lvFrfGxy_im = null; _lvFrfCount = 0;
  _lvCapturedH = null; _lvCapturedM = null; _lvCapturedFRF = null;
  const h = document.getElementById('lv-hits'); if (h) h.textContent = '';
};

function _lvNextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function _lvFftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const theta = -2 * Math.PI / len;
    const wr = Math.cos(theta), wi = Math.sin(theta);
    for (let i = 0; i < n; i += len) {
      let ur = 1, ui = 0;
      for (let k = 0; k < (len >> 1); k++) {
        const ar = re[i+k], ai = im[i+k];
        const br = re[i+k+(len>>1)]*ur - im[i+k+(len>>1)]*ui;
        const bi = re[i+k+(len>>1)]*ui + im[i+k+(len>>1)]*ur;
        re[i+k]          = ar + br; im[i+k]          = ai + bi;
        re[i+k+(len>>1)] = ar - br; im[i+k+(len>>1)] = ai - bi;
        const ur2 = ur*wr - ui*wi; ui = ur*wi + ui*wr; ur = ur2;
      }
    }
  }
}
function _lvSpectrum(samples, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  const len = Math.min(samples.length, N);
  for (let i = 0; i < len; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1));
    re[i] = samples[i] * w;
  }
  _lvFftInPlace(re, im);
  return { re, im };
}
function _lvComputeH1(hamWin, micWin) {
  const N = _lvNextPow2(Math.max(hamWin.length, micWin.length));
  const H = _lvSpectrum(hamWin, N);
  const M = _lvSpectrum(micWin, N);
  const bins = N >> 1;
  const freqs = new Float32Array(bins), Gxx = new Float64Array(bins);
  const Gxy_re = new Float64Array(bins), Gxy_im = new Float64Array(bins);
  for (let i = 0; i < bins; i++) {
    freqs[i]  = i * _lvSr / N;
    Gxx[i]    = H.re[i]*H.re[i] + H.im[i]*H.im[i];
    Gxy_re[i] = M.re[i]*H.re[i] + M.im[i]*H.im[i];
    Gxy_im[i] = M.im[i]*H.re[i] - M.re[i]*H.im[i];
  }
  return { freqs, Gxx, Gxy_re, Gxy_im };
}
function _lvH1ToDb(Gxx, Gxy_re, Gxy_im) {
  const mags = new Float32Array(Gxx.length);
  for (let i = 0; i < Gxx.length; i++) {
    const den = Gxx[i] + 1e-30;
    const hr = Gxy_re[i] / den, hi = Gxy_im[i] / den;
    mags[i] = 20 * Math.log10(Math.sqrt(hr*hr + hi*hi) + 1e-10);
  }
  return mags;
}

function _lvResizeCanvases() {
  ['lv-hammer-canvas', 'lv-mic-canvas', 'lv-frf-canvas'].forEach(id => {
    const c = document.getElementById(id);
    if (!c) return;
    c.width  = c.offsetWidth  * devicePixelRatio;
    c.height = c.offsetHeight * devicePixelRatio;
  });
}

function _lvDrawTime(id, samples, color, thr, showThr) {
  const c = document.getElementById(id); if (!c) return;
  const ctx = c.getContext('2d'), w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  if (!samples || !samples.length) return;
  const n = samples.length;
  let pk = 0;
  for (let i = 0; i < n; i++) if (Math.abs(samples[i]) > pk) pk = Math.abs(samples[i]);
  pk = Math.max(pk * 1.2, thr * 1.5, 0.02);
  const yOf = v => h * (0.5 - v / (2 * pk));
  ctx.strokeStyle = '#e0e0e0'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();
  if (showThr && thr > 0) {
    ctx.setLineDash([4*devicePixelRatio, 4*devicePixelRatio]);
    ctx.strokeStyle = '#7c2bc8'; ctx.lineWidth = 1.5*devicePixelRatio;
    ctx.beginPath(); ctx.moveTo(0, yOf(thr));  ctx.lineTo(w, yOf(thr));  ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, yOf(-thr)); ctx.lineTo(w, yOf(-thr)); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = color; ctx.lineWidth = 1.5*devicePixelRatio;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(n / w));
  for (let i = 0; i < n; i += step) {
    const x = w*i/n, y = yOf(samples[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#aaa'; ctx.font = `${9*devicePixelRatio}px sans-serif`; ctx.textBaseline = 'top';
  ctx.fillText(`pk ${(pk/1.2).toFixed(3)} V`, 4*devicePixelRatio, 3*devicePixelRatio);
}

function _lvDrawFRF(freqs, mags) {
  const c = document.getElementById('lv-frf-canvas'); if (!c) return;
  const ctx = c.getContext('2d'), w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  if (!freqs || !freqs.length) {
    ctx.fillStyle = '#ccc'; ctx.font = `${11*devicePixelRatio}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(_lvMode === 'trigger' ? 'Waiting for trigger…' : 'No data', w/2, h/2);
    ctx.textAlign = 'left'; return;
  }
  const fMin = 100, fMax = 12000;
  const fMinL = Math.log10(fMin), fMaxL = Math.log10(fMax);
  let yMax = -Infinity, yMin = Infinity;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] < fMin || freqs[i] > fMax || !isFinite(mags[i]) || mags[i] < -200) continue;
    if (mags[i] > yMax) yMax = mags[i];
    if (mags[i] < yMin) yMin = mags[i];
  }
  if (!isFinite(yMax)) { yMax = 20; yMin = -60; }
  yMax += 5; yMin = yMax - 60;
  const xOf = f => w * (Math.log10(Math.max(f, 0.1)) - fMinL) / (fMaxL - fMinL);
  const yOf = v => h * (1 - (v - yMin) / (yMax - yMin));
  ctx.strokeStyle = '#ececec'; ctx.lineWidth = 1;
  [100, 200, 500, 1000, 2000, 5000, 10000].forEach(f => {
    const x = xOf(f); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  });
  ctx.strokeStyle = '#6a1b9a'; ctx.lineWidth = 1.8*devicePixelRatio;
  ctx.beginPath(); let started = false;
  for (let i = 1; i < freqs.length; i++) {
    if (freqs[i] < fMin || freqs[i] > fMax || !isFinite(mags[i]) || mags[i] < -200) { started = false; continue; }
    const x = xOf(freqs[i]), y = yOf(mags[i]);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#aaa'; ctx.font = `${9*devicePixelRatio}px sans-serif`;
  ctx.textBaseline = 'bottom';
  [100, 200, 500, 1000, 2000, 5000, 10000].forEach(f => {
    ctx.fillText(f >= 1000 ? (f/1000)+'k' : f, xOf(f)+devicePixelRatio, h-devicePixelRatio);
  });
  ctx.textBaseline = 'top';
  ctx.fillText(`${yMax.toFixed(0)} dB`, 2*devicePixelRatio, 2*devicePixelRatio);
  ctx.fillText(`${yMin.toFixed(0)} dB`, 2*devicePixelRatio, h-12*devicePixelRatio);
}

function _lvSetSt(msg) { const el = document.getElementById('lv-status'); if (el) el.textContent = msg; }

async function _lvEnumerateMics() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const sel = document.getElementById('lv-mic-sel'); if (!sel) return;
    const savedId = _loadPrefs().deviceId || '';
    sel.innerHTML = '';
    const SKIP_LV = new Set(['default', 'communications']);
    devices.filter(d => d.kind === 'audioinput' && !SKIP_LV.has(d.deviceId)).forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Mic (${d.deviceId.slice(0,8)}…)`;
      if (d.deviceId === savedId) o.selected = true;
      sel.appendChild(o);
    });
  } catch(e) { _lvSetSt('Mic access denied: ' + e.message); }
}

function _lvApplyPrefsToForm() {
  const p = _loadPrefs();
  const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  set('lv-inp-thr',  p.threshold   ?? 0.05);
  set('lv-inp-pre',  p.pre_trig_s  ?? 0.01);
  set('lv-inp-post', p.post_trig_s ?? 0.30);
}

window.lvToggleCapture = async function() {
  if (_lvRunning) { _lvStopCapture(); return; }
  const sel = document.getElementById('lv-mic-sel');
  const deviceId = sel?.value || '';
  try {
    _lvSetSt('Requesting microphone…');
    const prefs = _loadPrefs();
    _lvStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId:         deviceId ? { exact: deviceId } : undefined,
        channelCount:     { ideal: 2 },
        sampleRate:       { ideal: prefs.sample_rate ?? 48000 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      }
    });
    _lvAudioCtx = new AudioContext();
    _lvSwap = prefs.swap_channels ?? false;
    _lvReallocRing(_lvAudioCtx.sampleRate);
    const blob = new Blob([LV_WORKLET_SRC], { type: 'application/javascript' });
    const blobURL = URL.createObjectURL(blob);
    await _lvAudioCtx.audioWorklet.addModule(blobURL);
    URL.revokeObjectURL(blobURL);
    _lvSource = _lvAudioCtx.createMediaStreamSource(_lvStream);
    _lvWorkletNode = new AudioWorkletNode(_lvAudioCtx, 'lv-capture', {
      numberOfInputs: 1, numberOfOutputs: 0,
      channelCount: 2, channelCountMode: 'explicit',
    });
    _lvWorkletNode.port.onmessage = ({ data }) => {
      _lvPushRing(data.l, data.r);
      if (_lvMode === 'trigger') _lvCheckTrigger(_lvSwap ? data.r : data.l);
    };
    _lvSource.connect(_lvWorkletNode);
    _lvRunning = true; _lvTrigState = 'armed';
    const btn = document.getElementById('lv-start-btn');
    if (btn) { btn.textContent = '■ Stop'; btn.classList.remove('accent'); btn.classList.add('stop'); }
    _lvSetSt(_lvMode === 'live' ? 'Running — live mode' : 'Armed — waiting for trigger…');
    _lvLoop();
  } catch(e) { _lvSetSt('Error: ' + e.message); }
};

function _lvStopCapture() {
  _lvRunning = false;
  if (_lvRafId) { cancelAnimationFrame(_lvRafId); _lvRafId = null; }
  if (_lvWorkletNode) { _lvWorkletNode.disconnect(); _lvWorkletNode = null; }
  if (_lvSource)      { _lvSource.disconnect();      _lvSource = null; }
  if (_lvStream)      { _lvStream.getTracks().forEach(t => t.stop()); _lvStream = null; }
  if (_lvAudioCtx)    { _lvAudioCtx.close(); _lvAudioCtx = null; }
  const btn = document.getElementById('lv-start-btn');
  if (btn) { btn.textContent = '▶ Start'; btn.classList.remove('stop'); btn.classList.add('accent'); }
  _lvSetSt('Stopped');
}

// Called when the user picks a different device while running — restart on the new device.
window.lvRestartWithDevice = async function() {
  const wasRunning = _lvRunning;
  if (wasRunning) {
    _lvStopCapture();
    await new Promise(r => setTimeout(r, 120));  // let the old context fully close
    lvToggleCapture();
  }
};

function _lvCheckTrigger(hammerBatch) {
  const thr = parseFloat(document.getElementById('lv-inp-thr')?.value) || 0.05;
  if (_lvTrigState === 'armed') {
    for (let i = 0; i < hammerBatch.length; i++) {
      if (Math.abs(hammerBatch[i]) > thr) {
        _lvTrigRingPos = (_lvRingWr - hammerBatch.length + i + _lvRingSz) % _lvRingSz;
        const postS = parseFloat(document.getElementById('lv-inp-post')?.value) || 0.30;
        _lvPostLeft = Math.ceil(postS * _lvSr) - (hammerBatch.length - i - 1);
        _lvTrigState = _lvPostLeft <= 0 ? 'capture_now' : 'triggered';
        if (_lvTrigState === 'capture_now') _lvDoCapture();
        break;
      }
    }
  } else if (_lvTrigState === 'triggered') {
    _lvPostLeft -= hammerBatch.length;
    if (_lvPostLeft <= 0) _lvDoCapture();
  }
}

function _lvDoCapture() {
  _lvTrigState = 'holding';
  const preS  = parseFloat(document.getElementById('lv-inp-pre')?.value)  || 0.01;
  const postS = parseFloat(document.getElementById('lv-inp-post')?.value) || 0.30;
  const preN  = Math.ceil(preS * _lvSr), postN = Math.ceil(postS * _lvSr);
  const { H, M } = _lvRingWindowAt(_lvTrigRingPos, preN, postN);
  _lvCapturedH = H; _lvCapturedM = M; _lvCapturedPreN = preN;
  const result = _lvComputeH1(H, M);
  if (!_lvFrfGxx) {
    _lvFrfGxx    = new Float64Array(result.Gxx);
    _lvFrfGxy_re = new Float64Array(result.Gxy_re);
    _lvFrfGxy_im = new Float64Array(result.Gxy_im);
    _lvFrfFreqs  = result.freqs;
  } else {
    const bins = Math.min(_lvFrfGxx.length, result.Gxx.length);
    for (let i = 0; i < bins; i++) {
      _lvFrfGxx[i]    += result.Gxx[i];
      _lvFrfGxy_re[i] += result.Gxy_re[i];
      _lvFrfGxy_im[i] += result.Gxy_im[i];
    }
  }
  _lvFrfCount++;
  _lvCapturedFRF = { freqs: _lvFrfFreqs, mags: _lvH1ToDb(_lvFrfGxx, _lvFrfGxy_re, _lvFrfGxy_im) };
  const h = document.getElementById('lv-hits');
  if (h) h.textContent = `${_lvFrfCount} hit${_lvFrfCount > 1 ? 's' : ''} averaged`;
  _lvSetSt(`Hit ${_lvFrfCount} captured — re-arming…`);
  setTimeout(() => { if (_lvRunning) { _lvTrigState = 'armed'; _lvSetSt('Armed — waiting for trigger…'); } }, 200);
}

let _lvLiveFrameCount = 0;
let _lvLiveFRF = null;

function _lvUpdateLiveFRF() {
  const postS = parseFloat(document.getElementById('lv-inp-post')?.value) || 0.30;
  const nAvg  = parseInt(document.getElementById('lv-num-avg')?.value) || 4;
  const { H, M } = _lvRingTail(Math.ceil(postS * _lvSr));
  const result    = _lvComputeH1(H, M);
  const mags      = _lvH1ToDb(result.Gxx, result.Gxy_re, result.Gxy_im);
  if (!_lvLiveFRF || _lvLiveFRF.freqs.length !== result.freqs.length) {
    _lvLiveFRF = { freqs: result.freqs, mags: new Float32Array(mags) };
  } else {
    const a = 1 / nAvg;
    for (let i = 0; i < mags.length; i++)
      _lvLiveFRF.mags[i] = _lvLiveFRF.mags[i] * (1 - a) + mags[i] * a;
  }
}

function _lvLoop() {
  if (!_lvRunning) return;
  _lvRafId = requestAnimationFrame(_lvLoop);
  _lvLiveFrameCount++;
  const thr = parseFloat(document.getElementById('lv-inp-thr')?.value) || 0.05;
  if (_lvMode === 'live') {
    const dispN = Math.ceil((parseFloat(document.getElementById('lv-inp-post')?.value) || 0.3) * _lvSr);
    const { H, M } = _lvRingTail(dispN);
    const pkH = H.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const pkM = M.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const lhEl = document.getElementById('lv-level-h');
    const lmEl = document.getElementById('lv-level-m');
    if (lhEl) lhEl.textContent = pkH > 1e-6 ? (20*Math.log10(pkH)).toFixed(1)+' dB' : '–';
    if (lmEl) lmEl.textContent = pkM > 1e-6 ? (20*Math.log10(pkM)).toFixed(1)+' dB' : '–';
    _lvDrawTime('lv-hammer-canvas', H, '#c62828', thr, true);
    _lvDrawTime('lv-mic-canvas',    M, '#1565c0', thr, false);
    if (_lvLiveFrameCount % 6 === 0) _lvUpdateLiveFRF();
    if (_lvLiveFRF) _lvDrawFRF(_lvLiveFRF.freqs, _lvLiveFRF.mags);
  } else {
    if (_lvCapturedH) {
      const pkH = _lvCapturedH.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      const pkM = _lvCapturedM.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      const lhEl = document.getElementById('lv-level-h');
      const lmEl = document.getElementById('lv-level-m');
      if (lhEl) lhEl.textContent = pkH > 1e-6 ? (20*Math.log10(pkH)).toFixed(1)+' dB' : '–';
      if (lmEl) lmEl.textContent = pkM > 1e-6 ? (20*Math.log10(pkM)).toFixed(1)+' dB' : '–';
      _lvDrawTime('lv-hammer-canvas', _lvCapturedH, '#c62828', thr, true);
      _lvDrawTime('lv-mic-canvas',    _lvCapturedM, '#1565c0', thr, false);
      if (_lvCapturedFRF) _lvDrawFRF(_lvCapturedFRF.freqs, _lvCapturedFRF.mags);
    } else {
      const { H, M } = _lvRingTail(Math.ceil(0.1 * _lvSr));
      _lvDrawTime('lv-hammer-canvas', H, '#c62828', thr, true);
      _lvDrawTime('lv-mic-canvas',    M, '#1565c0', thr, false);
      _lvDrawFRF(null, null);
    }
  }
}

let _lvSyncPending = null;

window.acqLvSyncYes = function() {
  document.getElementById('lv-sync-modal')?.classList.remove('open');
  if (!_lvSyncPending) return;
  _patchPrefs(_lvSyncPending);
  _callPyApplySettings();
  // Reflect in the mini-plot display inputs
  const inpThr = document.getElementById('inp-thr-disp');
  if (inpThr) inpThr.value = _lvSyncPending.threshold;
  const inpHam = document.getElementById('inp-ham-cut-disp');
  if (inpHam) inpHam.value = _lvSyncPending.post_trig_s;
  const inpMic = document.getElementById('inp-mic-cut-disp');
  if (inpMic) inpMic.value = _lvSyncPending.post_trig_s;
  _lvSyncPending = null;
};

window.acqLvSyncNo = function() {
  document.getElementById('lv-sync-modal')?.classList.remove('open');
  _lvSyncPending = null;
};

window.acqLiveView = function() {
  const dlg = document.getElementById('lv-dialog');
  if (!dlg) return;
  const isOpen = dlg.classList.contains('open');
  if (isOpen) {
    _lvStopCapture();
    dlg.classList.remove('open');
    document.getElementById('lv-btn')?.classList.remove('active');

    // Check whether the user changed threshold / pre / post inside LiveView
    const lvThr  = parseFloat(document.getElementById('lv-inp-thr')?.value);
    const lvPre  = parseFloat(document.getElementById('lv-inp-pre')?.value);
    const lvPost = parseFloat(document.getElementById('lv-inp-post')?.value);
    const p = _loadPrefs();
    if (!isNaN(lvThr) && !isNaN(lvPre) && !isNaN(lvPost) &&
        (Math.abs(lvThr - (p.threshold   ?? 0.05)) > 0.0001 ||
         Math.abs(lvPre - (p.pre_trig_s  ?? 0.01)) > 0.0001 ||
         Math.abs(lvPost - (p.post_trig_s ?? 0.30)) > 0.0001)) {
      const syncMsg = document.getElementById('lv-sync-detail');
      if (syncMsg) syncMsg.textContent =
        `Threshold ${lvThr} V · Pre ${lvPre} s · Post ${lvPost} s`;
      _lvSyncPending = { threshold: lvThr, pre_trig_s: lvPre, post_trig_s: lvPost };
      document.getElementById('lv-sync-modal')?.classList.add('open');
    }
  } else {
    dlg.classList.add('open');
    document.getElementById('lv-btn')?.classList.add('active');
    setTimeout(() => {
      _lvResizeCanvases();
      _lvApplyPrefsToForm();
      _lvEnumerateMics().then(() => setTimeout(lvToggleCapture, 300));
    }, 60);
  }
};


// ════════════════════════════════════════════════════════════════════════════
// Time-cutoff interaction (click on hammer or mic mini plot)
// ════════════════════════════════════════════════════════════════════════════



// ════════════════════════════════════════════════════════════════════════════
// Audio — start / stop
// ════════════════════════════════════════════════════════════════════════════

function _isBuiltInMic(label) {
  const l = (label || '').toLowerCase();
  return /built.?in|internal|macbook|imac|laptop|headset mic/.test(l);
}

window.acqToggleAcquire = async function() {
  if (appState === 'idle' || appState === 'complete') {
    const p      = _loadPrefs();
    const label  = p.deviceLabel || '';
    // Only warn pre-start when we already know the device name — if they chose
    // "Default device" we don't know the label yet and will check post-open.
    if (label && _isBuiltInMic(label)) {
      const name = label;
      const ok   = confirm(
        `"${name}" looks like a built-in microphone.\n\n` +
        `Impact hammer measurements need a directional external mic.\n\n` +
        `Start anyway?`
      );
      if (!ok) return;
    }
    // Starting a brand-new run after completion — clear stale plot data and banner.
    // Do NOT clear when starting from idle after a Pause (frfCache holds completed positions).
    if (appState === 'complete') {
      frfCache = {};
      tapCache = {};
      _blockFRFUpdates = true;   // suppress Python's history replay until first real hit
      const bannerEl = document.getElementById('pos-banner');
      if (bannerEl) bannerEl.innerHTML = '';
      renderFRF();
    }
    await _startAudio();
  } else {
    await _stopAudio();
  }
};

function _startSimulation(sr, swapChannels) {
  _simSample  = 0;
  _simNextHit = Math.round(sr * 1.5);                // first hit after 1.5 s
  const hitSpacing = Math.round(sr * 2.5);           // subsequent hits every 2.5 s
  const delay = Math.max(10, Math.round(BATCH_SIZE / sr * 1000));

  _simInterval = setInterval(() => {
    const L = new Float32Array(BATCH_SIZE);
    const R = new Float32Array(BATCH_SIZE);
    for (let i = 0; i < BATCH_SIZE; i++) {
      const s  = _simSample + i;
      const dt = (s - _simNextHit) / sr;
      let ham = 0, mic = 0;
      if (dt >= 0 && dt < 0.1) {
        ham = 0.4  * Math.exp(-dt / 0.0001);
        mic = 0.2  * Math.sin(2 * Math.PI * 600 * dt) * Math.exp(-dt / 0.012);
      }
      const noise = () => (Math.random() - 0.5) * 0.002;
      if (swapChannels) { R[i] = ham + noise(); L[i] = mic + noise(); }
      else              { L[i] = ham + noise(); R[i] = mic + noise(); }
    }
    _simSample += BATCH_SIZE;
    if (_simSample > _simNextHit + Math.round(sr * 0.5)) _simNextHit += hitSpacing;
    if (window.pyProcessAudio) window.pyProcessAudio(L, R);
  }, delay);
}

function _stopSimulation() {
  if (_simInterval) { clearInterval(_simInterval); _simInterval = null; }
}

async function _startAudio() {
  const prefs    = _loadPrefs();
  const deviceId = prefs.deviceId;

  if (deviceId === '__simulated__') {
    _pushSettingsFromPrefs({ ...prefs });
    _patchPrefs({ deviceLabel: '⚡ Simulated Input' });
    _updateSoundcardDisplay();
    _startSimulation(prefs.sample_rate ?? 48000, prefs.swap_channels ?? false);
    window.pyArm();
    return;
  }

  // Folder is created by _refreshInstrumentFolder (called from Instrument modal
  // and after each run completes). Just warn if somehow not ready.
  const _instrument = (document.getElementById('inp-instrument-banner')?.textContent || '').trim() || 'scratch';
  if (_instrument === 'scratch') {
    _setSaveStatus(null);
  } else if (!_rawHandle) {
    // Folder wasn't pre-created — try now as a fallback
    await _refreshInstrumentFolder(_instrument);
  }

  // If audio is already running (run completed naturally), reuse the existing
  // stream and just re-arm Python — no need to reopen the device.
  if (audioCtx) {
    _pushSettingsFromPrefs({ ...prefs });
    window.pyArm();
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId:         deviceId ? { exact: deviceId } : undefined,
        channelCount:     { ideal: 2 },
        sampleRate:       { ideal: prefs.sample_rate ?? 48000 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      },
    });
    audioCtx = new AudioContext();
    const sr = audioCtx.sampleRate;
    _patchPrefs({ sample_rate: sr });   // record actual hardware rate

    // Read the device that was actually opened — may differ from the requested
    // deviceId if the browser fell back to the default input.
    try {
      const track    = mediaStream.getAudioTracks()[0];
      const actualId = track?.getSettings().deviceId || '';
      const devices  = await navigator.mediaDevices.enumerateDevices();
      const dev      = devices.find(d => d.kind === 'audioinput' && d.deviceId === actualId);
      const actualLabel = dev?.label || track?.label || '';
      _patchPrefs({ deviceId: actualId, deviceLabel: actualLabel });
      _updateSoundcardDisplay();
      // Post-open built-in check: covers the "Default device" case where we
      // couldn't know the label until audio was actually opened.
      if (!prefs.deviceId && _isBuiltInMic(actualLabel)) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
        const ok = confirm(
          `"${actualLabel}" looks like a built-in microphone.\n\n` +
          `Impact hammer measurements need a directional external mic.\n\n` +
          `Start anyway?`
        );
        if (!ok) { audioCtx.close(); audioCtx = null; return; }
        // Re-open with same constraints — user confirmed
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId:         undefined,
            channelCount:     { ideal: 2 },
            sampleRate:       { ideal: prefs.sample_rate ?? 48000 },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl:  false,
          },
        });
      }
    } catch (_) {}

    _pushSettingsFromPrefs({ ...prefs });
    const blob    = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const blobURL = URL.createObjectURL(blob);
    await audioCtx.audioWorklet.addModule(blobURL);
    URL.revokeObjectURL(blobURL);

    sourceNode  = audioCtx.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioCtx, 'acq-capture', {
      numberOfInputs: 1, numberOfOutputs: 0,
      channelCount: 2, channelCountMode: 'explicit',
    });

    batchFill = 0;
    workletNode.port.onmessage = e => {
      const l = e.data.l, r = e.data.r;
      let off = 0;
      while (off < l.length) {
        const n = Math.min(l.length - off, BATCH_SIZE - batchFill);
        batchL.set(l.subarray(off, off + n), batchFill);
        batchR.set(r.subarray(off, off + n), batchFill);
        batchFill += n; off += n;
        if (batchFill >= BATCH_SIZE) {
          window.pyProcessAudio(batchL, batchR);
          batchFill = 0;
        }
      }
    };
    sourceNode.connect(workletNode);

    // Detect device disconnect: the track fires 'ended' when a USB device is yanked.
    // AudioContext.onstatechange catches broader interruptions (e.g. OS audio session loss).
    const _activeTrack = mediaStream.getAudioTracks()[0];
    if (_activeTrack) {
      _activeTrack.addEventListener('ended', () => {
        if (!audioCtx) return;   // already stopped
        _stopAudio();
        alert('⚠️ Audio device disconnected — acquisition stopped.');
      }, { once: true });
    }
    audioCtx.onstatechange = () => {
      if ((audioCtx?.state === 'suspended' || audioCtx?.state === 'closed') && mediaStream) {
        _stopAudio();
        alert('⚠️ Audio device interrupted — acquisition stopped.');
      }
    };

    window.pyArm();
  } catch (err) {
    if (err.name === 'NotAllowedError') return;
    const label = _loadPrefs().deviceLabel || '';
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      alert(`Cannot find audio device${label ? ' "' + label + '"' : ''} — check your selection in Preferences.`);
    } else {
      alert('Audio error: ' + err.message);
    }
  }
}

async function _stopAudio() {
  _blockFRFUpdates = false;
  _stopSimulation();
  if (workletNode)  { workletNode.disconnect(); workletNode = null; }
  if (sourceNode)   { sourceNode.disconnect();  sourceNode  = null; }
  if (audioCtx)     { await audioCtx.close();   audioCtx   = null; }
  if (mediaStream)  { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  window.pyStopAudio();
  _resetForNextRun();
}

function _resetForNextRun() {
  _rawHandle = null;
  _trfHandle = null;
  _runName   = '';
  // Immediately grey-out the position banner so it doesn't stay green for the next test
  document.querySelectorAll('#pos-banner .pos-tab').forEach(tab => {
    tab.classList.remove('current', 'partial', 'complete');
    const dots = tab.querySelector('.pos-dots');
    if (dots) dots.textContent = dots.textContent.replace(/●/g, '○');
  });
  const instrument = (document.getElementById('inp-instrument-banner')?.textContent || '').trim();
  if (instrument && instrument !== '—' && instrument !== 'scratch' && _rootDirHandle) {
    _refreshInstrumentFolder(instrument);  // rescans and increments test number
  }
}


// ════════════════════════════════════════════════════════════════════════════
// Sidebar resize
// ════════════════════════════════════════════════════════════════════════════

function _initResizer() {
  const resizer  = document.getElementById('acq-resizer');
  const sidebar  = document.querySelector('.acq-sidebar');
  if (!resizer || !sidebar) return;
  let dragging = false, startX = 0, startW = 0;
  resizer.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(120, Math.min(400, startW + (e.clientX - startX)));
    sidebar.style.width = w + 'px';
    Plotly.Plots.resize('plot-fft');
    Plotly.Plots.resize('plot-hammer');
    Plotly.Plots.resize('plot-mic');
    Plotly.Plots.resize('acq-plot');
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}


// ════════════════════════════════════════════════════════════════════════════
// Initialisation
// ════════════════════════════════════════════════════════════════════════════

function _clearTrigPlots() {
  const empty = [{ x: [], y: [], type: 'scatter', mode: 'lines' }];
  Plotly.react('plot-hammer', empty, miniLayout('Hammer',      'Time (s)', 'V', { range: _hamXRange }, { range: _hamYRange }), PCFG);
  Plotly.react('plot-mic',    empty, miniLayout('Microphone',  'Time (s)', 'V', { range: _micXRange }, { range: _micYRange }), PCFG);
  Plotly.react('plot-fft',    empty, miniLayout('Hammer FFT',  'Hz',       'dB',
    { type: 'log', range: [Math.log10(Math.max(_fftXRange[0], 1)), Math.log10(_fftXRange[1])] },
    { range: _fftYRange }), PCFG);
  _lastTrigData = null;
}

function _initPlots() {
  const empty = { x: [], y: [], type: 'scatter', mode: 'lines' };
  const fftColor  = '#7c4dbe';
  const hamColor  = '#c62828';
  const micColor  = '#1565c0';

  Plotly.newPlot('plot-fft',
    [{ ...empty, line: { color: fftColor, width: 1 } }],
    miniLayout('Hammer FFT', 'Hz', 'dB',
      { type: 'log', range: [Math.log10(Math.max(_fftXRange[0], 1)), Math.log10(_fftXRange[1])] },
      { range: _fftYRange }),
    PCFG);

  Plotly.newPlot('plot-hammer',
    [{ ...empty, line: { color: hamColor, width: 1 } }],
    miniLayout('Hammer', 'Time (s)', 'V', { range: _hamXRange }, { range: _hamYRange }),
    PCFG);

  Plotly.newPlot('plot-mic',
    [{ ...empty, line: { color: micColor, width: 1 } }],
    miniLayout('Microphone', 'Time (s)', 'V', { range: _micXRange }, { range: _micYRange }),
    PCFG);

  // Persist user zoom/pan — capture both x and y changes on mini plots.
  document.getElementById('plot-hammer').on('plotly_relayout', e => {
    if (e['yaxis.range[0]'] != null) _hamYRange = [e['yaxis.range[0]'], e['yaxis.range[1]']];
    else if (e['yaxis.autorange'])   _hamYRange = null;
    if (e['xaxis.range[0]'] != null) {
      _hamXRange = [e['xaxis.range[0]'], e['xaxis.range[1]']];
      const mn = document.getElementById('inp-ham-x-min');
      const mx = document.getElementById('inp-ham-x-max');
      if (mn) mn.value = _hamXRange[0].toFixed(3);
      if (mx) mx.value = _hamXRange[1].toFixed(3);
      _patchPrefs({ ham_x_min: _hamXRange[0], ham_x_max: _hamXRange[1] });
    }
  });
  document.getElementById('plot-mic').on('plotly_relayout', e => {
    if (e['yaxis.range[0]'] != null) _micYRange = [e['yaxis.range[0]'], e['yaxis.range[1]']];
    else if (e['yaxis.autorange'])   _micYRange = null;
    if (e['xaxis.range[0]'] != null) {
      _micXRange = [e['xaxis.range[0]'], e['xaxis.range[1]']];
      const mn = document.getElementById('inp-mic-x-min');
      const mx = document.getElementById('inp-mic-x-max');
      if (mn) mn.value = _micXRange[0].toFixed(3);
      if (mx) mx.value = _micXRange[1].toFixed(3);
      _patchPrefs({ mic_x_min: _micXRange[0], mic_x_max: _micXRange[1] });
    }
  });

  renderFRF();

  // Track main FRF plot zoom/pan — must attach after first renderFRF() initialises the plot.
  document.getElementById('acq-plot').on('plotly_relayout', e => {
    if (_yTrueAutorange) return;  // ignore events triggered by our own Plotly.react calls
    if (e['xaxis.range[0]'] != null) {
      // Plotly reports log10 values when axis type is 'log'
      _S.xMin = _S.xLog ? Math.pow(10, e['xaxis.range[0]']) : e['xaxis.range[0]'];
      _S.xMax = _S.xLog ? Math.pow(10, e['xaxis.range[1]']) : e['xaxis.range[1]'];
      const mn = document.getElementById('inp-frf-x-min');
      const mx = document.getElementById('inp-frf-x-max');
      if (mn) mn.value = Math.round(_S.xMin);
      if (mx) mx.value = Math.round(_S.xMax);
      _patchPrefs({ frf_x_min: Math.round(_S.xMin), frf_x_max: Math.round(_S.xMax) });
    } else if (e['xaxis.autorange']) {
      _S.xMin = 100; _S.xMax = 12000;
      const mn = document.getElementById('inp-frf-x-min');
      const mx = document.getElementById('inp-frf-x-max');
      if (mn) mn.value = 100;
      if (mx) mx.value = 12000;
      _patchPrefs({ frf_x_min: 100, frf_x_max: 12000 });
    }
    if (e['yaxis.range[0]'] != null) {
      _S.yMin = e['yaxis.range[0]']; _S.yMax = e['yaxis.range[1]'];
    } else if (e['yaxis.autorange']) {
      _S.yMin = null; _S.yMax = null;
    }
  });
}

// Called once from Python after proxies are registered
window.onPyReady = function() {
  const prefs = _loadPrefs();
  _pushSettingsFromPrefs(prefs);  // calls pyApplySettings which initialises positions
  // Auto-start: probe with getUserMedia first (establishes permission + real device IDs),
  // release the test stream, then start acquisition with the saved specific device.
  // If no audio device is available the probe throws and we leave the button at Start.
  // Simulated mode is excluded — user must press Start explicitly.
  if (_loadPrefs().deviceId !== '__simulated__') {
    setTimeout(async () => {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach(t => t.stop());
        acqToggleAcquire();
      } catch (_) {}
    }, 100);
  }
};

window.addEventListener('load', () => {
  const prefs = _loadPrefs();
  _hamTimeCutoffS = prefs.time_cutoff_s     ?? prefs.post_trig_s ?? 0.30;
  _micTimeCutoffS = prefs.mic_time_cutoff_s ?? prefs.time_cutoff_s ?? prefs.post_trig_s ?? 0.30;
  _lineWidth      = prefs.line_width        ?? 0.5;
  _S.xMin         = prefs.frf_x_min ?? 200;
  _S.xMax         = prefs.frf_x_max ?? 7000;
  _S.yMin         = prefs.frf_y_min ?? -10;
  _S.yMax         = prefs.frf_y_max ?? 30;
  _hamXRange      = [prefs.ham_x_min ?? 0,    prefs.ham_x_max ?? 0.05];
  _hamYRange      = [prefs.ham_y_min ?? -0.1, prefs.ham_y_max ?? 1];
  _micXRange      = [prefs.mic_x_min ?? 0,    prefs.mic_x_max ?? 0.3];
  _micYRange      = [prefs.mic_y_min ?? -1,   prefs.mic_y_max ?? 1];
  _fftXRange      = [prefs.fft_x_min ?? 200,  prefs.fft_x_max ?? 10000];
  _fftYRange      = [prefs.fft_y_min ?? -25,  prefs.fft_y_max ?? 0];
  _hamXRange      = [prefs.ham_x_min ?? 0,  prefs.ham_x_max ?? 0.1];
  _micXRange      = [prefs.mic_x_min ?? 0,  prefs.mic_x_max ?? 0.3];
  const instrEl = document.getElementById('inp-instrument-banner');
  if (instrEl && instrEl.textContent.trim() === '—') instrEl.textContent = prefs.instrument || 'scratch';
  try { _initPlots(); } catch (e) { console.warn('Plotly not available — plots disabled:', e); }
  _initResizer();
  _updateStopBtn();
  _updateEditBtns({ hit_n: 0 });
  _updateSoundcardDisplay();
  _updateInfoPanel();

  // Try to auto-restore a previously selected data folder (no user gesture needed
  // if the browser already granted permission in this origin).
  const storedName = localStorage.getItem('obieDataFolderName');
  const sub = document.getElementById('folder-overlay-sub');
  if (storedName && sub) sub.textContent = `Last used: "${storedName}" — or click to pick a folder`;
  loadDataFolderHandle().then(async handle => {
    if (!handle) return;
    try {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        await _applyDataFolder(handle);
        return;
      }
    } catch (_) {}
    // Permission not yet granted — overlay stays; user must click to re-grant
    if (sub && storedName)
      sub.textContent = `"${storedName}" needs permission — click to reconnect`;
  }).catch(() => {});
});
