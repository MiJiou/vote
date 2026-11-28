// 建立「2026 直轄市議員、縣市議員選舉」，並自動從中選會開票網站讀取。
//
//   npm run council:2026
//
// 會做這些事（重複執行是安全的，已建立的會更新）：
//   1. 讀中選會開票網站（vote.cec.gov.tw/2026-local）的導覽清單，找出 22 縣市共 221 個議員選舉區
//      （一般選舉區類別代碼 T1、平地原住民 T2、山地原住民 T3）
//   2. 逐一讀取各選舉區頁面，取得應選席次與候選人（號次、姓名、推薦之政黨）
//   3. 建立選舉（狀態「開票中」，直接公開）與「中選會開票網站（議員）」來源，每 60 秒讀一輪
//   4. 全部開完並維持 10 分鐘後，自動改為「開票完成」
// 看板程式開著時也可以執行，執行完新選舉會出現在首頁的選舉列表。
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createCtx, upsertCandidate } from '../server/domain.ts';
import type { Contest, Election } from '../server/domain.ts';
import { fetchUrl, parseCecPage } from '../server/ceclive.ts';

const NAME = '2026 直轄市議員、縣市議員選舉';
const SITE = 'https://vote.cec.gov.tw/2026-local';
const BASE = `${SITE}/zh-TW`;

type Node = Record<string, unknown> & { zh?: unknown; serial?: { c?: string }; next?: unknown; overrides?: { conditions: { ancestors?: unknown }; mutations: Record<string, unknown> }[] };
const res = await fetch(`${SITE}/assets/def/tree-compiled.2026-local.min.json?_=${Date.now()}`, {
  headers: { 'user-agent': 'Mozilla/5.0 (compatible; vote-dashboard/0.1)' },
  signal: AbortSignal.timeout(30_000),
});
if (!res.ok) {
  console.error(`讀不到中選會開票網站的導覽清單（HTTP ${res.status}）`);
  process.exit(1);
}
const tree = (await res.json()) as Record<string, Node>;
const root = tree['_ROOT'].next as string[];
const councilKey = root.find((k) => String(tree[k].zh ?? '').includes('議員'));
if (!councilKey) {
  console.error('導覽清單裡找不到議員選舉');
  process.exit(1);
}

// 各縣市的議員選舉區：[種類, 號碼, "01", (原住民區的類別樣板), [鄉鎮…]]
type Target = { county: string; countyName: string; no: number; label: string; page: string };
const targets: Target[] = [];
for (const key of tree['_AREAROOT'].next as string[]) {
  const county = tree[key];
  const code = county.serial?.c;
  if (!code) continue;
  const ov = county.overrides?.find((o) => JSON.stringify(o.conditions.ancestors) === JSON.stringify([councilKey]));
  for (const ck of (ov?.mutations.next as string[] | undefined) ?? []) {
    const c = tree[ck] as unknown as unknown[];
    const kind = c[0] as number;
    const no = c[1] as number;
    const nn = String(c[2]).padStart(2, '0');
    let prefix = 'T1';
    let append = '';
    if (kind === 4 && typeof c[3] === 'string') {
      const tpl = tree[c[3]];
      const p = (tpl.overrides?.[0]?.mutations.serial as { prefix?: string } | undefined)?.prefix;
      if (p) prefix = p;
      append = String((tpl.zh as { append?: string } | undefined)?.append ?? '');
    }
    targets.push({ county: code, countyName: String(county.zh), no, label: `第${no}選舉區${append}`, page: `${prefix}/${code}${nn}${'0'.repeat(10)}` });
  }
}
console.log(`找到 ${targets.length} 個議員選舉區，逐一讀取候選人名單…`);

// 一次讀 4 頁
const pages = new Array(targets.length);
let next = 0;
let failed = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < targets.length) {
      const i = next++;
      try {
        pages[i] = parseCecPage((await fetchUrl(`${BASE}/${targets[i].page}.html`)).html);
      } catch (err) {
        failed++;
        console.log(`  讀取失敗：${targets[i].countyName} ${targets[i].label}（${(err as Error).message}）`);
      }
    }
  }),
);

const config = loadConfig();
const ctx = createCtx(openDb(config.dbPath), config);
const db = ctx.db;
let election = db.prepare('SELECT * FROM elections WHERE name = ?').get(NAME) as Election | undefined;
if (!election) {
  const r = db
    .prepare("INSERT INTO elections (name, type, date, status, unit_level, source_note, created_at, auto_final) VALUES (?, 'mayor', '2026-11-28', 'live', 'county', ?, ?, 1)")
    .run(NAME, '中選會開票網站', new Date().toISOString());
  election = db.prepare('SELECT * FROM elections WHERE id = ?').get(Number(r.lastInsertRowid)) as Election;
}
const countyOrder = new Map(ctx.areas.counties.map((c, i) => [c.code, i]));
let contests = 0;
let candidates = 0;
targets.forEach((t, i) => {
  const page = pages[i];
  if (!page?.candidates?.length) return;
  const name = `${t.countyName}${t.label}`;
  let contest = db.prepare('SELECT * FROM contests WHERE election_id = ? AND cec_page = ?').get(election.id, t.page) as Contest | undefined;
  const sort = (countyOrder.get(t.county) ?? 99) * 100 + t.no;
  const seats = page.seats ?? 1;
  if (contest) {
    db.prepare('UPDATE contests SET name = ?, area_code = ?, sort = ?, seats = ? WHERE id = ?').run(name, t.county, sort, seats, contest.id);
  } else {
    const r = db.prepare('INSERT INTO contests (election_id, name, area_code, sort, seats, cec_page) VALUES (?, ?, ?, ?, ?, ?)').run(election.id, name, t.county, sort, seats, t.page);
    contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(Number(r.lastInsertRowid)) as Contest;
  }
  contests++;
  const existing = db.prepare('SELECT id, number FROM candidates WHERE contest_id = ?').all(contest.id) as { id: number; number: number }[];
  for (const c of page.candidates) {
    const party = !c.party || c.party === '無' ? '無黨籍及未經政黨推薦' : c.party;
    upsertCandidate(ctx, contest, { number: c.number, name: c.name ?? `${c.number} 號`, party }, existing.find((e) => e.number === c.number)?.id);
    candidates++;
  }
});

const source = { auto: false, base: BASE, prefix: 'T1' };
const srcName = '中選會開票網站（議員）';
const had = db.prepare("SELECT id FROM data_sources WHERE election_id = ? AND name = ?").get(election.id, srcName) as { id: number } | undefined;
if (had) db.prepare("UPDATE data_sources SET config = ?, url = '', interval_sec = 60, enabled = 1, last_hash = '' WHERE id = ?").run(JSON.stringify(source), had.id);
else db.prepare("INSERT INTO data_sources (election_id, name, kind, url, config, interval_sec, enabled) VALUES (?, ?, 'cec_live', '', ?, 60, 1)").run(election.id, srcName, JSON.stringify(source));
db.close();

console.log(`\n已建立「${NAME}」：${contests} 個選舉區、${candidates} 位候選人${failed ? `（${failed} 個選舉區讀取失敗，請稍後再執行一次）` : ''}。`);
console.log('狀態為「開票中」（已公開），每 60 秒從中選會開票網站讀一輪；全部開完 10 分鐘後自動改為開票完成。');
console.log('看板程式要保持開著；第一輪資料大約 1 分鐘內會出現。');
