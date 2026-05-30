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
let _lineWidth    = 0.5;    // FRF trace width in px
let _S = {
  xLog: true, xMin: 100, xMax: 12000,
  yMin: null, yMax: null,
  yDbRange: 30,
};

// Per-mini-plot y-range locks (null = auto)
let _fftYRange  = null;
let _hamYRange  = null;
let _micYRange  = null;

// ── Colour palette (same as Explore) ─────────────────────────────────────────
const PALETTE = [
  '#ff6f00','#2196f3','#4caf50','#e91e63','#9c27b0',
  '#00bcd4','#ff5722','#8bc34a','#ffc107','#607d8b',
  '#f44336','#3f51b5','#009688','#ff9800','#795548',
];

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
  const pkH = Math.max(...ham.map(Math.abs), 0.05);
  const pkM = Math.max(...mic.map(Math.abs), 0.05);
  const hamShapes = [hDot(thrF, '#7c2bc8'), vLine(_hamTimeCutoffS, '#2e7d32')];
  const micShapes = [vLine(_micTimeCutoffS, '#2e7d32')];

  Plotly.react('plot-hammer',
    [{ x: t, y: ham, type: 'scatter', mode: 'lines', line: { color: '#c62828', width: 1 } }],
    miniLayout('Hammer', 'Time (s)', 'V', {},
      _hamYRange ? { range: _hamYRange } : { range: [-pkH*1.2, pkH*1.2] },
      hamShapes),
    PCFG);

  Plotly.react('plot-mic',
    [{ x: t, y: mic, type: 'scatter', mode: 'lines', line: { color: '#1565c0', width: 1 } }],
    miniLayout('Microphone', 'Time (s)', 'V', {},
      _micYRange ? { range: _micYRange } : { range: [-pkM*1.2, pkM*1.2] },
      micShapes),
    PCFG);
}


/** Hammer FFT — normalized to 0 dB peak within the display window */
window.onHammerFFT = function(freq_js, db_js) {
  const freqAll  = Array.from(freq_js).map(Number);
  const dbAll    = Array.from(db_js).map(Number);
  const fMax     = Math.min(_S.xMax, freqAll[freqAll.length - 1] || _S.xMax);

  // Build arrays, skip DC bin (freq=0 breaks log axis)
  const freq = [], db = [];
  for (let i = 0; i < freqAll.length; i++) {
    if (freqAll[i] > 0) { freq.push(freqAll[i]); db.push(dbAll[i]); }
  }
  if (!freq.length) return;

  // Normalize by the peak within the displayed band
  let peak = -1e9;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= 200 && freq[i] <= fMax && isFinite(db[i]) && db[i] > peak)
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
      { type: 'log', range: [Math.log10(200), Math.log10(fMax)] },
      { range: [-25, 0] }),
    PCFG);
};

