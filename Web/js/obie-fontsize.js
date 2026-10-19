/**
 * obie-fontsize.js — shared by every page (loaded in <head>, right after
 * version-nav.js on tool pages / browser-check.js on the home page).
 *
 * Page-wide text/UI size. Uses CSS `zoom` on <html>, because the tools size
 * most things in fixed px (and Plotly draws its own text), so a root
 * font-size change would only reach a fraction of the UI. Zoom scales the
 * toolbar, dialogs and plots together.
 *
 * - Choice is stored in localStorage `obieFontScale` (percent). All tools
 *   share one origin, so one choice applies everywhere.
 * - With no stored choice the default depends on the platform: Windows/Linux
 *   get a larger default than macOS, where the system already renders small
 *   text more crisply.
 * - "A−" / "A+" buttons are added to the page's header (header.obie-header).
 *
 * `zoom` also scales `100vh`, so full-height page roots would overflow the
 * window by the zoom factor. The injected stylesheet divides them back down.
 */
(function () {
  var KEY = 'obieFontScale';
  var STEPS = [90, 100, 115, 130, 150, 175];

  function isMac() {
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /mac/i.test(p);
  }
  // Edit these two numbers to change the out-of-the-box size per platform.
  var DEFAULT_MAC = 100;
  var DEFAULT_PC  = 115;
  function platformDefault() { return isMac() ? DEFAULT_MAC : DEFAULT_PC; }

  function stored() {
    try {
      var v = parseInt(localStorage.getItem(KEY), 10);
      return STEPS.indexOf(v) >= 0 ? v : null;
    } catch (_) { return null; }
  }
  function current() { var s = stored(); return s == null ? platformDefault() : s; }

  function apply(pct) {
    var z = pct / 100;
    var st = document.getElementById('obie-fontsize-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'obie-fontsize-style';
      document.head.appendChild(st);
    }
    st.textContent = z === 1 ? '' :
      'html{zoom:' + z + '}' +
      'html,body{min-height:calc(100vh / ' + z + ')}' +
      'body>*:not(script):not(style):not(.loading-overlay){max-height:calc(100vh / ' + z + ')}';
    var lbl = document.getElementById('obie-fontsize-lbl');
    if (lbl) lbl.textContent = pct + '%';
    var dn = document.getElementById('obie-fontsize-dn');
    var up = document.getElementById('obie-fontsize-up');
    if (dn) dn.disabled = pct <= STEPS[0];
    if (up) up.disabled = pct >= STEPS[STEPS.length - 1];
    // Let Plotly and any other size-aware code re-measure.
    window.dispatchEvent(new Event('resize'));
  }

  function step(dir) {
    var cur = current();
    var i = STEPS.indexOf(cur);
    if (i < 0) i = STEPS.indexOf(platformDefault());
    var next = STEPS[Math.min(STEPS.length - 1, Math.max(0, i + dir))];
    try { localStorage.setItem(KEY, String(next)); } catch (_) {}
    apply(next);
  }
  window.obieFontStep = step;
  window.obieFontReset = function () {
    try { localStorage.removeItem(KEY); } catch (_) {}
    apply(platformDefault());
  };

  function injectButtons() {
    var header = document.querySelector('header.obie-header');
    if (!header || document.getElementById('obie-fontsize-wrap')) return;
    var wrap = document.createElement('span');
    wrap.id = 'obie-fontsize-wrap';
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:3px';
    wrap.title = 'Text size for all ObieWebApp tools — double-click the percentage to reset to the default for this computer (' + platformDefault() + '%)';
    wrap.innerHTML =
      '<button id="obie-fontsize-dn" class="btn" style="font-size:0.75rem;padding:3px 8px" onclick="obieFontStep(-1)" title="Smaller text">A−</button>' +
      '<span id="obie-fontsize-lbl" style="font-size:0.7rem;min-width:2.4em;text-align:center;cursor:default" ondblclick="obieFontReset()"></span>' +
      '<button id="obie-fontsize-up" class="btn" style="font-size:0.75rem;padding:3px 8px" onclick="obieFontStep(1)" title="Larger text">A+</button>';
    // Sit just before the Refresh button when it exists, otherwise at the end.
    var refresh = document.getElementById('obie-force-refresh-btn');
    if (refresh && refresh.parentNode === header) header.insertBefore(wrap, refresh);
    else header.appendChild(wrap);
    apply(current());
  }

  apply(current());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButtons);
  } else {
    injectButtons();
  }
  // version-nav.js adds the Refresh button on DOMContentLoaded too; re-run
  // once everything has loaded so ordering never leaves A−/A+ after it.
  window.addEventListener('load', function () {
    var wrap = document.getElementById('obie-fontsize-wrap');
    var refresh = document.getElementById('obie-force-refresh-btn');
    if (wrap && refresh && wrap.parentNode === refresh.parentNode && wrap.nextSibling !== refresh) {
      refresh.parentNode.insertBefore(wrap, refresh);
    }
  });
})();
