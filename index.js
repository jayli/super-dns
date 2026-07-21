#!/usr/bin/env node
const dgram = require('dgram');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ============================================================
// 配置
// ============================================================
const PORT = parseInt(process.env.PORT || '53', 10);
const HOST = process.env.HOST || '127.0.0.1';
const DOH_BASE = process.env.DOH_BASE || 'https://dns.alidns.com/resolve';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL || '300000', 10); // 5 min
const CONFIG_DIR = path.join(os.homedir(), '.config', 'super-dns');
const DOMAINS_FILE = path.join(CONFIG_DIR, 'domains');

// ============================================================
// Root 提权
// ============================================================
const ELEVATE_LOCK = '/tmp/super-dns-elevate.lock';

function ensureRoot() {
  // 已经是 root，清理可能残留的锁文件后直接返回
  try {
    if (process.getuid() === 0) {
      try { fs.unlinkSync(ELEVATE_LOCK); } catch (_) { /* ignore */ }
      return;
    }
  } catch (e) {
    return; // getuid not available
  }

  // 锁文件检查：防止 pm2 反复重启导致多次弹框
  if (fs.existsSync(ELEVATE_LOCK)) {
    const lockAge = Date.now() - fs.statSync(ELEVATE_LOCK).mtimeMs;
    if (lockAge < 30000) {
      console.log('[*] 已有提权进程在处理中，退出等待');
      process.exit(0);
    }
    try { fs.unlinkSync(ELEVATE_LOCK); } catch (_) { /* stale lock */ }
  }
  fs.writeFileSync(ELEVATE_LOCK, String(process.pid));

  console.log('[*] 需要 root 权限监听 53 端口，正在请求授权...');

  // 收集需要传递给 root 进程的环境变量
  const passEnv = {};
  for (const key of Object.keys(process.env)) {
    if (/^(DOH_BASE|CACHE_TTL|UPSTREAM_DNS|NETWORK_INTERFACE|SUPER_DNS_VERBOSE|NODE_PATH|PATH|HOME)$/.test(key)) {
      passEnv[key] = process.env[key];
    }
  }

  const envLines = Object.entries(passEnv)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`)
    .join('\n');

  // 用 nohup & 后台化而非 exec，让 osascript 能正常返回
  // 这样 execSync 不会永久阻塞，pm2 也不会反复重启弹框
  const shellScript = `#!/bin/bash\n${envLines}\nnohup ${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)} > /tmp/super-dns.log 2>&1 &\nrm -f ${ELEVATE_LOCK}`;

  const tmpFile = `/tmp/super-dns-elevate-${process.pid}.sh`;
  fs.writeFileSync(tmpFile, shellScript, { mode: 0o700 });

  try {
    execSync(
      `osascript -e 'do shell script "bash ${tmpFile}" with administrator privileges'`,
      { stdio: 'inherit' }
    );
  } catch (e) {
    console.error('[!] 授权失败或已取消:', e.message);
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(ELEVATE_LOCK); } catch (_) { /* ignore */ }
    process.exit(1);
  }

  try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }

  // osascript 执行完毕，root 子进程已在后台运行
  console.log('[*] Root 子进程已启动 (日志: /tmp/super-dns.log)');
  process.exit(0);
}

// ============================================================
// 系统网络检测
// ============================================================
function getActiveInterface() {
  // NETWORK_INTERFACE 环境变量：校验防止 shell 注入
  if (process.env.NETWORK_INTERFACE) {
    const iface = process.env.NETWORK_INTERFACE;
    if (/^[a-zA-Z0-9 -]+$/.test(iface)) return iface;
    console.error('[!] NETWORK_INTERFACE 包含非法字符，已忽略');
  }

  try {
    const out = execSync('networksetup -listallnetworkservices', { encoding: 'utf-8', timeout: 5000 });
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    // 过滤掉星号标记的已禁用接口（macOS 用 * 前缀标记禁用的服务，不依赖 locale）
    const enabled = lines.filter(l => !l.startsWith('*'));

    // 通过 -getinfo 检查哪个接口实际拥有 IP 地址
    for (const svc of enabled) {
      try {
        const info = execSync(`networksetup -getinfo "${svc}"`, { encoding: 'utf-8', timeout: 5000 });
        if (/^IP address:\s*\S/m.test(info)) return svc;
      } catch (e) { /* skip this service */ }
    }

    if (enabled.length > 0) return enabled[0];
  } catch (e) { /* ignore */ }

  return 'Wi-Fi'; // fallback
}

