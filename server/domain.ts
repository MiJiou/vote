import type { DB } from './db.ts';
import { Areas, NATION, tx } from './db.ts';
import type { Config } from './config.ts';
import { HttpError, asInt, now } from './util.ts';

export type Role = 'admin' | 'reporter';
export type User = { id: number; username: string; display_name: string; role: Role; active: number };

export type ElectionType = 'president' | 'mayor';
export type UnitLevel = 'county' | 'town' | 'station';
export type Election = {
  id: number;
  name: string;
  type: ElectionType;
  date: string;
  status: 'draft' | 'live' | 'final';
  unit_level: UnitLevel;
  auto_approve_reports: number;
  source_note: string;
  created_at: string;
};
export type Contest = { id: number; election_id: number; name: string; area_code: string; sort: number };
export type Candidate = {
  id: number;
  contest_id: number;
  number: number;
  name: string;
  running_mate: string;
  party: string;
  color: string;
};
export type Station = {
  id: number;
  election_id: number;
  town_code: string;
  station_no: string;
  name: string;
  village: string;
  eligible_voters: number | null;
};

/** 統計單位：票數實際登錄的最小單位（縣市、鄉鎮市區或投開票所）。 */
export type Unit = {
  code: string;
  name: string;
  level: UnitLevel;
  countyCode: string;
  townCode: string | null;
  eligible: number | null;
};

type Listener = (electionId: number, version: number) => void;

/** 記錄每場選舉的資料版本，並在變動時通知訂閱者（SSE）。 */
export class Bus {
  private versions = new Map<number, number>();
  private listeners = new Set<Listener>();
  private timers = new Map<number, NodeJS.Timeout>();
  private base = Date.now();

  version(electionId: number): number {
    return this.versions.get(electionId) ?? this.base;
  }

