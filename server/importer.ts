import { NATION, tx } from './db.ts';
import type { Candidate, Contest, Ctx, Election, Unit, User } from './domain.ts';
import { audit, candidatesByContest, listContests, listUnits, stationUnitCode, upsertCandidate } from './domain.ts';
import type { ResultInput, ResultRow, Source } from './results.ts';
import { submitResult } from './results.ts';
import { HttpError, normName, normStationNo, parseCount, toCsv } from './util.ts';

/** 來源無關的一列票數；CSV、Excel、JSON、中選會資料都先轉成這個形狀再套用。 */
export type NormRow = {
  line: number;
  contest?: string;
  code?: string;
  county?: string;
  town?: string;
  station?: string;
  /** 以號次指定的得票數 */
  byNumber: Map<number, unknown>;
  /** 以候選人姓名（已正規化）指定的得票數 */
  byName: Map<string, unknown>;
  invalid?: unknown;
  eligible?: unknown;
  stationsTotal?: unknown;
  stationsCounted?: unknown;
  valid?: unknown;
  total?: unknown;
};

export type ImportReport = {
  rows: number;
  applied: number;
  pending: number;
  unchanged: number;
  skipped: number;
  locked: number;
  errorCount: number;
  errors: { line: number; message: string }[];
  warnings: { line: number; message: string }[];
};

const ALIASES: Record<string, string[]> = {
  contest: ['contest', '選舉項目', '選舉區', '選舉'],
  code: ['code', '代碼', '區域代碼', '單位代碼', 'unit', 'unitcode', 'unit_code'],
  county: ['county', '縣市', '縣市別'],
  town: ['town', '鄉鎮市區', '鄉鎮', '行政區', '鄉鎮市區別'],
  station: ['station', 'stationno', 'station_no', '投開票所', '投開票所編號', '投票所', '票所', '投開票所別'],
  invalid: ['invalid', '無效票', '無效票數'],
  eligible: ['eligible', '選舉人數', '選舉人'],
  stationsTotal: ['stationstotal', 'stations_total', '投開票所總數', '應開投開票所數', '總投開票所數'],
  stationsCounted: ['stationscounted', 'stations_counted', '已開出投開票所數', '已開投開票所數', '已開出'],
  valid: ['valid', '有效票', '有效票數'],
  total: ['total', '投票數', '總投票數'],
  ignore: ['name', '名稱', '單位名稱', 'village', '村里', '村里別', '備註', 'note', '投票率', '得票率', '候選人姓名', '姓名'],
};
const FIELD_OF = new Map<string, string>();
for (const [field, names] of Object.entries(ALIASES)) for (const n of names) FIELD_OF.set(normName(n), field);

const NUMBER_HEADER = /^[(（]?(\d{1,2})(?!\d)[)）]?號?(.*)$/;
const CAND_HEADER = /^(?:cand|candidate|候選人)_?(\d{1,2})$/;

type Column = { field: string } | { number: number } | { name: string } | null;

/** 把表格（第一列為標題）轉成 NormRow。 */
export function tableToRows(table: string[][], candidateNames: Set<string>): { rows: NormRow[]; unknown: string[] } {
  if (!table.length) throw new HttpError(400, '檔案是空的');
  const unknown: string[] = [];
  const columns: Column[] = table[0].map((raw) => {
    const h = normName(String(raw ?? ''));
    if (!h) return null;
    const field = FIELD_OF.get(h);
    if (field) return field === 'ignore' ? null : { field };
    const cand = CAND_HEADER.exec(h);
    if (cand) return { number: Number(cand[1]) };
    if (candidateNames.has(h)) return { name: h };
    const num = NUMBER_HEADER.exec(h);
    if (num) return { number: Number(num[1]) };
    unknown.push(String(raw).trim());
    return null;
  });
  if (!columns.some((c) => c && ('number' in c || 'name' in c))) {
    throw new HttpError(400, '找不到候選人得票欄位。欄位名稱請用號次（例如「1號」）或候選人姓名，建議先下載範本。');
  }
  const rows: NormRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const row: NormRow = { line: i + 1, byNumber: new Map(), byName: new Map() };
    columns.forEach((col, j) => {
      if (!col) return;
      const v = (table[i][j] ?? '').toString().trim();
      if ('number' in col) row.byNumber.set(col.number, v);
      else if ('name' in col) row.byName.set(col.name, v);
      else (row as unknown as Record<string, unknown>)[col.field] = v;
    });
    rows.push(row);
  }
  return { rows, unknown };
}

