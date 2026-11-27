// 開票看板啟動程式（Windows 與 macOS 共用）。由 start-windows.bat／start-mac.command 呼叫。
// 第一次執行：建立設定檔（.env）、安裝套件；每次執行：建置網頁、啟動伺服器，意外停止時自動重啟。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const isWin = process.platform === 'win32';

function fail(message) {
  console.error(`\n✕ ${message}\n`);
  process.exit(1);
}

// 1. Node.js 版本
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  fail(`Node.js 版本太舊（目前 ${process.version}），需要 22.18 以上。請到 https://nodejs.org/ 下載 LTS 版安裝後再執行。`);
}

// 2. 設定檔
/** 問密碼：同一個輸入介面重複使用，輸入的字不顯示在畫面上。 */
let rl = null;
let muted = false;
function askHidden(question) {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (!muted) process.stdout.write(s);
    };
  }
  process.stdout.write(question);
  muted = true;
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      muted = false;
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

if (!existsSync('.env')) {
  console.log('第一次執行：建立設定檔。');
  let pw = '';
  for (;;) {
    pw = (await askHidden('請設定管理員密碼（至少 8 個字元，輸入時不會顯示）：')).trim();
    if (pw.length >= 8 && !/[\r\n]/.test(pw)) break;
    console.log('密碼太短，請重新輸入。');
  }
  writeFileSync(
    '.env',
    ['PORT=3000', 'HOST=127.0.0.1', 'ADMIN_USER=admin', `ADMIN_PASSWORD=${pw}`, 'COOKIE_SECURE=1', 'TRUST_PROXY=1', 'EDGE_CACHE_SECONDS=2', ''].join('\n'),
  );
  try {
    chmodSync('.env', 0o600);
  } catch {
    /* Windows 不支援，略過 */
  }
  console.log('已建立 .env（管理員帳號：admin）。\n');
}
rl?.close();

// 3. 安裝與建置
const npm = (args, label) => {
  console.log(`${label}…`);
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm', args, { stdio: 'inherit', shell: isWin });
  if (r.status !== 0) fail(`${label}失敗（見上方訊息）。請確認網路正常後再試一次。`);
};
if (!existsSync('node_modules')) npm(['ci'], '安裝套件中（第一次約需 1–3 分鐘）');
npm(['run', 'build'], '建置網頁中');

// 4. 啟動伺服器；意外停止時自動重啟
console.log('\n啟動中。這個視窗開票期間請一直開著；按 Ctrl+C 可停止看板。');
if (isWin) console.log('提醒：請到「設定 › 系統 › 電源」把睡眠設為「永不」。\n');
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});
for (;;) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--env-file=.env', 'server/index.ts'], { stdio: 'inherit' });
    child.on('exit', (c) => resolve(c));
  });
  if (stopping) break;
  console.log(`\n伺服器停止了（代碼 ${code}），3 秒後自動重啟…`);
  await new Promise((r) => setTimeout(r, 3000));
}
