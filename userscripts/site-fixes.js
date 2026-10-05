// ==UserScript==
// @name         Site Fixes (qute-ai-fix)
// @description  Applies per-domain CSS and adblock fixes saved by qute-ai-fix
// @version      1.0
// @author       omarchy-qutebrowser
// @namespace    https://github.com/Maximilian-Maag/omarchy-qutebrowser
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// NOTE: Greasemonkey scripts in qutebrowser run inside the page's JS sandbox
// and cannot access the filesystem directly. The actual fix data is injected
// into the page by qutebrowser via a meta tag written by the theme-set hook
// mechanism, or via a second Greasemonkey script that reads from localStorage.
//
// Architecture: qute-ai-fix writes fixes to ~/.local/state/.../site-fixes/<domain>.json
// The install.sh sets up a qutebrowser config hook that reads the fix file for
// the current domain and injects it as a <meta> tag or window variable before
// the page loads, via qutebrowser's content.javascript.extra_urls mechanism.
//
// For now: fixes are applied via a userChrome-style injection through
// qutebrowser's stylesheet mechanism. The CSS hides are written to
// ~/.config/qutebrowser/site-overrides.css and loaded via content.user_stylesheets.

(function () {
  'use strict';

  // Read fix data injected by qutebrowser's run_js mechanism
  // qute-ai-fix writes fixes to the page via:
  //   window.__omarchyFixes = { css_hide: [...], css_override: [...] }
  // This is set by a per-page JS injection configured in site-overrides.py

  function applyFixes(fixes) {
    if (!fixes) return;

    try {
      var style = document.createElement('style');
      style.id = 'omarchy-site-fixes';
      var css = '';

      // Hide elements
      if (fixes.css_hide && fixes.css_hide.length > 0) {
        css += fixes.css_hide.join(',\n') + ' { display: none !important; visibility: hidden !important; }\n';
      }

      // CSS overrides (verbatim rules)
      if (fixes.css_override && fixes.css_override.length > 0) {
        css += fixes.css_override.join('\n') + '\n';
      }

      if (css) {
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
      }
    } catch(e) {}
  }

  // Apply immediately if data is already in window (injected before document-start)
  try {
    if (window.__omarchyFixes) {
      applyFixes(window.__omarchyFixes);
    }
  } catch(e) {}

  // Also watch for late injection
  document.addEventListener('DOMContentLoaded', function() {
    try {
      if (window.__omarchyFixes) {
        applyFixes(window.__omarchyFixes);
      }
    } catch(e) {}
  });

  // MutationObserver: re-apply if fixes were injected after load
  var applied = false;
  new MutationObserver(function() {
    if (!applied && window.__omarchyFixes) {
      applied = true;
      applyFixes(window.__omarchyFixes);
    }
  }).observe(document.documentElement, { childList: true, subtree: false });

})();
