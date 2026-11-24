import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presidential, loginAs, testApp, testCtx } from './helpers.ts';

const SONGSHAN = '63000010';

test('公開 API 不需登入；後台 API 拒絕未登入與回報員', async () => {
  const ctx = testCtx();
  const { election } = presidential(ctx);
  const app = await testApp(ctx);
  const pub = await app.inject({ url: `/api/elections/${election.id}/summary` });
  assert.equal(pub.statusCode, 200);
  assert.equal(pub.json().election.name, '測試總統大選');
  assert.equal((await app.inject({ url: '/api/admin/elections' })).statusCode, 401);
  const reporter = await loginAs(app, 'reporter', 'reporter-password');
  assert.equal((await app.inject({ url: '/api/admin/elections', headers: { cookie: reporter } })).statusCode, 403);
  const admin = await loginAs(app, 'admin', 'admin-password');
  assert.equal((await app.inject({ url: '/api/admin/elections', headers: { cookie: admin } })).statusCode, 200);
  await app.close();
});

test('草稿選舉不對外公開', async () => {
  const ctx = testCtx();
  const { election } = presidential(ctx);
  ctx.db.prepare("UPDATE elections SET status = 'draft' WHERE id = ?").run(election.id);
  ctx.bus.bump(election.id);
  const app = await testApp(ctx);
  assert.equal((await app.inject({ url: `/api/elections/${election.id}/summary` })).statusCode, 404);
  assert.deepEqual((await app.inject({ url: '/api/elections' })).json(), []);
  const admin = await loginAs(app, 'admin', 'admin-password');
  assert.equal((await app.inject({ url: `/api/elections/${election.id}/summary`, headers: { cookie: admin } })).statusCode, 200);
  await app.close();
});

test('登入錯誤與跨站請求會被擋下', async () => {
  const ctx = testCtx();
  const app = await testApp(ctx);
  const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong' } });
  assert.equal(bad.statusCode, 401);
  const admin = await loginAs(app, 'admin', 'admin-password');
  const cross = await app.inject({
    method: 'POST', url: '/api/admin/elections', headers: { cookie: admin, origin: 'https://evil.example', host: 'vote.example' },
    payload: { name: 'x', type: 'president', date: '2028-01-08' },
  });
  assert.equal(cross.statusCode, 403);
  await app.close();
});

test('回報員只能回報被指派的範圍；核准後公開數字才更新', async () => {
  const ctx = testCtx();
  const { election, contest, candidates } = presidential(ctx);
  const app = await testApp(ctx);
  const admin = await loginAs(app, 'admin', 'admin-password');
  const reporter = await loginAs(app, 'reporter', 'reporter-password');
  const reporterId = (ctx.db.prepare("SELECT id FROM users WHERE username = 'reporter'").get() as { id: number }).id;
  const payload = { contestId: contest.id, unitCode: SONGSHAN, votes: Object.fromEntries(candidates.map((c) => [c.id, 111])), invalid: 2 };

  const denied = await app.inject({ method: 'POST', url: '/api/report/submit', headers: { cookie: reporter }, payload });
  assert.equal(denied.statusCode, 403);

  const assign = await app.inject({
    method: 'PUT', url: `/api/admin/users/${reporterId}/assignments`, headers: { cookie: admin },
    payload: { electionId: election.id, areaCodes: ['63000'] },
  });
  assert.equal(assign.statusCode, 200);

  const units = await app.inject({ url: `/api/report/elections/${election.id}/units`, headers: { cookie: reporter } });
  assert.equal(units.json().units.length, 12);

  const sent = await app.inject({ method: 'POST', url: '/api/report/submit', headers: { cookie: reporter }, payload });
  assert.equal(sent.json().status, 'pending');
  assert.equal((await app.inject({ url: `/api/elections/${election.id}/summary` })).json().contests[0].totals.valid, 0);

  const pending = (await app.inject({ url: `/api/admin/submissions?election=${election.id}`, headers: { cookie: admin } })).json();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].unit_name, '臺北市 松山區');
  const ok = await app.inject({ method: 'POST', url: `/api/admin/submissions/${pending[0].id}/approve`, headers: { cookie: admin } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await app.inject({ url: `/api/elections/${election.id}/summary` })).json().contests[0].totals.valid, 333);

  // 開啟自動核准後，沒有警示的回報直接生效
  await app.inject({ method: 'PATCH', url: `/api/admin/elections/${election.id}`, headers: { cookie: admin }, payload: { auto_approve_reports: true } });
  const auto = await app.inject({ method: 'POST', url: '/api/report/submit', headers: { cookie: reporter }, payload: { ...payload, unitCode: '63000020' } });
  assert.equal(auto.json().status, 'approved');
  // 有警示（投票數超過選舉人數）的仍需人工審核
  const odd = await app.inject({ method: 'POST', url: '/api/report/submit', headers: { cookie: reporter }, payload: { ...payload, unitCode: '63000030', eligible: 10 } });
  assert.equal(odd.json().status, 'pending');
  await app.close();
});

test('後台匯入：預覽不寫入，正式匯入才生效；可用權杖推送資料', async () => {
  const ctx = testCtx();
  const { election } = presidential(ctx);
  const app = await testApp(ctx);
  const admin = await loginAs(app, 'admin', 'admin-password');
  const csv = `代碼,1號,2號,3號,無效票\n${SONGSHAN},10,20,30,1\n`;
  const url = `/api/admin/elections/${election.id}/import`;
  const preview = await app.inject({ method: 'POST', url, headers: { cookie: admin }, payload: { csv, dryRun: true } });
  assert.equal(preview.json().applied, 1);
  assert.equal((await app.inject({ url: `/api/elections/${election.id}/summary` })).json().contests[0].totals.valid, 0);
  await app.inject({ method: 'POST', url, headers: { cookie: admin }, payload: { csv } });
  assert.equal((await app.inject({ url: `/api/elections/${election.id}/summary` })).json().contests[0].totals.valid, 60);

  const created = await app.inject({
    method: 'POST', url: `/api/admin/elections/${election.id}/sources`, headers: { cookie: admin },
    payload: { name: '外部推送', kind: 'push', enabled: true },
  });
  const { id, token } = created.json();
  assert.ok(token);
  const body = { results: [{ county: '臺北市', town: '信義區', votes: { 1: 5, 2: 6, 3: 7 }, invalid: 0 }] };
  assert.equal((await app.inject({ method: 'POST', url: `/api/ingest/${id}`, headers: { authorization: 'Bearer nope' }, payload: body })).statusCode, 401);
  const pushed = await app.inject({ method: 'POST', url: `/api/ingest/${id}`, headers: { authorization: `Bearer ${token}` }, payload: body });
  assert.equal(pushed.json().applied, 1);
  assert.equal((await app.inject({ url: `/api/elections/${election.id}/summary` })).json().contests[0].totals.valid, 78);
  await app.close();
});
