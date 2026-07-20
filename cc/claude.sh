#!/usr/bin/env bash
# 启动 Claude Code，注入 DNS-over-HTTPS patch
# 让 claude 进程及其子进程中的 *.qzz.io 域名走阿里云 DoH 解析
#
# 用法:
#   ./claude.sh              # 启动 claude
#   ./claude.sh --resume     # 带参数启动 claude
#   ./claude.sh --block      # 通过 block-cc 代理启动 claude
#
# 也适用于任何需要 DoH 的 Node.js 命令行工具:
#   node --require "$DOH_PATCH" your-script.js

set -euo pipefail

# 解析脚本所在目录 (支持 symlink)
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

DOH_PATCH="$SCRIPT_DIR/doh-patch.js"

if [ ! -f "$DOH_PATCH" ]; then
  echo "Error: $DOH_PATCH not found" >&2
  exit 1
fi

export NODE_OPTIONS="--require $DOH_PATCH ${NODE_OPTIONS:-}"
export CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1
export NODE_NO_WARNINGS=1


echo ""
if [ "${1:-}" = "--block" ]; then
  shift
  exec block-cc claude "$@"
else
  exec claude "$@"
fi
