# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Super DNS is a system-wide DNS proxy for macOS that prevents DNS hijacking. It listens on port 53 and intercepts all DNS queries from the system. Whitelisted domains (configured in `~/.config/super-dns/domains`) are resolved via Alibaba Cloud's DoH (DNS over HTTPS); all other domains are forwarded raw to the upstream DNS server unchanged.

## Commands

```bash
# Start the DNS server (requires root for port 53)
sudo node index.js
# or
npm start

# Test DNS resolution
dig @127.0.0.2 -p 53 perf.qzz.io A +short
dig @127.0.0.2 -p 53 baidu.com A +short

# Verify system DNS is pointed to local proxy
scutil --dns | head -20
networksetup -getdnsservers Wi-Fi

# Test with system resolver (works for ping, curl, browsers once DNS is set)
ping perf.qzz.io
curl -k https://perf.qzz.io:8443/

# Graceful shutdown (auto-restores DNS)
# Press Ctrl+C or: kill -TERM <PID>
```

## Architecture

**Single-file design**: Everything is in `index.js` (~530 lines), organized into logical sections:
- Configuration and domain loading (lines 1-30)
- Root elevation via osascript (lines 30-90)
- System network detection and upstream DNS reading (lines 90-130)
- DNS caching with TTL (lines 130-180)
- Upstream DNS UDP forwarding (lines 180-220)
- DoH querying to Alibaba Cloud (lines 220-280)
- Hand-rolled DNS packet parsing/building (lines 280-440)
- UDP server and request handling (lines 440-510)
- Graceful shutdown with DNS restore (lines 510-540)

**Key design decisions**:
- Zero dependencies - pure Node.js implementation
- Uses `osascript` for privilege elevation (macOS GUI password prompt instead of terminal)
- Lock file (`/tmp/super-dns-elevate.lock`) prevents repeated elevation dialogs
- Shell script uses `nohup &` so osascript returns and parent exits cleanly
- Hand-rolled DNS protocol implementation (no external DNS library)
- Binds to `127.0.0.2:53` to avoid conflicting with macOS `mDNSResponder` on `127.0.0.1:53`
- `networksetup -setdnsservers` replaces `/etc/resolver` — entire system DNS points to 127.0.0.2

**Configuration file**: `~/.config/super-dns/domains`
- One domain per line, supports `#` comments
- Wildcard syntax: `*.qzz.io` matches `qzz.io` and all subdomains
- Exact match: `example.com` matches only that domain

**Environment variables**:
- `PORT` (default: 53) - DNS server port
- `HOST` (default: 127.0.0.1) - bind address
- `DOH_BASE` (default: https://dns.alidns.com/resolve) - DoH endpoint
- `CACHE_TTL` (default: 300000) - cache duration in ms
- `UPSTREAM_DNS` - override upstream DNS (auto-detected via networksetup)
- `NETWORK_INTERFACE` - override network interface name

## Important Notes

**Port 53 requires root**: On first launch a macOS GUI password dialog appears. The elevated process runs `nohup` in background and logs to `/tmp/super-dns.log`.

**System DNS via networksetup**: On startup, `networksetup -setdnsservers <iface> 127.0.0.2` redirects all system DNS to the proxy (using `127.0.0.2` to avoid mDNSResponder's `127.0.0.1` binding).

**Upstream DNS forwarding**: Non-whitelisted domains are forwarded as raw UDP to the upstream DNS server (auto-detected from system settings, fallback `114.114.114.114`). Responses are matched by DNS transaction ID and relayed back. 5s timeout for pending upstream queries.

**Whitelist-only caching**: Only whitelisted domain DoH responses are cached. Upstream-forwarded responses are not cached.

**Lock file**: `/tmp/super-dns-elevate.lock` prevents concurrent elevation attempts. Stale after 30s. Root process cleans it on startup.

**pm2 usage**: Start with `sudo pm2 start` — the process is already root, no elevation dialog needed.

**dig/nslookup bypass**: These tools read network preferences directly. To test, point them explicitly: `dig @127.0.0.2 -p 53 <domain>`.
