import { createHash } from 'node:crypto';
import { NATION, tx } from './db.ts';
import type { Ctx, Election, ElectionType, User } from './domain.ts';
import { audit, createElection, getElection, listContests, upsertCandidate } from './domain.ts';
import type { ImportReport, NormRow } from './importer.ts';
import { applyRows, importTable, jsonToRows } from './importer.ts';
import { HttpError, asInt, now, parseCsv } from './util.ts';
import { checkConfig, collectCecLive, discoverCecLive, parseConfig } from './ceclive.ts';
import { runAutopilot } from './autopilot.ts';

export type SourceKind = 'csv_url' | 'json_url' | 'cec_db' | 'cec_live' | 'push';
export type DataSource = {
  id: number;
  election_id: number;
  name: string;
  kind: SourceKind;
  url: string;
  config: string;
  interval_sec: number;
  enabled: number;
  token_hash: string | null;
  last_run_at: string | null;
  last_ok: number | null;
  last_message: string;
  last_hash: string;
};

const MAX_BYTES = 20 * 1024 * 1024;
// 中選會開票網站每次要讀多頁，最短 20 秒一輪，避免造成對方負擔。
const lastDiscovery = new Map<number, number>();

export const MIN_INTERVAL: Record<SourceKind, number> = { csv_url: 10, json_url: 10, cec_db: 300, cec_live: 20, push: 0 };

