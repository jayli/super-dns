# CLAUDE.md

This file provides guidance when working with this repository.

## Overview

Super DNS is a macOS `/etc/hosts` maintenance daemon. It no longer runs a DNS proxy, does not listen on port 53, does not use pf, and does not change system DNS servers.

The foreground command is a small CLI controller. When administrator permission is needed, it uses `osascript ... with administrator privileges` to show the macOS authorization dialog, then starts a root background daemon. The daemon resolves exact domains from `~/.config/super-dns/domains` through Alibaba Cloud DoH and writes the results into a managed `/etc/hosts` block.

## Commands

```bash
# Start. Same behavior for both commands.
super-dns
super-dns start

# Stop the root daemon and clean managed hosts records.
super-dns stop

# Stop and start again.
super-dns restart

# Local development
node index.js
node index.js stop
node index.js restart

# Tests
npm test
node --check index.js

# Logs
tail -f /tmp/super-dns.log
```

If `super-dns` or `super-dns start` is executed while the daemon is already running, the CLI prints a colored status summary and shows a three-item menu:

```text
> 重启
  关闭
  退出
```

The default selection is `重启`. Arrow-key movement only redraws the menu rows to avoid terminal flicker.

## Startup Output

On a fresh start, the foreground controller:

1. Prints that administrator permission is required.
2. Shows the macOS authorization dialog through `osascript`.
3. Starts the root background daemon.
4. Waits for the first DoH update cycle to finish.
5. Prints a startup summary.
6. Exits, leaving the root daemon running.

The startup summary includes root status, config path, hosts write permission, monitored domain count, DoH result, hosts write result, DNS cache flush, polling interval, and log path. These key lines are green in terminal output:

- `程序已经启动`
- `开始执行 DoH 更新`
- `监控开始运行`

The detailed timestamped output is written to `/tmp/super-dns.log`.

## Architecture

`index.js` is a single-file implementation:

- CLI controller for `start`, `stop`, `restart`, and the already-running menu
- macOS administrator authorization through `osascript`
- root background daemon launch
- single-instance detection through `ps ax -o pid= -o user= -o command=`
- colored terminal status output using ANSI escape codes, with plain output for non-TTY
- 500-line bounded logger writing `/tmp/super-dns.log`
- domain file loading from `~/.config/super-dns/domains`
- DoH A-record lookup
- `/etc/hosts` managed block replacement
- DNS cache flushing
- 300-second polling by default
- `fs.watchFile` dynamic config reload
- SIGINT/SIGTERM cleanup

## Important Behavior

Only exact domains are written to `/etc/hosts`. Wildcard entries such as `*.qzz.io` are loaded, shown in summaries, logged, and skipped because `/etc/hosts` does not support wildcard matching.

The daemon owns only this block:

```text
# BEGIN super-dns
221.223.177.133 perf.qzz.io
# END super-dns
```

Do not edit or rewrite unrelated parts of `/etc/hosts`.

When hosts changes, the daemon runs:

```bash
dscacheutil -flushcache
killall -HUP mDNSResponder
```

On `SIGINT` or `SIGTERM`, the daemon removes the managed hosts block, flushes DNS cache, and exits.

## Configuration

Domain file:

```text
~/.config/super-dns/domains
```

Format:

```text
# comments are supported
perf.qzz.io
api.qzz.io
*.qzz.io
```

## Environment Variables

- `DOH_BASE` default: `https://dns.alidns.com/resolve`
- `POLL_INTERVAL` default: `300000` ms
- `SUPER_DNS_HOME` internal: preserves the original user home when the root daemon is launched through `osascript`
- `SUPER_DNS_LAUNCH_ID` internal: marks one startup in `/tmp/super-dns.log` so the foreground controller prints only this launch's summary

## Tests

Tests are source-level behavior guards in `test/`:

- `start`, `stop`, `restart`, and already-running menu behavior
- Colored running summary before the menu
- No DNS proxy, dgram socket, pf, or `networksetup -setdnsservers`
- No legacy `SUPER_DNS_SERVICE` root child control
- Hosts block management exists
- Poll interval is 300 seconds
- Domain file changes trigger immediate update
- Log file is capped at 500 lines