  /** 資料有變動：版本 +1，並在短暫延遲後通知（大量匯入時只會通知一次）。 */
  bump(electionId: number): void {
    this.versions.set(electionId, this.version(electionId) + 1);
    if (this.timers.has(electionId)) return;
    const t = setTimeout(() => {
      this.timers.delete(electionId);
      const v = this.version(electionId);
      for (const fn of this.listeners) fn(electionId, v);
    }, 250);
    t.unref();
    this.timers.set(electionId, t);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get subscribers(): number {
    return this.listeners.size;
  }
}

export type Ctx = {
  db: DB;
  areas: Areas;
  bus: Bus;
  config: Config;
  cache: Map<number, { version: number; value: unknown }>;
};

export function createCtx(db: DB, config: Config, areas = new Areas()): Ctx {
  return { db, areas, bus: new Bus(), config, cache: new Map() };
}

export function audit(ctx: Ctx, user: User | null, action: string, detail: unknown = ''): void {
  ctx.db
    .prepare('INSERT INTO audit_log (at, user_id, username, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(now(), user?.id ?? null, user?.username ?? 'system', action, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

// ---------- 選舉／選舉區／候選人 ----------

export function getElection(ctx: Ctx, id: number): Election {
  const e = ctx.db.prepare('SELECT * FROM elections WHERE id = ?').get(id) as Election | undefined;
  if (!e) throw new HttpError(404, '找不到這場選舉');
  return e;
}

export function getContest(ctx: Ctx, id: number): Contest {
  const c = ctx.db.prepare('SELECT * FROM contests WHERE id = ?').get(id) as Contest | undefined;
  if (!c) throw new HttpError(404, '找不到這個選舉區');
  return c;
}

export function listContests(ctx: Ctx, electionId: number): Contest[] {
  return ctx.db.prepare('SELECT * FROM contests WHERE election_id = ? ORDER BY sort, id').all(electionId) as Contest[];
}

export function listCandidates(ctx: Ctx, contestId: number): Candidate[] {
  return ctx.db.prepare('SELECT * FROM candidates WHERE contest_id = ? ORDER BY number').all(contestId) as Candidate[];
}

export function candidatesByContest(ctx: Ctx, electionId: number): Map<number, Candidate[]> {
  const rows = ctx.db
    .prepare(
      'SELECT c.* FROM candidates c JOIN contests t ON t.id = c.contest_id WHERE t.election_id = ? ORDER BY c.contest_id, c.number',
    )
    .all(electionId) as Candidate[];
  const map = new Map<number, Candidate[]>();
  for (const r of rows) {
    if (!map.has(r.contest_id)) map.set(r.contest_id, []);
    map.get(r.contest_id)!.push(r);
  }
  return map;
}

export type NewElection = {
  name: string;
  type: ElectionType;
  date: string;
  unit_level?: UnitLevel;
  status?: Election['status'];
  source_note?: string;
  /** 縣市長選舉要建立哪些縣市的選舉區；省略則為全部 22 縣市。 */
  counties?: string[];
};

/**
 * 建立選舉並自動產生選舉區：
 * 總統大選 → 一個全國選舉區；縣市長選舉 → 每個縣市一個選舉區。
 */
export function createElection(ctx: Ctx, input: NewElection): Election {
  const name = input.name?.trim();
  if (!name) throw new HttpError(400, '請輸入選舉名稱');
  if (input.type !== 'president' && input.type !== 'mayor') throw new HttpError(400, '選舉類型不正確');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) throw new HttpError(400, '投票日格式應為 YYYY-MM-DD');
  const unitLevel = input.unit_level ?? 'town';
  if (!['county', 'town', 'station'].includes(unitLevel)) throw new HttpError(400, '統計層級不正確');
  return tx(ctx.db, () => {
    const r = ctx.db
      .prepare('INSERT INTO elections (name, type, date, status, unit_level, source_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, input.type, input.date, input.status ?? 'draft', unitLevel, input.source_note ?? '', now());
    const id = asInt(r.lastInsertRowid)!;
    const add = ctx.db.prepare('INSERT INTO contests (election_id, name, area_code, sort) VALUES (?, ?, ?, ?)');
    if (input.type === 'president') {
      add.run(id, '總統副總統選舉', NATION, 0);
    } else {
      const wanted = input.counties?.length ? new Set(input.counties) : null;
      ctx.areas.counties.forEach((c, i) => {
        if (wanted && !wanted.has(c.code)) return;
        add.run(id, `${c.name}長選舉`, c.code, i);
      });
    }
    return getElection(ctx, id);
  });
}

/** 判斷某個選舉區涵蓋哪些縣市。 */
export function contestCounties(ctx: Ctx, contest: Contest): string[] {
  return contest.area_code === NATION ? ctx.areas.counties.map((c) => c.code) : [contest.area_code];
}

export function stationUnitCode(townCode: string, stationNo: string): string {
  return `${townCode}-${stationNo}`;
}

/**
 * 列出選舉區的所有統計單位。
 * 統計層級為「投開票所」時，尚未匯入投開票所清冊的鄉鎮市區會退回以整個鄉鎮市區為單位，
 * 這樣即使清冊只匯了一部分，加總也不會漏算或重複計算。
 */
export function listUnits(ctx: Ctx, election: Election, contest: Contest): Unit[] {
  const counties = contestCounties(ctx, contest);
  if (election.unit_level === 'county') {
    return counties.map((code) => ({ code, name: ctx.areas.name(code), level: 'county', countyCode: code, townCode: null, eligible: null }));
  }
  const stationsByTown = new Map<string, Station[]>();
  if (election.unit_level === 'station') {
    const rows = ctx.db.prepare('SELECT * FROM stations WHERE election_id = ? ORDER BY town_code, station_no').all(election.id) as Station[];
    for (const s of rows) {
      if (!stationsByTown.has(s.town_code)) stationsByTown.set(s.town_code, []);
      stationsByTown.get(s.town_code)!.push(s);
    }
  }
  const units: Unit[] = [];
  for (const county of counties) {
    for (const town of ctx.areas.townsOf.get(county) ?? []) {
      const stations = stationsByTown.get(town.code);
      if (!stations) {
        units.push({ code: town.code, name: town.name, level: 'town', countyCode: county, townCode: town.code, eligible: null });
        continue;
      }
      for (const s of stations) {
        const label = [s.village, s.name].filter(Boolean).join(' ');
        units.push({
          code: stationUnitCode(town.code, s.station_no),
          name: label ? `${s.station_no} ${label}` : `第 ${s.station_no} 投開票所`,
          level: 'station',
          countyCode: county,
          townCode: town.code,
          eligible: s.eligible_voters,
        });
      }
    }
  }
  return units;
}

/**
 * 候選人預設顏色：主要政黨用慣用色，無黨籍統一用同一色，其餘小黨依序取用備用色，
 * 用完之後一律灰色（歸入「其他」）。主要四色已用色盲模擬驗證過，在淺色與深色背景上
 * 兩兩都分得開；後台可以逐一修改。
 */
const PARTY_COLORS: [RegExp, string][] = [
  [/民主進步黨|民進黨/, '#1B9431'],
  [/中國國民黨|國民黨/, '#2A66D6'],
  [/台灣民眾黨|臺灣民眾黨|民眾黨/, '#12A3B5'],
  [/時代力量/, '#C98500'],
  [/親民黨/, '#D95926'],
  [/台灣基進|臺灣基進/, '#B5452C'],
];
export const INDEPENDENT_COLOR = '#D55181';
const FALLBACK_COLORS = ['#9085E9', '#D95926', '#C98500', '#E66767'];
export const OTHER_COLOR = '#8A8983';

export const isIndependent = (party: string): boolean => !party.trim() || /無黨籍|未經政黨推薦|^無$/.test(party);

export function defaultColor(party: string, used: string[] = []): string {
  if (isIndependent(party)) return INDEPENDENT_COLOR;
  for (const [re, color] of PARTY_COLORS) if (re.test(party)) return color;
  const taken = new Set(used.map((c) => c.toUpperCase()));
  return FALLBACK_COLORS.find((c) => !taken.has(c)) ?? OTHER_COLOR;
}

export type CandidateInput = { number: number; name: string; running_mate?: string; party?: string; color?: string };

export function upsertCandidate(ctx: Ctx, contest: Contest, input: CandidateInput, id?: number): Candidate {
  const number = Number(input.number);
  if (!Number.isInteger(number) || number < 1 || number > 99) throw new HttpError(400, '號次必須是 1–99 的整數');
  const name = input.name?.trim();
  if (!name) throw new HttpError(400, '請輸入候選人姓名');
  const party = input.party?.trim() ?? '';
  let color = (input.color?.trim() ?? '').toUpperCase();
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, '顏色格式應為 #RRGGBB');
  if (!color) {
    const others = ctx.db.prepare('SELECT color FROM candidates WHERE contest_id = ? AND id <> ?').all(contest.id, id ?? 0) as { color: string }[];
    color = defaultColor(party, others.map((o) => o.color));
  }
  const clash = ctx.db.prepare('SELECT id FROM candidates WHERE contest_id = ? AND number = ?').get(contest.id, number) as { id: number } | undefined;
  if (clash && clash.id !== id) throw new HttpError(409, `${contest.name} 已經有 ${number} 號候選人`);
  if (id) {
    ctx.db
      .prepare('UPDATE candidates SET number = ?, name = ?, running_mate = ?, party = ?, color = ? WHERE id = ? AND contest_id = ?')
      .run(number, name, input.running_mate?.trim() ?? '', party, color, id, contest.id);
  } else {
    const r = ctx.db
      .prepare('INSERT INTO candidates (contest_id, number, name, running_mate, party, color) VALUES (?, ?, ?, ?, ?, ?)')
      .run(contest.id, number, name, input.running_mate?.trim() ?? '', party, color);
    id = asInt(r.lastInsertRowid)!;
  }
  ctx.bus.bump(contest.election_id);
  return ctx.db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as Candidate;
}
