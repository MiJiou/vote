// 把中選會選舉公報上的候選人照片，補給「2026 直轄市長、縣市長選舉」裡還沒有照片的候選人。
//
//   npm run photos:2026            只補還沒有照片的人（已經套用維基彩色照片的不動）
//   npm run photos:2026 -- --all   全部換成公報照片
//
// 照片在 scripts/data/photos-2026/，檔名是「縣市-號次.jpg」，
// 從中選會選舉公報（bulletin.cec.gov.tw，115 年直轄市長／縣市長）的 PDF 擷取，裁成 4:5、480×600。
// 公報是黑白印刷，所以這些照片多半是灰階的。看板上標示的出處是「中選會選舉公報」。
// 看板程式開著時也可以執行；新照片會在下一次票數更新時出現（或重開看板程式）。
import { readdirSync, readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createCtx } from '../server/domain.ts';
import type { Election } from '../server/domain.ts';
import { importPhotoFiles } from '../server/photos.ts';

const NAME = '2026 直轄市長、縣市長選舉';
const overwrite = process.argv.includes('--all');
const config = loadConfig();
const ctx = createCtx(openDb(config.dbPath), config);

const election = ctx.db.prepare('SELECT * FROM elections WHERE name = ?').get(NAME) as Election | undefined;
if (!election) {
  console.error(`找不到「${NAME}」。請先執行 npm run setup:2026。`);
  process.exit(1);
}
const dir = new URL('./data/photos-2026/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
  .map((file) => ({ file, data: readFileSync(new URL(encodeURIComponent(file), dir)) }));
const r = importPhotoFiles(ctx, election.id, files, { credit: '中選會選舉公報', overwrite });
ctx.db.close();

console.log(`\n「${NAME}」：套用公報照片 ${r.applied.length} 位${overwrite ? '' : `，原本已有照片而保留 ${r.kept.length} 位`}。`);
if (r.unmatched.length) console.log(`對不到候選人的檔案：${r.unmatched.join('、')}`);
console.log('看板程式開著時，新照片會在下一次票數更新時出現；也可以重開看板程式。');
