/**
 * version-nav.js — shared by every tool page (loaded in <head>, right after
 * browser-check.js). Two unrelated jobs, both needing to run on every page
 * so neither has its own separate <script> tag to remember:
 *
 * 1. Detects whether this page is being served from a frozen
 *    Web/versions/X.Y.Z/ snapshot or from the live Web/tools/ tree:
 *      - Live tree (Beta or Experimental — anything not archived): adds an
 *        `obie-beta` class to <html>, which theme.css uses to swap the
 *        header's brown accent for purple as a quick "this isn't the stable
 *        release" visual signal.
 *      - Archived snapshot: the header's "brand" logo and "← All tools"
 *        links are hardcoded as `href="../../index.html"`, which — from
 *        inside versions/X.Y.Z/tools/<tool>/ — only reaches that frozen
 *        snapshot's own home page, not the live site. Rewrites them one
 *        level further out so clicking the header always returns to the
 *        current/live home page.
 * 2. Injects a "⟳ Refresh" button into the header. The coi-serviceworker.js
 *    registered on every page can keep serving a stale cached copy of a
 *    tool's JS/CSS indefinitely — even across a hard reload or a browser
 *    restart, since both the service worker registration and the HTTP cache
 *    live on disk in the profile. Most people hitting this won't know
 *    DevTools exists, let alone how to unregister a service worker there, so
 *    this button does it for them: unregister every service worker for this
 *    origin, clear the Cache Storage, then reload.
 */
(function () {
  var parts = window.location.pathname.split('/').filter(Boolean);
  var vIdx = parts.indexOf('versions');
  var isArchived = vIdx >= 0 && /^\d+\.\d+\.\d+$/.test(parts[vIdx + 1] || '');

  if (!isArchived) {
    document.documentElement.classList.add('obie-beta');
  } else {
    var fixArchivedNavLinks = function () {
      document.querySelectorAll('a[href="../../index.html"]').forEach(function (a) {
        a.href = '../../../../index.html';
      });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fixArchivedNavLinks);
    } else {
      fixArchivedNavLinks();
    }
  }

  async function obieForceRefresh() {
    if (!confirm(
      'Reload this page and clear its cached files?\n\n' +
      'Use this if the page looks out of date after a site update. ' +
      'Any unsaved work in progress on this page will be lost.'
    )) return;
    try {
      if ('serviceWorker' in navigator) {
        var regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(function (r) { return r.unregister(); }));
      }
    } catch (_) {}
    try {
      if ('caches' in window) {
        var keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }
    } catch (_) {}
    location.reload();
  }
  window.obieForceRefresh = obieForceRefresh;

  function injectRefreshButton() {
    var header = document.querySelector('header.obie-header');
    if (!header || document.getElementById('obie-force-refresh-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'obie-force-refresh-btn';
    btn.className = 'btn';
    btn.style.cssText = 'font-size:0.75rem;padding:3px 9px';
    btn.title = 'Force-reload this page and clear its cached files — use this if it looks out of date';
    btn.textContent = '⟳ Refresh';
    btn.onclick = obieForceRefresh;
    header.appendChild(btn);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectRefreshButton);
  } else {
    injectRefreshButton();
  }
})();
