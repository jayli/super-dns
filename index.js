#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');
const net = require('net');
const { execSync } = require('child_process');

const DOH_BASE = process.env.DOH_BASE || 'https://dns.alidns.com/resolve';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL || '300000', 10);
const USER_HOME = process.env.SUPER_DNS_HOME || (process.env.SUDO_USER ? `/Users/${process.env.SUDO_USER}` : os.homedir());
const CONFIG_DIR = path.join(USER_HOME, '.config', 'super-dns');
const DOMAINS_FILE = path.join(CONFIG_DIR, 'domains');
const HOSTS_FILE = '/etc/hosts';
const HOSTS_BEGIN = '# BEGIN super-dns';
const HOSTS_END = '# END super-dns';
const LOG_FILE = '/tmp/super-dns.log';
const LOG_MAX_LINES = 500;

let exactDomains = [];
let wildcardDomains = [];
let currentHosts = new Map();
let updateInFlight = false;
let shuttingDown = false;

const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m'
};

function color(name, text) {
  if (!process.stdout.isTTY) return text;
  return `${COLORS[name] || ''}${text}${COLORS.reset}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function appleScriptQuote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function writeBoundedLog(line) {
  let lines = [];
  try {
    lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
  } catch (_) {
    lines = [];
  }

  lines.push(line);
  try {
    fs.writeFileSync(LOG_FILE, `${lines.slice(-LOG_MAX_LINES).join('\n')}\n`);
  } catch (e) {
    process.stderr.write(`${line}\n`);
    process.stderr.write(`[super-dns] 写日志失败: ${e.message}\n`);
  }
}

function installLogger() {
  const originalLog = console.log;
  const originalError = console.error;
  const teeToConsole = !process.env.SUPER_DNS_LAUNCH_ID;

  const write = (level, args) => {
    const text = util.format(...args);
    const stamp = new Date().toISOString();
    for (const line of text.split('\n')) {
      writeBoundedLog(`${stamp} ${level} ${line}`);
    }
  };

  console.log = (...args) => {
    if (teeToConsole) originalLog.apply(console, args);
    write('INFO', args);
  };

  console.error = (...args) => {
    if (teeToConsole) originalError.apply(console, args);
    write('ERROR', args);
  };
}

function ensureSingleInstance() {
  const pid = findRootDaemonPid();
  if (!pid) return;

  process.stdout.write('已经在运行了\n');
  process.exit(0);
}

function findRootDaemonPid() {
  let out = '';
  try {
    out = execSync('ps ax -o pid= -o user= -o command=', { encoding: 'utf-8', timeout: 5000 });
  } catch (_) {
    return null;
  }

  const self = path.resolve(__filename);
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;

    const pid = parseInt(match[1], 10);
    const user = match[2];
    const command = match[3];
    if (pid === process.pid) continue;
    if (user !== 'root') continue;
    if (!command.includes('node')) continue;
    if (command.includes(self) || command.includes(__filename)) {
      return pid;
    }
  }

  return null;
}

function isRootUser() {
  try {
    return Boolean(process.getuid && process.getuid() === 0);
  } catch (_) {
    return true;
  }
}

function readDomainSummary() {
  try {
    if (!fs.existsSync(DOMAINS_FILE)) {
      return { exact: [], wildcard: [], error: null };
    }

    const exact = [];
    const wildcard = [];
    const seen = new Set();
    const lines = fs.readFileSync(DOMAINS_FILE, 'utf-8')
      .split('\n')
      .map(line => line.split('#')[0].trim().toLowerCase())
      .filter(Boolean);

    for (const line of lines) {
      if (seen.has(line)) continue;
      seen.add(line);
      if (line.startsWith('*.')) wildcard.push(line);
      else exact.push(line);
    }

    return { exact, wildcard, error: null };
  } catch (e) {
    return { exact: [], wildcard: [], error: e.message };
  }
}

function getDomainSummary() {
  const summary = readDomainSummary();
  return {
    ...summary,
    monitoredCount: summary.exact.length,
    skippedWildcardCount: summary.wildcard.length,
    intervalSeconds: POLL_INTERVAL_MS / 1000
  };
}

function hasRecentError(lines = 80) {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8').trimEnd();
    if (!content) return false;
    return content.split('\n').slice(-lines).some(line => /\bERROR\b|\[!\]/.test(line));
  } catch (_) {
    return false;
  }
}

function printRunningSummary(pid) {
  const summary = getDomainSummary();
  const hasError = hasRecentError();

  console.log(color('green', `程序正在运行: PID ${pid}`));
  console.log(`正在监控: ${color('cyan', String(summary.monitoredCount))} 个精确域名`);
  console.log(`更新频率: ${color('cyan', `${summary.intervalSeconds}s`)}`);
  console.log(`配置文件: ${DOMAINS_FILE}`);
  console.log(`详细日志: ${LOG_FILE}`);

  if (summary.skippedWildcardCount > 0) {
    console.log(color('yellow', `通配符域名 ${summary.skippedWildcardCount} 个，hosts 模式不会写入`));
  }

  if (summary.error) {
    console.log(color('red', `程序有错误: 读取 domains 失败: ${summary.error}`));
  } else if (hasError) {
    console.log(color('yellow', '程序有错误: 最近日志包含错误或告警，请查看详细日志'));
  } else {
    console.log(color('green', '程序状态: 未发现最近错误'));
  }
}

function readRecentLog(lines = 80) {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8').trimEnd();
    if (!content) return '';
    return content.split('\n').slice(-lines).join('\n');
  } catch (e) {
    return `[!] 读取日志失败: ${e.message}`;
  }
}

function readLogFromLaunch(launchId) {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8').trimEnd();
    if (!content) return '';

    const lines = content.split('\n');
    const markerIndex = lines.findLastIndex(line => line.includes(`SUPER_DNS_LAUNCH_ID=${launchId}`));
    if (markerIndex === -1) return '';
    return lines.slice(markerIndex).join('\n');
  } catch (_) {
    return '';
  }
}

function waitForLaunchSummary(launchId) {
  const deadline = Date.now() + 20000;
  let latest = '';

  while (Date.now() < deadline) {
    latest = readLogFromLaunch(launchId);
    if (latest.includes('监控开始运行') || latest.includes('[!] 启动失败')) return latest;

    try {
      execSync('sleep 0.2', { timeout: 1000 });
    } catch (_) {
      return latest;
    }
  }

  return latest;
}

function formatLaunchSummary(text) {
  return text
    .split('\n')
    .map(line => line.replace(/^\d{4}-\d{2}-\d{2}T\S+Z (INFO|ERROR) /, ''))
    .filter(line => !line.includes('SUPER_DNS_LAUNCH_ID='))
    .map(line => {
      if (line.includes('程序已经启动') || line.includes('开始执行 DoH 更新') || line.includes('监控开始运行')) {
        return color('green', line);
      }
      return line;
    })
    .join('\n')
    .trim();
}

function waitForRootDaemon() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pid = findRootDaemonPid();
    if (pid) return pid;

    try {
      execSync('sleep 0.2', { timeout: 1000 });
    } catch (_) {
      return null;
    }
  }

  return null;
}

function launchWithAdministratorDialog() {
  console.log('[*] 需要管理员权限写入 /etc/hosts，正在弹出授权窗口...');
  const launchId = `${Date.now()}-${process.pid}`;

  const rootCommand = [
    `cd ${shellQuote(process.cwd())}`,
    `printf '\\n--- SUPER_DNS_LAUNCH_ID=${launchId} ---\\n' >> ${shellQuote(LOG_FILE)}`,
    `(${[
      'env',
      `SUPER_DNS_HOME=${shellQuote(USER_HOME)}`,
      `SUPER_DNS_LAUNCH_ID=${shellQuote(launchId)}`,
      `DOH_BASE=${shellQuote(DOH_BASE)}`,
      `POLL_INTERVAL=${shellQuote(String(POLL_INTERVAL_MS))}`,
      shellQuote(process.execPath),
      shellQuote(__filename),
      `>> ${shellQuote(LOG_FILE)} 2>&1 < /dev/null & echo $!`
    ].join(' ')})`
  ].join(' && ');

  const script = `do shell script "${appleScriptQuote(rootCommand)}" with administrator privileges`;
  let launchedPid = '';

  try {
    launchedPid = execSync(`osascript -e ${shellQuote(script)}`, { encoding: 'utf-8', timeout: 120000 }).trim();
  } catch (e) {
    console.error(`[!] 授权失败或已取消: ${e.message}`);
    process.exit(1);
  }

  const pid = waitForRootDaemon();
  if (pid) {
    console.log(`[*] root 守护进程已启动，PID: ${pid}`);
  } else {
    console.error(`[*] 已完成授权，启动命令返回 PID: ${launchedPid || '未知'}`);
    console.error(`[*] 但 5 秒内没有确认到进程，请查看日志: ${LOG_FILE}`);
  }

  const summary = waitForLaunchSummary(launchId);
  if (summary) {
    const formatted = formatLaunchSummary(summary);
    console.log('------------------------------------------------------------------');
    console.log(formatted || summary);
    console.log('------------------------------------------------------------------');
  } else {
    console.error(`[*] 本次启动没有产生可读日志，请查看: ${LOG_FILE}`);
  }

  process.exit(0);
}

function killRootDaemon(pid) {
  if (isRootUser()) {
    execSync(`kill -TERM ${pid}`, { timeout: 10000 });
    return;
  }

  const script = `do shell script "kill -TERM ${pid}" with administrator privileges`;
  execSync(`osascript -e ${shellQuote(script)}`, { stdio: 'inherit', timeout: 120000 });
}

function waitForRootDaemonStop(pid) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const running = findRootDaemonPid();
    if (!running || running !== pid) return true;

    try {
      execSync('sleep 0.2', { timeout: 1000 });
    } catch (_) {
      return false;
    }
  }

  return false;
}

function stopRootDaemon() {
  const pid = findRootDaemonPid();
  if (!pid) {
    console.log(color('yellow', '[*] super-dns 未运行'));
    return true;
  }

  console.log(`[*] 正在关闭 root 守护进程，PID: ${pid}`);
  try {
    killRootDaemon(pid);
  } catch (e) {
    console.error(`[!] 关闭失败: ${e.message}`);
    return false;
  }

  if (!waitForRootDaemonStop(pid)) {
    console.error('[!] 已发送关闭信号，但进程仍在运行');
    return false;
  }

  console.log('[*] super-dns 已关闭');
  return true;
}

function restartRootDaemon() {
  if (!stopRootDaemon()) process.exit(1);
  launchWithAdministratorDialog();
}

function renderMenuItems(items, selected) {
  for (let i = 0; i < items.length; i++) {
    process.stdout.write('\x1b[2K');
    process.stdout.write(`${i === selected ? '>' : ' '} ${items[i]}\n`);
  }
}

function renderRunningMenu(items, selected) {
  process.stdout.write('\x1b[2J\x1b[H');
  printRunningSummary(findRootDaemonPid());
  console.log('');
  renderMenuItems(items, selected);
  console.log('');
  console.log('使用 ↑/↓ 选择，Enter 确认，q 退出');
}

function updateRunningMenuSelection(items, selected) {
  process.stdout.write(`\x1b[${items.length + 2}A`);
  renderMenuItems(items, selected);
  process.stdout.write(`\x1b[${2}B`);
}

function showRunningMenu() {
  const items = ['重启', '关闭', '退出'];
  let selected = 0;

  if (!process.stdin.isTTY) {
    printRunningSummary(findRootDaemonPid());
    console.log('');
    console.log('1. 重启');
    console.log('2. 关闭');
    console.log('3. 退出');
    return;
  }

  const restoreRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?25l');
  renderRunningMenu(items, selected);

  const restoreTerminal = () => {
    process.stdin.setRawMode(Boolean(restoreRaw));
    process.stdout.write('\x1b[?25h');
  };

  process.stdin.on('data', (key) => {
    if (key === '\u0003' || key === 'q') {
      restoreTerminal();
      process.stdout.write('\n');
      process.exit(0);
    }

    if (key === '\u001b[A') {
      selected = selected === 0 ? items.length - 1 : selected - 1;
      updateRunningMenuSelection(items, selected);
      return;
    }

    if (key === '\u001b[B') {
      selected = selected === items.length - 1 ? 0 : selected + 1;
      updateRunningMenuSelection(items, selected);
      return;
    }

    if (key === '\r' || key === '\n') {
      restoreTerminal();
      process.stdout.write('\n');
      if (selected === 0) restartRootDaemon();
      if (selected === 1) {
        stopRootDaemon();
        process.exit(0);
      }
      process.exit(0);
    }
  });
}

function runCli(command) {
  switch (command) {
    case '':
    case 'start':
      if (findRootDaemonPid()) showRunningMenu();
      else launchWithAdministratorDialog();
      break;
    case 'stop':
      process.exit(stopRootDaemon() ? 0 : 1);
      break;
    case 'restart':
      restartRootDaemon();
      break;
    default:
      console.error(`未知命令: ${command}`);
      console.error('用法: super-dns [start|stop|restart]');
      process.exit(1);
  }
}

function ensureRootUser() {
  if (isRootUser()) return;

  runCli((process.argv[2] || '').toLowerCase());
}

function ensureDomainsFile() {
  if (fs.existsSync(DOMAINS_FILE)) return;

  fs.mkdirSync(path.dirname(DOMAINS_FILE), { recursive: true });
  fs.writeFileSync(
    DOMAINS_FILE,
    '# Super DNS 域名配置\n# 每行一个域名，支持 # 注释\n# /etc/hosts 模式只会写入精确域名，通配符会被跳过\n\nperf.qzz.io\n',
    'utf-8'
  );
  console.log(`[*] 已自动创建配置文件: ${DOMAINS_FILE}`);
}

function loadDomains() {
  ensureDomainsFile();

  const nextExact = [];
  const nextWildcard = [];
  const seen = new Set();
  const lines = fs.readFileSync(DOMAINS_FILE, 'utf-8')
    .split('\n')
    .map(line => line.split('#')[0].trim().toLowerCase())
    .filter(Boolean);

  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);

    if (line.startsWith('*.')) {
      nextWildcard.push(line);
      continue;
    }

    nextExact.push(line);
  }

  exactDomains = nextExact;
  wildcardDomains = nextWildcard;

  console.log(`[*] 精确域名列表: ${exactDomains.length} (domains 中需要监控)`);
  for (const domain of exactDomains) console.log(`    - ${domain}`);

  console.log(`[*] 通配符域名列表: ${wildcardDomains.length} (hosts 模式不会写入)`);
  for (const domain of wildcardDomains) console.log(`    - ${domain} (跳过通配符 hosts 条目)`);
}

function uniqueIps(ips) {
  return [...new Set(ips)];
}

function dohQuery(domain, type) {
  return new Promise((resolve, reject) => {
    const recordTypes = { A: 1, AAAA: 28 };
    const ipVersions = { A: 4, AAAA: 6 };
    const recordType = recordTypes[type];
    const ipVersion = ipVersions[type];

    if (!recordType || !ipVersion) {
      reject(new Error(`不支持的 DoH 记录类型: ${type}`));
      return;
    }

    const url = `${DOH_BASE}?name=${encodeURIComponent(domain)}&type=${type}`;
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const ips = [];
          for (const answer of json.Answer || []) {
            if (answer.type === recordType && typeof answer.data === 'string' && net.isIP(answer.data) === ipVersion) {
              ips.push(answer.data);
            }
          }
          resolve(uniqueIps(ips));
        } catch (e) {
          reject(new Error(`DoH JSON 解析失败: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('DoH 超时'));
    });
  });
}

