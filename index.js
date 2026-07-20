#!/usr/bin/env node
const dgram = require('dgram');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');

// ============================================================
// 配置
// ============================================================
const PORT = parseInt(process.env.PORT || '15353', 10);
const HOST = process.env.HOST || '127.0.0.1';
const DOH_BASE = process.env.DOH_BASE || 'https://dns.alidns.com/resolve';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL || '300000', 10); // 5 min
const CONFIG_DIR = path.join(os.homedir(), '.config', 'super-dns');
const DOMAINS_FILE = path.join(CONFIG_DIR, 'domains');

// ============================================================
// 域名列表加载
// ============================================================
function loadDomains(file) {
  // 自动创建配置文件
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

  // 解析域名规则
  const rules = lines.map(line => {
    if (line.startsWith('*.')) {
      // 通配符: *.qzz.io → 匹配 qzz.io 及所有子域
      const base = line.slice(2);
      return { type: 'wildcard', base, raw: line };
    }
    return { type: 'exact', domain: line, raw: line };
  });

  console.log(`[*] 已加载 ${rules.length} 条规则:`);
  rules.forEach(r => console.log(`    - ${r.raw}`));
  return rules;
}

const domainRules = loadDomains(DOMAINS_FILE);

// 从规则中提取需要配置 resolver 的域名
function getResolverDomains() {
  const domains = new Set();
  for (const rule of domainRules) {
    if (rule.type === 'wildcard') {
      domains.add(rule.base); // *.qzz.io → resolver 文件用 qzz.io
    } else {
      // 精确域名，提取二级域作为 resolver 文件名
      // 比如 aaa.qzz.io → resolver 文件用 qzz.io
      const parts = rule.domain.split('.');
      if (parts.length >= 2) {
        domains.add(parts.slice(-2).join('.'));
      } else {
        domains.add(rule.domain);
      }
    }
  }
  return [...domains];
}

