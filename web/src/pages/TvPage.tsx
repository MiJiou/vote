import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import { NATION, useLive, useStreamStatus } from '../api';
import type { Cand, ContestSummary, ElectionInfo, Summary, Totals } from '../api';
import { num, pct, ratio } from '../format';
import { TaiwanMap } from '../components/TaiwanMap';
import { leaderOf, progressOf, ranked } from '../components/results';
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

/** 新聞台常見的票數寫法：12 萬 2584。 */
function Wan({ n }: { n: number }) {
  if (n < 10000) {
    return (
      <span className="wan" aria-label={`${num(n)} 票`}>
        <span className="wan-major">{n}</span>
      </span>
    );
  }
  return (
    <span className="wan" aria-label={`${num(n)} 票`}>
      <span className="wan-major">{Math.floor(n / 10000)}</span>
      <span className="wan-unit">萬</span>
      <span className="wan-rest">{String(n % 10000).padStart(4, '0')}</span>
    </span>
  );
}

const PARTY_SHORT: [RegExp, string][] = [
  [/民主進步黨|民進黨/, '民'],
  [/中國國民黨|國民黨/, '國'],
  [/民眾黨/, '眾'],
  [/時代力量/, '時'],
  [/親民黨/, '親'],
  [/基進/, '基'],
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
        <img src={c.photo} alt={`${c.name}的照片`} />
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
          focus.map((c) => <FocusPanel key={c.id} contest={c} final={final} election={election} />)
        )}
        {!national && focus.length < 2 && <div />}
        <SidePanel summary={summary} national={national} />
      </div>
      <Headline summary={summary} national={national} />
      <div className="tv-strip" key={page}>
        {strip.map((item) => (
          <MiniPanel key={item.key} item={item} final={final} />
        ))}
      </div>
      <Footer summary={summary} items={items} />
    </>
  );
}

/** 一個選舉區的大版面：直排地名＋前兩名。 */
function FocusPanel({ contest, final, election }: { contest: ContestSummary; final: boolean; election: ElectionInfo }) {
  const t = contest.totals;
  const top = topOf(contest.candidates, t, 2);
  const others = contest.candidates.length - top.length;
  const p = progressOf(t, election.unitLevel);
  const lead = t.leaderId !== null && top.length > 1 ? (t.votes[top[0].id] ?? 0) - (t.votes[top[1].id] ?? 0) : null;
  return (
    <section className="tv-card tv-focus" aria-label={contest.name}>
      <Tab text={contest.areaName} />
      <div className="tv-focus-body">
        {top.map((c) => {
          const votes = t.votes[c.id] ?? 0;
          const winner = isWinner(c, t, final);
          return (
            <div key={c.id} className={`tv-row${t.leaderId === c.id ? ' is-lead' : ''}`} style={colorVar(c)}>
              <Portrait c={c} winner={winner} />
              <div className="tv-row-main">
                <div className="tv-row-head">
                  <PartyBadge c={c} />
                  <span className={`tv-name${nameClass(c.name)}`}>{c.name}</span>
                </div>
                <div className={`tv-votes${votes >= 1_000_000 ? ' is-wide' : ''}`}>
                  <Wan n={votes} />
                </div>
                <div className="tv-meter">
                  <span className="tv-bar">
                    <span style={{ width: `${share(c, t)}%` }} />
                  </span>
                  <span className="tv-pct">{pct(votes, t.valid)}</span>
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
                <Wan n={votes} />
              </div>
              <div className="tv-meter">
                <span className="tv-bar">
                  <span style={{ width: `${share(c, t)}%` }} />
                </span>
                <span className="tv-pct">{pct(votes, t.valid)}</span>
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
        <ul className="tv-tally">
          {tally.map((t) => (
            <li key={t.label} style={{ ['--c' as string]: t.color }}>
              <span className="tv-party">{t.label}</span>
              <b>{t.count}</b>
            </li>
          ))}
        </ul>
      )}
      <div className="tv-progress">
        <span className="tv-bar">
          <span style={{ width: `${shareDone * 100}%` }} />
        </span>
        <p>{line}</p>
      </div>
    </section>
  );
}

function Headline({ summary, national }: { summary: Summary; national: boolean }) {
  const { election, contests } = summary;
  const tv = election.tv;
  if (tv.headline) return <div className={`tv-headline is-${tv.headlineStyle}`}>{tv.headline}</div>;
  // 沒有設定快訊時，自動帶出選舉名稱與進度。
  let text = election.name;
  if (election.status === 'final') text += '　開票完成';
  else if (national) {
    const p = progressOf(contests[0].totals, election.unitLevel);
    if (p.done > 0) text += `　開票進度 ${(p.share * 100).toFixed(1)}%`;
  }
  return <div className="tv-headline is-auto">{text}</div>;
}

/** 底部小卡：一個地區的前兩名。 */
function MiniPanel({ item, final }: { item: StripItem; final: boolean }) {
  const top = topOf(item.candidates, item.totals, 2);
  return (
    <section className="tv-card tv-mini" aria-label={item.title}>
      <Tab text={item.title} as="h3" />
      <div className="tv-mini-body">
        {top.map((c) => (
          <div key={c.id} className={`tv-mini-row${item.totals.valid === 0 ? ' is-empty' : ''}`} style={colorVar(c)}>
            <PartyBadge c={c} />
            <span className={`tv-name${nameClass(c.name)}`}>{c.name}</span>
            {item.whole && isWinner(c, item.totals, final) && <Stamp />}
            <span className="tv-mini-votes">
              <Wan n={item.totals.votes[c.id] ?? 0} />
            </span>
          </div>
        ))}
      </div>
    </section>
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
  const tick = useTick(6000);

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
      <time className="tv-clock">{clockFormat.format(now)}</time>
      <p className="tv-ticker" key={tick % lines.length}>
        {lines[tick % lines.length]}
      </p>
      <p className="tv-note">
        <span className={`tv-live${streaming ? ' is-on' : ''}`} aria-hidden="true" />
        非官方統計・正式結果以中選會公告為準
      </p>
    </footer>
  );
}
