'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const portalSource = fs.readFileSync(path.join(__dirname, '..', 'web', 'portal.js'), 'utf8');
const gamesSource = fs.readFileSync(path.join(__dirname, '..', 'web', 'games.js'), 'utf8');

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
    this.attributes = {};
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler({target: this, currentTarget: this, preventDefault() {}, ...event});
    }
  }

  append(...elements) {
    for (const element of elements) {
      element.parentElement = this;
      this.children.push(element);
    }
  }

  replaceChildren(...elements) {
    this.children = [];
    this.append(...elements);
  }

  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return null; }
  remove() { this.isConnected = false; }
  get firstElementChild() { return this.children[0] || null; }
  getAttribute(name) { return this.attributes[name] || ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() {}
  click() {}
}

function makeHarness(mode, {deferClaim = false, sessionValues = null, registrationRequiredOnce = false} = {}) {
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const intervalTasks = [];
  const requests = [];
  const eventSources = [];
  const audioInstances = [];
  const pendingAudioFetches = [];
  const beacons = [];
  const pendingSends = [];
  let claimResolver = null;
  let failHeartbeat = false;
  let deferNextClaim = false;
  let foregroundReady = true;
  let runtimeEpoch = 'core-epoch-1';
  let receiptSuffix = '';
  let requestID = 0;
  let deferAudioContextResume = false;
  let resolveAudioContextResume = null;
  let deferAudioPlay = false;
  const documentElement = new FakeElement('html');
  const body = new FakeElement('body');
  body.dataset.mode = mode;
  body.dataset.surface = mode;
  const document = {
    body,
    documentElement,
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
    querySelectorAll() { return []; },
    querySelector(selector) {
      if (selector === '.games-screen-shell') return this.getElementById('gamesScreenShell');
      return null;
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
  const localValues = new Map([
    ['rencrow.portal.ttsPreference', 'off'],
    ['roomConversation.selectedPartner', 'mio'],
  ]);
  const localStorage = {
    getItem(key) { return localValues.has(key) ? localValues.get(key) : null; },
    setItem(key, value) { localValues.set(key, String(value)); },
  };
  const storedSessionValues = sessionValues || new Map([['rencrow.portal.viewerClientID', 'portal-presence-test']]);
  if (!storedSessionValues.has('rencrow.portal.surfacePresenceV2')) {
    storedSessionValues.set('rencrow.portal.surfacePresenceV2', JSON.stringify({
      viewerClientID: 'portal-presence-test',
      protocolVersion: 2,
      runtimeEpoch: 'core-epoch-1',
      registrationReceipt: 'presence-receipt-core-epoch-1',
      surface: '',
      updateSeq: 0,
      claimSeq: 0,
      stateRevision: 0,
      playbackGeneration: 0,
    }));
  }
  const sessionStorage = {
    getItem(key) { return storedSessionValues.has(key) ? storedSessionValues.get(key) : null; },
    setItem(key, value) { storedSessionValues.set(key, String(value)); },
    removeItem(key) { storedSessionValues.delete(key); },
  };

  function response(payload = {}, status = 200) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {get: () => 'application/json'},
      json: async () => typeof payload === 'string' ? JSON.parse(payload) : payload,
      text: async () => text,
      blob: async () => ({type: 'audio/test'}),
    };
  }

  function presenceResponse(body) {
    if (body.action === 'register') {
      return Promise.resolve(response({
        ok: true,
        protocol_version: 2,
        runtime_epoch: runtimeEpoch,
        registration_receipt: `presence-receipt-${runtimeEpoch}${receiptSuffix}`,
        registration_expires_at: '2026-10-24T13:00:30Z',
        last_update_seq: 0,
      }));
    }
    if (body.action === 'claim' && registrationRequiredOnce) {
      registrationRequiredOnce = false;
      receiptSuffix = '-reissued';
      return Promise.resolve(response({error: 'registration_required'}, 409));
    }
    if (body.action === 'heartbeat' && failHeartbeat) return Promise.resolve(response({error: 'disconnected'}, 503));
    const resolveClaim = (payload = {}) => response({
      ok: true,
      protocol_version: 2,
      accepted_update_seq: body.update_seq,
      current_claim_seq: body.action === 'claim' ? body.update_seq : body.claim_seq,
      runtime_epoch: body.runtime_epoch,
      registration_receipt: body.registration_receipt,
      state_revision: 7,
      playback_state: 'stopped',
      playback_generation: 4,
      playback_allowed: body.surface === 'idlechat',
      foreground_ready: body.surface !== 'idlechat' && foregroundReady,
      cleanup_pending: false,
      ...payload,
    });
    if (body.action === 'claim' && (deferClaim || deferNextClaim)) {
      deferNextClaim = false;
      return new Promise((resolve) => { claimResolver = (payload) => resolve(resolveClaim(payload)); });
    }
    return Promise.resolve(resolveClaim());
  }

  const fetch = (url, options = {}) => {
    const entry = {url: String(url), options};
    requests.push(entry);
    const body = (() => {
      try { return JSON.parse(options.body || '{}'); } catch { return {}; }
    })();
    if (String(url).includes('/viewer/surface-presence')) return presenceResponse(body);
    if (String(url).includes('/viewer/tts/audio')) {
      return new Promise((resolve) => pendingAudioFetches.push({resolve: () => resolve(response({audio: true}))}));
    }
    if (String(url).includes('/viewer/send')) {
      return new Promise((resolve, reject) => pendingSends.push({body, resolve, reject}));
    }
    if (String(url).includes('/viewer/idlechat/playback')) {
      return Promise.resolve(response({protocol_version: 2, state_revision: 8, playback: {current: {}, can_next: true}}));
    }
    if (String(url).includes('/viewer/idlechat/status')) {
      return Promise.resolve(response({topic_stock_playback: {current: {}, can_next: true, can_previous: false}}));
    }
    if (String(url).includes('/viewer/games/status')) {
      return Promise.resolve(response({decision_mode: 'agent', supported_games: ['nethack']}));
    }
    if (String(url).includes('/viewer/games/observer-api/games/sessions')) {
      return Promise.resolve(response({sessions: []}));
    }
    if (String(url).includes('/viewer/games/launch')) {
      return Promise.resolve(response({session_id: `game-session-${++requestID}`, status: 'launching'}));
    }
    if (String(url).includes('/health/ready')) return Promise.resolve(response({ready: true}));
    return Promise.resolve(response({}));
  };

  const window = {
    location: {search: `?mode=${mode}`, href: `http://localhost/?mode=${mode}`},
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    matchMedia() { return {addEventListener() {}}; },
    setInterval(callback, milliseconds) {
      const task = {callback, milliseconds, active: true};
      intervalTasks.push(task);
      return intervalTasks.length;
    },
    clearInterval(id) { if (intervalTasks[id - 1]) intervalTasks[id - 1].active = false; },
    setTimeout(callback) { intervalTasks.push({callback, milliseconds: 0, active: true}); return intervalTasks.length; },
    clearTimeout() {},
    addEventListener(type, handler) {
      const handlers = windowListeners.get(type) || [];
      handlers.push(handler);
      windowListeners.set(type, handlers);
    },
    dispatch(type, event = {}) { for (const handler of windowListeners.get(type) || []) handler(event); },
    requestAnimationFrame() { return ++requestID; },
    cancelAnimationFrame() {},
  };
  class FakeEventSource {
    constructor(url) { this.url = url; this.readyState = 0; this.onopen = null; this.onmessage = null; this.onerror = null; this.listeners = new Map(); eventSources.push(this); }
    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }
    close() { this.readyState = 2; }
    fail() { this.readyState = 0; if (this.onerror) this.onerror(); }
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    emit(type, payload) {
      const message = {type, data: JSON.stringify(payload)};
      if (type === 'message' && this.onmessage) this.onmessage(message);
      for (const handler of this.listeners.get(type) || []) handler(message);
    }
  }
  class FakeAudio {
    constructor(source = '') {
      this.src = source;
      this.listeners = new Map();
      this.playCount = 0;
      this.paused = false;
      this.error = null;
      audioInstances.push(this);
    }
    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }
    dispatch(type) { for (const handler of this.listeners.get(type) || []) handler(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    play() {
      this.playCount += 1;
      if (!deferAudioPlay) return Promise.resolve();
      deferAudioPlay = false;
      return new Promise((resolve) => { this.resolvePlay = resolve; });
    }
  }
  class FakeAudioContext {
    async resume() {
      if (!deferAudioContextResume) return;
      deferAudioContextResume = false;
      return new Promise((resolve) => { resolveAudioContextResume = resolve; });
    }
    createMediaElementSource() { return {connect() {}, disconnect() {}}; }
    createAnalyser() {
      return {fftSize: 0, smoothingTimeConstant: 0, connect() {}, disconnect() {}, getFloatTimeDomainData() {}};
    }
    get destination() { return {}; }
  }
  window.AudioContext = FakeAudioContext;
  class FakeURL extends URL {}
  FakeURL.createObjectURL = () => `blob:test-${++requestID}`;
  FakeURL.revokeObjectURL = () => {};
  const sandbox = {
    document,
    window,
    navigator: {
      platform: 'test',
      userAgentData: {platform: 'test'},
      sendBeacon(url, blob) { beacons.push({url, blob}); return true; },
    },
    localStorage,
    sessionStorage,
    fetch,
    EventSource: FakeEventSource,
    Audio: FakeAudio,
    FormData: class FakeFormData { append() {} },
    Blob: class FakeBlob { constructor(parts) { this.parts = parts; } },
    URL: FakeURL,
    URLSearchParams,
    Date,
    Intl,
    performance: {now: () => 1},
    crypto: {randomUUID: () => `test-${++requestID}`},
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    console: {error() {}, log() {}, warn() {}},
  };
  vm.runInNewContext(portalSource, sandbox, {filename: 'portal.js'});
  if (mode === 'games') vm.runInNewContext(gamesSource, sandbox, {filename: 'games.js'});
  return {
    document,
    elements,
    eventSources,
    beacons,
    sessionValues: storedSessionValues,
    intervalTasks,
    requests,
    pendingSends,
    pendingAudioFetches,
    window,
    response,
    resolveClaim(payload) { assert.ok(claimResolver, 'a claim response is pending'); claimResolver(payload); claimResolver = null; },
    setFailHeartbeat(value) { failHeartbeat = value; },
    deferOneClaim() { deferNextClaim = true; },
    setForegroundReady(value) { foregroundReady = value; },
    setRuntimeEpoch(value) { runtimeEpoch = value; },
    audioInstances,
    deferNextAudioContextResume() { deferAudioContextResume = true; },
    resolveAudioContextResume() {
      assert.ok(resolveAudioContextResume, 'an audio context resume is pending');
      resolveAudioContextResume();
      resolveAudioContextResume = null;
    },
    deferNextAudioPlay() { deferAudioPlay = true; },
    resolveAudioPlay(audio = audioInstances.at(-1)) {
      assert.ok(audio && audio.resolvePlay, 'an audio play promise is pending');
      audio.resolvePlay();
      audio.resolvePlay = null;
    },
  };
}

