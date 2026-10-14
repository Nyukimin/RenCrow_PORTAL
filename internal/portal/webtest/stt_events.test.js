'use strict';
// Behavior test for web/stt_events.js. Run by the Go test TestSTTEventsDecisionTable
// (internal/portal/stt_events_test.go); needs only Node.js, no npm packages.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'web', 'stt_events.js');
const {classifySTTMessage, describeSTTClose} = require(sourcePath);

let failures = 0;
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures += 1;
    console.error(`[NG] ${name}\n${error && error.stack || error}`);
    return;
  }
  console.log(`[OK] ${name}`);
}

check('error with utterance_id fails only that utterance', () => {
  const event = classifySTTMessage({type: 'error', utterance_id: 'u-1', code: 'stt_busy', error: 'too many utterances', seq: 5});
  assert.deepEqual(event, {kind: 'utterance_error', detail: 'stt_busy: too many utterances'});
});

check('error without utterance_id is session-level', () => {
  const event = classifySTTMessage({type: 'error', code: 'unsupported_audio_format', error: 'bad format', seq: 2});
  assert.deepEqual(event, {kind: 'session_error', detail: 'unsupported_audio_format: bad format'});
});

check('blank, null or missing utterance_id is session-level', () => {
  for (const id of [undefined, null, '', '   ']) {
    assert.equal(classifySTTMessage({type: 'error', utterance_id: id, error: 'x'}).kind, 'session_error', JSON.stringify(id));
  }
});

check('numeric utterance_id counts as an utterance id', () => {
  assert.equal(classifySTTMessage({type: 'error', utterance_id: 7, error: 'x'}).kind, 'utterance_error');
  assert.equal(classifySTTMessage({type: 'error', utterance_id: 0, error: 'x'}).kind, 'utterance_error');
});

check('error detail falls back to message, code, then unknown', () => {
  assert.equal(classifySTTMessage({type: 'error', message: 'm'}).detail, 'm');
  assert.equal(classifySTTMessage({type: 'error', code: 'c'}).detail, 'c');
  assert.equal(classifySTTMessage({type: 'ERROR'}).detail, 'unknown');
  assert.equal(classifySTTMessage({type: 'ERROR'}).kind, 'session_error');
});

check('final with any end_reason is an ordinary final', () => {
  const reasons = ['stop', 'max_length', 'idle_timeout', 'restart', 'silence', 'future_reason', '', 123, null, undefined, {a: 1}];
  for (const endReason of reasons) {
    const event = classifySTTMessage({type: 'final', utterance_id: 'u-1', text: ' こんにちは ', end_reason: endReason, audio_ms: 900});
    assert.deepEqual(event, {kind: 'final', text: 'こんにちは'}, `end_reason=${JSON.stringify(endReason)}`);
  }
  assert.deepEqual(classifySTTMessage({type: 'final', text: 'no end_reason'}), {kind: 'final', text: 'no end_reason'});
  assert.deepEqual(classifySTTMessage({type: 'final', transcript: 'by transcript'}), {kind: 'final', text: 'by transcript'});
});

check('empty final and cancelled are ignored whatever end_reason says', () => {
  assert.equal(classifySTTMessage({type: 'final', text: '', end_reason: 'silence', empty_reason: 'silent'}).kind, 'ignore');
  assert.equal(classifySTTMessage({type: 'final', text: '   ', end_reason: 'future_reason'}).kind, 'ignore');
  assert.equal(classifySTTMessage({type: 'cancelled', utterance_id: 'u-1', end_reason: 'silence'}).kind, 'ignore');
});

check('draft and partial show text only when there is some', () => {
  assert.deepEqual(classifySTTMessage({type: 'draft', text: 'abc'}), {kind: 'draft', text: 'abc'});
  assert.deepEqual(classifySTTMessage({type: 'partial', utterance_id: 'u-1', text: 'abc', seq: 3}), {kind: 'draft', text: 'abc'});
  assert.equal(classifySTTMessage({type: 'partial', text: ''}).kind, 'ignore');
});

check('lifecycle and unknown events are ignored', () => {
  for (const type of ['session_info', 'ready', 'speech_start', 'something_new', '']) {
    assert.equal(classifySTTMessage({type, utterance_id: 'u-1'}).kind, 'ignore', type);
  }
});

check('non-object payloads are ignored', () => {
  for (const payload of [null, undefined, 'error', 42, true, []]) {
    assert.equal(classifySTTMessage(payload).kind, 'ignore', JSON.stringify(payload));
  }
});

check('normal close codes add no suffix', () => {
  assert.equal(describeSTTClose({code: 1000, reason: ''}), 'STT接続が終了しました');
  assert.equal(describeSTTClose({code: 1005}), 'STT接続が終了しました');
  assert.equal(describeSTTClose(undefined, ''), 'STT接続が終了しました');
  assert.equal(describeSTTClose({}, null), 'STT接続が終了しました');
});

check('abnormal close reports code, reason and the last utterance error', () => {
  assert.equal(describeSTTClose({code: 1006}), 'STT接続が終了しました（close code 1006）');
  assert.equal(describeSTTClose({code: 1011, reason: 'server error'}), 'STT接続が終了しました（server error、close code 1011）');
  assert.equal(
    describeSTTClose({code: 1000}, 'stt_limit_exceeded: too many pending'),
    'STT接続が終了しました（直前のエラー stt_limit_exceeded: too many pending）',
  );
});

check('browser global is published and module.exports is not required there', () => {
  const sandbox = {window: {}};
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), sandbox, {filename: sourcePath});
  const api = sandbox.window.RenCrowSTTEvents;
  assert.equal(typeof api.classifySTTMessage, 'function');
  assert.equal(typeof api.describeSTTClose, 'function');
  assert.equal(api.classifySTTMessage({type: 'error', utterance_id: 'u'}).kind, 'utterance_error');
});

if (failures > 0) {
  console.error(`[NG] ${failures} check(s) failed`);
  process.exit(1);
}
console.log('[OK] all checks passed');
