import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NATION } from '../server/db.ts';
import { createElection, listContests, listUnits, upsertCandidate } from '../server/domain.ts';
import { drill, findUnit, reviewSubmission, setLock, submitResult, summaryJson } from '../server/results.ts';
import { importStations, importTable, resultsCsv } from '../server/importer.ts';
import { parseCsv, parseCount, toCsv } from '../server/util.ts';
import { presidential, testCtx } from './helpers.ts';

const SONGSHAN = '63000010'; // 臺北市松山區
const XINYI = '63000020'; // 臺北市信義區
const BANQIAO = '65000010'; // 新北市板橋區

const admin = { id: 1, username: 'admin', display_name: '', role: 'admin' as const, active: 1 };

test('建立選舉會自動產生選舉區', () => {
  const ctx = testCtx();
  const p = createElection(ctx, { name: '總統', type: 'president', date: '2028-01-08' });
  assert.deepEqual(listContests(ctx, p.id).map((c) => c.area_code), [NATION]);
  const m = createElection(ctx, { name: '縣市長', type: 'mayor', date: '2026-11-28' });
  const contests = listContests(ctx, m.id);
  assert.equal(contests.length, 22);
  assert.equal(contests[0].name, '臺北市長選舉');
  assert.ok(contests.some((c) => c.name === '新竹縣長選舉'));
  assert.equal(listUnits(ctx, p, listContests(ctx, p.id)[0]).length, 368);
  assert.equal(listUnits(ctx, m, contests[0]).length, 12);
});

test('票數加總、領先者與各層級下鑽', () => {
  const ctx = testCtx();
  const { election, contest, candidates } = presidential(ctx);
  const [a, b, c] = candidates;
  const put = (code: string, votes: number[], invalid: number, eligible: number) =>
    submitResult(ctx, {
      election, contest, unit: findUnit(ctx, election, contest, code), candidates,
      input: { votes: { [a.id]: votes[0], [b.id]: votes[1], [c.id]: votes[2] }, invalid, eligible },
      source: 'admin', user: admin, approve: true,
    });
  assert.equal(put(SONGSHAN, [100, 300, 200], 6, 1000).status, 'approved');
  put(XINYI, [50, 100, 250], 4, 800);
  put(BANQIAO, [10, 20, 30], 0, 100);

  const summary = JSON.parse(summaryJson(ctx, election.id));
  const totals = summary.contests[0].totals;
  assert.equal(totals.votes[a.id], 160);
  assert.equal(totals.votes[b.id], 420);
  assert.equal(totals.votes[c.id], 480);
  assert.equal(totals.valid, 1060);
  assert.equal(totals.invalid, 10);
  assert.equal(totals.total, 1070);
  assert.equal(totals.leaderId, c.id);
  assert.equal(totals.unitsTotal, 368);
  assert.equal(totals.unitsReported, 3);
  assert.equal(totals.done, false);
  // 開票期間，沒有投開票所數的資料不確定是否開完，不計算投票率；標為開票完成後才計入。
  assert.equal(totals.turnout, null);
  ctx.db.prepare("UPDATE elections SET status = 'final' WHERE id = ?").run(election.id);
  ctx.bus.bump(election.id);
  assert.ok(Math.abs(JSON.parse(summaryJson(ctx, election.id)).contests[0].totals.turnout - 1070 / 1900) < 1e-9);

  const taipei = summary.contests[0].children.find((r: { code: string }) => r.code === '63000');
  assert.equal(taipei.totals.valid, 1000);
  assert.equal(taipei.totals.leaderId, c.id);
  assert.equal(taipei.totals.unitsReported, 2);

  const towns = drill(ctx, election.id, contest.id, '63000');
  assert.equal(towns.childLevel, 'town');
  assert.equal(towns.children.length, 12);
  assert.equal(towns.children.find((r) => r.code === SONGSHAN)!.totals.leaderId, b.id);
  assert.deepEqual(towns.path.map((p) => p.name), ['全國', '臺北市']);
});

test('相同資料重複送出不會產生新紀錄；修正後舊紀錄標為已取代', () => {
  const ctx = testCtx();
  const { election, contest, candidates } = presidential(ctx);
  const unit = findUnit(ctx, election, contest, SONGSHAN);
  const input = { votes: Object.fromEntries(candidates.map((c, i) => [c.id, (i + 1) * 10])), invalid: 1 };
  const base = { election, contest, unit, candidates, source: 'admin' as const, user: admin, approve: true };
  const first = submitResult(ctx, { ...base, input });
  assert.equal(submitResult(ctx, { ...base, input }).status, 'unchanged');
  const second = submitResult(ctx, { ...base, input: { ...input, invalid: 2 } });
  assert.equal(second.status, 'approved');
  const statuses = (ctx.db.prepare('SELECT id, status FROM submissions ORDER BY id').all() as { id: number; status: string }[]).map((r) => ({ ...r }));
  assert.deepEqual(statuses, [{ id: first.id, status: 'superseded' }, { id: second.id, status: 'approved' }]);
});