/** FRF updated for one position — cache and re-render main plot */
window.onFRFUpdate = function(freq_js, H1db_js, coh_js, pos, nHits) {
  const freq = Array.from(freq_js), H1db = Array.from(H1db_js);
  const coh  = Array.from(coh_js);
  const p = Number(pos);
  if (freq.length > 0) {
    frfCache[p] = { freq, H1db, coh, nHits: Number(nHits) };
  } else {
    delete frfCache[p];
  }
  renderFRF();
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
  else if (s.state === 'complete')  { txt = `✓ Run complete — ${s.n_positions} positions measured`; cls = 'complete'; }
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

/** Auto-save hit WAV to run folder */
window.onSaveHit = async function(b64, pos, hitN) {
  if (!_rawHandle) return;
  const pfx = (document.getElementById('inp-prefix')?.value || 'H').trim();
  const p   = String(Number(pos) + 1).padStart(3, '0');
  const h   = String(Number(hitN)).padStart(3, '0');
  const inst = _runName || 'run';
  await _writeFile(_rawHandle, `${inst} ${pfx}_${p}_${h}.wav`, b64);
};

/** Auto-save TRF when position completes */
window.onSaveTRF = async function(b64, pos) {
  if (!_trfHandle) return;
  const pfx = (document.getElementById('inp-prefix')?.value || 'H').trim();
  const p   = String(Number(pos) + 1).padStart(3, '0');
  const inst = _runName || 'run';
  await _writeFile(_trfHandle, `${inst} ${pfx}_${p}.trf`, b64);
};

/** Manual download fallback */
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
// Main FRF plot
// ════════════════════════════════════════════════════════════════════════════

function renderFRF() {
  const traces = [];
  const positions = Object.keys(frfCache).map(Number).sort((a,b)=>a-b);

  const pfx = document.getElementById('inp-prefix')?.value || 'H';
  positions.forEach((pos, idx) => {
    const d = frfCache[pos];
    if (!d || !d.freq.length) return;
    const mags  = d.H1db;
    const valid = mags.filter(v => isFinite(v) && v > -200);
    if (!valid.length) return;
    const color = PALETTE[pos % PALETTE.length];
    const label = `${pfx}${String(pos+1).padStart(2,'0')} (${d.nHits} hits)`;
    traces.push({
      x: d.freq, y: mags,
      type: 'scatter', mode: 'lines',
      name: label,
      yaxis: 'y',
      line: { color, width: _lineWidth },
      showlegend: true,
    });
    if (d.coh?.length) {
      traces.push({
        x: d.freq, y: d.coh,
        type: 'scatter', mode: 'lines',
        name: label,
        yaxis: 'y2',
        line: { color: '#1565c0', width: _lineWidth },
        showlegend: false,
        hoverinfo: 'skip',
      });
    }
  });

  if (!traces.length) {
    traces.push({ x: [], y: [], type: 'scatter', mode: 'lines', showlegend: false });
  }

  // Y range — use 99th-percentile max so a few noisy outlier bins don't
  // push the real data to the bottom of the plot.
  let yRange;
  if (_S.yMin != null && _S.yMax != null) {
    yRange = [_S.yMin, _S.yMax];
  } else {
    const allY = [];
    for (const t of traces)
      for (const v of t.y)
        if (isFinite(v) && v > -200) allY.push(v);
    if (allY.length) {
      allY.sort((a, b) => a - b);
      const maxY = allY[Math.floor(allY.length * 0.99)];
      yRange = [maxY - _S.yDbRange, maxY + 2];
    }
  }

  const xRange = _S.xLog
    ? [Math.log10(Math.max(_S.xMin, 1)), Math.log10(_S.xMax)]
    : [_S.xMin, _S.xMax];

  Plotly.react('acq-plot', traces, {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    margin: { l: 58, r: 52, t: 12, b: 50 },
    font: { size: 11, family: 'inherit' },
    showlegend: traces.length > 1,
    legend: { font: { size: 9 }, x: 1, xanchor: 'right', y: 1 },
    xaxis: {
      type: _S.xLog ? 'log' : 'linear',
      title: { text: 'Frequency (Hz)', font: { size: 11 } },
      range: xRange,
      gridcolor: '#c0c4cc', tickfont: { size: 10 },
    },
    yaxis: {
      title: { text: 'Intensity (dB)', font: { size: 11 } },
      range: yRange,
      gridcolor: '#c0c4cc', tickfont: { size: 10 },
    },
    yaxis2: {
      title: { text: 'Coherence', font: { size: 11 } },
      range: [-0.5, 1.5],
      overlaying: 'y',
      side: 'right',
      showgrid: false,
      tickfont: { size: 10 },
      tickvals: [0, 0.5, 1],
    },
    autosize: true,
  }, { ...PCFG, displayModeBar: true, displaylogo: false,
       modeBarButtonsToRemove: ['sendDataToCloud'] });
}


// ════════════════════════════════════════════════════════════════════════════
// Toolbar controls
// ════════════════════════════════════════════════════════════════════════════

window.acqRescaleY = function() {
  _S.yMin = null; _S.yMax = null;
  renderFRF();
};

window.acqSetYDbRange = function(val) {
  _S.yDbRange = parseFloat(val) || 30;
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
  acqSavePrefs();
};

window.acqApplyHamCutoff = function(val) {
  const v = Math.max(0.01, parseFloat(val) || 0.30);
  const el = document.getElementById('inp-ham-cut-disp');
  if (el) el.value = v.toFixed(3);
  const pref = document.getElementById('inp-time-cutoff');
  if (pref) pref.value = v;
  _hamTimeCutoffS = v;
  if (_lastTrigData) { const { t, ham, mic, thr } = _lastTrigData; _drawTrigPlots(t, ham, mic, thr); }
  acqSavePrefs();
};

window.acqApplyMicCutoff = function(val) {
  const v = Math.max(0.01, parseFloat(val) || 0.30);
  const el = document.getElementById('inp-mic-cut-disp');
  if (el) el.value = v.toFixed(3);
  const pref = document.getElementById('inp-mic-time-cutoff');
  if (pref) pref.value = v;
  _micTimeCutoffS = v;
  if (_lastTrigData) { const { t, ham, mic, thr } = _lastTrigData; _drawTrigPlots(t, ham, mic, thr); }
  acqSavePrefs();
};

function _updateSoundcardDisplay() {
  const el = document.getElementById('soundcard-ind');
  if (!el) return;
  const sc = _loadPrefs().soundcard || '';
  el.textContent = sc ? `Sound card: ${sc}` : '';
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
};

window.acqStartOver = async function() {
  if (!confirm('Clear all positions and start over from the beginning?')) return;
  if (appState !== 'idle' && appState !== 'complete') await _stopAudio();
  frfCache = {};
  renderFRF();
  if (window.pyResetAll) window.pyResetAll();
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
}


// ════════════════════════════════════════════════════════════════════════════
// Settings dropdown
// ════════════════════════════════════════════════════════════════════════════

window.acqSettings = function(e) {
  e.stopPropagation();
  const m = document.getElementById('settings-menu');
  if (!m) return;
  m.classList.toggle('open');
  document.body.addEventListener('click', () => m.classList.remove('open'), { once: true });
};

window.acqPreferences = function() {
  document.getElementById('settings-menu')?.classList.remove('open');
  document.getElementById('prefs-modal')?.classList.add('open');
  _populatePrefsForm();
};

window.acqClosePrefs = function() {
  document.getElementById('prefs-modal')?.classList.remove('open');
};

function _populatePrefsForm(overridePrefs) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el && val != null) el.value = val;
  };
  const prefs = overridePrefs || _loadPrefs();
  set('inp-threshold',   prefs.threshold);
  set('inp-thr-disp',    Number(prefs.threshold ?? 0.05).toFixed(3));
  set('inp-frf-x-min',   prefs.frf_x_min);
  set('inp-frf-x-max',   prefs.frf_x_max);
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
  set('inp-soundcard',   prefs.soundcard);
  const instrVal = prefs.instrument || 'scratch';
  set('inp-instrument',        instrVal);
  set('inp-instrument-banner', instrVal);
  set('inp-line-width',  prefs.line_width);
  // populate device selector
  _enumeratePrefsDevices();
}

