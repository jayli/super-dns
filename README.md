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

> 因为需要监听 53 端口和修改系统 DNS，必须以 root 运行。首次启动弹出 macOS 密码框授权。

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
2. 通过 `networksetup` 将系统 DNS 设置为 `127.0.0.2`（避开 mDNSResponder）
3. 所有本机 DNS 请求路由到本地代理
4. 命中白名单的域名 → 阿里云 DoH 解析 → 缓存 → 返回
5. 未命中的域名 → UDP 原样转发到上游 DNS → 返回
6. 退出时自动恢复系统 DNS

## 退出清理

- `Ctrl+C` (SIGINT) 或 `kill` (SIGTERM) 触发优雅退出
- 自动执行 `networksetup -setdnsservers <iface> Empty` 恢复 DNS
