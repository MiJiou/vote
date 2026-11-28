import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { autoPick, findPhotos, plainText, setCommonsFetch, usableLicense } from '../server/commons.ts';
import type { PhotoMatch } from '../server/commons.ts';
import { matchPhotoFile } from '../web/src/admin/photoMatch.ts';
import { loginAs, presidential, testApp, testCtx } from './helpers.ts';

afterEach(() => setCommonsFetch(null));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const lit = (value: string, lang?: string) => ({ type: 'literal', value, ...(lang ? { 'xml:lang': lang } : {}) });
const uri = (value: string) => ({ type: 'uri', value });
const fp = (file: string) => uri(`http://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`);

/** 模擬維基數據＋維基共享資源：甲候選人有兩個同名的人，乙候選人的照片授權是 NC（不能用）。 */
function fakeWikimedia(calls: string[]) {
  setCommonsFetch(async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.hostname);
    if (url.hostname === 'query.wikidata.org') {
      assert.equal(init?.method, 'POST');
      assert.match(String(init?.body), /query=/);
      const query = new URLSearchParams(String(init?.body)).get('query') ?? '';
      if (/VALUES \?item/.test(query)) {
        // 中文維基百科找到的項目：補查國籍、職業、政黨
        assert.match(query, /wd:Q9/);
        return json({ results: { bindings: [{ item: uri('http://www.wikidata.org/entity/Q9'), tw: lit('1'), pol: lit('1'), party: lit('中國國民黨', 'zh-tw') }] } });
      }
      return json({
        results: {
          bindings: [
            { item: uri('http://www.wikidata.org/entity/Q1'), name: lit('甲候選人', 'zh'), image: fp('Jia_portrait.jpg'), desc: lit('臺灣政治人物', 'zh-tw'), dl: lit('zh-tw'), birth: lit('1970-05-01T00:00:00Z'), tw: lit('1'), pol: lit('1') },
            { item: uri('http://www.wikidata.org/entity/Q1'), name: lit('甲候選人', 'zh-hant'), image: fp('Jia_portrait.jpg'), desc: lit('台湾政治人物', 'zh'), dl: lit('zh') },
            { item: uri('http://www.wikidata.org/entity/Q2'), name: lit('甲候選人', 'zh'), image: fp('Jia other.png'), desc: lit('中國演員', 'zh') },
            { item: uri('http://www.wikidata.org/entity/Q3'), name: lit('乙候選人', 'zh'), image: fp('Yi.jpg'), tw: lit('1') },
          ],
        },
      });
    }
    if (url.hostname === 'zh.wikipedia.org') {
      assert.equal(url.searchParams.get('pilicense'), 'free');
      calls.push(`titles=${url.searchParams.get('titles')}`);
      return json({
        query: {
          converted: [{ from: '乙候選人', to: '乙候选人' }],
          redirects: [{ from: '乙候选人', to: '乙某' }],
          pages: [
            { title: '乙某', pageimage: 'Yi_wiki.jpg', description: '臺灣政治人物', pageprops: { wikibase_item: 'Q9' } },
            { title: '查無此人', missing: true },
          ],
        },
      });
    }
    if (url.hostname === 'commons.wikimedia.org' && url.searchParams.get('list') === 'search') {
      calls.push(`search=${url.searchParams.get('srsearch')}`);
      return json({ query: { search: [{ title: 'File:查無此人，2026年臺北市長選舉候選人肖像照.jpg' }, { title: 'File:別人.jpg' }, { title: 'File:查無此人甲肖像.jpg' }, { title: 'File:查無此人.pdf' }] } });
    }
    if (url.hostname === 'commons.wikimedia.org' && url.pathname === '/w/api.php') {
      const meta = (artist: string, license: string) => ({ Artist: { value: artist }, LicenseShortName: { value: license } });
      return json({
        query: {
          normalized: [{ from: 'File:Jia portrait.jpg', to: 'File:Jia portrait.jpg' }],
          pages: [
            { title: 'File:Jia portrait.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/a.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Jia_portrait.jpg', extmetadata: meta('<a href="//x">王&amp;攝影</a>', 'CC BY-SA 4.0') }] },
            { title: 'File:Jia other.png', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/b.png', descriptionurl: '', extmetadata: meta('', 'CC0') }] },
            { title: 'File:Yi.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/c.jpg', descriptionurl: '', extmetadata: meta('某人', 'CC BY-NC-SA 2.0') }] },
            { title: 'File:Yi wiki.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/d.jpg', descriptionurl: '', extmetadata: meta('丙', 'CC BY 4.0') }] },
            { title: 'File:查無此人，2026年臺北市長選舉候選人肖像照.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/e.jpg', descriptionurl: '', extmetadata: meta('丁', 'CC0') }] },
          ],
        },
      });
    }
    if (url.hostname === 'commons.wikimedia.org' && url.pathname.startsWith('/wiki/Special:FilePath/')) {
      const res = new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
      Object.defineProperty(res, 'url', { value: 'https://upload.wikimedia.org/x/Jia_portrait.jpg' });
      return res;
    }
    throw new Error('unexpected request ' + url);
  });
}