function _loadPrefs() {
  try {
    return {
      threshold: 0.05, pre_trig_s: 0.01, post_trig_s: 0.30,
      time_cutoff_s: 0.30, mic_time_cutoff_s: 0.30,
      taps: 5, positions: 12, prefix: 'H',
      mic_cal: 1.0, ham_cal: 1.0, swap_channels: false,
      frf_x_min: 100, frf_x_max: 12000,
      soundcard: '', instrument: 'scratch', deviceId: '', line_width: 0.5,
      ...JSON.parse(localStorage.getItem('obieAcquire_prefs') || '{}'),
    };
  } catch (_) {
    return { threshold: 0.05, pre_trig_s: 0.01, post_trig_s: 0.30,
             time_cutoff_s: 0.30, mic_time_cutoff_s: 0.30,
             taps: 5, positions: 12, prefix: 'H', mic_cal: 1.0, ham_cal: 1.0,
             swap_channels: false, frf_x_min: 100, frf_x_max: 12000,
             soundcard: '', instrument: 'scratch', deviceId: '', line_width: 0.5 };
  }
}

window.acqSavePrefs = function() {
  const g = id => document.getElementById(id)?.value ?? '';
  const prefs = {
    threshold:     parseFloat(g('inp-threshold'))   || 0.05,
    frf_x_min:     parseFloat(g('inp-frf-x-min'))   || 100,
    frf_x_max:     parseFloat(g('inp-frf-x-max'))   || 12000,
    pre_trig_s:    parseFloat(g('inp-pre'))         || 0.01,
    post_trig_s:   parseFloat(g('inp-post'))        || 0.30,
    time_cutoff_s:     parseFloat(g('inp-time-cutoff'))     || 0.30,
    mic_time_cutoff_s: parseFloat(g('inp-mic-time-cutoff')) || 0.30,
    taps:          parseInt(g('inp-taps'))          || 5,
    positions:     parseInt(g('inp-positions'))     || 12,
    prefix:        g('inp-prefix')                  || 'H',
    mic_cal:       parseFloat(g('inp-mic-cal'))     || 1.0,
    ham_cal:       parseFloat(g('inp-ham-cal'))     || 1.0,
    swap_channels: document.getElementById('inp-swap-channels')?.checked ?? false,
    soundcard:     g('inp-soundcard'),
    instrument:    g('inp-instrument'),
    deviceId:      g('prefs-device'),
    line_width:    parseFloat(g('inp-line-width'))  || 0.5,
  };
  localStorage.setItem('obieAcquire_prefs', JSON.stringify(prefs));
  _saveAcqSettings();
  _pushSettingsFromPrefs(prefs);
  _updateSoundcardDisplay();
  const st = document.getElementById('prefs-save-msg');
  if (st) { st.textContent = '✓ Saved'; setTimeout(() => st.textContent = '', 2500); }
};