/** 標準 JSON 格式：{ "results": [{ code | county/town/station, votes: { "1": 123 }, invalid, eligible, ... }] } */
export function jsonToRows(data: unknown): NormRow[] {
  const list = Array.isArray(data) ? data : (data as { results?: unknown })?.results;
  if (!Array.isArray(list)) throw new HttpError(400, 'JSON 格式不符：需要 results 陣列');
  return list.map((item, i) => {
    if (!item || typeof item !== 'object') throw new HttpError(400, `第 ${i + 1} 筆不是物件`);
    const o = item as Record<string, unknown>;
    const row: NormRow = { line: i + 1, byNumber: new Map(), byName: new Map() };
    for (const k of ['contest', 'code', 'county', 'town', 'station'] as const) if (o[k] != null) row[k] = String(o[k]);
    for (const k of ['invalid', 'eligible', 'stationsTotal', 'stationsCounted', 'valid', 'total'] as const) if (o[k] != null) row[k] = o[k];
    const votes = o.votes;
    if (!votes || typeof votes !== 'object') throw new HttpError(400, `第 ${i + 1} 筆缺少 votes`);
    for (const [k, v] of Object.entries(votes as Record<string, unknown>)) {
      if (/^\d{1,2}$/.test(k)) row.byNumber.set(Number(k), v);
      else row.byName.set(normName(k), v);
    }
    return row;
  });
}

export function electionCandidateNames(ctx: Ctx, electionId: number): Set<string> {
  const names = new Set<string>();
  for (const list of candidatesByContest(ctx, electionId).values()) for (const c of list) names.add(normName(c.name));
  return names;
}

const blank = (v: unknown): boolean => v === undefined || v === null || String(v).trim() === '';

export type ApplyOptions = {
  source: Source;
  sourceRef?: string;
  user: User | null;
  respectLock?: boolean;
  approve?: boolean;
};

