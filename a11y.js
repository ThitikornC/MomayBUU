// ==================== Keyboard access for clickable elements ====================
// Many controls in index.html are <div onclick> / <img onclick>. This gives each one a
// button role and makes Enter/Space activate it, so they work without a mouse and
// screen readers announce them. Elements added later are handled too.
(function () {
  'use strict';
  const NATIVE = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|LABEL|OPTION)$/;

  function enhance(el) {
    if (NATIVE.test(el.tagName) || el.dataset.a11y) return;
    el.dataset.a11y = '1';
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('aria-label') && !el.textContent.trim()) {
      const img = el.tagName === 'IMG' ? el : el.querySelector('img[alt]');
      const label = el.getAttribute('title') || (img && img.getAttribute('alt')) || el.id;
      if (label) el.setAttribute('aria-label', label);
    }
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.hasAttribute('onclick')) enhance(root);
    root.querySelectorAll('[onclick]').forEach(enhance);
  }

  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.a11y) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.click();
    }
  });

  function start() {
    scan(document.body);
    new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(scan)))
      .observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
