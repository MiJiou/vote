#!/bin/bash
# 在 macOS 上啟動開票看板：在 Finder 裡雙擊這個檔案即可。
# 第一次執行會安裝套件、建置網頁、建立設定檔（.env）；之後每次直接啟動。
# 伺服器意外停止時會在 3 秒後自動重啟；開著這個視窗期間電腦不會進入睡眠。
set -u
cd "$(dirname "$0")/.." || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 Node.js。請先到 https://nodejs.org/ 下載安裝 22 版（LTS），再重新執行。"
  read -r -p "按 Enter 結束…" _
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  echo "Node.js 版本太舊（目前 $(node -v)），需要 22.18 以上。請到 https://nodejs.org/ 更新。"
  read -r -p "按 Enter 結束…" _
  exit 1
fi

if [ ! -f .env ]; then
  echo "第一次執行：建立設定檔。"
  while true; do
    read -r -s -p "請設定管理員密碼（至少 8 個字元）：" pw; echo
    [ ${#pw} -ge 8 ] && break
    echo "密碼太短，請重新輸入。"
  done
  {
    echo "PORT=3000"
    echo "HOST=127.0.0.1"
    echo "ADMIN_USER=admin"
    echo "ADMIN_PASSWORD=$pw"
    echo "COOKIE_SECURE=1"
    echo "TRUST_PROXY=1"
    echo "EDGE_CACHE_SECONDS=2"
  } > .env
  chmod 600 .env
  echo "已建立 .env（管理員帳號：admin）。"
fi

if [ ! -d node_modules ]; then
  echo "安裝套件中（第一次約需 1–2 分鐘）…"
  npm ci || { read -r -p "安裝失敗，按 Enter 結束…" _; exit 1; }
fi
if [ ! -f web/dist/index.html ] || [ -n "$(find web/src -newer web/dist/index.html -print -quit)" ]; then
  echo "建置網頁中…"
  npm run build || { read -r -p "建置失敗，按 Enter 結束…" _; exit 1; }
fi

echo "啟動中。關閉這個視窗或按 Ctrl+C 會停止看板。"
while true; do
  caffeinate -dims node --disable-warning=ExperimentalWarning --env-file=.env server/index.ts
  echo "伺服器停止了，3 秒後自動重啟（按 Ctrl+C 可結束）…"
  sleep 3
done