test('驗證：負數、非整數、未知候選人都會被拒絕；超過選舉人數給警示', () => {
  const ctx = testCtx();
  const { election, contest, candidates } = presidential(ctx);
  const unit = findUnit(ctx, election, contest, SONGSHAN);
  const base = { election, contest, unit, candidates, source: 'admin' as const, user: admin, approve: true };
  const ids = candidates.map((c) => c.id);
  assert.throws(() => submitResult(ctx, { ...base, input: { votes: { [ids[0]]: -1 } } }), /整數/);
  assert.throws(() => submitResult(ctx, { ...base, input: { votes: { [ids[0]]: '12.5' } } }), /整數/);
  assert.throws(() => submitResult(ctx, { ...base, input: { votes: { 99999: 1 } } }), /不屬於/);
  assert.throws(() => submitResult(ctx, { ...base, input: { votes: {}, stationsTotal: 3, stationsCounted: 5 } }), /不能大於/);
  const out = submitResult(ctx, { ...base, input: { votes: { [ids[0]]: 900, [ids[1]]: 200 }, eligible: 1000 } });
  assert.equal(out.warnings.length, 1);
  assert.equal(parseCount('1,234', 'x'), 1234);
  assert.equal(parseCount('１２３', 'x'), 123);
  assert.equal(parseCount('', 'x'), null);
});

test('回報需審核：待審核不影響公開數字，核准後才生效', () => {
  const ctx = testCtx();
  const { election, contest, candidates } = presidential(ctx);
  const unit = findUnit(ctx, election, contest, SONGSHAN);
  const input = { votes: Object.fromEntries(candidates.map((c) => [c.id, 100])), invalid: 0 };
  const out = submitResult(ctx, { election, contest, unit, candidates, input, source: 'reporter', user: null, approve: false });
  assert.equal(out.status, 'pending');
  assert.equal(JSON.parse(summaryJson(ctx, election.id)).contests[0].totals.valid, 0);
  reviewSubmission(ctx, out.id!, 'approve', admin);
  assert.equal(JSON.parse(summaryJson(ctx, election.id)).contests[0].totals.valid, 300);
  assert.throws(() => reviewSubmission(ctx, out.id!, 'reject', admin), /已經處理過/);
});

test('自動來源的進度：已開出 0 所不算已回報；部分開出不算完成', () => {
  const ctx = testCtx();
  const { election, contest, candidates } = presidential(ctx);
  const put = (code: string, n: number, counted: number) =>
    submitResult(ctx, {
      election, contest, unit: findUnit(ctx, election, contest, code), candidates,
      input: { votes: Object.fromEntries(candidates.map((c) => [c.id, n])), invalid: 0, eligible: 1000, stationsTotal: 10, stationsCounted: counted },
      source: 'auto', user: null, approve: true,
    });
  put(SONGSHAN, 0, 0);
  put(XINYI, 50, 4);
  put(BANQIAO, 100, 10);
  const taipei = drill(ctx, election.id, contest.id, '63000').area.totals;
  assert.equal(taipei.unitsReported, 1);
  assert.equal(taipei.turnout, null); // 還沒有任何一區開完，不顯示投票率
  assert.equal(taipei.stationsTotal, null); // 其餘 10 區尚未提供投開票所數
  const banqiao = drill(ctx, election.id, contest.id, BANQIAO).area.totals;
  assert.equal(banqiao.done, true);
  assert.equal(banqiao.stationsCounted, 10);
  assert.equal(banqiao.turnout, 0.3);
});

test('投開票所層級：已匯入清冊的鄉鎮以投開票所為單位，其餘退回鄉鎮', () => {
  const ctx = testCtx();
  const { election, contest, candidates } = presidential(ctx, 'station');
  const r = importStations(ctx, election, parseCsv('縣市,鄉鎮市區,投開票所,村里,名稱,選舉人數\n台北市,松山區,1,莊敬里,松山國小,1200\n臺北市,松山區,0002,東榮里,活動中心,900\n臺北市,不存在區,1,,,\n'), admin);
  assert.equal(r.upserted, 2);
  assert.equal(r.errors.length, 1);
  const units = listUnits(ctx, election, contest);
  assert.equal(units.length, 368 - 1 + 2);
  assert.ok(units.some((u) => u.code === `${SONGSHAN}-0001` && u.eligible === 1200));
  assert.throws(() => findUnit(ctx, election, contest, SONGSHAN), /沒有這個統計單位/);

  submitResult(ctx, {
    election, contest, unit: findUnit(ctx, election, contest, `${SONGSHAN}-0001`), candidates,
    input: { votes: Object.fromEntries(candidates.map((c) => [c.id, 200])), invalid: 0 }, source: 'admin', user: admin, approve: true,
  });
  const town = drill(ctx, election.id, contest.id, SONGSHAN);
  assert.equal(town.childLevel, 'station');
  assert.equal(town.children.length, 2);
  assert.equal(town.area.totals.stationsTotal, 2);
  assert.equal(town.area.totals.stationsCounted, 1);
  assert.equal(town.area.totals.turnout, 0.5); // 600 / 1200，選舉人數取自清冊
});

