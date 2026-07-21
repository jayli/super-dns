# Super DNS v2 系统级 DNS 代理升级

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 super-dns 从按域名 `/etc/resolver` 代理升级为系统级 DNS 代理（监听 53 端口，修改系统 DNS 为 127.0.0.1，白名单域名走 DoH，其余透传到上游 DNS）

**Architecture:** 单进程 `index.js`，通过 osascript 提权后以 root 运行，监听 UDP 53。启动时通过 `networksetup` 将系统 DNS 设为 127.0.0.1，所有本机 DNS 请求被路由到该代理。命中白名单的域名走阿里 DoH 解析并缓存；未命中的通过持久 UDP socket 原样转发到上游 DNS。退出时 `networksetup -setdnsservers <iface> Empty` 恢复。

**Tech Stack:** Node.js (zero dependencies), macOS `networksetup` CLI, `osascript` for privilege elevation

## Global Constraints

- 保持零 npm 依赖
- 配置文件 `~/.config/super-dns/domains` 格式不变
- 通配符匹配逻辑不变
- DoH 查询逻辑不变
- 缓存逻辑不变（仅白名单域名）
- 环境变量：`DOH_BASE`, `CACHE_TTL`（毫秒）, `UPSTREAM_DNS`（可选覆盖）, `NETWORK_INTERFACE`（可选覆盖）
- `cc/doh-patch.js` 不变

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `index.js` | Rewrite | DNS proxy main process |
| `package.json` | Modify | Bump version to 2.0.0, update description |
| `README.md` | Modify | Update docs for v2 |
| `CLAUDE.md` | Modify | Update architecture notes |

---

### Task 1: Root 提权 + 系统网络检测 + 上游 DNS 读取

**Files:**
- Modify: `index.js` (full rewrite)

**Interfaces:**
- Produces: `ensureRoot()` — exits if not root, restarts self as root via osascript
- Produces: `getActiveInterface()` → `string` — active network service name
- Produces: `getUpstreamDNS(iface)` → `string[]` — upstream DNS server IPs
- Produces: global `UPSTREAM_DNS` constant, `NETWORK_INTERFACE` constant

**Overview:** 重写 `index.js` 前 77 行（配置加载 + getResolverDomains），并删除紧随其后的 `/etc/resolver` 变量声明：
- 端口改为 53
- `{ fork }` → `{ execSync }`（fork 不再使用）
- 新增 root 检测与 osascript 提权
- 新增系统网络接口检测
- 新增上游 DNS 读取
- 移除 `getResolverDomains()` 和 `RESOLVER_DIR` / `resolverConfigured`

- [ ] **Step 1: 重写配置段和头部 import**

将 `index.js` 的 L1-L77（配置 + loadDomains + getResolverDomains）替换为：

```javascript
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
function ensureRoot() {
  try {
    if (process.getuid() === 0) return;
  } catch (e) {
    return; // getuid not available
  }

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

  const shellScript = `#!/bin/bash\n${envLines}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)}`;

  const tmpFile = `/tmp/super-dns-elevate-${process.pid}.sh`;
  fs.writeFileSync(tmpFile, shellScript, { mode: 0o700 });

  try {
    execSync(
      `osascript -e 'do shell script "bash ${tmpFile}" with administrator privileges'`,
      { stdio: 'inherit' }
    );
  } catch (e) {
    console.error('[!] 授权失败或已取消:', e.message);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
  }

  process.exit(0);
}

// ============================================================
// 系统网络检测
// ============================================================
function getActiveInterface() {
  if (process.env.NETWORK_INTERFACE) return process.env.NETWORK_INTERFACE;

  try {
    const out = execSync('networksetup -listallnetworkservices', { encoding: 'utf-8', timeout: 5000 });
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    // 过滤掉星号标记的已禁用接口
    const active = lines.filter(l => !l.startsWith('*') && !l.startsWith('An asterisk'));
    if (active.length > 0) return active[0];
  } catch (e) { /* ignore */ }

  return 'Wi-Fi'; // fallback
}

