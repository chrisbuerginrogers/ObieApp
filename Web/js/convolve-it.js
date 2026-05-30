/* ─────────────────────────────────────────────────────────────────────
 * convolve-it.js  —  UI wiring for the Convolve It tool
 *
 * Requires (loaded before this file):
 *   plotly-theme.js   — cssVar(), plotLayout(), pcfg, COL
 *   audio.js          — encodeWAV(), AudioPlayer
 *
 * All file parsing, WAV decoding, and DSP run in Python (dsp.py / files.py).
 * This file manages: playback state, plot rendering, and UI interactions.
 * ───────────────────────────────────────────────────────────────────── */

// ── Playback state (JS-only — needed by AudioPlayer) ─────────────────
let wavSamples = null, wavSR = 44100;
let outSamples = null, outSR = 44100, outChannels = 1;
let frfLLoaded = false, frfRLoaded = false;
let _frfData = { l: null, r: null };

const DEFAULT_WAV_URL = '../../sample-data/1-Tchaikovsky-short.wav';

const player = new AudioPlayer({ wav: 'play-wav-btn', out: 'play-btn' });

// ── Plot initialisation ───────────────────────────────────────────────
const _pcfg = { ...pcfg, toImageButtonOptions: { format: 'png', scale: 2, filename: 'convolve' } };
const _wl = (title, xl, yl, extra) => ({
  ...plotLayout(title, xl, yl, extra), paper_bgcolor: '#fff', plot_bgcolor: '#fff'
});

Plotly.newPlot('frf-plot',  [], _wl('FRF · Magnitude',       'Frequency (Hz)', 'dB', { xaxis: { type: 'log' } }), _pcfg);
Plotly.newPlot('wav-plot',  [], _wl('Input · Spectrogram',   'Time (s)', 'Frequency (Hz)'), _pcfg);
Plotly.newPlot('out-plot',  [], _wl('Convolved Output',       'Time (s)', 'Amplitude'),      _pcfg);
Plotly.newPlot('spec-plot', [], _wl('Output · Spectrogram',  'Time (s)', 'Frequency (Hz)'), _pcfg);

// ── FRF loading ───────────────────────────────────────────────────────
function loadFRF(ch, input) {
  const file = input.files[0]; if (!file) return;
  const c = ch.toLowerCase();
  document.getElementById(`frf-${c}-btn-text`).textContent = file.name;
  setSt(`frf-${c}-status`, 'reading…');
  const reader = new FileReader();
  reader.onerror = () => setSt(`frf-${c}-status`, 'read error', 'err');
  reader.onload  = e => {
    if (!window.pyLoadFRF) {
      setSt(`frf-${c}-status`, 'Python not ready — try again', 'err'); return;
    }
    window.pyLoadFRF(ch, file.name, new Uint8Array(e.target.result));
  };
  reader.readAsArrayBuffer(file);
}

window.onFRFResult = function(ch, freqs, dbs, info) {
  const c = String(ch).toLowerCase();
  setSt(`frf-${c}-status`, info, 'ok');
  _frfData[c] = { freqs: Array.from(freqs), dbs: Array.from(dbs) };
  if (c === 'l') frfLLoaded = true; else frfRLoaded = true;
  plotFRF();
  checkReady();
};
window.onFRFError = function(ch, msg) {
  const c = String(ch).toLowerCase();
  if (c === 'l') frfLLoaded = false; else frfRLoaded = false;
  setSt(`frf-${c}-status`, 'error: ' + msg, 'err');
  checkReady();
};

