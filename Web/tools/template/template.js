'use strict';
/* ─────────────────────────────────────────────────────────────────────
 * template.js — Stencil Builder
 * Visual node layout editor for projector-assisted hammer testing.
 * Nodes are dragged to position, transforms calibrate the projector.
 * Physical (x,y) coordinates stored in stencils and later embedded
 * in TRF metadata by Acquire.
 * ──────────────────────────────────────────────────────────────────── */

// ─── State ────────────────────────────────────────────────────────────────────
let _rootDirHandle   = null;
let _templatesHandle = null;
let _projWindow      = null;
let _currentName     = '';
let _folderTemplates = [];

let _grid = { rows: 4, cols: 6, xSpacing: 25, ySpacing: 20 };
let _transform = { scale: 5, xStretch: 1.0, yStretch: 1.0, rotation: 0, panX: 0, panY: 0 };
let _nodes = [];      // [{id, label, row, col, xMm, yMm}]
let _selected = null; // node id | null

// Drag: capture start position so we can offset cleanly through any transform
let _drag = null; // {nodeId, startMX, startMY, startXmm, startYmm}

// Violin reference overlay & projector mount
let _violinViz     = { show: false, orientation: 'vertical', opacity: 0.25 };
let _verticalMount = false;

// Watch state — polls a TRF folder to track Acquire progress (no Acquire coupling)
let _watchHandle      = null;       // FileSystemDirectoryHandle for the TRF/ folder
let _watchTestHandle  = null;       // parent test run folder (for writing node_layout.json)
let _watchInterval    = null;       // setInterval id
let _watchCurrentNode = null;       // node id to hit next (null = not watching)
let _watchDoneNodes   = new Set();  // node ids already recorded
let _watchRunLabel    = '';         // "InstrumentA / run_001" for display
let _watchTaps           = null;    // taps-per-position from the run's template.json; null = use file-existence fallback
let _watchConfirmedDone  = new Set(); // position numbers (not node ids) already confirmed to have reached _watchTaps hits

// ─── Canvas ───────────────────────────────────────────────────────────────────
const _canvas = document.getElementById('tpl-canvas');
const _ctx    = _canvas.getContext('2d');

function _resizeCanvas() {
  const wrap = document.getElementById('tpl-canvas-wrap');
  _canvas.width  = wrap.clientWidth;
  _canvas.height = wrap.clientHeight;
  _renderCanvas();
}
window.addEventListener('resize', _resizeCanvas);

// ─── Coordinate transforms ────────────────────────────────────────────────────
// Physical (mm) ↔ canvas screen (px), origin at canvas centre + pan offset.
// xStretch/yStretch allow independent axis scaling for projector keystone.

function _physToScreen(xMm, yMm) {
  const { scale, xStretch, yStretch, rotation, panX, panY } = _transform;
  const W = _canvas.width, H = _canvas.height;
  const rad = rotation * Math.PI / 180;
  const px  = xMm * scale * xStretch;
  const py  = yMm * scale * yStretch;
  return {
    x: W / 2 + panX + px * Math.cos(rad) - py * Math.sin(rad),
    y: H / 2 + panY + px * Math.sin(rad) + py * Math.cos(rad)
  };
}

function _screenToPhys(sx, sy) {
  const { scale, xStretch, yStretch, rotation, panX, panY } = _transform;
  const W = _canvas.width, H = _canvas.height;
  const rad = -rotation * Math.PI / 180; // inverse rotation
  const dx  = sx - W / 2 - panX;
  const dy  = sy - H / 2 - panY;
  const rx  = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry  = dx * Math.sin(rad) + dy * Math.cos(rad);
  return {
    xMm: rx / (scale * xStretch),
    yMm: ry / (scale * yStretch)
  };
}

// ─── Grid building ────────────────────────────────────────────────────────────
function _buildGridNodes() {
  const { rows, cols, xSpacing, ySpacing } = _grid;
  // Centre the grid at physical origin (0, 0)
  const centerX = ((cols - 1) * xSpacing) / 2;
  const centerY = ((rows - 1) * ySpacing) / 2;
  _nodes = [];
  let id = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      _nodes.push({
        id,
        label: String(id + 1),
        row: r,
        col: c,
        xMm: c * xSpacing - centerX,
        yMm: r * ySpacing - centerY
      });
      id++;
    }
  }
  _selected = null;
  _updateNodeDetail();
  _updateNodeCount();
  _renderCanvas();
  _pushToProjection();
}

// ─── Canvas rendering ─────────────────────────────────────────────────────────
const _NODE_R = 9; // base node circle radius (px)

