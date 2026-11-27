import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import { NATION, useLive, useStreamStatus } from '../api';
import type { Cand, ContestSummary, ElectionInfo, Summary, Totals } from '../api';
import { num, pct, ratio } from '../format';
import { TaiwanMap } from '../components/TaiwanMap';
import { leaderOf, progressOf, ranked } from '../components/results';
import { reducedMotion, useChanged, useFlip } from '../motion';
import { FrozenContext, Odometer } from '../components/Odometer';
import './tv.css';

/**
 * 轉播版面：仿電視開票特別報導的 16:9 畫面，適合投影、電視牆或當作直播軟體的瀏覽器來源。
 * 整個舞台固定以 1920×1080 設計，再等比例縮放到視窗大小，所以任何螢幕上的構圖都一樣。
 */
const STAGE_W = 1920;
const STAGE_H = 1080;

export default function TvPage() {
  const id = Number(useParams().id);
  const { data, error } = useLive<Summary>(Number.isInteger(id) ? `/api/elections/${id}/summary` : null, id);
  const scale = useStageScale();
  useEffect(() => {
    document.title = data ? `${data.election.name}｜轉播版面` : '轉播版面';
    return () => void (document.title = '即時開票看板');
  }, [data]);
  return (
    <div className="tv-viewport">
      <div className="tv-stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        {data ? <Stage summary={data} /> : <div className="tv-message">{error || '載入中…'}</div>}
      </div>
      <Controls id={id} />
    </div>
  );
}

function useStageScale(): number {
  const fit = () => Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  const [scale, setScale] = useState(fit);
  useEffect(() => {
    const onResize = () => setScale(fit());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return scale;
}

/** 每隔一段時間 +1，用來驅動輪播。 */
function useTick(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

/** 滑鼠動一下才出現的小按鈕，轉播時不會擋到畫面。 */
function Controls({ id }: { id: number }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let timer = setTimeout(() => setVisible(false), 3500);
    const show = () => {
      setVisible(true);
      clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), 3500);
    };
    window.addEventListener('pointermove', show);
    window.addEventListener('keydown', show);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', show);
      window.removeEventListener('keydown', show);
    };
  }, []);
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  };
  return (
    <div className={`tv-controls${visible ? '' : ' is-hidden'}`}>
      <button onClick={fullscreen}>全螢幕</button>
      <Link to={`/e/${id}?detail=1`}>詳細看板</Link>
    </div>
  );
}

// ---------- 小元件 ----------

/**
 * 新聞台常見的票數寫法：12 萬 2584。每一位數字都是滾輪，數字改變時滾到新的值；
 * countUp 時第一次出現會從 0 滾上來。
 */
function Wan({ n, countUp = false }: { n: number; countUp?: boolean }) {
  // 票數更新時整個數字發光一下
  const cls = `wan${useChanged(n, 1200) ? ' is-bump' : ''}`;
  if (n < 10000) {
    return (
      <span className={cls} aria-label={`${num(n)} 票`}>
        <Odometer className="wan-major" text={String(n)} rollIn={countUp} />
      </span>
    );
  }
  return (
    <span className={cls} aria-label={`${num(n)} 票`}>
      <Odometer className="wan-major" text={String(Math.floor(n / 10000))} rollIn={countUp} spin={0} />
      <span className="wan-unit">萬</span>
      <Odometer className="wan-rest" text={String(n % 10000).padStart(4, '0')} rollIn={countUp} />
    </span>
  );
}

/** 票數增加時，在數字上方飄出「+1,234」（第一次出現、票數沒增加時不顯示）。 */
function VoteDelta({ n }: { n: number }) {
  const prev = useRef(n);
  const [pop, setPop] = useState<{ diff: number; key: number } | null>(null);
  useEffect(() => {
    const diff = n - prev.current;
    prev.current = n;
    if (diff <= 0 || reducedMotion()) return;
    setPop((p) => ({ diff, key: (p?.key ?? 0) + 1 }));
    const t = setTimeout(() => setPop(null), 2400);
    return () => clearTimeout(t);
  }, [n]);
  if (!pop) return null;
  return (
    <span key={pop.key} className="tv-delta" aria-hidden="true">
      +{num(pop.diff)}
    </span>
  );
}

/** 得票率也是滾輪。 */
function Pct({ votes, valid }: { votes: number; valid: number }) {
  if (!valid) return <span className="tv-pct">—</span>;
  return (
    <span className="tv-pct">
      <Odometer text={((votes / valid) * 100).toFixed(2)} rollIn />%
    </span>
  );
}

