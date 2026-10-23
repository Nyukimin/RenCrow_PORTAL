'use strict';
// Browser RAM metrics behavior test. Run directly with Node.js; no npm packages are required.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'web', 'portal.js');
const source = fs.readFileSync(sourcePath, 'utf8');

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.dataset = {};
    this.style = {removeProperty() {}, setProperty() {}};
    this.classList = {add() {}, remove() {}, toggle() {}};
    this.listeners = new Map();
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    this.clientHeight = 600;
    this.clientWidth = 800;
    this.scrollHeight = 600;
    this.scrollTop = 0;
    this.value = '';
    this.files = [];
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  dispatch(type, event = {}) {
    const handlers = this.listeners.get(type) || [];
    for (const handler of handlers) handler({target: this, currentTarget: this, ...event});
  }

  append(...elements) {
    for (const element of elements) {
      element.parentElement = this;
      this.children.push(element);
    }
  }

  remove() {
    this.isConnected = false;
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  getAttribute(name) {
    return this.attributes && this.attributes[name] || '';
  }

  setAttribute(name, value) {
    this.attributes = this.attributes || {};
    this.attributes[name] = String(value);
  }

  removeAttribute(name) {
    if (this.attributes) delete this.attributes[name];
  }

  focus() {}
  click() {}
}

function makeHarness(search = '?mode=Chat&ui_metrics=1', recipient = 'shiro') {
  const elements = new Map();
  const documentListeners = new Map();
  const documentElement = new FakeElement('html');
  const body = new FakeElement('body');
  body.dataset.mode = 'chat';
  body.dataset.surface = 'chat';
  const document = {
    body,
    documentElement,
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    createElement(tag) {
      return new FakeElement(tag);
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(type, handler) {
      const handlers = documentListeners.get(type) || [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
    },
    dispatch(type) {
      for (const handler of documentListeners.get(type) || []) handler();
    },
  };
  const requests = [];
  const animationFrames = [];
  const eventSources = [];
  const storageWrites = [];
  const consoleCalls = [];
  const localValues = new Map([
    ['rencrow.portal.ttsPreference', 'off'],
    ['roomConversation.selectedPartner', recipient],
  ]);
  const localStorage = {
    getItem(key) { return localValues.has(key) ? localValues.get(key) : null; },
    setItem(key, value) {
      storageWrites.push([key, String(value)]);
      localValues.set(key, String(value));
    },
  };
  const sessionStorage = {
    getItem(key) { return key === 'rencrow.portal.viewerClientID' ? 'portal-test-client' : null; },
    setItem() {},
  };
  let sendResponseResolve = null;
  let clock = 0;
  let timerID = 0;

  function response(payload = {}) {
    return {
      ok: true,
      status: 200,
      headers: {get: () => 'application/json'},
      json: async () => payload,
      text: async () => '',
    };
  }

  const fetch = (url, options = {}) => {
    const metricSnapshot = window.RenCrowPortalMetrics && window.RenCrowPortalMetrics.snapshot();
    requests.push({
      url: String(url),
      options,
      metricsAtFetch: metricSnapshot && Array.from(metricSnapshot.records, (record) => record.event),
    });
    if (String(url).includes('/viewer/send')) {
      return new Promise((resolve) => { sendResponseResolve = resolve; });
    }
    if (String(url).includes('/viewer/surface-presence')) {
      return Promise.resolve(response({effective_mode: 'chat', idlechat_active: false}));
    }
    return Promise.resolve(response());
  };

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      eventSources.push(this);
    }

    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }

    dispatchEvent(event) {
      for (const handler of this.listeners.get(event.type) || []) handler(event);
      return true;
    }
  }

  const window = {
    location: {search, href: `http://localhost/?mode=Chat${search.includes('ui_metrics=1') ? '&ui_metrics=1' : ''}`},
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    setInterval() { return ++timerID; },
    clearInterval() {},
    setTimeout() { return ++timerID; },
    clearTimeout() {},
    addEventListener() {},
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    cancelAnimationFrame() {},
  };
  const sandbox = {
    document,
    window,
    navigator: {platform: 'test', userAgentData: {platform: 'test'}},
    localStorage,
    sessionStorage,
    fetch,
    EventSource: FakeEventSource,
    FormData: class FakeFormData { append() {} },
    URLSearchParams,
    performance: {now: () => ++clock},
    crypto: {randomUUID: () => 'test-id'},
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    console: {
      error(...args) { consoleCalls.push(args); },
      log(...args) { consoleCalls.push(args); },
      warn(...args) { consoleCalls.push(args); },
    },
  };
  vm.runInNewContext(source, sandbox, {filename: sourcePath});

  return {
    document,
    elements,
    requests,
    animationFrames,
    eventSources,
    storageWrites,
    consoleCalls,
    window,
    get sendResponseResolve() { return sendResponseResolve; },
    response,
  };
}