/** 把整批票數套用到一場選舉；每列各自成功或失敗，互不影響。 */
export function applyRows(ctx: Ctx, election: Election, rows: NormRow[], opts: ApplyOptions): ImportReport {
  const report: ImportReport = { rows: rows.length, applied: 0, pending: 0, unchanged: 0, skipped: 0, locked: 0, errorCount: 0, errors: [], warnings: [] };
  const contests = listContests(ctx, election.id);
  const cands = candidatesByContest(ctx, election.id);
  const contestByKey = new Map<string, Contest>();
  for (const c of contests) {
    contestByKey.set(String(c.id), c);
    contestByKey.set(normName(ctx.areas.name(c.area_code)), c);
    contestByKey.set(normName(c.name), c);
  }
  const countyByName = new Map(ctx.areas.counties.map((c) => [normName(c.name), c.code]));
  const townIndex = new Map<string, Map<string, string>>();
  const townsOfCounty = (county: string) => {
    if (!townIndex.has(county)) townIndex.set(county, new Map((ctx.areas.townsOf.get(county) ?? []).map((t) => [normName(t.name), t.code])));
    return townIndex.get(county)!;
  };
  const unitIndex = new Map<number, Map<string, Unit>>();
  const unitsOf = (c: Contest) => {
    if (!unitIndex.has(c.id)) unitIndex.set(c.id, new Map(listUnits(ctx, election, c).map((u) => [u.code, u])));
    return unitIndex.get(c.id)!;
  };
  const levelName = { county: '縣市', town: '鄉鎮市區', station: '投開票所' }[election.unit_level];

  const resolveCode = (row: NormRow): string => {
    if (!blank(row.code)) {
      const code = String(row.code).trim();
      const m = /^(\d{8})-(.+)$/.exec(code);
      return m ? stationUnitCode(m[1], normStationNo(m[2])) : code;
    }
    if (blank(row.county)) throw new HttpError(400, '缺少地區欄位（需要「代碼」或「縣市」）');
    const county = countyByName.get(normName(String(row.county)));
    if (!county) throw new HttpError(400, `找不到縣市「${row.county}」`);
    if (blank(row.town)) {
      if (!blank(row.station)) throw new HttpError(400, '有投開票所編號時必須同時提供鄉鎮市區');
      return county;
    }
    const town = townsOfCounty(county).get(normName(String(row.town)));
    if (!town) throw new HttpError(400, `${row.county} 沒有「${row.town}」這個鄉鎮市區`);
    return blank(row.station) ? town : stationUnitCode(town, normStationNo(String(row.station)));
  };

  const resolveContest = (row: NormRow, code: string): Contest => {
    if (!blank(row.contest)) {
      const c = contestByKey.get(normName(String(row.contest)));
      if (!c) throw new HttpError(400, `找不到選舉項目「${row.contest}」`);
      return c;
    }
    const county = code.slice(0, 5);
    const matches = contests.filter((c) => c.area_code === NATION || c.area_code === county);
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw new HttpError(400, `這場選舉沒有涵蓋「${ctx.areas.name(county)}」的選舉區`);
    throw new HttpError(400, '這個地區對應多個選舉區，請加上「選舉項目」欄位');
  };

  const fail = (line: number, message: string) => {
    report.errorCount++;
    if (report.errors.length < 200) report.errors.push({ line, message });
  };

  tx(ctx.db, () => {
    for (const row of rows) {
      try {
        const code = resolveCode(row);
        const contest = resolveContest(row, code);
        const candidates: Candidate[] = cands.get(contest.id) ?? [];
        const unit = unitsOf(contest).get(code);
        if (!unit) {
          throw new HttpError(400, `「${code}」不是「${contest.name}」的統計單位（這場選舉以${levelName}為單位登錄票數）`);
        }
        const votes: Record<string, unknown> = {};
        let anyValue = false;
        for (const c of candidates) {
          const v = row.byNumber.has(c.number) ? row.byNumber.get(c.number) : row.byName.get(normName(c.name));
          if (!blank(v)) anyValue = true;
          votes[String(c.id)] = blank(v) ? 0 : v;
        }
        for (const n of row.byNumber.keys()) {
          if (!blank(row.byNumber.get(n)) && !candidates.some((c) => c.number === n)) {
            throw new HttpError(400, `${contest.name} 沒有 ${n} 號候選人，但該欄有數字`);
          }
        }
        if (!anyValue && blank(row.invalid)) {
          report.skipped++;
          continue;
        }
        const sum = Object.entries(votes).reduce((s, [id, v]) => s + (parseCount(v, `候選人 ${id} 得票數`) ?? 0), 0);
        const invalid = parseCount(row.invalid, '無效票');
        const valid = parseCount(row.valid, '有效票');
        if (valid !== null && valid !== sum) throw new HttpError(400, `各候選人得票加總 ${sum} 與有效票 ${valid} 不符`);
        const total = parseCount(row.total, '投票數');
        if (total !== null && total !== sum + (invalid ?? 0)) throw new HttpError(400, `有效票＋無效票 ${sum + (invalid ?? 0)} 與投票數 ${total} 不符`);

        const input: ResultInput = { votes, invalid: row.invalid, eligible: row.eligible, stationsTotal: row.stationsTotal, stationsCounted: row.stationsCounted };
        const out = submitResult(ctx, {
          election, contest, unit, candidates, input,
          source: opts.source, sourceRef: opts.sourceRef, user: opts.user,
          approve: opts.approve ?? true, respectLock: opts.respectLock,
        });
        if (out.status === 'approved') report.applied++;
        else report[out.status]++;
        for (const w of out.warnings) if (report.warnings.length < 200) report.warnings.push({ line: row.line, message: `${unit.name}：${w}` });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        fail(row.line, err.message);
      }
    }
  });
  return report;
}

export function importTable(ctx: Ctx, election: Election, table: string[][], opts: ApplyOptions): ImportReport {
  const { rows, unknown } = tableToRows(table, electionCandidateNames(ctx, election.id));
  const report = applyRows(ctx, election, rows, opts);
  if (unknown.length) report.warnings.unshift({ line: 1, message: `已忽略無法辨識的欄位：${unknown.join('、')}` });
  return report;
}

// ---------- 範本與匯出 ----------