// ─── Violin outline ───────────────────────────────────────────────────────────
const _violinImg = new Image();
_violinImg.src    = './violin-outline.svg';
_violinImg.onload = () => _renderCanvas();

function _drawViolinOutline() {
  if (!_violinViz.show || !_violinImg.complete || !_violinImg.naturalWidth) return;
  const { scale, xStretch, yStretch, rotation, panX, panY } = _transform;
  const W = _canvas.width, H = _canvas.height;
  const rad = rotation * Math.PI / 180;
  _ctx.save();
  _ctx.globalAlpha = _violinViz.opacity;
  _ctx.translate(W / 2 + panX, H / 2 + panY);
  _ctx.rotate(rad);
  _ctx.scale(scale * xStretch, scale * yStretch);
  if (_violinViz.orientation === 'vertical') _ctx.rotate(Math.PI / 2);
  // SVG 1514×914: body centre at SVG (890,485) → shift so it lands at mm (0,0)
  // Extra 180° so neck points the correct direction after orientation rotation
  _ctx.rotate(Math.PI);
  _ctx.drawImage(_violinImg, -200, -131.5, 400, 248);
  _ctx.restore();
}

function _renderCanvas() {
  const W = _canvas.width, H = _canvas.height;
  _ctx.clearRect(0, 0, W, H);

  // Dark background
  _ctx.fillStyle = '#221e14';
  _ctx.fillRect(0, 0, W, H);

  // Subtle crosshair at origin
  const { panX, panY } = _transform;
  _ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  _ctx.lineWidth = 1;
  _ctx.beginPath(); _ctx.moveTo(W / 2 + panX, 0); _ctx.lineTo(W / 2 + panX, H); _ctx.stroke();
  _ctx.beginPath(); _ctx.moveTo(0, H / 2 + panY); _ctx.lineTo(W, H / 2 + panY); _ctx.stroke();

  // Vertical mount preview — same -90° rotation as the projection window
  _ctx.save();
  if (_verticalMount) {
    _ctx.translate(W / 2, H / 2);
    _ctx.rotate(-Math.PI / 2);
    _ctx.translate(-W / 2, -H / 2);
  }

  _drawViolinOutline();

  if (!_nodes.length) { _ctx.restore(); return; }

  // Draw edges between row/col neighbours
  _ctx.strokeStyle = 'rgba(100,160,255,0.30)';
  _ctx.lineWidth = 1.5;
  _nodes.forEach(n => {
    const pos   = _physToScreen(n.xMm, n.yMm);
    const right = _nodes.find(m => m.row === n.row && m.col === n.col + 1);
    if (right) {
      const rp = _physToScreen(right.xMm, right.yMm);
      _ctx.beginPath(); _ctx.moveTo(pos.x, pos.y); _ctx.lineTo(rp.x, rp.y); _ctx.stroke();
    }
    const below = _nodes.find(m => m.row === n.row + 1 && m.col === n.col);
    if (below) {
      const bp = _physToScreen(below.xMm, below.yMm);
      _ctx.beginPath(); _ctx.moveTo(pos.x, pos.y); _ctx.lineTo(bp.x, bp.y); _ctx.stroke();
    }
  });

  // Draw nodes — three watch states + selection state
  const watching = _watchCurrentNode !== null || _watchDoneNodes.size > 0;
  _nodes.forEach(n => {
    const pos   = _physToScreen(n.xMm, n.yMm);
    const isSel = n.id === _selected;
    const isCur = watching && n.id === _watchCurrentNode;
    const isDone = watching && _watchDoneNodes.has(n.id);
    const r     = (isSel || isCur) ? _NODE_R + 3 : _NODE_R;

    // Halo — selection (orange) or current-node (yellow)
    if (isCur) {
      _ctx.beginPath();
      _ctx.arc(pos.x, pos.y, r + 6, 0, Math.PI * 2);
      _ctx.strokeStyle = 'rgba(255,220,0,0.45)';
      _ctx.lineWidth = 2;
      _ctx.stroke();
    } else if (isSel) {
      _ctx.beginPath();
      _ctx.arc(pos.x, pos.y, r + 4, 0, Math.PI * 2);
      _ctx.strokeStyle = 'rgba(255,153,68,0.55)';
      _ctx.lineWidth = 2;
      _ctx.stroke();
    }

    _ctx.beginPath();
    _ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    if (isCur)         _ctx.fillStyle = '#ffdd00';               // yellow — next to hit
    else if (isSel)    _ctx.fillStyle = '#ff9944';               // orange — selected for editing
    else if (isDone)   _ctx.fillStyle = 'rgba(60,90,60,0.45)';  // dark — done
    else if (watching) _ctx.fillStyle = 'rgba(80,140,255,0.50)'; // muted — pending
    else               _ctx.fillStyle = 'rgba(80,140,255,0.88)'; // normal
    _ctx.fill();

    _ctx.strokeStyle = isDone ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.6)';
    _ctx.lineWidth = 1;
    _ctx.stroke();

    _ctx.fillStyle = isDone ? 'rgba(255,255,255,0.3)' : '#fff';
    _ctx.font = `bold ${Math.max(8, Math.min(12, r - 1))}px monospace`;
    _ctx.textAlign = 'center';
    _ctx.textBaseline = 'middle';
    _ctx.fillText(n.label, pos.x, pos.y);
  });

  _ctx.restore();
}