async function flushTasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function idleControl(overrides = {}) {
  return {
    runtime_epoch: 'core-epoch-1',
    state_revision: 8,
    playback_generation: 5,
    playback_state: 'blocked',
    playback_allowed: false,
    playback_active: false,
    cleanup_pending: false,
    generation_state: 'idle',
    generation_quiesced: true,
    backend_resource_state: 'released',
    ...overrides,
  };
}

async function testChatUsesV2PresenceBeforeReadyAndSendsClaimReference() {
  const harness = makeHarness('chat', {deferClaim: true});
  await flushTasks();
  const presenceRequests = harness.requests.filter((item) => item.url.includes('/viewer/surface-presence'));
  assert.deepEqual(presenceRequests.map((item) => JSON.parse(item.options.body).action), ['register', 'claim']);
  const claim = JSON.parse(presenceRequests[1].options.body);
  assert.equal(claim.protocol_version, 2);
  assert.equal(claim.update_seq, 1);
  assert.equal(harness.elements.get('roomInput').disabled, true, 'Chat stays disabled while claim is unresolved');

  harness.resolveClaim();
  await flushTasks();
  assert.equal(harness.elements.get('roomInput').disabled, false, 'Chat becomes ready after V2 foreground_ready');

  const input = harness.elements.get('roomInput');
  input.value = 'presence bound send';
  input.dispatch('keydown', {key: 'Enter', keyCode: 13, isComposing: false, preventDefault() {}});
  await flushTasks();
  const send = harness.requests.find((item) => item.url.includes('/viewer/send'));
  assert.ok(send, 'Chat send is issued');
  const payload = JSON.parse(send.options.body);
  assert.deepEqual(payload.presence, {
    protocol_version: 2,
    runtime_epoch: 'core-epoch-1',
    registration_receipt: 'presence-receipt-core-epoch-1',
    claim_seq: 1,
  });
}

