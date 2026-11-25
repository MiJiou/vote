@echo off
rem 在 Windows 上啟動開票看板：在檔案總管裡雙擊這個檔案即可。
rem 第一次執行會安裝套件、建置網頁、建立設定檔（.env）；之後每次直接啟動。
rem 伺服器意外停止時會在 3 秒後自動重啟。
chcp 65001 >nul
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node.js。請先到 https://nodejs.org/ 下載安裝 22 版（LTS），再重新執行。
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)"
if errorlevel 1 (
  echo Node.js 版本太舊，需要 22.18 以上。請到 https://nodejs.org/ 更新。
  pause
  exit /b 1
)

if not exist .env (
  echo 第一次執行：建立設定檔。
  node -e "const rl=require('readline').createInterface({input:process.stdin,output:process.stdout});const ask=()=>rl.question('請設定管理員密碼（至少 8 個字元）：',p=>{if(p.length<8){console.log('密碼太短，請重新輸入。');return ask();}require('fs').writeFileSync('.env',['PORT=3000','HOST=127.0.0.1','ADMIN_USER=admin','ADMIN_PASSWORD='+p,'COOKIE_SECURE=1','TRUST_PROXY=1','EDGE_CACHE_SECONDS=2',''].join('\n'));console.log('已建立 .env（管理員帳號：admin）。');rl.close();});ask();"
)

if not exist node_modules (
  echo 安裝套件中（第一次約需 1–2 分鐘）…
  call npm ci
  if errorlevel 1 ( echo 安裝失敗。 & pause & exit /b 1 )
)
echo 建置網頁中…
call npm run build
if errorlevel 1 ( echo 建置失敗。 & pause & exit /b 1 )

echo 啟動中。關閉這個視窗會停止看板。請到「設定 > 系統 > 電源」把睡眠設為「永不」。
:loop
node --disable-warning=ExperimentalWarning --env-file=.env server/index.ts
echo 伺服器停止了，3 秒後自動重啟…
timeout /t 3 /nobreak >nul
goto loop
