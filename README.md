# Super DNS

本地 DNS 代理服务器，通过阿里云 DoH (DNS over HTTPS) 解析域名，防止 DNS 劫持。

## 特性

- 🛡️ 通过阿里云 DoH 解析，防 DNS 劫持
- 🎯 支持通配符配置（如 `*.qzz.io` 接管整个域）
- ⚡ 5 分钟本地缓存，减少重复查询
- 🍎 macOS 独立解析器自动配置/清理
- 📦 零依赖，纯 Node.js 实现

## 快速开始

### 方式一：npx 直接运行（无需安装）

```bash
npx super-dns
```

### 方式二：全局安装

```bash
npm install -g super-dns
super-dns
```

首次启动会自动创建配置文件 `~/.config/super-dns/domains`，并弹出密码框配置 macOS 独立解析器。

### 方式三：pm2 守护进程（推荐生产使用）

```bash
# 用 pm2 启动
pm2 start npx --name super-dns -- super-dns

# 保存进程列表
pm2 save

# 设置开机自启（按提示执行输出的命令）
pm2 startup
```

**常用 pm2 命令：**

```bash
pm2 logs super-dns    # 查看日志
pm2 status            # 查看状态
pm2 restart super-dns # 重启服务
pm2 stop super-dns    # 停止服务
pm2 delete super-dns  # 删除服务
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
| `PORT` | `15353` | DNS 服务监听端口 |
| `HOST` | `127.0.0.1` | DNS 服务监听地址 |
| `DOH_BASE` | `https://dns.alidns.com/resolve` | DoH 服务地址 |
| `CACHE_TTL` | `300000` | 缓存时间（毫秒），默认 5 分钟 |

## 工作原理

1. 启动 UDP DNS 服务监听在 `127.0.0.1:15353`
2. 自动在 `/etc/resolver/` 下创建 macOS 独立解析器配置
3. 收到 DNS 请求后，检查域名是否在管理列表中
4. 命中的域名通过阿里云 DoH 查询真实 IP 并返回
5. 退出时自动清理 `/etc/resolver/` 配置

## 退出清理

- `Ctrl+C` (SIGINT) 或 `kill` (SIGTERM) 触发优雅退出
- 自动删除 `/etc/resolver/` 下的配置文件
- 可能需要输入一次密码（osascript 弹窗）

