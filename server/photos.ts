import { HttpError } from './util.ts';

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
