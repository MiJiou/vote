export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const now = (): string => new Date().toISOString();

/** 比對用的名稱正規化：去空白、「台」一律視為「臺」。 */
export function normName(s: string): string {
  return s.replace(/\s+/g, '').replace(/台/g, '臺').toLowerCase();
}

/** 投開票所編號：純數字補滿 4 碼（1 → 0001），其餘原樣保留。 */
export function normStationNo(s: string): string {
  const t = s.trim();
  return /^\d{1,4}$/.test(t) ? t.padStart(4, '0') : t;
}

/**
 * 解析票數欄位。空字串回傳 null；允許千分位逗號與全形數字。
 * 不是非負整數時丟出錯誤。
 */
export function parseCount(raw: unknown, label: string): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0) throw new HttpError(400, `${label} 必須是 0 以上的整數`);
    return raw;
  }
  let s = String(raw).trim();
  if (s === '' || s === '-') return null;
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[,，\s]/g, '');
  if (/^\d+\.0+$/.test(s)) s = s.slice(0, s.indexOf('.'));
  if (!/^\d+$/.test(s)) throw new HttpError(400, `${label} 必須是 0 以上的整數（收到「${String(raw).slice(0, 20)}」）`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new HttpError(400, `${label} 數值過大`);
  return n;
}

/** RFC 4180 CSV 解析；自動處理 BOM，並在第一列沒有逗號但有 Tab 時改用 Tab 分隔（方便直接貼上 Excel 內容）。 */
export function parseCsv(input: string): string[][] {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delim = !firstLine.includes(',') && firstLine.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** 輸出 CSV；以 = + - @ 開頭的文字前面加上單引號，避免試算表把它當公式執行。 */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

export function asInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'bigint' ? Number(v) : (v as number);
}
