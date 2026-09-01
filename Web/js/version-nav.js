/**
 * version-nav.js — shared by every tool page (loaded in <head>, right after
 * browser-check.js). Detects whether this page is being served from a frozen
 * Web/versions/X.Y.Z/ snapshot or from the live Web/tools/ tree:
 *
 *   - Live tree (Beta or Experimental — anything not archived): adds an
 *     `obie-beta` class to <html>, which theme.css uses to swap the header's
 *     brown accent for purple as a quick "this isn't the stable release"
 *     visual signal.
 *   - Archived snapshot: the header's "brand" logo and "← All tools" links
 *     are hardcoded as `href="../../index.html"`, which — from inside
 *     versions/X.Y.Z/tools/<tool>/ — only reaches that frozen snapshot's own
 *     home page, not the live site. Rewrites them one level further out so
 *     clicking the header always returns to the current/live home page.
 */
(function () {
  var parts = window.location.pathname.split('/').filter(Boolean);
  var vIdx = parts.indexOf('versions');
  var isArchived = vIdx >= 0 && /^\d+\.\d+\.\d+$/.test(parts[vIdx + 1] || '');

  if (!isArchived) {
    document.documentElement.classList.add('obie-beta');
    return;
  }

  function fixArchivedNavLinks() {
    document.querySelectorAll('a[href="../../index.html"]').forEach(function (a) {
      a.href = '../../../../index.html';
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fixArchivedNavLinks);
  } else {
    fixArchivedNavLinks();
  }
})();