// ============================================================
// macOS Resolver 自动配置
// ============================================================
const RESOLVER_DIR = '/etc/resolver';
let resolverConfigured = false;

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
// DoH 查询 (阿里云公共 DNS)
// ============================================================
function dohQuery(name, type) {
  return new Promise((resolve, reject) => {
    const qtype = type === 28 ? 'AAAA' : 'A';
    const url = `${DOH_BASE}?name=${encodeURIComponent(name)}&type=${qtype}`;
    const req = https.get(url, { timeout: 3000 }, (res) => {
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
    questionRaw: buf.slice(12, nextOffset + 4)
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

function buildNxDomain(req) {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(req.id, 0);
  const flags = Buffer.alloc(2);
  flags.writeUInt16BE(0x8183, 0);
  const counts = Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([id, flags, counts, req.questionRaw]);
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
  console.log(`[>] ${cleanName} ${typeStr} from ${rinfo.address}:${rinfo.port}`);

  if (!isManaged(req.name)) {
    console.log(`[x] 不在管理列表中，返回 NXDOMAIN`);
    server.send(buildNxDomain(req), rinfo.port, rinfo.address);
    return;
  }

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

const resolverDomains = getResolverDomains();

server.on('listening', () => {
  const addr = server.address();
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║           Super DNS 本地代理服务             ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`[*] 监听: ${addr.address}:${addr.port} (UDP)`);
  console.log(`[*] DoH:  ${DOH_BASE}`);
  console.log(`[*] 缓存: ${CACHE_TTL_MS / 1000}s`);
  console.log(`[*] 配置: ${DOMAINS_FILE}`);
  console.log('');
  console.log('[*] 正在配置 macOS 独立解析器（可能需要输入密码）...');

  // 用子进程配置 macOS resolver，避免阻塞 DNS 服务
  // osascript 弹密码框期间 DNS 仍可正常响应
  // 关键：chown 把 resolver 文件归属当前用户，退出时 rm 不需要 sudo
  const currentUser = os.userInfo().username;
  const setupScript = `
    const fs = require('fs');
    const { execSync } = require('child_process');
    const resolverDomains = ${JSON.stringify(resolverDomains)};
    const host = '${addr.address}';
    const port = ${addr.port};
    const RESOLVER_DIR = '${RESOLVER_DIR}';
    const pid = ${process.pid};
    const currentUser = '${currentUser}';

    function sudoExec(cmd) {
      const escaped = cmd.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
      execSync(
        \`osascript -e 'do shell script "\${escaped}" with administrator privileges'\`,
        { stdio: 'pipe', timeout: 120000 }
      );
    }

    try {
      const commands = ['mkdir -p ' + RESOLVER_DIR];
      for (const domain of resolverDomains) {
        const tmpFile = '/tmp/super-dns-' + domain + '-' + pid;
        const resolverFile = RESOLVER_DIR + '/' + domain;
        fs.writeFileSync(tmpFile, '# Auto-generated by super-dns (PID ' + pid + ')\\nnameserver ' + host + '\\nport ' + port + '\\n');
        commands.push('mv ' + tmpFile + ' ' + resolverFile);
        commands.push('chmod 644 ' + resolverFile);
        commands.push('chown ' + currentUser + ' ' + resolverFile);
      }
      sudoExec(commands.join(' && '));

      // 验证 chown 是否生效，确保退出时 unlinkSync 能直接删除
      for (const domain of resolverDomains) {
        const resolverFile = RESOLVER_DIR + '/' + domain;
        try {
          const stat = fs.statSync(resolverFile);
          const owner = require('os').userInfo().uid;
          if (stat.uid !== owner) {
            process.send({ type: 'setup-warn', domain, error: 'chown 未生效 (uid=' + stat.uid + ', 期望=' + owner + ')，退出时可能需要手动清理' });
          }
        } catch (statErr) {
          // 忽略 stat 错误
        }
        process.send({ type: 'setup-ok', domain });
      }
      process.send({ type: 'setup-done' });
    } catch (e) {
      process.send({ type: 'setup-fail', error: e.message });
    }
  `;

  const setupChild = fork(`-e`, [setupScript], {
    silent: true,
    detached: false
  });

  setupChild.on('message', (msg) => {
    if (msg.type === 'setup-ok') {
      console.log(`    ✓ ${RESOLVER_DIR}/${msg.domain} → ${addr.address}:${addr.port}`);
    } else if (msg.type === 'setup-warn') {
      console.warn(`    ⚠ ${RESOLVER_DIR}/${msg.domain}: ${msg.error}`);
    } else if (msg.type === 'setup-done') {
      resolverConfigured = true;
      console.log('[*] macOS 解析器配置完成');
      console.log('');
    } else if (msg.type === 'setup-fail') {
      console.error(`[!] 配置 macOS 解析器失败: ${msg.error}`);
      console.error('[!] 请手动执行:');
      for (const domain of resolverDomains) {
        console.error(`    sudo mkdir -p ${RESOLVER_DIR}`);
        console.error(`    echo "nameserver ${addr.address}\\nport ${addr.port}" | sudo tee ${RESOLVER_DIR}/${domain}`);
      }
    }
  });

  setupChild.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[!] resolver 配置子进程异常退出 (code=${code})`);
    }
  });
});

// ============================================================
// 优雅退出
// ============================================================
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[*] 收到 ${signal}，正在关闭...`);

  // 关闭 DNS 服务器
  server.close(() => {
    console.log('[*] DNS 服务已关闭');
  });

  if (resolverConfigured) {
    console.log('[*] 正在清理 macOS 独立解析器...');
    for (const domain of resolverDomains) {
      const resolverFile = `${RESOLVER_DIR}/${domain}`;
      try {
        // 文件已 chown 为当前用户，直接 rm 即可，无需 sudo
        fs.unlinkSync(resolverFile);
        console.log(`    ✓ 已删除 ${resolverFile}`);
      } catch (e) {
        // pm2 等进程管理器 kill_timeout 很短，osascript 弹密码框来不及输入就会被 SIGKILL
        // 不弹框，改为提示手动清理
        console.error(`    ✗ 删除 ${resolverFile} 失败: ${e.message}`);
        console.error(`    请手动执行: sudo rm ${resolverFile}`);
      }
    }
  }

  console.log('[*] 已关闭');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 启动
server.bind(PORT, HOST);