async function testIdlePlaybackRequiresExplicitActionAndCarriesCurrentRevision() {
  const harness = makeHarness('idlechat');
  await flushTasks();
  assert.equal(harness.requests.some((item) => item.url.includes('/viewer/idlechat/playback')),
    false, 'claim never automatically resumes IdleChat playback');
  const play = harness.elements.get('idlePlaybackPlay');
  play.dispatch('click');
  await flushTasks();
  const request = harness.requests.find((item) => item.url.includes('/viewer/idlechat/playback'));
  assert.ok(request, 'explicit play click reaches CORE');
  assert.deepEqual(JSON.parse(request.options.body), {
    protocol_version: 2,
    viewer_client_id: 'portal-presence-test',
    runtime_epoch: 'core-epoch-1',
    registration_receipt: 'presence-receipt-core-epoch-1',
    claim_seq: 1,
    expected_state_revision: 7,
    action: 'play',
  });
}

async function testGamesActionsWaitForPresenceAndDisableAfterHeartbeatFailure() {
  const harness = makeHarness('games', {deferClaim: true});
  await flushTasks();
  const launchButton = harness.elements.get('gamesLaunchButton');
  const form = harness.elements.get('gamesLaunchForm');
  assert.equal(launchButton.disabled, true, 'Games launch is disabled before foreground_ready');
  form.dispatch('submit');
  await flushTasks();
  assert.equal(harness.requests.some((item) => item.url.includes('/viewer/games/launch')), false,
    'Games does not send launch before V2 presence is ready');

  harness.resolveClaim();
  await flushTasks();
  assert.equal(launchButton.disabled, false, 'Games launch is enabled after foreground_ready');
  const readyTimer = harness.intervalTasks.filter((entry) => entry.active && entry.milliseconds === 10000).at(-1);
  readyTimer.callback();
  await flushTasks();
  const heartbeat = harness.requests.map((item) => JSON.parse(item.options.body || '{}'))
    .find((body) => body.action === 'heartbeat');
  assert.equal(heartbeat.update_seq, 2, 'heartbeat advances the registration update sequence');
  assert.equal(heartbeat.claim_seq, 1, 'heartbeat keeps the original claim sequence');

  form.dispatch('submit');
  await flushTasks();
  assert.equal(harness.requests.filter((item) => item.url.includes('/viewer/games/launch')).length, 1,
    'Games launch sends after foreground_ready');

  harness.setFailHeartbeat(true);
  harness.setForegroundReady(false);
  harness.setRuntimeEpoch('core-epoch-2');
  harness.deferOneClaim();
  for (const task of harness.intervalTasks.filter((entry) => entry.active && entry.milliseconds === 10000)) task.callback();
  for (let index = 0; index < 5; index += 1) await flushTasks();
  assert.equal(launchButton.disabled, true, 'Games actions are disabled after heartbeat loss');
  const recoveryClaim = harness.requests.map((item) => JSON.parse(item.options.body || '{}'))
    .filter((body) => body.action === 'claim').at(-1);
  assert.equal(recoveryClaim.runtime_epoch, 'core-epoch-2', 'CORE restart recovery claims under the new runtime epoch');
  form.dispatch('submit');
  harness.elements.get('gamesRetryButton').dispatch('click');
  harness.elements.get('gamesStartOverButton').dispatch('click');
  await flushTasks();
  assert.equal(harness.requests.filter((item) => item.url.includes('/viewer/games/launch')).length, 1,
    'Games does not send after presence readiness is lost');
  assert.equal(harness.requests.filter((item) => /\/viewer\/games\/sessions\/.*\/(retry|start_over)/.test(item.url)).length, 0,
    'Games does not send retry or start-over after presence readiness is lost');
}

