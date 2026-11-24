// 示範資料：從中選會選舉資料庫匯入真實的歷屆選舉結果。需要能連上 db.cec.gov.tw。
//
//   npm run demo                 匯入「第16任總統副總統選舉」與「111 年縣市長選舉」（標為開票完成）
//   npm run demo -- --simulate   另建一場「模擬開票」，把 2024 總統大選的票數分批送進「正在執行中」的伺服器，
//                                用來展示看板的即時更新，也可以當作開票日前的演練。
//                                選項：--url http://localhost:3000（伺服器位址）、--seconds 120（整個過程多久）
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createCtx, listContests } from '../server/domain.ts';
import { sha256 } from '../server/auth.ts';
import { cecElections, createFromCec } from '../server/sources.ts';
import type { ResultRow } from '../server/results.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const config = loadConfig();
const ctx = createCtx(openDb(config.dbPath), config);

async function importHistorical(type: 'president' | 'mayor', pick: (name: string, date: string) => boolean, name?: string) {
  const options = await cecElections(type);
  const chosen = options.find((o) => pick(o.name, o.date));
  if (!chosen) throw new Error(`中選會資料庫裡找不到要匯入的${type === 'president' ? '總統' : '縣市長'}選舉`);
  console.log(`匯入「${chosen.name}」…`);
  const { election, report } = await createFromCec(ctx, { type, themes: chosen.themes, name: name ?? chosen.name, date: chosen.date }, null);
  console.log(`  完成：${report.applied} 個鄉鎮市區${report.errorCount ? `，${report.errorCount} 筆無法對應（${report.errors[0].message}）` : ''}`);
  return election;
}

if (flag('simulate')) {
  await simulate();
} else {
  const president = await importHistorical('president', (_n, date) => date.startsWith('2024'));
  const mayor = await importHistorical('mayor', (_n, date) => date.startsWith('2022'), '111 年直轄市長、縣市長選舉');
  ctx.db.prepare("UPDATE elections SET status = 'final' WHERE id IN (?, ?)").run(president.id, mayor.id);
  console.log('\n示範資料已就緒。啟動伺服器（npm start）後打開 http://localhost:' + config.port);
}
ctx.db.close();

async function simulate() {
  const url = option('url', `http://localhost:${config.port}`).replace(/\/$/, '');
  const seconds = Math.max(20, Number(option('seconds', '120')));
  try {
    const health = await fetch(`${url}/api/health`);
    if (!health.ok) throw new Error(String(health.status));
  } catch {
    throw new Error(`連不上伺服器 ${url}。請先在另一個終端機執行 npm start，再執行模擬。`);
  }

  // 先取得完整結果，再清空，之後分批「開票」。
  const election = await importHistorical('president', (_n, date) => date.startsWith('2024'), `模擬開票演練（重播第16任總統選舉）`);
  const contest = listContests(ctx, election.id)[0];
  const final = ctx.db.prepare('SELECT * FROM results WHERE contest_id = ?').all(contest.id) as ResultRow[];
  const numberOf = new Map((ctx.db.prepare('SELECT id, number FROM candidates WHERE contest_id = ?').all(contest.id) as { id: number; number: number }[]).map((c) => [String(c.id), c.number]));
  ctx.db.prepare('DELETE FROM results WHERE contest_id = ?').run(contest.id);
  ctx.db.prepare('DELETE FROM submissions WHERE contest_id = ?').run(contest.id);
  ctx.db.prepare('DELETE FROM data_sources WHERE election_id = ?').run(election.id);
  const token = randomBytes(24).toString('base64url');
  const source = ctx.db
    .prepare("INSERT INTO data_sources (election_id, name, kind, enabled, token_hash) VALUES (?, '模擬開票', 'push', 1, ?)")
    .run(election.id, sha256(token));
  ctx.db.prepare("UPDATE elections SET status = 'live', source_note = '模擬資料：重播中選會公布的第16任總統選舉結果' WHERE id = ?").run(election.id);
  const ingest = `${url}/api/ingest/${Number(source.lastInsertRowid)}`;

  // 每個鄉鎮市區有自己的開票速度：有的很快開完，有的拖到最後。
  const towns = final.map((r) => {
    const votes = JSON.parse(r.votes) as Record<string, number>;
    const total = Object.values(votes).reduce((a, b) => a + b, 0) + (r.invalid_votes ?? 0);
    const stations = Math.max(1, Math.round((r.eligible_voters ?? total) / 1400));
    return { r, votes, stations, start: Math.random() * 0.25, pace: 0.35 + Math.random() * 0.65, sent: -1 };
  });

  console.log(`\n開始模擬開票：${towns.length} 個鄉鎮市區，約 ${seconds} 秒開完。`);
  console.log(`請打開 ${url}/e/${election.id} 觀看即時更新（Ctrl+C 可中止）。\n`);
  const ticks = Math.ceil(seconds / 2);
  for (let tick = 0; tick <= ticks; tick++) {
    const clock = tick / ticks;
    const results = [];
    for (const t of towns) {
      const progress = tick === ticks ? 1 : Math.min(1, Math.max(0, (clock - t.start) / (t.pace * 0.75)));
      const counted = Math.round(t.stations * progress);
      if (counted === t.sent) continue;
      t.sent = counted;
      const share = counted / t.stations;
      results.push({
        code: t.r.unit_code,
        votes: Object.fromEntries(Object.entries(t.votes).map(([id, n]) => [numberOf.get(id), Math.round(n * share)])),
        invalid: Math.round((t.r.invalid_votes ?? 0) * share),
        eligible: t.r.eligible_voters,
        stationsTotal: t.stations,
        stationsCounted: counted,
      });
    }
    if (results.length) {
      const res = await fetch(ingest, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ results }) });
      if (!res.ok) throw new Error(`推送失敗：${res.status} ${await res.text()}`);
    }
    const done = towns.filter((t) => t.sent === t.stations).length;
    process.stdout.write(`\r  進度 ${Math.round(clock * 100)}%　已開完 ${done} / ${towns.length} 個鄉鎮市區   `);
    if (tick < ticks) await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('\n\n模擬結束。這場選舉仍是「開票中」，可到後台改為「開票完成」或直接刪除。');
}