function buildHostsBlock(records) {
  const lines = [HOSTS_BEGIN];
  const domains = [...records.keys()].sort();

  for (const domain of domains) {
    const ips = records.get(domain) || [];
    for (const ip of ips) {
      lines.push(`${ip} ${domain}`);
    }
  }

  lines.push(HOSTS_END);
  return lines.join('\n');
}

function stripHostsBlock(content) {
  const pattern = new RegExp(`\\n?${escapeRegExp(HOSTS_BEGIN)}[\\s\\S]*?${escapeRegExp(HOSTS_END)}\\n?`, 'g');
  return content.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function stripManagedDomainLines(content, domains) {
  const managed = new Set([...domains].map(domain => domain.toLowerCase()));
  if (managed.size === 0) return content;

  return content
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (trimmed.startsWith('#')) return true; // 保留注释行

      const fields = trimmed.split(/\s+/);
      const names = fields.slice(1).map(name => name.toLowerCase());
      return !names.some(name => managed.has(name));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function updateHostsBlock(records) {
  const existing = fs.readFileSync(HOSTS_FILE, 'utf-8');
  const base = stripManagedDomainLines(stripHostsBlock(existing), records.keys());
  const block = buildHostsBlock(records);
  const next = `${base ? `${base}\n\n` : ''}${block}\n`;

  if (existing === next) {
    console.log('[*] /etc/hosts 无变化');
    return false;
  }

  fs.writeFileSync(HOSTS_FILE, next, 'utf-8');
  console.log(`[*] 已更新 /etc/hosts，写入 ${records.size} 个域名`);
  for (const [domain, ips] of [...records.entries()].sort()) {
    console.log(`    - ${domain} -> ${ips.join(', ')}`);
  }
  return true;
}

function removeHostsBlock() {
  let existing = '';
  try {
    existing = fs.readFileSync(HOSTS_FILE, 'utf-8');
  } catch (e) {
    console.error(`[!] 读取 /etc/hosts 失败: ${e.message}`);
    return false;
  }

  if (!existing.includes(HOSTS_BEGIN) || !existing.includes(HOSTS_END)) return false;

  const next = `${stripHostsBlock(existing)}\n`;
  if (existing === next) return false;

  fs.writeFileSync(HOSTS_FILE, next, 'utf-8');
  console.log('[*] 已清理 /etc/hosts super-dns 区块');
  return true;
}

function flushDnsCache() {
  try {
    execSync('dscacheutil -flushcache', { timeout: 10000 });
    execSync('killall -HUP mDNSResponder', { timeout: 10000 });
    console.log('[*] 已刷新本机 DNS 缓存');
  } catch (e) {
    console.error(`[!] 刷新 DNS 缓存失败: ${e.message}`);
  }
}

function recordsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [domain, ips] of a) {
    const other = b.get(domain);
    if (!other || other.join(',') !== ips.join(',')) return false;
  }
  return true;
}

