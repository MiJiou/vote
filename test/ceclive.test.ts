import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cecCode, parseCecPage, setCecLiveFetch } from '../server/ceclive.ts';
import { createElection, listContests, upsertCandidate } from '../server/domain.ts';
import { runSource } from '../server/sources.ts';
import type { DataSource } from '../server/sources.ts';
import { summaryJson } from '../server/results.ts';
import { loginAs, testApp, testCtx } from './helpers.ts';

afterEach(() => setCecLiveFetch(null));
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** 仿中選會開票頁面的版型（外框取自 2025 年真實頁面），內容是縣市長選舉的候選人表格。 */
function mayorPage(o: { area: string; counted: number; total: number; rows: [number, string, number][]; valid?: number; invalid?: number; time?: string }) {
  const rows = o.rows.map(([no, name, votes]) => `<tr><td class="numeric">${no}</td><td>${name}</td><td>男</td><td class="numeric">\n ${votes.toLocaleString('en-US')} \n</td><td class="numeric">0.00</td><td>政黨推薦</td></tr>`).join('');
  const valid = o.valid ?? o.rows.reduce((s, r) => s + r[2], 0);
  return `<div id="vote-table-header"><div class="vote-table-header-title"><b>直轄市長選舉&nbsp;候選人得票數 - ${o.area}</b></div>
<div class="vote-table-header-subtitle"><div class="bullet"> <img src="../assets/img/nav.gif" />已送投開票所數/總投開票所數: ${o.counted}/${o.total} </div></div></div>
<div id="vote-table-content"><table class="tablesaw"><thead><tr><th scope="col">號次</th><th scope="col">姓名</th><th scope="col">性別</th><th scope="col">得票數</th><th scope="col">得票率%</th><th scope="col">登記方式</th></tr></thead><tbody>${rows}</tbody></table>
<table class="tablesaw"><thead><tr><th>有效票數</th><th>無效票數</th><th>投票數</th></tr></thead><tbody><tr><td class="numeric">${valid.toLocaleString('en-US')}</td><td class="numeric">${o.invalid ?? 0}</td><td class="numeric">${valid + (o.invalid ?? 0)}</td></tr></tbody></table>
<table class="tablesaw"><thead><tr><th>選舉人數</th><th>投票率%</th></tr></thead><tbody><tr><td class="numeric">2,000,000</td><td class="numeric">60.00</td></tr></tbody></table></div>
<div id="vote-table-footer"><span>資料時間:&nbsp;${o.time ?? '11/28 19:30'}</span></div>`;
}

test('解析中選會真實頁面（2025 公投）：投票所進度、資料時間、有效／無效票', () => {
  const page = parseCecPage(fixture('cec-2025-referendum-taipei.html'));
  assert.equal(page.stationsCounted, 1760);
  assert.equal(page.stationsTotal, 1760);
  assert.equal(page.dataTime, '08/23 20:10');
  assert.equal(page.valid, 625557);
  assert.equal(page.invalid, 4330);
  assert.equal(page.total, 629887);
  assert.equal(page.candidates.length, 0, '公投頁面沒有候選人表格');
  assert.match(page.title, /臺北市/);
});

test('解析 2024 年頁面（沒有姓名欄）與仿縣市長頁面（有姓名欄、數字含千分位）', () => {
  const p2024 = parseCecPage(fixture('cec-2024-party-list-condensed.html'));
  assert.deepEqual(p2024.candidates.map((c) => [c.number, c.votes, c.name]), [[11, 2, null], [12, 286, null], [6, 2, null], [9, 334, null]]);
  assert.equal(p2024.dataTime, '01/13 22:21');
  const p = parseCecPage(mayorPage({ area: '臺北市', counted: 900, total: 1500, rows: [[1, '甲', 1234567], [2, '乙', 89]], invalid: 321 }));
  assert.deepEqual(p.candidates, [{ number: 1, name: '甲', votes: 1234567 }, { number: 2, name: '乙', votes: 89 }]);
  assert.deepEqual([p.stationsCounted, p.stationsTotal, p.valid, p.invalid, p.eligible], [900, 1500, 1234656, 321, 2000000]);
});

