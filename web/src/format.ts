const int = new Intl.NumberFormat('zh-TW');

export const num = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : int.format(n));

export function pct(part: number, whole: number, digits = 2): string {
  if (!whole) return '—';
  return ((part / whole) * 100).toFixed(digits) + '%';
}

export const ratio = (r: number | null, digits = 2): string => (r === null ? '—' : (r * 100).toFixed(digits) + '%');

const timeFmt = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });
const dateTimeFmt = new Intl.DateTimeFormat('zh-TW', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Taipei',
});

export const time = (iso: string | null | undefined): string => (iso ? timeFmt.format(new Date(iso)) : '—');
export const dateTime = (iso: string | null | undefined): string => (iso ? dateTimeFmt.format(new Date(iso)) : '—');

export function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${y} 年 ${m} 月 ${d} 日`;
}
