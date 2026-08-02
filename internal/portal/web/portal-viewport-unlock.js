(() => {
  'use strict';

  const restore = window.__restorePortalViewportListenerRegistration;
  if (typeof restore === 'function') restore();
  document.body.dataset.chatCanvasFitPolicy = 'initial-only';
})();
