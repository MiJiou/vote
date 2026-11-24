// 從維基數據／維基共享資源找候選人照片。
// 只回傳自由授權（CC BY、CC BY-SA、CC0、公有領域）的照片，並附上作者與授權，用來在畫面上標示出處。
import { HttpError } from './util.ts';

const UA = `vote-dashboard/0.1 (self-hosted election results dashboard${process.env.WIKIMEDIA_CONTACT ? `; ${process.env.WIKIMEDIA_CONTACT}` : ''})`;
const SPARQL = 'https://query.wikidata.org/sparql';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const TAIWAN = 'Q865';

type Fetch = (url: URL | string, init?: RequestInit) => Promise<Response>;
let http: Fetch = (url, init) => fetch(url, init);
/** 測試用：換掉對外連線。 */
export function setCommonsFetch(f: Fetch | null): void {
  http = f ?? ((url, init) => fetch(url, init));
}

const RATE_LIMITED = '維基媒體暫時限制了連線次數，請過幾分鐘再試';

/** 取得 JSON；有 form 時改用 POST（查詢很長時網址會超過伺服器上限）。 */
async function getJson<T>(url: URL, form?: URLSearchParams): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { 'user-agent': UA, 'api-user-agent': UA, accept: 'application/sparql-results+json, application/json' };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await http(url, { method: form ? 'POST' : 'GET', headers, body: form, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    const limited = res.status === 429 || /too many requests/i.test(text.slice(0, 300));
    if ((limited || res.status >= 500) && attempt < 2) {
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

/**
 * 依姓名查詢維基數據裡「是人、而且有照片」的項目。
 * 一次查詢處理多個姓名，避免逐一查詢觸發流量限制。
 */
async function searchWikidata(names: string[]): Promise<Map<string, Found[]>> {
  const found = new Map<string, Map<string, Found>>();
  for (let i = 0; i < names.length; i += 60) {
    const chunk = names.slice(i, i + 60);
    const values = chunk.flatMap((n) => ['zh', 'zh-tw', 'zh-hant'].map((lang) => `${JSON.stringify(n)}@${lang}`)).join(' ');
    const query = `SELECT ?item ?name ?image ?desc ?dl ?birth ?tw ?pol WHERE {
      VALUES ?name { ${values} }
      ?item rdfs:label ?name ; wdt:P31 wd:Q5 ; wdt:P18 ?image .
      OPTIONAL { ?item schema:description ?desc . BIND(LANG(?desc) AS ?dl) FILTER(?dl IN ("zh-tw", "zh-hant", "zh")) }
      OPTIONAL { ?item wdt:P569 ?birth }
      OPTIONAL { ?item wdt:P27 wd:${TAIWAN} . BIND(1 AS ?tw) }
      OPTIONAL { ?item wdt:P106 wd:Q82955 . BIND(1 AS ?pol) }
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
      const hit = byItem.get(qid);
      if (hit) {
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
        file: fileOf(b.image.value),
        score: 0,
      });
    }
  }
  const out = new Map<string, Found[]>();
  for (const [name, byItem] of found) {
    const list = [...byItem.values()];
    for (const p of list) p.score = (p.taiwan ? 2 : 0) + (p.politician ? 2 : 0);
    out.set(name, list.sort((a, b) => b.score - a.score).slice(0, 4));
  }
  return out;
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

/** 依姓名找照片；回傳每個姓名可用的候選照片（依可信度排序），以及因授權不符而略過的張數。 */
export async function findPhotos(names: string[]): Promise<{ matches: Map<string, PhotoMatch[]>; excluded: number }> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const people = await searchWikidata(unique);
  const files = [...new Set([...people.values()].flat().map((p) => p.file))];
  const infos = files.length ? await imageInfo(files) : new Map<string, ImageInfo | null>();
  const matches = new Map<string, PhotoMatch[]>();
  let excluded = 0;
  for (const [name, list] of people) {
    const usable: PhotoMatch[] = [];
    for (const p of list) {
      const info = infos.get(p.file);
      if (!info) {
        excluded++;
        continue;
      }
      usable.push({
        qid: p.qid, label: p.label, description: p.description, birthYear: p.birthYear, taiwan: p.taiwan, politician: p.politician,
        file: p.file, ...info, credit: `${info.author}／${info.license}／維基共享資源`,
      });
    }
    if (usable.length) matches.set(name, usable);
  }
  return { matches, excluded };
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
