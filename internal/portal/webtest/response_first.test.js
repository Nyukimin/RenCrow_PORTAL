'use strict';
// Response-first Chat behavior test. Run directly with Node.js; no npm packages are required.

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
    this.disabled = false;
    this.textContent = '';
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler({target: this, currentTarget: this, ...event});
    }
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

function makeHarness({search = '?mode=Chat&protocol_version=2', recipient = 'mio', ttsPreference = 'off', deferAudioUnlock = false} = {}) {
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
    dispatch(type, event = {}) {
      for (const handler of documentListeners.get(type) || []) handler(event);
    },
  };
  const requests = [];
  const eventSources = [];
  const localValues = new Map([['roomConversation.selectedPartner', recipient]]);
  if (ttsPreference !== null) localValues.set('rencrow.portal.ttsPreference', ttsPreference);
  const localStorage = {
    getItem(key) { return localValues.has(key) ? localValues.get(key) : null; },
    setItem(key, value) { localValues.set(key, String(value)); },
  };
  const sessionStorage = {
    getItem(key) { return key === 'rencrow.portal.viewerClientID' ? 'portal-test-client' : null; },
    setItem() {},
  };
  const pendingSends = [];
  let audioUnlockCalls = 0;
  let resolveAudioUnlock;
  const audioUnlock = new Promise((resolve) => { resolveAudioUnlock = resolve; });
  let timerID = 0;
  let clock = 0;

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
    requests.push({url: String(url), options});
    if (String(url).includes('/viewer/send')) {
      let payload = {};
      try {
        payload = JSON.parse(options.body || '{}');
      } catch (_) {
        // A test assertion below reports malformed payloads more clearly.
      }
      return new Promise((resolve, reject) => pendingSends.push({payload, resolve, reject}));
    }
    if (String(url).includes('/viewer/surface-presence')) {
      const body = JSON.parse(options.body || '{}');
      if (body.action === 'register') {
        return Promise.resolve(response({
          ok: true,
          protocol_version: 2,
          runtime_epoch: 'core-test-epoch',
          registration_receipt: 'portal-test-receipt',
          last_update_seq: 0,
        }));
      }
      return Promise.resolve(response({
        ok: true,
        protocol_version: 2,
        accepted_update_seq: body.update_seq,
        current_claim_seq: body.action === 'claim' ? body.update_seq : body.claim_seq,
        runtime_epoch: body.runtime_epoch,
        registration_receipt: body.registration_receipt,
        state_revision: 1,
        playback_generation: 0,
        playback_state: 'blocked',
        playback_allowed: false,
        foreground_ready: true,
        cleanup_pending: false,
      }));
    }
    return Promise.resolve(response());
  };

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      eventSources.push(this);
    }

    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }

    close() {
      this.readyState = 2;
    }

    dispatchEvent(event) {
      for (const handler of this.listeners.get(event.type) || []) handler(event);
      return true;
    }

    emit(event) {
      if (this.onmessage) this.onmessage({data: JSON.stringify(event)});
    }

    failClosed() {
      this.readyState = 2;
      if (this.onerror) this.onerror();
    }
  }

  const window = {
    location: {search, href: `http://localhost/${search}`},
    AudioContext: class FakeAudioContext {
      resume() {
        audioUnlockCalls += 1;
        return deferAudioUnlock ? audioUnlock : Promise.resolve();
      }
    },
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    setInterval() { return ++timerID; },
    clearInterval() {},
    setTimeout() { return ++timerID; },
    clearTimeout() {},
    addEventListener() {},
    requestAnimationFrame(callback) {
      callback();
      return ++timerID;
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
    crypto: {randomUUID: (() => { let id = 0; return () => `submission-${++id}`; })()},
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    console: {error() {}, log() {}, warn() {}},
  };
  vm.runInNewContext(source, sandbox, {filename: sourcePath});

  return {
    elements,
    eventSources,
    requests,
    pendingSends,
    window,
    response,
    resolveAudioUnlock,
    audioUnlockCalls: () => audioUnlockCalls,
  };
}

