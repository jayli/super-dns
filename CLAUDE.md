# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Super DNS is a system-wide DNS proxy for macOS that prevents DNS hijacking. It listens directly on `127.0.0.1:53`. Whitelisted domains (configured in `~/.config/super-dns/domains`) are resolved via Alibaba Cloud's DoH (DNS over HTTPS); all other domains are forwarded raw to the upstream DNS server unchanged.

## Commands

```bash
# Start the DNS server (uses osascript to launch a root child for port 53)
npm start
# or interactive menu
super-dns

# Direct commands
super-dns start
super-dns end

# Test DNS resolution
dig @127.0.0.1 perf.qzz.io A +short
dig @127.0.0.1 baidu.com A +short

# Verify system DNS is pointed to local proxy
networksetup -getdnsservers Wi-Fi

# Test with system resolver (ping, curl, browsers)
ping perf.qzz.io
curl -k https://perf.qzz.io:8443/

# Graceful shutdown
super-dns end
```

## Architecture

**Single-file design**: Everything is in `index.js` (~510 lines), organized into logical sections:
- Configuration (lines 1-18)
- Privileged operations via osascript: `sudoExec()` (lines 20-29)
- System network detection and upstream DNS reading (lines 30-85)
- Domain loading (lines 85-122)
- DNS caching with TTL (lines 124-146)
- Upstream DNS UDP forwarding (lines 148-178)
- DoH querying to Alibaba Cloud (lines 180-205)
- Hand-rolled DNS packet parsing/building (lines 207-358)
- Domain matching (lines 360-373)
- UDP server and request handling (lines 375-471)
- Graceful shutdown with pf/DNS cleanup (lines 473-513)

**Key design decisions**:
- Zero dependencies - pure Node.js implementation
- Root child binds directly to `127.0.0.1:53`
- Uses `osascript` for one-time privilege elevation (macOS GUI password dialog)
- `networksetup -setdnsservers` replaces `/etc/resolver` — entire system DNS points to 127.0.0.1
- Hand-rolled DNS protocol implementation (no external DNS library)
- Upstream loopback guard: skips upstream DNS servers starting with `127.` to prevent forwarding loops
- Node v26 compat: uses `Buffer.from(buf.subarray(...))` instead of deprecated `buf.slice()`

**Transparent proxy for DoH**: `https.get` internally calls `dns.lookup` → system DNS → proxy → forwarded to upstream → response → HTTPS connection established. No special DoH DNS resolution needed.

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

**System DNS via networksetup**: On startup, `networksetup -setdnsservers <iface> 127.0.0.1` redirects all system DNS to the proxy.

**Upstream DNS forwarding**: Non-whitelisted domains are forwarded as raw UDP to the upstream DNS server (auto-detected from system settings, fallback `114.114.114.114`). Loopback addresses (`127.x.x.x`) are skipped to prevent forwarding dead loops. Responses are matched by DNS transaction ID and relayed back. 5s timeout for pending upstream queries.

**Whitelist-only caching**: Only whitelisted domain DoH responses are cached. Upstream-forwarded responses are not cached.

**Startup auth dialog**: `super-dns start` shows one macOS GUI password dialog to launch the root child process. The root child listens on `127.0.0.1:53` and configures system DNS.

**CLI control**: `super-dns start` starts the background service, `super-dns end` stops it and restores DNS. `super-dns` or `npm start` opens a two-item menu whose first item is the safe default action for the current service state.

**Service log**: The root child writes `/tmp/super-dns.log` through the internal bounded logger. The log file keeps at most 500 lines.

**dig/nslookup bypass**: These tools read network preferences directly. To test through the proxy, use `dig @127.0.0.1 <domain>`.

**Manual cleanup** (if process exits abnormally):
```bash
sudo networksetup -setdnsservers Wi-Fi Empty
```