/**
 * 電視台式的推移轉場：內容換了（id 改變）時，舊的畫面留下來播放離場動畫，新的同時進場。
 * 離場的畫面是凍結的快照，裡面的數字不會再從 0 滾起。
 */
function Swap({ id, children, className, ms = 800 }: { id: string; children: ReactNode; className?: string; ms?: number }) {
  const current = useRef({ id, node: children });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [leaving, setLeaving] = useState<{ id: string; node: ReactNode } | null>(null);
  useLayoutEffect(() => {
    if (current.current.id !== id) {
      setLeaving(current.current);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setLeaving(null), ms);
    }
    current.current = { id, node: children };
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className={`tv-swap${className ? ` ${className}` : ''}`}>
      {leaving && (
        <div className="tv-swap-out" key={`out-${leaving.id}`} aria-hidden="true">
          <FrozenContext.Provider value={true}>{leaving.node}</FrozenContext.Provider>
        </div>
      )}
      <div className="tv-swap-in" key={`in-${id}`}>
        {children}
      </div>
    </div>
  );
}

const PARTY_SHORT: [RegExp, string][] = [
  [/民主進步黨|民進黨/, '民'],
  [/中國國民黨|國民黨/, '國'],
  [/民眾黨/, '眾'],
  [/時代力量/, '時'],
  [/親民黨/, '親'],
  [/基進/, '基'],
  [/台灣團結聯盟|臺灣團結聯盟|台聯/, '聯'],
];
const isIndependent = (party: string) => !party.trim() || /無黨籍|未經政黨推薦/.test(party);

function partyShort(party: string): string {
  if (isIndependent(party)) return '無';
  for (const [re, short] of PARTY_SHORT) if (re.test(party)) return short;
  return party.replace(/^(台灣|臺灣|中華|中國)/, '').charAt(0) || party.charAt(0);
}

function PartyBadge({ c }: { c: Cand }) {
  return (
    <span className="tv-party" title={c.party || '無黨籍'}>
      {partyShort(c.party)}
    </span>
  );
}

function Portrait({ c, winner }: { c: Cand; winner: boolean }) {
  return (
    <div className="tv-photo">
      {c.photo ? (
        <>
          <img src={c.photo} alt={`${c.name}的照片`} />
          {c.photoCredit && <span className="tv-photo-credit">{c.photoCredit}</span>}
        </>
      ) : (
        <svg viewBox="0 0 100 120" aria-hidden="true" className="tv-silhouette">
          <circle cx="50" cy="44" r="21" />
          <path d="M10 120c0-28 17-44 40-44s40 16 40 44z" />
        </svg>
      )}
      <span className="tv-photo-no">{c.number}</span>
      {winner && <Stamp />}
    </div>
  );
}

/**
 * 直排地名。不用 CSS 的直書模式，而是一個字一行往下排：
 * 有些電腦上的中文字型缺少直排所需的資訊，直書模式會讓字全部疊在一起。
 */
function Tab({ text, as: Tag = 'h2' }: { text: string; as?: 'h2' | 'h3' }) {
  const chars = [...text];
  return (
    <Tag className="tv-tab" aria-label={text} style={chars.length > 4 ? { fontSize: `${(4 / chars.length) * 100}%` } : undefined}>
      <span className="tv-tab-text" aria-hidden="true">
        {chars.map((ch, i) => (
          <span key={i}>{ch}</span>
        ))}
      </span>
    </Tag>
  );
}

function Stamp() {
  return (
    <span className="tv-stamp" role="img" aria-label="當選">
      <span>當選</span>
    </span>
  );
}

const colorVar = (c: Cand): CSSProperties => ({ ['--c' as string]: c.color });
/** 名字越長字越小：4 個字、5–6 個字、7 個字以上各一級，免得被截斷。 */
const nameClass = (name: string) => (name.length > 6 ? ' len-7' : name.length > 4 ? ' len-5' : name.length === 4 ? ' len-4' : '');
const share = (c: Cand, t: Totals) => (t.valid ? ((t.votes[c.id] ?? 0) / t.valid) * 100 : 0);

/**
 * 版面上要秀的前幾名。還沒有票的時候依主要政黨、號次排，
 * 免得十幾位候選人的選舉區一開始秀出的是號次最前面的兩位。
 */
