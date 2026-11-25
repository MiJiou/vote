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

test('轉播版面：候選人照片、當選標示與快訊設定', async () => {
  const ctx = testCtx();
  const { election, contest, candidates } = presidential(ctx);
  const app = await testApp(ctx);
  const admin = await loginAs(app, 'admin', 'admin-password');
  const cand = candidates[0];
  const summary = async () => (await app.inject({ url: `/api/elections/${election.id}/summary` })).json();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const put = (dataUrl: string, cookie?: string) =>
    app.inject({ method: 'PUT', url: `/api/admin/candidates/${cand.id}/photo`, headers: cookie ? { cookie } : {}, payload: { dataUrl } });

  // 照片：只有管理員能上傳，只收真正的圖片
  assert.equal((await put(png)).statusCode, 401);
  assert.equal((await put('data:image/svg+xml;base64,PHN2Zy8+', admin)).statusCode, 400);
  assert.equal((await put('data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64'), admin)).statusCode, 400);
  const uploaded = await put(png, admin);
  assert.equal(uploaded.statusCode, 200);
  const photoUrl = uploaded.json().photo as string;
  assert.equal((await summary()).contests[0].candidates[0].photo, photoUrl);
  const photo = await app.inject({ url: photoUrl });
  assert.equal(photo.statusCode, 200);
  assert.equal(photo.headers['content-type'], 'image/png');
  assert.equal(photo.headers['x-content-type-options'], 'nosniff');

  // 當選標示
  assert.equal((await summary()).contests[0].candidates[0].declared, false);
  await app.inject({ method: 'POST', url: `/api/admin/candidates/${cand.id}/declare`, headers: { cookie: admin }, payload: { declared: true } });
  assert.equal((await summary()).contests[0].candidates[0].declared, true);
  // 修改候選人資料不會洗掉照片與當選標示
  await app.inject({ method: 'PATCH', url: `/api/admin/candidates/${cand.id}`, headers: { cookie: admin }, payload: { number: 1, name: '甲候選人改名', party: '台灣民眾黨' } });
  const after = (await summary()).contests[0].candidates[0];
  assert.deepEqual([after.name, after.declared, after.photo], ['甲候選人改名', true, photoUrl]);

  // 轉播設定：不合法的值會被修正，不屬於這場選舉的選舉區會被剔除
  const patched = await app.inject({
    method: 'PATCH', url: `/api/admin/elections/${election.id}`, headers: { cookie: admin },
    payload: { tv: { headline: '  開票快訊  ', headlineStyle: 'weird', focus: [contest.id, 99999], rotateSeconds: 1, defaultView: 'tv', extra: 'x' } },
  });
  assert.equal(patched.statusCode, 200);
  assert.deepEqual((await summary()).election.tv, { headline: '開票快訊', headlineStyle: 'alert', focus: [contest.id], rotateSeconds: 4, defaultView: 'tv' });
  // 只改一個欄位時，其他設定保留
  await app.inject({ method: 'PATCH', url: `/api/admin/elections/${election.id}`, headers: { cookie: admin }, payload: { tv: { headline: '' } } });
  assert.deepEqual((await summary()).election.tv, { headline: '', headlineStyle: 'alert', focus: [contest.id], rotateSeconds: 4, defaultView: 'tv' });

  // 移除照片
  await app.inject({ method: 'DELETE', url: `/api/admin/candidates/${cand.id}/photo`, headers: { cookie: admin } });
  assert.equal((await summary()).contests[0].candidates[0].photo, null);
  assert.equal((await app.inject({ url: photoUrl })).statusCode, 404);
  await app.close();
});

test('公開資料的壓縮快取：內容與未壓縮一致，草稿選舉不會因快取外洩', async () => {
  const { gunzipSync, brotliDecompressSync } = await import('node:zlib');
  const ctx = testCtx();
  const { election, contest, candidates } = presidential(ctx);
  const app = await testApp(ctx);
  const admin = await loginAs(app, 'admin', 'admin-password');
  await app.inject({ method: 'PUT', url: `/api/admin/contests/${contest.id}/units/63000010`, headers: { cookie: admin }, payload: { votes: Object.fromEntries(candidates.map((c) => [c.id, 1000])), invalid: 1 } });
  for (const url of [`/api/elections/${election.id}/summary`, `/api/elections/${election.id}/contests/${contest.id}/areas/63000`]) {
    const plain = await app.inject({ url });
    const gz = await app.inject({ url, headers: { 'accept-encoding': 'gzip' } });
    const br = await app.inject({ url, headers: { 'accept-encoding': 'gzip, br' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(gunzipSync(gz.rawPayload).toString(), plain.body);
    assert.equal(brotliDecompressSync(br.rawPayload).toString(), plain.body);
    assert.equal((await app.inject({ url, headers: { 'if-none-match': plain.headers.etag as string } })).statusCode, 304);
  }
  // 改成草稿後：版本變了，舊的快取不能再被公開讀到
  await app.inject({ method: 'PATCH', url: `/api/admin/elections/${election.id}`, headers: { cookie: admin }, payload: { status: 'draft' } });
  assert.equal((await app.inject({ url: `/api/elections/${election.id}/summary`, headers: { 'accept-encoding': 'gzip' } })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/elections/${election.id}/contests/${contest.id}/areas/63000`, headers: { 'accept-encoding': 'gzip' } })).statusCode, 404);
  await app.close();
});