window.acqResetPrefs = async function() {
  const st = document.getElementById('prefs-save-msg');
  if (_settingsHandle) {
    try {
      const file  = await (await _settingsHandle.getFileHandle('acquire.json')).getFile();
      const prefs = JSON.parse(await file.text());
      localStorage.setItem('obieAcquire_prefs', JSON.stringify(prefs));
      _populatePrefsForm(prefs);
      _pushSettingsFromPrefs(prefs);
      if (st) { st.textContent = '✓ Restored from disk'; setTimeout(() => st.textContent = '', 2500); }
      return;
    } catch (_) {}
  }
  localStorage.removeItem('obieAcquire_prefs');
  _populatePrefsForm();
  if (st) { st.textContent = '✓ Reset to defaults'; setTimeout(() => st.textContent = '', 2500); }
};

function _pushSettingsFromPrefs(prefs) {
  _hamTimeCutoffS  = prefs.time_cutoff_s     ?? prefs.post_trig_s ?? 0.30;
  _micTimeCutoffS  = prefs.mic_time_cutoff_s ?? prefs.time_cutoff_s ?? prefs.post_trig_s ?? 0.30;
  _lineWidth       = prefs.line_width        ?? 0.5;
  _S.xMin          = prefs.frf_x_min        ?? 100;
  _S.xMax          = prefs.frf_x_max        ?? 12000;
  renderFRF();
  if (!window.pyApplySettings) return;
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
    devices.filter(d => d.kind === 'audioinput').forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Mic (${d.deviceId.slice(0, 8)}…)`;
      if (d.deviceId === saved) o.selected = true;
      sel.appendChild(o);
    });
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
  const st = document.getElementById('notes-save-msg');
  if (st) { st.textContent = '✓ Saved'; setTimeout(() => st.textContent = '', 2000); }
};


// ════════════════════════════════════════════════════════════════════════════
// Template modal
// ════════════════════════════════════════════════════════════════════════════

window.acqTemplate = function() {
  document.getElementById('template-modal')?.classList.add('open');
  _selectedTpl = null;
  _renderTemplateList();
  const pre = document.getElementById('tpl-json');
  const lbl = document.getElementById('tpl-json-lbl');
  if (pre) pre.textContent = '';
  if (lbl) lbl.textContent = 'Select a template above to preview its settings';
};

window.acqCloseTemplate = function() {
  document.getElementById('template-modal')?.classList.remove('open');
};

let _templates = [];
let _selectedTpl = null;

function _tplMeta(s) {
  const bits = [];
  if (s.taps      != null) bits.push(`${s.taps} hits`);
  if (s.frf_x_max != null) bits.push(`≤${s.frf_x_max} Hz`);
  if (s.threshold != null) bits.push(`thr ${s.threshold}`);
  if (s.ham_cal   != null && s.ham_cal !== 1) bits.push(`ham×${s.ham_cal}`);
  if (s.mic_cal   != null && s.mic_cal !== 1) bits.push(`mic×${s.mic_cal}`);
  return bits.join(' · ');
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
          <div class="tpl-item${_selectedTpl === i ? ' selected' : ''}" onclick="acqSelectTpl(${i})">
            <div class="tpl-name">${t.name || 'Unnamed'}</div>
            ${meta ? `<div class="tpl-desc">${meta}</div>` : ''}
          </div>`;
      }).join('')
    : '<div style="font-size:11px;color:var(--muted);padding:4px 0">No saved templates — set a Data Folder to load from <code>ObieAppSettings/Templates/</code>, or use Browse.</div>';

  container.innerHTML = currentItem + list;
}