function getUpstreamDNS(iface) {
  // 校验 iface 参数防止 shell 注入
  if (!/^[a-zA-Z0-9 -]+$/.test(iface)) {
    console.error('[!] 网卡名称包含非法字符，使用默认上游 DNS');
    return '114.114.114.114';
  }

  if (process.env.UPSTREAM_DNS) return process.env.UPSTREAM_DNS;

  try {
    const out = execSync(`networksetup -getdnsservers "${iface}"`, { encoding: 'utf-8', timeout: 5000 });
    // 只保留有效的 IP 地址格式，不依赖 locale（避免 "There aren't any..." 等文本）
    const servers = out.split('\n').map(s => s.trim()).filter(s => /^\d+\.\d+\.\d+\.\d+$/.test(s));
    if (servers.length > 0) return servers[0];
  } catch (e) { /* ignore */ }

  return '114.114.114.114'; // fallback
}

const NETWORK_INTERFACE = getActiveInterface();
const UPSTREAM_DNS = getUpstreamDNS(NETWORK_INTERFACE);

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

// 在尝试 root 提权之前先加载配置（验证配置有效性）
const domainRules = loadDomains(DOMAINS_FILE);

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
const pendingUpstream = new Map(); // key → { rinfo, dnsId, timer }

upstreamSocket.on('message', (msg) => {
  if (msg.length < 2) return;
  const dnsId = msg.readUInt16BE(0);

  for (const [key, entry] of pendingUpstream) {
    if (entry.dnsId === dnsId) {
      clearTimeout(entry.timer);
      server.send(msg, entry.rinfo.port, entry.rinfo.address);
      pendingUpstream.delete(key);
      return;
    }
  }
});

function forwardToUpstream(msg, rinfo) {
  const dnsId = msg.readUInt16BE(0);
  const key = `${rinfo.address}:${rinfo.port}:${dnsId}:${Date.now()}`;

  const timer = setTimeout(() => {
    pendingUpstream.delete(key);
  }, 5000);

  pendingUpstream.set(key, { rinfo, dnsId, timer });
  upstreamSocket.send(msg, 0, msg.length, 53, UPSTREAM_DNS);
}

// ============================================================
// DoH 查询 (阿里云公共 DNS)
// ============================================================
// https.get 内部 dns.lookup 会走系统 DNS → 127.0.0.1 → 代理不匹配白名单 → 透传到上游
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
    server.send(buildResponse(req, []), rinfo.port, rinfo.address);
    return;
  }

  const cached = cacheGet(cleanName, req.qtype);
  if (cached) {
    console.log(`[c] 缓存命中: ${cached.join(', ')}`);
    server.send(buildResponse(req, cached), rinfo.port, rinfo.address);
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
    server.send(buildResponse(req, ips), rinfo.port, rinfo.address);
  } catch (e) {
    console.error(`[!] DoH 查询失败: ${e.message}`);
    const stale = cache.get(cacheKey(cleanName, req.qtype));
    if (stale) {
      console.log(`[!] 使用过期缓存: ${stale.data.join(', ')}`);
      server.send(buildResponse(req, stale.data), rinfo.port, rinfo.address);
    } else {
      server.send(buildResponse(req, []), rinfo.port, rinfo.address);
    }
  }
});

server.on('error', (err) => {
  console.error(`[!] 服务器错误: ${err.message}`);
  process.exit(1);
});

server.on('listening', () => {
  const addr = server.address();
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║           Super DNS 本地代理服务 v2          ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`[*] 监听: ${addr.address}:${addr.port} (UDP)`);
  console.log(`[*] DoH:  ${DOH_BASE}`);
  console.log(`[*] 缓存: ${CACHE_TTL_MS / 1000}s`);
  console.log(`[*] 上游 DNS: ${UPSTREAM_DNS}`);
  console.log(`[*] 配置: ${DOMAINS_FILE}`);
  console.log('');

  // 设置系统 DNS 为本地代理
  try {
    execSync(`networksetup -setdnsservers "${NETWORK_INTERFACE}" 127.0.0.1`, { timeout: 10000 });
    console.log(`[*] 已将 ${NETWORK_INTERFACE} DNS 设置为 127.0.0.1`);
  } catch (e) {
    console.error(`[!] 设置系统 DNS 失败: ${e.message}`);
    console.error(`[!] 请手动执行: sudo networksetup -setdnsservers "${NETWORK_INTERFACE}" 127.0.0.1`);
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
    console.error(`    或: networksetup -setdnsservers "${NETWORK_INTERFACE}" <原来的DNS>`);
  }

  console.log('[*] 已关闭');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 提权（如需要）
ensureRoot();

// 启动
server.bind(PORT, HOST);
