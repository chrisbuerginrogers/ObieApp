'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// spectrum.js — Spectrum Monitor tool
//
// Live single-channel microphone scope: raw waveform + an averaged magnitude
// spectrum (block average of the last N ~0.3 s snippets — see main.py's
// _process_snippet, which does the actual FFT/averaging math via numpy) and
// an on-demand scrolling spectrogram via the canonical processing/
// spectrogram.py. Audio capture (getUserMedia + AudioWorklet) is plain JS
// with no Python equivalent, matching the precedent set by tools/liveview.
//
// Settings (device / channel / N / snippet length) persist to
// ObieAppSettings/spectrum.json in the shared Data Folder, layered under
// this browser's obieSpectrum_prefs localStorage — same pattern as LiveView.
// ═══════════════════════════════════════════════════════════════════════════

// State referenced by _pcfgFor()/_redrawConfigOnly() below — declared first
// since those are called immediately (at the initial Plotly.newPlot calls).
let _running = false;
let _paused  = false;
let _channel = 1;
let _view    = 'scope';

// Modebar (the grey Plotly toolbar band) is distracting during continuous
// live redraws, so it's only shown while stopped or paused — i.e. whenever
// the user might actually want to zoom/pan/export a frozen plot.
function _pcfgFor() {
  return { ...pcfg, displayModeBar: !_running || _paused, displaylogo: false };
}
const _wl = (title, xl, yl, extra) => ({
  ...plotLayout(title, xl, yl, extra), paper_bgcolor: '#fff', plot_bgcolor: '#fff',
});

Plotly.newPlot('sm-wave-plot', [], _wl('Waveform', 'Time (s)', 'Amplitude',
  { xaxis: { range: [0, 0.3] }, yaxis: { range: [-1, 1] }, uirevision: 'keep' }), _pcfgFor());
Plotly.newPlot('sm-spectrum-plot', [], _wl('Spectrum', 'Frequency (Hz)', 'dB',
  { xaxis: { type: 'log', range: [Math.log10(20), Math.log10(20000)] }, yaxis: { range: [-80, 0] }, uirevision: 'keep' }), _pcfgFor());
Plotly.newPlot('sm-spectrogram-plot', [], _wl('Spectrogram', 'Time (s)', 'Frequency (Hz)', { uirevision: 'keep' }), _pcfgFor());

// Cached last-rendered traces so the modebar can be shown/hidden instantly
// (via _redrawConfigOnly) on pause/stop without waiting for the next tick.
let _lastWave = null, _lastSpectrum = null, _lastSpectrogram = null;

function _redrawConfigOnly() {
  const cfg = _pcfgFor();
  if (_lastWave) {
    Plotly.react('sm-wave-plot', [_lastWave.trace],
      _wl(`Waveform — Ch ${_channel}`, 'Time (s)', 'Amplitude', { uirevision: 'keep' }), cfg);
  }
  if (_lastSpectrum) {
    Plotly.react('sm-spectrum-plot', [_lastSpectrum.trace],
      _wl(`Spectrum — ${_lastSpectrum.count} snippet${_lastSpectrum.count === 1 ? '' : 's'} averaged`,
        'Frequency (Hz)', 'dB', { xaxis: { type: 'log' }, uirevision: 'keep' }), cfg);
  }
  if (_lastSpectrogram) {
    Plotly.react('sm-spectrogram-plot', [_lastSpectrogram.trace],
      _wl(`Spectrogram — Ch ${_channel}`, 'Time (s)', 'Frequency (Hz)', { uirevision: 'keep' }), cfg);
  }
}

// ── Data folder + settings ──────────────────────────────────────────────────
let _rootDirHandle  = null;
let _settingsHandle = null;
let _diskPrefs      = {};

function _loadPrefs() {
  let local = {};
  try { local = JSON.parse(localStorage.getItem('obieSpectrum_prefs') || '{}'); } catch (_) {}
  return { ..._diskPrefs, ...local };
}

function _patchPrefs(patch) {
  const merged = { ..._loadPrefs(), ...patch };
  try { localStorage.setItem('obieSpectrum_prefs', JSON.stringify(merged)); } catch (_) {}
  // Auto-persist to the Data Folder too, if one is set — no explicit "save" button;
  // every change (device/channel/N/snippet) is immediately durable across browsers.
  _diskPrefs = { ..._diskPrefs, ...patch };
  if (_settingsHandle) _writeDiskPrefs();
}