function topOf(candidates: Cand[], totals: Totals, count: number): Cand[] {
  if (totals.valid > 0) return ranked(candidates, totals).slice(0, count);
  const major = (c: Cand) => (/民主進步黨|中國國民黨|民眾黨/.test(c.party) ? 0 : isIndependent(c.party) ? 2 : 1);
  return [...candidates].sort((a, b) => major(a) - major(b) || a.number - b.number).slice(0, count);
}

/** 整個選舉區的當選者：管理員宣布當選，或選舉已標為開票完成的最高票。 */
const isWinner = (c: Cand, totals: Totals, final: boolean) => c.declared || (final && totals.leaderId === c.id);

// ---------- 舞台 ----------

type StripItem = { key: string; title: string; candidates: Cand[]; totals: Totals; whole: boolean };

function Stage({ summary }: { summary: Summary }) {
  const { election, contests } = summary;
  const tv = election.tv;
  const final = election.status === 'final';
  const ready = contests.filter((c) => c.candidates.length > 0);
  const national = contests.length === 1 && contests[0].areaCode === NATION;
  const tick = useTick(tv.rotateSeconds * 1000);

  if (!ready.length) return <div className="tv-message">尚未設定候選人</div>;

  // 底部輪播：全國性選舉輪播各縣市，多選舉區則輪播各選舉區。
  const items: StripItem[] = national
    ? (ready[0].children ?? []).map((r) => ({ key: r.code, title: r.name, candidates: ready[0].candidates, totals: r.totals, whole: false }))
    : ready.map((c) => ({ key: String(c.id), title: c.areaName, candidates: c.candidates, totals: c.totals, whole: true }));
  const pages = Math.max(1, Math.ceil(items.length / 4));
  const page = tick % pages;
  const strip = items.slice(page * 4, page * 4 + 4);

  // 大版面：管理員指定的選舉區優先，其餘自動輪播（每兩頁小卡換一次）。
  const pinned = tv.focus.map((id) => ready.find((c) => c.id === id)).filter((c): c is ContestSummary => !!c);
  const rest = ready.filter((c) => !pinned.includes(c));
  const turn = Math.floor(tick / 2);
  const focus = [...pinned];
  for (let i = 0; focus.length < Math.min(2, ready.length) && i < rest.length; i++) {
    focus.push(rest[(turn * (2 - pinned.length) + i) % rest.length]);
  }

  return (
    <>
      <div className="tv-top">
        {national ? (
          <NationalPanel contest={ready[0]} final={final} />
        ) : (
          [0, 1].map((slot) =>
            focus[slot] ? (
              <Swap key={slot} id={String(focus[slot].id)} className="tv-swap-panel">
                <FocusPanel contest={focus[slot]} final={final} election={election} index={slot} />
              </Swap>
            ) : (
              <div key={slot} />
            ),
          )
        )}
        <SidePanel summary={summary} national={national} />
      </div>
      <Swap id={tv.headline || 'auto'} className="tv-swap-headline" ms={700}>
        <Headline summary={summary} national={national} />
      </Swap>
      <Swap id={String(page)} className="tv-swap-strip" ms={900}>
        <div className="tv-strip">
          {strip.map((item, i) => (
            <MiniPanel key={item.key} item={item} final={final} index={i} />
          ))}
        </div>
      </Swap>
      <Footer summary={summary} items={items} />
    </>
  );
}

