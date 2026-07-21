const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('cli supports explicit start and end commands plus menu mode', () => {
  assert.match(source, /const PID_FILE = '\/tmp\/super-dns\.pid';/);
  assert.match(source, /case 'start':/);
  assert.match(source, /case 'end':/);
  assert.match(source, /showMenu\(\);/);
});

test('service state falls back to process table when pid file is missing', () => {
  assert.match(source, /function findServiceProcessPid\(\)/);
  assert.match(source, /ps ax -o pid= -o command=/);
  assert.match(source, /command\.includes\(__filename\)/);
});

test('menu defaults to the action matching service state', () => {
  assert.match(source, /服务正在运行/);
  assert.match(source, /关闭服务/);
  assert.match(source, /服务未运行/);
  assert.match(source, /启动服务/);
});

test('service mode is separated from user-facing cli mode', () => {
  assert.match(source, /process\.env\.SUPER_DNS_SERVICE === '1'/);
  assert.match(source, /runService\(\);/);
  assert.doesNotMatch(source, /const domainRules = loadDomains\(DOMAINS_FILE\);/);
});

test('service log file is capped at 500 lines', () => {
  assert.match(source, /const LOG_MAX_LINES = 500;/);
  assert.match(source, /function installServiceLogger\(\)/);
  assert.match(source, /slice\(-LOG_MAX_LINES\)/);
  assert.match(source, /installServiceLogger\(\);/);
  assert.match(source, /> \/dev\/null 2>&1 < \/dev\/null &/);
});

test('upstream forwarding rewrites dns ids to avoid response cross-talk', () => {
  assert.match(source, /let nextUpstreamId = 1;/);
  assert.match(source, /allocateUpstreamId\(\)/);
  assert.match(source, /msg\.writeUInt16BE\(upstreamId, 0\)/);
  assert.match(source, /response\.writeUInt16BE\(entry\.clientDnsId, 0\)/);
  assert.doesNotMatch(source, /entry\.dnsId === dnsId/);
});
