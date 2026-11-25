// 建立「2026（115 年）直轄市長、縣市長選舉」並匯入 22 縣市的候選人（號次取自中選會選舉公報）。
//
//   npm run setup:2026                 以「縣市」為統計層級建立（預設；讀中選會開票網站時每輪只需 22 頁）
//   npm run setup:2026 -- --level town  以「鄉鎮市區」建立（可下鑽到鄉鎮地圖，但讀中選會網站每輪要 368 頁）
//
// 已經建立過時不會重複建立，只會補上或更新候選人。建立後選舉是「草稿」，到後台確認無誤再改成「開票中」。
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import type { Election, User } from '../server/domain.ts';
import { createCtx, createElection, listContests } from '../server/domain.ts';
import { importCandidates } from '../server/importer.ts';
import { parseCsv } from '../server/util.ts';

const NAME = '2026 直轄市長、縣市長選舉';
const DATE = '2026-11-28';
const args = process.argv.slice(2);
const level = (args.includes('--level') ? args[args.indexOf('--level') + 1] : 'county') as Election['unit_level'];
if (!['county', 'town', 'station'].includes(level)) throw new Error('--level 只能是 county、town 或 station');

const ctx = createCtx(openDb(loadConfig().dbPath), loadConfig());
const setupUser = { id: 0, username: 'setup-2026', display_name: '初始化程式', role: 'admin', active: 1 } as User;

let election = ctx.db.prepare('SELECT * FROM elections WHERE name = ?').get(NAME) as Election | undefined;
if (election) {
  console.log(`「${NAME}」已存在（編號 ${election.id}），只更新候選人。`);
} else {
  election = createElection(ctx, {
    name: NAME,
    type: 'mayor',
    date: DATE,
    unit_level: level,
    status: 'draft',
    source_note: '候選人號次依中央選舉委員會選舉公報',
  });
  console.log(`已建立「${NAME}」（編號 ${election.id}，以${{ county: '縣市', town: '鄉鎮市區', station: '投開票所' }[level]}為單位，草稿）。`);
}

const table = parseCsv(readFileSync(new URL('./data/candidates-2026.csv', import.meta.url), 'utf8'));
const result = importCandidates(ctx, election, table, setupUser);
console.log(`候選人：匯入 ${result.upserted} / ${result.rows} 位${result.errors.length ? `，有問題 ${result.errors.length} 筆` : ''}`);
for (const e of result.errors) console.log(`  第 ${e.line} 列：${e.message}`);

const empty = listContests(ctx, election.id).filter(
  (c) => !(ctx.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE contest_id = ?').get(c.id) as { n: number }).n,
);
if (empty.length) console.log(`注意：以下選舉區沒有候選人：${empty.map((c) => c.name).join('、')}`);
console.log(`\n下一步：到後台 /admin/e/${election.id}/candidates 核對名單、找照片，確認後把狀態改成「開票中」。`);
ctx.db.close();