window.acqSelectTpl = function(i) {
  _selectedTpl = i;
  _renderTemplateList();
  const pre = document.getElementById('tpl-json');
  const lbl = document.getElementById('tpl-json-lbl');
  if (!pre) return;

  if (i === -1) {
    // Current Settings
    const p = { ..._loadPrefs() };
    delete p.soundcard; delete p.deviceId;
    pre.textContent = JSON.stringify(p, null, 2);
    if (lbl) lbl.textContent = 'Current Settings (soundcard excluded):';
  } else if (_templates[i]) {
    const t = _templates[i];
    const s = { ...(t.settings || t.run || t) };
    delete s.soundcard;
    const display = { name: t.name || 'Unnamed' };
    if (t.description) display.description = t.description;
    display.settings = s;
    pre.textContent = JSON.stringify(display, null, 2);
    if (lbl) lbl.textContent = `${t.name || 'Template'} — settings (soundcard excluded):`;
  } else {
    pre.textContent = '';
    if (lbl) lbl.textContent = 'Select a template above to preview its settings';
  }
};

window.acqBrowseTemplate = async function() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files[0]; if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      // Support both single template object and array
      const arr  = Array.isArray(data) ? data : [data];
      _templates = arr;
      _selectedTpl = arr.length === 1 ? 0 : null;
      _renderTemplateList();
    } catch (e) {
      alert('Invalid JSON template: ' + e.message);
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
  // soundcard intentionally skipped — keep the current soundcard on import
  _currentTemplateName = t.name || '';
  const tplInd = document.getElementById('tpl-ind');
  if (tplInd) tplInd.textContent = _currentTemplateName;
  window.acqSavePrefs();
  window.acqCloseTemplate();
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
  const tpl = {
    name:        name.trim(),
    description: `${prefs.instrument || ''}  ${new Date().toISOString().slice(0, 10)}`.trim(),
    settings:    prefs,
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


// ════════════════════════════════════════════════════════════════════════════
// Data folder management (File System Access API)
// ════════════════════════════════════════════════════════════════════════════

const HAS_FS = typeof window.showDirectoryPicker === 'function';
let _rawHandle       = null;
let _trfHandle       = null;
let _runName         = '';
let _settingsHandle  = null;   // ObieAppSettings/ dir inside the data folder
let _templatesHandle = null;   // ObieAppSettings/Templates/ dir
let _testsHandle     = null;   // <instrument>/test/ dir (set when data folder chosen)
let _rootDirHandle   = null;   // root data folder handle
let _pendingTestName = '';  // proposed test folder name, editable before first Start
let _currentTemplateName = '';  // template last applied

window.acqUpdatePendingTest = function(val) { _pendingTestName = val.trim(); };

// Core folder-setup logic, callable with any directory handle (manual pick or auto-restore)
async function _applyDataFolder(dirHandle) {
  _rootDirHandle = dirHandle;

  // ObieAppSettings first — gives us the saved instrument name
  ({ settingsHandle: _settingsHandle, templatesHandle: _templatesHandle } =
      await openObieAppSettings(dirHandle));

  // Load saved prefs (instrument name comes from here)
  let savedPrefs = null;
  try {
    const file = await (await _settingsHandle.getFileHandle('acquire.json')).getFile();
    savedPrefs  = JSON.parse(await file.text());
    _populatePrefsForm(savedPrefs);
    _pushSettingsFromPrefs(savedPrefs);
  } catch (_) {}

  // Determine instrument name: banner > prefs > 'scratch'
  const instrument =
    (document.getElementById('inp-instrument-banner')?.value.trim()) ||
    (savedPrefs?.instrument || '') ||
    'scratch';

  // Structure: DataFolder/<instrument>/<instrument>_XX/raw, TRF
  const instrHandle = await dirHandle.getDirectoryHandle(instrument, { create: true });
  let maxNum = 0;
  for await (const [name, h] of instrHandle.entries()) {
    if (h.kind === 'directory') {
      const m = name.match(/_(\d+)$/);
      if (m) { const n = parseInt(m[1]); if (n > maxNum) maxNum = n; }
    }
  }
  _pendingTestName = `${instrument}_${String(maxNum + 1).padStart(2, '0')}`;
  _testsHandle     = instrHandle;

  const instrBannerEl = document.getElementById('inp-instrument-banner');
  if (instrBannerEl && !instrBannerEl.value) instrBannerEl.value = instrument;
  const testBannerEl = document.getElementById('inp-test-banner');
  if (testBannerEl) testBannerEl.value = _pendingTestName;

  _rawHandle = null;   // created on first Start
  _trfHandle = null;
  _runName   = '';

  // Load templates
  _templates = [];
  await _loadTemplatesFromFolder(_templatesHandle);

  const btn = document.getElementById('data-folder-btn');
  if (btn) btn.textContent = '📁 ' + dirHandle.name;
  const ind = document.getElementById('folder-name-ind');
  if (ind) ind.textContent = _pendingTestName || dirHandle.name;

  // Hide the no-folder overlay
  document.getElementById('folder-overlay')?.classList.add('hidden');
}

window.acqSetDataFolder = async function() {
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
  await _applyDataFolder(dirHandle);
  await saveDataFolderHandle(dirHandle);
};

async function _writeFile(folderHandle, filename, b64) {
  const raw   = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const fh = await folderHandle.getFileHandle(filename, { create: true });
  const w  = await fh.createWritable();
  await w.write(bytes); await w.close();
}

async function _saveAcqSettings() {
  if (!_settingsHandle) return;
  try {
    const json = JSON.stringify(_loadPrefs(), null, 2);
    const fh   = await _settingsHandle.getFileHandle('acquire.json', { create: true });
    const w    = await fh.createWritable();
    await w.write(json);
    await w.close();
  } catch (e) { console.warn('_saveAcqSettings:', e); }
}

async function _loadTemplatesFromFolder(dir) {
  try {
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || !name.toLowerCase().endsWith('.json')) continue;
      try {
        const tpl = JSON.parse(await (await h.getFile()).text());
        _templates.push(...(Array.isArray(tpl) ? tpl : [tpl]));
      } catch (_) {}
    }
  } catch (_) {}
  _renderTemplateList();
}


