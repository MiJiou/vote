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
/**
 * 問密碼：自己處理鍵盤輸入並顯示 *，不用 readline 的終端模式
 * （它會把提示文字清掉，Windows 上看起來就像程式卡住）。
 */
function askHidden(question) {
  process.stdout.write(question);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // 非互動（例如測試時用管線輸入）：讀一行。
    return new Promise((resolve) => {
      const rl = createInterface({ input: stdin, terminal: false });
      rl.once('line', (line) => {
        rl.close();
        process.stdout.write('\n');
        resolve(line);
      });
    });
  }
  return new Promise((resolve) => {
    let buf = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\b' || ch === '\u007f') {
          if (buf) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          buf += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

if (!existsSync('.env')) {
  console.log('第一次執行：建立設定檔。');
  let pw = '';
  for (;;) {
    pw = (await askHidden('請設定管理員密碼（至少 8 個字元），輸入完按 Enter：')).trim();
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