async function flushTasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function testOptInAndPreAckCorrelation() {
  const disabled = makeHarness('?mode=Chat');
  assert.equal(disabled.window.RenCrowPortalMetrics, undefined, 'metrics API is absent unless opted in');

  const harness = makeHarness();
  await flushTasks();
  harness.storageWrites.length = 0;
  const api = harness.window.RenCrowPortalMetrics;
  assert.equal(typeof api.snapshot, 'function');
  const initial = api.snapshot();
  assert.deepEqual(Array.from(initial.records, (record) => record.event), ['ui_visibility']);
  assert.equal(initial.records[0].visibility_state, 'visible');

  const input = harness.elements.get('roomInput');
  input.value = 'hello';
  input.dispatch('keydown', {
    key: 'Enter',
    keyCode: 13,
    isComposing: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() {},
  });
  assert.equal(typeof harness.sendResponseResolve, 'function', 'send request started');
  const events = harness.eventSources[0];
  events.onmessage({data: JSON.stringify({
    type: 'agent.response',
    from: 'shiro',
    to: 'user',
    trace_id: 'trace-before-ack',
    message_id: 'message-before-ack',
    content: 'hello back',
  })});
  while (harness.animationFrames.length) harness.animationFrames.shift()();
  harness.sendResponseResolve(harness.response({
    trace_id: 'trace-before-ack',
    recipient: 'shiro',
    attachment_count: 0,
  }));
  await flushTasks();

  const snapshot = api.snapshot();
  const records = snapshot.records;
  const eventNames = records.map((record) => record.event);
  for (const name of [
    'ui_submit',
    'ui_send_preparation_end',
    'ui_post_start',
    'ui_ack_received',
    'ui_response_received',
    'ui_dom_updated',
    'ui_render_opportunity',
  ]) {
    assert.ok(eventNames.includes(name), `${name} was recorded`);
  }
  assert.ok(eventNames.indexOf('ui_response_received') < eventNames.indexOf('ui_ack_received'), 'SSE-before-ACK order was preserved');
  const correlated = records.filter((record) => [
    'ui_submit',
    'ui_send_preparation_end',
    'ui_post_start',
    'ui_ack_received',
    'ui_response_received',
    'ui_dom_updated',
    'ui_render_opportunity',
  ].includes(record.event));
  for (const record of correlated) {
    assert.equal(record.trace_id, 'trace-before-ack', `${record.event} has the trace ID`);
    assert.equal(record.submission_id, 1, `${record.event} belongs to the submitted request`);
  }
  const requestPoints = records.filter((record) => [
    'ui_submit',
    'ui_send_preparation_end',
    'ui_post_start',
    'ui_ack_received',
  ].includes(record.event));
  for (const record of requestPoints) {
    assert.equal(record.message_id, '', `${record.event} does not borrow a response message ID`);
  }
  for (const record of records.filter((record) => [
    'ui_response_received',
    'ui_dom_updated',
    'ui_render_opportunity',
  ].includes(record.event))) {
    assert.equal(record.message_id, 'message-before-ack', `${record.event} keeps the response event's message ID`);
  }
  assert.equal(snapshot.overflowed, false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.records), true);
  assert.equal(Object.isFrozen(snapshot.records[0]), true);
  assert.equal(api.snapshot().records[0].visibility_state, 'visible', 'snapshot contains a detached copy');
  assert.equal(harness.requests.filter((request) => request.url.includes('/viewer/send')).length, 1, 'metrics did not add send POSTs');
  const sendRequest = harness.requests.find((request) => request.url.includes('/viewer/send'));
  assert.equal(sendRequest.metricsAtFetch.at(-1), 'ui_post_start', 'post_start was recorded immediately before fetch');
  assert.equal(harness.requests.some((request) => request.url.includes('metrics')), false, 'metrics did not POST measurements');
  assert.equal(harness.consoleCalls.length, 0, 'metrics did not write to console');
  assert.equal(harness.storageWrites.length, 0, 'metrics did not write to localStorage during the measured flow');

  harness.document.visibilityState = 'hidden';
  harness.document.dispatch('visibilitychange');
  const withVisibility = api.snapshot();
  assert.equal(withVisibility.records.at(-1).event, 'ui_visibility');
  assert.equal(withVisibility.records.at(-1).visibility_state, 'hidden');

  harness.eventSources[0].onmessage({data: '{'});
  const withError = api.snapshot();
  assert.equal(withError.records.at(-1).event, 'ui_error');
  assert.equal(withError.records.at(-1).stage, 'sse_message');
}

