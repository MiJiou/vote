// 從維基數據／中文維基百科／維基共享資源找候選人照片。
// 只回傳自由授權（CC BY、CC BY-SA、CC0、公有領域）的照片，並附上作者與授權，用來在畫面上標示出處。
import { HttpError } from './util.ts';

const UA = `vote-dashboard/0.1 (self-hosted election results dashboard${process.env.WIKIMEDIA_CONTACT ? `; ${process.env.WIKIMEDIA_CONTACT}` : ''})`;
const SPARQL = 'https://query.wikidata.org/sparql';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const ZHWIKI_API = 'https://zh.wikipedia.org/w/api.php';
const TAIWAN = 'Q865';

type Fetch = (url: URL | string, init?: RequestInit) => Promise<Response>;
let http: Fetch = (url, init) => fetch(url, init);
/** 測試用：換掉對外連線。 */
export function setCommonsFetch(f: Fetch | null): void {
  http = f ?? ((url, init) => fetch(url, init));
}

const RATE_LIMITED = '維基媒體暫時限制了連線次數，請過幾分鐘再試';

/** 取得 JSON；有 form 時改用 POST（查詢很長時網址會超過伺服器上限）。 */
async function getJson<T>(url: URL, form?: URLSearchParams, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { 'user-agent': UA, 'api-user-agent': UA, accept: 'application/sparql-results+json, application/json' };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    let res: Response;
    let text: string;
    try {
      res = await http(url, { method: form ? 'POST' : 'GET', headers, body: form, signal: AbortSignal.timeout(30_000) });
      text = await res.text();
    } catch {
      // 逾時或連線中斷：稍等再試，仍失敗就回報清楚的訊息
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw new HttpError(502, '連不上維基媒體（逾時或連線中斷），請過幾分鐘再試');
    }
    const limited = res.status === 429 || /too many requests/i.test(text.slice(0, 300));
    if ((limited || res.status >= 500) && attempt < retries) {
      const header = res.headers.get('retry-after');
      const wait = header !== null && header.trim() !== '' && Number.isFinite(Number(header)) ? Number(header) : 2 * (attempt + 1);
      await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
      continue;
    }
    if (limited) throw new HttpError(503, RATE_LIMITED);
    if (!res.ok) throw new HttpError(502, `維基媒體回應錯誤（HTTP ${res.status}）`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(502, '維基媒體回傳的內容無法解讀');
    }
  }
}

export type PhotoMatch = {
  qid: string;
  label: string;
  description: string;
  birthYear: string | null;
  taiwan: boolean;
  politician: boolean;
  /** 維基數據上的所屬政黨（中文名稱），用來區分同名同姓的人。 */
  parties: string[];
  /** 照片從哪裡找到：維基數據的照片欄位、中文維基百科條目的主圖，或維基共享資源的檔名。 */
  via: 'wikidata' | 'wikipedia' | 'commons';
  file: string;
  thumb: string;
  author: string;
  license: string;
  sourceUrl: string;
  /** 顯示在畫面上的出處，例如「王小明／CC BY-SA 4.0／維基共享資源」。 */
  credit: string;
};

type Binding = Record<string, { value: string; 'xml:lang'?: string } | undefined>;

/**
 * 可以拿來播出的授權：CC BY、CC BY-SA、CC0、公有領域，以及「Attribution」（只要求標示出處，
 * 臺灣政府網站釋出的照片多屬此類）。排除非商業（NC）、禁止改作（ND），以及必須附上全文的 GFDL。
 */
export function usableLicense(short: string): boolean {
  const s = short.trim();
  if (/\b(nc|nd)\b/i.test(s)) return false;
  return /^(cc0|public domain|pd\b|cc[ -]by(-sa)?[ -]\d|attribution$)/i.test(s);
}

const LICENSE_LABEL: Record<string, string> = { attribution: '標示出處授權', 'public domain': '公有領域' };

