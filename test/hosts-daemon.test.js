const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('runs directly as a daemon without cli start end or menu commands', () => {
  assert.doesNotMatch(source, /case 'end':/);
});

test('supports start stop restart commands and an already-running menu', () => {
  assert.match(source, /case 'start':/);
  assert.match(source, /case 'stop':/);
  assert.match(source, /case 'restart':/);
  assert.match(source, /function showRunningMenu\(\)/);
  assert.match(source, /重启/);
  assert.match(source, /关闭/);
  assert.match(source, /退出/);
});

test('prints a colored running summary before the running menu', () => {
  assert.match(source, /function color\(/);
  assert.match(source, /function getDomainSummary\(\)/);
  assert.match(source, /function printRunningSummary\(/);
  assert.match(source, /程序正在运行/);
  assert.match(source, /正在监控/);
  assert.match(source, /更新频率/);
  assert.match(source, /green: '\\x1b\[32m'/);
  assert.match(source, /red: '\\x1b\[31m'/);
  assert.match(source, /yellow: '\\x1b\[33m'/);
});

test('prevents multiple instances of the same program', () => {
  assert.match(source, /function ensureSingleInstance\(\)/);
  assert.match(source, /已经在运行了/);
  assert.match(source, /ps ax -o pid= -o user= -o command=/);
});

test('maintains a bounded log file at the original path', () => {
  assert.match(source, /const LOG_FILE = '\/tmp\/super-dns\.log';/);
  assert.match(source, /const LOG_MAX_LINES = 500;/);
  assert.match(source, /function installLogger\(\)/);
  assert.match(source, /slice\(-LOG_MAX_LINES\)/);
  assert.match(source, /originalLog\.apply\(console, args\)/);
  assert.match(source, /originalError\.apply\(console, args\)/);
  assert.match(source, /process\.stderr\.write/);
});

test('checks root before enabling file logging', () => {
  assert.match(source, /ensureSingleInstance\(\);\n  ensureRootUser\(\);\n  installLogger\(\);/);
});

test('manages only its own hosts block', () => {
  assert.match(source, /const HOSTS_FILE = '\/etc\/hosts';/);
  assert.match(source, /const HOSTS_BEGIN = '# BEGIN super-dns';/);
  assert.match(source, /const HOSTS_END = '# END super-dns';/);
  assert.match(source, /function updateHostsBlock/);
  assert.match(source, /function removeHostsBlock/);
});

test('deduplicates managed domains outside the hosts block before writing', () => {
  assert.match(source, /function stripManagedDomainLines/);
  assert.match(source, /stripManagedDomainLines\(stripHostsBlock\(existing\), records\.keys\(\)\)/);
  assert.match(source, /保留注释行/);
});

test('polls doh every 300 seconds and reacts to domain file changes', () => {
  assert.match(source, /const POLL_INTERVAL_MS = parseInt\(process\.env\.POLL_INTERVAL \|\| '300000', 10\);/);
  assert.match(source, /setInterval\(runUpdateCycle, POLL_INTERVAL_MS\)/);
  assert.match(source, /fs\.watchFile\(DOMAINS_FILE/);
});

test('flushes local dns cache after hosts changes', () => {
  assert.match(source, /function flushDnsCache\(\)/);
  assert.match(source, /dscacheutil -flushcache/);
  assert.match(source, /killall -HUP mDNSResponder/);
});

test('removes managed hosts records when the daemon stops', () => {
  assert.match(source, /function shutdown\(signal\)/);
  assert.match(source, /process\.on\('SIGINT', \(\) => shutdown\('SIGINT'\)\)/);
  assert.match(source, /process\.on\('SIGTERM', \(\) => shutdown\('SIGTERM'\)\)/);
  assert.match(source, /if \(removeHostsBlock\(\)\) flushDnsCache\(\);/);
});

test('uses doh to resolve exact domains and skips wildcard hosts entries', () => {
  assert.match(source, /function dohQuery/);
  assert.match(source, /dohQuery\(domain, 'A'\)/);
  assert.match(source, /dohQuery\(domain, 'AAAA'\)/);
  assert.match(source, /A: 1/);
  assert.match(source, /AAAA: 28/);
  assert.match(source, /net\.isIP\(answer\.data\) === ipVersion/);
  assert.match(source, /wildcard/);
  assert.match(source, /跳过通配符/);
  assert.match(source, /exactDomains/);
});

test('writes both ipv4 and ipv6 records to hosts', () => {
  assert.match(source, /Promise\.all\(\[\s*dohQuery\(domain, 'A'\),\s*dohQuery\(domain, 'AAAA'\)\s*\]\)/);
  assert.match(source, /const ips = uniqueIps\(\[\.\.\.ipv4, \.\.\.ipv6\]\)/);
  assert.match(source, /for \(const ip of ips\) {\n      lines\.push\(`\$\{ip\} \$\{domain\}`\);/);
});

test('prints startup status including root identity and loaded domains', () => {
  assert.match(source, /root 身份确认/);
  assert.match(source, /配置文件:/);
  assert.match(source, /精确域名列表:/);
  assert.match(source, /通配符域名列表/);
  assert.match(source, /开始执行 DoH 更新/);
});
