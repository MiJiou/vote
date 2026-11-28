// 中選會開票網站（選舉當晚的即時計票頁）轉接。
//
// 中選會的即時開票網站不是 JSON，而是每個選舉區、每個地區各一小段 HTML：
//   {網址開頭}/{類別代碼}/{17 碼地區代碼}.html
// 例如 2022 年縣市長：https://www.cec.gov.tw/zh-TW/TC/63000000000000000.html（臺北市）
//     2024 年總統：  https://vote2024.cec.gov.tw/zh-TW/P1/00000000000000000.html（全國）
// 網址開頭與類別代碼每次選舉都不同，所以做成可設定；頁面內容依表頭文字解析，不依賴欄位順序。
// 任何一頁格式不符、號次對不上候選人姓名、或得票加總對不上有效票，該頁就不寫入，並在狀態裡明確報錯。
import { createHash } from 'node:crypto';
import type { Ctx, Election } from './domain.ts';
import { candidatesByContest, listContests } from './domain.ts';
import type { NormRow } from './importer.ts';
import { HttpError, normName } from './util.ts';

export type CecLiveConfig = {
  base: string;
  prefix: string;
  /** 自動尋找網址開頭與類別代碼（選舉當天網站上線時自動接上）。 */
  auto?: boolean;
  /** 自動尋找時要試的網址開頭；省略則用 DISCOVERY_BASES。 */
  hosts?: string[];
  /** 何時開始自動尋找（ISO 時間）；省略則為投票日 10:00（臺灣時間）。 */
  startAt?: string;
};

/** 中選會歷年開票網站的位置（2022：www.cec.gov.tw、2024：vote2024、2025：vote.cec.gov.tw）。 */
export const DISCOVERY_BASES = [
  'https://vote.cec.gov.tw/2026-local/zh-TW', // 2026 年實際使用的位置（11/28 開票當天確認）
  'https://vote2026.cec.gov.tw/zh-TW',
  'https://info.cec.gov.tw/vote2026/zh-TW', // 2026 年選舉資訊網所在位置
  'https://vote.cec.gov.tw/zh-TW',
  'https://info.cec.gov.tw/zh-TW',
  'https://www.cec.gov.tw/zh-TW',
];
/** 可能的類別代碼：2022 年縣市長是 TC；2026 年中選會資訊網把縣市長標為 C1。 */
export const DISCOVERY_PREFIXES = ['TC', 'C1', 'C2', 'CC', 'M1', 'T1'];

export type ParsedPage = {
  title: string;
  stationsCounted: number | null;
  stationsTotal: number | null;
  dataTime: string | null;
  candidates: { number: number; name: string | null; votes: number; party?: string | null }[];
  /** 應選人數（議員選舉頁面才有意義）。 */
  seats: number | null;
  valid: number | null;
  invalid: number | null;
  total: number | null;
  eligible: number | null;
};

const decode = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const toInt = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = s.replace(/[,\s]/g, '');
  return /^\d+$/.test(t) ? Number(t) : null;
};

type Table = { header: string[]; rows: string[][] };

function tables(html: string): Table[] {
  const out: Table[] = [];
  for (const t of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const rows = (t.match(/<tr[\s\S]*?<\/tr>/gi) ?? []).map((tr) => ({
      th: /<th[\s>]/i.test(tr),
      cells: [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => decode(m[1])),
    }));
    if (!rows.length) continue;
    const headerIndex = rows.findIndex((r) => r.th);
    const header = (headerIndex >= 0 ? rows[headerIndex] : rows[0]).cells;
    out.push({ header, rows: rows.slice((headerIndex >= 0 ? headerIndex : 0) + 1).filter((r) => !r.th).map((r) => r.cells) });
  }
  return out;
}

const col = (header: string[], ...names: RegExp[]) => header.findIndex((h) => names.some((re) => re.test(h)));

/** 依表頭取值；資料列比表頭多出欄位時（例如前面多了照片欄），從右邊對齊。 */
function cell(row: string[], header: string[], index: number): string | undefined {
  if (index < 0) return undefined;
  const shift = row.length - header.length;
  return row[index + (shift > 0 ? shift : 0)];
}