async function testV2ResponseKindsAndErrors() {
  const harness = makeHarness('?mode=Chat&protocol_version=2&ui_metrics=1', 'mio');
  await flushTasks();
  const events = harness.eventSources[0];
  const successfulKinds = ['reply', 'delegation_notice', 'readback', 'report_reply'];
  const errorKinds = ['turn_error', 'handoff_error'];

  for (const kind of [...successfulKinds, ...errorKinds]) {
    const traceID = `trace-${kind}`;
    events.onmessage({data: JSON.stringify({
      type: 'agent.response',
      kind,
      visibility: 'public',
      from: 'mio',
      to: 'user',
      trace_id: traceID,
      message_id: `message-${kind}`,
      content: `${kind} result`,
    })});
  }
  while (harness.animationFrames.length) harness.animationFrames.shift()();

  const records = harness.window.RenCrowPortalMetrics.snapshot().records;
  for (const kind of errorKinds) {
    const traceID = `trace-${kind}`;
    const terminalError = records.find((record) => record.event === 'ui_error'
      && record.stage === 'sse_terminal'
      && record.trace_id === traceID);
    assert.ok(terminalError, `${kind} has an error terminal metric`);
    assert.equal(terminalError.kind, kind, `${kind} stays distinct in error metrics`);
    assert.equal(records.some((record) => record.event === 'ui_response_received' && record.trace_id === traceID), false,
      `${kind} is excluded from successful response metrics`);
    assert.equal(records.some((record) => record.event === 'ui_dom_updated' && record.trace_id === traceID), false,
      `${kind} is excluded from successful DOM metrics`);
    assert.equal(records.some((record) => record.event === 'ui_render_opportunity' && record.trace_id === traceID), false,
      `${kind} is excluded from successful render metrics`);
  }
  const receiptEvents = {
    reply: 'ui_response_received',
    delegation_notice: 'ui_delegation_notice_received',
    readback: 'ui_readback_received',
    report_reply: 'ui_report_reply_received',
  };
  for (const kind of successfulKinds) {
    const traceID = `trace-${kind}`;
    const received = records.find((record) => record.event === receiptEvents[kind] && record.trace_id === traceID);
    assert.ok(received, `${kind} has a response receipt`);
    assert.equal(received.kind, kind, `${kind} stays distinct in response metrics`);
    const domUpdate = records.find((record) => record.event === 'ui_dom_updated' && record.trace_id === traceID);
    assert.ok(domUpdate, `${kind} has a DOM update mark`);
    assert.equal(domUpdate.kind, kind, `${kind} stays distinct in DOM metrics`);
  }
}

