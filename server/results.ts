import { NATION, tx } from './db.ts';
import type { Candidate, Contest, Ctx, Election, Unit, User } from './domain.ts';
import { audit, candidatesByContest, getContest, getElection, listCandidates, listContests, listUnits, parseTv } from './domain.ts';
import { HttpError, asInt, now, parseCount } from './util.ts';

export type Source = 'admin' | 'reporter' | 'import' | 'auto';

export type ResultInput = {
  /** 候選人 id → 得票數 */
  votes: Record<string, unknown>;
  invalid?: unknown;
  eligible?: unknown;
  stationsTotal?: unknown;
  stationsCounted?: unknown;
  note?: string;
};

export type ResultRow = {
  contest_id: number;
  unit_code: string;
  submission_id: number;
  votes: string;
  invalid_votes: number | null;
  eligible_voters: number | null;
  stations_total: number | null;
  stations_counted: number | null;
  source: Source;
  locked: number;
  updated_at: string;
};

export type Submission = {
  id: number;
  contest_id: number;
  unit_code: string;
  source: Source;
  source_ref: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded' | 'cleared';
  votes: string;
  invalid_votes: number | null;
  eligible_voters: number | null;
  stations_total: number | null;
  stations_counted: number | null;
  note: string;
  submitted_by: number | null;
  submitted_at: string;
  reviewed_by: number | null;
  reviewed_at: string | null;
};

type Clean = {
  votes: Record<string, number>;
  invalid: number | null;
  eligible: number | null;
  stationsTotal: number | null;
  stationsCounted: number | null;
  note: string;
  warnings: string[];
};

/** 驗證並整理一筆票數；格式錯誤直接丟出 400，合理性疑慮則放進 warnings。 */
export function cleanInput(candidates: Candidate[], unit: Unit, input: ResultInput): Clean {
  if (!candidates.length) throw new HttpError(400, '這個選舉區還沒有設定候選人');
  if (!input || typeof input.votes !== 'object' || input.votes === null) throw new HttpError(400, '缺少各候選人得票數');
  const known = new Set(candidates.map((c) => String(c.id)));
  for (const key of Object.keys(input.votes)) {
    if (!known.has(key)) throw new HttpError(400, `得票資料包含不屬於這個選舉區的候選人（id ${key}）`);
  }
  const votes: Record<string, number> = {};
  let valid = 0;
  for (const c of candidates) {
    const n = parseCount(input.votes[String(c.id)], `${c.number} 號 ${c.name} 的得票數`) ?? 0;
    votes[String(c.id)] = n;
    valid += n;
  }
  const invalid = parseCount(input.invalid, '無效票');
  const eligible = parseCount(input.eligible, '選舉人數') ?? unit.eligible;
  let stationsTotal: number | null = null;
  let stationsCounted: number | null = null;
  if (unit.level !== 'station') {
    stationsTotal = parseCount(input.stationsTotal, '投開票所總數');
    stationsCounted = parseCount(input.stationsCounted, '已開出投開票所數');
    if (stationsTotal !== null && stationsCounted !== null && stationsCounted > stationsTotal) {
      throw new HttpError(400, '已開出投開票所數不能大於投開票所總數');
    }
  }
  const warnings: string[] = [];
  const total = valid + (invalid ?? 0);
  if (eligible !== null && total > eligible) warnings.push(`投票數 ${total} 超過選舉人數 ${eligible}`);
  if (unit.level === 'station' && total > 5000) warnings.push(`單一投開票所投票數 ${total} 異常偏高`);
  return { votes, invalid, eligible, stationsTotal, stationsCounted, note: (input.note ?? '').toString().slice(0, 500), warnings };
}

export type SubmitOutcome = {
  status: 'approved' | 'pending' | 'unchanged' | 'locked';
  id?: number;
  warnings: string[];
};

export type SubmitParams = {
  election: Election;
  contest: Contest;
  unit: Unit;
  candidates: Candidate[];
  input: ResultInput;
  source: Source;
  sourceRef?: string;
  user: User | null;
  /** true：直接生效；false：進入待審核。 */
  approve: boolean;
  /** 設定鎖定狀態（僅管理員輸入時使用）。 */
  lock?: boolean;
  /** true：不覆蓋已鎖定的單位（自動來源與批次匯入使用）。 */
  respectLock?: boolean;
};

