(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) {
    root.RenCrowOtherPresence = api;
    if (root.document && typeof root.fetch === 'function') {
      const client = api.createOtherPresence({
        document: root.document,
        window: root,
        fetch: root.fetch.bind(root),
      });
      root.RenCrowOtherPresenceClient = client;
      client.start();
    }
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const endpoint = '/api/other/viewer/surface-presence';
  const heartbeatIntervalMs = 10000;

  function createViewerClientID(windowObject) {
    const cryptoObject = windowObject && windowObject.crypto;
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
      return `portal-other-${cryptoObject.randomUUID()}`;
    }
    if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      cryptoObject.getRandomValues(bytes);
      return `portal-other-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
    }
    return `portal-other-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function createOtherPresence(options) {
    if (!options || !options.document || !options.window || typeof options.fetch !== 'function') {
      throw new TypeError('document, window, and fetch are required');
    }
    const documentObject = options.document;
    const windowObject = options.window;
    const fetchRequest = options.fetch;
    const requestURL = options.endpoint || endpoint;
    const viewerClientID = options.viewerClientID || createViewerClientID(windowObject);
    let state = null;
    let ready = false;
    let claimMayExist = false;
    let started = false;
    let generation = 0;
    let heartbeatTimer = null;
    let requestSequence = Promise.resolve();

    function isVisible() {
      return documentObject.visibilityState === 'visible';
    }

    function enqueue(work) {
      requestSequence = requestSequence.catch(() => {}).then(work).catch(() => {
        ready = false;
      });
      return requestSequence;
    }

    async function post(body, keepalive = false) {
      let response;
      try {
        response = await fetchRequest(requestURL, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body),
          keepalive,
        });
      } catch (cause) {
        const error = new Error('CORE surface presence request failed');
        error.cause = cause;
        throw error;
      }
      let payload;
      try {
        payload = await response.json();
      } catch (_) {
        payload = null;
      }
      if (!response.ok) {
        const error = new Error(`CORE surface presence returned HTTP ${response.status}`);
        error.status = response.status;
        error.code = payload && String(payload.error_code || payload.code || '');
        throw error;
      }
      return payload;
    }

    function validRegistration(response) {
      return response && response.ok === true && response.protocol_version === 2
        && typeof response.runtime_epoch === 'string' && response.runtime_epoch.trim() !== ''
        && typeof response.registration_receipt === 'string' && response.registration_receipt.trim() !== ''
        && Number.isSafeInteger(response.last_update_seq) && response.last_update_seq >= 0;
    }

    function validUpdate(response, request, currentState) {
      if (!response || response.ok !== true || response.protocol_version !== 2
        || response.runtime_epoch !== currentState.runtimeEpoch
        || response.registration_receipt !== currentState.registrationReceipt
        || response.accepted_update_seq !== request.update_seq) return false;
      if (request.action === 'claim') return response.current_claim_seq === request.update_seq;
      if (request.action === 'heartbeat') return response.current_claim_seq === request.claim_seq;
      return true;
    }

    async function register(currentGeneration) {
      const response = await post({
        protocol_version: 2,
        viewer_client_id: viewerClientID,
        action: 'register',
      });
      if (currentGeneration !== generation || !isVisible()) return false;
      if (!validRegistration(response)) throw new Error('CORE surface presence V2 registration response is invalid');

      const sameRegistration = state
        && state.runtimeEpoch === response.runtime_epoch
        && state.registrationReceipt === response.registration_receipt;
      if (!sameRegistration) {
        ready = false;
        claimMayExist = false;
      }
      state = {
        runtimeEpoch: response.runtime_epoch,
        registrationReceipt: response.registration_receipt,
        updateSeq: Math.max(sameRegistration ? state.updateSeq : 0, response.last_update_seq),
        claimSeq: sameRegistration ? state.claimSeq : 0,
      };
      return true;
    }

    async function update(action, currentGeneration, keepalive = false, allowRegistrationRefresh = true) {
      if (!state) return false;
      const currentState = state;
      const updateSeq = currentState.updateSeq + 1;
      if (!Number.isSafeInteger(updateSeq) || updateSeq <= currentState.updateSeq) {
        throw new Error('CORE surface presence update sequence is exhausted');
      }
      const request = {
        protocol_version: 2,
        viewer_client_id: viewerClientID,
        runtime_epoch: currentState.runtimeEpoch,
        registration_receipt: currentState.registrationReceipt,
        surface: 'other',
        action,
        update_seq: updateSeq,
      };
      if (action === 'heartbeat' || action === 'release') request.claim_seq = currentState.claimSeq;
      currentState.updateSeq = updateSeq;
      if (action === 'claim') {
        currentState.claimSeq = updateSeq;
        claimMayExist = true;
      }

      let response;
      try {
        response = await post(request, keepalive);
      } catch (error) {
        if (action === 'claim' && allowRegistrationRefresh
          && error.status === 409 && error.code === 'registration_required'
          && currentGeneration === generation && isVisible()) {
          state = null;
          claimMayExist = false;
          await register(currentGeneration);
          return update('claim', currentGeneration, false, false);
        }
        throw error;
      }
      if (action === 'release') claimMayExist = false;
      if (!validUpdate(response, request, currentState)) {
        if (response && response.runtime_epoch && response.runtime_epoch !== currentState.runtimeEpoch) {
          state = null;
          claimMayExist = false;
        }
        throw new Error('CORE surface presence V2 update response does not match the request');
      }
      if (currentGeneration !== generation || (action !== 'release' && !isVisible())) return false;
      if (action === 'claim' || action === 'heartbeat') ready = true;
      if (action === 'release') ready = false;
      return true;
    }

    async function claimVisible(currentGeneration) {
      ready = false;
      if (currentGeneration !== generation || !isVisible()) return;
      if (!await register(currentGeneration)) return;
      if (currentGeneration !== generation || !isVisible()) return;
      await update('claim', currentGeneration);
    }

    async function heartbeat(currentGeneration) {
      if (currentGeneration !== generation || !isVisible()) return;
      if (!ready || !claimMayExist || !state) {
        await claimVisible(currentGeneration);
        return;
      }
      try {
        await update('heartbeat', currentGeneration);
      } catch (error) {
        ready = false;
        if (error.status === 409 && currentGeneration === generation && isVisible()) {
          state = null;
          claimMayExist = false;
          await claimVisible(currentGeneration);
          return;
        }
        throw error;
      }
    }

    async function release(keepalive) {
      ready = false;
      if (!state || !claimMayExist) return;
      try {
        await update('release', generation, keepalive);
      } finally {
        claimMayExist = false;
      }
    }

    function onVisibilityChange() {
      generation += 1;
      const currentGeneration = generation;
      if (isVisible()) {
        enqueue(() => claimVisible(currentGeneration));
      } else {
        ready = false;
        enqueue(() => release(true));
      }
    }

    function onPageHide() {
      generation += 1;
      ready = false;
      enqueue(() => release(true));
    }

    function onPageShow(event) {
      if (!event || event.persisted !== true || !isVisible()) return;
      generation += 1;
      const currentGeneration = generation;
      enqueue(() => claimVisible(currentGeneration));
    }

    function onOnline() {
      if (!isVisible() || ready) return;
      generation += 1;
      const currentGeneration = generation;
      enqueue(() => claimVisible(currentGeneration));
    }

    function start() {
      if (started) return requestSequence;
      started = true;
      documentObject.addEventListener('visibilitychange', onVisibilityChange);
      windowObject.addEventListener('pagehide', onPageHide);
      windowObject.addEventListener('pageshow', onPageShow);
      windowObject.addEventListener('online', onOnline);
      heartbeatTimer = windowObject.setInterval(() => {
        if (!isVisible()) return;
        const currentGeneration = generation;
        enqueue(() => heartbeat(currentGeneration));
      }, heartbeatIntervalMs);
      if (isVisible()) enqueue(() => claimVisible(generation));
      return requestSequence;
    }

    function stop() {
      if (!started) return requestSequence;
      started = false;
      generation += 1;
      ready = false;
      documentObject.removeEventListener?.('visibilitychange', onVisibilityChange);
      windowObject.removeEventListener?.('pagehide', onPageHide);
      windowObject.removeEventListener?.('pageshow', onPageShow);
      windowObject.removeEventListener?.('online', onOnline);
      if (heartbeatTimer !== null) windowObject.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      enqueue(() => release(true));
      return requestSequence;
    }

    return {
      start,
      stop,
      whenSettled: () => requestSequence,
      state: () => state ? {...state} : null,
      get ready() { return ready; },
      viewerClientID,
    };
  }

  return {createOtherPresence};
});