test('地區代碼轉換成中選會 17 碼', () => {
  assert.equal(cecCode('63000'), '63000000000000000');
  assert.equal(cecCode('63000010'), '63000000100000000');
  assert.equal(cecCode('10002010'), '10002000100000000');
  assert.throws(() => cecCode('630'));
});

test('中選會開票網站來源：寫入正確的頁面，拒絕姓名不符、加總不符、讀不到的頁面', async () => {
  const ctx = testCtx();
  const election = createElection(ctx, { name: '測試縣市長', type: 'mayor', date: '2026-11-28', unit_level: 'county', status: 'live', counties: ['63000', '65000', '66000', '67000'] });
  const byArea = new Map(listContests(ctx, election.id).map((c) => [c.area_code, c]));
  for (const [area, names] of [['63000', ['北一', '北二']], ['65000', ['新一', '新二']], ['66000', ['中一', '中二']], ['67000', ['南一', '南二']]] as const) {
    names.forEach((name, i) => upsertCandidate(ctx, byArea.get(area)!, { number: i + 1, name, party: '' }));
  }
  const pages: Record<string, string> = {
    '63000000000000000': mayorPage({ area: '臺北市', counted: 600, total: 1500, rows: [[1, '北一', 300000], [2, '北二', 200000]], invalid: 5000 }),
    '65000000000000000': mayorPage({ area: '新北市', counted: 10, total: 2400, rows: [[1, '新一', 100], [2, '別人', 50]] }),
    '66000000000000000': mayorPage({ area: '臺中市', counted: 10, total: 1600, rows: [[1, '中一', 100], [2, '中二', 50]], valid: 999 }),
  };
  const requested: string[] = [];
  setCecLiveFetch(async (url) => {
    requested.push(url);
    const m = /\/TC\/(\d{17})\.html\?_=\d+$/.exec(url);
    assert.ok(m, `網址格式：${url}`);
    return pages[m[1]] ? new Response(pages[m[1]]) : new Response('not found', { status: 404 });
  });
  const id = Number(ctx.db.prepare("INSERT INTO data_sources (election_id, name, kind, url, config, enabled) VALUES (?, '中選會', 'cec_live', ?, ?, 1)")
    .run(election.id, 'https://vote2026.example/zh-TW', JSON.stringify({ base: 'https://vote2026.example/zh-TW/', prefix: 'TC' })).lastInsertRowid);
  const source = () => ctx.db.prepare('SELECT * FROM data_sources WHERE id = ?').get(id) as DataSource;

  const r = await runSource(ctx, source());
  assert.equal(requested.length, 4, '每個縣市一頁');
  assert.ok(requested[0].startsWith('https://vote2026.example/zh-TW/TC/'));
  assert.equal(r.ok, false, '有頁面出問題時狀態要標示');
  assert.match(r.message, /讀取 4 頁，3 頁有問題/);
  assert.equal(r.report?.applied, 1);
  const summary = JSON.parse(summaryJson(ctx, election.id));
  const tp = summary.contests.find((c: { areaCode: string }) => c.areaCode === '63000').totals;
  assert.deepEqual([tp.valid, tp.invalid, tp.stationsCounted, tp.stationsTotal], [500000, 5000, 600, 1500]);
  for (const area of ['65000', '66000', '67000']) {
    assert.equal(summary.contests.find((c: { areaCode: string }) => c.areaCode === area).totals.valid, 0, `${area} 不應寫入`);
  }
  const status = source().last_message;
  assert.match(status, /臺北市|新北市|臺中市|臺南市/);

  // 內容完全沒變：不重複寫入
  const again = await runSource(ctx, source());
  assert.match(again.message, /內容與上次相同/);
});

