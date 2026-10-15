(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.RenCrowWorldPOC = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const snapshotURL = '/api/world-poc/viewer/world/snapshot';
  const streamURL = '/api/world-poc/viewer/world/stream';
  const maxUint64 = 18446744073709551615n;
  const revisionFieldsByObject = new WeakMap();

  function streamURLAfterRevision(baseURL, revision) {
    const separator = baseURL.includes('?') ? '&' : '?';
    return `${baseURL}${separator}after_revision=${encodeURIComponent(revision)}`;
  }

  function quoteWorldRevisionNumbers(text) {
    let output = '';
    const numericRevisionFields = new Set();
    const duplicateRootKeys = new Set();
    const rootKeys = new Set();
    let depth = 0;
    let rootKey = '';
    let rootKeyParsed = false;
    let expectingRootKey = true;
    let nestedRootValue = false;

    for (let index = 0; index < text.length;) {
      const character = text[index];
      if (character === '"') {
        const start = index;
        index += 1;
        while (index < text.length) {
          if (text[index] === '\\') {
            index += 2;
            continue;
          }
          if (text[index] === '"') {
            index += 1;
            break;
          }
          index += 1;
        }
        const token = text.slice(start, index);
        output += token;
        if (depth === 1) {
          if (expectingRootKey) {
            rootKey = JSON.parse(token);
            rootKeyParsed = true;
            if (rootKeys.has(rootKey)) duplicateRootKeys.add(rootKey);
            rootKeys.add(rootKey);
          } else {
            rootKey = '';
            rootKeyParsed = false;
            expectingRootKey = true;
          }
        }
        continue;
      }

      if (character === '{' || character === '[') {
        if (depth === 1 && !expectingRootKey) nestedRootValue = true;
        depth += 1;
        output += character;
        index += 1;
        continue;
      }

      if (character === '}' || character === ']') {
        depth -= 1;
        output += character;
        index += 1;
        if (depth === 1 && nestedRootValue) {
          rootKey = '';
          rootKeyParsed = false;
          expectingRootKey = true;
          nestedRootValue = false;
        }
        continue;
      }

      if (depth === 1 && character === ':' && rootKeyParsed) {
        expectingRootKey = false;
        rootKeyParsed = false;
        output += character;
        index += 1;
        continue;
      }

      if (depth === 1 && character === ',') {
        rootKey = '';
        rootKeyParsed = false;
        expectingRootKey = true;
        output += character;
        index += 1;
        continue;
      }

      if (depth === 1 && !expectingRootKey && !/\s/.test(character)) {
        const start = index;
        while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
        const token = text.slice(start, index);
        if (rootKey === 'world_revision' && /^(0|[1-9]\d*)$/.test(token)) {
          numericRevisionFields.add(rootKey);
          output += `"${token}"`;
        } else {
          output += token;
        }
        rootKey = '';
        rootKeyParsed = false;
        expectingRootKey = true;
        continue;
      }

      output += character;
      index += 1;
    }
    return {text: output, numericRevisionFields, duplicateRootKeys};
  }

  function parseWorldJSON(text) {
    const source = quoteWorldRevisionNumbers(text);
    const parsed = JSON.parse(source.text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      revisionFieldsByObject.set(parsed, source);
    }
    return parsed;
  }

  function normalizeUint64(value) {
    let revision;
    if (typeof value === 'bigint') {
      revision = value;
    } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      revision = BigInt(value);
    } else if (typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value)) {
      try {
        revision = BigInt(value);
      } catch {
        return null;
      }
    } else {
      return null;
    }
    if (revision < 0n || revision > maxUint64) return null;
    return revision.toString();
  }

  function validCapturedAt(value) {
    return typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value));
  }

  function normalizeActor(actor) {
    if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return null;
    if (actor.actor_id !== 'mio' || actor.presence !== 'present' || actor.floor_id !== '1f' ||
        actor.room_id !== 'r04-room-1f' || actor.activity_id !== 'idle' || actor.position !== null) return null;
    return Object.freeze({
      actor_id: actor.actor_id,
      presence: actor.presence,
      floor_id: actor.floor_id,
      room_id: actor.room_id,
      position: null,
      activity_id: actor.activity_id,
    });
  }

  function normalizeSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const revisionMetadata = revisionFieldsByObject.get(value);
    if (!revisionMetadata || !revisionMetadata.numericRevisionFields.has('world_revision') ||
        revisionMetadata.duplicateRootKeys.has('world_revision')) return null;
    const revision = normalizeUint64(value.world_revision);
    if (value.schema_version !== 'r04.mock.v1' || value.source !== 'mock' || value.world_id !== 'r04-house' ||
        revision === null || revision === '0' || !validCapturedAt(value.captured_at) || value.spatial_revision !== 'unverified' ||
        value.spatial_ready !== false || !Array.isArray(value.actors) || value.actors.length > 1) return null;
    const actors = value.actors.map(normalizeActor);
    if (actors.some((actor) => !actor)) return null;
    return Object.freeze({
      schema_version: value.schema_version,
      source: value.source,
      world_id: value.world_id,
      world_revision: revision,
      captured_at: value.captured_at,
      spatial_revision: value.spatial_revision,
      spatial_ready: false,
      actors: Object.freeze(actors),
    });
  }

  function normalizeCursor(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const revisionMetadata = revisionFieldsByObject.get(value);
    if (!revisionMetadata || !revisionMetadata.numericRevisionFields.has('world_revision') ||
        revisionMetadata.duplicateRootKeys.has('world_revision')) return null;
    const revision = normalizeUint64(value.world_revision);
    if (value.schema_version !== 'r04.mock.v1' || value.source !== 'mock' || value.world_id !== 'r04-house' || revision === null || revision === '0') return null;
    return Object.freeze({
      schema_version: value.schema_version,
      source: value.source,
      world_id: value.world_id,
      world_revision: revision,
    });
  }

  function revisionCompare(left, right) {
    const leftRevision = BigInt(left);
    const rightRevision = BigInt(right);
    return leftRevision < rightRevision ? -1 : leftRevision > rightRevision ? 1 : 0;
  }

  class WorldStore {
    constructor(options = {}) {
      this.snapshotURL = options.snapshotURL || snapshotURL;
      this.streamURL = options.streamURL || streamURL;
      this.fetcher = options.fetcher || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
      this.EventSourceCtor = options.EventSourceCtor || (typeof EventSource === 'function' ? EventSource : null);
      this.AbortControllerCtor = options.AbortControllerCtor || (typeof AbortController === 'function' ? AbortController : null);
      this.setTimer = options.setTimer || setTimeout;
      this.clearTimer = options.clearTimer || clearTimeout;
      this.reconnectDelayMs = options.reconnectDelayMs === undefined ? 1000 : options.reconnectDelayMs;
      this.maxReconnectDelayMs = options.maxReconnectDelayMs === undefined ? 16000 : options.maxReconnectDelayMs;
      this.maxReconnectAttempts = options.maxReconnectAttempts === undefined ? 5 : options.maxReconnectAttempts;
      this.catchUpDelayMs = options.catchUpDelayMs === undefined ? 1000 : options.catchUpDelayMs;
      this.snapshotTimeoutMs = Number.isFinite(options.snapshotTimeoutMs) && options.snapshotTimeoutMs >= 0 ? options.snapshotTimeoutMs : 10000;
      this.streamTimeoutMs = Number.isFinite(options.streamTimeoutMs) && options.streamTimeoutMs >= 0 ? options.streamTimeoutMs : 10000;
      this.listeners = new Set();
      this.snapshot = null;
      this.status = Object.freeze({stale: true, label: '接続待ち'});
      this.source = null;
      this.generation = 0;
      this.timer = null;
      this.deadlineTimer = null;
      this.deadlineGeneration = null;
      this.fetchAbortController = null;
      this.fetchGeneration = null;
      this.started = false;
      this.stopped = false;
      this.suspended = false;
      this.baselineReady = false;
      this.reconnectAttempts = 0;
    }

    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('WorldStore listener must be a function');
      this.listeners.add(listener);
      listener(this.snapshot, this.status);
      return () => this.listeners.delete(listener);
    }

    start() {
      if (this.started || this.stopped) return this;
      this.started = true;
      this.connect();
      return this;
    }

    stop() {
      if (this.stopped) return;
      this.stopped = true;
      this.suspended = false;
      this.generation += 1;
      this.clearActiveResources();
    }

    pause() {
      if (this.stopped || !this.started || this.suspended) return;
      this.suspended = true;
      this.generation += 1;
      this.clearActiveResources();
      this.baselineReady = false;
      this.setStatus(true, 'ページ一時停止中');
    }

    resume() {
      if (this.stopped || !this.started || !this.suspended) return;
      this.suspended = false;
      this.connect();
    }

    clearActiveResources() {
      if (this.source) this.source.close();
      this.source = null;
      if (this.timer !== null) this.clearTimer(this.timer);
      this.timer = null;
      this.clearDeadline();
      this.abortSnapshotFetch();
    }

    connect(options = {}) {
      if (!this.started || this.stopped || this.suspended) return;
      const generation = ++this.generation;
      this.baselineReady = false;
      if (!options.preserveFresh || this.status.stale) this.setStatus(true, 'Snapshotを取得中');

      if (!this.fetcher || !this.EventSourceCtor) {
        this.scheduleReconnect(generation, '接続を作れません');
        return;
      }

      const controller = this.AbortControllerCtor ? new this.AbortControllerCtor() : null;
      this.fetchAbortController = controller;
      this.fetchGeneration = controller ? generation : null;
      const requestOptions = {method: 'GET', cache: 'no-store'};
      if (controller) requestOptions.signal = controller.signal;
      this.setDeadline(generation, this.snapshotTimeoutMs, () => {
        this.abortSnapshotFetch(generation);
        this.scheduleReconnect(generation, 'Snapshot取得timeout・再取得中');
      });

      Promise.resolve()
        .then(() => generation === this.generation && !this.stopped ? this.fetcher(this.snapshotURL, requestOptions) : null)
        .then((response) => {
          if (generation !== this.generation || this.stopped) return null;
          if (!response || !response.ok) throw new Error('snapshot unavailable');
          return response.text();
        })
        .then((body) => {
          if (generation !== this.generation || this.stopped) return;
          this.clearDeadline(generation);
          this.releaseSnapshotFetch(generation);
          const snapshot = normalizeSnapshot(parseWorldJSON(body));
          if (!snapshot) throw new Error('invalid snapshot');
          this.acceptSnapshot(snapshot, generation);
        })
        .catch(() => {
          this.clearDeadline(generation);
          this.abortSnapshotFetch(generation);
          this.scheduleReconnect(generation, 'Snapshotを取得できません');
        });
    }

    openStream(generation) {
      if (generation !== this.generation || this.stopped || this.suspended || !this.snapshot) return;
      let source;
      try {
        source = new this.EventSourceCtor(streamURLAfterRevision(this.streamURL, this.snapshot.world_revision));
      } catch {
        this.scheduleReconnect(generation, 'Streamに接続できません');
        return;
      }
      this.source = source;
      source.addEventListener('snapshot', (event) => this.receiveEvent('snapshot', event, generation));
      source.addEventListener('cursor', (event) => this.receiveEvent('cursor', event, generation));
      source.addEventListener('caught_up', (event) => this.receiveEvent('caught_up', event, generation));
      source.onerror = () => this.scheduleReconnect(generation, 'Stream切断・再接続待ち');
      this.setDeadline(generation, this.streamTimeoutMs, () => this.scheduleReconnect(generation, 'caught_up待機timeout・再取得中'));
    }

    receiveEvent(eventType, event, generation) {
      if (generation !== this.generation || this.stopped || this.suspended) return;
      let update;
      try {
        const value = parseWorldJSON(event.data);
        update = eventType === 'snapshot' ? normalizeSnapshot(value) :
          eventType === 'cursor' || eventType === 'caught_up' ? normalizeCursor(value) : null;
      } catch {
        this.scheduleReconnect(generation, '不正なWorld eventを受信しました');
        return;
      }
      if (!update) {
        this.scheduleReconnect(generation, '不正なWorld eventを受信しました');
        return;
      }
      if (!this.baselineReady) return;
      if (eventType === 'caught_up') {
        if (!this.snapshot || update.world_revision !== this.snapshot.world_revision) {
          this.scheduleReconnect(generation, 'caught_up revision不一致・Snapshot再取得中');
          return;
        }
        this.clearDeadline(generation);
        this.finishCatchUp(generation);
        return;
      }
      this.applyUpdate(Object.freeze({eventType, update}), generation);
    }

    acceptSnapshot(snapshot, generation) {
      if (generation !== this.generation || this.stopped || this.suspended) return;
      if (!this.snapshot || revisionCompare(snapshot.world_revision, this.snapshot.world_revision) >= 0) {
        this.snapshot = snapshot;
      }
      this.baselineReady = true;
      this.setStatus(false, 'mock stream更新中');
      this.openStream(generation);
      this.notify();
    }

    finishCatchUp(generation) {
      if (generation !== this.generation || this.stopped || this.suspended) return;
      this.clearDeadline(generation);
      if (this.source) this.source.close();
      this.source = null;
      this.generation += 1;
      this.baselineReady = false;
      this.reconnectAttempts = 0;
      this.setStatus(false, 'mock stream更新確認待ち');
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.connect({preserveFresh: true});
      }, this.catchUpDelayMs);
    }

    applyUpdate(received, generation) {
      if (generation !== this.generation || !this.snapshot || this.stopped || this.suspended) return;
      const {eventType, update} = received;
      const nextRevision = (BigInt(this.snapshot.world_revision) + 1n).toString();
      if (update.world_revision !== nextRevision) {
        this.scheduleReconnect(generation, 'revision不連続・Snapshot再取得中');
        return;
      }
      this.snapshot = eventType === 'snapshot'
        ? update
        : Object.freeze({...this.snapshot, world_revision: update.world_revision});
      this.notify();
    }

    scheduleReconnect(generation, label) {
      if (!this.started || this.stopped || this.suspended || generation !== this.generation || this.timer !== null) return;
      this.clearDeadline(generation);
      this.abortSnapshotFetch(generation);
      this.generation += 1;
      if (this.source) this.source.close();
      this.source = null;
      this.baselineReady = false;
      this.setStatus(true, label);
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.setStatus(true, `${label} · 再接続上限に達しました`);
        return;
      }
      const delay = Math.min(this.reconnectDelayMs * (2 ** this.reconnectAttempts), this.maxReconnectDelayMs);
      this.reconnectAttempts += 1;
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.connect();
      }, delay);
    }

    setDeadline(generation, delay, callback) {
      this.clearDeadline();
      this.deadlineGeneration = generation;
      this.deadlineTimer = this.setTimer(() => {
        if (generation !== this.generation || this.stopped || this.suspended || this.deadlineGeneration !== generation) return;
        this.deadlineTimer = null;
        this.deadlineGeneration = null;
        callback();
      }, delay);
    }

    clearDeadline(generation) {
      if (generation !== undefined && this.deadlineGeneration !== generation) return;
      if (this.deadlineTimer !== null) this.clearTimer(this.deadlineTimer);
      this.deadlineTimer = null;
      this.deadlineGeneration = null;
    }

    releaseSnapshotFetch(generation) {
      if (this.fetchGeneration !== generation) return;
      this.fetchAbortController = null;
      this.fetchGeneration = null;
    }

    abortSnapshotFetch(generation) {
      if (!this.fetchAbortController || (generation !== undefined && this.fetchGeneration !== generation)) return;
      this.fetchAbortController.abort();
      this.fetchAbortController = null;
      this.fetchGeneration = null;
    }

    setStatus(stale, label) {
      this.status = Object.freeze({stale, label});
      this.notify();
    }

    notify() {
      for (const listener of this.listeners) listener(this.snapshot, this.status);
    }
  }

  function setActiveView(buttons, panels, view) {
    if (view !== 'lcp' && view !== 'workplace') return false;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.worldView === view));
    for (const panel of panels) panel.hidden = panel.dataset.worldPanel !== view;
    return true;
  }

  function createActorCard(document, actor) {
    const card = document.createElement('article');
    card.className = 'world-poc__actor';
    const heading = document.createElement('h3');
    heading.textContent = actor.actor_id;
    card.append(heading);
    const details = document.createElement('dl');
    for (const [label, value] of [
      ['Presence', actor.presence],
      ['Floor', actor.floor_id],
      ['Room', actor.room_id],
      ['Position', '未測量'],
      ['Activity', actor.activity_id],
    ]) {
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value;
      details.append(term, description);
    }
    card.append(details);
    return card;
  }

  function mountWorldPOC(document, window) {
    const root = document.querySelector('.world-poc');
    const statusNode = document.getElementById('worldStatus');
    const buttons = Array.from(document.querySelectorAll('[data-world-view]'));
    const panels = Array.from(document.querySelectorAll('[data-world-panel]'));
    const store = new WorldStore();

    for (const button of buttons) {
      button.addEventListener('click', () => setActiveView(buttons, panels, button.dataset.worldView));
    }
    store.subscribe((snapshot, status) => {
      root.dataset.stale = String(status.stale);
      statusNode.textContent = status.stale ? `STALE · ${status.label}` : status.label;
      for (const panel of panels) {
        const revisionNode = panel.querySelector('[data-world-revision]');
        const actorContainer = panel.querySelector('[data-world-actors]');
        revisionNode.textContent = snapshot ? snapshot.world_revision : '—';
        if (!snapshot) {
          const waiting = document.createElement('p');
          waiting.textContent = 'Snapshotを待っています。';
          actorContainer.replaceChildren(waiting);
          continue;
        }
        if (snapshot.actors.length === 0) {
          const empty = document.createElement('p');
          empty.textContent = 'このScopeに表示できるAgentはいません。';
          actorContainer.replaceChildren(empty);
          continue;
        }
        actorContainer.replaceChildren(...snapshot.actors.map((actor) => createActorCard(document, actor)));
      }
    });
    window.addEventListener('pagehide', (event) => {
      if (event.persisted) store.pause();
      else store.stop();
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) store.resume();
    });
    store.start();
    return store;
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined') mountWorldPOC(document, window);

  return {
    WorldStore,
    normalizeSnapshot,
    normalizeCursor,
    parseWorldJSON,
    setActiveView,
    mountWorldPOC,
    snapshotURL,
    streamURL,
  };
});