async function testDelayedClaimAfterHideCannotRestoreReady() {
  const harness = makeHarness('chat', {deferClaim: true});
  await flushTasks();
  harness.document.visibilityState = 'hidden';
  harness.document.dispatch('visibilitychange');
  harness.resolveClaim();
  for (let index = 0; index < 5; index += 1) await flushTasks();
  assert.equal(harness.elements.get('roomInput').disabled, true,
    'a delayed claim response cannot restore ready after the surface is hidden');
}

async function testModeReplacementCarriesSequenceAndReRegistersAfterLateRelease() {
  const chat = makeHarness('chat');
  await flushTasks();
  chat.window.dispatch('pagehide');
  const release = JSON.parse(chat.beacons[0].blob.parts[0]);
  assert.equal(release.action, 'release');
  assert.equal(release.update_seq, 2, 'pagehide release advances the active receipt sequence');
  assert.equal(release.claim_seq, 1, 'release identifies the claim it is retiring');

  const games = makeHarness('games', {
    sessionValues: chat.sessionValues,
    registrationRequiredOnce: true,
  });
  for (let index = 0; index < 8; index += 1) await flushTasks();
  const claims = games.requests.map((item) => JSON.parse(item.options.body || '{}'))
    .filter((body) => body.action === 'claim');
  assert.equal(claims[0].update_seq, 3, 'a new top-level mode continues the locally persisted sequence');
  assert.equal(claims[0].registration_receipt, release.registration_receipt);
  assert.equal(claims[1].registration_receipt, `${release.registration_receipt}-reissued`,
    'a release that arrives before the replacement claim forces a fresh registration');
  assert.equal(claims[1].update_seq, 1, 'a new receipt starts its own sequence');
  assert.equal(games.window.RenCrowPortalPresence.isReady(), true,
    'the replacement mode becomes ready only after its new claim is confirmed');
}