// ─── Hit testing ──────────────────────────────────────────────────────────────
function _nodeAt(mx, my) {
  const HIT = _NODE_R + 6;
  return _nodes.find(n => {
    const pos = _physToScreen(n.xMm, n.yMm);
    return Math.hypot(pos.x - mx, pos.y - my) <= HIT;
  }) || null;
}

// ─── Canvas events ────────────────────────────────────────────────────────────
_canvas.addEventListener('mousedown', e => {
  const rect = _canvas.getBoundingClientRect();
  const mx   = e.clientX - rect.left;
  const my   = e.clientY - rect.top;
  const node = _nodeAt(mx, my);

  if (node) {
    _selected = node.id;
    _drag = { nodeId: node.id, startMX: mx, startMY: my,
              startXmm: node.xMm, startYmm: node.yMm };
  } else {
    _selected = null;
    _drag = null;
  }
  _updateNodeDetail();
  _renderCanvas();
});

// Drag on document so moves outside the canvas still work
document.addEventListener('mousemove', e => {
  const rect = _canvas.getBoundingClientRect();
  const mx   = e.clientX - rect.left;
  const my   = e.clientY - rect.top;

  if (_drag) {
    _canvas.style.cursor = 'grabbing';
    const node = _nodes.find(n => n.id === _drag.nodeId);
    if (node) {
      // Convert drag delta to new physical position via the inverse transform
      const startScreen = _physToScreen(_drag.startXmm, _drag.startYmm);
      const newPhys = _screenToPhys(
        startScreen.x + (mx - _drag.startMX),
        startScreen.y + (my - _drag.startMY)
      );
      node.xMm = newPhys.xMm;
      node.yMm = newPhys.yMm;
      _updateNodeDetail();
      _renderCanvas();
      _pushToProjection();
    }
    return;
  }

  // Hover cursor
  _canvas.style.cursor = _nodeAt(mx, my) ? 'grab' : 'default';
});

document.addEventListener('mouseup', () => { _drag = null; });

// ─── Keyboard nudge ───────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (_selected === null) return;
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].indexOf(e.key) === -1) return;

  const node = _nodes.find(n => n.id === _selected);
  if (!node) return;
  e.preventDefault();

  const step = e.shiftKey ? 0.1 : 1.0; // mm
  if (e.key === 'ArrowLeft')  node.xMm -= step;
  if (e.key === 'ArrowRight') node.xMm += step;
  if (e.key === 'ArrowUp')    node.yMm -= step;
  if (e.key === 'ArrowDown')  node.yMm += step;

  _updateNodeDetail();
  _renderCanvas();
  _pushToProjection();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    _selected = null;
    _drag = null;
    _updateNodeDetail();
    _renderCanvas();
  }
});

// ─── Sidebar: node detail ─────────────────────────────────────────────────────
function _updateNodeDetail() {
  const section = document.getElementById('node-detail-section');
  const node    = _nodes.find(n => n.id === _selected);
  if (!node) { section.style.display = 'none'; return; }
  section.style.display = '';
  document.getElementById('inp-node-label').value = node.label;
  document.getElementById('inp-node-x').value     = node.xMm.toFixed(2);
  document.getElementById('inp-node-y').value     = node.yMm.toFixed(2);
}

function _updateNodeCount() {
  const el = document.getElementById('tpl-node-count');
  if (el) el.textContent = `${_nodes.length} node${_nodes.length !== 1 ? 's' : ''}`;
}

window.tplUpdateNodeLabel = function() {
  const node = _nodes.find(n => n.id === _selected);
  if (!node) return;
  node.label = document.getElementById('inp-node-label').value;
  _renderCanvas();
  _pushToProjection();
};