/** 票數範本（filled = true 時填入目前生效的票數，即為匯出）。 */
export function resultsCsv(ctx: Ctx, election: Election, filled: boolean): string {
  const contests = listContests(ctx, election.id);
  const cands = candidatesByContest(ctx, election.id);
  const single = contests.length === 1;
  const maxNumber = Math.max(0, ...[...cands.values()].flat().map((c) => c.number));
  const numbers = Array.from({ length: maxNumber }, (_, i) => i + 1);
  const candHeader = (n: number) => {
    const c = single ? cands.get(contests[0].id)?.find((x) => x.number === n) : undefined;
    return c ? `${n}號 ${c.name}` : `${n}號`;
  };
  const station = election.unit_level === 'station';
  const header = ['選舉項目', '代碼', '縣市', ...(election.unit_level === 'county' ? [] : ['鄉鎮市區']), ...(station ? ['投開票所', '名稱'] : []),
    ...numbers.map(candHeader), '無效票', '選舉人數', '投開票所總數', '已開出投開票所數'];
  const out: (string | number | null)[][] = [header];
  for (const contest of contests) {
    const list = cands.get(contest.id) ?? [];
    const results = filled
      ? new Map((ctx.db.prepare('SELECT * FROM results WHERE contest_id = ?').all(contest.id) as ResultRow[]).map((r) => [r.unit_code, r]))
      : new Map<string, ResultRow>();
    for (const u of listUnits(ctx, election, contest)) {
      const r = results.get(u.code);
      const votes = r ? (JSON.parse(r.votes) as Record<string, number>) : null;
      const row: (string | number | null)[] = [contest.name, u.code, ctx.areas.name(u.countyCode)];
      if (election.unit_level !== 'county') row.push(u.townCode ? ctx.areas.name(u.townCode) : '');
      if (station) row.push(u.level === 'station' ? u.code.split('-')[1] : '', u.level === 'station' ? u.name : '');
      for (const n of numbers) {
        const c = list.find((x) => x.number === n);
        row.push(c && votes ? (votes[String(c.id)] ?? 0) : null);
      }
      row.push(r?.invalid_votes ?? null, r?.eligible_voters ?? u.eligible, r?.stations_total ?? null, r?.stations_counted ?? null);
      out.push(row);
    }
  }
  return toCsv(out);
}

// ---------- 投開票所清冊 ----------

export function importStations(ctx: Ctx, election: Election, table: string[][], user: User) {
  if (table.length < 2) throw new HttpError(400, '檔案沒有資料列');
  const idx: Record<string, number> = {};
  table[0].forEach((raw, j) => {
    const h = normName(String(raw ?? ''));
    const field = FIELD_OF.get(h);
    if (field && field !== 'ignore') idx[field] = j;
    else if (['name', '名稱', '投開票所名稱', '地點', '設置地點'].includes(h)) idx.name = j;
    else if (['village', '村里', '村里別'].includes(h)) idx.village = j;
  });
  if (idx.station === undefined) throw new HttpError(400, '缺少「投開票所」編號欄位');
  if (idx.code === undefined && (idx.county === undefined || idx.town === undefined)) {
    throw new HttpError(400, '需要「代碼」（鄉鎮市區代碼）或「縣市」＋「鄉鎮市區」欄位');
  }
  const countyByName = new Map(ctx.areas.counties.map((c) => [normName(c.name), c.code]));
  const errors: { line: number; message: string }[] = [];
  let upserted = 0;
  const stmt = ctx.db.prepare(
    `INSERT INTO stations (election_id, town_code, station_no, name, village, eligible_voters) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (election_id, town_code, station_no) DO UPDATE SET name = excluded.name, village = excluded.village, eligible_voters = excluded.eligible_voters`,
  );
  tx(ctx.db, () => {
    for (let i = 1; i < table.length; i++) {
      const cell = (k: string) => (idx[k] === undefined ? '' : (table[i][idx[k]] ?? '').toString().trim());
      try {
        let town = cell('code').slice(0, 8);
        if (!town) {
          const county = countyByName.get(normName(cell('county')));
          if (!county) throw new HttpError(400, `找不到縣市「${cell('county')}」`);
          const t = (ctx.areas.townsOf.get(county) ?? []).find((x) => normName(x.name) === normName(cell('town')));
          if (!t) throw new HttpError(400, `${cell('county')} 沒有「${cell('town')}」這個鄉鎮市區`);
          town = t.code;
        } else if (ctx.areas.byCode.get(town)?.level !== 'town') throw new HttpError(400, `「${town}」不是鄉鎮市區代碼`);
        const no = normStationNo(cell('station'));
        if (!no || /[\s-]/.test(no)) throw new HttpError(400, '投開票所編號不可空白，也不可包含空白或連字號');
        stmt.run(election.id, town, no, cell('name'), cell('village'), parseCount(cell('eligible'), '選舉人數'));
        upserted++;
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        if (errors.length < 200) errors.push({ line: i + 1, message: err.message });
      }
    }
    audit(ctx, user, 'stations.import', { election: election.name, upserted, errors: errors.length });
  });
  ctx.bus.bump(election.id);
  return { rows: table.length - 1, upserted, errors };
}

