# Super DNS

系统级 DNS 代理，白名单域名通过阿里云 DoH (DNS over HTTPS) 解析防劫持，其余域名 UDP 透传到上游 DNS。

## 特性

- 白名单域名走阿里云 DoH，防 DNS 劫持
- 非白名单域名 UDP 原样透传上游 DNS，不影响正常解析
- 支持通配符配置（如 `*.qzz.io` 接管整个域）
- 5 分钟本地缓存，减少重复查询
- 自动设置/恢复系统 DNS（通过 networksetup）
- 直接监听本机 DNS 端口，避免 pf loopback 转发问题
- 零依赖，纯 Node.js 实现

## 快速开始

```bash
# 交互菜单：根据服务状态显示启动或关闭选项
npm start
# 或
super-dns

# 直接启动/关闭
super-dns start
super-dns end
```

启动时需要一次管理员授权（macOS GUI 密码框），用于：
1. 启动 root 子进程监听 `127.0.0.1:53`
2. 设置系统 DNS 为 `127.0.0.1`

> 服务直接监听系统 DNS 端口 53，不再依赖 pf loopback 端口转发。

### 菜单行为

- 服务未运行时：默认选中 `启动服务`，第二项是 `退出`
- 服务正在运行时：默认选中 `关闭服务`，第二项是 `退出`
- 方向键切换，Enter 确认，`q` 退出

## 配置域名

编辑 `~/.config/super-dns/domains`，每行一个域名：

```
# 通配符：接管 qzz.io 及所有子域名
*.qzz.io

# 精确匹配：只接管这一个域名
example.com
```

支持 `#` 开头的注释行。

## 测试

```bash
# 直接测试代理
dig @127.0.0.1 perf.qzz.io A +short
dig @127.0.0.1 baidu.com A +short

# 测试系统 DNS 解析
ping perf.qzz.io
curl http://perf.qzz.io:1314/
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `53` | DNS 代理监听端口 |
| `DOH_BASE` | `https://dns.alidns.com/resolve` | DoH 服务地址 |
| `CACHE_TTL` | `300000` | 缓存时间（毫秒），默认 5 分钟 |
| `UPSTREAM_DNS` | 自动检测 | 上游 DNS 服务器（非白名单域名透传目标） |
| `NETWORK_INTERFACE` | 自动检测 | 网络接口名（如 Wi-Fi、Ethernet） |

## 工作原理

1. 通过 osascript 弹框获取一次性管理员授权
2. root 子进程监听 `127.0.0.1:53` (UDP)
3. 设置系统 DNS 为 `127.0.0.1`（通过 networksetup）
4. 命中白名单的域名 → 阿里云 DoH 解析 → 缓存 → 返回
5. 未命中的域名 → UDP 原样转发到上游 DNS → 返回
6. 退出时自动恢复系统 DNS

## 退出清理

- `super-dns end` 关闭后台服务并恢复系统 DNS
- 自动恢复系统 DNS：`networksetup -setdnsservers <iface> Empty`
- PID 文件：`/tmp/super-dns.pid`
- 日志文件：`/tmp/super-dns.log`，最多保留 500 行

## 手动清理

如果进程异常退出（未触发清理逻辑），手动执行：

```bash
# 恢复 DNS
sudo networksetup -setdnsservers Wi-Fi Empty

```
