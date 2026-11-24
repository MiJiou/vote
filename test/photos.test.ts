import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { findPhotos, plainText, setCommonsFetch, usableLicense } from '../server/commons.ts';
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
    if (url.hostname === 'commons.wikimedia.org' && url.pathname === '/w/api.php') {
      const meta = (artist: string, license: string) => ({ Artist: { value: artist }, LicenseShortName: { value: license } });
      return json({
        query: {
          normalized: [{ from: 'File:Jia portrait.jpg', to: 'File:Jia portrait.jpg' }],
          pages: [
            { title: 'File:Jia portrait.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/a.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Jia_portrait.jpg', extmetadata: meta('<a href="//x">王&amp;攝影</a>', 'CC BY-SA 4.0') }] },
            { title: 'File:Jia other.png', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/b.png', descriptionurl: '', extmetadata: meta('', 'CC0') }] },
            { title: 'File:Yi.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/c.jpg', descriptionurl: '', extmetadata: meta('某人', 'CC BY-NC-SA 2.0') }] },
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
  const { matches, excluded } = await findPhotos(['甲候選人', '乙候選人', '甲候選人', '查無此人']);
  assert.deepEqual(calls, ['query.wikidata.org', 'commons.wikimedia.org'], '所有姓名只發一次查詢');
  assert.ok(!calls.includes('www.wikidata.org'));
  const jia = matches.get('甲候選人')!;
  assert.equal(jia.length, 2);
  assert.equal(jia[0].qid, 'Q1', '臺灣的政治人物排第一');
  assert.equal(jia[0].description, '臺灣政治人物', '優先用繁體中文描述');
  assert.equal(jia[0].birthYear, '1970');
  assert.equal(jia[0].credit, '王&攝影／CC BY-SA 4.0／維基共享資源');
  assert.equal(jia[1].author, '作者不詳');
  assert.equal(matches.has('乙候選人'), false);
  assert.equal(excluded, 1);
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