async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, '網址格式不正確');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new HttpError(400, '只支援 http／https 網址');
  const res = await fetch(parsed, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'vote-dashboard/0.1', accept: '*/*' } });
  if (!res.ok) throw new Error(`來源回應 HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error('來源檔案超過 20 MB');
  return new TextDecoder('utf-8').decode(buf);
}

export const reportMessage = (r: ImportReport): string =>
  `共 ${r.rows} 列：更新 ${r.applied}、無變更 ${r.unchanged}、空白略過 ${r.skipped}` +
  (r.locked ? `、已鎖定未覆蓋 ${r.locked}` : '') +
  (r.pending ? `、待審核 ${r.pending}` : '') +
  (r.errorCount ? `、錯誤 ${r.errorCount}（${r.errors[0].message}）` : '');

function saveStatus(ctx: Ctx, id: number, ok: boolean, message: string, hash?: string): void {
  ctx.db
    .prepare('UPDATE data_sources SET last_run_at = ?, last_ok = ?, last_message = ?, last_hash = COALESCE(?, last_hash) WHERE id = ?')
    .run(now(), ok ? 1 : 0, message.slice(0, 500), hash ?? null, id);
}

/** 執行一次自動讀取。內容與上次相同時直接略過（除非 force）。 */
export async function runSource(ctx: Ctx, source: DataSource, force = false): Promise<{ ok: boolean; message: string; report?: ImportReport }> {
  try {
    const election = getElection(ctx, source.election_id);
    let report: ImportReport;
    let hash: string | undefined;
    const opts = { source: 'auto' as const, sourceRef: `source:${source.id}`, user: null, respectLock: true };
    if (source.kind === 'csv_url' || source.kind === 'json_url') {
      const text = await fetchText(source.url);
      hash = createHash('sha256').update(text).digest('hex');
      if (!force && hash === source.last_hash) {
        saveStatus(ctx, source.id, true, '來源內容與上次相同，未更新');
        return { ok: true, message: '來源內容與上次相同，未更新' };
      }
      report = source.kind === 'csv_url' ? importTable(ctx, election, parseCsv(text), opts) : applyRows(ctx, election, jsonToRows(parseJson(text)), opts);
    } else if (source.kind === 'cec_live') {
      let config = checkConfig(parseConfig(source.config));
      if (config.auto && (!config.base || !config.prefix)) {
        // 自動尋找：投票日 10:00（或設定的時間）以後，每分鐘最多試一輪。
        const startAt = Date.parse(config.startAt ?? `${election.date}T10:00:00+08:00`);
        if (Date.now() < startAt) {
          const msg = `等待中選會開票網站上線（${new Date(startAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })} 起自動尋找）`;
          saveStatus(ctx, source.id, true, msg);
          return { ok: true, message: msg };
        }
        const last = lastDiscovery.get(source.id) ?? 0;
        if (!force && Date.now() - last < 60_000) return { ok: false, message: '尋找中選會開票網站中' };
        lastDiscovery.set(source.id, Date.now());
        const { found, tried } = await discoverCecLive(ctx, election, config);
        if (!found) {
          const msg = `尚未找到中選會開票網站（試了 ${tried} 種網址），每分鐘會自動再試`;
          saveStatus(ctx, source.id, false, msg);
          return { ok: false, message: msg };
        }
        config = found;
        ctx.db.prepare("UPDATE data_sources SET config = ?, url = ?, last_hash = '' WHERE id = ?").run(JSON.stringify(found), found.base, source.id);
        console.log(`[自動讀取] 找到中選會開票網站：${found.base}/${found.prefix}/`);
      }
      const got = await collectCecLive(ctx, election, config);
      const failed = got.pages.filter((p) => !p.ok);
      // 自動模式下整批都讀不到：可能網址換了，清掉讓下一輪重新尋找。
      if (config.auto && got.pages.length && failed.length === got.pages.length) {
        ctx.db.prepare("UPDATE data_sources SET config = ? WHERE id = ?").run(JSON.stringify({ ...config, base: '', prefix: '' }), source.id);
      }
      const pagesNote = `讀取 ${got.pages.length} 頁${failed.length ? `，${failed.length} 頁有問題（${failed[0].name}：${failed[0].message}）` : ''}`;
      if (!force && got.hash === source.last_hash) {
        saveStatus(ctx, source.id, failed.length === 0, `${pagesNote}；內容與上次相同，未更新`);
        return { ok: failed.length === 0, message: `${pagesNote}；內容與上次相同` };
      }
      if (!got.rows.length) throw new HttpError(502, pagesNote);
      hash = got.hash;
      report = applyRows(ctx, election, got.rows, opts);
      const message = `${pagesNote}；${reportMessage(report)}`;
      const ok = report.errorCount === 0 && failed.length === 0;
      saveStatus(ctx, source.id, ok, message, hash);
      return { ok, message, report };
    } else if (source.kind === 'cec_db') {
      const config = JSON.parse(source.config || '{}') as { themes?: CecThemeRef[] };
      if (!config.themes?.length) throw new HttpError(400, '尚未設定要讀取的中選會選舉資料');
      report = applyRows(ctx, election, await fetchCecRows(ctx, election, config.themes), opts);
    } else {
      throw new HttpError(400, '「API 推送」來源由外部程式主動送資料進來，不需要執行');
    }
    const message = reportMessage(report);
    saveStatus(ctx, source.id, report.errorCount === 0, message, hash);
    return { ok: report.errorCount === 0, message, report };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    saveStatus(ctx, source.id, false, `讀取失敗：${message}`);
    return { ok: false, message: `讀取失敗：${message}` };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '來源內容不是合法的 JSON');
  }
}

/** 外部程式以權杖推送資料（CSV 或標準 JSON）。 */
export function ingest(ctx: Ctx, source: DataSource, body: unknown, isCsv: boolean): ImportReport {
  const election = getElection(ctx, source.election_id);
  const opts = { source: 'auto' as const, sourceRef: `source:${source.id}`, user: null, respectLock: true };
  const report = isCsv ? importTable(ctx, election, parseCsv(String(body)), opts) : applyRows(ctx, election, jsonToRows(body), opts);
  saveStatus(ctx, source.id, report.errorCount === 0, reportMessage(report));
  return report;
}

/** 定時檢查所有啟用中的來源，到期就執行。回傳停止函式。 */
export function startPoller(ctx: Ctx, log: (msg: string) => void = () => {}): () => void {
  const running = new Set<number>();
  const tick = () => {
    try {
      for (const line of runAutopilot(ctx)) log(`[自動駕駛] ${line}`);
    } catch (err) {
      log(`[自動駕駛] 錯誤：${err instanceof Error ? err.message : String(err)}`);
    }
    let sources: DataSource[];
    try {
      sources = ctx.db.prepare("SELECT * FROM data_sources WHERE enabled = 1 AND kind <> 'push'").all() as DataSource[];
    } catch {
      return;
    }
    for (const s of sources) {
      if (running.has(s.id)) continue;
      const interval = Math.max(s.interval_sec, MIN_INTERVAL[s.kind]) * 1000;
      if (s.last_run_at && Date.now() - Date.parse(s.last_run_at) < interval) continue;
      running.add(s.id);
      runSource(ctx, s)
        .then((r) => {
          if (r.report?.applied || !r.ok) log(`[自動讀取] ${s.name}：${r.message}`);
        })
        .finally(() => running.delete(s.id));
    }
  };
  const timer = setInterval(tick, 5000);
  return () => clearInterval(timer);
}

// ---------- 中選會選舉資料庫（db.cec.gov.tw）----------
// 這是中選會公布的「歷屆選舉」正式結果，選後數日才會上線，不是開票當晚的即時資料。

const CEC = 'https://db.cec.gov.tw/static/elections';
export type CecThemeRef = { subject: string; themeId: string };
type CecTheme = { theme_id: string; subject_id: string; theme_name: string; vote_date: string; session: number };
type CecTicket = {
  prv_code: string; city_code: string; ris_prv_code: string; ris_city_code: string; ris_dept_code: string;
  cand_no: number; cand_name: string; party_name: string; ticket_num: number; is_vice: string;
};
type CecProfile = {
  ris_prv_code: string; ris_city_code: string; ris_dept_code: string;
  valid_ticket: number; invalid_ticket: number; vote_ticket: number; votable_population: number;
};

async function cecJson<T>(path: string): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(await fetchText(`${CEC}/${path}`, 30_000)) as T;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error(`無法讀取中選會選舉資料庫（${last instanceof Error ? last.message : last}）`);
}

const firstValue = <T>(o: Record<string, T[]>): T[] => Object.values(o)[0] ?? [];

/** 中選會用「@2F97F@」這種寫法表示罕見字（Unicode 碼位），這裡還原成實際的字。 */
export const cecText = (s: string): string =>
  s.replace(/@([0-9A-Fa-f]{4,6})@/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16))).normalize('NFC').trim();

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export type CecElectionOption = { key: string; name: string; date: string; themes: (CecThemeRef & { name: string })[] };

/** 列出中選會選舉資料庫裡可匯入的歷屆選舉。 */
export async function cecElections(type: ElectionType): Promise<CecElectionOption[]> {
  const subjects = type === 'president' ? ['P0'] : ['C1', 'C2'];
  const groups = new Map<string, CecElectionOption>();
  for (const subject of subjects) {
    const data = await cecJson<{ theme_items: CecTheme[] }[]>(`list/ELC_${subject}.json`);
    for (const t of data.flatMap((g) => g.theme_items)) {
      const key = type === 'president' ? t.theme_id : `mayor-${t.session}`;
      if (!groups.has(key)) {
        groups.set(key, { key, name: type === 'president' ? t.theme_name : `${t.session} 年直轄市長、縣市長選舉`, date: t.vote_date, themes: [] });
      }
      const g = groups.get(key)!;
      g.themes.push({ subject, themeId: t.theme_id, name: t.theme_name });
      if (t.vote_date < g.date) g.date = t.vote_date;
    }
  }
  return [...groups.values()].sort((a, b) => b.date.localeCompare(a.date));
}

const ticketPath = (t: CecThemeRef, level: string, key: string) => `data/tickets/ELC/${t.subject}/00/${t.themeId}/${level}/${key}.json`;
const profilePath = (t: CecThemeRef, level: string, key: string) => `data/profiles/ELC/${t.subject}/00/${t.themeId}/${level}/${key}.json`;
const NATION_KEY = '00_000_00_000_0000';

/** 把中選會資料轉成 NormRow（依選舉的統計層級取縣市或鄉鎮市區資料）。 */
export async function fetchCecRows(ctx: Ctx, election: Election, themes: CecThemeRef[]): Promise<NormRow[]> {
  if (election.unit_level === 'station') throw new HttpError(400, '中選會資料庫轉接目前只支援「縣市」與「鄉鎮市區」統計層級');
  const rows = new Map<string, NormRow>();
  const rowFor = (code: string): NormRow => {
    if (!rows.has(code)) rows.set(code, { line: rows.size + 1, code, byNumber: new Map(), byName: new Map() });
    return rows.get(code)!;
  };
  const addTickets = (list: CecTicket[], codeOf: (t: { ris_prv_code: string; ris_city_code: string; ris_dept_code: string }) => string) => {
    for (const t of list) {
      if (t.is_vice === 'Y') continue;
      const row = rowFor(codeOf(t));
      row.byNumber.set(t.cand_no, (Number(row.byNumber.get(t.cand_no) ?? 0) || 0) + t.ticket_num);
    }
  };
  const addProfiles = (list: CecProfile[], codeOf: (t: CecProfile) => string) => {
    for (const p of list) {
      const row = rows.get(codeOf(p));
      if (!row) continue;
      row.invalid = (Number(row.invalid ?? 0) || 0) + p.invalid_ticket;
      row.eligible = (Number(row.eligible ?? 0) || 0) + p.votable_population;
      row.valid = (Number(row.valid ?? 0) || 0) + p.valid_ticket;
    }
  };
  const countyCode = (t: { ris_prv_code: string; ris_city_code: string }) => t.ris_prv_code + t.ris_city_code;
  const townCode = (t: { ris_prv_code: string; ris_city_code: string; ris_dept_code: string }) => t.ris_prv_code + t.ris_city_code + t.ris_dept_code;

  for (const theme of themes) {
    const countyTickets = firstValue(await cecJson<Record<string, CecTicket[]>>(ticketPath(theme, 'C', NATION_KEY)));
    if (election.unit_level === 'county') {
      addTickets(countyTickets, countyCode);
      addProfiles(firstValue(await cecJson<Record<string, CecProfile[]>>(profilePath(theme, 'C', NATION_KEY))), countyCode);
      continue;
    }
    const keys = [...new Set(countyTickets.map((t) => `${t.prv_code}_${t.city_code}_00_000_0000`))];
    const parts = await pool(keys, 6, async (key) => ({
      tickets: firstValue(await cecJson<Record<string, CecTicket[]>>(ticketPath(theme, 'D', key))),
      profiles: firstValue(await cecJson<Record<string, CecProfile[]>>(profilePath(theme, 'D', key))),
    }));
    for (const p of parts) {
      addTickets(p.tickets, townCode);
      addProfiles(p.profiles, townCode);
    }
  }
  return [...rows.values()];
}

/** 從中選會選舉資料庫建立一場歷屆選舉：選舉區、候選人、票數一次到位。 */
export async function createFromCec(
  ctx: Ctx,
  input: { type: ElectionType; themes: CecThemeRef[]; name: string; date: string; unitLevel?: 'county' | 'town' },
  user: User | null,
): Promise<{ election: Election; report: ImportReport }> {
  if (!input.themes?.length) throw new HttpError(400, '請選擇要匯入的選舉');
  // 先把候選人資料抓齊再開始寫入，避免抓到一半失敗留下半套資料。
  const tickets: CecTicket[] = [];
  for (const theme of input.themes) {
    const level = input.type === 'president' ? 'N' : 'C';
    tickets.push(...firstValue(await cecJson<Record<string, CecTicket[]>>(ticketPath(theme, level, NATION_KEY))));
  }
  const counties = [...new Set(tickets.map((t) => t.ris_prv_code + t.ris_city_code))].filter((c) => ctx.areas.byCode.has(c));
  const { election, sourceId } = tx(ctx.db, () => {
    const election = createElection(ctx, {
      name: input.name,
      type: input.type,
      date: input.date,
      unit_level: input.unitLevel ?? 'town',
      source_note: '資料來源：中央選舉委員會選舉資料庫',
      counties: input.type === 'mayor' ? counties : undefined,
    });
    const contests = listContests(ctx, election.id);
    for (const contest of contests) {
      const mine = tickets.filter((t) => contest.area_code === NATION || t.ris_prv_code + t.ris_city_code === contest.area_code);
      const numbers = [...new Set(mine.map((t) => t.cand_no))].sort((a, b) => a - b);
      for (const number of numbers) {
        const main = mine.find((t) => t.cand_no === number && t.is_vice !== 'Y');
        const vice = mine.find((t) => t.cand_no === number && t.is_vice === 'Y');
        if (main) upsertCandidate(ctx, contest, { number, name: cecText(main.cand_name), running_mate: cecText(vice?.cand_name ?? ''), party: cecText(main.party_name) });
      }
    }
    const r = ctx.db
      .prepare("INSERT INTO data_sources (election_id, name, kind, config, interval_sec, enabled) VALUES (?, '中選會選舉資料庫', 'cec_db', ?, 3600, 0)")
      .run(election.id, JSON.stringify({ themes: input.themes.map((t) => ({ subject: t.subject, themeId: t.themeId })) }));
    audit(ctx, user, 'election.import_cec', { election: election.name, themes: input.themes.length });
    return { election, sourceId: asInt(r.lastInsertRowid)! };
  });
  const source = ctx.db.prepare('SELECT * FROM data_sources WHERE id = ?').get(sourceId) as DataSource;
  const result = await runSource(ctx, source, true);
  if (!result.report) throw new HttpError(502, `選舉已建立，但票數讀取失敗：${result.message}`);
  return { election, report: result.report };
}
