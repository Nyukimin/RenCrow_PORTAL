'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {WorldStore, mountWorldPOC, normalizeCursor, normalizeSnapshot, parseWorldJSON, snapshotURL, streamURL} = require('../web/world-poc.js');

const actor = {
  actor_id: 'mio',
  presence: 'present',
  floor_id: '1f',
  room_id: 'r04-room-1f',
  position: null,
  activity_id: 'idle',
};

function snapshot(revision, actors = [actor], capturedAt = '2026-10-15T12:00:00Z') {
  return {
    schema_version: 'r04.mock.v1',
    source: 'mock',
    world_id: 'r04-house',
    world_revision: revision,
    captured_at: capturedAt,
    spatial_revision: 'unverified',
    spatial_ready: false,
    actors,
  };
}

function cursor(revision) {
  return {
    schema_version: 'r04.mock.v1',
    source: 'mock',
    world_id: 'r04-house',
    world_revision: revision,
  };
}

function response(value) {
  return {
    ok: true,
    text: async () => typeof value === 'string' ? value : JSON.stringify(value),
  };
}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(type, value) {
    const listener = this.listeners.get(type);
    if (listener) listener({data: JSON.stringify(value)});
  }

  fail() {
    if (this.onerror) this.onerror(new Error('disconnected'));
  }

  close() {
    this.closed = true;
  }
}

function fakeTimers() {
  const pending = [];
  return {
    setTimer(callback, delay) {
      pending.push({callback, delay});
      return pending.length;
    },
    clearTimer(id) {
      pending[id - 1] = null;
    },
    runNext(delay) {
      const index = pending.findIndex((task) => task && (delay === undefined || task.delay === delay));
      const task = pending[index];
      assert.equal(typeof task?.callback, 'function', 'expected a scheduled timer');
      pending[index] = null;
      task.callback();
    },
    get count() {
      return pending.filter(Boolean).length;
    },
    get delays() {
      return pending.filter(Boolean).map((task) => task.delay);
    },
  };
}

test('WorldStore preserves the browser receiver for default timers', () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  const cleared = [];
  globalThis.setTimeout = function (callback, delay) {
    assert.equal(this, globalThis);
    scheduled.push({callback, delay});
    return scheduled.length;
  };
  globalThis.clearTimeout = function (timerID) {
    assert.equal(this, globalThis);
    cleared.push(timerID);
  };

  const store = new WorldStore();
  try {
    store.setDeadline(0, 50, () => {});
    store.clearDeadline();
    assert.deepEqual(scheduled.map((task) => task.delay), [50]);
    assert.deepEqual(cleared, [1]);
  } finally {
    try {
      store.stop();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  }
});

function harness(responses, options = {}) {
  FakeEventSource.instances = [];
  const timers = fakeTimers();
  const requests = [];
  const fetcher = (url, options) => {
    requests.push({url, options});
    const next = responses.shift();
    if (typeof next === 'function') return next();
    return Promise.resolve(response(next));
  };
  const store = new WorldStore({
    fetcher,
    EventSourceCtor: FakeEventSource,
    streamURL: options.streamURL,
    setTimer: (callback, delay) => timers.setTimer(callback, delay),
    clearTimer: (timerID) => timers.clearTimer(timerID),
    reconnectDelayMs: options.reconnectDelayMs === undefined ? 0 : options.reconnectDelayMs,
    catchUpDelayMs: options.catchUpDelayMs,
    snapshotTimeoutMs: options.snapshotTimeoutMs,
    streamTimeoutMs: options.streamTimeoutMs,
  });
  return {store, timers, requests};
}

async function flushPromises() {
  for (let count = 0; count < 10; count += 1) await Promise.resolve();
}

function fakeElement(dataset = {}) {
  return {
    dataset,
    children: [],
    handlers: {},
    attributes: {},
    hidden: false,
    textContent: '',
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelector(selector) { return this.queries?.[selector] || null; },
  };
}