window.tplUpdateNodeCoords = function() {
  const node = _nodes.find(n => n.id === _selected);
  if (!node) return;
  const x = parseFloat(document.getElementById('inp-node-x').value);
  const y = parseFloat(document.getElementById('inp-node-y').value);
  if (!isNaN(x)) node.xMm = x;
  if (!isNaN(y)) node.yMm = y;
  _renderCanvas();
  _pushToProjection();
};

window.tplResetNodeToGrid = function() {
  const node = _nodes.find(n => n.id === _selected);
  if (!node) return;
  const { xSpacing, ySpacing, cols, rows } = _grid;
  const centerX = ((cols - 1) * xSpacing) / 2;
  const centerY = ((rows - 1) * ySpacing) / 2;
  node.xMm = node.col * xSpacing - centerX;
  node.yMm = node.row * ySpacing - centerY;
  _updateNodeDetail();
  _renderCanvas();
  _pushToProjection();
};

// ─── Grid controls ────────────────────────────────────────────────────────────
function _readGrid() {
  _grid.rows     = Math.max(1, parseInt(document.getElementById('inp-rows').value)     || 4);
  _grid.cols     = Math.max(1, parseInt(document.getElementById('inp-cols').value)     || 6);
  _grid.xSpacing = parseFloat(document.getElementById('inp-xspacing').value) || 25;
  _grid.ySpacing = parseFloat(document.getElementById('inp-yspacing').value) || 20;
}

window.tplRebuildGrid = function() {
  if (_nodes.length && !confirm('Rebuild grid? All manual position adjustments will be reset.')) return;
  _readGrid();
  _buildGridNodes();
};

// ─── Transform controls ───────────────────────────────────────────────────────
window.tplSyncTransform = function() {
  _transform.scale    = parseFloat(document.getElementById('inp-scale').value)    || 5;
  _transform.xStretch = parseFloat(document.getElementById('inp-xstretch').value) || 1;
  _transform.yStretch = parseFloat(document.getElementById('inp-ystretch').value) || 1;
  _transform.rotation = parseFloat(document.getElementById('inp-rotation').value) || 0;
  _transform.panX     = parseFloat(document.getElementById('inp-panx').value)     || 0;
  _transform.panY     = parseFloat(document.getElementById('inp-pany').value)     || 0;
  _renderCanvas();
  _pushToProjection();
};

function _populateTransformForm() {
  document.getElementById('inp-scale').value    = _transform.scale;
  document.getElementById('inp-xstretch').value = _transform.xStretch.toFixed(2);
  document.getElementById('inp-ystretch').value = _transform.yStretch.toFixed(2);
  document.getElementById('inp-rotation').value = _transform.rotation;
  document.getElementById('inp-panx').value     = _transform.panX;
  document.getElementById('inp-pany').value     = _transform.panY;
}

function _populateGridForm() {
  document.getElementById('inp-rows').value     = _grid.rows;
  document.getElementById('inp-cols').value     = _grid.cols;
  document.getElementById('inp-xspacing').value = _grid.xSpacing;
  document.getElementById('inp-yspacing').value = _grid.ySpacing;
}

// ─── Projection window ────────────────────────────────────────────────────────
window.tplOpenProjection = function() {
  if (_projWindow && !_projWindow.closed) {
    _projWindow.focus();
    _pushToProjection();
    return;
  }
  _projWindow = window.open(
    './projection.html', 'tpl-projection',
    'menubar=no,toolbar=no,location=no,status=no'
  );
  // Push twice — the window may not be ready on the first attempt
  setTimeout(_pushToProjection, 700);
  setTimeout(_pushToProjection, 1600);
};

function _pushToProjection() {
  if (!_projWindow || _projWindow.closed) return;
  _projWindow.postMessage({
    type:          'tpl-update',
    nodes:         _nodes.map(n => ({ ...n })),
    transform:     { ..._transform },
    currentNode:   _watchCurrentNode,
    doneNodes:     [..._watchDoneNodes],
    violinViz:     { ..._violinViz },
    verticalMount: _verticalMount
  }, '*');
}

// ─── Data folder ──────────────────────────────────────────────────────────────
window.tplSetDataFolder = async function() {
  if (!window.showDirectoryPicker) { alert('Requires Chrome or Edge.'); return; }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    _rootDirHandle = handle;
    await saveDataFolderHandle(handle);
    const { templatesHandle, isNew } = await openObieAppSettings(handle);
    _templatesHandle = templatesHandle;
    document.getElementById('tpl-folder-name').textContent = handle.name;
    if (isNew) alert('New Data Folder created. Default settings copied in.');
  } catch (e) {
    if (e.name !== 'AbortError') alert('Folder error: ' + e.message);
  }
};

