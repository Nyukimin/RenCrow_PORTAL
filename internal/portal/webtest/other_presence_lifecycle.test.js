'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {createOtherPresence} = require('../web/other_presence.js');

let generatedClientID = 0;

function makeHarness({deferClaim = false} = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const requests = [];
  const timers = [];
  let runtimeEpoch = 'core-epoch-1';
  let registrationReceipt = 'registration-core-epoch-1';
  let lastUpdateSeq = 0;
  let registrationRetired = false;
  let registrationRequiredNextHeartbeat = false;
  let pendingClaim = null;
  let failNextAction = null;

  const document = {
    visibilityState: 'visible',
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    dispatch(type, event = {}) {
      for (const listener of documentListeners.get(type) || []) listener({type, ...event});
    },
  };
  const window = {
    crypto: {randomUUID: () => `presence-${++generatedClientID}`},
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    dispatch(type, event = {}) {
      for (const listener of windowListeners.get(type) || []) listener({type, ...event});
    },
    setInterval(callback, milliseconds) {
      timers.push({callback, milliseconds, active: true});
      return timers.length;
    },
    clearInterval(id) {
      if (timers[id - 1]) timers[id - 1].active = false;
    },
  };

  function response(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }

  function updateResponse(body) {
    return {
      ok: true,
      protocol_version: 2,
      runtime_epoch: body.runtime_epoch,
      registration_receipt: body.registration_receipt,
      accepted_update_seq: body.update_seq,
      current_claim_seq: body.action === 'claim' ? body.update_seq : body.claim_seq,
      state_revision: body.update_seq + 100,
      playback_generation: 1,
      foreground_ready: true,
    };
  }

  const fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    const entry = {url: String(url), options, body};
    requests.push(entry);
    assert.equal(entry.url, '/api/other/viewer/surface-presence');
    assert.equal(options.method, 'POST');

    if (failNextAction === body.action) {
      failNextAction = null;
      return response({ok: false, protocol_version: 2, error_code: 'disconnected'}, 503);
    }
    if (body.action === 'heartbeat' && registrationRequiredNextHeartbeat) {
      registrationRequiredNextHeartbeat = false;
      return response({ok: false, protocol_version: 2, error_code: 'registration_required'}, 409);
    }
    if (body.action === 'register') {
      if (registrationRetired) {
        registrationReceipt += '-renewed';
        lastUpdateSeq = 0;
        registrationRetired = false;
      }
      return response({
        ok: true,
        protocol_version: 2,
        runtime_epoch: runtimeEpoch,
        registration_receipt: registrationReceipt,
        last_update_seq: lastUpdateSeq,
      });
    }
    const complete = () => {
      lastUpdateSeq = body.update_seq;
      if (body.action === 'release') registrationRetired = true;
      return response(updateResponse(body));
    };
    if (body.action === 'claim' && deferClaim) {
      return new Promise((resolve) => { pendingClaim = () => resolve(complete()); });
    }
    return complete();
  };

  function runTimer() {
    const timer = timers.find((candidate) => candidate.active);
    assert.equal(timer?.milliseconds, 10000, 'a visible presence heartbeat is scheduled every 10 seconds');
    timer.callback();
  }

  function restartCore() {
    runtimeEpoch = 'core-epoch-2';
    registrationReceipt = 'registration-core-epoch-2';
    lastUpdateSeq = 0;
    registrationRequiredNextHeartbeat = true;
  }

  return {
    document,
    window,
    fetch,
    requests,
    timers,
    runTimer,
    restartCore,
    get pendingClaim() { return pendingClaim; },
    failNext(action) { failNextAction = action; },
  };
}

test('visible other surface registers, claims, heartbeats, releases, and re-registers in sequence', async () => {
  const harness = makeHarness();
  const presence = createOtherPresence(harness);

  await presence.start();
  assert.equal(presence.ready, true);
  assert.deepEqual(harness.requests.map((request) => request.body.action), ['register', 'claim']);
  assert.equal(harness.requests[1].body.surface, 'other');
  assert.equal(harness.requests[1].body.update_seq, 1);

  harness.runTimer();
  await presence.whenSettled();
  assert.equal(harness.requests.at(-1).body.action, 'heartbeat');
  assert.equal(harness.requests.at(-1).body.update_seq, 2);
  assert.equal(harness.requests.at(-1).body.claim_seq, 1);

  harness.document.visibilityState = 'hidden';
  harness.document.dispatch('visibilitychange');
  await presence.whenSettled();
  assert.equal(presence.ready, false);
  assert.equal(harness.requests.at(-1).body.action, 'release');
  assert.equal(harness.requests.at(-1).body.update_seq, 3);

  harness.document.visibilityState = 'visible';
  harness.document.dispatch('visibilitychange');
  await presence.whenSettled();
  assert.deepEqual(harness.requests.slice(-2).map((request) => request.body.action), ['register', 'claim']);
  assert.equal(harness.requests.at(-1).body.update_seq, 1);
  assert.equal(presence.ready, true);
});

test('connection failure drops ready and the next visible tick re-registers', async () => {
  const harness = makeHarness();
  const presence = createOtherPresence(harness);
  await presence.start();
  harness.failNext('heartbeat');

  harness.runTimer();
  await presence.whenSettled();
  assert.equal(presence.ready, false);

  harness.restartCore();
  harness.runTimer();
  await presence.whenSettled();
  assert.deepEqual(harness.requests.slice(-2).map((request) => request.body.action), ['register', 'claim']);
  assert.equal(presence.state().runtimeEpoch, 'core-epoch-2');
  assert.equal(presence.ready, true);
});

test('pagehide releases with keepalive and a late claim cannot restore ready', async () => {
  const harness = makeHarness({deferClaim: true});
  const presence = createOtherPresence(harness);
  const start = presence.start();
  await new Promise(setImmediate);
  assert.equal(typeof harness.pendingClaim, 'function');

  harness.document.visibilityState = 'hidden';
  harness.document.dispatch('visibilitychange');
  harness.window.dispatch('pagehide');
  harness.pendingClaim();
  await start;
  await presence.whenSettled();

  assert.equal(presence.ready, false);
  const release = harness.requests.filter((request) => request.body.action === 'release');
  assert.equal(release.length, 1);
  assert.equal(release[0].options.keepalive, true);
});

test('CORE restart rejection re-registers against the new runtime epoch', async () => {
  const harness = makeHarness();
  const presence = createOtherPresence(harness);
  await presence.start();
  harness.restartCore();

  harness.runTimer();
  await presence.whenSettled();
  assert.deepEqual(harness.requests.slice(-3).map((request) => request.body.action), ['heartbeat', 'register', 'claim']);
  assert.equal(presence.state().runtimeEpoch, 'core-epoch-2');
  assert.equal(presence.ready, true);
});

test('restoring a page from the back-forward cache registers and claims again', async () => {
  const harness = makeHarness();
  const presence = createOtherPresence(harness);
  await presence.start();
  harness.document.visibilityState = 'hidden';
  harness.document.dispatch('visibilitychange');
  await presence.whenSettled();

  harness.document.visibilityState = 'visible';
  harness.window.dispatch('pageshow', {persisted: true});
  await presence.whenSettled();
  assert.deepEqual(harness.requests.slice(-2).map((request) => request.body.action), ['register', 'claim']);
  assert.equal(presence.ready, true);
});

test('separate page instances receive different viewer client IDs', () => {
  const first = createOtherPresence(makeHarness());
  const second = createOtherPresence(makeHarness());
  assert.notEqual(first.viewerClientID, second.viewerClientID);
});