const sameData = (r: ResultRow, c: Clean): boolean =>
  r.votes === JSON.stringify(c.votes) &&
  r.invalid_votes === c.invalid &&
  r.eligible_voters === c.eligible &&
  r.stations_total === c.stationsTotal &&
  r.stations_counted === c.stationsCounted;

function currentResult(ctx: Ctx, contestId: number, unitCode: string): ResultRow | undefined {
  return ctx.db.prepare('SELECT * FROM results WHERE contest_id = ? AND unit_code = ?').get(contestId, unitCode) as ResultRow | undefined;
}

function applyToResults(ctx: Ctx, contestId: number, unitCode: string, submissionId: number, c: Omit<Clean, 'warnings' | 'note'>, source: Source, locked: number): void {
  ctx.db
    .prepare("UPDATE submissions SET status = 'superseded' WHERE contest_id = ? AND unit_code = ? AND status = 'approved' AND id <> ?")
    .run(contestId, unitCode, submissionId);
  ctx.db
    .prepare(
      `INSERT INTO results (contest_id, unit_code, submission_id, votes, invalid_votes, eligible_voters, stations_total, stations_counted, source, locked, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (contest_id, unit_code) DO UPDATE SET
         submission_id = excluded.submission_id, votes = excluded.votes, invalid_votes = excluded.invalid_votes,
         eligible_voters = excluded.eligible_voters, stations_total = excluded.stations_total,
         stations_counted = excluded.stations_counted, source = excluded.source, locked = excluded.locked,
         updated_at = excluded.updated_at`,
    )
    .run(contestId, unitCode, submissionId, JSON.stringify(c.votes), c.invalid, c.eligible, c.stationsTotal, c.stationsCounted, source, locked, now());
}

