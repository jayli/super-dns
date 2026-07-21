# Super DNS

macOS 本机 hosts 维护守护进程。它通过 DoH 解析指定域名，并维护 `/etc/hosts` 中由 super-dns 管理的记录，避免目标域名被本机其他 DNS 模块抢答污染。

当前版本不运行 DNS 代理，不监听 53 端口，不使用 pf，也不修改系统 DNS 服务器。

## 安装后命令

```bash
# 启动，两个命令等价
super-dns
super-dns start

# 关闭 root 守护进程，并清理 /etc/hosts 中的 super-dns 区块
super-dns stop

# 重启 root 守护进程
super-dns restart
```

本地开发时也可以直接执行：

```bash
node index.js
node index.js stop
node index.js restart
```

## 启动流程

执行 `super-dns` 或 `super-dns start` 时：

1. 普通用户前台进程启动
2. 通过 macOS 系统授权弹窗请求管理员权限
3. 授权后启动 root 后台守护进程
4. root 进程执行首轮 DoH 解析
5. 将解析结果写入 `/etc/hosts`
6. 刷新本机 DNS 缓存
7. 前台进程输出启动摘要后退出
8. root 后台进程继续常驻运行

前台进程退出是正常行为，真正工作的进程是 root 后台守护进程。

## 已运行菜单

如果服务已经在运行，再执行：

```bash
super-dns
```

会先显示运行摘要：

- 程序是否正在运行
- root 进程 PID
- 正在监控多少个精确域名
- 更新频率
- 配置文件路径
- 日志文件路径
- 是否发现最近错误

然后显示菜单：

```text
> 重启
  关闭
  退出
```

默认光标停在 `重启`，按回车会直接重启服务。上下键选择时只刷新菜单行，避免整屏闪烁。

## 颜色说明

终端支持颜色时会显示关键信息：

- 绿色：程序正在运行、程序已经启动、开始执行 DoH 更新、监控开始运行、无最近错误
- 黄色：通配符域名跳过、最近日志中有告警
- 红色：配置读取失败等错误

非 TTY 输出时会自动关闭颜色，便于脚本处理。

## 配置

域名列表：

```text
~/.config/super-dns/domains
```

示例：

```text
# 每行一个域名，支持 # 注释
perf.qzz.io
api.qzz.io
*.qzz.io
```

当前 hosts 模式只会写入精确域名。通配符规则会被加载、显示和记录日志，但不会写入 `/etc/hosts`，因为 hosts 不支持通配符。

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
3. 通过阿里云 DoH 查询 A 记录
4. 结果变化时更新 `/etc/hosts`
5. 执行 `dscacheutil -flushcache`
6. 执行 `killall -HUP mDNSResponder`

默认每 300 秒轮询一次。配置文件发生变化后，会立即触发一次更新。

## 日志

日志路径：

```text
/tmp/super-dns.log
```

最多保留 500 行。

查看日志：

```bash
tail -f /tmp/super-dns.log
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DOH_BASE` | `https://dns.alidns.com/resolve` | DoH 查询地址 |
| `POLL_INTERVAL` | `300000` | 轮询间隔，单位毫秒 |

## 停止

推荐使用：

```bash
super-dns stop
```

程序收到 `SIGINT` 或 `SIGTERM` 后，会清理 `/etc/hosts` 中的 super-dns 区块并刷新 DNS 缓存。

## 测试

```bash
npm test
node --check index.js
```
