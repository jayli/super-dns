#!/usr/bin/env node
const dgram = require('dgram');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');
const { execSync } = require('child_process');

// ============================================================
// 配置
// ============================================================
const PORT = parseInt(process.env.PORT || '53', 10);
const HOST = process.env.HOST || '127.0.0.1';
const DOH_BASE = process.env.DOH_BASE || 'https://dns.alidns.com/resolve';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL || '300000', 10);
const VERBOSE = process.env.SUPER_DNS_VERBOSE === '1';
const CONFIG_DIR = path.join(os.homedir(), '.config', 'super-dns');
const DOMAINS_FILE = path.join(CONFIG_DIR, 'domains');
const ELEVATE_LOCK = '/tmp/super-dns-elevate.lock';
const PID_FILE = '/tmp/super-dns.pid';
const LOG_FILE = '/tmp/super-dns.log';
const LOG_MAX_LINES = 500;
let NETWORK_INTERFACE = null;
let UPSTREAM_DNS = null;
let domainRules = [];

// ============================================================
// Root 提权
// ============================================================
function isRoot() {
  try {
    return process.getuid && process.getuid() === 0;
  } catch {
    return false;
  }
}

function sudoExec(cmd) {
  const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return execSync(
    `osascript -e 'do shell script "${escaped}" with administrator privileges'`,
    { stdio: 'inherit', timeout: 120000 }
  );
}

function launchServiceAsRoot() {
  if (fs.existsSync(ELEVATE_LOCK)) {
    const lockAge = Date.now() - fs.statSync(ELEVATE_LOCK).mtimeMs;
    if (lockAge < 30000) {
      console.log('[*] 已有提权进程在处理中，退出等待');
      process.exit(0);
    }
    try { fs.unlinkSync(ELEVATE_LOCK); } catch (_) { /* ignore */ }
  }

  fs.writeFileSync(ELEVATE_LOCK, String(process.pid));
  console.log('[*] 需要管理员权限监听 53 端口，正在请求授权...');

  const passEnv = {};
  for (const key of Object.keys(process.env)) {
    if (/^(DOH_BASE|CACHE_TTL|UPSTREAM_DNS|NETWORK_INTERFACE|SUPER_DNS_VERBOSE|NODE_PATH|PATH|HOME)$/.test(key)) {
      passEnv[key] = process.env[key];
    }
  }

  passEnv.PORT = String(PORT);
  passEnv.HOST = HOST;
  passEnv.SUPER_DNS_SERVICE = '1';

  const envLines = Object.entries(passEnv)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`)
    .join('\n');

  const script = [
    '#!/bin/bash',
    envLines,
    `${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)} > /dev/null 2>&1 < /dev/null &`,
    `rm -f ${JSON.stringify(ELEVATE_LOCK)}`
  ].join('\n');

  const tmpFile = `/tmp/super-dns-elevate-${process.pid}.sh`;
  fs.writeFileSync(tmpFile, script, { mode: 0o700 });

  try {
    const escaped = `bash ${tmpFile}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execSync(
      `osascript -e 'do shell script "${escaped}" with administrator privileges'`,
      { stdio: 'inherit', timeout: 120000 }
    );
    console.log(`[*] 已请求启动 Root DNS 服务，日志: ${LOG_FILE}`);
  } catch (e) {
    console.error(`[!] 授权失败或已取消: ${e.message}`);
    try { fs.unlinkSync(ELEVATE_LOCK); } catch (_) { /* ignore */ }
    process.exit(1);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
  }

  if (!waitForServiceStart()) {
    console.error(`[!] Root DNS 服务未能在 5 秒内启动，请查看日志: ${LOG_FILE}`);
    process.exit(1);
  }
  console.log(`[*] Root DNS 服务已启动，PID: ${getServicePid()}`);
}

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function findServiceProcessPid() {
  try {
    const out = execSync('ps ax -o pid= -o command=', { encoding: 'utf-8', timeout: 5000 });
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      const command = match[2];
      if (pid === process.pid) continue;
      if (command.includes('node') && command.includes(__filename)) return pid;
    }
  } catch (_) {
    return null;
  }
  return null;
}

