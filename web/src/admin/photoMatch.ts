// 依檔名把照片配對到候選人。純函式，沒有用到瀏覽器功能，方便測試。
//
// 支援的檔名（副檔名不拘，「台」「臺」通用，分隔符號可用 - _ 空白）：
//   臺北市-6.jpg、臺北6號.png、台北市_06.jpg   → 縣市＋號次
//   蔣萬安.jpg、臺北市-蔣萬安.jpg、6-蔣萬安.jpg → 姓名（同名時再用縣市區分）
//   3.jpg、3號.jpg                              → 只有一個選舉區時，直接用號次

export type MatchCandidate = { id: number; number: number; name: string; contestId: number; areaName: string };
export type FileMatch = { candidateId: number | null; reason: string };

const norm = (s: string) => s.normalize('NFC').replace(/台/g, '臺').replace(/[\s_\-－—–.。．、,，()（）[\]【】]+/g, '');

/** 「臺北市」也接受「臺北」；「新竹縣」接受「新竹縣」但不接受「新竹」（新竹市也叫新竹）。 */
function areaAliases(areaName: string, allAreas: string[]): string[] {
  const out = [norm(areaName)];
  const short = norm(areaName).replace(/[市縣]$/, '');
  const clash = allAreas.filter((a) => norm(a).replace(/[市縣]$/, '') === short).length > 1;
  if (short.length >= 2 && !clash) out.push(short);
  return out;
}

export function matchPhotoFile(fileName: string, candidates: MatchCandidate[]): FileMatch {
  const base = norm(fileName.replace(/\.[a-z0-9]+$/i, ''));
  if (!base) return { candidateId: null, reason: '檔名是空的' };
  const areas = [...new Set(candidates.map((c) => c.areaName))];
  const contests = new Set(candidates.map((c) => c.contestId));

  // 找出檔名裡提到的縣市（取最長的寫法，避免「新竹」吃掉「新竹市」）
  let area: string | null = null;
  let rest = base;
  let best = 0;
  for (const a of areas) {
    for (const alias of areaAliases(a, areas)) {
      if (alias.length > best && base.includes(alias)) {
        best = alias.length;
        area = a;
        rest = base.replace(alias, '');
      }
    }
  }
  const pool = area ? candidates.filter((c) => c.areaName === area) : candidates;

  // 1. 姓名
  const byName = pool.filter((c) => c.name && base.includes(norm(c.name)));
  if (byName.length === 1) return { candidateId: byName[0].id, reason: `姓名「${byName[0].name}」` };
  if (byName.length > 1) {
    const longest = Math.max(...byName.map((c) => norm(c.name).length));
    const top = byName.filter((c) => norm(c.name).length === longest);
    if (top.length === 1) return { candidateId: top[0].id, reason: `姓名「${top[0].name}」` };
    return { candidateId: null, reason: `有 ${top.length} 位同名候選人，請在檔名加上縣市` };
  }

  // 2. 號次
  const num = /^(?:第)?0*(\d{1,2})號?$/.exec(rest);
  if (num) {
    const n = Number(num[1]);
    if (!area && contests.size > 1) return { candidateId: null, reason: '有多個選舉區，檔名請加上縣市，例如「臺北市-6」' };
    const hit = pool.find((c) => c.number === n);
    if (hit) return { candidateId: hit.id, reason: `${area ? area + ' ' : ''}${n} 號` };
    return { candidateId: null, reason: `${area ?? '這個選舉區'}沒有 ${n} 號候選人` };
  }
  return { candidateId: null, reason: '無法從檔名判斷是哪位候選人' };
}
