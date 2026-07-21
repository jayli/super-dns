# Super DNS

本机 hosts 维护守护进程。程序以 root 常驻运行，定时通过阿里云 DoH 查询配置域名的 A 记录，并维护 `/etc/hosts` 中由 super-dns 管理的区块。

## 启动

```bash
sudo node index.js
```

推荐交给 pm2 管理 root 常驻进程。程序自身不再提供 `start/end` 命令和菜单。

重复启动时，如果检测到同一个 `index.js` 已在运行，会输出：

```text
已经在运行了
```

## 配置

域名列表：

```text
~/.config/super-dns/domains
```

示例：

```text
perf.qzz.io
api.qzz.io
*.qzz.io
```

当前 hosts 模式只会写入精确域名。通配符规则会被加载并记录日志，但不会写入 `/etc/hosts`，因为 hosts 不支持通配符。

## 工作方式

程序只维护 `/etc/hosts` 中这一段：

```text
# BEGIN super-dns
221.223.177.133 perf.qzz.io
# END super-dns
```

每次更新流程：

1. 读取 `~/.config/super-dns/domains`
2. 跳过通配符，保留精确域名
3. 通过 DoH 查询 A 记录
4. 结果变化时更新 `/etc/hosts`
5. 执行 `dscacheutil -flushcache`
6. 执行 `killall -HUP mDNSResponder`

默认每 300 秒轮询一次。配置文件发生变化后，会立即触发一次更新。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DOH_BASE` | `https://dns.alidns.com/resolve` | DoH 查询地址 |
| `POLL_INTERVAL` | `300000` | 轮询间隔，单位毫秒 |

## 日志

日志路径：

```text
/tmp/super-dns.log
```

最多保留 500 行。

## 停止

使用进程管理器停止即可，例如 pm2 stop。程序收到 `SIGINT` 或 `SIGTERM` 后，会清理 `/etc/hosts` 中的 super-dns 区块并刷新 DNS 缓存。
