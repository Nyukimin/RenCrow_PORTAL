'use strict';
// CORE's custom reset event must discard the current EventSource cursor and rebuild the page.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = process.env.PORTAL_JS_SOURCE || path.join(__dirname, '..', 'web', 'portal.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const functionStart = source.indexOf('  function connectEvents() {');
assert.notEqual(functionStart, -1, 'portal.js must define connectEvents');
const nextFunctionOffset = source.slice(functionStart + 1).search(/\n  (?:async )?function [A-Za-z0-9_$]+\(/);
assert.notEqual(nextFunctionOffset, -1, 'connectEvents must remain a top-level function');
const connectEventsSource = source.slice(functionStart, functionStart + 1 + nextFunctionOffset);

const eventSources = [];

class FakeEventSource {
  static CLOSED = 2;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.closed = false;
    eventSources.push(this);
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
}

function makeHarness() {
  const order = [];
  const sandbox = {
    EventSource: FakeEventSource,
    api: (endpoint) => `/api/Chat${endpoint}`,
    responseFirstEnabled: false,
    conversationEventSource: null,
    uiMetrics: null,
    blockingRequest: () => null,
    requestIdentifiers: () => ({}),
    requestForIdentifiers: () => null,
    setConnection() {},
    handleRequestEvent() {},
    handleControlEvent() {},
    renderEvent() {},
    setSurfaceReady(ready) { order.push(['surface-ready', ready]); },
    window: {
      location: {
        reload() { order.push(['reload']); },
      },
    },
  };
  vm.runInNewContext(`${connectEventsSource}\nconnectEvents()`, sandbox, {filename: sourcePath});
  return {eventSource: eventSources[eventSources.length - 1], order};
}

function testResetClosesTheStreamAndReloadsOnce() {
  const {eventSource, order} = makeHarness();
  eventSource.emit('reset', {data: '{"reason":"cursor_lost_after_rollback"}', lastEventId: 'reset'});

  assert.equal(eventSource.closed, true, 'the stream carrying the stale cursor is closed');
  assert.deepEqual(order, [['surface-ready', false], ['reload']], 'the UI is frozen before a full rebuild');

  eventSource.emit('reset', {data: '{"reason":"cursor_lost_after_rollback"}', lastEventId: 'reset'});
  assert.deepEqual(order, [['surface-ready', false], ['reload']], 'duplicate reset delivery cannot start a reload loop');
}

testResetClosesTheStreamAndReloadsOnce();
console.log('reset event behavior passed');