// ════════════════════════════════════════════════════════════════════════════
// LiveView
// ════════════════════════════════════════════════════════════════════════════

window.acqLiveView = function() {
  window.open('liveview.html', '_blank');
};


// ════════════════════════════════════════════════════════════════════════════
// Time-cutoff interaction (click on hammer or mic mini plot)
// ════════════════════════════════════════════════════════════════════════════



// ════════════════════════════════════════════════════════════════════════════
// Audio — start / stop
// ════════════════════════════════════════════════════════════════════════════

window.acqToggleAcquire = async function() {
  if (appState === 'idle' || appState === 'complete') {
    await _startAudio();
  } else {
    await _stopAudio();
  }
};

async function _startAudio() {
  const prefs    = _loadPrefs();
  const deviceId = prefs.deviceId;

  // Create the test run folder on the very first Start after a data folder is set
  if (_testsHandle && !_rawHandle && _pendingTestName) {
    try {
      const testName = document.getElementById('inp-test-banner')?.value.trim() || _pendingTestName;
      _pendingTestName = testName;
      const testHandle = await _testsHandle.getDirectoryHandle(testName, { create: true });
      _rawHandle = await testHandle.getDirectoryHandle('raw', { create: true });
      _trfHandle = await testHandle.getDirectoryHandle('TRF', { create: true });
      _runName   = testName;
      // Copy settings into test folder
      const fh1 = await testHandle.getFileHandle('settings.json', { create: true });
      const w1  = await fh1.createWritable();
      await w1.write(JSON.stringify(_loadPrefs(), null, 2));
      await w1.close();
      // Copy notes if any exist
      const notes = localStorage.getItem('obieAcquire_notes_' + testName)
                 || localStorage.getItem('obieAcquire_notes_default') || '';
      if (notes) {
        const fh2 = await testHandle.getFileHandle('notes.txt', { create: true });
        const w2  = await fh2.createWritable();
        await w2.write(notes);
        await w2.close();
      }
      const ind = document.getElementById('folder-name-ind');
      if (ind) ind.textContent = testName;
    } catch (e) { console.warn('Failed to create test folder:', e); }
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId:         deviceId ? { exact: deviceId } : undefined,
        channelCount:     { ideal: 2 },
        sampleRate:       { ideal: 44100 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      },
    });
    audioCtx = new AudioContext();
    const sr = audioCtx.sampleRate;
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
    window.pyArm();
  } catch (err) {
    if (err.name === 'NotAllowedError') return;
    const sc = _loadPrefs().soundcard || '';
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      alert(`Cannot find soundcard${sc ? ' "' + sc + '"' : ''} — turn it on or reset in Preferences.`);
    } else {
      alert('Audio error: ' + err.message);
    }
  }
}