function dispatchEnter(harness, text) {
  const input = harness.elements.get('roomInput');
  input.value = text;
  input.dispatch('keydown', {
    key: 'Enter',
    keyCode: 13,
    isComposing: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() {},
  });
}

function emit(harness, event) {
  harness.eventSources[0].onmessage({data: JSON.stringify(event)});
}

async function testPerEventCorrelationSurvivesSameTraceAndLaterReport() {
  const harness = makeHarness('?mode=Chat&protocol_version=2&ui_metrics=1', 'mio');
  await flushTasks();
  dispatchEnter(harness, '調査を委譲してください');
  await flushTasks();
  const pendingSubmissionID = harness.window.RenCrowPortalMetrics.snapshot().records
    .find((record) => record.event === 'ui_submit').submission_id;
  const request = harness.requests.find((entry) => entry.url.includes('/viewer/send'));
  assert.ok(request, 'v2 send begins');
  const clientSubmissionID = JSON.parse(request.options.body).client_submission_id;

  emit(harness, {
    type: 'agent.response', kind: 'delegation_notice', message_id: 'notice-message',
    client_submission_id: clientSubmissionID, turn_id: 'origin-turn', trace_id: 'origin-trace',
    reply_to_message_id: 'origin-input', delegation_id: 'delegation-1', actor: 'mio', to: 'user',
    visibility: 'public', content: '調査を引き受けました。',
  });
  assert.equal(harness.animationFrames.length > 0, true, 'notice schedules its render opportunity');
  emit(harness, {
    type: 'agent.response', kind: 'readback', message_id: 'readback-message',
    client_submission_id: clientSubmissionID, turn_id: 'origin-turn', trace_id: 'origin-trace',
    reply_to_message_id: 'origin-input', delegation_id: 'delegation-1', actor: 'shiro', to: 'user',
    availability: 'free', visibility: 'public', content: '依頼を復唱しました。',
  });
  emit(harness, {
    type: 'agent.response', kind: 'report_reply', message_id: 'report-message',
    client_submission_id: clientSubmissionID, turn_id: 'report-turn', trace_id: 'report-trace',
    origin_turn_id: 'origin-turn', origin_user_message_id: 'origin-input',
    delegation_id: 'delegation-1', actor: 'mio', to: 'user', visibility: 'public', content: '調査結果です。',
  });

  const queuedFrames = harness.animationFrames.splice(0);
  for (const frame of queuedFrames) frame();
  harness.sendResponseResolve(harness.response({
    status: 'accepted', turn_id: 'origin-turn', trace_id: 'origin-trace', input_message_id: 'origin-input',
    session_id: 'session-1', client_submission_id: clientSubmissionID,
  }));
  await flushTasks();

  const records = harness.window.RenCrowPortalMetrics.snapshot().records;
  const receivedByMessageID = (messageID) => records.find((record) => record.event.endsWith('_received')
    && record.message_id === messageID);
  const notice = receivedByMessageID('notice-message');
  const readback = receivedByMessageID('readback-message');
  const report = receivedByMessageID('report-message');
  assert.ok(notice, 'delegation notice is recorded');
  assert.ok(readback, 'readback is recorded');
  assert.ok(report, 'later report is recorded');
  assert.equal(notice.submission_id, pendingSubmissionID, 'notice links to the original submission');
  assert.equal(readback.submission_id, pendingSubmissionID, 'readback links to the original submission');
  assert.equal(report.submission_id, pendingSubmissionID, 'report links through its explicit submission ID');
  assert.equal(notice.trace_id, 'origin-trace');
  assert.equal(readback.trace_id, 'origin-trace');
  assert.equal(report.trace_id, 'report-trace', 'later report keeps its separate trace');
  assert.equal(notice.turn_id, 'origin-turn');
  assert.equal(readback.turn_id, 'origin-turn');
  assert.equal(report.turn_id, 'report-turn', 'later report keeps its own turn');
  assert.equal(notice.delegation_id, 'delegation-1');
  assert.equal(readback.delegation_id, 'delegation-1');
  assert.equal(report.delegation_id, 'delegation-1');
  assert.equal(notice.origin_input_message_id, 'origin-input');
  assert.equal(report.origin_turn_id, 'origin-turn');
  assert.equal(report.origin_input_message_id, 'origin-input');

  const rendered = records.filter((record) => record.event === 'ui_render_opportunity');
  assert.deepEqual(Array.from(rendered, (record) => record.message_id), ['notice-message', 'readback-message', 'report-message'],
    'queued frame callbacks retain each event identity after later events arrive');
}