/** 解析一頁中選會的開票結果。 */
export function parseCecPage(html: string): ParsedPage {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const text = decode(clean);
  const stations = /已送投(?:開)?票所數\s*\/\s*總投(?:開)?票所數\s*[:：]?\s*([\d,]+)\s*\/\s*([\d,]+)/.exec(text);
  const time = /資料時間\s*[:：]?\s*(\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)/.exec(text);
  const title = decode((/<b>([\s\S]*?)<\/b>/i.exec(clean) ?? /<h\d[^>]*>([\s\S]*?)<\/h\d>/i.exec(clean) ?? ['', ''])[1]);
  const page: ParsedPage = {
    title,
    stationsCounted: stations ? toInt(stations[1]) : null,
    stationsTotal: stations ? toInt(stations[2]) : null,
    dataTime: time ? time[1] : null,
    candidates: [],
    seats: (() => {
      const m = /應選人數\s*[:：]\s*(\d+)/.exec(text);
      return m ? Number(m[1]) : null;
    })(),
    valid: null,
    invalid: null,
    total: null,
    eligible: null,
  };
  for (const t of tables(clean)) {
    const noCol = col(t.header, /號次/);
    const votesCol = col(t.header, /^得票數$/, /得票數(?!率)/, /^votes?$/i);
    if (noCol >= 0 && votesCol >= 0) {
      const nameCol = col(t.header, /姓名/, /候選人/);
      const partyCol = col(t.header, /推薦之?政黨/, /^政黨$/);
      for (const row of t.rows) {
        const number = toInt(cell(row, t.header, noCol));
        const votes = toInt(cell(row, t.header, votesCol));
        if (number === null || votes === null || number < 1 || number > 99) continue;
        const name = nameCol >= 0 ? (cell(row, t.header, nameCol) ?? null) : null;
        const party = partyCol >= 0 ? (cell(row, t.header, partyCol) ?? null) : null;
        page.candidates.push({ number, name: name ? name.replace(/[◎★✓✔]/g, '').trim() : null, votes, ...(partyCol >= 0 ? { party: party ? party.trim() : null } : {}) });
      }
      continue;
    }
    const first = t.rows[0];
    if (!first) continue;
    const pick = (...re: RegExp[]) => toInt(cell(first, t.header, col(t.header, ...re)));
    page.valid ??= pick(/^有效票數?$/);
    page.invalid ??= pick(/^無效票數?$/);
    page.total ??= pick(/^投票數$/, /^投票人數$/);
    page.eligible ??= pick(/^(選舉人|投票權人)總?數$/);
  }
  return page;
}

/** 我們的地區代碼 → 中選會 17 碼：縣市 63000 → 63000000000000000；鄉鎮市區 63000010 → 63000000100000000。 */
export function cecCode(code: string): string {
  if (/^\d{5}$/.test(code)) return code + '0'.repeat(12);
  if (/^\d{8}$/.test(code)) return `${code.slice(0, 5)}00${code.slice(5)}0000000`;
  throw new Error(`不支援的地區代碼：${code}`);
}

export function parseConfig(raw: string | null | undefined): CecLiveConfig {
  let o: Partial<CecLiveConfig> = {};
  try {
    o = JSON.parse(raw || '{}') as Partial<CecLiveConfig>;
  } catch {
    /* 當作沒設定 */
  }
  const out: CecLiveConfig = { base: String(o.base ?? '').trim().replace(/\/+$/, ''), prefix: String(o.prefix ?? '').trim() };
  if (o.auto) out.auto = true;
  if (Array.isArray(o.hosts)) out.hosts = o.hosts.map((h) => String(h).trim().replace(/\/+$/, '')).filter(Boolean).slice(0, 10);
  if (typeof o.startAt === 'string' && !Number.isNaN(Date.parse(o.startAt))) out.startAt = o.startAt;
  return out;
}