async function _stopAudio() {
  if (workletNode)  { workletNode.disconnect(); workletNode = null; }
  if (sourceNode)   { sourceNode.disconnect();  sourceNode  = null; }
  if (audioCtx)     { await audioCtx.close();   audioCtx   = null; }
  if (mediaStream)  { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  window.pyStopAudio();
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

function _initPlots() {
  const empty = { x: [], y: [], type: 'scatter', mode: 'lines' };
  const fftColor  = '#7c4dbe';
  const hamColor  = '#c62828';
  const micColor  = '#1565c0';

  Plotly.newPlot('plot-fft',
    [{ ...empty, line: { color: fftColor, width: 1 } }],
    miniLayout('Hammer FFT', 'Hz', 'dB',
      { type: 'log', range: [Math.log10(200), Math.log10(10000)] },
      { range: [-25, 0] }),
    PCFG);

  Plotly.newPlot('plot-hammer',
    [{ ...empty, line: { color: hamColor, width: 1 } }],
    miniLayout('Hammer', 'Time (s)', 'V'),
    PCFG);

  Plotly.newPlot('plot-mic',
    [{ ...empty, line: { color: micColor, width: 1 } }],
    miniLayout('Microphone', 'Time (s)', 'V'),
    PCFG);

  // Persist user zoom/pan so new hits don't reset the scale.
  // Programmatic Plotly.react calls also fire relayout, but only with
  // 'yaxis.range[0]' when the user explicitly drags — we capture those only.
  document.getElementById('plot-hammer').on('plotly_relayout', e => {
    if (e['yaxis.range[0]'] != null) _hamYRange = [e['yaxis.range[0]'], e['yaxis.range[1]']];
    else if (e['yaxis.autorange'])   _hamYRange = null;
  });
  document.getElementById('plot-mic').on('plotly_relayout', e => {
    if (e['yaxis.range[0]'] != null) _micYRange = [e['yaxis.range[0]'], e['yaxis.range[1]']];
    else if (e['yaxis.autorange'])   _micYRange = null;
  });

  renderFRF();
}

// Called once from Python after proxies are registered
window.onPyReady = function() {
  const prefs = _loadPrefs();
  _pushSettingsFromPrefs(prefs);
  window.pyInitPositions(prefs.positions || 12);
  // Auto-start acquisition; silently skipped if browser blocks without user gesture
  setTimeout(() => acqToggleAcquire(), 100);
};

window.addEventListener('load', () => {
  const prefs = _loadPrefs();
  _hamTimeCutoffS = prefs.time_cutoff_s     ?? prefs.post_trig_s ?? 0.30;
  _micTimeCutoffS = prefs.mic_time_cutoff_s ?? prefs.time_cutoff_s ?? prefs.post_trig_s ?? 0.30;
  _lineWidth      = prefs.line_width        ?? 0.5;
  _S.xMin         = prefs.frf_x_min        ?? 100;
  _S.xMax         = prefs.frf_x_max        ?? 12000;
  const instrEl = document.getElementById('inp-instrument-banner');
  if (instrEl && !instrEl.value) instrEl.value = prefs.instrument || 'scratch';
  const hiddenEl = document.getElementById('inp-instrument');
  if (hiddenEl) hiddenEl.value = instrEl?.value || 'scratch';
  _initPlots();
  _initResizer();
  _updateStopBtn();
  _updateEditBtns({ hit_n: 0 });
  _updateSoundcardDisplay();

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