/** 一個選舉區的大版面：直排地名＋前兩名。 */
function FocusPanel({ contest, final, election, index }: { contest: ContestSummary; final: boolean; election: ElectionInfo; index: number }) {
  const t = contest.totals;
  const top = topOf(contest.candidates, t, 2);
  const others = contest.candidates.length - top.length;
  const p = progressOf(t, election.unitLevel);
  const lead = t.leaderId !== null && top.length > 1 ? (t.votes[top[0].id] ?? 0) - (t.votes[top[1].id] ?? 0) : null;
  const body = useRef<HTMLDivElement>(null);
  useFlip(body, top.map((c) => c.id).join(','));
  const swapped = useLeadSwap(t.leaderId);
  return (
    <section className="tv-card tv-focus" aria-label={contest.name} style={{ ['--delay' as string]: `${index * 140}ms` }}>
      <Tab text={contest.areaName} />
      <div className="tv-focus-body" ref={body}>
        {swapped && <div className="tv-flash" role="status">領先易位</div>}
        {top.map((c) => {
          const votes = t.votes[c.id] ?? 0;
          const winner = isWinner(c, t, final);
          return (
            <div key={c.id} data-flip={c.id} className={`tv-row${t.leaderId === c.id ? ' is-lead' : ''}`} style={colorVar(c)}>
              <Portrait c={c} winner={winner} />
              <div className="tv-row-main">
                <div className="tv-row-head">
                  <PartyBadge c={c} />
                  <span className={`tv-name${nameClass(c.name)}`}>{c.name}</span>
                </div>
                <div className={`tv-votes${votes >= 1_000_000 ? ' is-wide' : ''}`}>
                  <Wan n={votes} countUp />
                  <VoteDelta n={votes} />
                </div>
                <div className="tv-meter">
                  <span className="tv-bar">
                    <span style={{ width: `${share(c, t)}%` }} />
                  </span>
                  <Pct votes={votes} valid={t.valid} />
                </div>
              </div>
            </div>
          );
        })}
        <p className="tv-focus-foot">
          <span>
            {t.done ? (final ? '開票完成' : t.stationsTotal !== null ? '已全部開出' : '已回報') : t.valid ? `已開出 ${num(p.done)} / ${num(p.total)} ${p.label}` : '尚未開出'}
          </span>
          {lead !== null && lead > 0 && <span>領先 {num(lead)} 票</span>}
          {others > 0 && <span>另有 {others} 位候選人</span>}
        </p>
      </div>
    </section>
  );
}