// ── WAV loading ───────────────────────────────────────────────────────
async function loadDefaultWAV() {
  setSt('wav-status', 'fetching default WAV…');
  try {
    const resp = await fetch(DEFAULT_WAV_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    _wavFileName = '1-Tchaikovsky-short.wav';
    window.pyLoadWAV('1-Tchaikovsky-short.wav', new Uint8Array(await resp.arrayBuffer()));
  } catch (e) {
    setSt('wav-status', 'default fetch failed — load manually (' + e.message + ')');
  }
}

async function loadWAV(input) {
  const file = input.files[0]; if (!file) return;
  _wavFileName = file.name;
  setSt('wav-status', 'loading…');
  try {
    window.pyLoadWAV(file.name, new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    setSt('wav-status', 'error: ' + e.message.slice(0, 40), 'err');
  }
}

window.onWavResult = function(samplesArr, sr, info) {
  wavSamples = new Float32Array(samplesArr);
  wavSR      = +sr;
  setSt('wav-status', info, 'ok');
  document.getElementById('play-wav-btn').style.display = '';
  checkReady();
};
window.onWavError = function(msg) {
  wavSamples = null;
  setSt('wav-status', 'error: ' + msg, 'err');
  checkReady();
};

// ── Spectrogram state ─────────────────────────────────────────────────
let _specLogFreq   = false;
let _botShowL      = true;   // output spectrogram: L or R channel
let _wavFileName   = '';
let _inLSpecCache  = null;
let _outLSpecCache = null, _outRSpecCache = null;

function _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  const times = Array.from(times_js), freqs = Array.from(freqs_js);
  const arr = Array.from(flatZ_js);
  const nF = +nFreqs, nT = +nTimes;
  const zDb = [];
  for (let i = 0; i < nF; i++) zDb.push(arr.slice(i * nT, (i + 1) * nT));
  return { times, freqs, zDb };
}

function _renderSpectrogram(divId, cache, title) {
  if (!cache) return;
  const { times, freqs, zDb } = cache;
  Plotly.react(divId, [{
    x: times, y: freqs, z: zDb,
    type: 'heatmap', colorscale: 'Plasma', showscale: true,
    colorbar: { title: 'dB', titleside: 'right', thickness: 10,
                len: 0.9, tickfont: { size: 9 } },
    zsmooth: 'fast', hoverinfo: 'skip',
  }], { ...plotLayout(title, 'Time (s)', 'Frequency (Hz)', {
    margin: { l: 50, r: 52, t: 28, b: 38 },
    yaxis: { type: _specLogFreq ? 'log' : 'linear' },
  }), paper_bgcolor: '#fff', plot_bgcolor: '#fff' }, _pcfg);
}

function _renderTopSpec() {
  _renderSpectrogram('wav-plot', _inLSpecCache, 'Input · ' + _wavFileName);
}
function _renderBotSpec() {
  _renderSpectrogram('spec-plot',
    _botShowL ? _outLSpecCache : _outRSpecCache,
    _botShowL ? 'Output · L Channel' : 'Output · R Channel');
}

// ── Input spectrogram callbacks (from Python load_wav) ────────────────
window.onWavSpectrogramResult = function() {};
window.onInRSpectrogramResult = function() {};  // input is always mono

window.onInLSpectrogramResult = function(times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  _inLSpecCache = _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes);
  document.getElementById('in-spec-label').textContent = 'Input · ' + _wavFileName;
  _renderTopSpec();
};

// ── Output spectrogram callbacks (from Python convolve) ───────────────
window.onOutLSpectrogramResult = function(times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  _outLSpecCache = _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes);
  _outRSpecCache = null;
  _botShowL = true;
  document.getElementById('out-spec-label').textContent = 'Output · L Channel';
  document.getElementById('out-spec-btn').style.display = 'none';
  _renderBotSpec();
};
window.onOutRSpectrogramResult = function(times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  _outRSpecCache = _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes);
  document.getElementById('out-spec-btn').style.display = '';
  if (!_botShowL) _renderBotSpec();
};

window.onOutSpectrogramResult = function() {};  // no longer used

// ── Toggle handlers ───────────────────────────────────────────────────
window.ciToggleBotSpec = function() {
  _botShowL = !_botShowL;
  document.getElementById('out-spec-label').textContent =
    _botShowL ? 'Output · L Channel' : 'Output · R Channel';
  document.getElementById('out-spec-btn').textContent =
    _botShowL ? 'Show R ▶' : '◀ Show L';
  _renderBotSpec();
};

