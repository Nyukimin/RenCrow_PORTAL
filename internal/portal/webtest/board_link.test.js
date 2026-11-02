'use strict';

// The internal BOARD link is visible only when the browser opens PORTAL locally.

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

const cases = [
  ['localhost', true],
  ['127.0.0.1', true],
  ['[::1]', true],
  ['portal.example', false],
  ['localhost.example', false],
  ['notlocalhost', false],
  ['127.0.0.1.example', false],
  ['::1', false],
];

for (const [hostname, expectedVisible] of cases) {
  const link = {hidden: true};
  const sandbox = {
    window: {location: {hostname}},
    document: {
      getElementById(id) {
        assert.equal(id, 'roomBoardLink');
        return link;
      },
    },
  };
  vm.runInNewContext(`${initializeBoardLinkSource}\ninitializeBoardLink()`, sandbox, {filename: sourcePath});
  assert.equal(link.hidden, !expectedVisible, `hostname=${hostname}`);
}

console.log('BOARD local link visibility passed');
