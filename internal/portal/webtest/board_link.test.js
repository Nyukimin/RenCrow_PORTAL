'use strict';

// An explicit BOARD URL is visible everywhere; the unset fallback is local-only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = process.env.PORTAL_JS_SOURCE || path.join(__dirname, '..', 'web', 'portal.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const functionStart = source.indexOf('  function initializeBoardLink() {');
assert.notEqual(functionStart, -1, 'portal.js must define initializeBoardLink');
const functionEnd = source.indexOf('\n  }', functionStart);
assert.notEqual(functionEnd, -1, 'initializeBoardLink must close at the expected scope');
const initializeBoardLinkSource = source.slice(functionStart, functionEnd + 4);
assert.match(source, /^\s+initializeBoardLink\(\);$/m, 'portal.js must run initializeBoardLink during startup');
assert.doesNotMatch(initializeBoardLinkSource, /boardLink\.href\s*=/, 'portal.js must not derive or rewrite the BOARD URL');

const fallbackCases = [
  ['localhost', false],
  ['127.0.0.1', false],
  ['[::1]', false],
  ['portal.example', true],
  ['localhost.example', true],
  ['notlocalhost', true],
  ['127.0.0.1.example', true],
  ['::1', true],
];

for (const [hostname, expectedHidden] of fallbackCases) {
  const href = 'http://127.0.0.1:18792/';
  const link = {hidden: true, href, dataset: {boardUrlConfigured: 'false'}};
  const sandbox = {window: {location: {hostname}}, document: {getElementById: () => link}};
  vm.runInNewContext(`${initializeBoardLinkSource}\ninitializeBoardLink()`, sandbox, {filename: sourcePath});
  assert.equal(link.hidden, expectedHidden, `fallback hidden state for hostname=${hostname}`);
  assert.equal(link.href, href, `fallback href must remain fixed for hostname=${hostname}`);
}

for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'portal.example']) {
  const href = 'https://macbook-pro.tailb07d8d.ts.net:8443/';
  const link = {hidden: false, href, dataset: {boardUrlConfigured: 'true'}};
  const sandbox = {window: {location: {hostname}}, document: {getElementById: () => link}};
  vm.runInNewContext(`${initializeBoardLinkSource}\ninitializeBoardLink()`, sandbox, {filename: sourcePath});
  assert.equal(link.hidden, false, `configured BOARD URL must remain visible for hostname=${hostname}`);
  assert.equal(link.href, href, `configured BOARD URL must remain unchanged for hostname=${hostname}`);
}

console.log('BOARD configured and local fallback link visibility passed');
