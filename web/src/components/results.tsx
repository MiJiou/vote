import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AreaRow, Cand, ElectionInfo, Totals } from '../api';
import { num, pct, ratio } from '../format';

export const OTHER_COLOR = '#8A8983';

export function Swatch({ color }: { color: string }) {
  return <span className="swatch" style={{ background: color }} aria-hidden="true" />;
}

/** 依得票排序（尚無票數時依號次）。 */
export function ranked(candidates: Cand[], totals: Totals): Cand[] {
  return [...candidates].sort((a, b) => (totals.votes[a.id] ?? 0) - (totals.votes[b.id] ?? 0) || b.number - a.number).reverse();
}

export function leaderOf(candidates: Cand[], totals: Totals): Cand | null {
  return candidates.find((c) => c.id === totals.leaderId) ?? null;
}

/** 領先者與第二名的票數差距。 */
export function margin(candidates: Cand[], totals: Totals): number | null {
  if (totals.leaderId === null || candidates.length < 2) return null;
  const order = ranked(candidates, totals);
  return (totals.votes[order[0].id] ?? 0) - (totals.votes[order[1].id] ?? 0);
}

export function StatusBadge({ status }: { status: ElectionInfo['status'] }) {
  if (status === 'live') {
    return (
      <span className="badge badge-live">
        <span className="pulse" aria-hidden="true" />
        開票中
      </span>
    );
  }
  if (status === 'final') return <span className="badge badge-final">✓ 開票完成</span>;
  return <span className="badge">草稿（未公開）</span>;
}

/**
 * 領先／當選標記。只有整個選舉區、且選舉已標為「開票完成」才顯示「當選」，避免開票途中誤報；
 * 選舉區底下的個別地區（例如總統大選裡的某個縣市）只會顯示「領先」或「最高票」。
 */
export type LeadKind = 'win' | 'lead' | 'top';
export function LeadTag({ kind }: { kind: LeadKind }) {
  return <span className={`tag ${kind === 'win' ? 'tag-win' : 'tag-lead'}`}>{kind === 'win' ? '當選' : kind === 'lead' ? '領先' : '最高票'}</span>;
}

// ---------- 候選人得票卡（總統大選主畫面）----------

export function CandidateCards({ candidates, totals, lead: kind }: { candidates: Cand[]; totals: Totals; lead: LeadKind }) {
  const lead = margin(candidates, totals);
  return (
    <ul className="cards" style={{ ['--n' as string]: Math.min(candidates.length, 4) }}>
      {candidates.map((c) => {
        const votes = totals.votes[c.id] ?? 0;
        const leading = totals.leaderId === c.id;
        return (
          <li key={c.id} className={`card cand-card${leading ? ' is-leading' : ''}`}>
            <span className="cand-stripe" style={{ background: c.color }} aria-hidden="true" />
            <div className="cand-head">
              <span className="cand-no">{c.number}</span>
              <span className="cand-party">{c.party || '—'}</span>
              {(c.declared || leading) && <LeadTag kind={c.declared ? 'win' : kind} />}
            </div>
            <div className="cand-name">
              {c.name}
              {c.runningMate && <span className="cand-mate">{c.runningMate}</span>}
            </div>
            <div className="cand-figures">
              <span className="cand-votes">{num(votes)}</span>
              <span className="cand-unit">票</span>
              <span className="cand-pct">{pct(votes, totals.valid)}</span>
            </div>
            {leading && lead !== null && lead > 0 && <div className="cand-margin">領先第二名 {num(lead)} 票</div>}
          </li>
        );
      })}
    </ul>
  );
}

// ---------- 得票率長條（一個整體分成幾塊）----------

type Segment = { key: string; label: string; color: string; value: number };

function segmentsOf(candidates: Cand[], totals: Totals, max: number, byRank: boolean): Segment[] {
  const toSeg = (c: Cand): Segment => ({ key: String(c.id), label: `${c.number} 號 ${c.name}`, color: c.color, value: totals.votes[c.id] ?? 0 });
  const order = byRank ? ranked(candidates, totals) : candidates;
  if (order.length <= max) return order.map(toSeg);
  // 候選人太多時只留得票最高的幾位，其餘合併成「其他」。
  const top = new Set(ranked(candidates, totals).slice(0, max - 1).map((c) => c.id));
  const shown = order.filter((c) => top.has(c.id));
  const rest = candidates.filter((c) => !top.has(c.id));
  return [
    ...shown.map(toSeg),
    { key: 'other', label: `其他 ${rest.length} 位`, color: OTHER_COLOR, value: rest.reduce((s, c) => s + (totals.votes[c.id] ?? 0), 0) },
  ];
}