/** 把維基共享資源的作者欄位（HTML）轉成純文字。 */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const fileOf = (uri: string): string => decodeURIComponent(uri.replace(/^.*\/Special:FilePath\//, '')).replace(/_/g, ' ');

type Found = Omit<PhotoMatch, 'thumb' | 'author' | 'license' | 'sourceUrl' | 'credit'> & { descLang: string; score: number };

/** 要找照片的人：姓名，加上（可省略的）政黨與縣市，用來排序同名的人。 */
export type PhotoQuery = string | { name: string; party?: string; area?: string };

const normParty = (s: string) => s.replace(/\s+/g, '').replace(/台/g, '臺');

/** 維基數據查詢的共同部分：生日、是否臺灣人、是否政治人物、所屬政黨。 */
const FACTS = `OPTIONAL { ?item wdt:P569 ?birth }
      OPTIONAL { ?item wdt:P27 wd:${TAIWAN} . BIND(1 AS ?tw) }
      OPTIONAL { ?item wdt:P106 wd:Q82955 . BIND(1 AS ?pol) }
      OPTIONAL { ?item wdt:P102 ?p . ?p rdfs:label ?party . FILTER(LANG(?party) IN ("zh-tw", "zh-hant", "zh")) }`;

/**
 * 依姓名查詢維基數據裡「是人、而且有照片」的項目。
 * 一次查詢處理多個姓名，避免逐一查詢觸發流量限制。
 */
async function searchWikidata(names: string[]): Promise<Map<string, Found[]>> {
  const found = new Map<string, Map<string, Found>>();
  for (let i = 0; i < names.length; i += 60) {
    const chunk = names.slice(i, i + 60);
    const values = chunk.flatMap((n) => ['zh', 'zh-tw', 'zh-hant'].map((lang) => `${JSON.stringify(n)}@${lang}`)).join(' ');
    const query = `SELECT ?item ?name ?image ?desc ?dl ?birth ?tw ?pol ?party WHERE {
      VALUES ?name { ${values} }
      ?item rdfs:label ?name ; wdt:P31 wd:Q5 ; wdt:P18 ?image .
      OPTIONAL { ?item schema:description ?desc . BIND(LANG(?desc) AS ?dl) FILTER(?dl IN ("zh-tw", "zh-hant", "zh")) }
      ${FACTS}
    }`;
    const data = await getJson<{ results: { bindings: Binding[] } }>(new URL(SPARQL), new URLSearchParams({ query, format: 'json' }));
    const rank = { 'zh-tw': 3, 'zh-hant': 2, zh: 1 } as Record<string, number>;
    for (const b of data.results.bindings) {
      const name = b.name?.value;
      const qid = b.item?.value.split('/').pop();
      if (!name || !qid || !b.image) continue;
      if (!found.has(name)) found.set(name, new Map());
      const byItem = found.get(name)!;
      const desc = b.desc?.value ?? '';
      const dl = b.dl?.value ?? '';
      const party = b.party?.value;
      const hit = byItem.get(qid);
      if (hit) {
        if (party && !hit.parties.includes(party)) hit.parties.push(party);
        if (desc && (rank[dl] ?? 0) > (rank[hit.descLang] ?? 0)) Object.assign(hit, { description: desc, descLang: dl });
        if (b.tw) hit.taiwan = true;
        if (b.pol) hit.politician = true;
        continue;
      }
      byItem.set(qid, {
        qid,
        label: name,
        description: desc,
        descLang: dl,
        birthYear: b.birth?.value.slice(0, 4) ?? null,
        taiwan: !!b.tw,
        politician: !!b.pol,
        parties: party ? [party] : [],
        via: 'wikidata',
        file: fileOf(b.image.value),
        score: 0,
      });
    }
  }
  const out = new Map<string, Found[]>();
  for (const [name, byItem] of found) out.set(name, [...byItem.values()]);
  return out;
}

type Facts = { birthYear: string | null; taiwan: boolean; politician: boolean; parties: string[] };

/** 查詢指定維基數據項目的生日、國籍、職業與政黨。 */
async function wikidataFacts(qids: string[]): Promise<Map<string, Facts>> {
  const out = new Map<string, Facts>();
  for (let i = 0; i < qids.length; i += 100) {
    const values = qids.slice(i, i + 100).map((q) => `wd:${q}`).join(' ');
    const query = `SELECT ?item ?birth ?tw ?pol ?party WHERE {
      VALUES ?item { ${values} }
      ${FACTS}
    }`;
    const data = await getJson<{ results: { bindings: Binding[] } }>(new URL(SPARQL), new URLSearchParams({ query, format: 'json' }));
    for (const b of data.results.bindings) {
      const qid = b.item?.value.split('/').pop();
      if (!qid) continue;
      const f = out.get(qid) ?? { birthYear: null, taiwan: false, politician: false, parties: [] };
      if (b.birth) f.birthYear = b.birth.value.slice(0, 4);
      if (b.tw) f.taiwan = true;
      if (b.pol) f.politician = true;
      if (b.party && !f.parties.includes(b.party.value)) f.parties.push(b.party.value);
      out.set(qid, f);
    }
  }
  return out;
}

/**
 * 中文維基百科：很多地方政治人物的維基數據項目沒有照片，但條目裡有自由授權的主圖。
 * 查詢會自動處理重新導向與繁簡、異體字（例如「張啓楷」與「張啟楷」），略過消歧義頁。
 */
async function searchZhWikipedia(names: string[]): Promise<Map<string, Found[]>> {
  const out = new Map<string, Found[]>();
  for (let i = 0; i < names.length; i += 50) {
    const url = new URL(ZHWIKI_API);
    for (const [k, v] of Object.entries({
      action: 'query', prop: 'pageimages|pageprops|description', piprop: 'name', pilicense: 'free', redirects: '1', converttitles: '1',
      format: 'json', formatversion: '2', maxlag: '5', titles: names.slice(i, i + 50).join('|'),
    })) url.searchParams.set(k, v);
    type Page = { title: string; missing?: boolean; pageimage?: string; description?: string; pageprops?: { wikibase_item?: string; disambiguation?: string } };
    type Hop = { from: string; to: string };
    const data = await getJson<{ query?: { pages?: Page[]; normalized?: Hop[]; converted?: Hop[]; redirects?: Hop[] } }>(url);
    const q = data.query ?? {};
    // 從最後的條目名稱一路追回查詢時用的姓名
    const back = new Map<string, string>();
    for (const hop of [...(q.normalized ?? []), ...(q.converted ?? []), ...(q.redirects ?? [])]) back.set(hop.to, back.get(hop.from) ?? hop.from);
    for (const page of q.pages ?? []) {
      const qid = page.pageprops?.wikibase_item;
      if (page.missing || !page.pageimage || !qid || page.pageprops?.disambiguation !== undefined) continue;
      const name = back.get(page.title) ?? page.title;
      out.set(name, [
        {
          qid, label: page.title, description: page.description ?? '', descLang: 'zh-tw', birthYear: null, taiwan: false, politician: false,
          parties: [], via: 'wikipedia', file: page.pageimage.replace(/_/g, ' '), score: 0,
        },
      ]);
    }
  }
  const qids = [...new Set([...out.values()].flat().map((f) => f.qid))];
  const facts = qids.length ? await wikidataFacts(qids) : new Map<string, Facts>();
  for (const f of [...out.values()].flat()) {
    const known = facts.get(f.qid);
    if (known) Object.assign(f, known);
    // 地方政治人物在維基數據上常缺國籍或職業，改看條目描述（例如「臺東縣議會議長」「中華民國律師、政治人物」）
    f.taiwan ||= TAIWANESE.test(f.description);
    f.politician ||= POLITICAL.test(f.description);
  }
  return out;
}

const POLITICAL = /候選人|參選|候选人|参选|議員|議長|議會|立委|立法委員|縣長|市長|鄉長|鎮長|政治|candidate|councilor|legislator|mayor|magistrate/i;
const TAIWANESE = /臺灣|台灣|台湾|中華民國|中华民国|[縣市]議/;
/** 檔名裡姓名後面接的字：接著其他漢字（例如「張靜」後面接「茵」）通常是另一個人。 */
const AFTER_NAME = /^(?:$|[^\p{Script=Han}]|肖像|照|像|參選|参选|候選|候选|競選|竞选|議員|議長|立委|縣長|市長|出席|參加|於|在|與|和|的)/u;

/**
 * 維基共享資源的檔名搜尋：還沒有維基百科條目的新人，有時會有人上傳像
 * 「游淑貞，2026年花蓮縣長選舉候選人肖像照.jpg」這樣的照片。
 * 這個搜尋的流量限制比較嚴，所以一個一個慢慢查、有時間上限，被限制時就停下來。
 */
async function searchCommonsFiles(
  people: { name: string; areas: string[] }[],
  budgetMs: number,
  gapMs: number,
): Promise<{ found: Map<string, Found[]>; limited: boolean }> {
  const found = new Map<string, Found[]>();
  const deadline = Date.now() + budgetMs;
  for (const [i, { name, areas }] of people.entries()) {
    if (Date.now() > deadline) return { found, limited: true };
    if (i > 0 && gapMs) await new Promise((r) => setTimeout(r, gapMs));
    const url = new URL(COMMONS_API);
    for (const [k, v] of Object.entries({
      action: 'query', list: 'search', srnamespace: '6', srlimit: '6', srprop: '', format: 'json', formatversion: '2', maxlag: '5', srsearch: `intitle:"${name}"`,
    })) url.searchParams.set(k, v);
    let data: { query?: { search?: { title: string }[] } };
    try {
      data = await getJson(url, undefined, 0);
    } catch {
      return { found, limited: true };
    }
    const aliases = areas
      .flatMap((a) => [a, a.replace(/[市縣]$/, '')])
      .filter((a) => a.length >= 2)
      .flatMap((a) => [a, a.replace(/臺/g, '台')]);
    const hits: Found[] = [];
    for (const { title } of data.query?.search ?? []) {
      const file = title.replace(/^File:/, '');
      if (!/\.(jpe?g|png|webp)$/i.test(file)) continue;
      const text = file.replace(/\.[a-z]+$/i, '');
      const at = text.indexOf(name);
      if (at < 0 || !AFTER_NAME.test(text.slice(at + name.length))) continue;
      hits.push({
        qid: '', label: name, description: text, descLang: '', birthYear: null,
        // 檔名有寫到縣市（或臺灣），又有「候選人」「議員」等字眼，才當作是臺灣的政治人物
        taiwan: aliases.some((a) => text.includes(a)) || /臺灣|台灣|Taiwan/i.test(text),
        politician: POLITICAL.test(text),
        parties: [], via: 'commons', file, score: 0,
      });
    }
    if (hits.length) found.set(name, hits);
  }
  return { found, limited: false };
}

type ImageInfo = { thumb: string; author: string; license: string; sourceUrl: string };

/** 從維基共享資源取得照片的縮圖、作者與授權。 */
async function imageInfo(files: string[]): Promise<Map<string, ImageInfo | null>> {
  const out = new Map<string, ImageInfo | null>();
  for (let i = 0; i < files.length; i += 50) {
    const chunk = files.slice(i, i + 50);
    const url = new URL(COMMONS_API);
    for (const [k, v] of Object.entries({
      action: 'query', prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '320', format: 'json', formatversion: '2', maxlag: '5',
      titles: chunk.map((f) => `File:${f}`).join('|'),
    })) url.searchParams.set(k, v);
    type Page = { title: string; imageinfo?: { thumburl?: string; descriptionurl?: string; extmetadata?: Record<string, { value?: string }> }[] };
    const data = await getJson<{ query?: { pages?: Page[]; normalized?: { from: string; to: string }[] } }>(url);
    const alias = new Map((data.query?.normalized ?? []).map((n) => [n.to, n.from]));
    for (const page of data.query?.pages ?? []) {
      const file = (alias.get(page.title) ?? page.title).replace(/^File:/, '');
      const info = page.imageinfo?.[0];
      const meta = info?.extmetadata ?? {};
      const license = plainText(meta.LicenseShortName?.value ?? '');
      if (!info?.thumburl || !usableLicense(license)) {
        out.set(file, null);
        continue;
      }
      const author = plainText(meta.Artist?.value ?? '') || plainText(meta.Credit?.value ?? '') || '作者不詳';
      out.set(file, { thumb: info.thumburl, author: author.slice(0, 80), license: LICENSE_LABEL[license.toLowerCase()] ?? license, sourceUrl: info.descriptionurl ?? '' });
    }
  }
  return out;
}

/**
 * 依姓名找照片；回傳每個姓名可用的候選照片（依可信度排序）、因授權不符而略過的張數，
 * 以及檔名搜尋是否因流量限制或時間上限而沒有查完（limited）。
 *
 * 依序查三個地方，前面找不到「臺灣的政治人物」時才往下查：
 *   1. 維基數據的照片欄位
 *   2. 中文維基百科條目的主圖（只取自由授權的）
 *   3. 維基共享資源的檔名
 */
export async function findPhotos(
  queries: PhotoQuery[],
  opts: { commonsBudgetMs?: number; commonsGapMs?: number } = {},
): Promise<{ matches: Map<string, PhotoMatch[]>; excluded: number; limited: boolean }> {
  const people = new Map<string, { parties: Set<string>; areas: Set<string> }>();
  for (const q of queries) {
    const { name, party = '', area = '' } = typeof q === 'string' ? { name: q } : q;
    const n = name.trim();
    if (!n) continue;
    if (!people.has(n)) people.set(n, { parties: new Set(), areas: new Set() });
    if (party.trim()) people.get(n)!.parties.add(normParty(party));
    if (area.trim()) people.get(n)!.areas.add(area.trim());
  }
  const unique = [...people.keys()];
  const all = new Map<string, Found[]>();
  const add = (more: Map<string, Found[]>) => {
    for (const [name, list] of more) {
      if (!people.has(name)) continue; // 對方回傳了沒查詢的姓名（例如重新導向追不回來），略過
      const have = all.get(name) ?? [];
      for (const f of list) if (!have.some((h) => h.file === f.file || (f.qid && h.qid === f.qid))) have.push(f);
      all.set(name, have);
    }
  };
  const strong = (name: string) => (all.get(name) ?? []).some((f) => f.taiwan && f.politician);

  add(await searchWikidata(unique));
  const notYet = unique.filter((n) => !strong(n));
  if (notYet.length) add(await searchZhWikipedia(notYet));
  const stillNot = unique.filter((n) => !strong(n));
  const commons = stillNot.length
    ? await searchCommonsFiles(
        stillNot.map((name) => ({ name, areas: [...people.get(name)!.areas] })),
        opts.commonsBudgetMs ?? 30_000,
        opts.commonsGapMs ?? 1000,
      )
    : { found: new Map<string, Found[]>(), limited: false };
  add(commons.found);

  // 排序：臺灣人、政治人物、政黨與候選人相同的優先
  for (const [name, list] of all) {
    const parties = people.get(name)!.parties;
    for (const p of list) {
      const partyMatch = p.parties.some((x) => parties.has(normParty(x)));
      p.score = (p.taiwan ? 2 : 0) + (p.politician ? 2 : 0) + (partyMatch ? 3 : 0);
    }
    all.set(name, list.sort((a, b) => b.score - a.score).slice(0, 5));
  }

  const files = [...new Set([...all.values()].flat().map((p) => p.file))];
  const infos = files.length ? await imageInfo(files) : new Map<string, ImageInfo | null>();
  const matches = new Map<string, PhotoMatch[]>();
  let excluded = 0;
  for (const [name, list] of all) {
    const usable: PhotoMatch[] = [];
    for (const p of list) {
      const info = infos.get(p.file);
      if (!info) {
        excluded++;
        continue;
      }
      usable.push({
        qid: p.qid, label: p.label, description: p.description, birthYear: p.birthYear, taiwan: p.taiwan, politician: p.politician,
        parties: p.parties, via: p.via, file: p.file, ...info, credit: `${info.author}／${info.license}／維基共享資源`,
      });
    }
    if (usable.length) matches.set(name, usable);
  }
  return { matches, excluded, limited: commons.limited };
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** 下載維基共享資源上的照片（寬 640 像素的版本），交給後台在瀏覽器裡裁切。 */
export async function fetchCommonsImage(file: unknown): Promise<{ mime: string; data: Buffer }> {
  if (typeof file !== 'string' || !file.trim() || file.length > 240 || /[/\\#?<>[\]{}|\u0000-\u001f]/.test(file)) {
    throw new HttpError(400, '檔名不正確');
  }
  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.trim().replace(/ /g, '_'))}?width=640`;
  const res = await http(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (res.status === 429) throw new HttpError(503, RATE_LIMITED);
  if (!res.ok) throw new HttpError(502, `下載照片失敗（HTTP ${res.status}）`);
  const host = new URL(res.url || url).hostname;
  // 圖片可能由 upload.wikimedia.org 或 thumb.wikimedia.org 等維基媒體自己的網域提供。
  if (!host.endsWith('.wikimedia.org')) throw new HttpError(502, '照片來源不是維基共享資源');
  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!IMAGE_TYPES.has(mime)) throw new HttpError(502, '下載到的不是圖片');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > 8 * 1024 * 1024) throw new HttpError(502, '照片檔案太大');
  return { mime, data };
}