async function flushTasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function submit(harness, text) {
  const input = harness.elements.get('roomInput');
  if (input.value !== text) {
    input.value = text;
    input.dispatch('input');
  }
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

function emit(harness, event, sourceIndex = 0) {
  harness.eventSources[sourceIndex].emit(event);
}

function messageRows(harness) {
  return harness.elements.get('chat').children.filter((element) => element.dataset.messageId);
}

function hasDelegationBadge(harness) {
  return messageRows(harness).some((row) => row.children.some((child) => child.className === 'room-delegation-badge'));
}

function findRowByMessageID(harness, messageID) {
  return messageRows(harness).find((row) => row.dataset.messageId === messageID) || null;
}

function findClarificationReplyAction(row) {
  if (!row) return null;
  for (const child of row.children) {
    if (child.dataset.clarificationReplyAction === 'true') return child;
    for (const nested of child.children || []) {
      if (nested.dataset.clarificationReplyAction === 'true') return nested;
    }
  }
  return null;
}

function findClarificationSelectionContext(row) {
  return row && row.children.flatMap((child) => [child, ...(child.children || [])])
    .find((child) => child.dataset.clarificationReplyContext === 'true') || null;
}

function clarificationPrompt(messageID = 'question-message') {
  return {
    type: 'agent.response',
    kind: 'clarification_prompt',
    message_id: messageID,
    turn_id: 'clarification-control-turn',
    trace_id: 'clarification-control-trace',
    reply_to_message_id: 'original-user-input',
    delegation_id: 'clarification-delegation',
    actor: 'mio',
    to: 'user',
    visibility: 'public',
    availability: 'free',
    content: '対象にする環境を選んでください。',
    clarification_question: 'PRIVATE CONTROL QUESTION MUST NOT BE SHOWN',
  };
}

async function testV2DoesNotWaitForTTSButLegacyStillDoes() {
  const v2 = makeHarness({ttsPreference: null, deferAudioUnlock: true});
  await flushTasks();

  assert.match(v2.eventSources[0].url, /\/viewer\/conversation\/events(?:\?|$)/, 'v2 uses the owner and session scoped replay stream');

  v2.elements.get('roomAudioBtn').dispatch('click');
  assert.equal(v2.audioUnlockCalls(), 1, 'TTS enable remains unresolved');
  submit(v2, 'response-first text');
  await flushTasks();
  assert.equal(v2.pendingSends.length, 1, 'v2 POST starts while TTS enable is unresolved');
  const first = v2.pendingSends[0];
  assert.equal(first.payload.protocol_version, 2);
  assert.equal(first.payload.audio_output, 'disabled', 'v2 text does not request audio');
  first.resolve(v2.response({
    status: 'accepted',
    turn_id: 'v2-turn-1',
    trace_id: 'v2-trace-1',
    input_message_id: 'v2-input-1',
    session_id: 'session-1',
    client_submission_id: first.payload.client_submission_id,
  }));
  await flushTasks();

  v2.resolveAudioUnlock();
  await flushTasks();
  emit(v2, {
    type: 'agent.response',
    kind: 'reply',
    message_id: 'v2-reply-1',
    client_submission_id: first.payload.client_submission_id,
    turn_id: 'v2-turn-1',
    trace_id: 'v2-trace-1',
    actor: 'mio',
    to: 'user',
    visibility: 'public',
    content: '回答しました。',
  });
  assert.equal(v2.elements.get('roomInput').disabled, false, 'terminal response releases the first v2 request');
  submit(v2, 'TTS is already enabled');
  await flushTasks();
  assert.equal(v2.pendingSends[1].payload.audio_output, 'disabled', 'v2 remains text-only after TTS is enabled');

  const legacy = makeHarness({search: '?mode=Chat', ttsPreference: null, deferAudioUnlock: true});
  await flushTasks();
  submit(legacy, 'legacy text');
  await flushTasks();
  assert.equal(legacy.audioUnlockCalls(), 1, 'legacy send still starts TTS enable');
  assert.equal(legacy.pendingSends.length, 0, 'legacy POST waits for TTS enable');

  legacy.resolveAudioUnlock();
  await flushTasks();
  assert.equal(legacy.pendingSends.length, 1, 'legacy POST starts after TTS enable completes');
  assert.equal(legacy.pendingSends[0].payload.audio_output, 'requested', 'legacy preserves its TTS request');
}

async function testAgentStartStatusRequiresTheActiveRequestTrace() {
  const harness = makeHarness();
  await flushTasks();
  submit(harness, '一致したagent.startだけで処理中表示を更新します');
  await flushTasks();

  const pending = harness.pendingSends[0];
  pending.resolve(harness.response({
    status: 'accepted',
    turn_id: 'start-turn',
    trace_id: 'start-trace',
    input_message_id: 'start-input',
    session_id: 'session-1',
    client_submission_id: pending.payload.client_submission_id,
  }));
  await flushTasks();

  const operation = harness.elements.get('operationStatus');
  const acceptedStatus = operation.textContent;
  emit(harness, {type: 'agent.start', trace_id: 'other-trace', turn_id: 'other-turn'});
  assert.equal(operation.textContent, acceptedStatus, 'an unrelated agent.start does not change the active request status');

  emit(harness, {type: 'agent.start', trace_id: 'start-trace', turn_id: 'start-turn'});
  assert.equal(operation.textContent, 'Mioが応答を生成中です', 'the matching agent.start updates the active request status');
}

async function testV2PreAckReadbackAndLateReportIsolation() {
  const harness = makeHarness();
  await flushTasks();
  const input = harness.elements.get('roomInput');
  assert.equal(input.disabled, false, 'Chat becomes ready');

  submit(harness, '調査を委譲してください');
  await flushTasks();
  assert.equal(harness.pendingSends.length, 1, 'v2 send starts');
  const first = harness.pendingSends[0];
  assert.equal(first.payload.protocol_version, 2, 'v2 requires explicit opt-in');
  assert.ok(first.payload.client_submission_id, 'request has a retry-stable submission id');
  const firstSubmissionID = first.payload.client_submission_id;
  assert.equal(first.payload.to, 'mio', 'v2 keeps the text-only Mio scope');
  assert.equal(input.disabled, true, 'request waits before readback');

  emit(harness, {
    type: 'conversation.user_message',
    message_id: 'input-1',
    client_submission_id: firstSubmissionID,
    turn_id: 'turn-1',
    trace_id: 'trace-1',
    actor: 'user',
    visibility: 'public',
    content: '調査を委譲してください',
  });
  emit(harness, {
    type: 'agent.response',
    kind: 'delegation_notice',
    message_id: 'notice-1',
    client_submission_id: firstSubmissionID,
    turn_id: 'turn-1',
    trace_id: 'trace-1',
    actor: 'mio',
    to: 'user',
    visibility: 'public',
    content: '調査を引き受けました。結果を確認します。',
  });
  assert.equal(input.disabled, true, 'delegation notice is not completion');

  for (const actor of ['mio', 'shiro', 'kuro', 'midori']) {
    emit(harness, {
      type: 'agent.response',
      kind: 'readback',
      message_id: `readback-${actor}`,
      client_submission_id: firstSubmissionID,
      turn_id: 'turn-1',
      trace_id: 'trace-1',
      delegation_id: 'delegation-1',
      actor,
      to: 'user',
      visibility: 'public',
      availability: 'free',
      content: `${actor}の復唱`,
    });
  }
  assert.equal(input.disabled, false, 'public readback frees Mio before HTTP ACK');
  assert.ok(messageRows(harness).some((row) => row.dataset.actor === 'shiro'), 'Shiro readback is rendered');
  assert.ok(messageRows(harness).some((row) => row.dataset.actor === 'kuro'), 'Kuro readback is rendered');
  assert.ok(messageRows(harness).some((row) => row.dataset.actor === 'midori'), 'Midori readback is rendered');
  assert.ok(hasDelegationBadge(harness), 'delegation badge remains visible while free');

  first.resolve(harness.response({
    status: 'accepted',
    turn_id: 'turn-1',
    trace_id: 'trace-1',
    input_message_id: 'input-1',
    session_id: 'session-1',
    client_submission_id: firstSubmissionID,
  }));
  await flushTasks();
  assert.equal(input.disabled, false, 'ACK does not undo the earlier readback transition');

  submit(harness, '別件を質問します');
  await flushTasks();
  assert.equal(harness.pendingSends.length, 2, 'free input starts a second Turn');
  const second = harness.pendingSends[1];
  assert.equal(second.payload.protocol_version, 2);
  assert.notEqual(second.payload.client_submission_id, firstSubmissionID, 'a new utterance gets a new submission id');
  assert.equal(input.disabled, true, 'the second Turn has its own wait state');
  second.resolve(harness.response({
    status: 'accepted',
    turn_id: 'turn-2',
    trace_id: 'trace-2',
    input_message_id: 'input-2',
    session_id: 'session-1',
    client_submission_id: second.payload.client_submission_id,
  }));
  await flushTasks();

  const report = {
    type: 'agent.response',
    kind: 'report_reply',
    message_id: 'report-1',
    client_submission_id: firstSubmissionID,
    turn_id: 'turn-1',
    trace_id: 'trace-1',
    delegation_id: 'delegation-1',
    actor: 'mio',
    to: 'user',
    visibility: 'public',
    content: '調査結果です。',
  };
  emit(harness, report);
  assert.equal(input.disabled, true, 'late report for Turn 1 does not release Turn 2');
  const rowCount = messageRows(harness).length;
  emit(harness, report);
  assert.equal(messageRows(harness).length, rowCount, 'replayed message_id is rendered only once');
  assert.equal(hasDelegationBadge(harness), false, 'report clears the matching delegation badge');

  emit(harness, {
    type: 'agent.response',
    kind: 'reply',
    message_id: 'private-reply',
    client_submission_id: second.payload.client_submission_id,
    turn_id: 'turn-2',
    trace_id: 'trace-2',
    actor: 'mio',
    to: 'user',
    visibility: 'internal',
    content: 'DO NOT DISPLAY private prompt material',
  });
  assert.equal(input.disabled, true, 'private content does not transition Turn state');
  assert.equal(messageRows(harness).some((row) => row.textContent.includes('private prompt material')), false, 'private content is not rendered');

  emit(harness, {
    type: 'agent.response',
    kind: 'reply',
    message_id: 'reply-2',
    client_submission_id: second.payload.client_submission_id,
    turn_id: 'turn-2',
    trace_id: 'trace-2',
    actor: 'mio',
    to: 'user',
    visibility: 'public',
    content: '直接回答です。',
  });
  assert.equal(input.disabled, false, 'public direct reply ends its own Turn');

  submit(harness, '失敗する操作を確認します');
  await flushTasks();
  const third = harness.pendingSends[2];
  third.resolve(harness.response({
    status: 'accepted',
    turn_id: 'turn-3',
    trace_id: 'trace-3',
    input_message_id: 'input-3',
    session_id: 'session-1',
    client_submission_id: third.payload.client_submission_id,
  }));
  await flushTasks();
  emit(harness, {
    type: 'agent.response',
    kind: 'turn_error',
    message_id: 'error-3',
    client_submission_id: third.payload.client_submission_id,
    turn_id: 'turn-3',
    trace_id: 'trace-3',
    actor: 'mio',
    to: 'user',
    visibility: 'public',
    content: 'この依頼は処理できませんでした。',
  });
  assert.equal(input.disabled, false, 'public turn_error ends only its own Turn');
}

async function testPreAckCorrelationByTurnAndTrace() {
  for (const key of ['turn_id', 'trace_id']) {
    const harness = makeHarness();
    await flushTasks();
    submit(harness, `correlate by ${key}`);
    await flushTasks();
    const pending = harness.pendingSends[0];
    const correlation = key === 'turn_id' ? {turn_id: 'turn-only'} : {trace_id: 'trace-only'};
    emit(harness, {
      type: 'agent.response',
      kind: 'readback',
      message_id: `readback-${key}`,
      delegation_id: `delegation-${key}`,
      actor: 'kuro',
      to: 'user',
      visibility: 'public',
      availability: 'free',
      content: '依頼を復唱しました。',
      ...correlation,
    });
    assert.equal(harness.elements.get('roomInput').disabled, true, `${key} cannot match before the ACK supplies its value`);
    pending.resolve(harness.response({
      status: 'accepted',
      turn_id: key === 'turn_id' ? 'turn-only' : 'turn-from-ack',
      trace_id: key === 'trace_id' ? 'trace-only' : 'trace-from-ack',
      input_message_id: `input-${key}`,
      session_id: 'session-1',
      client_submission_id: pending.payload.client_submission_id,
    }));
    await flushTasks();
    assert.equal(harness.elements.get('roomInput').disabled, false, `ACK links the pre-ACK event by ${key}`);
  }
}

async function testClarificationPromptReleasesOnlyItsDelegationRequest() {
  const harness = makeHarness();
  await flushTasks();
  submit(harness, '対象環境を調査してください');
  await flushTasks();
  const original = harness.pendingSends[0];
  const originalSubmissionID = original.payload.client_submission_id;
  original.resolve(harness.response({
    status: 'accepted', turn_id: 'origin-turn', trace_id: 'origin-trace', input_message_id: 'origin-input',
    session_id: 'session-1', client_submission_id: originalSubmissionID,
  }));
  await flushTasks();

  emit(harness, {
    type: 'agent.response', kind: 'delegation_notice', message_id: 'notice-1',
    client_submission_id: originalSubmissionID, turn_id: 'origin-turn', trace_id: 'origin-trace',
    reply_to_message_id: 'origin-input', delegation_id: 'delegation-1', actor: 'mio', to: 'user', visibility: 'public',
    content: 'Shiroへ確認します。',
  });
  assert.equal(harness.elements.get('roomInput').disabled, true, 'delegation notice keeps its originating request pending');

  emit(harness, {
    type: 'agent.response', kind: 'clarification_prompt', message_id: 'clarification-not-free',
    turn_id: 'control-turn-not-free', trace_id: 'origin-trace', reply_to_message_id: 'origin-input',
    delegation_id: 'delegation-1', availability: 'available', actor: 'mio', to: 'user', visibility: 'public',
    content: 'この状態値では入力を解放しません。',
  });
  assert.equal(harness.elements.get('roomInput').disabled, true, 'only the canonical free availability releases Chat input');

  emit(harness, {
    type: 'agent.response', kind: 'clarification_prompt', message_id: 'clarification-1',
    turn_id: 'control-turn', trace_id: 'origin-trace', reply_to_message_id: 'origin-input',
    delegation_id: 'delegation-1', availability: 'free', actor: 'mio', to: 'user', visibility: 'public',
    content: 'どの環境を対象にしますか？',
  });
  assert.equal(harness.elements.get('roomInput').disabled, false, 'Mio’s public clarification prompt releases only its original blocking request');
  const prompt = findRowByMessageID(harness, 'clarification-1');
  assert.ok(prompt, 'Mio’s clarification question is rendered as a public message');
  const needsClarification = prompt.children.find((child) => child.dataset.delegationStatus === 'needs_clarification');
  assert.ok(needsClarification, 'delegation remains visibly marked as needing clarification');
  assert.equal(needsClarification.textContent, '確認事項あり');

  submit(harness, 'ステージング環境です');
  await flushTasks();
  assert.equal(harness.pendingSends.length, 2, 'the user can answer Mio in a new request');
  const answer = harness.pendingSends[1];
  answer.resolve(harness.response({
    status: 'accepted', turn_id: 'answer-turn', trace_id: 'answer-trace', input_message_id: 'answer-input',
    session_id: 'session-1', client_submission_id: answer.payload.client_submission_id,
  }));
  await flushTasks();
  assert.equal(harness.elements.get('roomInput').disabled, true, 'the answer has its own active request lock');

  emit(harness, {
    type: 'agent.response', kind: 'clarification_prompt', message_id: 'late-old-prompt',
    turn_id: 'late-control-turn', trace_id: 'origin-trace', reply_to_message_id: 'origin-input',
    delegation_id: 'delegation-1', availability: 'free', actor: 'mio', to: 'user', visibility: 'public',
    content: '元の委譲への遅延イベントです。',
  });
  emit(harness, {
    type: 'agent.response', kind: 'clarification_prompt', message_id: 'wrong-delegation-prompt',
    turn_id: 'answer-turn', trace_id: 'answer-trace', reply_to_message_id: 'answer-input',
    delegation_id: 'delegation-1', availability: 'free', actor: 'mio', to: 'user', visibility: 'public',
    content: '別の依頼に対応するはずのイベントです。',
  });
  assert.equal(harness.elements.get('roomInput').disabled, true, 'late or mismatched clarification control cannot clear an unrelated active request');
}

async function testClarificationReplyRequiresExplicitSelectionAndUsesPromptMessageID() {
  const unselected = makeHarness();
  await flushTasks();
  const prompt = clarificationPrompt();
  emit(unselected, prompt);
  const promptRow = findRowByMessageID(unselected, prompt.message_id);
  assert.ok(promptRow, 'the replayable public prompt is visible in Chat');
  assert.ok(findClarificationReplyAction(promptRow), 'the public prompt has an explicit answer action');
  assert.equal(findClarificationSelectionContext(promptRow), null, 'a public prompt is never selected implicitly');
  assert.equal(messageRows(unselected).some((row) => row.textContent.includes('PRIVATE CONTROL QUESTION')), false,
    'private clarification control text is not rendered');

  submit(unselected, 'これは別件です');
  await flushTasks();
  assert.equal(Object.hasOwn(unselected.pendingSends[0].payload, 'reply_to_message_id'), false,
    'an unrelated input is not attached to a prompt that was not selected');
  unselected.pendingSends[0].reject(new TypeError('network connection lost'));
  await flushTasks();

  const selected = makeHarness();
  await flushTasks();
  emit(selected, prompt);
  const selectedRow = findRowByMessageID(selected, prompt.message_id);
  const answerAction = findClarificationReplyAction(selectedRow);
  answerAction.dispatch('click');
  const selectedContext = findClarificationSelectionContext(selectedRow);
  assert.ok(selectedContext, 'selecting a prompt shows the selected prompt context');
  assert.equal(selectedContext.dataset.clarificationPromptId, prompt.message_id,
    'selection context identifies the canonical public prompt message');
  assert.ok(selectedContext.children[0].textContent.includes(prompt.content), 'selection context uses the visible public prompt');
  assert.equal(selectedContext.children.some((child) => child.textContent.includes('PRIVATE CONTROL QUESTION')), false,
    'selection context never reads private clarification_question');
  const cancel = selectedContext.children.find((child) => child.dataset.clarificationReplyCancel === 'true');
  assert.ok(cancel, 'selected prompt context offers an explicit cancel action');
  cancel.dispatch('click');
  assert.equal(findClarificationSelectionContext(selectedRow), null, 'cancel clears only the current selection');

  submit(selected, 'ステージング環境です');
  await flushTasks();
  assert.equal(Object.hasOwn(selected.pendingSends[0].payload, 'reply_to_message_id'), false,
    'cancelled selection is not attached to the next input');
  selected.pendingSends[0].reject(new TypeError('network connection lost'));
  await flushTasks();

  const retry = makeHarness({search: '?mode=Chat&protocol_version=2&ui_metrics=1'});
  await flushTasks();
  emit(retry, prompt);
  const retryRow = findRowByMessageID(retry, prompt.message_id);
  findClarificationReplyAction(retryRow).dispatch('click');
  submit(retry, '本番環境を対象にしてください');
  await flushTasks();
  const firstAttempt = retry.pendingSends[0];
  const firstSubmissionID = firstAttempt.payload.client_submission_id;
  assert.equal(firstAttempt.payload.reply_to_message_id, prompt.message_id,
    'the answer references clarification_prompt.message_id, not the prompt origin input');
  assert.notEqual(firstAttempt.payload.reply_to_message_id, prompt.reply_to_message_id,
    'the origin input ID is not substituted for the canonical prompt message ID');
  assert.ok(firstSubmissionID, 'the answer preserves a retry-stable client_submission_id');
  firstAttempt.reject(new TypeError('network connection lost'));
  await flushTasks();
  assert.ok(findClarificationSelectionContext(retryRow), 'uncertain send error preserves the selected prompt');

  submit(retry, '本番環境を対象にしてください');
  await flushTasks();
  const secondAttempt = retry.pendingSends[1];
  assert.equal(secondAttempt.payload.client_submission_id, firstSubmissionID,
    'retry keeps the same client_submission_id while prompt and answer text are unchanged');
  assert.equal(secondAttempt.payload.reply_to_message_id, prompt.message_id,
    'retry keeps the same prompt correlation');
  secondAttempt.resolve(retry.response({
    status: 'accepted', turn_id: 'answer-turn', trace_id: 'answer-trace', input_message_id: 'answer-input',
    session_id: 'session-1', client_submission_id: firstSubmissionID,
  }));
  await flushTasks();
  assert.ok(findClarificationSelectionContext(retryRow), 'accepted ACK alone does not discard context before a matching public response');

  emit(retry, {
    type: 'agent.response', kind: 'reply', message_id: 'unrelated-reply',
    client_submission_id: 'other-submission', turn_id: 'other-turn', trace_id: 'other-trace',
    reply_to_message_id: prompt.message_id,
    actor: 'mio', to: 'user', visibility: 'public', content: '別の回答です。',
  });
  assert.equal(retry.elements.get('roomInput').disabled, true,
    'a reply that merely references the same prompt cannot release the answer request');

  emit(retry, {
    type: 'conversation.user_message', message_id: 'answer-input',
    client_submission_id: firstSubmissionID, turn_id: 'answer-turn', trace_id: 'answer-trace',
    reply_to_message_id: prompt.message_id, actor: 'user', visibility: 'public', content: '本番環境を対象にしてください',
  });
  emit(retry, {
    type: 'agent.response', kind: 'reply', message_id: 'answer-reply',
    client_submission_id: firstSubmissionID, turn_id: 'answer-turn', trace_id: 'answer-trace',
    actor: 'mio', to: 'user', visibility: 'public', content: '本番環境を対象にします。',
  });
  assert.equal(retry.elements.get('roomInput').disabled, false, 'matching public response completes the selected clarification answer');
  assert.equal(findClarificationSelectionContext(retryRow), null, 'successful response clears the consumed prompt selection');
  assert.equal(findClarificationReplyAction(retryRow).textContent, '回答を送信しました',
    'the consumed prompt cannot be silently selected again');
  assert.equal(findClarificationReplyAction(retryRow).disabled, true, 'the consumed prompt action is disabled');
  const metrics = retry.window.RenCrowPortalMetrics.snapshot();
  const responseMetric = metrics.records.find((record) => record.event === 'ui_response_received'
    && record.message_id === 'answer-reply');
  assert.ok(responseMetric, 'the answer response is recorded by UI metrics');
  assert.equal(responseMetric.submission_id, 2, 'the response metrics link to the successful retry attempt');
  assert.equal(responseMetric.trace_id, 'answer-trace', 'the response metrics retain the accepted answer trace');

  const reloaded = makeHarness();
  await flushTasks();
  emit(reloaded, prompt);
  const reloadedRow = findRowByMessageID(reloaded, prompt.message_id);
  assert.ok(reloadedRow, 'public prompt replay restores the visible message after page reload');
  findClarificationReplyAction(reloadedRow).dispatch('click');
  assert.ok(findClarificationSelectionContext(reloadedRow), 'replayed prompt remains explicitly answerable');
  submit(reloaded, '再読み込み後の回答');
  await flushTasks();
  assert.equal(reloaded.pendingSends[0].payload.reply_to_message_id, prompt.message_id,
    'a replayed public prompt preserves its canonical ID when selected after reload');

  const stale = makeHarness();
  await flushTasks();
  emit(stale, prompt);
  const staleRow = findRowByMessageID(stale, prompt.message_id);
  findClarificationReplyAction(staleRow).dispatch('click');
  staleRow.remove();
  submit(stale, '行から消えた質問への回答');
  await flushTasks();
  assert.equal(stale.pendingSends.length, 0, 'a stale selection cannot attach after its public prompt leaves the conversation');
  assert.equal(findClarificationSelectionContext(staleRow), null, 'stale selection is visibly discarded before any send');
}

async function testClarificationReplyCorrelatesSSEBeforeAck() {
  const harness = makeHarness();
  await flushTasks();
  const prompt = clarificationPrompt('before-ack-question');
  emit(harness, prompt);
  findClarificationReplyAction(findRowByMessageID(harness, prompt.message_id)).dispatch('click');
  submit(harness, '回答はACKより前に返ります');
  await flushTasks();
  const pending = harness.pendingSends[0];
  const submissionID = pending.payload.client_submission_id;

  emit(harness, {
    type: 'agent.response', kind: 'reply', message_id: 'unrelated-before-ack',
    client_submission_id: 'another-submission', turn_id: 'another-turn', trace_id: 'another-trace',
    reply_to_message_id: prompt.message_id,
    actor: 'mio', to: 'user', visibility: 'public', content: '別件です。',
  });
  assert.equal(harness.elements.get('roomInput').disabled, true,
    'a reply sharing only the selected prompt ID does not match before ACK');

  emit(harness, {
    type: 'agent.response', kind: 'reply', message_id: 'before-ack-answer',
    client_submission_id: submissionID, turn_id: 'before-ack-turn', trace_id: 'before-ack-trace',
    actor: 'mio', to: 'user', visibility: 'public', content: '回答を受け取りました。',
  });
  assert.equal(harness.elements.get('roomInput').disabled, false,
    'SSE with the exact client_submission_id completes the reply before HTTP ACK');
  assert.equal(findClarificationSelectionContext(findRowByMessageID(harness, prompt.message_id)), null,
    'the matching pre-ACK response consumes the prompt selection');

  pending.resolve(harness.response({
    status: 'accepted', turn_id: 'before-ack-turn', trace_id: 'before-ack-trace', input_message_id: 'before-ack-input',
    session_id: 'session-1', client_submission_id: submissionID,
  }));
  await flushTasks();
  assert.equal(harness.elements.get('roomInput').disabled, false,
    'the later ACK binds without undoing the earlier matching SSE completion');
  assert.equal(harness.eventSources.length, 1, 'SSE-before-ACK does not create a duplicate conversation stream');
}

async function testClarificationReadbackTargetsAnswerBeforeAck() {
  const harness = makeHarness({search: '?mode=Chat&protocol_version=2&ui_metrics=1'});
  await flushTasks();
  submit(harness, '委譲依頼');
  await flushTasks();
  const original = harness.pendingSends[0];
  const originalSubmissionID = original.payload.client_submission_id;
  original.resolve(harness.response({
    status: 'accepted', turn_id: 'origin-turn', trace_id: 'origin-trace', input_message_id: 'origin-input',
    session_id: 'session-1', client_submission_id: originalSubmissionID,
  }));
  await flushTasks();

  emit(harness, {
    type: 'agent.response', kind: 'delegation_notice', message_id: 'answer-readback-notice',
    client_submission_id: originalSubmissionID, turn_id: 'origin-turn', trace_id: 'origin-trace',
    reply_to_message_id: 'origin-input', delegation_id: 'answer-readback-delegation',
    actor: 'mio', to: 'user', visibility: 'public', content: '確認します。',
  });
  emit(harness, {
    ...clarificationPrompt('answer-readback-question'),
    client_submission_id: originalSubmissionID,
    turn_id: 'origin-control-turn',
    trace_id: 'origin-trace',
    reply_to_message_id: 'origin-input',
    delegation_id: 'answer-readback-delegation',
  });
  assert.equal(harness.elements.get('roomInput').disabled, false, 'the accepted clarification prompt releases the original request');

  const promptRow = findRowByMessageID(harness, 'answer-readback-question');
  findClarificationReplyAction(promptRow).dispatch('click');
  submit(harness, '回答依頼');
  await flushTasks();
  const answer = harness.pendingSends[1];
  const answerSubmissionID = answer.payload.client_submission_id;

  emit(harness, {
    type: 'agent.response', kind: 'readback', message_id: 'answer-readback-public',
    client_submission_id: originalSubmissionID, turn_id: 'origin-turn', trace_id: 'origin-trace',
    response_to_turn_id: 'answer-turn-before-ack',
    response_to_client_submission_id: answerSubmissionID,
    reply_to_message_id: 'origin-input', delegation_id: 'answer-readback-delegation',
    availability: 'free', actor: 'mio', to: 'user', visibility: 'public', content: '回答を受け付けました。',
  });

  assert.equal(harness.elements.get('roomInput').disabled, false,
    'the readback correlation releases the clarification answer request before its HTTP ACK');
  const metrics = harness.window.RenCrowPortalMetrics.snapshot();
  const readbackMetric = metrics.records.find((record) => record.event === 'ui_readback_received'
    && record.message_id === 'answer-readback-public');
  assert.ok(readbackMetric, 'the answer readback is recorded by UI metrics');
  assert.equal(readbackMetric.submission_id, 2, 'the readback metrics link to the clarification answer submission');
  assert.equal(readbackMetric.turn_id, 'answer-turn-before-ack', 'the readback metrics use response_to_turn_id');
  assert.equal(readbackMetric.origin_turn_id, 'origin-turn', 'the readback metrics retain the original Turn separately');

  answer.resolve(harness.response({
    status: 'accepted', turn_id: 'answer-turn-before-ack', trace_id: 'answer-trace', input_message_id: 'answer-input',
    session_id: 'session-1', client_submission_id: answerSubmissionID,
  }));
  await flushTasks();
  assert.equal(harness.elements.get('roomInput').disabled, false,
    'the later ACK preserves the pre-ACK readback completion');
}

async function testUnmatchedResponseToDoesNotCorrelateByOriginTrace() {
  const harness = makeHarness({search: '?mode=Chat&protocol_version=2&ui_metrics=1'});
  await flushTasks();
  submit(harness, '応答待ちの依頼');
  await flushTasks();
  const pending = harness.pendingSends[0];
  const submissionID = pending.payload.client_submission_id;
  pending.resolve(harness.response({
    status: 'accepted', turn_id: 'origin-turn', trace_id: 'origin-trace', input_message_id: 'origin-input',
    session_id: 'session-1', client_submission_id: submissionID,
  }));
  await flushTasks();
  assert.equal(harness.elements.get('roomInput').disabled, true, 'the origin request remains active while awaiting its response');

  emit(harness, {
    type: 'agent.response', kind: 'readback', message_id: 'unmatched-response-to-readback',
    client_submission_id: submissionID, turn_id: 'origin-turn', trace_id: 'origin-trace',
    response_to_turn_id: 'different-answer-turn',
    response_to_client_submission_id: 'different-answer-submission',
    reply_to_message_id: 'origin-input', availability: 'free',
    actor: 'mio', to: 'user', visibility: 'public', content: '別の回答に属する復唱です。',
  });

  assert.equal(harness.elements.get('roomInput').disabled, true,
    'unmatched response-to identifiers cannot release the origin request through its trace');
  const metric = harness.window.RenCrowPortalMetrics.snapshot().records.find((record) =>
    record.event === 'ui_readback_received' && record.message_id === 'unmatched-response-to-readback');
  assert.ok(metric, 'the unmatched readback remains observable in UI metrics');
  assert.equal(metric.submission_id, null,
    'an origin trace cannot attribute a response-to event to the blocking request');
}

async function testClosedFirstConversationStreamReplaysAfterAcceptedAck() {
  const harness = makeHarness({search: '?mode=Chat&protocol_version=2&ui_metrics=1'});
  await flushTasks();
  assert.equal(harness.eventSources.length, 1, 'the first v2 conversation stream is opened');
  harness.eventSources[0].close();

  submit(harness, '再接続後に正本イベントを表示します');
  await flushTasks();
  const pending = harness.pendingSends[0];
  const submissionID = pending.payload.client_submission_id;
  pending.resolve(harness.response({
    status: 'accepted', turn_id: 'replay-turn', trace_id: 'replay-trace', input_message_id: 'replay-input',
    session_id: 'session-1', client_submission_id: submissionID,
  }));
  await flushTasks();

  assert.equal(harness.eventSources.length, 2,
    'an accepted POST reconnects a v2 EventSource that closed before the session existed');
  assert.match(harness.eventSources[1].url, /\/viewer\/conversation\/events(?:\?|$)/,
    'replay reconnect uses the owner/session scoped conversation stream');
  const replay = [
    {
      type: 'conversation.user_message', message_id: 'replay-input', client_submission_id: submissionID,
      turn_id: 'replay-turn', trace_id: 'replay-trace', actor: 'user', visibility: 'public',
      content: '再接続後に正本イベントを表示します',
    },
    {
      type: 'agent.response', kind: 'delegation_notice', message_id: 'replay-notice',
      client_submission_id: submissionID, turn_id: 'replay-turn', trace_id: 'replay-trace',
      reply_to_message_id: 'replay-input', delegation_id: 'replay-delegation', actor: 'mio', to: 'user',
      visibility: 'public', content: 'Shiroへ依頼しました。',
    },
    {
      type: 'agent.response', kind: 'readback', message_id: 'replay-readback',
      client_submission_id: submissionID, turn_id: 'replay-turn', trace_id: 'replay-trace',
      reply_to_message_id: 'replay-input', delegation_id: 'replay-delegation', actor: 'shiro', to: 'user',
      visibility: 'public', availability: 'free', content: '依頼を受け取りました。',
    },
    {
      type: 'agent.response', kind: 'report_reply', message_id: 'replay-report',
      client_submission_id: submissionID, turn_id: 'report-turn', trace_id: 'report-trace',
      origin_turn_id: 'replay-turn', origin_user_message_id: 'replay-input',
      delegation_id: 'replay-delegation', actor: 'mio', to: 'user', visibility: 'public', content: '調査結果です。',
    },
  ];
  for (const event of replay) emit(harness, event, 1);
  emit(harness, replay[1], 1);
  emit(harness, replay[3], 1);

  const renderedIDs = messageRows(harness).map((row) => row.dataset.messageId);
  for (const messageID of ['replay-input', 'replay-notice', 'replay-readback', 'replay-report']) {
    assert.equal(renderedIDs.filter((id) => id === messageID).length, 1,
      `replayed ${messageID} is rendered once`);
  }
  const records = harness.window.RenCrowPortalMetrics.snapshot().records;
  for (const messageID of ['replay-notice', 'replay-readback', 'replay-report']) {
    const correlated = records.filter((record) => record.message_id === messageID && record.event.endsWith('_received'));
    assert.ok(correlated.length > 0, `${messageID} is represented in UI metrics`);
    assert.equal(correlated.length, 1, `${messageID} replay does not duplicate its response metric`);
    assert.ok(correlated.every((record) => record.submission_id === 1),
      `${messageID} replay metrics remain linked to the accepted POST`);
  }
  assert.equal(records.find((record) => record.message_id === 'replay-report' && record.event.endsWith('_received')).trace_id,
    'report-trace', 'later report metrics retain their independent trace');
}

async function testV2UncertainRetryReusesOnlyTheSameSubmission() {
  const harness = makeHarness();
  await flushTasks();

  submit(harness, '同じ送信を再試行します');
  await flushTasks();
  const first = harness.pendingSends[0];
  const firstSubmissionID = first.payload.client_submission_id;
  first.reject(new TypeError('network connection lost'));
  await flushTasks();
  assert.equal(harness.elements.get('roomInput').value, '同じ送信を再試行します', 'uncertain send keeps its input available for retry');

  submit(harness, '同じ送信を再試行します');
  await flushTasks();
  const retry = harness.pendingSends[1];
  assert.equal(retry.payload.client_submission_id, firstSubmissionID, 'retry reuses the id after an uncertain POST outcome');
  retry.resolve(harness.response({
    status: 'accepted',
    turn_id: 'retry-turn',
    trace_id: 'retry-trace',
    input_message_id: 'retry-input',
    session_id: 'session-1',
    client_submission_id: firstSubmissionID,
  }));
  await flushTasks();
  emit(harness, {
    type: 'agent.response',
    kind: 'reply',
    message_id: 'retry-reply',
    client_submission_id: firstSubmissionID,
    turn_id: 'retry-turn',
    trace_id: 'retry-trace',
    actor: 'mio',
    to: 'user',
    visibility: 'public',
    content: '受付済みの回答です。',
  });

  submit(harness, '同じ送信を再試行します');
  await flushTasks();
  assert.notEqual(harness.pendingSends[2].payload.client_submission_id, firstSubmissionID, 'a new send after a terminal reply gets a fresh id');

  const changed = makeHarness();
  await flushTasks();
  submit(changed, '送信内容');
  await flushTasks();
  const uncertain = changed.pendingSends[0];
  const uncertainID = uncertain.payload.client_submission_id;
  uncertain.reject(new TypeError('network connection lost'));
  await flushTasks();
  const changedInput = changed.elements.get('roomInput');
  changedInput.value = '送信内容を変更';
  changedInput.dispatch('input');
  changedInput.value = '送信内容';
  changedInput.dispatch('input');
  submit(changed, '送信内容');
  await flushTasks();
  assert.notEqual(changed.pendingSends[1].payload.client_submission_id, uncertainID, 'editing input invalidates a retry id even when text is restored');

  const terminal = makeHarness();
  await flushTasks();
  submit(terminal, '終端エラー後の新規送信');
  await flushTasks();
  const terminalSend = terminal.pendingSends[0];
  const terminalSubmissionID = terminalSend.payload.client_submission_id;
  terminalSend.reject(new TypeError('network connection lost'));
  await flushTasks();
  emit(terminal, {
    type: 'agent.response',
    kind: 'turn_error',
    message_id: 'terminal-error',
    client_submission_id: terminalSubmissionID,
    turn_id: 'terminal-turn',
    trace_id: 'terminal-trace',
    actor: 'mio',
    to: 'user',
    visibility: 'public',
    content: 'Turnを終了しました。',
  });
  submit(terminal, '終端エラー後の新規送信');
  await flushTasks();
  assert.notEqual(terminal.pendingSends[1].payload.client_submission_id, terminalSubmissionID, 'a terminal turn_error prevents reuse of the uncertain id');
}

async function testLegacyDefaultAndUnsupportedV2AreExplicit() {
  const legacy = makeHarness({search: '?mode=Chat', recipient: 'mio'});
  await flushTasks();
  assert.match(legacy.eventSources[0].url, /\/viewer\/events(?:\?|$)/, 'v1 keeps the legacy global stream');
  submit(legacy, 'legacy message');
  await flushTasks();
  const legacySend = legacy.pendingSends[0];
  assert.ok(legacySend, 'legacy send starts by default');
  assert.equal('protocol_version' in legacySend.payload, false, 'default request keeps the legacy payload');
  assert.equal('client_submission_id' in legacySend.payload, false, 'legacy request has no v2 id');
  legacySend.resolve(legacy.response({trace_id: 'legacy-trace', recipient: 'mio', attachment_count: 0}));
  await flushTasks();
  assert.equal(legacy.elements.get('roomInput').disabled, true, 'legacy keeps its existing request lock');
  emit(legacy, {
    type: 'agent.response',
    message_id: 'legacy-reply',
    trace_id: 'legacy-trace',
    from: 'mio',
    to: 'user',
    content: 'legacy response',
  });
  assert.equal(messageRows(legacy).length, 1, 'legacy response is still rendered');
  assert.equal(legacy.elements.get('roomInput').disabled, false, 'legacy terminal response releases its lock');

  const unsupported = makeHarness({search: '?mode=Chat&protocol_version=2', recipient: 'shiro'});
  await flushTasks();
  submit(unsupported, 'not supported for Shiro');
  await flushTasks();
  assert.equal(unsupported.pendingSends.length, 0, 'v2 request is not silently sent as v1 for another recipient');
  assert.match(unsupported.elements.get('operationStatus').textContent, /Mio/);
}

(async () => {
  await testAgentStartStatusRequiresTheActiveRequestTrace();
  await testV2DoesNotWaitForTTSButLegacyStillDoes();
  await testV2PreAckReadbackAndLateReportIsolation();
  await testPreAckCorrelationByTurnAndTrace();
  await testClarificationPromptReleasesOnlyItsDelegationRequest();
  await testClarificationReplyRequiresExplicitSelectionAndUsesPromptMessageID();
  await testClarificationReplyCorrelatesSSEBeforeAck();
  await testClarificationReadbackTargetsAnswerBeforeAck();
  await testUnmatchedResponseToDoesNotCorrelateByOriginTrace();
  await testClosedFirstConversationStreamReplaysAfterAcceptedAck();
  await testV2UncertainRetryReusesOnlyTheSameSubmission();
  await testLegacyDefaultAndUnsupportedV2AreExplicit();
  console.log('[OK] response-first portal UI tests passed');
})().catch((error) => {
  console.error(`[NG] response-first portal UI tests failed\n${error && error.stack || error}`);
  process.exitCode = 1;
});