export function ShareBar({ candidates, totals, thin = false, byRank = false }: { candidates: Cand[]; totals: Totals; thin?: boolean; byRank?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState<Segment | null>(null);
  useEffect(() => {
    if (thin || !ref.current) return;
    const el = ref.current;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [thin]);

  const segs = segmentsOf(candidates, totals, thin ? 4 : 6, byRank).filter((s) => s.value > 0);
  const summary = segs.map((s) => `${s.label} ${pct(s.value, totals.valid)}`).join('、');
  if (!totals.valid) return <div className={`sharebar ${thin ? 'is-thin' : ''} is-empty`} role="img" aria-label="尚無票數" />;
  return (
    <div className="sharebar-wrap">
      <div className={`sharebar ${thin ? 'is-thin' : ''}`} ref={ref} role="img" aria-label={`得票率：${summary}`}>
        {segs.map((s) => {
          const share = s.value / totals.valid;
          // 只有放得下才把百分比印在色塊裡，放不下就交給圖例與表格。
          const fits = !thin && share * width >= 58;
          return (
            <span
              key={s.key}
              className="seg"
              style={{ flexGrow: s.value, background: s.color }}
              onPointerEnter={() => setTip(s)}
              onPointerLeave={() => setTip(null)}
            >
              {fits && <span className="seg-label">{pct(s.value, totals.valid, 1)}</span>}
            </span>
          );
        })}
      </div>
      {tip && !thin && (
        <div className="tooltip tooltip-static" role="status">
          <strong>{pct(tip.value, totals.valid)}</strong> {tip.label}（{num(tip.value)} 票）
        </div>
      )}
    </div>
  );
}

// ---------- 候選人排行（下鑽頁、縣市長選舉區）----------

export function RankedRows({ candidates, totals, lead, whole }: { candidates: Cand[]; totals: Totals; lead: LeadKind; whole: boolean }) {
  const order = ranked(candidates, totals);
  const top = Math.max(1, ...order.map((c) => totals.votes[c.id] ?? 0));
  return (
    <ol className="ranked">
      {order.map((c) => {
        const votes = totals.votes[c.id] ?? 0;
        return (
          <li key={c.id} className="ranked-row">
            <div className="ranked-who">
              <Swatch color={c.color} />
              <span className="cand-no is-small">{c.number}</span>
              <span className="ranked-name">{c.name}</span>
              <span className="ranked-party">{c.party}</span>
              {/* 已宣布當選的候選人在整個選舉區的頁面直接標「當選」。 */}
              {whole && c.declared ? <LeadTag kind="win" /> : totals.leaderId === c.id && <LeadTag kind={lead} />}
            </div>
            <div className="ranked-bar" aria-hidden="true">
              <span style={{ width: `${(votes / top) * 100}%`, background: c.color }} />
            </div>
            <div className="ranked-figures">
              <span className="ranked-votes">{num(votes)}</span>
              <span className="ranked-pct">{pct(votes, totals.valid)}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- 開票進度與統計數字 ----------

const UNIT_NAME = { county: '縣市', town: '鄉鎮市區', station: '投開票所' } as const;

/** 開票進度：知道投開票所數就用投開票所算，否則用已回報的統計單位數。 */
export function progressOf(t: Totals, unitLevel: ElectionInfo['unitLevel']): { done: number; total: number; label: string; share: number } {
  if (t.stationsTotal !== null && t.stationsCounted !== null && t.stationsTotal > 0) {
    return { done: t.stationsCounted, total: t.stationsTotal, label: '投開票所', share: t.stationsCounted / t.stationsTotal };
  }
  return { done: t.unitsReported, total: t.unitsTotal, label: UNIT_NAME[unitLevel], share: t.unitsTotal ? t.unitsReported / t.unitsTotal : 0 };
}

/**
 * 「開完了」的說法：知道投開票所數才敢說「已全部開出」；
 * 只有縣市／鄉鎮總數時無從判斷是否開完，只說「已回報」，等選舉標為開票完成才說「開票完成」。
 */
export function doneLabel(totals: Totals, final: boolean): string {
  if (final) return '開票完成';
  return totals.stationsTotal !== null ? '已全部開出' : '已回報';
}

export function ProgressText({ totals, unitLevel, final }: { totals: Totals; unitLevel: ElectionInfo['unitLevel']; final: boolean }) {
  const p = progressOf(totals, unitLevel);
  if (totals.done) return <>{doneLabel(totals, final)}</>;
  if (!p.done) return <>尚未開出</>;
  return (
    <>
      {num(p.done)} / {num(p.total)}
    </>
  );
}

export function Stats({ totals, unitLevel }: { totals: Totals; unitLevel: ElectionInfo['unitLevel'] }) {
  const p = progressOf(totals, unitLevel);
  return (
    <div className="stats">
      <div className="card stat stat-progress">
        <div className="stat-label">開票進度（已開出的{p.label}）</div>
        <div className="stat-value">
          {num(p.done)}
          <span className="stat-of"> / {num(p.total)}</span>
          <span className="stat-side">{(p.share * 100).toFixed(1)}%</span>
        </div>
        <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-label="開票進度">
          <span style={{ width: `${p.share * 100}%` }} />
        </div>
      </div>
      <Stat label="投票數" value={num(totals.total)} />
      <Stat label="有效票" value={num(totals.valid)} />
      <Stat label="無效票" value={num(totals.invalid)} />
      <Stat label="投票率" value={ratio(totals.turnout)} hint={totals.turnout === null ? '確定開完的地區才計入' : totals.done ? undefined : '已開完的地區'} />
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

// ---------- 地圖提示框 ----------

export function AreaTooltip({ title, candidates, totals, final, note }: { title: string; candidates: Cand[]; totals: Totals | null; final: boolean; note?: ReactNode }) {
  if (!totals) return <div className="tip-title">{title}</div>;
  const order = ranked(candidates, totals).slice(0, 4);
  return (
    <>
      <div className="tip-title">
        {title}
        {totals.valid > 0 && totals.done && <span className="tip-done">{doneLabel(totals, final)}</span>}
      </div>
      {totals.valid === 0 ? (
        <div className="muted">尚未開出</div>
      ) : (
        <table className="tip-table">
          <tbody>
            {order.map((c) => (
              <tr key={c.id}>
                <td>
                  <span className="linekey" style={{ background: c.color }} aria-hidden="true" />
                </td>
                <td className="tip-num">{pct(totals.votes[c.id] ?? 0, totals.valid, 1)}</td>
                <td className="tip-num">{num(totals.votes[c.id] ?? 0)}</td>
                <td className="tip-name">{c.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {note}
    </>
  );
}

// ---------- 各區表格（地圖的表格版）----------

export function AreaTable({
  rows, candidates, linkOf, firstColumn, unitLevel, final,
}: {
  rows: AreaRow[];
  candidates: Cand[];
  linkOf: (row: AreaRow) => string | null;
  firstColumn: string;
  unitLevel: ElectionInfo['unitLevel'];
  final: boolean;
}) {
  const wide = candidates.length <= 4;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{firstColumn}</th>
            {wide ? (
              candidates.map((c) => (
                <th scope="col" key={c.id} className="num">
                  <span className="th-cand">
                    <Swatch color={c.color} />
                    {c.number} {c.name}
                  </span>
                </th>
              ))
            ) : (
              <>
                <th scope="col">領先</th>
                <th scope="col" className="num">得票</th>
                <th scope="col">次高</th>
                <th scope="col" className="num">得票</th>
              </>
            )}
            <th scope="col" className="num">投票數</th>
            <th scope="col" className="num">開票進度</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const t = row.totals;
            const link = linkOf(row);
            const order = ranked(candidates, t);
            return (
              <tr key={row.code}>
                <th scope="row">{link ? <Link to={link}>{row.name}</Link> : row.name}</th>
                {wide
                  ? candidates.map((c) => (
                      <td key={c.id} className={`num${t.leaderId === c.id ? ' is-lead' : ''}`}>
                        {t.valid ? (
                          <>
                            {num(t.votes[c.id] ?? 0)}
                            <span className="cell-pct">{pct(t.votes[c.id] ?? 0, t.valid, 1)}</span>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    ))
                  : [0, 1].map((i) => {
                      const c = t.valid ? order[i] : undefined;
                      return c ? (
                        [
                          <td key={`n${i}`}>
                            <span className="th-cand">
                              <Swatch color={c.color} />
                              {c.name}
                            </span>
                          </td>,
                          <td key={`v${i}`} className={`num${i === 0 ? ' is-lead' : ''}`}>
                            {num(t.votes[c.id] ?? 0)}
                            <span className="cell-pct">{pct(t.votes[c.id] ?? 0, t.valid, 1)}</span>
                          </td>,
                        ]
                      ) : (
                        [<td key={`n${i}`} className="muted">—</td>, <td key={`v${i}`} className="num muted">—</td>]
                      );
                    })}
                <td className="num">{t.total ? num(t.total) : <span className="muted">—</span>}</td>
                <td className="num">
                  <ProgressText totals={t} unitLevel={unitLevel} final={final} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
