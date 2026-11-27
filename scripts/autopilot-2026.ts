// 開啟「自動駕駛」：開票當天不需要有人顧後台。
//
//   npm run autopilot:2026
//
// 會設定「2026 直轄市長、縣市長選舉」：
//   1. 11/28 16:00 自動從草稿改為「開票中」（公開看板）
//   2. 新增「中選會開票網站（自動尋找）」來源：當天 13:00 起每分鐘自動尋找中選會開票網站，找到後每 30 秒讀一輪
//   3. 22 縣市全部開完並維持 10 分鐘後，自動改為「開票完成」
// 重複執行是安全的。要取消，到後台「總覽與設定」與「自動讀取」頁修改即可。
//
// 演練用（搭配 npm run mock:cec）：npm run autopilot:2026 -- --test
//   改為讀取本機的模擬網站、立即開始尋找、1 分鐘後自動公開。
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import type { Election } from '../server/domain.ts';
import type { DataSource } from '../server/sources.ts';

const NAME = '2026 直轄市長、縣市長選舉';
const test = process.argv.includes('--test');
const db = openDb(loadConfig().dbPath);

const election = db.prepare('SELECT * FROM elections WHERE name = ?').get(NAME) as Election | undefined;
if (!election) {
  console.error(`找不到「${NAME}」。請先執行 npm run setup:2026。`);
  process.exit(1);
}
const candidates = (db.prepare('SELECT COUNT(*) AS n FROM candidates k JOIN contests c ON c.id = k.contest_id WHERE c.election_id = ?').get(election.id) as { n: number }).n;

const liveAt = test ? new Date(Date.now() + 60_000) : new Date('2026-11-28T16:00:00+08:00');
const showTime = (d: Date) => d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
if (election.status === 'draft') {
  db.prepare('UPDATE elections SET auto_live_at = ?, auto_final = 1 WHERE id = ?').run(liveAt.toISOString(), election.id);
} else {
  db.prepare('UPDATE elections SET auto_final = 1 WHERE id = ?').run(election.id);
}

const config = test
  ? { auto: true, base: '', prefix: '', hosts: ['http://localhost:4000/zh-TW'], startAt: new Date().toISOString() }
  : { auto: true, base: '', prefix: '' };
const name = test ? '中選會開票網站（自動尋找・演練）' : '中選會開票網站（自動尋找）';
const existing = db.prepare("SELECT * FROM data_sources WHERE election_id = ? AND kind = 'cec_live' AND name = ?").get(election.id, name) as DataSource | undefined;
if (existing) {
  db.prepare("UPDATE data_sources SET config = ?, url = '', interval_sec = 30, enabled = 1, last_hash = '' WHERE id = ?").run(JSON.stringify(config), existing.id);
} else {
  db.prepare("INSERT INTO data_sources (election_id, name, kind, url, config, interval_sec, enabled) VALUES (?, ?, 'cec_live', '', ?, 30, 1)").run(election.id, name, JSON.stringify(config));
}
const others = db.prepare("SELECT name FROM data_sources WHERE election_id = ? AND enabled = 1 AND name <> ?").all(election.id, name) as { name: string }[];
db.close();

console.log(`\n已開啟自動駕駛：「${NAME}」（${candidates} 位候選人）`);
console.log(election.status === 'draft' ? `  ● ${showTime(liveAt)} 自動公開（改為開票中）` : `  ● 目前已是「${election.status === 'live' ? '開票中' : '開票完成'}」，不需排定公開`);
console.log(test ? '  ● 立即開始尋找本機的模擬中選會網站（http://localhost:4000）' : '  ● 11/28 13:00 起每分鐘自動尋找中選會開票網站，找到後每 30 秒讀一輪');
console.log('  ● 22 縣市全部開完並維持 10 分鐘後，自動改為「開票完成」');
if (others.length) console.log(`\n注意：還有其他啟用中的資料來源：${others.map((o) => o.name).join('、')}。演練用的來源請到後台刪除。`);
console.log('\n看板程式要保持開著（自動駕駛在看板程式裡執行）。進度可到後台「自動讀取」頁查看。');
