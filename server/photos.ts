import { HttpError } from './util.ts';
import { tx } from './db.ts';
import { audit } from './domain.ts';
import type { Ctx } from './domain.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 800 * 1024;

/**
 * 解析後台上傳的候選人照片（data URL）。
 * 只接受 JPEG／PNG／WebP，並檢查檔頭確實是該格式——不收 SVG 之類可以夾帶程式的格式。
 */
export function decodePhoto(dataUrl: unknown): { mime: string; data: Buffer } {
  if (typeof dataUrl !== 'string') throw new HttpError(400, '缺少照片');
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  if (!m) throw new HttpError(400, '照片格式需為 JPEG、PNG 或 WebP');
  const mime = m[1];
  const data = Buffer.from(m[2], 'base64');
  if (data.length > MAX_BYTES) throw new HttpError(413, '照片太大（上限 800 KB）');
  const valid =
    mime === 'image/jpeg' ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    : mime === 'image/png' ? data.subarray(0, 8).equals(PNG)
    : data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP';
  if (!valid) throw new HttpError(400, '檔案內容不是有效的圖片');
  return { mime, data };
}

/** 存入（或取代）候選人照片，回傳新的照片版本。 */
export function storePhoto(ctx: Ctx, candidateId: number, mime: string, data: Buffer, credit: string): string {
  const version = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  tx(ctx.db, () => {
    ctx.db
      .prepare('INSERT INTO candidate_photos (candidate_id, mime, data) VALUES (?, ?, ?) ON CONFLICT (candidate_id) DO UPDATE SET mime = excluded.mime, data = excluded.data')
      .run(candidateId, mime, data);
    ctx.db.prepare('UPDATE candidates SET photo_version = ?, photo_credit = ? WHERE id = ?').run(version, credit, candidateId);
  });
  return version;
}

const normArea = (s: string) => s.normalize('NFC').replace(/台/g, '臺').trim();

/**
 * 依檔名「縣市-號次.jpg」（例如「臺北市-6.jpg」）把一批照片套用到某場選舉的候選人。
 * 預設只補還沒有照片的候選人；overwrite 時一律取代。
 */
export function importPhotoFiles(
  ctx: Ctx,
  electionId: number,
  files: { file: string; data: Buffer }[],
  opts: { credit: string; overwrite?: boolean },
): { applied: string[]; kept: string[]; unmatched: string[] } {
  const rows = ctx.db
    .prepare('SELECT k.id, k.number, k.name, k.photo_version, c.area_code FROM candidates k JOIN contests c ON c.id = k.contest_id WHERE c.election_id = ?')
    .all(electionId) as { id: number; number: number; name: string; photo_version: string; area_code: string }[];
  const out = { applied: [] as string[], kept: [] as string[], unmatched: [] as string[] };
  for (const { file, data } of files) {
    const m = /^(.+?)[-_ ]0*(\d{1,2})\.(jpe?g|png|webp)$/i.exec(file.normalize('NFC'));
    const cand = m && rows.find((r) => r.number === Number(m[2]) && normArea(ctx.areas.name(r.area_code)) === normArea(m[1]));
    if (!m || !cand) {
      out.unmatched.push(file);
      continue;
    }
    const label = `${ctx.areas.name(cand.area_code)} ${cand.number} 號 ${cand.name}`;
    if (cand.photo_version && !opts.overwrite) {
      out.kept.push(label);
      continue;
    }
    const ext = m[3].toLowerCase();
    const mimeOf = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const { mime, data: checked } = decodePhoto(`data:${mimeOf};base64,${data.toString('base64')}`);
    storePhoto(ctx, cand.id, mime, checked, opts.credit);
    audit(ctx, null, 'candidate.photo', { name: cand.name, bytes: checked.length, credit: opts.credit, file });
    out.applied.push(label);
  }
  if (out.applied.length) ctx.bus.bump(electionId);
  return out;
}