export function checkConfig(c: CecLiveConfig): CecLiveConfig {
  // 自動尋找模式：網址開頭與類別代碼可以先空著，找到後才填入。
  if (c.auto && !c.base && !c.prefix) {
    for (const h of c.hosts ?? []) {
      if (!/^https?:\/\//i.test(h)) throw new HttpError(400, `網址格式不正確：${h}`);
    }
    return c;
  }
  let url: URL;
  try {
    url = new URL(c.base);
  } catch {
    throw new HttpError(400, '請填入中選會開票網站的網址開頭，例如 https://vote2026.cec.gov.tw/zh-TW');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, '網址需為 http 或 https');
  if (!/^[A-Za-z0-9]{1,4}$/.test(c.prefix)) throw new HttpError(400, '類別代碼應為 1–4 個英數字，例如 TC、C1');
  return c;
}

export const pageUrl = (c: CecLiveConfig, code: string) => `${c.base}/${c.prefix}/${cecCode(code)}.html`;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let http: Fetch = (url, init) => fetch(url, init);
/** 測試用：換掉對外連線。 */
export function setCecLiveFetch(f: Fetch | null): void {
  http = f ?? ((url, init) => fetch(url, init));
}

export async function fetchPage(c: CecLiveConfig, code: string): Promise<{ url: string; html: string }> {
  return fetchUrl(pageUrl(c, code));
}

/** 讀取中選會開票網站的一頁。 */
export async function fetchUrl(url: string): Promise<{ url: string; html: string }> {
  // 加上時間參數避開快取，跟中選會網頁自己的做法一樣。
  const res = await http(`${url}?_=${Date.now()}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; vote-dashboard/0.1)', accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 2 * 1024 * 1024) throw new Error('頁面太大');
  return { url, html: new TextDecoder('utf-8').decode(buf) };
}

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

export type PageResult = { code: string; name: string; url: string; ok: boolean; message: string; page?: ParsedPage };

/** 讀取這場選舉需要的所有頁面，轉成可匯入的資料列；有問題的頁面不轉換，只回報原因。 */
export async function collectCecLive(ctx: Ctx, election: Election, c: CecLiveConfig): Promise<{ rows: NormRow[]; pages: PageResult[]; hash: string }> {
  if (election.unit_level === 'station') throw new HttpError(400, '中選會開票網站轉接只支援「縣市」或「鄉鎮市區」統計層級');
  const cands = candidatesByContest(ctx, election.id);
  const targets: { code: string; name: string; contestId: number; pagePath?: string }[] = [];
  for (const contest of listContests(ctx, election.id)) {
    // 議員選舉：每個選舉區有自己的頁面，整個選舉區的結果記在所屬縣市底下。
    if (contest.cec_page) {
      targets.push({ code: contest.area_code, name: contest.name, contestId: contest.id, pagePath: contest.cec_page });
      continue;
    }
    const counties = contest.area_code === '00000' ? ctx.areas.counties.map((a) => a.code) : [contest.area_code];
    for (const county of counties) {
      if (election.unit_level === 'county') targets.push({ code: county, name: ctx.areas.name(county), contestId: contest.id });
      else for (const t of ctx.areas.townsOf.get(county) ?? []) targets.push({ code: t.code, name: `${ctx.areas.name(county)} ${t.name}`, contestId: contest.id });
    }
  }
  // 一次最多同時讀 4 頁，避免對中選會網站造成負擔。
  const bodies: string[] = new Array(targets.length).fill('');
  const pages = await pool(targets, 4, async (t): Promise<PageResult & { contestId: number; pagePath?: string }> => {
    let url = t.pagePath ? `${c.base}/${t.pagePath}.html` : pageUrl(c, t.code);
    try {
      const got = t.pagePath ? await fetchUrl(url) : await fetchPage(c, t.code);
      url = got.url;
      bodies[targets.indexOf(t)] = got.html;
      const page = parseCecPage(got.html);
      if (!page.candidates.length) return { ...t, url, ok: false, message: '頁面格式不符：找不到「號次／得票數」表格', page };
      const list = cands.get(t.contestId) ?? [];
      for (const p of page.candidates) {
        const mine = list.find((k) => k.number === p.number);
        if (!mine) return { ...t, url, ok: false, message: `頁面上有 ${p.number} 號，但這個選舉區沒有 ${p.number} 號候選人`, page };
        if (p.name && normName(p.name) !== normName(mine.name) && !normName(p.name).includes(normName(mine.name))) {
          return { ...t, url, ok: false, message: `${p.number} 號在頁面上是「${p.name}」，我們的名單是「${mine.name}」，請核對候選人名單`, page };
        }
      }
      const sum = page.candidates.reduce((s, p) => s + p.votes, 0);
      if (page.valid !== null && page.valid !== sum) return { ...t, url, ok: false, message: `各候選人得票加總 ${sum} 與有效票 ${page.valid} 不符`, page };
      return { ...t, url, ok: true, message: page.dataTime ? `資料時間 ${page.dataTime}` : '', page };
    } catch (err) {
      return { ...t, url, ok: false, message: `讀取失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  });
  const rows: NormRow[] = [];
  for (const p of pages) {
    if (!p.ok || !p.page) continue;
    const row: NormRow = { line: rows.length + 1, code: p.code, contest: String(p.contestId), byNumber: new Map(), byName: new Map() };
    for (const cand of p.page.candidates) row.byNumber.set(cand.number, cand.votes);
    if (p.page.invalid !== null) row.invalid = p.page.invalid;
    if (p.page.eligible !== null) row.eligible = p.page.eligible;
    if (p.page.stationsTotal !== null && p.page.stationsCounted !== null) {
      row.stationsTotal = p.page.stationsTotal;
      row.stationsCounted = p.page.stationsCounted;
    }
    rows.push(row);
  }
  const hash = createHash('sha256');
  targets.forEach((t, i) => hash.update(t.pagePath ?? t.code).update('\0').update(bodies[i]).update('\0'));
  return { rows, pages: pages.map(({ contestId: _c, pagePath: _p, ...rest }) => rest), hash: hash.digest('hex') };
}