function getServicePid() {
  const pid = readPid();
  if (isPidRunning(pid)) return pid;
  try { fs.unlinkSync(PID_FILE); } catch (_) { /* ignore */ }
  return findServiceProcessPid();
}

function isServiceRunning() {
  return Boolean(getServicePid());
}

function waitForServiceStart() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (isServiceRunning()) return true;
    try { execSync('sleep 0.2'); } catch (_) { /* ignore */ }
  }
  return false;
}

function startService() {
  const pid = getServicePid();
  if (pid) {
    console.log(`[*] Super DNS 已在运行，PID: ${pid}`);
    console.log(`[*] 日志: ${LOG_FILE}`);
    return;
  }

  if (isRoot()) {
    process.env.SUPER_DNS_SERVICE = '1';
    runService();
    return;
  }

  launchServiceAsRoot();
}

function stopService() {
  const pid = getServicePid();
  const iface = getActiveInterface();

  if (!pid) {
    console.log('[*] Super DNS 未运行');
    try {
      execSync(`networksetup -setdnsservers "${iface}" Empty`, { timeout: 10000 });
      console.log(`[*] 已恢复 ${iface} DNS 为默认`);
    } catch (e) {
      console.error(`[!] 恢复系统 DNS 失败: ${e.message}`);
    }
    return;
  }

  console.log(`[*] 正在关闭 Super DNS，PID: ${pid}`);
  try {
    sudoExec(
      `kill -TERM ${pid} 2>/dev/null || true; ` +
      `networksetup -setdnsservers "${iface}" Empty; ` +
      `rm -f ${PID_FILE}`
    );
    console.log('[*] Super DNS 已关闭');
  } catch (e) {
    console.error(`[!] 关闭失败: ${e.message}`);
    console.error(`    请手动执行: sudo kill -TERM ${pid}`);
    console.error(`    请手动执行: sudo networksetup -setdnsservers "${iface}" Empty`);
    process.exit(1);
  }
}

function renderMenu(title, items, selected) {
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(title);
  console.log('');
  items.forEach((item, idx) => {
    console.log(`${idx === selected ? '>' : ' '} ${item}`);
  });
  console.log('');
  console.log('使用 ↑/↓ 选择，Enter 确认，q 退出');
}

function showMenu() {
  const running = isServiceRunning();
  const title = running ? 'Super DNS 服务正在运行' : 'Super DNS 服务未运行';
  const items = running ? ['关闭服务', '退出'] : ['启动服务', '退出'];
  let selected = 0;

  if (!process.stdin.isTTY) {
    console.log(title);
    console.log(`1. ${items[0]}`);
    console.log(`2. ${items[1]}`);
    return;
  }

  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  renderMenu(title, items, selected);

  process.stdin.on('data', (key) => {
    if (key === '\u0003' || key === 'q') {
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdout.write('\n');
      process.exit(0);
    }

    if (key === '\u001b[A' || key === '\u001b[B') {
      selected = selected === 0 ? 1 : 0;
      renderMenu(title, items, selected);
      return;
    }

    if (key === '\r' || key === '\n') {
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdout.write('\n');
      if (selected === 1) process.exit(0);
      if (running) stopService();
      else startService();
    }
  });
}

function runCli() {
  const command = (process.argv[2] || '').toLowerCase();
  switch (command) {
    case 'start':
      startService();
      break;
    case 'end':
      stopService();
      break;
    case '':
      showMenu();
      break;
    default:
      console.error(`未知命令: ${command}`);
      console.error('用法: super-dns [start|end]');
      process.exit(1);
  }
}

function writeBoundedLog(line) {
  let lines = [];
  try {
    lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  } catch (_) {
    lines = [];
  }

  lines.push(line);
  fs.writeFileSync(LOG_FILE, `${lines.slice(-LOG_MAX_LINES).join('\n')}\n`);
}

