// DNS-over-HTTPS patch for Node.js (CJS)
// 通过 --require 注入，劫持 dns.lookup 让托管域名走阿里云 DoH 解析
//
// 用法: node --require ./doh-patch.js your-script.js
//
// 环境变量:
//   DOH_BASE    - DoH 端点 (默认: https://dns.alidns.com/resolve)
//   CACHE_TTL   - 缓存秒数 (默认: 300)
//   SUPER_DNS_VERBOSE - 设为 1 开启调试日志

const dns = require('node:dns');
const https = require('node:https');

// ============================================================
// 配置
// ============================================================
const DOH_BASE = process.env.DOH_BASE || 'https://dns.alidns.com/resolve';
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL || '300', 10)) * 1000;
const VERBOSE = process.env.SUPER_DNS_VERBOSE === '1';
const TAG = '[doh-patch]';

// ============================================================
// 域名规则 (硬编码，与 super-dns 的 *.qzz.io 规则一致)
// ============================================================
const domainRules = [
  { type: 'wildcard', base: 'qzz.io' },
];

// ============================================================
// 缓存
// ============================================================
const cache = new Map();

function cacheGet(name, type) {
  const key = `${name}|${type}`;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(name, type, data) {
  cache.set(`${name}|${type}`, { data, ts: Date.now() });
}

// ============================================================
// 域名匹配 (与 super-dns 逻辑一致)
// ============================================================
function isManaged(hostname) {
  const clean = hostname.toLowerCase().replace(/\.$/, '');
  for (const rule of domainRules) {
    if (rule.type === 'wildcard') {
      if (clean === rule.base || clean.endsWith('.' + rule.base)) return true;
    } else {
      if (clean === rule.domain) return true;
    }
  }
  return false;
}

// ============================================================
// DoH 查询 (阿里云公共 DNS)
// ============================================================
function dohQuery(name, type) {
  return new Promise((resolve, reject) => {
    const qtype = type === 'AAAA' ? 'AAAA' : 'A';
    const url = `${DOH_BASE}?name=${encodeURIComponent(name)}&type=${qtype}`;

    if (VERBOSE) console.error(`${TAG} DoH → ${url}`);

    const req = https.get(url, { timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const expectedType = qtype === 'AAAA' ? 28 : 1;
          const ips = (json.Answer || [])
            .filter(a => a.type === expectedType)
            .map(a => a.data);
          if (VERBOSE) console.error(`${TAG} DoH ← ${name} ${qtype}: ${ips.join(', ') || '(empty)'}`);
          resolve(ips);
        } catch (e) {
          reject(new Error(`DoH JSON parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('DoH timeout')); });
  });
}

// ============================================================
// Patch dns.lookup
// ============================================================
const originalLookup = dns.lookup;

dns.lookup = function patchedLookup(hostname, options, callback) {
  // 参数归一化 (与原生 dns.lookup 签名一致)
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof options === 'number') {
    options = { family: options };
  }
  if (!options) {
    options = {};
  }

  if (!isManaged(hostname)) {
    return originalLookup.call(dns, hostname, options, callback);
  }

  const family = options.family || 4;
  const queryType = family === 6 ? 'AAAA' : 'A';
  const cleanName = hostname.toLowerCase().replace(/\.$/, '');

  if (VERBOSE) console.error(`${TAG} lookup ${cleanName} ${queryType}`);

  // 缓存
  const cached = cacheGet(cleanName, queryType);
  if (cached && cached.length > 0) {
    if (VERBOSE) console.error(`${TAG} cache hit: ${cached.join(', ')}`);
    if (options.all) {
      return callback(null, cached.map(ip => ({ address: ip, family })));
    }
    return callback(null, cached[0], family);
  }

  // DoH 查询
  dohQuery(cleanName, queryType).then(ips => {
    if (ips.length > 0) {
      cacheSet(cleanName, queryType, ips);
      if (options.all) {
        return callback(null, ips.map(ip => ({ address: ip, family })));
      }
      return callback(null, ips[0], family);
    }
    // DoH 无记录，回退到系统 DNS
    if (VERBOSE) console.error(`${TAG} no DoH records, fallback → system DNS`);
    return originalLookup.call(dns, hostname, options, callback);
  }).catch(err => {
    console.error(`${TAG} DoH failed for ${cleanName}: ${err.message}`);
    // DoH 失败，回退到系统 DNS
    return originalLookup.call(dns, hostname, options, callback);
  });
};

// ============================================================
// Patch dns.promises.lookup
// ============================================================
const originalPromisesLookup = dns.promises.lookup;

dns.promises.lookup = async function patchedPromisesLookup(hostname, options) {
  if (!isManaged(hostname)) {
    return originalPromisesLookup.call(dns.promises, hostname, options);
  }

  const opts = typeof options === 'number' ? { family: options } : (options || {});
  const family = opts.family || 4;
  const queryType = family === 6 ? 'AAAA' : 'A';
  const cleanName = hostname.toLowerCase().replace(/\.$/, '');

  // 缓存
  const cached = cacheGet(cleanName, queryType);
  if (cached && cached.length > 0) {
    if (opts.all) {
      return cached.map(ip => ({ address: ip, family }));
    }
    return { address: cached[0], family };
  }

  // DoH 查询
  try {
    const ips = await dohQuery(cleanName, queryType);
    if (ips.length > 0) {
      cacheSet(cleanName, queryType, ips);
      if (opts.all) {
        return ips.map(ip => ({ address: ip, family }));
      }
      return { address: ips[0], family };
    }
    return originalPromisesLookup.call(dns.promises, hostname, options);
  } catch (err) {
    console.error(`${TAG} DoH failed for ${cleanName}: ${err.message}`);
    return originalPromisesLookup.call(dns.promises, hostname, options);
  }
};

// ============================================================
// 启动日志 (仅 verbose 模式)
// ============================================================
if (VERBOSE) {
  console.error(`${TAG} DNS-over-HTTPS patch loaded`);
  console.error(`${TAG} DoH: ${DOH_BASE}`);
  console.error(`${TAG} Rules: ${domainRules.map(r => r.type === 'wildcard' ? '*.' + r.base : r.domain).join(', ')}`);
}