/** 從中選會網站的導覽清單（2025 年起有）找出可能的類別代碼。 */
async function manifestPrefixes(base: string): Promise<string[]> {
  try {
    const origin = new URL(base).origin;
    const res = await http(`${origin}/assets/def/tree-compiled.min.json?_=${Date.now()}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const text = (await res.text()).slice(0, 5_000_000);
    return [...new Set([...text.matchAll(/"prefix"\s*:\s*"([A-Za-z0-9]{1,4})"/g)].map((m) => m[1]))];
  } catch {
    return [];
  }
}

/**
 * 自動尋找中選會開票網站：用第一個選舉區的縣市頁試各種「網址開頭 × 類別代碼」，
 * 頁面上的號次與姓名必須和我們的候選人名單完全一致才採用，不會誤認成別的選舉。
 */
export async function discoverCecLive(ctx: Ctx, election: Election, c: CecLiveConfig): Promise<{ found: CecLiveConfig | null; tried: number }> {
  const contests = listContests(ctx, election.id);
  const contest = contests[0];
  if (!contest) return { found: null, tried: 0 };
  const code = contest.area_code === '00000' ? '63000' : contest.area_code;
  const ours = candidatesByContest(ctx, election.id).get(contest.id) ?? [];
  if (!ours.length) return { found: null, tried: 0 };
  let tried = 0;
  for (const base of c.hosts?.length ? c.hosts : DISCOVERY_BASES) {
    const prefixes = [...new Set([...(await manifestPrefixes(base)), ...DISCOVERY_PREFIXES])];
    for (const prefix of prefixes) {
      tried++;
      try {
        const { html } = await fetchPage({ base, prefix }, code);
        const page = parseCecPage(html);
        if (!page.candidates.length || page.candidates.length !== ours.length) continue;
        const ok = page.candidates.every((p) => {
          const mine = ours.find((k) => k.number === p.number);
          return mine && (!p.name || normName(p.name) === normName(mine.name) || normName(p.name).includes(normName(mine.name)));
        });
        if (ok) return { found: { ...c, base, prefix }, tried };
      } catch {
        // 網址不存在、連不上或格式不符：試下一個
      }
    }
  }
  return { found: null, tried };
}