test('CSV 匯入：以名稱或代碼對應、空白列略過、加總不符報錯', () => {
  const ctx = testCtx();
  const { election, contest, candidates } = presidential(ctx);
  const csv = [
    '縣市,鄉鎮市區,1號 甲候選人,2號,丙候選人,無效票,有效票,選舉人數',
    '台北市,松山區,"1,000",2000,3000,10,6000,9000', // 台/臺 通用、千分位
    '臺北市,信義區,,,,,,', // 尚未開出 → 略過
    '臺北市,大安區,1,2,3,0,7,100', // 有效票對不上 → 錯誤
    '火星市,某區,1,2,3,0,,', // 不存在
    '新北市,板橋區,5,6,7,1,,',
  ].join('\n');
  const report = importTable(ctx, election, parseCsv(csv), { source: 'import', user: admin });
  assert.equal(report.applied, 2);
  assert.equal(report.skipped, 1);
  assert.equal(report.errorCount, 2);
  assert.match(report.errors[0].message, /不符/);
  assert.equal(report.errors[0].line, 4);
  assert.match(report.errors[1].message, /找不到縣市/);
  const totals = JSON.parse(summaryJson(ctx, election.id)).contests[0].totals;
  assert.equal(totals.votes[candidates[0].id], 1005);
  assert.equal(totals.votes[candidates[2].id], 3007);

  // 匯出再匯入應該完全一致
  const again = importTable(ctx, election, parseCsv(resultsCsv(ctx, election, true)), { source: 'import', user: admin });
  assert.equal(again.unchanged, 2);
  assert.equal(again.applied, 0);
  assert.equal(again.skipped, 366);
  assert.equal(again.errorCount, 0);
  void contest;
});

test('縣市長選舉：一份表格匯入多個選舉區，依地區自動對應', () => {
  const ctx = testCtx();
  const election = createElection(ctx, { name: '縣市長', type: 'mayor', date: '2026-11-28', unit_level: 'county', status: 'live' });
  const contests = listContests(ctx, election.id);
  const taipei = contests.find((c) => c.area_code === '63000')!;
  const hsinchu = contests.find((c) => c.area_code === '10004')!;
  upsertCandidate(ctx, taipei, { number: 1, name: '北一', party: '中國國民黨' });
  upsertCandidate(ctx, taipei, { number: 2, name: '北二', party: '民主進步黨' });
  upsertCandidate(ctx, taipei, { number: 3, name: '北三', party: '無黨籍' });
  upsertCandidate(ctx, hsinchu, { number: 1, name: '竹一', party: '民主進步黨' });
  upsertCandidate(ctx, hsinchu, { number: 2, name: '竹二', party: '中國國民黨' });
  const csv = '縣市,1號,2號,3號,無效票\n臺北市,100,200,50,3\n新竹縣,70,30,,1\n新竹縣,1,1,9,0\n';
  const report = importTable(ctx, election, parseCsv(csv), { source: 'import', user: admin });
  assert.equal(report.applied, 2);
  assert.equal(report.errorCount, 1); // 新竹縣沒有 3 號
  const summary = JSON.parse(summaryJson(ctx, election.id));
  const t = summary.contests.find((c: { areaCode: string }) => c.areaCode === '63000');
  const h = summary.contests.find((c: { areaCode: string }) => c.areaCode === '10004');
  assert.equal(t.totals.valid, 350);
  assert.equal(t.candidates.find((c: { id: number }) => c.id === t.totals.leaderId).name, '北二');
  assert.equal(h.candidates.find((c: { id: number }) => c.id === h.totals.leaderId).name, '竹一');
  assert.equal(h.totals.done, true);
  assert.equal(t.children, undefined);
});

test('鎖定的單位不會被批次匯入或自動來源覆蓋', () => {
  const ctx = testCtx();
  const { election, contest, candidates } = presidential(ctx);
  const csv = (n: number) => `代碼,1號,2號,3號,無效票\n${SONGSHAN},${n},${n},${n},0\n`;
  importTable(ctx, election, parseCsv(csv(10)), { source: 'auto', user: null, respectLock: true });
  setLock(ctx, contest, SONGSHAN, true, admin);
  const report = importTable(ctx, election, parseCsv(csv(99)), { source: 'auto', user: null, respectLock: true });
  assert.equal(report.locked, 1);
  assert.equal(JSON.parse(summaryJson(ctx, election.id)).contests[0].totals.valid, 30);
  void candidates;
});

test('CSV 工具：引號、換行、Tab 分隔與公式注入防護', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x,1","y ""q"""\n\n'), [['a', 'b'], ['x,1', 'y "q"']]);
  assert.deepEqual(parseCsv('縣市\t1號\n臺北市\t5\n'), [['縣市', '1號'], ['臺北市', '5']]);
  assert.ok(toCsv([['=SUM(A1)', -5, 'a,b']]).includes(`'=SUM(A1),-5,"a,b"`));
});