/** 登錄一筆票數。所有來源（後台、回報、匯入、自動讀取）都走這裡。 */
export function submitResult(ctx: Ctx, p: SubmitParams): SubmitOutcome {
  const clean = cleanInput(p.candidates, p.unit, p.input);
  return tx(ctx.db, () => {
    const current = currentResult(ctx, p.contest.id, p.unit.code);
    if (p.approve) {
      if (p.respectLock && current?.locked) return { status: 'locked', warnings: clean.warnings };
      const locked = p.lock === undefined ? (current?.locked ?? 0) : p.lock ? 1 : 0;
      if (current && sameData(current, clean) && locked === current.locked) return { status: 'unchanged', warnings: clean.warnings };
    }
    const at = now();
    const r = ctx.db
      .prepare(
        `INSERT INTO submissions (contest_id, unit_code, source, source_ref, status, votes, invalid_votes, eligible_voters,
           stations_total, stations_counted, note, submitted_by, submitted_at, reviewed_by, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.contest.id, p.unit.code, p.source, p.sourceRef ?? '', p.approve ? 'approved' : 'pending', JSON.stringify(clean.votes),
        clean.invalid, clean.eligible, clean.stationsTotal, clean.stationsCounted, clean.note,
        p.user?.id ?? null, at, p.approve ? (p.user?.id ?? null) : null, p.approve ? at : null,
      );
    const id = asInt(r.lastInsertRowid)!;
    // 待審核的回報不影響公開數字，不需要通知看板。
    if (!p.approve) return { status: 'pending', id, warnings: clean.warnings };
    const locked = p.lock === undefined ? (current?.locked ?? 0) : p.lock ? 1 : 0;
    applyToResults(ctx, p.contest.id, p.unit.code, id, clean, p.source, locked);
    ctx.bus.bump(p.election.id);
    return { status: 'approved', id, warnings: clean.warnings };
  });
}

export function reviewSubmission(ctx: Ctx, id: number, action: 'approve' | 'reject', user: User): Submission {
  return tx(ctx.db, () => {
    const s = ctx.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as Submission | undefined;
    if (!s) throw new HttpError(404, '找不到這筆回報');
    if (s.status !== 'pending') throw new HttpError(409, '這筆回報已經處理過了');
    const contest = getContest(ctx, s.contest_id);
    if (action === 'approve') {
      const election = getElection(ctx, contest.election_id);
      const unit = listUnits(ctx, election, contest).find((u) => u.code === s.unit_code);
      if (!unit) throw new HttpError(409, '這筆回報對應的統計單位已不存在（統計層級或投開票所清冊可能已變更）');
      const current = currentResult(ctx, s.contest_id, s.unit_code);
      if (current?.locked) throw new HttpError(409, '這個單位的票數已鎖定，請先解除鎖定');
      const votes = JSON.parse(s.votes) as Record<string, number>;
      const known = new Set(listCandidates(ctx, contest.id).map((c) => String(c.id)));
      if (Object.keys(votes).some((k) => !known.has(k)) || Object.keys(votes).length !== known.size) {
        throw new HttpError(409, '候選人名單在回報之後已經變更，請退回並請回報員重新回報');
      }
      applyToResults(
        ctx, s.contest_id, s.unit_code, s.id,
        { votes, invalid: s.invalid_votes, eligible: s.eligible_voters, stationsTotal: s.stations_total, stationsCounted: s.stations_counted },
        s.source, 0,
      );
    }
    ctx.db
      .prepare('UPDATE submissions SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
      .run(action === 'approve' ? 'approved' : 'rejected', user.id, now(), id);
    audit(ctx, user, action === 'approve' ? 'submission.approve' : 'submission.reject', { id, unit: s.unit_code, contest: contest.name });
    ctx.bus.bump(contest.election_id);
    return ctx.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as Submission;
  });
}

export function clearResult(ctx: Ctx, contest: Contest, unitCode: string, user: User): void {
  tx(ctx.db, () => {
    const r = ctx.db.prepare('DELETE FROM results WHERE contest_id = ? AND unit_code = ?').run(contest.id, unitCode);
    if (!r.changes) throw new HttpError(404, '這個單位目前沒有票數');
    ctx.db
      .prepare("UPDATE submissions SET status = 'cleared', reviewed_by = ?, reviewed_at = ? WHERE contest_id = ? AND unit_code = ? AND status = 'approved'")
      .run(user.id, now(), contest.id, unitCode);
    audit(ctx, user, 'result.clear', { contest: contest.name, unit: unitCode });
    ctx.bus.bump(contest.election_id);
  });
}

export function setLock(ctx: Ctx, contest: Contest, unitCode: string, locked: boolean, user: User): void {
  const r = ctx.db.prepare('UPDATE results SET locked = ? WHERE contest_id = ? AND unit_code = ?').run(locked ? 1 : 0, contest.id, unitCode);
  if (!r.changes) throw new HttpError(404, '這個單位目前沒有票數，無法鎖定');
  audit(ctx, user, locked ? 'result.lock' : 'result.unlock', { contest: contest.name, unit: unitCode });
  ctx.bus.bump(contest.election_id);
}

// ---------- 加總統計 ----------

export type Totals = {
  votes: Record<string, number>;
  valid: number;
  invalid: number;
  total: number;
  /** 投票率（0–1）；只計入確定開完且有選舉人數的單位，無法計算時為 null。 */
  turnout: number | null;
  unitsTotal: number;
  unitsReported: number;
  /** 投開票所數；有單位未提供時為 null，此時請改用 units 進度。 */
  stationsTotal: number | null;
  stationsCounted: number | null;
  done: boolean;
  leaderId: number | null;
  updatedAt: string | null;
};

class Acc {
  votes: Record<string, number> = {};
  invalid = 0;
  unitsTotal = 0;
  unitsReported = 0;
  unitsComplete = 0;
  stTotal = 0;
  stCounted = 0;
  stUnknown = 0;
  tVotes = 0;
  tEligible = 0;
  updatedAt: string | null = null;

  /** 選舉已標為「開票完成」時，所有已回報的單位都視為確定開完。 */
  final: boolean;

  constructor(candidates: Candidate[], final: boolean) {
    this.final = final;
    for (const c of candidates) this.votes[String(c.id)] = 0;
  }

  add(unit: Unit, r: ResultRow | undefined, parsed: Record<string, number> | undefined): void {
    this.unitsTotal++;
    const hasStations = unit.level === 'station' || (r != null && r.stations_total !== null && r.stations_counted !== null);
    if (unit.level === 'station') {
      this.stTotal += 1;
      if (r) this.stCounted += 1;
    } else if (hasStations) {
      this.stTotal += r!.stations_total!;
      this.stCounted += r!.stations_counted!;
    } else this.stUnknown++;
    if (!r || !parsed) return;

    let valid = 0;
    for (const id in this.votes) {
      const n = parsed[id] ?? 0;
      this.votes[id] += n;
      valid += n;
    }
    const total = valid + (r.invalid_votes ?? 0);
    this.invalid += r.invalid_votes ?? 0;
    // 自動來源會在開票前先送出「0 票、已開 0 所」的資料，這種不算已回報。
    const reported = unit.level === 'station' || !hasStations || r.stations_counted! > 0 || total > 0;
    if (!reported) return;
    this.unitsReported++;
    if (!this.updatedAt || r.updated_at > this.updatedAt) this.updatedAt = r.updated_at;
    const complete = unit.level === 'station' || !hasStations || r.stations_counted! >= r.stations_total!;
    if (!complete) return;
    this.unitsComplete++;
    // 投票率只計入「確定開完」的單位：沒有提供投開票所數的縣市／鄉鎮資料可能只是開到一半，
    // 開票期間不拿來算投票率，等選舉標為開票完成後才計入。
    const sure = unit.level === 'station' || hasStations || this.final;
    const eligible = r.eligible_voters ?? unit.eligible;
    if (sure && eligible) {
      this.tVotes += total;
      this.tEligible += eligible;
    }
  }

  finish(): Totals {
    let valid = 0;
    let top = -1;
    let leaderId: number | null = null;
    let tie = false;
    for (const id in this.votes) {
      const n = this.votes[id];
      valid += n;
      if (n > top) {
        top = n;
        leaderId = Number(id);
        tie = false;
      } else if (n === top) tie = true;
    }
    if (top <= 0 || tie) leaderId = null;
    return {
      votes: this.votes,
      valid,
      invalid: this.invalid,
      total: valid + this.invalid,
      turnout: this.tEligible > 0 ? this.tVotes / this.tEligible : null,
      unitsTotal: this.unitsTotal,
      unitsReported: this.unitsReported,
      stationsTotal: this.stUnknown ? null : this.stTotal,
      stationsCounted: this.stUnknown ? null : this.stCounted,
      done: this.unitsTotal > 0 && this.unitsComplete === this.unitsTotal,
      leaderId,
      updatedAt: this.updatedAt,
    };
  }
}

export type AreaRow = { code: string; name: string; level: 'nation' | 'county' | 'town' | 'station'; totals: Totals };

type ContestAgg = {
  contest: Contest;
  candidates: Candidate[];
  units: Unit[];
  results: Map<string, ResultRow>;
  total: Totals;
  byCounty: Map<string, Totals>;
  byTown: Map<string, Totals>;
};

type ElectionAgg = { election: Election; contests: ContestAgg[]; summaryJson?: string; drills?: Map<string, string> };

function aggregateContest(ctx: Ctx, election: Election, contest: Contest, candidates: Candidate[]): ContestAgg {
  const units = listUnits(ctx, election, contest);
  const rows = ctx.db.prepare('SELECT * FROM results WHERE contest_id = ?').all(contest.id) as ResultRow[];
  const results = new Map(rows.map((r) => [r.unit_code, r]));
  const final = election.status === 'final';
  const total = new Acc(candidates, final);
  const counties = new Map<string, Acc>();
  const towns = new Map<string, Acc>();
  for (const u of units) {
    const r = results.get(u.code);
    const parsed = r ? (JSON.parse(r.votes) as Record<string, number>) : undefined;
    total.add(u, r, parsed);
    if (!counties.has(u.countyCode)) counties.set(u.countyCode, new Acc(candidates, final));
    counties.get(u.countyCode)!.add(u, r, parsed);
    if (u.townCode) {
      if (!towns.has(u.townCode)) towns.set(u.townCode, new Acc(candidates, final));
      towns.get(u.townCode)!.add(u, r, parsed);
    }
  }
  const finish = (m: Map<string, Acc>) => new Map([...m].map(([k, v]) => [k, v.finish()]));
  return { contest, candidates, units, results, total: total.finish(), byCounty: finish(counties), byTown: finish(towns) };
}

function getAgg(ctx: Ctx, electionId: number): ElectionAgg {
  const version = ctx.bus.version(electionId);
  const hit = ctx.cache.get(electionId);
  if (hit && hit.version === version) return hit.value as ElectionAgg;
  const election = getElection(ctx, electionId);
  const cands = candidatesByContest(ctx, electionId);
  const contests = listContests(ctx, electionId).map((c) => aggregateContest(ctx, election, c, cands.get(c.id) ?? []));
  const value: ElectionAgg = { election, contests };
  ctx.cache.set(electionId, { version, value });
  return value;
}

const publicElection = (e: Election) => ({
  id: e.id,
  name: e.name,
  type: e.type,
  date: e.date,
  status: e.status,
  unitLevel: e.unit_level,
  sourceNote: e.source_note,
  tv: parseTv(e.tv),
});

function contestSummary(ctx: Ctx, a: ContestAgg) {
  return {
    id: a.contest.id,
    name: a.contest.name,
    areaCode: a.contest.area_code,
    areaName: ctx.areas.name(a.contest.area_code),
    candidates: a.candidates.map((c) => ({
      id: c.id,
      number: c.number,
      name: c.name,
      runningMate: c.running_mate,
      party: c.party,
      color: c.color,
      declared: !!c.declared,
      photo: c.photo_version ? `/api/candidates/${c.id}/photo?v=${c.photo_version}` : null,
      photoCredit: c.photo_version ? c.photo_credit : '',
    })),
    totals: a.total,
  };
}

function countyRows(ctx: Ctx, a: ContestAgg): AreaRow[] {
  return ctx.areas.counties
    .filter((c) => a.byCounty.has(c.code))
    .map((c) => ({ code: c.code, name: c.name, level: 'county', totals: a.byCounty.get(c.code)! }));
}

/** 公開看板用的整場選舉摘要（JSON 字串，同一版本只算一次）。 */
export function summaryJson(ctx: Ctx, electionId: number, allowDraft = false): string {
  const agg = getAgg(ctx, electionId);
  if (agg.election.status === 'draft' && !allowDraft) throw new HttpError(404, '找不到這場選舉');
  if (!agg.summaryJson) {
    let updatedAt: string | null = null;
    for (const c of agg.contests) if (c.total.updatedAt && (!updatedAt || c.total.updatedAt > updatedAt)) updatedAt = c.total.updatedAt;
    agg.summaryJson = JSON.stringify({
      election: publicElection(agg.election),
      version: ctx.bus.version(electionId),
      updatedAt,
      contests: agg.contests.map((a) => ({
        ...contestSummary(ctx, a),
        // 全國性選舉區附上各縣市統計，供地圖與縣市表格使用。
        children: a.contest.area_code === NATION ? countyRows(ctx, a) : undefined,
      })),
    });
  }
  return agg.summaryJson;
}

/** 下鑽：某個選舉區在指定地區（全國／縣市／鄉鎮市區）之下的各區統計。 */
/** 下鑽資料的 JSON；同一版本、同一地區只算一次（開票時大家常看的是同幾個縣市）。 */
export function drillJson(ctx: Ctx, electionId: number, contestId: number, areaCode: string, allowDraft = false): string {
  const agg = getAgg(ctx, electionId);
  if (agg.election.status === 'draft' && !allowDraft) throw new HttpError(404, '找不到這場選舉');
  agg.drills ??= new Map();
  const key = `${contestId}|${areaCode}`;
  let json = agg.drills.get(key);
  if (json === undefined) {
    json = JSON.stringify(drill(ctx, electionId, contestId, areaCode, allowDraft));
    if (agg.drills.size < 5000) agg.drills.set(key, json);
  }
  return json;
}

export function drill(ctx: Ctx, electionId: number, contestId: number, areaCode: string, allowDraft = false) {
  const agg = getAgg(ctx, electionId);
  if (agg.election.status === 'draft' && !allowDraft) throw new HttpError(404, '找不到這場選舉');
  const a = agg.contests.find((c) => c.contest.id === contestId);
  if (!a) throw new HttpError(404, '找不到這個選舉區');
  const base = { election: publicElection(agg.election), version: ctx.bus.version(electionId), contest: contestSummary(ctx, a) };
  const nationPath = a.contest.area_code === NATION ? [{ code: NATION, name: '全國' }] : [];

  if (areaCode === NATION) {
    if (a.contest.area_code !== NATION) throw new HttpError(404, '這個選舉區不是全國性選舉');
    return {
      ...base,
      area: { code: NATION, name: '全國', level: 'nation', totals: a.total } as AreaRow,
      path: nationPath,
      childLevel: 'county',
      children: countyRows(ctx, a),
    };
  }
  const area = ctx.areas.byCode.get(areaCode);
  if (area?.level === 'county' && a.byCounty.has(area.code)) {
    const children: AreaRow[] =
      agg.election.unit_level === 'county'
        ? []
        : (ctx.areas.townsOf.get(area.code) ?? [])
            .filter((t) => a.byTown.has(t.code))
            .map((t) => ({ code: t.code, name: t.name, level: 'town', totals: a.byTown.get(t.code)! }));
    return {
      ...base,
      area: { code: area.code, name: area.name, level: 'county', totals: a.byCounty.get(area.code)! } as AreaRow,
      path: [...nationPath, { code: area.code, name: area.name }],
      childLevel: children.length ? 'town' : null,
      children,
    };
  }
  if (area?.level === 'town' && a.byTown.has(area.code)) {
    const county = ctx.areas.byCode.get(area.parent!)!;
    const children: AreaRow[] = a.units
      .filter((u) => u.townCode === area.code && u.level === 'station')
      .map((u) => {
        const acc = new Acc(a.candidates, agg.election.status === 'final');
        const r = a.results.get(u.code);
        acc.add(u, r, r ? JSON.parse(r.votes) : undefined);
        return { code: u.code, name: u.name, level: 'station', totals: acc.finish() };
      });
    return {
      ...base,
      area: { code: area.code, name: area.name, level: 'town', totals: a.byTown.get(area.code)! } as AreaRow,
      path: [...nationPath, { code: county.code, name: county.name }, { code: area.code, name: area.name }],
      childLevel: children.length ? 'station' : null,
      children,
    };
  }
  throw new HttpError(404, '這個選舉區沒有這個地區');
}

/** 後台輸入用：列出某地區之下的統計單位與目前生效的票數。 */
export function adminUnits(ctx: Ctx, contest: Contest, parentCode: string | null) {
  const a = getAgg(ctx, contest.election_id).contests.find((c) => c.contest.id === contest.id)!;
  const pending = new Map(
    (
      ctx.db
        .prepare("SELECT unit_code, COUNT(*) AS n FROM submissions WHERE contest_id = ? AND status = 'pending' GROUP BY unit_code")
        .all(contest.id) as { unit_code: string; n: number }[]
    ).map((r) => [r.unit_code, r.n]),
  );
  return a.units
    .filter((u) => !parentCode || u.countyCode === parentCode || u.townCode === parentCode)
    .map((u) => {
      const r = a.results.get(u.code);
      return {
        code: u.code,
        name: u.name,
        level: u.level,
        countyCode: u.countyCode,
        townCode: u.townCode,
        defaultEligible: u.eligible,
        pending: pending.get(u.code) ?? 0,
        result: r
          ? {
              votes: JSON.parse(r.votes) as Record<string, number>,
              invalid: r.invalid_votes,
              eligible: r.eligible_voters,
              stationsTotal: r.stations_total,
              stationsCounted: r.stations_counted,
              source: r.source,
              locked: !!r.locked,
              updatedAt: r.updated_at,
            }
          : null,
      };
    });
}

export function findUnit(ctx: Ctx, election: Election, contest: Contest, unitCode: string): Unit {
  const unit = listUnits(ctx, election, contest).find((u) => u.code === unitCode);
  if (!unit) throw new HttpError(404, '這個選舉區沒有這個統計單位（請確認統計層級與投開票所清冊）');
  return unit;
}
