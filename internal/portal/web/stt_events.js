// Chat microphone (STT) event decisions for the CORE WS /stt stream (protocol utterance.v1).
//
// Pure functions only: no DOM, timers or network. portal.js applies the effects
// (microphone, input right, status line); this file only decides which effect an
// event calls for, so the decision table can be tested without a browser.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.RenCrowSTTEvents = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // An event that carries an utterance_id belongs to one utterance.
  function hasUtteranceID(payload) {
    const id = payload.utterance_id;
    return id !== undefined && id !== null && String(id).trim() !== '';
  }

  // "code: message", or whichever of the two exists.
  function describeSTTError(payload) {
    const code = String(payload.code || '').trim();
    const text = String(payload.error || payload.message || '').trim();
    if (code && text) return `${code}: ${text}`;
    return code || text || 'unknown';
  }

  // classifySTTMessage maps one parsed WS event to the effect portal.js must apply.
  //   draft / partial   {kind: 'draft', text}            show the text in the input
  //   final with text   {kind: 'final', text}            put the text in the input and send it
  //   error + utterance {kind: 'utterance_error', detail} that utterance failed; the microphone keeps running
  //   error, no id      {kind: 'session_error', detail}   the session is unusable; stop the microphone
  //   anything else     {kind: 'ignore'}                  ready, speech_start, cancelled, empty final, unknown types
  // end_reason and empty_reason are deliberately not inspected: a value added later
  // (for example "silence") is an ordinary final.
  function classifySTTMessage(payload) {
    if (!payload || typeof payload !== 'object') return {kind: 'ignore'};
    const type = String(payload.type || '').toLowerCase();
    const text = String(payload.text || payload.transcript || '').trim();
    if (type === 'draft' || type === 'partial') return text ? {kind: 'draft', text} : {kind: 'ignore'};
    if (type === 'final') return text ? {kind: 'final', text} : {kind: 'ignore'};
    if (type === 'error') {
      const detail = describeSTTError(payload);
      return hasUtteranceID(payload) ? {kind: 'utterance_error', detail} : {kind: 'session_error', detail};
    }
    return {kind: 'ignore'};
  }

  // describeSTTClose builds the status text for a connection that ended while the
  // microphone was on. lastUtteranceError is the last utterance error of the
  // connection (CORE reports stt_limit_exceeded per utterance, then closes).
  function describeSTTClose(closeEvent, lastUtteranceError) {
    const parts = [];
    const lastError = String(lastUtteranceError || '').trim();
    if (lastError) parts.push(`直前のエラー ${lastError}`);
    const reason = String(closeEvent && closeEvent.reason || '').trim();
    if (reason) parts.push(reason);
    const code = closeEvent ? closeEvent.code : undefined;
    if (typeof code === 'number' && Number.isInteger(code) && code !== 1000 && code !== 1005) {
      parts.push(`close code ${code}`);
    }
    return parts.length ? `STT接続が終了しました（${parts.join('、')}）` : 'STT接続が終了しました';
  }

  return {classifySTTMessage, describeSTTClose};
});
