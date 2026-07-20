# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Super DNS is a local DNS proxy server for macOS that prevents DNS hijacking by routing specific domains through Alibaba Cloud's DoH (DNS over HTTPS). It automatically configures macOS's `/etc/resolver/` mechanism for per-domain DNS routing.

## Commands

```bash
# Start the DNS server
node index.js
# or
npm start

# Test DNS resolution (must specify server and port explicitly)
dig @127.0.0.1 -p 15353 perf.qzz.io A +short
dig @127.0.0.1 -p 15353 perf.qzz.io AAAA +short

# Verify macOS system resolver is configured
scutil --dns | grep -A 5 "qzz.io"
cat /etc/resolver/qzz.io

# Test with system resolver (works for ping, curl, browsers)
ping perf.qzz.io
curl -k https://perf.qzz.io:8443/

# Graceful shutdown (auto-cleans resolver files)
# Press Ctrl+C or: kill -TERM <PID>
```

## Architecture

**Single-file design**: Everything is in `index.js` (~500 lines), organized into logical sections:
- Configuration and domain loading (lines 1-90)
- macOS resolver setup/cleanup using `osascript` (lines 90-150)
- DNS caching with TTL (lines 150-180)
- DoH querying to Alibaba Cloud (lines 180-210)
- Hand-rolled DNS packet parsing/building (lines 210-380)
- UDP server and request handling (lines 380-440)
- Graceful shutdown (lines 440-500)

**Key design decisions**:
- Zero dependencies - pure Node.js implementation
- Uses `osascript` for sudo operations (macOS GUI password prompt instead of terminal)
- Resolver setup runs in a child process via `fork()` to avoid blocking DNS server
- Resolver files are `chown`'d to current user during setup so cleanup doesn't require sudo
- Hand-rolled DNS protocol implementation (no external DNS library)

**Configuration file**: `~/.config/super-dns/domains`
- One domain per line, supports `#` comments
- Wildcard syntax: `*.qzz.io` matches `qzz.io` and all subdomains
- Exact match: `example.com` matches only that domain

**Environment variables**:
- `PORT` (default: 15353) - DNS server port
- `HOST` (default: 127.0.0.1) - bind address
- `DOH_BASE` (default: https://dns.alidns.com/resolve) - DoH endpoint
- `CACHE_TTL` (default: 300000) - cache duration in ms

## Important Notes

**macOS `/etc/resolver/` behavior**:
- Only affects system resolvers: browsers, ping, curl, Node.js, Python
- Does NOT affect: `dig`, `nslookup` (they read from network preferences directly)
- To test with `dig`, must explicitly specify: `dig @127.0.0.1 -p 15353 <domain>`
- To make `dig` use local DNS by default, create `~/.digrc` with `server 127.0.0.1\nport 15353`

**Port selection**: Default port is 15353 (not 5353) because 5353 is often occupied by mDNS services (Chrome, adb).

**Resolver cleanup**: On SIGTERM/SIGINT, the server deletes `/etc/resolver/` files. This uses `fs.unlinkSync()` first (files are owned by current user), falling back to `sudoExec()` if needed.

**SSL certificate trust**: If accessing HTTPS services with self-signed or mismatched certificates, trust the cert system-wide:
```bash
echo | openssl s_client -connect <IP>:<PORT> -servername <domain> 2>/dev/null | openssl x509 -outform PEM > /tmp/cert.pem
security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db /tmp/cert.pem
```
Then clear Chrome HSTS cache at `chrome://net-internals/#hsts`.