function worldPOCDOM() {
  const root = fakeElement();
  const status = fakeElement();
  const swapButton = fakeElement();
  const positionAnnouncement = fakeElement();
  const panels = ['lcp', 'workplace'].map((view) => {
    const position = fakeElement();
    const revision = fakeElement();
    const viewStatus = fakeElement();
    const actors = fakeElement();
    const panel = fakeElement({worldPanel: view, worldPosition: view === 'lcp' ? 'main' : 'pinp'});
    panel.queries = {
      '[data-world-position-label]': position,
      '[data-world-revision]': revision,
      '[data-world-status]': viewStatus,
      '[data-world-actors]': actors,
    };
    Object.assign(panel, {position, revision, viewStatus, actors});
    return panel;
  });
  const document = {
    querySelector: () => root,
    getElementById: (id) => ({worldStatus: status, swapWorldViews: swapButton, worldPositionAnnouncement: positionAnnouncement})[id] || null,
    querySelectorAll: (selector) => selector === '[data-world-panel]' ? panels : [],
    createElement: () => fakeElement(),
  };
  const windowHandlers = new Map();
  const window = {
    addEventListener(type, handler) {
      const handlers = windowHandlers.get(type) || [];
      handlers.push(handler);
      windowHandlers.set(type, handlers);
    },
  };
  return {root, status, swapButton, positionAnnouncement, panels, document, window, windowHandlers};
}

test('world revision uint64 values stay exact beyond JavaScript safe integers', () => {
  const maximum = '18446744073709551615';
  const parsed = parseWorldJSON(`{"schema_version":"r04.mock.v1","world_revision":${maximum}` + '}');
  assert.equal(parsed.world_revision, maximum);
});

test('uint64 cursor precision is preserved in the after_revision request', async () => {
  const maximum = '18446744073709551615';
  const rawSnapshot = JSON.stringify(snapshot(1)).replace('"world_revision":1', `"world_revision":${maximum}`);
  const {store} = harness([rawSnapshot]);
  store.start();
  await flushPromises();
  assert.equal(store.snapshot.world_revision, maximum);
  assert.equal(FakeEventSource.instances[0].url, `${streamURL}?after_revision=${maximum}`);
  store.stop();
});

test('revision fields must be JSON uint64 numbers', async () => {
  const invalidSnapshot = JSON.stringify(snapshot(10)).replace('"world_revision":10', '"world_revision":"10"');
  const {store, timers} = harness([invalidSnapshot]);
  store.start();
  await flushPromises();
  assert.equal(store.snapshot, null);
  assert.equal(store.status.stale, true);
  assert.equal(timers.count, 1);
  store.stop();
});

test('revision zero is invalid and empty actor snapshots remain safe to consume', async () => {
  assert.equal(normalizeSnapshot(parseWorldJSON(JSON.stringify(snapshot(0)))), null);
  assert.equal(normalizeCursor(parseWorldJSON(JSON.stringify(cursor(0)))), null);
  const duplicatedSnapshot = JSON.stringify(snapshot(1)).replace('"world_revision":1', '"world_revision":1,"world_revision":"2"');
  const duplicatedCursor = JSON.stringify(cursor(1)).replace('"world_revision":1', '"world_revision":1,"world_revision":"2"');
  assert.equal(normalizeSnapshot(parseWorldJSON(duplicatedSnapshot)), null);
  assert.equal(normalizeCursor(parseWorldJSON(duplicatedCursor)), null);
  const empty = snapshot(1, []);
  const {store} = harness([empty]);
  store.start();
  await flushPromises();
  assert.deepEqual(store.snapshot.actors, []);
  store.stop();
});

