/* matlab.js — Export to MATLAB tool */
'use strict';

let _dataDir   = null;
let _allFiles  = [];
let _pyReady   = false;
let _exporting = false;
const _checkedPaths = new Set();   // persists across instrument filter changes

const _SCAN_EXTS = new Set(['.trf', '.trv', '.avc', '.avr']);

// ── DOM helpers ───────────────────────────────────────────────────────────
const $    = id => document.getElementById(id);
const _esc = s  => String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');

function setStatus(msg, cls = '') {
  const el = $('mat-status');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'mat-status-txt' + (cls ? ' ' + cls : '');
}
function appendProgress(msg, cls = '') {
  const el = $('mat-progress');
  if (!el) return;
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = msg;
  el.appendChild(d);
}

// ── Folder scan ───────────────────────────────────────────────────────────
async function _scanDir(dh, relPath) {
  const out = [];
  for await (const [name, h] of dh.entries()) {
    if (h.kind === 'file') {
      const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
      if (_SCAN_EXTS.has(ext))
        out.push({ name, ext, path: relPath ? relPath + '/' + name : name, handle: h });
    } else if (h.kind === 'directory') {
      if (name === 'ObieAppSettings') continue;
      const sub = await _scanDir(h, relPath ? relPath + '/' + name : name);
      out.push(...sub);
    }
  }
  return out;
}

// ── Instrument dropdown ───────────────────────────────────────────────────
function _populateInstrumentSelect() {
  const sel = $('mat-instr-sel');
  if (!sel) return;

  // Collect unique top-level folder names
  const instrs  = new Set();
  let   hasRoot = false;
  for (const f of _allFiles) {
    const slash = f.path.indexOf('/');
    if (slash > 0) instrs.add(f.path.slice(0, slash));
    else hasRoot = true;
  }

  let html = `<option value="">All instruments (${_allFiles.length})</option>`;
  for (const name of [...instrs].sort((a, b) => a.localeCompare(b))) {
    const n = _allFiles.filter(f => f.path.startsWith(name + '/')).length;
    html += `<option value="${_esc(name)}">${_esc(name)} (${n})</option>`;
  }
  if (hasRoot) {
    const n = _allFiles.filter(f => !f.path.includes('/')).length;
    html += `<option value="__root__">(no folder) (${n})</option>`;
  }
  sel.innerHTML = html;
}

function _getVisibleFiles() {
  const instr = $('mat-instr-sel')?.value || '';
  if (!instr)           return _allFiles;
  if (instr === '__root__') return _allFiles.filter(f => !f.path.includes('/'));
  return _allFiles.filter(f => f.path.startsWith(instr + '/'));
}

window.matlabInstrumentChange = function() { _renderFileList(); };

// ── File list rendering ───────────────────────────────────────────────────
function _extBadge(ext) {
  const cls = ext.replace('.', '');
  return `<span class="mat-file-ext mat-ext-${cls}">${cls.toUpperCase()}</span>`;
}

function _renderFileList() {
  const list = $('mat-file-list');
  if (!list) return;

  const visible   = _getVisibleFiles();
  const showInstr = !($('mat-instr-sel')?.value || ''); // show folder label when viewing all

  if (!visible.length) {
    list.innerHTML = '<div class="mat-placeholder">No FRF files found</div>';
    _updateSelectionUI();
    return;
  }

  list.innerHTML = visible.map(f => {
    const stem   = f.name.replace(/\.[^.]+$/, '');
    const isChk  = _checkedPaths.has(f.path);
    const folder = f.path.includes('/') ? f.path.split('/')[0] : '';
    const sub    = (showInstr && folder)
      ? `<span class="mat-file-sub">${_esc(folder)}</span>` : '';
    return `<div class="mat-file-row${isChk ? ' checked' : ''}" onclick="_matlabRowClick(this)">
      <input type="checkbox" class="mat-file-chk" data-path="${_esc(f.path)}"
             ${isChk ? 'checked' : ''} style="flex-shrink:0;margin:0;cursor:pointer"
             onclick="event.stopPropagation();_matlabChkClick(this)">
      <div class="mat-file-info">
        <span class="mat-file-name" title="${_esc(f.path)}">${_esc(stem)}</span>
        ${sub}
      </div>
      ${_extBadge(f.ext)}
    </div>`;
  }).join('');

  _updateSelectionUI();
}

window._matlabRowClick = function(row) {
  const chk = row.querySelector('.mat-file-chk');
  if (!chk) return;
  chk.checked = !chk.checked;
  _matlabChkClick(chk);
};

window._matlabChkClick = function(chk) {
  const path = chk.dataset.path;
  if (chk.checked) {
    _checkedPaths.add(path);
    _triggerPreview(path);
  } else {
    _checkedPaths.delete(path);
  }
  chk.closest('.mat-file-row')?.classList.toggle('checked', chk.checked);
  _updateSelectionUI();
};