async function _writeDiskPrefs() {
  try {
    const fh = await _settingsHandle.getFileHandle('spectrum.json', { create: true });
    const w  = await fh.createWritable();
    await w.write(JSON.stringify(_diskPrefs, null, 2));
    await w.close();
  } catch (_) { /* best-effort — localStorage already has it */ }
}

async function _applyDataFolder(dirHandle) {
  _rootDirHandle = dirHandle;
  const { settingsHandle, isNew } = await openObieAppSettings(dirHandle);
  _settingsHandle = settingsHandle;
  if (isNew) alert('This is a new Data Folder and I moved over the default settings folder.');

  try {
    const file = await (await _settingsHandle.getFileHandle('spectrum.json')).getFile();
    _diskPrefs = JSON.parse(await file.text());
  } catch (_) {
    _diskPrefs = {};
  }

  const btn = document.getElementById('sm-folder-btn');
  if (btn) btn.textContent = '📁 ' + dirHandle.name;
  const nameEl = document.getElementById('sm-folder-name');
  if (nameEl) nameEl.textContent = dirHandle.name;

  _applyPrefsToForm();
  await _enumerateDevicesInto('device-picker-select');
  _updateSoundcardDisplay();
}

window.smSetDataFolder = async function() {
  if (!window.showDirectoryPicker) { alert('Directory picker requires Chrome/Edge.'); return; }
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e.name !== 'AbortError') alert('Folder error: ' + e.message);
    return;
  }
  try {
    await _applyDataFolder(dirHandle);
    await saveDataFolderHandle(dirHandle);
  } catch (e) {
    alert('Folder error: ' + e.message);
  }
};

function _applyPrefsToForm() {
  const p = _loadPrefs();
  const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  set('sm-inp-navg', p.n_avg     ?? 5);
  set('sm-inp-snip', p.snippet_s ?? 0.3);
  smSetChannel(p.channel === 2 ? 2 : 1);
}

window.smHelp = function() { window.open('../../Docs/index.html', '_blank'); };

// ── Device picker (mirrors Acquire's Device: … indicator + popup) ──────────

function _updateSoundcardDisplay() {
  const el = document.getElementById('soundcard-ind');
  if (!el) return;
  const label = _loadPrefs().deviceLabel || '';
  el.textContent = label ? `Device: ${label}` : '';
}

window.smOpenDevicePicker = async function() {
  document.getElementById('device-picker-modal')?.classList.add('active');
  await _enumerateDevicesInto('device-picker-select');
};
window.smCloseDevicePicker = function() {
  document.getElementById('device-picker-modal')?.classList.remove('active');
};
window.smRecheckDevices = function() { _enumerateDevicesInto('device-picker-select'); };
window.smApplyDeviceSelection = function() { _applyDeviceChangeFromSelect('device-picker-select'); };