test('World PoC exposes an accessible native control and keeps both view panels present', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/world-poc.html'), 'utf8');
  assert.match(html, /<button\b[^>]*\bid="swapWorldViews"[^>]*aria-controls="worldPOCStage"[^>]*aria-describedby="worldPositionAnnouncement"[^>]*>MainとPinPを入れ替え<\/button>/);
  assert.match(html, /id="worldPositionAnnouncement"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /data-world-panel="lcp" data-world-position="main" aria-labelledby="lcpPosition lcpTitle"/);
  assert.match(html, /data-world-panel="workplace" data-world-position="pinp" aria-labelledby="workplacePosition workplaceTitle"/);
  const panelTags = html.match(/<section\b[^>]*data-world-panel=[^>]*>/g) || [];
  assert.equal(panelTags.length, 2);
  for (const tag of panelTags) assert.doesNotMatch(tag, /\shidden(?:\s|=|>)/);
});

test('one WorldStore keeps both Main and PinP views synchronized through swap, live update, stale reconnect and empty scope', async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = fakeTimers();
  const requests = [];
  const responses = [snapshot(10), snapshot(12, [])];
  globalThis.fetch = async (url, options) => {
    requests.push({url, options});
    return response(responses.shift());
  };
  globalThis.EventSource = FakeEventSource;
  globalThis.setTimeout = (callback, delay) => timers.setTimer(callback, delay);
  globalThis.clearTimeout = (timerID) => timers.clearTimer(timerID);
  FakeEventSource.instances = [];

  const ui = worldPOCDOM();
  let store;
  try {
    store = mountWorldPOC(ui.document, ui.window);
    await flushPromises();

    assert.equal(store.listeners.size, 1, 'both panels must share one store subscription');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, snapshotURL);
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(FakeEventSource.instances[0].url, `${streamURL}?after_revision=10`);
    for (const panel of ui.panels) {
      assert.equal(panel.dataset.worldPosition, panel.dataset.worldPanel === 'lcp' ? 'main' : 'pinp');
      assert.equal(panel.position.textContent, panel.dataset.worldPanel === 'lcp' ? 'Main' : 'PinP');
      assert.equal(panel.revision.textContent, '10');
      assert.equal(panel.viewStatus.textContent, ui.panels[0].viewStatus.textContent);
      assert.equal(panel.actors.children[0].className, 'world-poc__actor');
    }

    ui.swapButton.handlers.click();
    assert.equal(ui.panels[0].dataset.worldPosition, 'pinp');
    assert.equal(ui.panels[1].dataset.worldPosition, 'main');
    assert.equal(ui.panels[0].position.textContent, 'PinP');
    assert.equal(ui.panels[1].position.textContent, 'Main');
    assert.equal(ui.positionAnnouncement.textContent, 'Main: Workplace。PinP: LCP。');
    assert.equal(requests.length, 1, 'swapping must not fetch a new snapshot');
    assert.equal(FakeEventSource.instances.length, 1, 'swapping must not open another stream');
    assert.equal(store.listeners.size, 1, 'swapping must not add another store subscription');

    FakeEventSource.instances[0].emit('snapshot', snapshot(11, [], '2026-10-15T12:01:00Z'));
    for (const panel of ui.panels) {
      assert.equal(panel.revision.textContent, '11');
      assert.equal(panel.viewStatus.textContent, 'mock stream更新中');
      assert.equal(panel.actors.children.length, 1);
      assert.equal(panel.actors.children[0].textContent, 'このScopeに表示できるAgentはいません。');
    }
    assert.equal(ui.panels[0].viewStatus.textContent, ui.panels[1].viewStatus.textContent);

    const firstStream = FakeEventSource.instances[0];
    firstStream.fail();
    assert.equal(firstStream.closed, true);
    assert.equal(ui.root.dataset.stale, 'true');
    for (const panel of ui.panels) {
      assert.equal(panel.revision.textContent, '11', 'both views retain the same last revision while stale');
      assert.equal(panel.viewStatus.textContent, 'STALE · Stream切断・再接続待ち');
      assert.equal(panel.actors.children[0].textContent, 'このScopeに表示できるAgentはいません。');
    }
    assert.equal(requests.length, 1, 'disconnect waits for the scheduled reconnect');
    assert.equal(FakeEventSource.instances.length, 1);

    timers.runNext(1000);
    await flushPromises();
    assert.equal(requests.length, 2);
    assert.equal(FakeEventSource.instances.length, 2);
    assert.equal(FakeEventSource.instances[1].url, `${streamURL}?after_revision=12`);
    for (const panel of ui.panels) {
      assert.equal(panel.revision.textContent, '12');
      assert.equal(panel.viewStatus.textContent, 'mock stream更新中');
      assert.equal(panel.actors.children.length, 1);
      assert.equal(panel.actors.children[0].textContent, 'このScopeに表示できるAgentはいません。');
    }
    assert.equal(ui.root.dataset.stale, 'false');
    assert.equal(ui.panels[0].viewStatus.textContent, ui.panels[1].viewStatus.textContent);
    assert.equal(ui.panels[0].revision.textContent, ui.panels[1].revision.textContent);
  } finally {
    store?.stop();
    globalThis.fetch = originalFetch;
    if (originalEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = originalEventSource;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('WorldStore uses the configured stream URL and preserves existing query parameters', async () => {
  const customStreamURL = '/custom/world-stream?tenant=mock';
  const {store} = harness([snapshot(10)], {streamURL: customStreamURL});
  store.start();
  await flushPromises();
  assert.equal(FakeEventSource.instances[0].url, `${customStreamURL}&after_revision=10`);
  store.stop();
});

test('BFCache pageshow resumes the same store and remains stale until a new snapshot', async () => {
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  const requests = [];
  const responses = [snapshot(1), snapshot(2)];
  globalThis.fetch = async (url, options) => {
    requests.push({url, options});
    return response(responses.shift());
  };
  globalThis.EventSource = FakeEventSource;
  FakeEventSource.instances = [];

  const ui = worldPOCDOM();
  let store;
  try {
    store = mountWorldPOC(ui.document, ui.window);
    await flushPromises();
    assert.equal(store.status.stale, false);
    const subscriptions = store.listeners.size;
    const pagehide = ui.windowHandlers.get('pagehide')[0];
    pagehide({persisted: true});
    assert.equal(store.status.stale, true);
    assert.equal(FakeEventSource.instances[0].closed, true);

    const pageshow = ui.windowHandlers.get('pageshow')[0];
    assert.equal(typeof pageshow, 'function');
    pageshow({persisted: true});
    assert.equal(store.status.stale, true, 'resume must stay stale while refetching');
    assert.equal(store.listeners.size, subscriptions, 'resume must reuse the mounted subscription');
    await flushPromises();
    assert.equal(requests.length, 2);
    assert.equal(FakeEventSource.instances.length, 2);
    assert.equal(store.snapshot.world_revision, '2');
    assert.equal(store.status.stale, false);

    pagehide({persisted: false});
    assert.equal(store.stopped, true, 'ordinary pagehide still performs permanent cleanup');
    assert.equal(FakeEventSource.instances[1].closed, true);
  } finally {
    store?.stop();
    globalThis.fetch = previousFetch;
    if (previousEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previousEventSource;
  }
});

test('reverse, duplicate and gap revisions close the stream and request a new snapshot', async () => {
  const cases = [
    {name: 'reverse', events: [['snapshot', snapshot(9)]], expectedRevision: '10'},
    {name: 'duplicate', events: [['cursor', cursor(11)], ['cursor', cursor(11)]], expectedRevision: '11'},
    {name: 'gap', events: [['cursor', cursor(13)]], expectedRevision: '10'},
    {name: 'caught_up mismatch', events: [['caught_up', cursor(11)]], expectedRevision: '10'},
  ];

  for (const scenario of cases) {
    const {store, timers, requests} = harness([snapshot(10), snapshot(10)]);
    store.start();
    await flushPromises();
    const firstSource = FakeEventSource.instances[0];
    for (const [type, event] of scenario.events) firstSource.emit(type, event);
    assert.equal(firstSource.closed, true, `${scenario.name} event must close the current stream`);
    assert.equal(timers.count, 1, `${scenario.name} event must schedule one reconnect`);
    timers.runNext();
    await flushPromises();
    assert.equal(requests.length, 2, `${scenario.name} event must fetch a new snapshot`);
    assert.equal(FakeEventSource.instances.length, 2);
    assert.equal(store.snapshot.world_revision, scenario.expectedRevision);
    store.stop();
  }
});

test('disconnect marks the retained snapshot stale and ignores messages from the old generation', async () => {
  const {store, timers} = harness([snapshot(5), snapshot(6)]);
  store.start();
  await flushPromises();
  const oldSource = FakeEventSource.instances[0];
  oldSource.fail();
  assert.equal(store.status.stale, true);
  assert.equal(store.snapshot.world_revision, '5');
  oldSource.emit('cursor', cursor(99));
  assert.equal(store.snapshot.world_revision, '5');

  timers.runNext();
  await flushPromises();
  assert.equal(FakeEventSource.instances.length, 2);
  assert.equal(store.snapshot.world_revision, '6');
  assert.equal(store.status.stale, false);
  store.stop();
});

test('a delayed older snapshot cannot roll back a retained revision', async () => {
  let resolveSnapshot;
  const delayedResponse = new Promise((resolve) => { resolveSnapshot = resolve; });
  const {store, timers} = harness([snapshot(10), () => delayedResponse]);
  store.start();
  await flushPromises();
  FakeEventSource.instances[0].fail();
  assert.equal(store.status.stale, true);
  assert.equal(store.snapshot.world_revision, '10');
  timers.runNext();
  await flushPromises();
  assert.equal(FakeEventSource.instances.length, 1, 'stream waits for the reconnect snapshot');

  resolveSnapshot(response(snapshot(9)));
  await flushPromises();
  const reconnectSource = FakeEventSource.instances[1];
  assert.equal(reconnectSource.url, `${streamURL}?after_revision=10`);
  reconnectSource.emit('cursor', cursor(11));
  assert.equal(store.snapshot.world_revision, '11');
  assert.equal(store.status.stale, false);
  store.stop();
});

test('finite SSE EOF reconnects use capped backoff and stop at the retry limit', async () => {
  const {store, timers, requests} = harness(Array.from({length: 6}, () => snapshot(1)), {reconnectDelayMs: 1000});
  store.start();
  await flushPromises();

  const delays = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    FakeEventSource.instances.at(-1).fail();
    delays.push(timers.delays[0]);
    timers.runNext();
    await flushPromises();
  }
  FakeEventSource.instances.at(-1).fail();
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
  assert.equal(timers.count, 0);
  assert.equal(FakeEventSource.instances.length, 6);
  assert.equal(requests.length, 6);
  assert.equal(store.status.stale, true);
  assert.match(store.status.label, /再接続上限/);
  store.stop();
});

test('caught_up closes a finite stream and polls without marking the retained snapshot stale', async () => {
  const {store, timers, requests} = harness([snapshot(1, []), snapshot(1, [])], {catchUpDelayMs: 250});
  store.start();
  await flushPromises();

  const source = FakeEventSource.instances[0];
  source.emit('cursor', cursor(2));
  assert.equal(store.snapshot.world_revision, '2');
  assert.deepEqual(store.snapshot.actors, []);
  source.emit('caught_up', cursor(2));
  source.fail();
  assert.equal(source.closed, true);
  assert.equal(store.status.stale, false);
  assert.equal(timers.count, 1);
  assert.deepEqual(timers.delays, [250]);
  assert.deepEqual(store.snapshot.actors, []);

  timers.runNext();
  await flushPromises();
  assert.equal(requests.length, 2);
  assert.equal(FakeEventSource.instances.length, 2);
  assert.equal(FakeEventSource.instances[1].url, `${streamURL}?after_revision=2`);
  assert.equal(store.status.stale, false);
  store.stop();
});

test('a snapshot fetch hanging after catch-up poll aborts and marks retained data stale', async () => {
  const pendingSnapshot = new Promise(() => {});
  const {store, timers, requests} = harness(
    [snapshot(1), snapshot(1), () => pendingSnapshot],
    {catchUpDelayMs: 100, snapshotTimeoutMs: 50, streamTimeoutMs: 200},
  );
  store.start();
  await flushPromises();
  FakeEventSource.instances[0].emit('caught_up', cursor(1));
  assert.equal(store.status.stale, false);

  timers.runNext(100);
  await flushPromises();
  FakeEventSource.instances[1].emit('caught_up', cursor(1));
  timers.runNext(100);
  await flushPromises();
  assert.equal(requests.length, 3);
  assert.equal(store.status.stale, false, 'freshness is retained while the poll request is pending');
  const signal = requests[2].options.signal;
  assert.ok(signal, 'snapshot request should support cancellation');
  assert.equal(signal.aborted, false);

  timers.runNext(50);
  assert.equal(store.status.stale, true);
  assert.equal(signal.aborted, true);
  assert.equal(timers.count, 1, 'timeout enters the bounded retry path');
  store.stop();
});

test('a stream without caught_up after a normal poll becomes stale at its deadline', async () => {
  const {store, timers} = harness(
    [snapshot(1), snapshot(1)],
    {catchUpDelayMs: 100, snapshotTimeoutMs: 200, streamTimeoutMs: 50},
  );
  store.start();
  await flushPromises();
  FakeEventSource.instances[0].emit('caught_up', cursor(1));
  assert.equal(store.status.stale, false);

  timers.runNext(100);
  await flushPromises();
  const pendingSource = FakeEventSource.instances[1];
  assert.equal(store.status.stale, false);
  timers.runNext(50);
  assert.equal(pendingSource.closed, true);
  assert.equal(store.status.stale, true);
  assert.equal(timers.count, 1, 'stream timeout enters the bounded retry path');
  store.stop();
});

test('a late snapshot from a timed-out generation cannot replace current state', async () => {
  let resolveLateSnapshot;
  const lateSnapshot = new Promise((resolve) => { resolveLateSnapshot = resolve; });
  const {store, timers} = harness(
    [snapshot(1), () => lateSnapshot, snapshot(2)],
    {snapshotTimeoutMs: 50, streamTimeoutMs: 200},
  );
  store.start();
  await flushPromises();
  FakeEventSource.instances[0].fail();
  timers.runNext(0);
  await flushPromises();
  timers.runNext(50);
  timers.runNext(0);
  await flushPromises();
  assert.equal(store.snapshot.world_revision, '2');
  assert.equal(store.status.stale, false);

  resolveLateSnapshot(response(snapshot(99)));
  await flushPromises();
  assert.equal(store.snapshot.world_revision, '2');
  assert.equal(FakeEventSource.instances.length, 2);
  store.stop();
});

test('stop aborts a pending snapshot and clears its deadline', async () => {
  const pendingSnapshot = new Promise(() => {});
  const {store, timers, requests} = harness([() => pendingSnapshot], {snapshotTimeoutMs: 50});
  store.start();
  await flushPromises();
  const signal = requests[0].options.signal;
  assert.equal(signal.aborted, false);
  assert.equal(timers.count, 1);

  store.stop();
  assert.equal(signal.aborted, true);
  assert.equal(timers.count, 0);
});

test('stop closes the stream and clears its caught_up deadline', async () => {
  const {store, timers} = harness([snapshot(1)], {streamTimeoutMs: 50});
  store.start();
  await flushPromises();
  const source = FakeEventSource.instances[0];
  assert.equal(timers.count, 1);

  store.stop();
  assert.equal(source.closed, true);
  assert.equal(timers.count, 0);
});