function _getSelected() {
  return _allFiles.filter(f => _checkedPaths.has(f.path));
}

function _updateSelectionUI() {
  const selected = _getSelected();
  const n = selected.length;
  $('mat-selected-count').textContent = n + ' file' + (n !== 1 ? 's' : '') + ' selected';
  $('mat-export-btn').disabled = !_pyReady || n === 0;
  _updatePreviewTable(selected);
}

window.matlabSelectAll = function() {
  _getVisibleFiles().forEach(f => _checkedPaths.add(f.path));
  _renderFileList();
};

window.matlabClearAll = function() {
  _getVisibleFiles().forEach(f => _checkedPaths.delete(f.path));
  _renderFileList();
};

// ── Preview table (right panel) ───────────────────────────────────────────
function _updatePreviewTable(selected) {
  const tbody = $('mat-preview-body');
  if (!tbody) return;
  if (!selected.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="mat-preview-empty">No files selected</td></tr>';
    return;
  }
  tbody.innerHTML = selected.map(f => {
    const stem = f.name.replace(/\.[^.]+$/, '');
    const type = f.ext.replace('.', '').toUpperCase();
    return `<tr>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          title="${_esc(f.path)}">${_esc(stem)}</td>
      <td>${type}</td>
      <td id="pr-freq-${_esc(f.path)}" style="color:var(--muted)">—</td>
      <td id="pr-pts-${_esc(f.path)}"  style="color:var(--muted)">—</td>
    </tr>`;
  }).join('');
}

window.matlabFileAdded = function(path, label, startHz, stopHz, nPts) {
  const fEl = document.getElementById('pr-freq-' + path);
  const pEl = document.getElementById('pr-pts-'  + path);
  if (fEl) fEl.textContent = Math.round(startHz) + '–' + Math.round(stopHz) + ' Hz';
  if (pEl) pEl.textContent = nPts;
};

window.matlabFileError = function(path, err) {
  appendProgress('✗ ' + path.split('/').pop() + ': ' + err, 'err');
};

// ── Mini plot (canvas at bottom of left panel) ────────────────────────────
async function _triggerPreview(path) {
  if (!_pyReady || !window.pyMatlabPreview) return;
  const f = _allFiles.find(f => f.path === path);
  if (!f) return;
  try {
    const file = await f.handle.getFile();
    const buf  = await file.arrayBuffer();
    window.pyMatlabPreview(path, new Uint8Array(buf));
  } catch (_) {}
}

window.matlabPreviewData = function(freqJs, magJs) {
  _drawMiniPlot(Array.from(freqJs), Array.from(magJs));
};

function _drawMiniPlot(freq, mag) {
  const canvas = $('mat-mini-plot');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement.clientWidth  || 290;
  const H   = canvas.parentElement.clientHeight || 120;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const PAD = { top: 6, right: 6, bottom: 18, left: 30 };
  const pW  = W - PAD.left - PAD.right;
  const pH  = H - PAD.top  - PAD.bottom;

  // Filter to 200–7000 Hz range
  const pts = [];
  for (let i = 0; i < freq.length; i++)
    if (freq[i] >= 200 && freq[i] <= 7000) pts.push([freq[i], mag[i]]);
  if (!pts.length) return;

  // Y: 40 dB window pinned to data max
  const maxM = Math.max(...pts.map(p => p[1]));
  const yTop = Math.ceil(maxM / 5) * 5;
  const yBot = yTop - 40;

  // X: log scale 200–7000
  const L0  = Math.log10(200), L1 = Math.log10(7000);
  const xPx = f => PAD.left + (Math.log10(f) - L0) / (L1 - L0) * pW;
  const yPx = m => PAD.top  + (1 - (m - yBot) / (yTop - yBot)) * pH;

  // Background
  ctx.fillStyle = '#f8f9fa';
  ctx.fillRect(0, 0, W, H);

  // X grid lines
  ctx.strokeStyle = '#e0e2e6';
  ctx.lineWidth   = 0.5;
  [500, 1000, 2000, 5000].forEach(f => {
    const x = xPx(f);
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + pH); ctx.stroke();
  });
  // Y grid every 10 dB
  for (let m = Math.ceil(yBot / 10) * 10; m <= yTop; m += 10) {
    const y = yPx(m);
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + pW, y); ctx.stroke();
  }

  // Axes border
  ctx.strokeStyle = '#c0c4cc';
  ctx.lineWidth   = 0.8;
  ctx.strokeRect(PAD.left, PAD.top, pW, pH);

  // Y labels
  ctx.fillStyle   = '#888';
  ctx.font        = '7px system-ui,sans-serif';
  ctx.textAlign   = 'right';
  ctx.textBaseline = 'middle';
  for (let m = Math.ceil(yBot / 10) * 10; m <= yTop; m += 10)
    ctx.fillText(m, PAD.left - 2, yPx(m));

  // X labels
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  [200, 500, 1000, 2000, 5000, 7000].forEach(f => {
    const lbl = f >= 1000 ? (f / 1000) + 'k' : String(f);
    ctx.fillText(lbl, xPx(f), PAD.top + pH + 3);
  });

  // Data line
  ctx.beginPath();
  ctx.strokeStyle = '#b35c00';
  ctx.lineWidth   = 1.2;
  ctx.lineJoin    = 'round';
  let first = true;
  for (const [f, m] of pts) {
    const x = xPx(f);
    const y = yPx(Math.max(yBot, Math.min(yTop, m)));
    first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    first = false;
  }
  ctx.stroke();
}