async function testSSEDisconnectClearsChatReadiness() {
  const harness = makeHarness('chat');
  await flushTasks();
  assert.equal(harness.elements.get('roomInput').disabled, false, 'Chat is ready after its presence claim');
  harness.eventSources[0].fail();
  assert.equal(harness.elements.get('roomInput').disabled, true, 'CORE event stream loss clears Chat readiness');
}

async function testOldClientIDWithoutLocalSequenceRotatesBeforeRegister() {
  const sessionValues = new Map([
    ['rencrow.portal.viewerClientID', 'client-with-lost-seq'],
    ['rencrow.portal.surfacePresenceV2', JSON.stringify({
      viewerClientID: 'client-with-lost-seq',
      protocolVersion: 2,
      runtimeEpoch: 'core-epoch-1',
      registrationReceipt: 'old-receipt',
    })],
  ]);
  const harness = makeHarness('chat', {sessionValues});
  await flushTasks();
  const register = harness.requests.map((item) => JSON.parse(item.options.body || '{}'))
    .find((body) => body.action === 'register');
  assert.notEqual(register.viewer_client_id, 'client-with-lost-seq',
    'a persisted client ID with missing local seq is replaced before register');
  assert.equal(sessionValues.get('rencrow.portal.viewerClientID'), register.viewer_client_id);
}