async function testAckBeforeSSEKeepsEventIdentity() {
  const harness = makeHarness('?mode=Chat&protocol_version=2&ui_metrics=1', 'mio');
  await flushTasks();
  dispatchEnter(harness, 'ACKを先に受け取る');
  await flushTasks();
  const request = harness.requests.find((entry) => entry.url.includes('/viewer/send'));
  const clientSubmissionID = JSON.parse(request.options.body).client_submission_id;
  harness.sendResponseResolve(harness.response({
    status: 'accepted', turn_id: 'ack-turn', trace_id: 'ack-trace', input_message_id: 'ack-input',
    session_id: 'session-1', client_submission_id: clientSubmissionID,
  }));
  await flushTasks();

  emit(harness, {
    type: 'agent.response', kind: 'reply', message_id: 'after-ack-message',
    client_submission_id: clientSubmissionID, turn_id: 'ack-turn', trace_id: 'ack-trace',
    reply_to_message_id: 'ack-input', actor: 'mio', to: 'user', visibility: 'public', content: '応答です。',
  });
  const records = harness.window.RenCrowPortalMetrics.snapshot().records;
  const received = records.find((record) => record.event === 'ui_response_received');
  assert.equal(received.submission_id, 1, 'SSE after ACK links to the known submission');
  assert.equal(received.trace_id, 'ack-trace');
  assert.equal(received.turn_id, 'ack-turn');
  assert.equal(received.message_id, 'after-ack-message');
  assert.equal(received.origin_input_message_id, 'ack-input');
}

function testOverflowIsBoundedAndReported() {
  const harness = makeHarness();
  const events = harness.eventSources[0];
  for (let index = 0; index < 1100; index += 1) {
    events.onmessage({data: JSON.stringify({
      type: 'agent.response',
      from: 'shiro',
      to: 'user',
      trace_id: `trace-${index}`,
      message_id: `message-${index}`,
      content: 'response',
    })});
  }
  const snapshot = harness.window.RenCrowPortalMetrics.snapshot();
  assert.equal(snapshot.count, snapshot.capacity, 'record storage remains fixed-capacity');
  assert.ok(snapshot.dropped_count > 0, 'overflow reports dropped records');
  assert.equal(snapshot.overflowed, true);
  assert.equal(snapshot.records[0].event, 'ui_visibility', 'full storage does not overwrite earlier records');
}

(async () => {
  await testOptInAndPreAckCorrelation();
  await testV2ResponseKindsAndErrors();
  await testPerEventCorrelationSurvivesSameTraceAndLaterReport();
  await testAckBeforeSSEKeepsEventIdentity();
  testOverflowIsBoundedAndReported();
  console.log('[OK] portal UI RAM metrics tests passed');
})().catch((error) => {
  console.error(`[NG] portal UI RAM metrics tests failed\n${error && error.stack || error}`);
  process.exitCode = 1;
});