/** 全國單一選舉區（總統大選）：各組候選人並排。 */
function NationalPanel({ contest, final }: { contest: ContestSummary; final: boolean }) {
  const t = contest.totals;
  // 位置跟著候選人（號次）不跟著名次，數字跳動時版面不會左右互換。
  const shown = new Set(topOf(contest.candidates, t, 4).map((c) => c.id));
  const cols = contest.candidates.filter((c) => shown.has(c.id));
  const order = ranked(contest.candidates, t);
  const lead = t.leaderId !== null && order.length > 1 ? (t.votes[order[0].id] ?? 0) - (t.votes[order[1].id] ?? 0) : null;
  return (
    <section className="tv-card tv-focus tv-national" aria-label={contest.name}>
      <Tab text="全國" />
      <div className={`tv-cols is-${cols.length}`}>
        {cols.map((c) => {
          const votes = t.votes[c.id] ?? 0;
          const leading = t.leaderId === c.id;
          return (
            <div key={c.id} className={`tv-col${leading ? ' is-lead' : ''}`} style={colorVar(c)}>
              <div className="tv-col-head">
                <Portrait c={c} winner={isWinner(c, t, final)} />
                <div className="tv-col-who">
                  <PartyBadge c={c} />
                  <span className={`tv-name${nameClass(c.name)}`}>{c.name}</span>
                  {c.runningMate && <span className="tv-mate">{c.runningMate}</span>}
                </div>
              </div>
              <div className="tv-votes">
                <Wan n={votes} countUp />
                <VoteDelta n={votes} />
              </div>
              <div className="tv-meter">
                <span className="tv-bar">
                  <span style={{ width: `${share(c, t)}%` }} />
                </span>
                <Pct votes={votes} valid={t.valid} />
              </div>
              <p className="tv-col-foot">{leading && lead !== null && lead > 0 ? `領先 ${num(lead)} 票` : ' '}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** 右側：全國地圖＋整體進度。 */
function SidePanel({ summary, national }: { summary: Summary; national: boolean }) {
  const { election, contests } = summary;
  const final = election.status === 'final';
  const first = contests[0];
  const byCounty = useMemo(() => {
    const map = new Map<string, { name: string; color: string | null }>();
    if (national) {
      const cands = new Map(first.candidates.map((c) => [c.id, c]));
      for (const row of first.children ?? []) map.set(row.code, { name: row.name, color: row.totals.leaderId !== null ? (cands.get(row.totals.leaderId)?.color ?? null) : null });
    } else {
      for (const c of contests) map.set(c.areaCode, { name: c.areaName, color: leaderOf(c.candidates, c.totals)?.color ?? null });
    }
    return map;
  }, [summary]); // eslint-disable-line react-hooks/exhaustive-deps

  // 整體進度：全國性選舉看投開票所／統計單位，多選舉區看幾個選舉區已經開完。
  let line: string;
  let shareDone: number;
  if (national) {
    const p = progressOf(first.totals, election.unitLevel);
    line = `已開出 ${num(p.done)} / ${num(p.total)} ${p.label}`;
    shareDone = p.share;
  } else {
    const withData = contests.filter((c) => c.totals.valid > 0).length;
    const done = contests.filter((c) => c.totals.done).length;
    line = final ? `${contests.length} 縣市開票完成` : `${withData} / ${contests.length} 縣市已有票數　${done} 縣市已開完`;
    shareDone = contests.length ? done / contests.length : 0;
  }
  const tally = useMemo(() => {
    if (national) return [];
    const m = new Map<string, { label: string; color: string; count: number }>();
    for (const c of contests) {
      const lead = leaderOf(c.candidates, c.totals);
      if (!lead) continue;
      const label = partyShort(lead.party);
      const hit = m.get(label);
      if (hit) hit.count++;
      else m.set(label, { label, color: lead.color, count: 1 });
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [summary]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="tv-card tv-side" aria-label="全國概況">
      <h2 className="tv-side-title">{national ? '各縣市領先' : final ? '各縣市當選' : '各縣市領先'}</h2>
      <div className="tv-map">
        <TaiwanMap
          ariaLabel="各縣市領先地圖"
          only={national ? undefined : new Set(contests.map((c) => c.areaCode))}
          fill={(code) => byCounty.get(code)?.color ?? null}
          name={(code) => byCounty.get(code)?.name ?? code}
          tooltip={() => null}
        />
      </div>
      {tally.length > 0 && (
        <ul className={`tv-tally${tally.length > 4 ? ' is-many' : ''}`}>
          {tally.map((t) => (
            <li key={t.label} style={{ ['--c' as string]: t.color }}>
              <span className="tv-party">{t.label}</span>
              <b>{t.count}</b>
            </li>
          ))}
        </ul>
      )}
      <div className={`tv-progress${shareDone > 0 && shareDone < 1 && !final ? ' is-running' : ''}`}>
        <span className="tv-bar">
          <span style={{ width: `${shareDone * 100}%` }} />
        </span>
        <p>{line}</p>
      </div>
    </section>
  );
}

/** 每秒更新一次的目前時間。 */
function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 整體開票進度（0–1）：知道投開票所數就用投開票所，否則用已回報的統計單位。 */
function overallShare(summary: Summary): number {
  let counted = 0;
  let total = 0;
  let units = 0;
  let unitsTotal = 0;
  let stationsKnown = true;
  for (const c of summary.contests) {
    const t = c.totals;
    units += t.unitsReported;
    unitsTotal += t.unitsTotal;
    if (t.stationsTotal === null || t.stationsCounted === null) stationsKnown = false;
    else {
      counted += t.stationsCounted;
      total += t.stationsTotal;
    }
  }
  if (stationsKnown && total > 0) return counted / total;
  return unitsTotal ? units / unitsTotal : 0;
}

/** 快訊橫幅左側的白框：投票結束前倒數，開票後顯示整體進度。 */
function HeadlineBox({ summary }: { summary: Summary }) {
  const now = useNow();
  const { election } = summary;
  const close = new Date(`${election.date}T16:00:00+08:00`).getTime();
  if (election.status === 'final') {
    return (
      <span className="tv-headline-box">
        <span className="tv-hb-label">開票</span>
        <span className="tv-hb-value">完成</span>
      </span>
    );
  }
  const left = Math.floor((close - now.getTime()) / 1000);
  if (left > 0) {
    const days = Math.floor(left / 86400);
    const value = days > 0 ? `${days} 天` : `${pad2(Math.floor(left / 3600))}:${pad2(Math.floor((left % 3600) / 60))}:${pad2(left % 60)}`;
    return (
      <span className="tv-headline-box">
        <span className="tv-hb-label">開票倒數</span>
        <span className="tv-hb-value">{value}</span>
      </span>
    );
  }
  return (
    <span className="tv-headline-box">
      <span className="tv-hb-label">開票進度</span>
      <span className="tv-hb-value">
        <Odometer text={(overallShare(summary) * 100).toFixed(1)} />%
      </span>
    </span>
  );
}

function Headline({ summary }: { summary: Summary; national: boolean }) {
  const { election } = summary;
  const tv = election.tv;
  if (tv.headline) {
    return (
      <div className={`tv-headline is-${tv.headlineStyle}`}>
        <HeadlineBox summary={summary} />
        <span className="tv-headline-text">
          {tv.headlineStyle === 'alert' && <span className="tv-headline-chip">快訊</span>}
          {tv.headline}
        </span>
      </div>
    );
  }
  // 沒有設定快訊時，深藍底黃字顯示選舉名稱。
  return (
    <div className="tv-headline is-auto">
      <HeadlineBox summary={summary} />
      <span className="tv-headline-text">{election.status === 'final' ? `${election.name}　開票完成` : election.name}</span>
    </div>
  );
}

/** 底部小卡：一個地區的前兩名。 */
function MiniPanel({ item, final, index }: { item: StripItem; final: boolean; index: number }) {
  const top = topOf(item.candidates, item.totals, 2);
  return (
    <section className="tv-card tv-mini" aria-label={item.title} style={{ ['--i' as string]: index }}>
      <Tab text={item.title} as="h3" />
      <div className="tv-mini-body">
        {top.map((c) => (
          <div key={c.id} className={`tv-mini-row${item.totals.valid === 0 ? ' is-empty' : ''}`} style={colorVar(c)} title={c.party || '無黨籍'}>
            <span className="tv-mini-no">{c.number}</span>
            <span className={`tv-name${nameClass(c.name)}`}>{c.name}</span>
            {item.whole && isWinner(c, item.totals, final) && <Stamp />}
            <span className="tv-mini-votes">
              <Wan n={item.totals.votes[c.id] ?? 0} countUp />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 領先者換人（不是第一次顯示）時，回傳 true 約 3 秒。 */
function useLeadSwap(leaderId: number | null): boolean {
  const prev = useRef(leaderId);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const before = prev.current;
    prev.current = leaderId;
    if (before === null || leaderId === null || before === leaderId) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), 3200);
    return () => clearTimeout(t);
  }, [leaderId]);
  return on;
}

/**
 * 底部跑馬燈：連續捲動。每一輪只捲幾則（約 1 分鐘），捲完才換下一批並帶入最新數字，
 * 畫面不會跳動，數字也不會落後太久。
 */
const TICKER_BATCH = 5;
function Ticker({ lines }: { lines: string[] }) {
  const latest = useRef(lines);
  latest.current = lines;
  const [batch, setBatch] = useState(0);
  const [shown, setShown] = useState(() => lines.slice(0, TICKER_BATCH));
  const next = () => {
    const all = latest.current;
    const batches = Math.max(1, Math.ceil(all.length / TICKER_BATCH));
    const b = (batch + 1) % batches;
    setBatch(b);
    setShown(all.slice(b * TICKER_BATCH, b * TICKER_BATCH + TICKER_BATCH));
  };
  const text = shown.join('　｜　');
  // 固定的閱讀速度：每個字約 0.3 秒。
  const seconds = Math.max(18, Math.round(text.length * 0.3));
  return (
    <p className="tv-ticker">
      <span className="tv-ticker-track" style={{ animationDuration: `${seconds}s` }} onAnimationIteration={next}>
        {text}
      </span>
    </p>
  );
}

const clockFormat = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });

function Footer({ summary, items }: { summary: Summary; items: StripItem[] }) {
  const streaming = useStreamStatus();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  // 跑馬資訊：整體數字＋各地區前兩名，一次一則輪流出現。
  const lines = useMemo(() => {
    const out: string[] = [];
    const { contests } = summary;
    if (contests.length === 1 && contests[0].areaCode === NATION) {
      const t = contests[0].totals;
      if (t.valid) out.push(`全國　有效票 ${num(t.valid)}　無效票 ${num(t.invalid)}${t.turnout !== null ? `　投票率 ${ratio(t.turnout)}` : ''}`);
    }
    for (const item of items) {
      if (!item.totals.valid) continue;
      const top = topOf(item.candidates, item.totals, 2);
      out.push(`${item.title}　` + top.map((c) => `${c.name} ${num(item.totals.votes[c.id] ?? 0)} 票（${pct(item.totals.votes[c.id] ?? 0, item.totals.valid, 1)}）`).join('　'));
    }
    if (!out.length) out.push(summary.election.name);
    return out;
  }, [summary, items]);

  return (
    <footer className="tv-footer">
      <div className="tv-clockbox">
        {summary.election.status === 'live' && (
          <span className={`tv-livebadge${streaming ? '' : ' is-off'}`}>
            <span className="tv-livebadge-dot" aria-hidden="true" />
            LIVE
          </span>
        )}
        <time className="tv-clock">{clockFormat.format(now)}</time>
      </div>
      <Ticker lines={lines} />
      <p className="tv-note">
        <span className={`tv-live${streaming ? ' is-on' : ''}`} aria-hidden="true" />
        非官方統計・正式結果以中選會公告為準
      </p>
    </footer>
  );
}