async function testIdleControlUsesMonotonicEpochRevisionAndGeneration() {
  const harness = makeHarness('idlechat');
  await flushTasks();
  const source = harness.eventSources[0];
  source.emit('message', {
    type: 'idlechat.message', message_id: 'idle-current', from: 'mio', visibility: 'public',
    content: '現在の台詞', runtime_epoch: 'core-epoch-1', playback_generation: 4,
  });
  assert.equal(harness.elements.get('chat').children.length, 1, 'current IdleChat output is rendered');

  source.emit('idlechat.control', idleControl({state_revision: 8, playback_generation: 5, playback_allowed: false}));
  assert.equal(harness.window.RenCrowPortalPresence.isReady(), false, 'a newer control snapshot blocks IdleChat');
  assert.equal(harness.elements.get('chat').children.length, 0, 'a new playback generation discards old IdleChat dialogue');
  source.emit('message', {
    type: 'idlechat.message', message_id: 'idle-old-generation', from: 'mio', visibility: 'public',
    content: '古い台詞', runtime_epoch: 'core-epoch-1', playback_generation: 4,
  });
  assert.equal(harness.elements.get('chat').children.length, 0, 'an old generation event is rejected');

  source.emit('idlechat.control', idleControl({state_revision: 9, playback_generation: 5, playback_allowed: true, playback_state: 'ready'}));
  assert.equal(harness.window.RenCrowPortalPresence.isReady(), true, 'a newer allowed snapshot restores current claimed IdleChat');
  source.emit('idlechat.control', idleControl({state_revision: 8, playback_generation: 4, playback_allowed: false}));
  assert.equal(harness.window.RenCrowPortalPresence.isReady(), true, 'an older control revision cannot change readiness');

  source.emit('idlechat.control', idleControl({state_revision: 10, playback_generation: 5, playback_allowed: false}));
  const heartbeat = harness.intervalTasks.filter((entry) => entry.active && entry.milliseconds === 10000).at(-1);
  heartbeat.callback();
  await flushTasks();
  assert.equal(harness.window.RenCrowPortalPresence.isReady(), false,
    'an older heartbeat response cannot restore readiness after a newer control revision');
}