async function resolveExactDomains() {
  const records = new Map();

  for (const domain of exactDomains) {
    try {
      const [ipv4, ipv6] = await Promise.all([
        dohQuery(domain, 'A'),
        dohQuery(domain, 'AAAA')
      ]);
      const ips = uniqueIps([...ipv4, ...ipv6]);
      if (ips.length === 0) {
        console.log(`[!] ${domain} 没有 A/AAAA 记录`);
        continue;
      }
      records.set(domain, ips);
      console.log(`[✓] ${domain} A -> ${ipv4.length ? ipv4.join(', ') : '无'}`);
      console.log(`[✓] ${domain} AAAA -> ${ipv6.length ? ipv6.join(', ') : '无'}`);
      console.log(`[✓] ${domain} hosts -> ${ips.join(', ')}`);
    } catch (e) {
      console.error(`[!] ${domain} DoH 查询失败: ${e.message}`);
      const stale = currentHosts.get(domain);
      if (stale) {
        records.set(domain, stale);
        console.log(`[!] ${domain} 使用上次结果: ${stale.join(', ')}`);
      }
    }
  }

  return records;
}

async function runUpdateCycle() {
  if (updateInFlight || shuttingDown) return;
  updateInFlight = true;

  try {
    console.log('[*] 开始执行 DoH 更新');
    loadDomains();
    const nextHosts = await resolveExactDomains();
    const unchanged = recordsEqual(currentHosts, nextHosts);
    if (unchanged) {
      console.log('[*] 解析结果无变化');
      if (nextHosts.size > 0) {
        console.log('[*] /etc/hosts 已是最新，以下域名和 IP 已写入');
        for (const [domain, ips] of [...nextHosts.entries()].sort()) {
          console.log(`    - ${domain} -> ${ips.join(', ')}`);
        }
      }
    } else {
      if (updateHostsBlock(nextHosts)) flushDnsCache();
      currentHosts = nextHosts;
    }

    return { changed: !unchanged, records: nextHosts };
  } finally {
    updateInFlight = false;
  }
}

