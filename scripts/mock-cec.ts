// 模擬中選會開票網站（演練用）：用中選會即時計票頁的格式，依 2026 年縣市長候選人名單，在幾分鐘內模擬開完票。
//
//   npm run mock:cec                          預設 10 分鐘開完，網站在 http://localhost:4000
//   npm run mock:cec -- --minutes 3 --port 4000 --prefix C1
//
// 到後台「自動讀取」新增「中選會開票網站」來源，網址開頭填 http://localhost:4000/zh-TW、類別代碼填 TC，
// 就能完整演練選舉當晚的自動讀取流程。數字是隨機產生的，不代表任何預測。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { parseCsv } from '../server/util.ts';
import { Areas } from '../server/db.ts';

const args = process.argv.slice(2);
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const minutes = opt('minutes', 10);
const port = opt('port', 4000);
const prefixArg = args.indexOf('--prefix');
const prefix = prefixArg >= 0 && args[prefixArg + 1] ? args[prefixArg + 1] : 'TC';

const areas = new Areas();
const table = parseCsv(readFileSync(new URL('./data/candidates-2026.csv', import.meta.url), 'utf8'));
const byCounty = new Map<string, { number: number; name: string; weight: number }[]>();
for (const [county, number, name] of table.slice(1)) {
  const code = areas.counties.find((a) => a.name === county)?.code;
  if (!code) continue;
  if (!byCounty.has(code)) byCounty.set(code, []);
  byCounty.get(code)!.push({ number: Number(number), name, weight: Math.random() ** 2 + 0.02 });
}

// 每個縣市：選舉人數、投開票所數、投票率與開票速度都不同。
const plan = new Map(
  [...byCounty.keys()].map((code) => {
    const eligible = Math.round(50_000 + Math.random() * 3_000_000);
    return [code, { eligible, stations: Math.max(10, Math.round(eligible / 1300)), turnout: 0.55 + Math.random() * 0.15, delay: Math.random() * 0.2, speed: 0.6 + Math.random() * 0.4 }];
  }),
);
const start = Date.now();

function page(code: string): string | null {
  const cands = byCounty.get(code);
  const p = plan.get(code);
  if (!cands || !p) return null;
  const clock = Math.min(1, (Date.now() - start) / (minutes * 60_000));
  // 時間到時一律開完；之前各縣市依自己的起始時間與速度開票。
  const share = clock >= 1 ? 1 : Math.min(1, Math.max(0, (clock - p.delay) / (p.speed * (1 - p.delay))));
  const counted = Math.round(p.stations * share);
  const ballots = Math.round(p.eligible * p.turnout * (counted / p.stations));
  const invalid = Math.round(ballots * 0.012);
  const totalWeight = cands.reduce((s, c) => s + c.weight, 0);
  const votes = cands.map((c) => Math.round(((ballots - invalid) * c.weight) / totalWeight));
  const valid = votes.reduce((a, b) => a + b, 0);
  const name = areas.name(code);
  const title = name.endsWith('市') ? '直轄市長、縣市長選舉' : '縣長選舉';
  const now = new Date();
  const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const rows = cands
    .map((c, i) => `<tr><td class="numeric">${c.number}</td><td>${c.name}</td><td class="numeric">${votes[i].toLocaleString('en-US')}</td><td class="numeric">${valid ? ((votes[i] / valid) * 100).toFixed(2) : '0.00'}</td></tr>`)
    .join('');
  return `<div id="vote-table-header"><div class="vote-table-header-title"><b>${title}&nbsp;候選人得票數 - ${name}</b></div>
<div class="vote-table-header-subtitle"><div class="bullet">已送投開票所數/總投開票所數: ${counted}/${p.stations} </div></div></div>
<div id="vote-table-content">
<table class="tablesaw"><thead><tr><th scope="col">號次</th><th scope="col">姓名</th><th scope="col">得票數</th><th scope="col">得票率%</th></tr></thead><tbody>${rows}</tbody></table>
<table class="tablesaw"><thead><tr><th scope="col">有效票數</th><th scope="col">無效票數</th><th scope="col">投票數</th></tr></thead>
<tbody><tr><td class="numeric">${valid.toLocaleString('en-US')}</td><td class="numeric">${invalid.toLocaleString('en-US')}</td><td class="numeric">${(valid + invalid).toLocaleString('en-US')}</td></tr></tbody></table>
<table class="tablesaw"><thead><tr><th scope="col">選舉人數</th></tr></thead><tbody><tr><td class="numeric">${p.eligible.toLocaleString('en-US')}</td></tr></tbody></table>
</div>
<div id="vote-table-footer"><span>資料時間:&nbsp;${stamp}</span><span>（模擬資料，非真實開票結果）</span></div>`;
}

let requests = 0;
createServer((req, res) => {
  requests++;
  const m = /^\/zh-TW\/([A-Za-z0-9]+)\/(\d{5})0{12}\.html(?:\?.*)?$/.exec(req.url ?? '');
  const body = m && m[1] === prefix ? page(m[2]) : null;
  if (!body) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found（模擬網站只提供縣市層級的頁面）');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }).end(body);
}).listen(port, () => {
  console.log(`模擬中選會開票網站：http://localhost:${port}/zh-TW/${prefix}/63000000000000000.html（臺北市）`);
  console.log(`後台來源設定：網址開頭 http://localhost:${port}/zh-TW　類別代碼 ${prefix}`);
  console.log(`${minutes} 分鐘後全部開完。數字是隨機產生的，不代表任何預測。按 Ctrl+C 結束。\n`);
});
setInterval(() => {
  const clock = Math.min(1, (Date.now() - start) / (minutes * 60_000));
  process.stdout.write(`\r  模擬進度 ${Math.round(clock * 100)}%　已被讀取 ${requests} 次   `);
}, 2000);
