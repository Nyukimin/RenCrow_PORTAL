'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {WorldStore, mountWorldPOC, snapshotURL, streamURL} = require('../web/world-poc.js');

const integrationBase = process.env.RENCROW_WORLD_POC_INTEGRATION_BASE;

function fakeElement(dataset = {}) {
  return {
    dataset,
    children: [],
    handlers: {},
    attributes: {},
    hidden: false,
    textContent: '',
    className: '',
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelector(selector) { return this.queries?.[selector] || null; },
  };
}

function fakeDocument() {
  const root = fakeElement();
  const status = fakeElement();
  const buttons = ['lcp', 'workplace'].map((view) => fakeElement({worldView: view}));
  const panels = ['lcp', 'workplace'].map((view) => {
    const panel = fakeElement({worldPanel: view});
    panel.revision = fakeElement();
    panel.actors = fakeElement();
    panel.queries = {
      '[data-world-revision]': panel.revision,
      '[data-world-actors]': panel.actors,
    };
    return panel;
  });

  return {
    root,
    status,
    buttons,
    panels,
    document: {
      querySelector(selector) {
        assert.equal(selector, '.world-poc');
        return root;
      },
      getElementById(id) {
        assert.equal(id, 'worldStatus');
        return status;
      },
      querySelectorAll(selector) {
        if (selector === '[data-world-view]') return buttons;
        if (selector === '[data-world-panel]') return panels;
        assert.fail(`unexpected selector: ${selector}`);
      },
      createElement() { return fakeElement(); },
    },
  };
}

function fakeWindow() {
  return {addEventListener() {}};
}

function waitFor(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function check() {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${description}`));
        return;
      }
      setTimeout(check, 10);
    }
    check();
  });
}

function dispatchSSE(source, body) {
  let eventName = 'message';
  let data = [];
  const dispatch = () => {
    if (data.length > 0) source.emit(eventName, data.join('\n'));
    eventName = 'message';
    data = [];
  };

  for (const line of body.split(/\r?\n/)) {
    if (line === '') {
      dispatch();
      continue;
    }
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') eventName = value;
    else if (field === 'data') data.push(value);
  }
  dispatch();
}

function makeHTTPEventSource(fetcher, baseURL, instances) {
  return class HTTPEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.listeners = new Map();
      this.events = [];
      instances.push(this);
      this.done = this.consume(fetcher, baseURL);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    emit(type, data) {
      this.events.push({type, data});
      const listener = this.listeners.get(type);
      if (listener) listener({data});
    }

    close() {
      this.closed = true;
    }

    async consume(fetcher, baseURL) {
      try {
        const response = await fetcher(new URL(this.url, baseURL).toString(), {
          headers: {accept: 'text/event-stream'},
        });
        if (!response.ok) throw new Error(`stream returned HTTP ${response.status}`);
        dispatchSSE(this, await response.text());
      } catch (error) {
        if (!this.closed && typeof this.onerror === 'function') this.onerror(error);
      }
    }
  };
}

test('live World PoC HTTP response reaches the store and both views without view-triggered requests', {
  skip: !integrationBase,
}, async () => {
  const baseURL = new URL(integrationBase);
  assert.ok(baseURL.protocol === 'http:' || baseURL.protocol === 'https:', 'integration base must use HTTP');

  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalSubscribe = WorldStore.prototype.subscribe;
  const requests = [];
  const snapshotBodies = [];
  const eventSources = [];
  let subscriptionCount = 0;
  let store;

  const fetcher = async (input, options = {}) => {
    const target = new URL(typeof input === 'string' ? input : input.url, baseURL);
    const method = (options.method || input?.method || 'GET').toUpperCase();
    const request = {url: target.toString(), method};
    requests.push(request);
    const response = await originalFetch(target, options);
    request.status = response.status;
    if (target.pathname === snapshotURL && response.ok) {
      snapshotBodies.push(await response.clone().text());
    }
    return response;
  };

  globalThis.fetch = fetcher;
  globalThis.EventSource = makeHTTPEventSource(fetcher, baseURL, eventSources);
  WorldStore.prototype.subscribe = function (listener) {
    subscriptionCount += 1;
    return originalSubscribe.call(this, listener);
  };

  try {
    const {document, root, status, buttons, panels} = fakeDocument();
    store = mountWorldPOC(document, fakeWindow());

    await waitFor(
      () => eventSources.some((source) => source.events.some((event) => event.type === 'caught_up')),
      'the live caught_up event',
    );
    await Promise.all(eventSources.map((source) => source.done));

    assert.equal(snapshotBodies.length, 1, 'one actual snapshot response body should feed the store');
    const responseSnapshot = JSON.parse(snapshotBodies[0]);
    const revision = String(responseSnapshot.world_revision);
    assert.equal(store.snapshot.world_revision, revision);
    assert.equal(store.snapshot.actors[0]?.actor_id, 'mio');
    assert.equal(store.status.stale, false);
    assert.equal(root.dataset.stale, 'false');
    assert.doesNotMatch(status.textContent, /^STALE\b/);
    assert.match(status.textContent, /mock stream更新確認待ち/);

    for (const panel of panels) {
      assert.equal(panel.revision.textContent, revision);
      assert.equal(panel.actors.children.length, 1);
      assert.equal(panel.actors.children[0].className, 'world-poc__actor');
      assert.equal(panel.actors.children[0].children[0].textContent, 'mio');
    }

    assert.equal(subscriptionCount, 1, 'mount should create one WorldStore subscription');
    assert.equal(requests.length, 2, 'startup should make one snapshot and one stream request');
    assert.equal(new URL(requests[0].url).pathname, snapshotURL);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].status, 200);
    assert.equal(new URL(requests[1].url).pathname, streamURL);
    assert.equal(new URL(requests[1].url).searchParams.get('after_revision'), revision);
    assert.equal(requests[1].method, 'GET');
    assert.equal(requests[1].status, 200);

    const requestCount = requests.length;
    const sourceCount = eventSources.length;
    const subscriptionCountBeforeSwitches = subscriptionCount;
    for (let index = 0; index < 20; index += 1) {
      const button = buttons[index % buttons.length];
      button.handlers.click();
    }
    assert.equal(requests.length, requestCount, 'view switching must not issue network requests');
    assert.equal(eventSources.length, sourceCount, 'view switching must not open another stream');
    assert.equal(subscriptionCount, subscriptionCountBeforeSwitches, 'view switching must not subscribe again');

    const postResponse = await fetcher(snapshotURL, {method: 'POST'});
    assert.equal(postResponse.status, 405, 'POST to the read-only snapshot route must be rejected');
    const unknownResponse = await fetcher('/api/world-poc/viewer/world/unknown', {method: 'GET'});
    assert.equal(unknownResponse.status, 404, 'an unknown World PoC route must be rejected');
  } finally {
    store?.stop();
    globalThis.fetch = originalFetch;
    if (originalEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = originalEventSource;
    WorldStore.prototype.subscribe = originalSubscribe;
  }
});