function getUpstreamDNS(iface) {
  if (process.env.UPSTREAM_DNS) return process.env.UPSTREAM_DNS;

  try {
    const out = execSync(`networksetup -getdnsservers "${iface}"`, { encoding: 'utf-8', timeout: 5000 });
    const servers = out.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('There'));
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
```

- [ ] **Step 2: 删除旧的 L79-L84 resolver 相关代码**

移除以下代码块：
```javascript
// ============================================================
// macOS Resolver 自动配置
// ============================================================
const RESOLVER_DIR = '/etc/resolver';
let resolverConfigured = false;
```

- [ ] **Step 3: 在启动前调用 ensureRoot**

在文件末尾 `server.bind(PORT, HOST)` 之前插入：

```javascript
// 提权（如需要）
ensureRoot();
```

- [ ] **Step 4: 验证配置加载正常**

```bash
node index.js
# 预期：打印加载的规则，然后弹出密码框（如果非 root）
# 输入密码后进程以 root 身份重新启动
```

---

### Task 2: 上游 UDP 透传 + 主请求处理逻辑改造

**Files:**
- Modify: `index.js` (L316-L366, the `server.on('message', ...)` handler)

**Interfaces:**
- Produces: `upstreamSocket` — persistent UDP socket for upstream forwarding
- Produces: `pendingUpstream` — `Map<string, {rinfo, dnsId, timer}>` tracking pending upstream queries
- Produces: `forwardToUpstream(msg, rinfo)` — forwards raw DNS query to upstream, relays response
- Modifies: `server.on('message', ...)` — unmanaged domains now forwarded instead of NXDOMAIN

- [ ] **Step 1: 在缓存代码段之后、主服务代码段之前，添加上游转发逻辑**

在 `cacheSet` 函数之后（L107 附近）插入：

```javascript
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
```

- [ ] **Step 2: 修改主请求处理逻辑，将未命中白名单的请求从 NXDOMAIN 改为 UDP 透传**

替换 L328-L332（`server.on('message', ...)` 内的非管理域名处理）：

原始代码：
```javascript
  if (!isManaged(req.name)) {
    console.log(`[x] 不在管理列表中，返回 NXDOMAIN`);
    server.send(buildNxDomain(req), rinfo.port, rinfo.address);
    return;
  }
```

替换为：
```javascript
  if (!isManaged(req.name)) {
    // 非管理域名：UDP 原样透传到上游 DNS
    forwardToUpstream(msg, rinfo);
    return;
  }
```

- [ ] **Step 3: 在 listening 事件日志中打印上游 DNS 和网络接口信息**

在 `server.on('listening', ...)` 的日志输出中（L375-L385）添加：

```javascript
console.log(`[*] 网络接口: ${NETWORK_INTERFACE}`);
console.log(`[*] 上游 DNS: ${UPSTREAM_DNS}`);
```

完整替换 L375-L386 为：

```javascript
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
```

- [ ] **Step 4: 测试上游透传**

```bash
# 启动后，在另一个终端测试一个非白名单域名
dig @127.0.0.1 -p 53 baidu.com A +short
# 预期：返回正常的 IP 地址（透传到上游 DNS 的结果）
```

---

### Task 3: networksetup 系统 DNS 设置 + 退出恢复 + 清理旧代码

**Files:**
- Modify: `index.js` — listening 事件后半段 + shutdown 函数

**Interfaces:**
- Modifies: `server.on('listening', ...)` — 替换 `/etc/resolver` 子进程为 `networksetup` 调用
- Modifies: `shutdown()` — 替换 `/etc/resolver` 清理为 `networksetup` 恢复

- [ ] **Step 1: 替换 listening 事件中的 resolver 配置逻辑**

删除从 `const resolverDomains = getResolverDomains();`（原 L373）到 `setupChild.on('exit', ...)`（原 L471）的整个 `/etc/resolver` 子进程代码块。

替换为：

```javascript
  // 设置系统 DNS 为本地代理
  try {
    execSync(`networksetup -setdnsservers "${NETWORK_INTERFACE}" 127.0.0.1`, { timeout: 10000 });
    console.log(`[*] 已将 ${NETWORK_INTERFACE} DNS 设置为 127.0.0.1`);
  } catch (e) {
    console.error(`[!] 设置系统 DNS 失败: ${e.message}`);
    console.error(`[!] 请手动执行: sudo networksetup -setdnsservers "${NETWORK_INTERFACE}" 127.0.0.1`);
  }
  console.log('');
```

- [ ] **Step 2: 替换 shutdown 函数中的清理逻辑**

将 `shutdown()` 函数（L478-L508）完整替换为：

```javascript
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[*] 收到 ${signal}，正在关闭...`);

  // 先关闭上游 socket，停止接受新请求
  try { upstreamSocket.close(); } catch (e) { /* ignore */ }

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
    console.error(`    或: networksetup -setdnsservers "${NETWORK_INTERFACE}" <你的原来的DNS>`);
  }

  console.log('[*] 已关闭');
  process.exit(0);
}
```

- [ ] **Step 3: 删除 `buildNxDomain` 函数（不再需要）**

`buildNxDomain` 位于原 L286-L293。非管理域名现在透传到上游 DNS，不再需要 NXDOMAIN 响应：

```javascript
// 删除以下整个函数：
// function buildNxDomain(req) {
//   const id = Buffer.alloc(2);
//   id.writeUInt16BE(req.id, 0);
//   const flags = Buffer.alloc(2);
//   flags.writeUInt16BE(0x8183, 0);
//   const counts = Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]);
//   return Buffer.concat([id, flags, counts, req.questionRaw]);
// }
```

> 注意：`getResolverDomains` 和 `{ fork }` → `{ execSync }` 已在 Task 1 中处理，此处无需重复。

- [ ] **Step 4: 验证完整流程**

```bash
# 启动服务（如果是非 root，会弹密码框）
sudo node index.js

# 另一个终端测试：
# 1. 检查系统 DNS 是否已修改
scutil --dns | head -20
# 预期：nameserver 显示 127.0.0.1

# 2. 测试白名单域名（走 DoH）
dig @127.0.0.1 -p 53 perf.qzz.io A +short
# 预期：返回真实 IP

# 3. 测试非白名单域名（透传）
dig @127.0.0.1 -p 53 baidu.com A +short
# 预期：返回正常 IP

# 4. 使用系统 resolver（验证全局生效）
# （此时系统 DNS 已指向 127.0.0.1:53）
ping -c 1 perf.qzz.io
# 预期：能 ping 通

# 5. Ctrl+C 退出
# 预期：打印恢复 DNS 的信息

# 6. 验证 DNS 已恢复
scutil --dns | head -20
# 预期：恢复为原来的 DNS 服务器
```

---

### Task 4: 文档更新

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 package.json**

```bash
# version 改为 2.0.0, description 更新
```

```json
{
  "name": "super-dns",
  "version": "2.0.0",
  "description": "系统级 DNS 代理，白名单域名走 DoH 防劫持，其余透传上游 DNS",
  "homepage": "https://github.com/jayli/super-dns#readme",
  "bugs": {
    "url": "https://github.com/jayli/super-dns/issues"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/jayli/super-dns.git"
  },
  "license": "ISC",
  "author": "",
  "type": "commonjs",
  "main": "index.js",
  "bin": {
    "super-dns": "index.js"
  },
  "scripts": {
    "start": "sudo node index.js",
    "test": "echo \"Error: no test specified\" && exit 1"
  }
}
```

- [ ] **Step 2: 更新 README.md**

将 `README.md` 替换为 v2 的主端口 53 + networksetup 版本的文档：

```markdown
# Super DNS

系统级 DNS 代理，白名单域名通过阿里云 DoH (DNS over HTTPS) 解析防劫持，其余域名原样透传到上游 DNS。

## 特性

- 🛡️ 白名单域名走阿里云 DoH，防 DNS 劫持
- 🔄 非白名单域名 UDP 原样透传上游 DNS，不影响正常解析
- 🎯 支持通配符配置（如 `*.qzz.io` 接管整个域）
- ⚡ 5 分钟本地缓存，减少重复查询
- 🍎 自动设置/恢复系统 DNS（通过 networksetup）
- 📦 零依赖，纯 Node.js 实现

## 快速开始

### 方式一：npx 直接运行

```bash
npx super-dns
```

### 方式二：全局安装

```bash
npm install -g super-dns
sudo super-dns
```

### 方式三：pm2 守护进程（推荐）

```bash
sudo pm2 start npx --name super-dns -- super-dns
sudo pm2 save
sudo pm2 startup
```

> **注意：** 因为需要监听 53 端口和修改系统 DNS 设置，必须以 root 权限运行。首次启动会弹出 macOS 密码框。

### 常用 pm2 命令

```bash
sudo pm2 logs super-dns    # 查看日志
sudo pm2 status            # 查看状态
sudo pm2 restart super-dns # 重启服务
sudo pm2 stop super-dns    # 停止服务
sudo pm2 delete super-dns  # 删除服务
```

## 配置域名

编辑 `~/.config/super-dns/domains`，每行一个域名：

```
# 通配符：接管 qzz.io 及所有子域名
*.qzz.io

# 精确匹配：只接管这一个域名
example.com
```

支持 `#` 开头的注释行。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DOH_BASE` | `https://dns.alidns.com/resolve` | DoH 服务地址 |
| `CACHE_TTL` | `300000` | 缓存时间（毫秒），默认 5 分钟 |
| `UPSTREAM_DNS` | 自动检测 | 上游 DNS 服务器（非白名单域名透传目标） |
| `NETWORK_INTERFACE` | 自动检测 | 网络接口名（如 Wi-Fi、Ethernet） |

## 工作原理

1. 以 root 权限监听 UDP 53 端口
2. 通过 `networksetup` 将系统 DNS 设置为 `127.0.0.1`
3. 所有本机 DNS 请求路由到本地代理
4. 命中白名单的域名 → 阿里云 DoH 解析 → 缓存 → 返回
5. 未命中的域名 → UDP 原样转发到上游 DNS → 返回
6. 退出时自动恢复系统 DNS

## 退出清理

- `Ctrl+C` (SIGINT) 或 `kill` (SIGTERM) 触发优雅退出
- 自动执行 `networksetup -setdnsservers <iface> Empty` 恢复 DNS
```

- [ ] **Step 3: 更新 CLAUDE.md**

将 CLAUDE.md 的第 10-17 行（"The two approaches" 部分之前）和架构笔记中与 port/resolver 相关的内容更新为 v2：

替换 L10-L17：

```markdown
**1. `index.js` — 系统级 DNS 代理（主产品，作为 `super-dns` 发布到 npm）**
- 以 root 权限运行 UDP DNS 服务在 `127.0.0.1:53`，手写 DNS 报文协议（解析请求 → 构建响应 / 透传）；无 DNS 库依赖。
- 启动时通过 `networksetup -setdnsservers` 将系统 DNS 指向本地代理，使**整个系统**（浏览器、curl、ping、Node、Python）的 DNS 请求经过该代理。退出时恢复。
- 命中白名单的域名走阿里 DoH 解析并缓存；未命中的域名**UDP 原样透传**到上游 DNS（启动时自动从系统读取，可 `UPSTREAM_DNS` 环境变量覆盖）。
- 只处理 **A / AAAA** 查询；其他类型对管理域名返回空回答。
```

替换架构笔记中关于端口和 resolver 的条目：

```markdown
- **53 端口需 root 权限**：通过 osascript GUI 弹密码框，写临时 shell 脚本用 sudo 重启自身。
- **`networksetup` 设置系统 DNS**：将当前活跃网络接口的 DNS 服务器设为 `127.0.0.1`，退出时 `Empty` 恢复。无需 `/etc/resolver` 文件。
- **上游 DNS 透传**：非白名单域名通过持久 UDP socket 原样转发到上游 DNS（启动时 `networksetup -getdnsservers` 读取），零开销不回写报文。用 `(clientAddr, clientPort, dnsId)` 元组匹配响应，5s 超时清理。
- **DNS-answer TTL 固定为 300s**：`buildResponse` 中 `uint32(300)`，与 `CACHE_TTL` 独立。
- **`/etc/resolver/` 不再使用**：改为全局系统 DNS 代理，不再按域名写解析器文件。
```

删除或更新以下过时的 gotchas：
- "Port 15353, not 5353" → "Port 53, root required via osascript elevation"
- "`/etc/resolver/` scope" → "`networksetup -setdnsservers` affects system-resolver consumers"

- [ ] **Step 4: Commit**

```bash
git add index.js package.json README.md CLAUDE.md
git commit -m "feat: upgrade to v2 — system-wide DNS proxy on port 53 with upstream forwarding

- Listen on port 53 (root via osascript elevation)
- Replace /etc/resolver with networksetup for system DNS
- Forward unmanaged domains via raw UDP to upstream DNS
- Auto-detect active network interface and upstream DNS
- Remove getResolverDomains, buildNxDomain, old resolver code

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
```

