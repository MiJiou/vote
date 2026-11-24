// 產生行政區清單（server/data/areas.json）與精簡後的地圖圖資（web/public/maps/tw.json）。
// 圖資來源：taiwan-atlas（內政部國土測繪中心開放資料）；官方名稱取自中選會選舉資料庫。
// 產出的檔案已提交到版本庫，平常不需要重新執行；行政區調整時再跑一次：npm run build:geo
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { presimplify, simplify, quantile } from 'topojson-simplify';
import { feature } from 'topojson-client';
import { topology } from 'topojson-server';

const require = createRequire(import.meta.url);
const atlas = JSON.parse(readFileSync(require.resolve('taiwan-atlas/towns-10t.json'), 'utf8'));

// 中選會慣用的縣市排序：六都在前，其餘依省轄縣、市。
const COUNTY_ORDER = [
  '63000', '65000', '68000', '66000', '67000', '64000',
  '10004', '10005', '10007', '10008', '10009', '10010', '10013',
  '10002', '10015', '10014', '10016', '09020', '09007',
  '10017', '10018', '10020',
];
const MUNICIPALITIES = new Set(['63000', '65000', '68000', '66000', '67000', '64000']);

const THEME_2024_PRESIDENT = '4d83db17c1707e3defae5dc4d4e9c800';
const CEC = 'https://db.cec.gov.tw/static/elections/data/areas/ELC/P0/00/' + THEME_2024_PRESIDENT;

async function fetchOfficialNames() {
  const names = new Map();
  try {
    const counties = Object.values(await (await fetch(`${CEC}/C/00_000_00_000_0000.json`)).json())[0];
    for (const c of counties) {
      names.set(c.ris_prv_code + c.ris_city_code, c.area_name);
      const key = `${c.prv_code}_${c.city_code}_00_000_0000`;
      const towns = Object.values(await (await fetch(`${CEC}/D/${key}.json`)).json())[0];
      for (const t of towns) names.set(t.ris_prv_code + t.ris_city_code + t.ris_dept_code, t.area_name);
    }
  } catch (err) {
    console.warn('無法取得中選會官方名稱，改用圖資內的名稱：', err.message);
  }
  return names;
}

const official = await fetchOfficialNames();
const fix = (name) => name.replace(/^台/, '臺');

const areas = [];
const countyGeoms = atlas.objects.counties.geometries;
const townGeoms = atlas.objects.towns.geometries;

for (const code of COUNTY_ORDER) {
  const g = countyGeoms.find((x) => x.properties.COUNTYCODE === code);
  if (!g) throw new Error('圖資缺少縣市 ' + code);
  areas.push({
    code,
    name: official.get(code) ?? fix(g.properties.COUNTYNAME),
    level: 'county',
    parent: null,
    kind: MUNICIPALITIES.has(code) ? 'municipality' : 'county',
  });
}
let unmatched = 0;
for (const county of [...areas]) {
  const towns = townGeoms
    .filter((x) => x.properties.COUNTYCODE === county.code)
    .sort((a, b) => a.properties.TOWNCODE.localeCompare(b.properties.TOWNCODE));
  for (const t of towns) {
    const code = t.properties.TOWNCODE;
    if (official.size && !official.has(code)) unmatched++;
    areas.push({ code, name: official.get(code) ?? fix(t.properties.TOWNNAME), level: 'town', parent: county.code });
  }
}
if (official.size) {
  const known = new Set(areas.map((a) => a.code));
  const extra = [...official.keys()].filter((c) => !known.has(c));
  console.log(`官方名稱 ${official.size} 筆；圖資中無對應 ${unmatched} 筆；官方多出 ${extra.length} 筆`, extra);
}

mkdirSync(new URL('../server/data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../server/data/areas.json', import.meta.url), JSON.stringify(areas, null, 0).replace(/\},\{/g, '},\n{') + '\n');

// --- 地圖：只保留代碼，簡化線條後重新建立拓撲 ---
const nameOf = new Map(areas.map((a) => [a.code, a.name]));
for (const g of countyGeoms) g.properties = { code: g.properties.COUNTYCODE };
for (const g of townGeoms) g.properties = { code: g.properties.TOWNCODE, county: g.properties.COUNTYCODE };
delete atlas.objects.nation;

const pre = presimplify(atlas);
const simplified = simplify(pre, quantile(pre, 0.22));
const counties = feature(simplified, simplified.objects.counties);
const towns = feature(simplified, simplified.objects.towns);
for (const f of [...counties.features, ...towns.features]) f.id = f.properties.code;
const out = topology({ counties, towns }, 1e5);

mkdirSync(new URL('../web/public/maps/', import.meta.url), { recursive: true });
const json = JSON.stringify(out);
writeFileSync(new URL('../web/public/maps/tw.json', import.meta.url), json);
console.log(`areas.json: ${areas.length} 筆（縣市 ${COUNTY_ORDER.length}、鄉鎮市區 ${areas.length - COUNTY_ORDER.length}）`);
console.log(`tw.json: ${(json.length / 1024).toFixed(0)} KB；範例名稱：${nameOf.get('63000')}、${nameOf.get('10014010')}`);