export function stationsCsv(ctx: Ctx, election: Election): string {
  const rows = ctx.db.prepare('SELECT * FROM stations WHERE election_id = ? ORDER BY town_code, station_no').all(election.id) as {
    town_code: string; station_no: string; name: string; village: string; eligible_voters: number | null;
  }[];
  const out: (string | number | null)[][] = [['縣市', '鄉鎮市區', '投開票所', '村里', '名稱', '選舉人數']];
  if (!rows.length) out.push(['臺北市', '松山區', '0001', '莊敬里', '（範例）松山國小', 1200]);
  for (const s of rows) {
    const town = ctx.areas.byCode.get(s.town_code);
    out.push([town ? ctx.areas.name(town.parent!) : '', town?.name ?? s.town_code, s.station_no, s.village, s.name, s.eligible_voters]);
  }
  return toCsv(out);
}

// ---------- 候選人名單 ----------

export function importCandidates(ctx: Ctx, election: Election, table: string[][], user: User) {
  if (table.length < 2) throw new HttpError(400, '檔案沒有資料列');
  const want: Record<string, string[]> = {
    contest: ['選舉項目', '選舉區', '縣市', 'contest', 'county'],
    number: ['號次', 'number', 'no'],
    name: ['姓名', '候選人', '候選人姓名', '總統候選人', 'name'],
    mate: ['副手', '副總統候選人', '副總統', 'runningmate', 'running_mate'],
    party: ['政黨', '推薦政黨', '黨籍', 'party'],
    color: ['顏色', 'color'],
  };
  const idx: Record<string, number> = {};
  table[0].forEach((raw, j) => {
    const h = normName(String(raw ?? ''));
    for (const [field, names] of Object.entries(want)) if (names.some((n) => normName(n) === h)) idx[field] = j;
  });
  if (idx.number === undefined || idx.name === undefined) throw new HttpError(400, '需要「號次」與「姓名」欄位');
  const contests = listContests(ctx, election.id);
  const byKey = new Map<string, Contest>();
  for (const c of contests) {
    byKey.set(normName(c.name), c);
    byKey.set(normName(ctx.areas.name(c.area_code)), c);
  }
  const errors: { line: number; message: string }[] = [];
  let upserted = 0;
  tx(ctx.db, () => {
    for (let i = 1; i < table.length; i++) {
      const cell = (k: string) => (idx[k] === undefined ? '' : (table[i][idx[k]] ?? '').toString().trim());
      try {
        const contest = contests.length === 1 && !cell('contest') ? contests[0] : byKey.get(normName(cell('contest')));
        if (!contest) throw new HttpError(400, cell('contest') ? `找不到選舉項目「${cell('contest')}」` : '缺少「選舉項目」或「縣市」');
        const number = Number(cell('number'));
        const existing = ctx.db.prepare('SELECT id FROM candidates WHERE contest_id = ? AND number = ?').get(contest.id, number) as { id: number } | undefined;
        upsertCandidate(ctx, contest, { number, name: cell('name'), running_mate: cell('mate'), party: cell('party'), color: cell('color') }, existing?.id);
        upserted++;
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        if (errors.length < 200) errors.push({ line: i + 1, message: err.message });
      }
    }
    audit(ctx, user, 'candidates.import', { election: election.name, upserted, errors: errors.length });
  });
  return { rows: table.length - 1, upserted, errors };
}

export function candidatesCsv(ctx: Ctx, election: Election): string {
  const cands = candidatesByContest(ctx, election.id);
  const out: (string | number | null)[][] = [['選舉項目', '號次', '姓名', ...(election.type === 'president' ? ['副總統候選人'] : []), '政黨', '顏色']];
  for (const contest of listContests(ctx, election.id)) {
    const list = cands.get(contest.id) ?? [];
    const base = election.type === 'president' ? contest.name : ctx.areas.name(contest.area_code);
    if (!list.length) out.push([base, 1, '', ...(election.type === 'president' ? [''] : []), '', '']);
    for (const c of list) out.push([base, c.number, c.name, ...(election.type === 'president' ? [c.running_mate] : []), c.party, c.color]);
  }
  return toCsv(out);
}
