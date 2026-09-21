#!/usr/bin/env bash
# 从几何图形生成 App 图标：PNG → .icns（含 Retina 各尺寸）
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${PYTHON:-/Users/ramon/.workbuddy/binaries/python/versions/3.13.12/bin/python3}"
"$PY" tools/make-icon.py build

if command -v iconutil >/dev/null 2>&1; then
  iconutil -c icns build/icon.iconset -o build/icon.icns
  echo "wrote build/icon.icns"
else
  echo "iconutil 不可用（非 macOS），跳过 .icns 合成" >&2
fi