// ─── Template save ────────────────────────────────────────────────────────────
window.tplSaveTemplate = async function() {
  if (!_templatesHandle) {
    alert('Set a Data Folder first — templates save to ObieAppSettings/Templates/.');
    return;
  }
  const name = prompt('Template name:', _currentName || 'Violin Layout');
  if (!name?.trim()) return;
  _currentName = name.trim();
  _readGrid(); // capture any unsaved grid input changes

  const data = {
    name:      _currentName,
    type:      'node-stencil',
    settings:  { positions: _nodes.length },
    grid:      { ..._grid },
    transform: { ..._transform },
    nodes:     _nodes.map(n => ({ ...n }))
  };
  const safeName = _currentName.replace(/[\\/:*?"<>|]/g, '_') + '.json';
  try {
    const fh = await _templatesHandle.getFileHandle(safeName, { create: true });
    const w  = await fh.createWritable();
    await w.write(JSON.stringify(data, null, 2));
    await w.close();
    _showSaveMsg(_currentName);
  } catch (e) {
    alert('Failed to save template: ' + e.message);
  }
};

// ─── Template load modal ──────────────────────────────────────────────────────
window.tplOpenTemplateModal = async function() {
  await _refreshFolderTemplates();
  _renderTemplateList();
  document.getElementById('tpl-modal').classList.add('open');
};

window.tplCloseTemplateModal = function() {
  document.getElementById('tpl-modal').classList.remove('open');
};

async function _refreshFolderTemplates() {
  _folderTemplates = [];
  if (!_templatesHandle) return;
  try {
    for await (const entry of _templatesHandle.values()) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;
      try {
        const file = await entry.getFile();
        const data = JSON.parse(await file.text());
        if (data.type === 'node-stencil' || data.type === 'node-layout') {
          _folderTemplates.push({
            name:  data.name || entry.name.replace(/\.json$/i, ''),
            data,
            _file: entry.name
          });
        }
      } catch (_) {}
    }
  } catch (_) {}
  _folderTemplates.sort((a, b) => a.name.localeCompare(b.name));
}

function _renderTemplateList() {
  const list = document.getElementById('tpl-modal-list');
  if (!_folderTemplates.length) {
    const msg = _templatesHandle
      ? 'No node stencils found in Data Folder. Use Browse below to load a file.'
      : 'Set a Data Folder to load saved stencils, or use Browse below.';
    list.innerHTML = `<div class="tpl-list-empty">${msg}</div>`;
    return;
  }
  list.innerHTML = _folderTemplates.map((t, i) => `
    <div class="tpl-list-item">
      <div style="flex:1;cursor:pointer" onclick="tplApplyFolderTemplate(${i})">
        <div class="tpl-list-name">${t.name}</div>
        <div class="tpl-list-meta">${t.data.settings ? `${t.data.settings.positions} nodes · ${t.data.settings.input_method || 'microphone'}` : (t.data.grid ? `${t.data.grid.rows}×${t.data.grid.cols} nodes` : '')}</div>
      </div>
      <button class="tpl-list-del" title="Delete" onclick="tplDeleteFolderTemplate(${i},event)">🗑</button>
    </div>
  `).join('');
}

window.tplApplyFolderTemplate = function(i) {
  const t = _folderTemplates[i];
  if (!t) return;
  _applyTemplate(t.data);
  tplCloseTemplateModal();
};

window.tplDeleteFolderTemplate = async function(i, e) {
  e.stopPropagation();
  const t = _folderTemplates[i];
  if (!t || !confirm(`Delete template "${t.name}"?`)) return;
  try {
    await _templatesHandle.removeEntry(t._file);
    _folderTemplates.splice(i, 1);
    _renderTemplateList();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
};

window.tplBrowseTemplate = function() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      _applyTemplate(data);
      tplCloseTemplateModal();
    } catch (err) {
      alert('Could not load template: ' + err.message);
    }
  };
  input.click();
};

