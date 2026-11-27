import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setCecLiveFetch } from '../server/ceclive.ts';
import { createElection, listContests, upsertCandidate } from '../server/domain.ts';
import { runSource } from '../server/sources.ts';
import type { DataSource } from '../server/sources.ts';
import { runAutopilot } from '../server/autopilot.ts';
import { findUnit, submitResult, summaryJson } from '../server/results.ts';
import { testCtx } from './helpers.ts';

afterEach(() => setCecLiveFetch(null));

function page(rows: [number, string, number][], counted: number, total: number) {
  const tr = rows.map(([n, name, v]) => `<tr><td>${n}</td><td>${name}</td><td>${v}</td><td>0</td></tr>`).join('');
  return `<b>縣市長選舉 候選人得票數</b><div>已送投開票所數/總投開票所數: ${counted}/${total}</div>
<table><tr><th>號次</th><th>姓名</th><th>得票數</th><th>得票率%</th></tr>${tr}</table><span>資料時間: 11/28 17:00</span>`;
}

function mayorElection() {
  const ctx = testCtx();
  const election = createElection(ctx, { name: '自動駕駛測試', type: 'mayor', date: '2026-11-28', unit_level: 'county', counties: ['63000', '65000'] });
  const [tp, ntp] = listContests(ctx, election.id);
  upsertCandidate(ctx, tp, { number: 1, name: '北一', party: '' });
  upsertCandidate(ctx, tp, { number: 2, name: '北二', party: '' });
  upsertCandidate(ctx, ntp, { number: 1, name: '新一', party: '' });
  upsertCandidate(ctx, ntp, { number: 2, name: '新二', party: '' });
  return { ctx, election, tp, ntp };
}

test('自動尋找中選會開票網站：只採用號次與姓名完全對得上的頁面', async () => {
  const { ctx, election } = mayorElection();
  const requested: string[] = [];
  setCecLiveFetch(async (url) => {
    requested.push(url.replace(/\?_=\d+$/, ''));
    if (url.includes('/assets/def/')) return new Response('nope', { status: 404 });
    if (url.startsWith('https://a.example/')) return new Response('', { status: 404 });
    // b.example 的 TC 是別的選舉（姓名不同），C1 才是縣市長
    if (url.startsWith('https://b.example/zh-TW/TC/')) return new Response(page([[1, '別人', 5], [2, '他人', 6]], 1, 10));
    if (url.startsWith('https://b.example/zh-TW/C1/63000')) return new Response(page([[1, '北一', 300], [2, '北二', 200]], 5, 10));
    if (url.startsWith('https://b.example/zh-TW/C1/65000')) return new Response(page([[1, '新一', 30], [2, '新二', 20]], 10, 10));
    return new Response('', { status: 404 });
  });
  const config = { auto: true, base: '', prefix: '', hosts: ['https://a.example/zh-TW', 'https://b.example/zh-TW'], startAt: '2000-01-01T00:00:00Z' };
  const id = Number(ctx.db.prepare("INSERT INTO data_sources (election_id, name, kind, config, enabled) VALUES (?, 'auto', 'cec_live', ?, 1)").run(election.id, JSON.stringify(config)).lastInsertRowid);
  const source = () => ctx.db.prepare('SELECT * FROM data_sources WHERE id = ?').get(id) as DataSource;

  const r = await runSource(ctx, source());
  assert.equal(r.ok, true, r.message);
  const saved = JSON.parse(source().config);
  assert.deepEqual([saved.base, saved.prefix, saved.auto], ['https://b.example/zh-TW', 'C1', true]);
  assert.ok(requested.includes('https://b.example/zh-TW/TC/63000000000000000.html'), '有試過 TC');
  const s = JSON.parse(summaryJson(ctx, election.id, true));
  assert.deepEqual(s.contests.map((c: { totals: { valid: number } }) => c.totals.valid), [500, 50]);

  // 之後整批都讀不到（例如網址換了）：清掉設定，下一輪重新尋找
  setCecLiveFetch(async () => new Response('', { status: 404 }));
  await runSource(ctx, source());
  const cleared = JSON.parse(source().config);
  assert.deepEqual([cleared.base, cleared.prefix, cleared.auto], ['', '', true]);
});

test('自動尋找：開始時間之前只等待，不對外連線', async () => {
  const { ctx, election } = mayorElection();
  let calls = 0;
  setCecLiveFetch(async () => {
    calls++;
    return new Response('', { status: 404 });
  });
  const config = { auto: true, base: '', prefix: '', startAt: '2999-01-01T00:00:00Z' };
  const id = Number(ctx.db.prepare("INSERT INTO data_sources (election_id, name, kind, config, enabled) VALUES (?, 'auto', 'cec_live', ?, 1)").run(election.id, JSON.stringify(config)).lastInsertRowid);
  const r = await runSource(ctx, ctx.db.prepare('SELECT * FROM data_sources WHERE id = ?').get(id) as DataSource);
  assert.match(r.message, /等待中選會開票網站上線/);
  assert.equal(calls, 0);
});

test('自動駕駛：排定時間自動公開；全部開完 10 分鐘後自動改為開票完成', () => {
  const { ctx, election, tp, ntp } = mayorElection();
  const t0 = Date.parse('2026-11-28T08:00:00Z');
  ctx.db.prepare("UPDATE elections SET auto_live_at = ?, auto_final = 1 WHERE id = ?").run('2026-11-28T08:00:00.000Z', election.id);
  assert.deepEqual(runAutopilot(ctx, t0 - 1000), [], '時間還沒到');
  assert.equal(runAutopilot(ctx, t0).length, 1);
  const status = () => (ctx.db.prepare('SELECT status, auto_live_at FROM elections WHERE id = ?').get(election.id) as { status: string; auto_live_at: string });
  assert.deepEqual({ ...status() }, { status: 'live', auto_live_at: '' });

  const fresh = () => ctx.db.prepare('SELECT * FROM elections WHERE id = ?').get(election.id) as typeof election;
  const put = (contest: typeof tp, code: string, counted: number) => {
    const cands = ctx.db.prepare('SELECT * FROM candidates WHERE contest_id = ? ORDER BY number').all(contest.id) as { id: number }[];
    submitResult(ctx, {
      election: fresh(), contest, unit: findUnit(ctx, fresh(), contest, code), candidates: cands as never,
      input: { votes: { [cands[0].id]: 10, [cands[1].id]: 5 }, stationsTotal: 10, stationsCounted: counted }, source: 'auto', user: null, approve: true,
    });
  };
  put(tp, '63000', 10);
  put(ntp, '65000', 9);
  runAutopilot(ctx, t0 + 60_000);
  assert.equal(status().status, 'live', '新北市還沒開完');
  put(ntp, '65000', 10);
  runAutopilot(ctx, t0 + 120_000);
  runAutopilot(ctx, t0 + 120_000 + 9 * 60_000);
  assert.equal(status().status, 'live', '開完未滿 10 分鐘');
  assert.equal(runAutopilot(ctx, t0 + 120_000 + 10 * 60_000).length, 1);
  assert.equal(status().status, 'final');
});