// ── Export ────────────────────────────────────────────────────────────────
window.matlabExport = async function() {
  if (_exporting || !_pyReady) return;
  const selected = _getSelected();
  if (!selected.length) { setStatus('No files selected', 'err'); return; }

  _exporting = true;
  $('mat-export-btn').disabled = true;
  $('mat-progress').innerHTML  = '';
  setStatus(`Reading ${selected.length} file${selected.length !== 1 ? 's' : ''}…`);

  window.pyMatlabClear();

  let nOk = 0;
  for (const f of selected) {
    try {
      const file = await f.handle.getFile();
      const buf  = await file.arrayBuffer();
      window.pyMatlabAddFile(f.path, new Uint8Array(buf));
      nOk++;
      setStatus(`Parsing ${nOk} / ${selected.length}…`);
    } catch (e) {
      appendProgress('✗ ' + f.name + ': ' + e.message, 'err');
    }
  }

  let outName = ($('mat-output-name')?.value || 'data').trim();
  if (!outName.toLowerCase().endsWith('.mat')) outName += '.mat';
  setStatus('Building .mat file…');
  window.pyMatlabFinish(outName);
};

window.matlabExportDone = function(jsBytes, filename) {
  _exporting = false;
  try {
    const blob = new Blob([new Uint8Array(jsBytes)], { type: 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('✓ ' + filename + ' downloaded', 'ok');
    appendProgress('✓ Exported ' + filename, 'ok');
  } catch (e) {
    setStatus('Download error: ' + e.message, 'err');
  }
  $('mat-export-btn').disabled = false;
};

window.matlabExportError = function(err) {
  _exporting = false;
  setStatus('Export failed: ' + err, 'err');
  appendProgress('✗ ' + err, 'err');
  $('mat-export-btn').disabled = false;
};

// ── Data folder ───────────────────────────────────────────────────────────
window.matlabSetDataFolder = async function() {
  if (!window.showDirectoryPicker) {
    alert('Directory picker requires Chrome or Edge.');
    return;
  }
  try {
    const dir = await window.showDirectoryPicker({ mode: 'read' });
    saveDataFolderHandle(dir).catch(() => {});
    await _applyFolder(dir);
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('Folder error: ' + e.message, 'err');
  }
};

async function _applyFolder(dir) {
  _dataDir = dir;
  _checkedPaths.clear();
  setStatus('Scanning…');
  $('mat-folder-btn').textContent  = '📁 ' + dir.name;
  $('mat-folder-name').textContent = dir.name;
  $('mat-overlay')?.classList.add('hidden');

  _allFiles = await _scanDir(dir, '');

  const nameInput = $('mat-output-name');
  if (nameInput) nameInput.value = dir.name.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.mat';

  _populateInstrumentSelect();
  const sel = $('mat-instr-sel');
  if (sel) sel.disabled = false;
  _renderFileList();
  setStatus(dir.name + ' — ' + _allFiles.length + ' file' + (_allFiles.length !== 1 ? 's' : '') + ' found');
}

window.matlabHelp = function() { window.open('../../Docs/experimental.html', '_blank'); };
window.matlabTips = function() { window.open('../../Docs/shortcuts.html', '_blank'); };

// ── PyScript ready ────────────────────────────────────────────────────────
window.matlabPyReady = function() {
  _pyReady = true;
  document.getElementById('loading')?.classList.add('gone');
  _updateSelectionUI();

  loadDataFolderHandle().then(async handle => {
    if (!handle) return;
    try {
      const perm = await handle.queryPermission({ mode: 'read' });
      if (perm === 'granted') await _applyFolder(handle);
    } catch (_) {}
  }).catch(() => {});
};

// ── Resizer ───────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  const resizer = $('mat-resizer');
  const panel   = $('matlab-files-panel');
  if (!resizer || !panel) return;
  let drag = false, x0 = 0, w0 = 0;
  resizer.addEventListener('mousedown', e => {
    drag = true; x0 = e.clientX; w0 = panel.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    panel.style.width = Math.max(180, Math.min(520, w0 + e.clientX - x0)) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = false; resizer.classList.remove('dragging');
    document.body.style.userSelect = '';
  });
});