test('後台：建立中選會來源、試讀一頁', async () => {
  const ctx = testCtx();
  const election = createElection(ctx, { name: '測試縣市長', type: 'mayor', date: '2026-11-28', unit_level: 'county', status: 'live', counties: ['63000'] });
  const contest = listContests(ctx, election.id)[0];
  upsertCandidate(ctx, contest, { number: 1, name: '北一', party: '' });
  upsertCandidate(ctx, contest, { number: 2, name: '北二', party: '' });
  const app = await testApp(ctx);
  const admin = await loginAs(app, 'admin', 'admin-password');
  setCecLiveFetch(async () => new Response(mayorPage({ area: '臺北市', counted: 1, total: 1500, rows: [[1, '北一', 30], [2, '北三', 20]] })));

  const bad = await app.inject({ method: 'POST', url: `/api/admin/elections/${election.id}/sources`, headers: { cookie: admin }, payload: { name: 'x', kind: 'cec_live', config: { base: 'not a url', prefix: 'TC' } } });
  assert.equal(bad.statusCode, 400);
  const created = await app.inject({
    method: 'POST', url: `/api/admin/elections/${election.id}/sources`, headers: { cookie: admin },
    payload: { name: '中選會開票網站', kind: 'cec_live', config: { base: 'https://vote2026.example/zh-TW', prefix: 'TC' }, interval_sec: 5, enabled: false },
  });
  assert.equal(created.statusCode, 200);
  assert.deepEqual(created.json().config, { base: 'https://vote2026.example/zh-TW', prefix: 'TC' });
  assert.equal(created.json().interval_sec, 20, '最短 20 秒一輪');

  const preview = await app.inject({ method: 'POST', url: `/api/admin/elections/${election.id}/cec-live/preview`, headers: { cookie: admin }, payload: { base: 'https://vote2026.example/zh-TW', prefix: 'TC' } });
  assert.equal(preview.statusCode, 200);
  const p = preview.json();
  assert.equal(p.url, 'https://vote2026.example/zh-TW/TC/63000000000000000.html');
  assert.deepEqual(p.candidates.map((c: { name: string; ours: string }) => [c.name, c.ours]), [['北一', '北一'], ['北三', '北二']]);
  assert.equal((await app.inject({ method: 'GET', url: `/api/elections/${election.id}/summary` })).json().contests[0].totals.valid, 0, '試讀不寫入');
  await app.close();
});

test('舊資料庫升級後可以建立中選會開票網站來源，原有來源保留', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openDb } = await import('../server/db.ts');
  const dir = mkdtempSync(join(tmpdir(), 'vote-v3-'));
  const path = join(dir, 'vote.db');
  try {
    const old = openDb(path);
    old.exec("INSERT INTO elections (name, type, date, created_at) VALUES ('舊', 'mayor', '2022-11-26', 'x')");
    old.exec(`ALTER TABLE data_sources RENAME TO ds; CREATE TABLE data_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('csv_url', 'json_url', 'cec_db', 'push')), url TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}',
      interval_sec INTEGER NOT NULL DEFAULT 60, enabled INTEGER NOT NULL DEFAULT 0, token_hash TEXT, last_run_at TEXT, last_ok INTEGER,
      last_message TEXT NOT NULL DEFAULT '', last_hash TEXT NOT NULL DEFAULT ''); DROP TABLE ds;
      INSERT INTO data_sources (election_id, name, kind) VALUES (1, '舊來源', 'push'); PRAGMA user_version = 2;`);
    assert.throws(() => old.exec("INSERT INTO data_sources (election_id, name, kind) VALUES (1, 'x', 'cec_live')"));
    old.close();
    const db = openDb(path);
    db.exec("INSERT INTO data_sources (election_id, name, kind) VALUES (1, '新來源', 'cec_live')");
    assert.deepEqual((db.prepare('SELECT name FROM data_sources ORDER BY id').all() as { name: string }[]).map((r) => r.name), ['舊來源', '新來源']);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
