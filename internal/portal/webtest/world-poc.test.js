'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {WorldStore, mountWorldPOC, normalizeCursor, normalizeSnapshot, parseWorldJSON, setActiveView, snapshotURL, streamURL} = require('../web/world-poc.js');

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

function lcpAndWorkplaceViews() {
  const buttons = [
    {dataset: {worldView: 'lcp'}, setAttribute(name, value) { this[name] = value; }},
    {dataset: {worldView: 'workplace'}, setAttribute(name, value) { this[name] = value; }},
  ];
  const panels = [
    {dataset: {worldPanel: 'lcp'}, hidden: false},
    {dataset: {worldPanel: 'workplace'}, hidden: true},
  ];
  return {buttons, panels};
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

test('one WorldStore subscription feeds both views and view switching has no network effect', async () => {
  const {store, requests} = harness([snapshot(10)]);
  const revisions = [];
  store.subscribe((world) => {
    if (world) revisions.push({lcp: world.world_revision, workplace: world.world_revision, sameSnapshot: world === store.snapshot});
  });
  store.start();
  store.start();
  await flushPromises();

  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, snapshotURL);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(store.snapshot.world_revision, '10');
  assert.equal(FakeEventSource.instances[0].url, `${streamURL}?after_revision=10`);

  FakeEventSource.instances[0].emit('snapshot', snapshot(11, [actor], '2026-10-15T12:01:00Z'));
  assert.equal(store.snapshot.world_revision, '11');
  assert.equal(store.snapshot.captured_at, '2026-10-15T12:01:00Z');
  assert.ok(revisions.some((entry) => entry.lcp === entry.workplace && entry.lcp === '11' && entry.sameSnapshot));
  FakeEventSource.instances[0].emit('cursor', cursor(12));
  assert.equal(store.snapshot.world_revision, '12');
  assert.equal(store.snapshot.captured_at, '2026-10-15T12:01:00Z', 'cursor-only event must preserve snapshot contents');
  assert.deepEqual(store.snapshot.actors, [actor]);

  const {buttons, panels} = lcpAndWorkplaceViews();
  const requestCount = requests.length;
  const streamCount = FakeEventSource.instances.length;
  assert.equal(setActiveView(buttons, panels, 'workplace'), true);
  assert.equal(buttons[0]['aria-pressed'], 'false');
  assert.equal(buttons[1]['aria-pressed'], 'true');
  assert.equal(panels[0].hidden, true);
  assert.equal(panels[1].hidden, false);
  assert.equal(requests.length, requestCount);
  assert.equal(FakeEventSource.instances.length, streamCount);
  store.stop();
});

test('WorldStore uses the configured stream URL and preserves existing query parameters', async () => {
  const customStreamURL = '/custom/world-stream?tenant=mock';
  const {store} = harness([snapshot(10)], {streamURL: customStreamURL});
  store.start();
  await flushPromises();
  assert.equal(FakeEventSource.instances[0].url, `${customStreamURL}&after_revision=10`);
  store.stop();
});

test('a visible snapshot followed by an empty scope removes actor cards from both views', async () => {
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  const responses = [snapshot(1), snapshot(2, [])];
  globalThis.fetch = async () => response(responses.shift());
  globalThis.EventSource = FakeEventSource;
  FakeEventSource.instances = [];

  const root = fakeElement();
  const status = fakeElement();
  const buttons = [fakeElement({worldView: 'lcp'}), fakeElement({worldView: 'workplace'})];
  const panels = ['lcp', 'workplace'].map((view) => {
    const revision = fakeElement();
    const actors = fakeElement();
    const panel = fakeElement({worldPanel: view});
    panel.queries = {'[data-world-revision]': revision, '[data-world-actors]': actors};
    panel.revision = revision;
    panel.actors = actors;
    return panel;
  });
  const document = {
    querySelector: () => root,
    getElementById: () => status,
    querySelectorAll: (selector) => selector === '[data-world-view]' ? buttons : panels,
    createElement: () => fakeElement(),
  };
  const window = {addEventListener() {}};
  let store;
  try {
    store = mountWorldPOC(document, window);
    await flushPromises();
    for (const panel of panels) {
      assert.equal(panel.revision.textContent, '1');
      assert.equal(panel.actors.children[0].className, 'world-poc__actor');
    }

    FakeEventSource.instances[0].emit('snapshot', snapshot(2, []));
    for (const panel of panels) {
      assert.equal(panel.revision.textContent, '2');
      assert.equal(panel.actors.children.length, 1);
      assert.equal(panel.actors.children[0].textContent, 'このScopeに表示できるAgentはいません。');
      assert.notEqual(panel.actors.children[0].className, 'world-poc__actor');
    }
  } finally {
    store?.stop();
    globalThis.fetch = previousFetch;
    if (previousEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previousEventSource;
  }
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

  const buttons = [fakeElement({worldView: 'lcp'}), fakeElement({worldView: 'workplace'})];
  const panels = ['lcp', 'workplace'].map((view) => {
    const panel = fakeElement({worldPanel: view});
    panel.queries = {'[data-world-revision]': fakeElement(), '[data-world-actors]': fakeElement()};
    return panel;
  });
  const document = {
    querySelector: () => fakeElement(),
    getElementById: () => fakeElement(),
    querySelectorAll: (selector) => selector === '[data-world-view]' ? buttons : panels,
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
  let store;
  try {
    store = mountWorldPOC(document, window);
    await flushPromises();
    assert.equal(store.status.stale, false);
    const subscriptions = store.listeners.size;
    const pagehide = windowHandlers.get('pagehide')[0];
    pagehide({persisted: true});
    assert.equal(store.status.stale, true);
    assert.equal(FakeEventSource.instances[0].closed, true);

    const pageshow = windowHandlers.get('pageshow')[0];
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
