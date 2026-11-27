// 自動駕駛：不需要有人顧著後台。
// 1. 到了排定時間，把選舉從「草稿」改成「開票中」（公開看板）。
// 2. 所有選舉區的投開票所都開完、並持續 10 分鐘沒有變動後，改成「開票完成」（看板標示當選）。
import type { Ctx, Election } from './domain.ts';
import { audit } from './domain.ts';
import { summaryJson } from './results.ts';

const DONE_HOLD_MS = 10 * 60_000;
const doneSince = new Map<number, number>();

type SummaryTotals = { done: boolean; stationsTotal: number | null };

/** 是否每個選舉區都已全部開出（而且有投開票所數，代表是中選會之類的完整資料，不是人工輸入的縣市總數）。 */
export function allCounted(ctx: Ctx, electionId: number): boolean {
  const s = JSON.parse(summaryJson(ctx, electionId, true)) as { contests: { candidates: unknown[]; totals: SummaryTotals }[] };
  const contests = s.contests.filter((c) => c.candidates.length);
  return contests.length > 0 && contests.every((c) => c.totals.done && c.totals.stationsTotal !== null);
}

export function runAutopilot(ctx: Ctx, now = Date.now()): string[] {
  const log: string[] = [];
  const due = ctx.db
    .prepare("SELECT * FROM elections WHERE status = 'draft' AND auto_live_at <> ''")
    .all() as Election[];
  for (const e of due) {
    if (Date.parse(e.auto_live_at) > now) continue;
    ctx.db.prepare("UPDATE elections SET status = 'live', auto_live_at = '' WHERE id = ?").run(e.id);
    audit(ctx, null, 'election.auto_live', { id: e.id, name: e.name });
    ctx.bus.bump(e.id);
    log.push(`「${e.name}」已依排定時間自動公開（開票中）`);
  }
  const live = ctx.db.prepare("SELECT * FROM elections WHERE status = 'live' AND auto_final = 1").all() as Election[];
  for (const e of live) {
    if (!allCounted(ctx, e.id)) {
      doneSince.delete(e.id);
      continue;
    }
    const since = doneSince.get(e.id) ?? now;
    doneSince.set(e.id, since);
    if (now - since < DONE_HOLD_MS) continue;
    ctx.db.prepare("UPDATE elections SET status = 'final' WHERE id = ?").run(e.id);
    doneSince.delete(e.id);
    audit(ctx, null, 'election.auto_final', { id: e.id, name: e.name });
    ctx.bus.bump(e.id);
    log.push(`「${e.name}」全部開完已滿 10 分鐘，自動改為開票完成`);
  }
  return log;
}
