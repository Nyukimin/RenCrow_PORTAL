(() => {
  'use strict';

  const ASSET_BASE_URL = new URL('/assets/purupuru/', window.location.origin).href;
  const VIRTUAL_STAGE = Object.freeze({width: 1280, height: 720});
  const instances = new Set();
  let animationFrameID = 0;
  let latestPointer = null;

  function runStage(timestamp) {
    animationFrameID = requestAnimationFrame(runStage);
    if (document.hidden) return;
    instances.forEach((runtime) => runtime.frame(timestamp));
  }

  function ensureStageRunning() {
    if (!animationFrameID) animationFrameID = requestAnimationFrame(runStage);
  }

  function virtualPointer(clientX, clientY) {
    return {
      x: (Number(clientX) || 0) * VIRTUAL_STAGE.width / Math.max(1, window.innerWidth),
      y: (Number(clientY) || 0) * VIRTUAL_STAGE.height / Math.max(1, window.innerHeight),
    };
  }

  // The upstream control surface receives pointer movement over its full-stage
  // canvas. PORTAL renders the canvas inside non-interactive portrait hosts, so
  // forward the page pointer in the same 1280x720 coordinate space instead.
  window.addEventListener('pointermove', (event) => {
    latestPointer = virtualPointer(event.clientX, event.clientY);
    instances.forEach((runtime) => runtime.setPointer(latestPointer.x, latestPointer.y));
  }, {passive: true});

  function scopedStorage(namespace) {
    const prefix = `rencrow.purupuru.${namespace}.`;
    return {
      get length() {
        let count = 0;
        for (let index = 0; index < localStorage.length; index += 1) {
          if (String(localStorage.key(index) || '').startsWith(prefix)) count += 1;
        }
        return count;
      },
      key(index) {
        const keys = [];
        for (let cursor = 0; cursor < localStorage.length; cursor += 1) {
          const key = String(localStorage.key(cursor) || '');
          if (key.startsWith(prefix)) keys.push(key.slice(prefix.length));
        }
        return keys[index] ?? null;
      },
      getItem(key) {
        return localStorage.getItem(prefix + key);
      },
      setItem(key, value) {
        localStorage.setItem(prefix + key, String(value));
      },
      removeItem(key) {
        localStorage.removeItem(prefix + key);
      },
      clear() {
        const keys = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = String(localStorage.key(index) || '');
          if (key.startsWith(prefix)) keys.push(key);
        }
        keys.forEach((key) => localStorage.removeItem(key));
      },
    };
  }

  function createScopedDocument(root, shell) {
    return new Proxy(document, {
      get(target, property) {
        if (property === 'body' || property === 'documentElement' || property === 'head') return shell;
        if (property === 'activeElement') return root.activeElement || target.activeElement;
        if (property === 'querySelector') return root.querySelector.bind(root);
        if (property === 'querySelectorAll') return root.querySelectorAll.bind(root);
        if (property === 'getElementById') return (id) => root.querySelector(`#${CSS.escape(String(id))}`);
        if (property === 'elementFromPoint' && typeof root.elementFromPoint === 'function') {
          return root.elementFromPoint.bind(root);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  function createScopedWindow(host, scopedDocument, character) {
    const runtimeURL = new URL(`index.html?mode=portal&transparent=1&character=${encodeURIComponent(character)}`, ASSET_BASE_URL);
    let proxy;
    proxy = new Proxy(window, {
      get(target, property) {
        if (property === 'document') return scopedDocument;
        if (property === 'location') return runtimeURL;
        if (property === 'innerWidth') return VIRTUAL_STAGE.width;
        if (property === 'innerHeight') return VIRTUAL_STAGE.height;
        if (property === 'devicePixelRatio') return 1;
        if (property === 'parent' || property === 'top' || property === 'self') return proxy;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return proxy;
  }

  let templatePromise;
  async function loadTemplate() {
    if (!templatePromise) {
      templatePromise = fetch(new URL('index.html', ASSET_BASE_URL), {cache: 'no-store'})
        .then((response) => {
          if (!response.ok) throw new Error(`PuruPuru template HTTP ${response.status}`);
          return response.text();
        })
        .then((source) => {
          const parsed = new DOMParser().parseFromString(source, 'text/html');
          parsed.querySelectorAll('script').forEach((script) => script.remove());
          return parsed.body.innerHTML;
        });
    }
    return templatePromise;
  }

  class PuruPuruAvatarElement extends HTMLElement {
    constructor() {
      super();
      this.runtime = null;
      this.mountToken = 0;
    }

    async connectedCallback() {
      const token = ++this.mountToken;
      const character = String(this.getAttribute('character') || '').trim().toLowerCase();
      if (!['mio', 'shiro', 'midori'].includes(character)) {
        this.dataset.runtimeState = 'error';
        throw new Error(`Unknown PuruPuru character: ${character}`);
      }
      this.dataset.runtimeState = 'loading';
      const root = this.shadowRoot || this.attachShadow({mode: 'open'});
      const shell = document.createElement('div');
      shell.className = 'purupuru-runtime-document';
      shell.setAttribute('data-character', character);

      const upstreamStyle = document.createElement('link');
      upstreamStyle.rel = 'stylesheet';
      upstreamStyle.href = new URL('styles.css', ASSET_BASE_URL).href;
      const hostStyle = document.createElement('link');
      hostStyle.rel = 'stylesheet';
      hostStyle.href = new URL('runtime-host.css', ASSET_BASE_URL).href;
      root.replaceChildren(upstreamStyle, hostStyle, shell);

      try {
        shell.innerHTML = await loadTemplate();
        if (token !== this.mountToken || !this.isConnected) return;
        const scopedDocument = createScopedDocument(root, shell);
        const scopedWindow = createScopedWindow(this, scopedDocument, character);
        const registry = window.PuruPuruRuntime;
        if (!registry || typeof registry.boot !== 'function') throw new Error('PuruPuru runtime factory is unavailable');
        const runtime = registry.boot({
          portal: true,
          character,
          window: scopedWindow,
          document: scopedDocument,
          localStorage: scopedStorage(character),
          indexedDB: window.indexedDB,
          assetBaseURL: ASSET_BASE_URL,
          mouseFollowEnabled: false,
          // PuruPuru's pointer response reserves the standalone 448px control
          // dock plus its 20px right margin. The dock is visually hidden in
          // PORTAL, but retaining this virtual edge preserves the same motion
          // curve for the same stage coordinates.
          controlPanelLeft: VIRTUAL_STAGE.width - 20 - Math.min(448, VIRTUAL_STAGE.width - 40),
        });
        this.runtime = runtime;
        instances.add(runtime);
        ensureStageRunning();
        await runtime.ready;
        if (token !== this.mountToken || !this.isConnected) return;
        runtime.setVoiceLevel(0);
        if (latestPointer) runtime.setPointer(latestPointer.x, latestPointer.y);
        this.dataset.runtimeState = 'ready';
        this.dispatchEvent(new CustomEvent('purupuru-ready', {
          bubbles: true,
          composed: true,
          detail: {character},
        }));
      } catch (error) {
        this.dataset.runtimeState = 'error';
        this.dispatchEvent(new CustomEvent('purupuru-error', {
          bubbles: true,
          composed: true,
          detail: {character, message: String(error && error.message || error)},
        }));
        console.error(`PuruPuru ${character} runtime failed`, error);
      }
    }

    disconnectedCallback() {
      this.mountToken += 1;
      if (!this.runtime) return;
      instances.delete(this.runtime);
      this.runtime.destroy();
      this.runtime = null;
    }

    setInput(input) {
      this.runtime?.setInput(input);
    }

    setPointer(clientX, clientY) {
      this.runtime?.setPointer(clientX, clientY);
    }

    setVoiceLevel(raw) {
      this.runtime?.setVoiceLevel(raw);
    }

    debugState() {
      return this.runtime?.debugState() || null;
    }
  }

  if (!customElements.get('purupuru-avatar')) {
    customElements.define('purupuru-avatar', PuruPuruAvatarElement);
  }
})();