function installServiceLogger() {
  const write = (level, args) => {
    const text = util.format(...args);
    const stamp = new Date().toISOString();
    for (const line of text.split('\n')) {
      writeBoundedLog(`${stamp} ${level} ${line}`);
    }
  };

  console.log = (...args) => write('INFO', args);
  console.error = (...args) => write('ERROR', args);
}

// ============================================================
// 系统网络检测
// ============================================================
function getActiveInterface() {
  if (process.env.NETWORK_INTERFACE) {
    const iface = process.env.NETWORK_INTERFACE;
    if (/^[a-zA-Z0-9 -]+$/.test(iface)) return iface;
    console.error('[!] NETWORK_INTERFACE 包含非法字符，已忽略');
  }

  try {
    const out = execSync('networksetup -listallnetworkservices', { encoding: 'utf-8', timeout: 5000 });
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    const enabled = lines.filter(l => !l.startsWith('*'));

    for (const svc of enabled) {
      try {
        const info = execSync(`networksetup -getinfo "${svc}"`, { encoding: 'utf-8', timeout: 5000 });
        if (/^IP address:\s*\S/m.test(info)) return svc;
      } catch (e) { /* skip */ }
    }

    if (enabled.length > 0) return enabled[0];
  } catch (e) { /* ignore */ }

  return 'Wi-Fi';
}

function getUpstreamDNS(iface) {
  if (!/^[a-zA-Z0-9 -]+$/.test(iface)) {
    console.error('[!] 网卡名称包含非法字符，使用默认上游 DNS');
    return '114.114.114.114';
  }

  if (process.env.UPSTREAM_DNS && !process.env.UPSTREAM_DNS.startsWith('127.')) {
    return process.env.UPSTREAM_DNS;
  }

  try {
    const out = execSync(`networksetup -getdnsservers "${iface}"`, { encoding: 'utf-8', timeout: 5000 });
    const servers = out.split('\n').map(s => s.trim()).filter(s => /^\d+\.\d+\.\d+\.\d+$/.test(s));
    for (const s of servers) {
      // 跳过环回地址，避免转发死循环
      if (!s.startsWith('127.')) return s;
    }
  } catch (e) { /* ignore */ }

  return '114.114.114.114';
}

// ============================================================
// 域名列表加载
// ============================================================
function loadDomains(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# Super DNS 域名配置\n# 每行一个域名，支持通配符\n# 例: *.qzz.io 表示接管 qzz.io 及其所有子域名\n# 例: aaa.qzz.io 表示只接管这一个域名\n\n*.qzz.io\n', 'utf-8');
    console.log(`[*] 已自动创建配置文件: ${file}`);
  }

  const lines = fs.readFileSync(file, 'utf-8')
    .split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(l => l && !l.startsWith('#'));

  if (lines.length === 0) {
    console.error(`[!] 配置文件为空: ${file}`);
    console.error('[!] 请添加至少一个域名，例如:');
    console.error('    *.qzz.io');
    process.exit(1);
  }

  const rules = lines.map(line => {
    if (line.startsWith('*.')) {
      const base = line.slice(2);
      return { type: 'wildcard', base, raw: line };
    }
    return { type: 'exact', domain: line, raw: line };
  });

  console.log(`[*] 已加载 ${rules.length} 条规则:`);
  rules.forEach(r => console.log(`    - ${r.raw}`));
  return rules;
}

// ============================================================
// 缓存
// ============================================================
const cache = new Map();

function cacheKey(name, type) {
  return `${name}|${type}`;
}