async function testIdleEpochChangeAndSSEReconnectRequireFreshClaim() {
  const harness = makeHarness('idlechat');
  await flushTasks();
  const source = harness.eventSources[0];
  source.emit('message', {
    type: 'idlechat.message', message_id: 'idle-before-reset', from: 'mio', visibility: 'public',
    content: '切替前の台詞', runtime_epoch: 'core-epoch-1', playback_generation: 4,
  });
  harness.setRuntimeEpoch('core-epoch-2');
  source.emit('idlechat.control', idleControl({
    runtime_epoch: 'core-epoch-2', state_revision: 1, playback_generation: 1, playback_allowed: true, playback_state: 'ready',
  }));
  assert.equal(harness.window.RenCrowPortalPresence.isReady(), false, 'an epoch change clears ready synchronously');
  assert.equal(harness.elements.get('chat').children.length, 0, 'an epoch change discards local IdleChat dialogue');
  await flushTasks();
  assert.equal(harness.window.RenCrowPortalPresence.isReady(), true, 'the new epoch is ready only after register and claim');
  const requestsAfterEpochChange = harness.requests.map((item) => JSON.parse(item.options.body || '{}'));
  assert.deepEqual(requestsAfterEpochChange.slice(-2).map((body) => body.action), ['register', 'claim']);
  assert.equal(requestsAfterEpochChange.at(-1).runtime_epoch, 'core-epoch-2');

  source.fail();
  assert.equal(harness.window.RenCrowPortalPresence.isReady(), false, 'SSE disconnect clears readiness synchronously');
  assert.equal(harness.elements.get('chat').children.length, 0, 'SSE disconnect clears old IdleChat dialogue');
  source.open();
  assert.equal(harness.window.RenCrowPortalPresence.isReady(), false, 'SSE reconnect waits for a fresh claim');
  await flushTasks();
  const reconnectRequests = harness.requests.map((item) => JSON.parse(item.options.body || '{}')).slice(-2);
  assert.deepEqual(reconnectRequests.map((body) => body.action), ['register', 'claim']);
  assert.equal(harness.window.RenCrowPortalPresence.isReady(), true, 'SSE reconnect becomes ready after the new claim');
  source.emit('message', {
    type: 'idlechat.message', message_id: 'old-runtime-replay', from: 'mio', visibility: 'public',
    content: '旧runtimeの再送', runtime_epoch: 'core-epoch-1', playback_generation: 4,
  });
  assert.equal(harness.elements.get('chat').children.length, 0, 'old runtime replay is rejected after reconnect');
}

async function testTTSAsyncWorkIsFencedBeforeAudioLoadPlayAndAck() {
  const harness = makeHarness('chat');
  await flushTasks();
  harness.elements.get('roomAudioBtn').dispatch('click');
  await flushTasks();
  assert.equal(harness.elements.get('roomAudioBtn').getAttribute('aria-pressed'), 'true', 'TTS is enabled for the fixture');
  const source = harness.eventSources[0];
  const chunk = {
    type: 'tts.audio_chunk', channel: 'chat', session_id: 'chat-session-1',
    runtime_epoch: 'core-epoch-1', playback_generation: 4,
    content: JSON.stringify({
      session_id: 'chat-session-1', response_id: 'response-1', utterance_id: 'utterance-1',
      chunk_index: 0, audio_url: 'https://audio.invalid/chunk.wav', runtime_epoch: 'core-epoch-1', playback_generation: 4,
    }),
  };
  source.emit('message', chunk);
  source.emit('message', {
    type: 'tts.session_completed', channel: 'chat', session_id: 'chat-session-1',
    runtime_epoch: 'core-epoch-1', playback_generation: 4,
    content: JSON.stringify({session_id: 'chat-session-1', response_id: 'response-1', runtime_epoch: 'core-epoch-1', playback_generation: 4}),
  });
  await flushTasks();
  assert.equal(harness.audioInstances.length, 0, 'audio is not created before the fetch result is current');
  assert.equal(harness.pendingAudioFetches.length, 1, 'current audio is fetched through the existing audio endpoint');

  source.emit('idlechat.control', idleControl({state_revision: 8, playback_generation: 5, playback_allowed: false}));
  harness.pendingAudioFetches[0].resolve();
  await flushTasks();
  assert.equal(harness.audioInstances.length, 0, 'a stale audio fetch result is discarded before creating audio');
  assert.equal(harness.requests.some((item) => item.url.includes('/viewer/tts/playback-ack')), false,
    'a stale TTS completion does not ACK the replacement generation');
}