test('授權過濾與作者欄位整理', () => {
  for (const ok of ['CC BY-SA 4.0', 'CC BY 2.0', 'CC BY-SA 3.0 tw', 'CC0', 'Public domain', 'Attribution']) assert.ok(usableLicense(ok), ok);
  for (const bad of ['CC BY-NC-SA 2.0', 'CC BY-ND 4.0', 'GFDL', '', 'All rights reserved', 'Attribution-NonCommercial']) assert.ok(!usableLicense(bad), bad);
  assert.equal(plainText('<a href="x">王&amp;攝影</a>\n <span>(工作室)</span>'), '王&攝影 (工作室)');
});

test('維基共享資源搜尋：依可信度排序、剔除不可用授權、組出出處文字', async () => {
  const calls: string[] = [];
  fakeWikimedia(calls);
  const { matches, excluded, limited } = await findPhotos(['甲候選人', '乙候選人', '甲候選人', { name: '查無此人', area: '臺北市' }], { commonsGapMs: 0 });
  assert.deepEqual(
    calls,
    // 中文維基百科只查還沒找到本人的；它找到乙候選人後，檔名搜尋只剩查無此人
    ['query.wikidata.org', 'zh.wikipedia.org', 'titles=乙候選人|查無此人', 'query.wikidata.org', 'commons.wikimedia.org', 'search=intitle:"查無此人"', 'commons.wikimedia.org'],
    '每一層的所有姓名合併成一次查詢（檔名搜尋除外）',
  );
  assert.equal(limited, false);
  const jia = matches.get('甲候選人')!;
  assert.equal(jia.length, 2);
  assert.equal(jia[0].qid, 'Q1', '臺灣的政治人物排第一');
  assert.equal(jia[0].description, '臺灣政治人物', '優先用繁體中文描述');
  assert.equal(jia[0].birthYear, '1970');
  assert.equal(jia[0].credit, '王&攝影／CC BY-SA 4.0／維基共享資源');
  assert.equal(jia[1].author, '作者不詳');
  // 乙候選人：維基數據的照片授權是 NC（略過），改用中文維基百科條目的主圖（經繁簡轉換與重新導向）
  const yi = matches.get('乙候選人')!;
  assert.equal(yi.length, 1);
  assert.equal(yi[0].file, 'Yi wiki.jpg');
  assert.equal(yi[0].via, 'wikipedia');
  assert.ok(yi[0].taiwan && yi[0].politician);
  assert.deepEqual(yi[0].parties, ['中國國民黨']);
  assert.equal(excluded, 1);
  // 查無此人：只有維基共享資源上的檔名提到，檔名有縣市與「候選人」才算可信
  const nobody = matches.get('查無此人')!;
  assert.equal(nobody.length, 1);
  assert.equal(nobody[0].via, 'commons');
  assert.ok(nobody[0].taiwan && nobody[0].politician);
  assert.equal(nobody[0].credit, '丁／CC0／維基共享資源');
});

