'use strict';

window.setupHelp = function() { window.open('../../Docs/experimental.html', '_blank'); };
window.setupTips = function() { window.open('../../Docs/shortcuts.html', '_blank'); };

// ── OS detection ──────────────────────────────────────────────────────────────
window._currentOS = (function() {
  const ua = navigator.userAgent;
  if (ua.includes('Win')) return 'windows';
  if (ua.includes('Linux')) return 'linux';
  return 'mac';
})();

// ── Mode tabs ─────────────────────────────────────────────────────────────────
const MODES = ['web', 'offline', 'python'];
window._currentMode = 'web';

window.setMode = function(mode) {
  _currentMode = mode;
  MODES.forEach(m => {
    const panel = document.getElementById('mode-' + m);
    const btn   = document.getElementById('mode-' + m + '-btn');
    if (panel) panel.style.display = m === mode ? '' : 'none';
    if (btn)   btn.classList.toggle('active', m === mode);
  });
  setOS(_currentOS);
};

// ── OS tab switcher ───────────────────────────────────────────────────────────
window.setOS = function(os) {
  _currentOS = os;
  document.querySelectorAll('.os-tab[data-os]').forEach(t =>
    t.classList.toggle('active', t.dataset.os === os)
  );
  document.querySelectorAll('.os-content').forEach(c =>
    c.classList.toggle('active', c.dataset.os === os)
  );
};

// ── Copy-to-clipboard ─────────────────────────────────────────────────────────
window.copyCode = function(btn) {
  const pre = btn.closest('.code-block').querySelector('pre');
  navigator.clipboard.writeText(pre.textContent.trim()).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }).catch(() => {});
};

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', function() {
  setMode('web');
  setOS(_currentOS);
});