async function testTTSPlayPromiseCannotCompleteOrAckAfterGenerationChange() {
  const harness = makeHarness('chat');
  await flushTasks();
  harness.elements.get('roomAudioBtn').dispatch('click');
  await flushTasks();
  harness.deferNextAudioPlay();
  const source = harness.eventSources[0];
  source.emit('message', {
    type: 'tts.audio_chunk', channel: 'chat', session_id: 'chat-session-play',
    runtime_epoch: 'core-epoch-1', playback_generation: 4,
    content: JSON.stringify({
      session_id: 'chat-session-play', response_id: 'response-play', utterance_id: 'utterance-play',
      chunk_index: 0, audio_url: 'https://audio.invalid/chunk.wav', runtime_epoch: 'core-epoch-1', playback_generation: 4,
    }),
  });
  await flushTasks();
  assert.equal(harness.pendingAudioFetches.length, 1, 'the current audio request is pending');
  harness.pendingAudioFetches[0].resolve();
  await flushTasks();
  const audio = harness.audioInstances[0];
  assert.ok(audio && audio.playCount === 1, 'the audio play promise is pending');
  source.emit('message', {
    type: 'tts.session_completed', channel: 'chat', session_id: 'chat-session-play',
    runtime_epoch: 'core-epoch-1', playback_generation: 4,
    content: JSON.stringify({session_id: 'chat-session-play', response_id: 'response-play', runtime_epoch: 'core-epoch-1', playback_generation: 4}),
  });
  source.emit('idlechat.control', idleControl({state_revision: 8, playback_generation: 5, playback_allowed: false}));
  harness.resolveAudioPlay(audio);
  audio.dispatch('ended');
  await flushTasks();
  assert.equal(audio.src, '', 'control invalidation synchronously detaches the old audio');
  assert.equal(harness.requests.some((item) => item.url.includes('/viewer/tts/playback-ack')), false,
    'an old play promise and ended event cannot ACK after generation change');
}

async function testPagehideStopsTTSBeforePresenceReleaseCompletes() {
  const harness = makeHarness('chat');
  await flushTasks();
  harness.elements.get('roomAudioBtn').dispatch('click');
  await flushTasks();
  const source = harness.eventSources[0];
  source.emit('message', {
    type: 'tts.audio_chunk', channel: 'chat', session_id: 'chat-session-hide',
    runtime_epoch: 'core-epoch-1', playback_generation: 4,
    content: JSON.stringify({
      session_id: 'chat-session-hide', response_id: 'response-hide', utterance_id: 'utterance-hide',
      chunk_index: 0, audio_url: 'https://audio.invalid/chunk.wav', runtime_epoch: 'core-epoch-1', playback_generation: 4,
    }),
  });
  await flushTasks();
  harness.pendingAudioFetches[0].resolve();
  await flushTasks();
  const audio = harness.audioInstances[0];
  assert.ok(audio && audio.playCount === 1, 'TTS is playing before pagehide');
  harness.window.dispatch('pagehide');
  assert.equal(audio.paused, true, 'pagehide pauses TTS synchronously before awaiting release');
  assert.equal(audio.src, '', 'pagehide detaches the active audio synchronously');
}

(async () => {
  await testChatUsesV2PresenceBeforeReadyAndSendsClaimReference();
  await testIdlePlaybackRequiresExplicitActionAndCarriesCurrentRevision();
  await testGamesActionsWaitForPresenceAndDisableAfterHeartbeatFailure();
  await testDelayedClaimAfterHideCannotRestoreReady();
  await testModeReplacementCarriesSequenceAndReRegistersAfterLateRelease();
  await testSSEDisconnectClearsChatReadiness();
  await testOldClientIDWithoutLocalSequenceRotatesBeforeRegister();
  await testIdleControlUsesMonotonicEpochRevisionAndGeneration();
  await testIdleEpochChangeAndSSEReconnectRequireFreshClaim();
  await testTTSAsyncWorkIsFencedBeforeAudioLoadPlayAndAck();
  await testTTSPlayPromiseCannotCompleteOrAckAfterGenerationChange();
  await testPagehideStopsTTSBeforePresenceReleaseCompletes();
  process.stdout.write('presence lifecycle tests passed\n');
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
