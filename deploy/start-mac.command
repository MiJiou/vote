#!/bin/bash
# 在 macOS 上啟動開票看板：在 Finder 裡雙擊這個檔案即可（實際流程在 deploy/launcher.mjs）。
# 開著這個視窗期間電腦不會進入睡眠。
cd "$(dirname "$0")/.." || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 Node.js。請先到 https://nodejs.org/ 下載安裝 22 版（LTS），再重新執行。"
  read -r -p "按 Enter 結束…" _
  exit 1
fi
caffeinate -dims node deploy/launcher.mjs
read -r -p "看板已停止。按 Enter 關閉視窗…" _
