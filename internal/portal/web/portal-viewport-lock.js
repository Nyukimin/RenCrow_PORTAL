(() => {
  'use strict';

  const prototype = EventTarget.prototype;
  const originalAddEventListener = prototype.addEventListener;
  const visualViewport = window.visualViewport;

  function guardedAddEventListener(type, listener, options) {
    const blocksWindowRefit = this === window && (type === 'resize' || type === 'pageshow');
    const blocksVisualViewportRefit = visualViewport && this === visualViewport && (type === 'resize' || type === 'scroll');
    if (blocksWindowRefit || blocksVisualViewportRefit) return;
    return originalAddEventListener.call(this, type, listener, options);
  }

  prototype.addEventListener = guardedAddEventListener;
  window.__restorePortalViewportListenerRegistration = () => {
    if (prototype.addEventListener === guardedAddEventListener) {
      prototype.addEventListener = originalAddEventListener;
    }
    delete window.__restorePortalViewportListenerRegistration;
  };
})();