function cacheGet(name, type) {
  const key = cacheKey(name, type);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(name, type, data) {
  cache.set(cacheKey(name, type), { data, ts: Date.now() });
}

// ============================================================
// 上游 DNS UDP 透传
// ============================================================
const upstreamSocket = dgram.createSocket('udp4');
const pendingUpstream = new Map(); // upstreamId -> { rinfo, clientDnsId, timer }
let nextUpstreamId = 1;

function sendToClient(msg, rinfo, label) {
  server.send(msg, rinfo.port, rinfo.address, (err) => {
    if (err) {
      console.error(`[!] 响应发送失败 ${label}: ${err.message}`);
    } else if (VERBOSE) {
      const tailIp = msg.length >= 4 ? Array.from(msg.subarray(msg.length - 4)).join('.') : '-';
      console.log(`[<] 已发送 ${label}: ${msg.length} bytes to ${rinfo.address}:${rinfo.port} tail=${tailIp}`);
    }
  });
}

upstreamSocket.on('message', (msg) => {
  if (msg.length < 2) return;
  const upstreamId = msg.readUInt16BE(0);
  const entry = pendingUpstream.get(upstreamId);
  if (!entry) return;

  clearTimeout(entry.timer);
  pendingUpstream.delete(upstreamId);

  const response = Buffer.from(msg);
  response.writeUInt16BE(entry.clientDnsId, 0);
  sendToClient(response, entry.rinfo, 'upstream');
});

function allocateUpstreamId() {
  for (let i = 0; i < 65535; i++) {
    const upstreamId = nextUpstreamId;
    nextUpstreamId = nextUpstreamId >= 65535 ? 1 : nextUpstreamId + 1;
    if (!pendingUpstream.has(upstreamId)) return upstreamId;
  }
  return null;
}

function forwardToUpstream(msg, rinfo) {
  const clientDnsId = msg.readUInt16BE(0);
  const upstreamId = allocateUpstreamId();
  if (!upstreamId) {
    console.error('[!] 上游 DNS 请求过多，丢弃本次透传');
    return;
  }

  const timer = setTimeout(() => {
    pendingUpstream.delete(upstreamId);
  }, 5000);

  msg = Buffer.from(msg);
  msg.writeUInt16BE(upstreamId, 0);

  pendingUpstream.set(upstreamId, { rinfo, clientDnsId, timer });
  upstreamSocket.send(msg, 0, msg.length, 53, UPSTREAM_DNS);
}

// ============================================================
// DoH 查询 (阿里云公共 DNS)
// ============================================================
// https.get 内部 dns.lookup 走系统 DNS → 代理 → 不匹配白名单 → 透传到上游
function dohQuery(name, type) {
  return new Promise((resolve, reject) => {
    const qtype = type === 28 ? 'AAAA' : 'A';
    const url = `${DOH_BASE}?name=${encodeURIComponent(name)}&type=${qtype}`;
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const answers = (json.Answer || []).filter(a => a.type === (type === 28 ? 28 : 1));
          const ips = answers.map(a => a.data);
          resolve(ips);
        } catch (e) {
          reject(new Error(`DoH JSON 解析失败: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('DoH 超时')); });
  });
}

// ============================================================
// DNS 报文解析
// ============================================================

/**
 * 从 DNS 报文的 offset 处读取一个域名（支持压缩指针）
 */
function readName(buf, offset) {
  const parts = [];
  let jumped = false;
  let nextOffset = offset;
  let safety = 0;

  while (safety++ < 64) {
    if (offset >= buf.length) break;
    const len = buf[offset];

    if (len === 0) {
      if (!jumped) nextOffset = offset + 1;
      break;
    }

    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) break;
      const ptr = ((len & 0x3f) << 8) | buf[offset + 1];
      if (!jumped) nextOffset = offset + 2;
      jumped = true;
      offset = ptr;
      continue;
    }

    offset += 1;
    if (offset + len > buf.length) break;
    parts.push(buf.slice(offset, offset + len).toString('ascii'));
    offset += len;
    if (!jumped) nextOffset = offset;
  }

  return { name: parts.join('.'), nextOffset };
}

function parseRequest(buf) {
  if (buf.length < 12) return null;

  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qdCount = buf.readUInt16BE(4);

  if (qdCount < 1) return null;

  const { name, nextOffset } = readName(buf, 12);
  if (nextOffset + 4 > buf.length) return null;

  const qtype = buf.readUInt16BE(nextOffset);
  const qclass = buf.readUInt16BE(nextOffset + 2);

  return {
    id,
    flags,
    name: name.toLowerCase(),
    qtype,
    qclass,
    questionRaw: Buffer.from(buf.subarray(12, nextOffset + 4))
  };
}

// ============================================================
// DNS 报文构造
// ============================================================

function encodeName(name) {
  const labels = name.split('.');
  const bufs = labels.map(label => {
    const b = Buffer.from(label, 'ascii');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function uint16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v, 0);
  return b;
}

function uint32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v, 0);
  return b;
}

function ipv6ToBuffer(ip) {
  try {
    const expanded = expandIPv6(ip);
    const parts = expanded.split(':').map(p => parseInt(p, 16));
    if (parts.length !== 8) return null;
    const buf = Buffer.alloc(16);
    parts.forEach((p, i) => buf.writeUInt16BE(p, i * 2));
    return buf;
  } catch {
    return null;
  }
}

function expandIPv6(ip) {
  if (ip.includes('::')) {
    const [left, right] = ip.split('::');
    const l = left ? left.split(':') : [];
    const r = right ? right.split(':') : [];
    const fill = Array(8 - l.length - r.length).fill('0');
    return [...l, ...fill, ...r].join(':');
  }
  return ip;
}

function buildResponse(req, ips) {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(req.id, 0);

  const flags = Buffer.alloc(2);
  flags.writeUInt16BE(0x8180, 0);

  const qdCount = Buffer.from([0, 1, 0, ips.length, 0, 0, 0, 0]);
  const question = req.questionRaw;
  const answers = [];
  const encodedName = encodeName(req.name);

  for (const ip of ips) {
    if (req.qtype === 1) {
      const parts = ip.split('.').map(Number);
      if (parts.length !== 4 || parts.some(p => isNaN(p))) continue;
      answers.push(Buffer.concat([
        encodedName, uint16(1), uint16(1), uint32(300), uint16(4), Buffer.from(parts)
      ]));
    } else if (req.qtype === 28) {
      const rdata = ipv6ToBuffer(ip);
      if (!rdata) continue;
      answers.push(Buffer.concat([
        encodedName, uint16(28), uint16(1), uint32(300), uint16(16), rdata
      ]));
    }
  }

  if (answers.length === 0) {
    qdCount[2] = 0; qdCount[3] = 0;
  }

  return Buffer.concat([id, flags, qdCount, question, ...answers]);
}

// ============================================================
// 域名匹配（支持通配符）
// ============================================================
function isManaged(name) {
  const clean = name.endsWith('.') ? name.slice(0, -1) : name;
  for (const rule of domainRules) {
    if (rule.type === 'wildcard') {
      // *.qzz.io → 匹配 qzz.io 本身及其所有子域
      if (clean === rule.base || clean.endsWith('.' + rule.base)) return true;
    } else {
      // 精确匹配
      if (clean === rule.domain) return true;
    }
  }
  return false;
}

// ============================================================
// 主服务
// ============================================================
const server = dgram.createSocket('udp4');

server.on('message', async (msg, rinfo) => {
  const req = parseRequest(msg);
  if (!req) {
    console.log(`[!] 无法解析来自 ${rinfo.address}:${rinfo.port} 的请求`);
    return;
  }

  const cleanName = req.name.endsWith('.') ? req.name.slice(0, -1) : req.name;
  const typeStr = req.qtype === 1 ? 'A' : req.qtype === 28 ? 'AAAA' : `TYPE${req.qtype}`;

  if (!isManaged(req.name)) {
    // 非管理域名：UDP 原样透传到上游 DNS
    forwardToUpstream(msg, rinfo);
    return;
  }

  console.log(`[>] ${cleanName} ${typeStr} from ${rinfo.address}:${rinfo.port}`);

  if (req.qtype !== 1 && req.qtype !== 28) {
    console.log(`[x] 不支持的查询类型 ${typeStr}，返回空回答`);
    sendToClient(buildResponse(req, []), rinfo, `${cleanName} ${typeStr}`);
    return;
  }

  const cached = cacheGet(cleanName, req.qtype);
  if (cached) {
    console.log(`[c] 缓存命中: ${cached.join(', ')}`);
    sendToClient(buildResponse(req, cached), rinfo, `${cleanName} ${typeStr}`);
    return;
  }

  try {
    const ips = await dohQuery(cleanName, req.qtype);
    if (ips.length > 0) {
      cacheSet(cleanName, req.qtype, ips);
      console.log(`[✓] 解析成功: ${ips.join(', ')}`);
    } else {
      console.log(`[!] DoH 无记录`);
    }
    sendToClient(buildResponse(req, ips), rinfo, `${cleanName} ${typeStr}`);
  } catch (e) {
    console.error(`[!] DoH 查询失败: ${e.message}`);
    const stale = cache.get(cacheKey(cleanName, req.qtype));
    if (stale) {
      console.log(`[!] 使用过期缓存: ${stale.data.join(', ')}`);
      sendToClient(buildResponse(req, stale.data), rinfo, `${cleanName} ${typeStr}`);
    } else {
      sendToClient(buildResponse(req, []), rinfo, `${cleanName} ${typeStr}`);
    }
  }
});

server.on('error', (err) => {
  console.error(`[!] 服务器错误: ${err.message}`);
  process.exit(1);
});

server.on('listening', () => {
  const addr = server.address();
  fs.writeFileSync(PID_FILE, String(process.pid));
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║           Super DNS 本地代理服务 v2          ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`[*] 监听: ${addr.address}:${addr.port} (UDP)`);
  console.log(`[*] DoH:  ${DOH_BASE}`);
  console.log(`[*] 缓存: ${CACHE_TTL_MS / 1000}s`);
  console.log(`[*] 上游 DNS: ${UPSTREAM_DNS}`);
  console.log(`[*] 配置: ${DOMAINS_FILE}`);
  console.log(`[*] PID:  ${PID_FILE}`);
  console.log('');

  try {
    execSync(`networksetup -setdnsservers "${NETWORK_INTERFACE}" ${HOST}`, { timeout: 10000 });
    console.log(`[*] 已将 ${NETWORK_INTERFACE} DNS 设置为 ${HOST}`);
  } catch (e) {
    console.error(`[!] 设置系统 DNS 失败: ${e.message}`);
    console.error(`[!] 请手动执行: sudo networksetup -setdnsservers "${NETWORK_INTERFACE}" ${HOST}`);
  }
  console.log('');
});

// ============================================================
// 优雅退出
// ============================================================
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[*] 收到 ${signal}，正在关闭...`);

  // 关闭上游 socket
  try { upstreamSocket.close(); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(PID_FILE); } catch (_) { /* ignore */ }

  // 关闭 DNS 服务器
  server.close(() => {
    console.log('[*] DNS 服务已关闭');
  });

  // 恢复系统 DNS
  try {
    execSync(`networksetup -setdnsservers "${NETWORK_INTERFACE}" Empty`, { timeout: 10000 });
    console.log(`[*] 已恢复 ${NETWORK_INTERFACE} DNS 为默认`);
  } catch (e) {
    console.error(`[!] 恢复系统 DNS 失败: ${e.message}`);
    console.error(`[!] 请手动执行: sudo networksetup -setdnsservers "${NETWORK_INTERFACE}" Empty`);
  }

  console.log('[*] 已关闭');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function runService() {
  installServiceLogger();
  NETWORK_INTERFACE = getActiveInterface();
  UPSTREAM_DNS = getUpstreamDNS(NETWORK_INTERFACE);
  domainRules = loadDomains(DOMAINS_FILE);
  server.bind(PORT, HOST);
}

if (process.env.SUPER_DNS_SERVICE === '1') {
  runService();
} else {
  runCli();
}