window.ciToggleSpecScale = function() {
  _specLogFreq = !_specLogFreq;
  const btn = document.getElementById('spec-scale-btn');
  if (btn) {
    btn.textContent = _specLogFreq ? 'Freq: Log' : 'Freq: Lin';
    btn.classList.toggle('active', _specLogFreq);
  }
  _renderTopSpec();
  _renderBotSpec();
};

function plotFRF() {
  const colors = { l: COL.frf, r: '#1565C0' };
  const names  = { l: 'Left',  r: 'Right'  };
  const loaded = Object.entries(_frfData).filter(([, d]) => d);
  const traces = loaded.map(([ch, { freqs, dbs }]) => ({
    x: freqs, y: dbs, type: 'scatter', mode: 'lines',
    name: names[ch], line: { color: colors[ch], width: 1.5 },
    showlegend: loaded.length > 1,
  }));
  const allDbs = loaded.flatMap(([, { dbs }]) => dbs.filter(isFinite));
  const yMax = allDbs.length ? Math.max(6,  Math.ceil( (Math.max(...allDbs) + 3) / 6) * 6) : 6;
  const yMin = allDbs.length ? Math.min(-6, Math.floor((Math.min(...allDbs) - 3) / 6) * 6) : -6;
  Plotly.react('frf-plot', traces, _wl('FRF · Magnitude', 'Frequency (Hz)', 'dB', {
    xaxis: { type: 'log' }, yaxis: { range: [yMin, yMax] },
    showlegend: loaded.length > 1,
    legend: { x: 0.98, xanchor: 'right', y: 0.98, font: { size: 9 } },
  }), _pcfg);
}

// stride: 1 = mono, 2 = interleaved stereo (plots left channel)
function plotWaveform(divId, samples, sr, color, title, stride = 1) {
  const n = Math.floor(samples.length / stride);
  const step = Math.max(1, Math.floor(n / 5000));
  const x = [], y = [];
  for (let i = 0; i < n; i += step) { x.push(i / sr); y.push(samples[i * stride]); }
  Plotly.react(divId, [{
    x, y, type: 'scatter', mode: 'lines',
    line: { color, width: 1 }, showlegend: false,
  }], _wl(title, 'Time (s)', 'Amplitude'), _pcfg);
}

// ── Convolution ───────────────────────────────────────────────────────
function checkReady() {
  document.getElementById('conv-btn').disabled = !(frfLLoaded && wavSamples !== null);
}

function runConvolution() {
  if (!wavSamples) return;
  player.stopAll();
  ['conv-btn', 'play-btn', 'save-btn'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = true;
  });
  setProgMsg('Computing…');
  const gainDb = +document.getElementById('gain-sl').value;
  setTimeout(() => {
    if (!window.pyConvolve) {
      clearProgMsg(); setProgMsg('Python not ready — please wait…');
      setTimeout(clearProgMsg, 4000);
      document.getElementById('conv-btn').disabled = false;
      return;
    }
    try {
      window.pyConvolve(gainDb);
    } catch (e) {
      clearProgMsg(); setProgMsg('Error: ' + e.message.slice(0, 60));
      setTimeout(clearProgMsg, 5000);
      document.getElementById('conv-btn').disabled = false;
    }
  }, 30);
}

window.onConvolveResult = function(samplesArr, sr, nChannels) {
  outSamples  = new Float32Array(samplesArr);
  outSR       = +sr;
  outChannels = +nChannels;
  clearProgMsg();
  document.getElementById('conv-btn').disabled = false;
  document.getElementById('result-card').style.display = '';
  document.getElementById('play-btn').disabled  = false;
  document.getElementById('save-btn').disabled  = false;
  const nFrames = Math.floor(outSamples.length / outChannels);
  document.getElementById('out-info').textContent =
    `${(nFrames / outSR).toFixed(2)} s · ` +
    `${(outSR / 1000).toFixed(1)} kHz · ` +
    `${nFrames.toLocaleString()} samples · ` +
    (outChannels === 2 ? 'stereo' : 'mono');
  plotWaveform('out-plot', outSamples, outSR, COL.out, 'Convolved Output', outChannels);
};