test('後台 API：搜尋照片、經伺服器下載、上傳後出處顯示在看板資料中', async () => {
  const ctx = testCtx();
  const { election, candidates } = presidential(ctx);
  const app = await testApp(ctx);
  const admin = await loginAs(app, 'admin', 'admin-password');
  fakeWikimedia([]);

  assert.equal((await app.inject({ url: `/api/admin/elections/${election.id}/commons-photos` })).statusCode, 401);
  const res = await app.inject({ url: `/api/admin/elections/${election.id}/commons-photos`, headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.candidates.length, 3);
  assert.equal(body.candidates[0].name, '甲候選人');
  assert.equal(body.candidates[0].matches[0].file, 'Jia portrait.jpg');

  const img = await app.inject({ url: `/api/admin/commons/image?file=${encodeURIComponent('Jia portrait.jpg')}`, headers: { cookie: admin } });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/jpeg');
  // 轉址到維基媒體以外的網域時拒絕
  setCommonsFetch(async () => {
    const res = new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
    Object.defineProperty(res, 'url', { value: 'https://evil.example/wikimedia.org.jpg' });
    return res;
  });
  assert.equal((await app.inject({ url: `/api/admin/commons/image?file=x.jpg`, headers: { cookie: admin } })).statusCode, 502);
  fakeWikimedia([]);
  for (const bad of ['../etc/passwd', 'a/b.jpg', 'x?y=1', '']) {
    assert.equal((await app.inject({ url: `/api/admin/commons/image?file=${encodeURIComponent(bad)}`, headers: { cookie: admin } })).statusCode, 400, bad);
  }

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const credit = body.candidates[0].matches[0].credit;
  await app.inject({ method: 'PUT', url: `/api/admin/candidates/${candidates[0].id}/photo`, headers: { cookie: admin }, payload: { dataUrl: png, credit } });
  const summary = async () => (await app.inject({ url: `/api/elections/${election.id}/summary` })).json().contests[0].candidates[0];
  assert.equal((await summary()).photoCredit, credit);
  // 已有照片的候選人預設不再搜尋
  assert.equal((await app.inject({ url: `/api/admin/elections/${election.id}/commons-photos`, headers: { cookie: admin } })).json().candidates.length, 2);
  // 移除照片時出處一併清除
  await app.inject({ method: 'DELETE', url: `/api/admin/candidates/${candidates[0].id}/photo`, headers: { cookie: admin } });
  assert.equal((await summary()).photoCredit, '');
  await app.close();
});

test('維基媒體限制連線時，回報清楚的錯誤訊息', async () => {
  const ctx = testCtx();
  const { election } = presidential(ctx);
  const app = await testApp(ctx);
  const admin = await loginAs(app, 'admin', 'admin-password');
  let n = 0;
  setCommonsFetch(async () => {
    n++;
    return new Response('You are making too many requests to the API.', { status: 429, headers: { 'retry-after': '0' } });
  });
  const res = await app.inject({ url: `/api/admin/elections/${election.id}/commons-photos`, headers: { cookie: admin } });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error, /過幾分鐘再試/);
  assert.equal(n, 3, '重試兩次後放棄');
  await app.close();
});

test('依檔名配對候選人', () => {
  const cands = [
    { id: 1, number: 6, name: '蔣萬安', contestId: 10, areaName: '臺北市' },
    { id: 2, number: 12, name: '陳時中', contestId: 10, areaName: '臺北市' },
    { id: 3, number: 2, name: '侯友宜', contestId: 11, areaName: '新北市' },
    { id: 4, number: 1, name: '王小明', contestId: 12, areaName: '新竹市' },
    { id: 5, number: 1, name: '王小明', contestId: 13, areaName: '新竹縣' },
    { id: 6, number: 3, name: '李四', contestId: 13, areaName: '新竹縣' },
  ];
  const id = (f: string) => matchPhotoFile(f, cands).candidateId;
  assert.equal(id('臺北市-6.jpg'), 1);
  assert.equal(id('台北市_06.JPG'), 1);
  assert.equal(id('台北12號.png'), 2);
  assert.equal(id('蔣萬安.jpg'), 1);
  assert.equal(id('6 蔣萬安 (1).jpeg'), 1);
  assert.equal(id('新北市-侯友宜.webp'), 3);
  assert.equal(id('王小明.jpg'), null, '同名需要縣市');
  assert.match(matchPhotoFile('王小明.jpg', cands).reason, /同名/);
  assert.equal(id('新竹市-王小明.jpg'), 4);
  assert.equal(id('新竹縣-王小明.jpg'), 5);
  assert.equal(id('新竹-3.jpg'), null, '「新竹」同時是新竹市與新竹縣，不能縮寫');
  assert.equal(id('新竹縣-3.jpg'), 6);
  assert.equal(id('6.jpg'), null, '多個選舉區時只有號次不夠');
  assert.equal(id('臺北市-99.jpg'), null);
  assert.equal(id('IMG_2041.jpg'), null);
  const single = cands.filter((c) => c.contestId === 10);
  assert.equal(matchPhotoFile('12.jpg', single).candidateId, 2);
  assert.equal(matchPhotoFile('第6號.png', single).candidateId, 1);
});