function _applyTemplate(data) {
  if (data.type && data.type !== 'node-stencil' && data.type !== 'node-layout') {
    if (!confirm('This file was not created by Stencil Builder. Load anyway?')) return;
  }
  if (data.grid) {
    _grid = { ..._grid, ...data.grid };
    _populateGridForm();
  }
  if (data.transform) {
    _transform = { ..._transform, ...data.transform };
    _populateTransformForm();
  }
  if (Array.isArray(data.nodes) && data.nodes.length) {
    _nodes = data.nodes.map(n => ({ ...n }));
  }
  _currentName = data.name || '';
  _selected = null;
  _updateNodeDetail();
  _updateNodeCount();
  _showNameIndicator(_currentName);
  _renderCanvas();
  _pushToProjection();
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function _showNameIndicator(name) {
  const el = document.getElementById('tpl-name-ind');
  if (el) el.textContent = name || '';
}

function _showSaveMsg(name) {
  const el = document.getElementById('tpl-name-ind');
  if (!el) return;
  el.style.color = 'var(--accent-3)';
  el.textContent = 'Saved!';
  setTimeout(() => {
    el.style.color = '';
    el.textContent = name;
  }, 2500);
}

// ─── Watch Run ────────────────────────────────────────────────────────────────
// Polls a test run's TRF/ folder every second. Determines which positions have
// been recorded by counting TRF files, then drives the projection window.
// No interaction with Acquire — the data folder is the shared state layer.

let _scannedRuns = []; // [{instrument, run, label, trfHandle, testHandle}]

window.tplOpenWatchModal = async function() {
  if (!_rootDirHandle) {
    alert('Set a Data Folder first to see available runs.');
    return;
  }
  document.getElementById('watch-modal').classList.add('open');
  await tplRefreshRunList();
};

window.tplCloseWatchModal = function() {
  document.getElementById('watch-modal').classList.remove('open');
};

window.tplRefreshRunList = async function() {
  const list = document.getElementById('watch-run-list');
  list.innerHTML = '<div class="tpl-list-empty">Scanning…</div>';
  _scannedRuns = await _scanRuns();
  _renderRunList();
};

async function _scanRuns() {
  const runs = [];
  if (!_rootDirHandle) return runs;
  try {
    for await (const instrEntry of _rootDirHandle.values()) {
      if (instrEntry.kind !== 'directory' || instrEntry.name === 'ObieAppSettings') continue;
      try {
        for await (const runEntry of instrEntry.values()) {
          if (runEntry.kind !== 'directory') continue;
          try {
            const trfHandle = await runEntry.getDirectoryHandle('TRF');
            // Count TRF files already in this folder
            let trfCount = 0;
            for await (const f of trfHandle.values()) {
              if (f.kind === 'file' && f.name.toLowerCase().endsWith('.trf')) trfCount++;
            }
            runs.push({
              instrument: instrEntry.name,
              run:        runEntry.name,
              label:      `${instrEntry.name} / ${runEntry.name}`,
              trfHandle,
              testHandle: runEntry,
              trfCount
            });
          } catch (_) {} // no TRF/ subfolder — not an Acquire run folder
        }
      } catch (_) {}
    }
  } catch (_) {}
  // Sort by instrument then run name
  return runs.sort((a, b) =>
    a.instrument !== b.instrument
      ? a.instrument.localeCompare(b.instrument)
      : a.run.localeCompare(b.run)
  );
}

function _renderRunList() {
  const list = document.getElementById('watch-run-list');
  if (!_scannedRuns.length) {
    list.innerHTML = '<div class="tpl-list-empty">No Acquire run folders found in the Data Folder.<br>Make sure you have set up an instrument and started a run in Acquire first.</div>';
    return;
  }
  list.innerHTML = _scannedRuns.map((r, i) => `
    <div class="watch-run-item">
      <div class="watch-run-info">
        <div class="watch-run-name">${r.label}</div>
        <div class="watch-run-meta">${r.trfCount} TRF file${r.trfCount !== 1 ? 's' : ''} recorded</div>
      </div>
      <button class="act-btn accent" onclick="tplStartWatching(${i})">Watch</button>
    </div>
  `).join('');
}

window.tplStartWatching = async function(i) {
  const run = _scannedRuns[i];
  if (!run) return;

  // Stop any existing watch first
  tplStopWatching(true);

  _watchHandle          = run.trfHandle;
  _watchTestHandle      = run.testHandle;
  _watchRunLabel        = run.label;
  _watchTaps            = null;
  _watchConfirmedDone   = new Set();

  // Read template.json once per watch session (not per poll tick) — used both
  // to merge the node layout in and to cache taps-per-position for _pollTRF's
  // hit-count-based done-detection. Missing/invalid taps just means _pollTRF
  // falls back to its old file-existence heuristic.
  let existing = {};
  if (_watchTestHandle) {
    try {
      const rfh = await _watchTestHandle.getFileHandle('template.json');
      existing = JSON.parse(await (await rfh.getFile()).text());
    } catch (_) {}
    const t = Number(existing.taps);
    _watchTaps = Number.isFinite(t) && t > 0 ? t : null;
  }

  // Merge node layout into template.json (the unified run file)
  if (_nodes.length && _watchTestHandle) {
    try {
      const stencilPatch = {
        ...((existing.stencil) ? existing.stencil : {}),
        name:  _currentName || existing.stencil?.name || 'Node Layout',
        type:  'node-stencil',
        nodes: _nodes.map(n => ({ ...n })),
        grid:  { ..._grid }
      };
      const fh = await _watchTestHandle.getFileHandle('template.json', { create: true });
      const w  = await fh.createWritable();
      await w.write(JSON.stringify({ ...existing, stencil: stencilPatch }, null, 2));
      await w.close();
    } catch (e) {
      console.warn('Could not write stencil to template.json:', e.message);
    }
  }

  // Start polling
  await _pollTRF(); // immediate first poll
  _watchInterval = setInterval(_pollTRF, 1000);

  // Update toolbar
  _updateWatchUI(true);
  tplCloseWatchModal();
};

window.tplStopWatching = function(silent) {
  if (_watchInterval) { clearInterval(_watchInterval); _watchInterval = null; }
  _watchHandle         = null;
  _watchTestHandle     = null;
  _watchRunLabel       = '';
  _watchCurrentNode    = null;
  _watchDoneNodes      = new Set();
  _watchTaps           = null;
  _watchConfirmedDone  = new Set();
  _updateWatchUI(false);
  _renderCanvas();
  _pushToProjection();
};

// Find the first occurrence of `needle` bytes within `hay`. Returns -1 if absent.
function _findBytes(hay, needle) {
  outer:
  for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// Reads the plain-text metadata block Acquire appends after a TRF's binary
// data (see Python/fileio/trf_fileio.py's OBIE_META marker/format). Returns
// {} — never throws — if the block is missing (older TRF) or unreadable
// (e.g. mid-write), so callers can treat that as "unknown, not yet done."
async function _readTrfMeta(fileHandle) {
  try {
    const bytes  = new Uint8Array(await (await fileHandle.getFile()).arrayBuffer());
    const MARKER = new TextEncoder().encode('\x00OBIE_META\n'); // 11 bytes
    const idx    = _findBytes(bytes, MARKER);
    if (idx === -1) return {};
    const tail = new TextDecoder('utf-8').decode(bytes.subarray(idx + MARKER.length));
    const meta = {};
    for (const line of tail.split('\n')) {
      const c = line.indexOf(':');
      if (c > -1) meta[line.slice(0, c).trim()] = line.slice(c + 1).trim();
    }
    return meta;
  } catch (_) { return {}; }
}

async function _pollTRF() {
  if (!_watchHandle) return;

  // entry.name → position number, plus the entry (file) handle itself so we
  // can read its metadata without a second directory lookup.
  const byPos = new Map();
  try {
    for await (const entry of _watchHandle.values()) {
      if (entry.kind !== 'file') continue;
      const m = entry.name.match(/_(\d+)\.trf$/i);
      if (m) byPos.set(parseInt(m[1], 10), entry);
    }
  } catch (_) { return; }

  const sorted = [...byPos.keys()].sort((a, b) => a - b);

  if (sorted.length === 0) {
    // No TRFs yet (fresh run or after Start Over) — show first node
    _watchDoneNodes   = new Set();
    _watchCurrentNode = _nodes.length ? 0 : null;

  } else if (_watchTaps == null) {
    // No taps count available (missing/malformed template.json) — fall back
    // to the old file-existence heuristic so watch mode still degrades
    // gracefully instead of breaking.
    if (sorted.length > _nodes.length) {
      _watchDoneNodes   = new Set(sorted.map(p => p - 1));
      _watchCurrentNode = null;
    } else {
      const maxPos = sorted[sorted.length - 1];
      _watchDoneNodes   = new Set(sorted.filter(p => p < maxPos).map(p => p - 1));
      _watchCurrentNode = maxPos - 1;
    }

  } else {
    // Real done-detection: a position is done once its OWN file reports
    // n_hits >= taps — not merely because a later position's file exists.
    // This is what kills the one-hit lag: the moment the final hit at a
    // position lands, that position's own file already carries the
    // completed count, so we can advance immediately.
    const doneNodes = new Set();
    for (const pos of sorted) {
      if (_watchConfirmedDone.has(pos)) { doneNodes.add(pos - 1); continue; }
      const meta   = await _readTrfMeta(byPos.get(pos));
      const nHits  = parseInt(meta.n_hits, 10);
      if (Number.isFinite(nHits) && nHits >= _watchTaps) {
        doneNodes.add(pos - 1);
        _watchConfirmedDone.add(pos);
      }
      // else: not done yet — leave it out of doneNodes, it's in progress.
    }
    _watchDoneNodes = doneNodes;

    const firstNotDone = sorted.find(p => !doneNodes.has(p - 1));
    if (firstNotDone != null) {
      _watchCurrentNode = firstNotDone - 1;
    } else {
      // Every position we've seen a file for is done — advance to the next
      // unseen node, or finish if that would run past the stencil's node count.
      _watchCurrentNode = sorted.length < _nodes.length ? sorted.length : null;
    }
  }

  _renderCanvas();
  _pushToProjection();
}

function _updateWatchUI(active) {
  const watchBtn = document.getElementById('tpl-watch-btn');
  const stopBtn  = document.getElementById('tpl-stop-btn');
  const resetBtn = document.getElementById('tpl-reset-btn');
  const watchInd = document.getElementById('tpl-watch-ind');
  if (active) {
    if (watchBtn) watchBtn.style.display = 'none';
    if (stopBtn)  stopBtn.style.display  = '';
    if (resetBtn) resetBtn.style.display = '';
    if (watchInd) {
      const countHint = _nodes.length ? ` · Set Acquire Positions → ${_nodes.length}` : '';
      watchInd.textContent = `● ${_watchRunLabel}${countHint}`;
      watchInd.style.display = '';
    }
  } else {
    if (watchBtn) watchBtn.style.display = '';
    if (stopBtn)  stopBtn.style.display  = 'none';
    if (resetBtn) resetBtn.style.display = 'none';
    if (watchInd) { watchInd.textContent = ''; watchInd.style.display = 'none'; }
  }
}

window.tplResetWatch = async function() {
  // Check if the current TRF folder is still the active one.
  // After Acquire's "Start Over", it creates a new test folder and the old one
  // becomes empty — we auto-advance to the newest non-empty run.
  let folderIsStale = false;
  if (_watchHandle) {
    try {
      let count = 0;
      for await (const _ of _watchHandle.values()) { count++; break; }
      // Empty AND there's a data folder to scan means Acquire moved on
      if (count === 0 && _rootDirHandle) folderIsStale = true;
    } catch { folderIsStale = true; }
  }

  if (folderIsStale) {
    // Re-scan all runs and switch to the newest (last alphabetically per instrument)
    const runs = await _scanRuns();
    if (runs.length > 0) {
      // Pick the newest: last in the sorted list (sorted by instrument→run name)
      const newest = runs[runs.length - 1];
      _watchHandle     = newest.trfHandle;
      _watchTestHandle = newest.testHandle;
      _watchRunLabel   = newest.label;
      _updateWatchUI(true);
    }
  }

  _watchDoneNodes   = new Set();
  _watchCurrentNode = _nodes.length ? 0 : null;
  _renderCanvas();
  _pushToProjection();
  await _pollTRF(); // re-read actual folder state
};

// ─── Violin outline controls ──────────────────────────────────────────────────
window.tplToggleViolin = function() {
  _violinViz.show = !_violinViz.show;
  const btn = document.getElementById('tpl-violin-btn');
  if (btn) btn.textContent = _violinViz.show ? 'Hide Outline' : 'Show Outline';
  _renderCanvas();
  _pushToProjection();
};

window.tplSetViolinOrientation = function(val) {
  _violinViz.orientation = val;
  _renderCanvas();
  _pushToProjection();
};

window.tplSetViolinOpacity = function(val) {
  _violinViz.opacity = parseFloat(val);
  const lbl = document.getElementById('violin-opacity-lbl');
  if (lbl) lbl.textContent = Math.round(parseFloat(val) * 100) + '%';
  _renderCanvas();
  _pushToProjection();
};

// ─── Vertical projector mount ─────────────────────────────────────────────────
window.tplToggleVerticalMount = function() {
  _verticalMount = !_verticalMount;
  const btn = document.getElementById('tpl-vmount-btn');
  if (btn) btn.classList.toggle('accent', _verticalMount);
  _renderCanvas();
  _pushToProjection();
};

// ─── Help ─────────────────────────────────────────────────────────────────────
window.tplHelp = function() { window.open('../../Docs/index.html', '_blank'); };

// ─── Init ─────────────────────────────────────────────────────────────────────
(async function _init() {
  _resizeCanvas();
  _buildGridNodes();

  // Restore data folder from shared IDB handle
  try {
    const handle = await loadDataFolderHandle();
    if (handle) {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        _rootDirHandle = handle;
        const { templatesHandle } = await openObieAppSettings(handle);
        _templatesHandle = templatesHandle;
        document.getElementById('tpl-folder-name').textContent = handle.name;
      }
    }
  } catch (_) {}
})();