window.onConvolveError = function(msg) {
  clearProgMsg(); setProgMsg('Error: ' + msg);
  setTimeout(clearProgMsg, 6000);
  document.getElementById('conv-btn').disabled = false;
};

window.setProgMsg = setProgMsg;

// ── Audio playback & export ───────────────────────────────────────────
function togglePlayWAV() { player.toggle('wav', wavSamples, wavSR); }
function togglePlay()    { player.toggle('out', outSamples, outSR, outChannels); }

function saveWAV() {
  if (!outSamples) return;
  const url = URL.createObjectURL(
    new Blob([encodeWAV(outSamples, outSR, outChannels)], { type: 'audio/wav' })
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'convolved_' +
    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.wav';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Output device selection ───────────────────────────────────────────
async function enumerateOutputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const sel = document.getElementById('out-device-sel');
    if (!sel) return;
    const savedId = window.ciSavedOutputDeviceId || '';
    sel.innerHTML = '<option value="">Default output</option>';
    devices
      .filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default')
      .forEach(d => {
        const o = document.createElement('option');
        o.value       = d.deviceId;
        o.textContent = d.label || `Speaker (${d.deviceId.slice(0, 8)}…)`;
        if (d.deviceId === savedId) o.selected = true;
        sel.appendChild(o);
      });
    if (savedId) await player.setSinkId(savedId);
  } catch (e) {
    console.warn('Output device enumeration failed:', e.message);
  }
}

document.getElementById('out-device-sel')?.addEventListener('change', async function () {
  await player.setSinkId(this.value);
});

// ── UI helpers ────────────────────────────────────────────────────────
function setSt(id, txt, cls) {
  const el = document.getElementById(id);
  el.textContent = txt;
  el.className   = 'file-status' + (cls ? ' ' + cls : '');
}
function setProgMsg(m)  { document.getElementById('prog-msg').textContent = m; }
function clearProgMsg() { document.getElementById('prog-msg').textContent = ''; }

// Python signals ready — trigger default WAV load now that pyLoadWAV is registered.
window.onPythonReady = function() {
  loadDefaultWAV();
};

// ── Data Folder (ObieAppSettings) ────────────────────────────────────
let _ciSettingsHandle = null;

window.ciSetDataFolder = async function() {
  if (!window.showDirectoryPicker) {
    alert('Directory picker requires Chrome or Edge.');
    return;
  }
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    ({ settingsHandle: _ciSettingsHandle } = await openObieAppSettings(dir));
    const btn = document.getElementById('ci-folder-btn');
    if (btn) btn.textContent = '📁 ' + dir.name;
  } catch (e) {
    if (e.name !== 'AbortError') alert('Folder error: ' + e.message);
  }
};

// ── Sidebar resize (matches Acquire pattern) ──────────────────────────
function _initResizer() {
  const resizer = document.getElementById('ci-resizer');
  const sidebar = document.querySelector('.ci-sidebar');
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
    ['frf-plot','wav-plot','out-plot','spec-plot'].forEach(id => {
      const el = document.getElementById(id);
      if (el) Plotly.Plots.resize(el);
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

// ── Gain slider live display ──────────────────────────────────────────
function _initGainSlider() {
  const sl = document.getElementById('gain-sl');
  const disp = document.getElementById('gain-disp');
  if (!sl || !disp) return;
  const update = () => {
    const v = parseInt(sl.value, 10);
    disp.textContent = (v >= 0 ? '+' : '') + v + ' dB';
  };
  sl.addEventListener('input', update);
  update();
}

// ── Boot ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  enumerateOutputDevices();
  _initResizer();
  _initGainSlider();
});