test('照片搜尋：同名的人依政黨排序；檔名搜尋被限制時停下並回報', async () => {
  setCommonsFetch(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'query.wikidata.org') {
      const query = new URLSearchParams(String(init?.body)).get('query') ?? '';
      if (/VALUES \?item/.test(query)) return json({ results: { bindings: [] } });
      const row = (q: string, file: string, party: string) => ({ item: uri(`http://www.wikidata.org/entity/${q}`), name: lit('許某', 'zh'), image: fp(file), tw: lit('1'), pol: lit('1'), party: lit(party, 'zh') });
      return json({ results: { bindings: [row('Q1', 'A.jpg', '民主進步黨'), row('Q2', 'B.jpg', '中國國民黨'), row('Q2', 'B.jpg', '無黨團結聯盟')] } });
    }
    if (url.hostname === 'zh.wikipedia.org') return json({ query: { pages: [{ title: '王某', missing: true }] } });
    if (url.searchParams.get('list') === 'search') return new Response('You are making too many requests to the API.', { status: 429 });
    const pages = ['A.jpg', 'B.jpg'].map((f) => ({ title: `File:${f}`, imageinfo: [{ thumburl: `https://upload.wikimedia.org/${f}`, extmetadata: { LicenseShortName: { value: 'CC0' } } }] }));
    return json({ query: { pages } });
  });
  const { matches, limited } = await findPhotos([{ name: '許某', party: '中國國民黨' }, { name: '王某' }, { name: '李某' }], { commonsGapMs: 0 });
  const xu = matches.get('許某')!;
  assert.deepEqual(xu.map((m) => m.qid), ['Q2', 'Q1'], '政黨相同的排前面');
  assert.deepEqual(xu[0].parties, ['中國國民黨', '無黨團結聯盟']);
  assert.equal(limited, true);
  assert.equal(matches.has('王某'), false);
});

test('依檔名「縣市-號次」批次套用照片：預設只補沒有照片的人', async () => {
  const { importPhotoFiles } = await import('../server/photos.ts');
  const ctx = testCtx();
  const { election, candidates } = presidential(ctx);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const area = '全國';
  const first = importPhotoFiles(ctx, election.id, [{ file: `${area}-1.jpg`, data: jpeg }], { credit: '甲' });
  assert.deepEqual(first.applied.length, 1);
  const files = [
    { file: `${area}-1.jpg`, data: jpeg },
    { file: `${area}-02.jpg`, data: jpeg },
    { file: '臺北市-9.jpg', data: jpeg },
    { file: 'readme.txt', data: jpeg },
  ];
  const r = importPhotoFiles(ctx, election.id, files, { credit: '中選會選舉公報' });
  assert.equal(r.applied.length, 1, '2 號補上照片');
  assert.equal(r.kept.length, 1, '1 號已有照片，保留');
  assert.deepEqual(r.unmatched, ['臺北市-9.jpg', 'readme.txt']);
  const credit = (id: number) => (ctx.db.prepare('SELECT photo_credit FROM candidates WHERE id = ?').get(id) as { photo_credit: string }).photo_credit;
  assert.equal(credit(candidates[0].id), '甲');
  assert.equal(credit(candidates[1].id), '中選會選舉公報');
  // 覆寫模式；內容不是圖片時拒絕
  assert.equal(importPhotoFiles(ctx, election.id, [{ file: `${area}-1.jpg`, data: jpeg }], { credit: '公報', overwrite: true }).applied.length, 1);
  assert.equal(credit(candidates[0].id), '公報');
  assert.throws(() => importPhotoFiles(ctx, election.id, [{ file: `${area}-3.jpg`, data: Buffer.from('<svg/>') }], { credit: 'x' }));
});

test('自動挑選照片：只在能確定是本人時選', () => {
  const m = (over: Partial<PhotoMatch>) => ({ taiwan: true, politician: true, parties: [], file: 'x', ...over }) as PhotoMatch;
  assert.equal(autoPick([m({ file: 'a' }), m({ file: 'b', politician: false })], '')?.file, 'a', '恰好一位臺灣政治人物');
  assert.equal(autoPick([m({ file: 'a', parties: ['民主進步黨'] }), m({ file: 'b', parties: ['中國國民黨'] })], '中國國民黨')?.file, 'b', '同名時看政黨');
  assert.equal(autoPick([m({ file: 'a' }), m({ file: 'b' })], '中國國民黨'), null, '分不出來就不選');
  assert.equal(autoPick([m({ file: 'a', politician: false })], ''), null, '例如同名的藝人');
  assert.equal(autoPick([m({ file: 'a', parties: ['台灣民眾黨'] }), m({ file: 'b' })], '臺灣民眾黨')?.file, 'a', '台／臺 視為相同');
});
