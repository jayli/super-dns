const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('dns server binds the system resolver endpoint directly', () => {
  assert.match(source, /const PORT = parseInt\(process\.env\.PORT \|\| '53', 10\);/);
  assert.match(source, /const HOST = process\.env\.HOST \|\| '127\.0\.0\.1';/);
});

test('direct listener does not depend on pf loopback rdr', () => {
  assert.doesNotMatch(source, /PF_ANCHOR/);
  assert.doesNotMatch(source, /setupSystemDnsRedirect/);
  assert.doesNotMatch(source, /pfctl -a/);
});

test('administrator launcher backgrounds the root child without nohup', () => {
  assert.doesNotMatch(source, /nohup/);
  assert.match(source, /> \/dev\/null 2>&1 < \/dev\/null &/);
});