async function _enumerateDevicesInto(selectId) {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const saved = _loadPrefs().deviceId || '';
    sel.innerHTML = '<option value="">Default device</option>';
    let savedFound = false;
    const SKIP = new Set(['default', 'communications']);
    devices.filter(d => d.kind === 'audioinput' && !SKIP.has(d.deviceId)).forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Mic (${d.deviceId.slice(0, 8)}…)`;
      if (d.deviceId === saved) { o.selected = true; savedFound = true; }
      sel.appendChild(o);
    });
    if (saved && !savedFound) {
      _patchPrefs({ deviceId: '', deviceLabel: '' });
      _updateSoundcardDisplay();
    }
  } catch (e) {
    _setStatus('Mic access denied: ' + e.message);
  }
}

function _applyDeviceChangeFromSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const deviceId    = sel.value;
  const deviceLabel = sel.value ? (sel.selectedOptions[0]?.text || '') : '';
  _patchPrefs({ deviceId, deviceLabel });
  _updateSoundcardDisplay();
  if (_running) _restartOnNewDevice();
}

async function _restartOnNewDevice() {
  _stopCapture();
  await new Promise(r => setTimeout(r, 120));
  smToggleCapture();
}

// ── Channel / view selection ────────────────────────────────────────────────
window.smSetChannel = function(ch) {
  _channel = ch;
  document.getElementById('sm-ch-1')?.classList.toggle('active', ch === 1);
  document.getElementById('sm-ch-2')?.classList.toggle('active', ch === 2);
  _patchPrefs({ channel: ch });
  if (window.pyResetAverage) window.pyResetAverage();
};

window.smSetView = function(v) {
  _view = v;
  document.getElementById('sm-view-scope')?.classList.toggle('active', v === 'scope');
  document.getElementById('sm-view-spec')?.classList.toggle('active', v === 'spectrogram');
  document.getElementById('sm-scope-view').style.display       = v === 'scope'       ? '' : 'none';
  document.getElementById('sm-spectrogram-view').style.display = v === 'spectrogram' ? '' : 'none';
  ['sm-wave-plot', 'sm-spectrum-plot', 'sm-spectrogram-plot'].forEach(id => {
    const el = document.getElementById(id); if (el) Plotly.Plots.resize(el);
  });
  if (_running && !_paused) { _scopeTick(); _spectrogramTick(); }
};

window.smSettingsChanged = function() {
  const nAvg = parseInt(document.getElementById('sm-inp-navg')?.value) || 5;
  const snip = parseFloat(document.getElementById('sm-inp-snip')?.value) || 0.3;
  _patchPrefs({ n_avg: nAvg, snippet_s: snip });
  if (_running) _restartSnippetTimer();
};

// ── Audio capture (AudioWorklet, two independent channel ring buffers) ─────

const SM_WORKLET_SRC = `
class SMCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp[0] && inp[0].length > 0) {
      const c1 = inp[0];
      const c2 = inp.length > 1 && inp[1] && inp[1].length > 0 ? inp[1] : inp[0];
      this.port.postMessage({ c1: c1.slice(), c2: c2.slice() });
    }
    return true;
  }
}
registerProcessor('sm-capture', SMCaptureProcessor);
`;

let _audioCtx    = null;
let _workletNode = null;
let _source      = null;
let _stream      = null;
let _sr          = 44100;

const SM_RING_SECS = 8;
let _ring1  = new Float32Array(SM_RING_SECS * 44100);
let _ring2  = new Float32Array(SM_RING_SECS * 44100);
let _ringSz = SM_RING_SECS * 44100;
let _ringWr = 0;

function _reallocRing(sr) {
  _sr     = sr;
  _ringSz = SM_RING_SECS * sr;
  _ring1  = new Float32Array(_ringSz);
  _ring2  = new Float32Array(_ringSz);
  _ringWr = 0;
}
function _pushRing(c1, c2) {
  for (let i = 0; i < c1.length; i++) {
    _ring1[_ringWr] = c1[i]; _ring2[_ringWr] = c2[i];
    _ringWr = (_ringWr + 1) % _ringSz;
  }
}
function _ringTail(n) {
  n = Math.min(n, _ringSz);
  const out = new Float32Array(n);
  const src = _channel === 2 ? _ring2 : _ring1;
  for (let i = 0; i < n; i++) out[i] = src[(_ringWr - n + i + _ringSz) % _ringSz];
  return out;
}

window.smToggleCapture = async function() {
  if (_running) { _stopCapture(); return; }
  const prefs = _loadPrefs();
  const deviceId = prefs.deviceId || '';
  try {
    _setStatus('Requesting microphone…');
    _stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId:         deviceId ? { exact: deviceId } : undefined,
        channelCount:     { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      }
    });
    // Read the device that was actually opened — may differ from the requested
    // deviceId if the browser fell back to the default input (same pattern as
    // Acquire's _startAudio, since we can't know the label until it's open).
    try {
      const track    = _stream.getAudioTracks()[0];
      const actualId = track?.getSettings().deviceId || '';
      const devices  = await navigator.mediaDevices.enumerateDevices();
      const dev      = devices.find(d => d.kind === 'audioinput' && d.deviceId === actualId);
      const actualLabel = dev?.label || track?.label || '';
      _patchPrefs({ deviceId: actualId, deviceLabel: actualLabel });
      _updateSoundcardDisplay();
    } catch (_) {}

    _audioCtx = new AudioContext();
    _reallocRing(_audioCtx.sampleRate);
    const blob = new Blob([SM_WORKLET_SRC], { type: 'application/javascript' });
    const blobURL = URL.createObjectURL(blob);
    await _audioCtx.audioWorklet.addModule(blobURL);
    URL.revokeObjectURL(blobURL);
    _source = _audioCtx.createMediaStreamSource(_stream);
    _workletNode = new AudioWorkletNode(_audioCtx, 'sm-capture', {
      numberOfInputs: 1, numberOfOutputs: 0,
      channelCount: 2, channelCountMode: 'explicit',
    });
    _workletNode.port.onmessage = ({ data }) => _pushRing(data.c1, data.c2);
    _source.connect(_workletNode);

    _running = true; _paused = false;
    if (window.pyResetAverage) window.pyResetAverage();

    const btn = document.getElementById('sm-start-btn');
    if (btn) { btn.textContent = '■ Stop'; btn.classList.remove('accent'); btn.classList.add('stop'); }
    const pb = document.getElementById('sm-pause-btn');
    if (pb) { pb.disabled = false; pb.textContent = '⏸ Pause'; }
    _setStatus('Running');
    _redrawConfigOnly();
    _restartSnippetTimer();
    _specTimerId = setInterval(_spectrogramTick, 600);
  } catch (e) {
    _setStatus('Error: ' + e.message);
  }
};

let _snipTimerId = null;
let _specTimerId = null;

function _restartSnippetTimer() {
  if (_snipTimerId) clearInterval(_snipTimerId);
  const snip = parseFloat(document.getElementById('sm-inp-snip')?.value) || 0.3;
  _snipTimerId = setInterval(_scopeTick, Math.max(50, snip * 1000));
}

function _stopCapture() {
  _running = false;
  if (_snipTimerId) { clearInterval(_snipTimerId); _snipTimerId = null; }
  if (_specTimerId) { clearInterval(_specTimerId); _specTimerId = null; }
  if (_workletNode) { _workletNode.disconnect(); _workletNode = null; }
  if (_source)      { _source.disconnect();      _source = null; }
  if (_stream)      { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  if (_audioCtx)    { _audioCtx.close(); _audioCtx = null; }
  const btn = document.getElementById('sm-start-btn');
  if (btn) { btn.textContent = '▶ Start'; btn.classList.remove('stop'); btn.classList.add('accent'); }
  const pb = document.getElementById('sm-pause-btn');
  if (pb) { pb.disabled = true; pb.textContent = '⏸ Pause'; }
  _setStatus('Stopped');
  _redrawConfigOnly();
}

window.smTogglePause = function() {
  if (!_running) return;
  _paused = !_paused;
  const pb = document.getElementById('sm-pause-btn');
  if (pb) pb.textContent = _paused ? '▶ Resume' : '⏸ Pause';
  _setStatus(_paused ? 'Paused — press Resume to continue' : 'Running');
  _redrawConfigOnly();
};

// ── Waveform + averaged spectrum tick ───────────────────────────────────────
function _scopeTick() {
  if (!_running || _paused || _view !== 'scope') return;
  const snip  = parseFloat(document.getElementById('sm-inp-snip')?.value) || 0.3;
  const nAvg  = parseInt(document.getElementById('sm-inp-navg')?.value) || 5;
  const n     = Math.max(8, Math.ceil(snip * _sr));
  const tail  = _ringTail(n);

  let pk = 0;
  for (let i = 0; i < tail.length; i++) pk = Math.max(pk, Math.abs(tail[i]));
  const lvlEl = document.getElementById('sm-level');
  if (lvlEl) lvlEl.textContent = pk > 1e-6 ? (20 * Math.log10(pk)).toFixed(1) + ' dB' : '–';

  const step = Math.max(1, Math.floor(tail.length / 4000));
  const x = [], y = [];
  for (let i = 0; i < tail.length; i += step) { x.push(i / _sr); y.push(tail[i]); }
  _lastWave = { trace: {
    x, y, type: 'scatter', mode: 'lines', line: { color: '#1565c0', width: 1 }, showlegend: false,
  } };
  Plotly.react('sm-wave-plot', [_lastWave.trace],
    _wl(`Waveform — Ch ${_channel}`, 'Time (s)', 'Amplitude', { uirevision: 'keep' }), _pcfgFor());

  if (window.pySpectrum) window.pySpectrum(tail, _sr, nAvg);
}

window.onSpectrumResult = function(freqs_js, db_js, count) {
  const freqs = Array.from(freqs_js), db = Array.from(db_js);
  _lastSpectrum = { count: +count, trace: {
    x: freqs, y: db, type: 'scatter', mode: 'lines', line: { color: '#6a1b9a', width: 1.5 }, showlegend: false,
  } };
  Plotly.react('sm-spectrum-plot', [_lastSpectrum.trace],
    _wl(`Spectrum — ${count} snippet${count === 1 ? '' : 's'} averaged`, 'Frequency (Hz)', 'dB',
      { xaxis: { type: 'log' }, uirevision: 'keep' }), _pcfgFor());
};

// ── Spectrogram tick ─────────────────────────────────────────────────────────
const SM_SPECTROGRAM_WINDOW_SECS = 5;

function _spectrogramTick() {
  if (!_running || _paused || _view !== 'spectrogram') return;
  const n = Math.max(2048, Math.ceil(SM_SPECTROGRAM_WINDOW_SECS * _sr));
  const tail = _ringTail(n);
  if (window.pySpectrogram) window.pySpectrogram(tail, _sr);
}

window.onSpectrogramResult = function(times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  const times = Array.from(times_js), freqs = Array.from(freqs_js);
  const arr = Array.from(flatZ_js);
  const nF = +nFreqs, nT = +nTimes;
  const zDb = [];
  for (let i = 0; i < nF; i++) zDb.push(arr.slice(i * nT, (i + 1) * nT));
  _lastSpectrogram = { trace: {
    x: times, y: freqs, z: zDb,
    type: 'heatmap', colorscale: 'Plasma', showscale: true,
    colorbar: { title: 'dB', titleside: 'right', thickness: 10, len: 0.9, tickfont: { size: 9 } },
    zsmooth: 'fast', hoverinfo: 'skip',
  } };
  Plotly.react('sm-spectrogram-plot', [_lastSpectrogram.trace],
    _wl(`Spectrogram — Ch ${_channel}`, 'Time (s)', 'Frequency (Hz)', { uirevision: 'keep' }), _pcfgFor());
};

// ── UI helpers ───────────────────────────────────────────────────────────────
function _setStatus(msg) { const el = document.getElementById('sm-status'); if (el) el.textContent = msg; }

// ── Sidebar resize (matches Convolve/Circle Fit pattern) ────────────────────
function _initResizer() {
  const resizer = document.getElementById('sm-resizer');
  const sidebar = document.querySelector('.sm-left');
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
    const w = Math.max(160, Math.min(360, startW + (e.clientX - startX)));
    sidebar.style.width = w + 'px';
    ['sm-wave-plot', 'sm-spectrum-plot', 'sm-spectrogram-plot'].forEach(id => {
      const el = document.getElementById(id); if (el) Plotly.Plots.resize(el);
    });
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}
window.addEventListener('resize', () => {
  ['sm-wave-plot', 'sm-spectrum-plot', 'sm-spectrogram-plot'].forEach(id => {
    const el = document.getElementById(id); if (el) Plotly.Plots.resize(el);
  });
});

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  _initResizer();
  _applyPrefsToForm();

  const storedName = localStorage.getItem('obieDataFolderName');
  const handle = await loadDataFolderHandle().catch(() => null);
  let folderApplied = false;
  if (handle) {
    try {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        await _applyDataFolder(handle);
        folderApplied = true;
      }
    } catch (_) {}
    if (!folderApplied) {
      const nameEl = document.getElementById('sm-folder-name');
      if (nameEl && storedName) nameEl.textContent = `"${storedName}" needs permission — click 📁 Data Folder`;
    }
  }
  if (!folderApplied) {
    await _enumerateDevicesInto('device-picker-select');
    _updateSoundcardDisplay();
  }

  // Default to running — start capture immediately rather than waiting for
  // the user to click Start (this tool's whole point is a live monitor).
  smToggleCapture();
});
