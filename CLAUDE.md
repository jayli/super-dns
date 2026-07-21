# CLAUDE.md

This file provides guidance when working with this repository.

## Overview

Super DNS is now a root-only hosts maintenance daemon for macOS. It does not run a DNS proxy, does not listen on port 53, and does not use pf. It periodically resolves exact domains from `~/.config/super-dns/domains` through Alibaba Cloud DoH and writes the results into a managed `/etc/hosts` block.

## Commands

```bash
# Run directly as root
sudo node index.js

# Tests
npm test
node --check index.js

# Logs
tail -f /tmp/super-dns.log
```

The program no longer supports `super-dns start`, `super-dns end`, or an interactive menu. Process lifetime is expected to be managed externally, for example by pm2 running as root.

## Architecture

`index.js` is a single-file daemon:

- Configuration and constants
- 500-line bounded logger writing `/tmp/super-dns.log`
- Single-instance detection through `ps ax -o pid= -o command=`
- Domain file loading from `~/.config/super-dns/domains`
- DoH A-record lookup
- `/etc/hosts` block replacement
- DNS cache flushing
- 300-second polling
- `fs.watchFile` dynamic config reload
- SIGINT/SIGTERM cleanup

## Important Behavior

Only exact domains are written to `/etc/hosts`. Wildcard entries such as `*.qzz.io` are logged and skipped because `/etc/hosts` does not support wildcard matching.

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

On SIGINT/SIGTERM, the daemon removes the managed hosts block, flushes DNS cache, and exits.

## Environment Variables

- `DOH_BASE` default: `https://dns.alidns.com/resolve`
- `POLL_INTERVAL` default: `300000` ms

## Tests

Tests are source-level behavior guards in `test/`:

- No legacy CLI/menu/start/end behavior
- No DNS proxy, dgram socket, pf, or `networksetup -setdnsservers`
- Hosts block management exists
- Poll interval is 300 seconds
- Domain file changes trigger immediate update
- Log file is capped at 500 lines
