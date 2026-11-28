// 一次補齊「2026 直轄市長、縣市長選舉」81 位候選人的照片，彩色優先。不需要連網。
//
//   npm run photos:2026            補上還沒有照片的人：
//                                    1. 彩色照片 45 位（scripts/data/photos-2026-color/）
//                                       ・現任／前任立委 19 位：立法院官方照
//                                       ・其他 26 位：維基共享資源的自由授權照片
//                                       每張的作者與授權記在 credits.json，看板上會照實標示。
//                                    2. 其餘 36 位：中選會選舉公報的照片（scripts/data/photos-2026/，黑白）
//   npm run photos:2026 -- --all   全部換掉：有彩色照的用彩色，其他用公報照片
//   npm run photos:2026 -- --gray  全部換成公報的黑白照片（畫面風格一致）
//
// 照片都已裁成 4:5、480×600（看板相框的比例），每張不到 100 KB。
// 公報是黑白印刷，中選會選舉專區的候選人照片也是黑白的，所以中選會沒有彩色版本。
// 已經有照片的人不會被換掉（--all／--gray 除外），重複執行是安全的。
// 看板程式開著時也可以執行；新照片會在下一次票數更新時出現（或重開看板程式）。
import { readdirSync, readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createCtx } from '../server/domain.ts';
import type { Election } from '../server/domain.ts';
import { importPhotoFiles } from '../server/photos.ts';

const NAME = '2026 直轄市長、縣市長選舉';
const gray = process.argv.includes('--gray');
const overwrite = gray || process.argv.includes('--all');
const config = loadConfig();
const ctx = createCtx(openDb(config.dbPath), config);

const election = ctx.db.prepare('SELECT * FROM elections WHERE name = ?').get(NAME) as Election | undefined;
if (!election) {
  console.error(`找不到「${NAME}」。請先執行 npm run setup:2026。`);
  process.exit(1);
}
const folder = (name: string) => {
  const dir = new URL(`./data/${name}/`, import.meta.url);
  return readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((file) => ({ file, data: readFileSync(new URL(encodeURIComponent(file), dir)) }));
};

// 1. 彩色照片：每張照片的出處各不相同，逐張套用
let color = 0;
if (!gray) {
  const credits = JSON.parse(readFileSync(new URL('./data/photos-2026-color/credits.json', import.meta.url), 'utf8')) as Record<string, { credit: string }>;
  for (const f of folder('photos-2026-color')) {
    const credit = credits[f.file.normalize('NFC')]?.credit;
    if (!credit) {
      console.log(`  略過 ${f.file}：credits.json 裡沒有出處`);
      continue;
    }
    color += importPhotoFiles(ctx, election.id, [f], { credit, overwrite }).applied.length;
  }
}
// 2. 其餘的人用中選會選舉公報（黑白）。--all 時，剛套上彩色照的人不要再被蓋掉。
const colored = new Set(gray ? [] : Object.keys(JSON.parse(readFileSync(new URL('./data/photos-2026-color/credits.json', import.meta.url), 'utf8'))));
const bulletin = folder('photos-2026').filter((f) => !colored.has(f.file.normalize('NFC')));
const cec = importPhotoFiles(ctx, election.id, bulletin, { credit: '中選會選舉公報', overwrite });

const left = (ctx.db
  .prepare("SELECT k.number, k.name, c.area_code FROM candidates k JOIN contests c ON c.id = k.contest_id WHERE c.election_id = ? AND k.photo_version = ''")
  .all(election.id) as { number: number; name: string; area_code: string }[]).map((r) => `${ctx.areas.name(r.area_code)} ${r.number} 號 ${r.name}`);
ctx.db.close();

console.log(`\n「${NAME}」照片：`);
if (!gray) console.log(`  彩色（立法院官方照／維基共享資源）${color} 位`);
console.log(`  中選會選舉公報（黑白）${cec.applied.length} 位`);
if (cec.kept.length && !overwrite) console.log(`  原本已有照片、保留不動：${cec.kept.length} 位`);
if (left.length) console.log(`  仍沒有照片：${left.join('、')}`);
if (cec.unmatched.length) console.log(`  對不到候選人的檔案：${cec.unmatched.join('、')}`);
console.log('看板程式開著時，新照片會在下一次票數更新時出現；也可以重開看板程式。');
