const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('does not run a local dns proxy or pf redirect in hosts mode', () => {
  assert.doesNotMatch(source, /require\('dgram'\)/);
  assert.doesNotMatch(source, /createSocket/);
  assert.doesNotMatch(source, /server\.bind/);
  assert.doesNotMatch(source, /pfctl/);
  assert.doesNotMatch(source, /networksetup -setdnsservers/);
});

test('does not expose legacy root child cli control', () => {
  assert.doesNotMatch(source, /SUPER_DNS_SERVICE/);
  assert.match(source, /osascript/);
  assert.match(source, /with administrator privileges/);
});