function watchDomainsFile() {
  fs.watchFile(DOMAINS_FILE, { interval: 1000 }, () => {
    console.log('[*] 检测到 domains 文件变化，立即更新');
    runUpdateCycle();
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[*] 收到 ${signal}，正在退出`);

  fs.unwatchFile(DOMAINS_FILE);
  if (removeHostsBlock()) flushDnsCache();
  console.log('[*] 已退出');
  process.exit(0);
}

function logStartupStatus() {
  console.log('[*] 程序已经启动');
  console.log('[*] root 身份确认');
  console.log(`[*] 配置文件: ${DOMAINS_FILE}`);
  console.log(`[*] hosts 文件: ${HOSTS_FILE}`);
  console.log(`[*] 日志文件: ${LOG_FILE}`);
  console.log(`[*] DoH 地址: ${DOH_BASE}`);
  console.log(`[*] 轮询间隔: ${POLL_INTERVAL_MS / 1000}s`);

  try {
    fs.accessSync(HOSTS_FILE, fs.constants.W_OK);
    console.log('[*] /etc/hosts 写入权限: 可写');
  } catch (e) {
    console.error(`[!] /etc/hosts 写入权限: 不可写 (${e.message})`);
  }
}

async function main() {
  const command = (process.argv[2] || '').toLowerCase();

  if (!isRootUser()) {
    ensureRootUser();
    return;
  }

  if (command === 'stop') {
    process.exit(stopRootDaemon() ? 0 : 1);
  }

  if (command === 'restart') {
    if (!stopRootDaemon()) process.exit(1);
  }

  ensureSingleInstance();
  ensureRootUser();
  installLogger();
  logStartupStatus();

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await runUpdateCycle();
  watchDomainsFile();
  setInterval(runUpdateCycle, POLL_INTERVAL_MS);
  console.log(`[*] 监控开始运行，TTL/轮询间隔: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`[*] 详细日志: ${LOG_FILE}`);
}

main().catch((e) => {
  console.error(`[!] 启动失败: ${e.message}`);
  process.exit(1);
});
