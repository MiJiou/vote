import { Suspense, lazy, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { NATION, api, useLive, useStreamStatus } from './api';
import type { AreaRow, Cand, ContestSummary, Drill, ElectionInfo, Summary, Totals } from './api';
import { dateLabel, num, pct, time } from './format';
import { TaiwanMap } from './components/TaiwanMap';
import {
  AreaTable, AreaTooltip, CandidateCards, LeadTag, OTHER_COLOR, ProgressText, RankedRows, ShareBar, Stats, StatusBadge, Swatch,
  doneLabel, leaderOf, progressOf, ranked,
} from './components/results';

const ReportPage = lazy(() => import('./pages/ReportPage'));
const AdminPage = lazy(() => import('./admin/AdminPage'));

export function App() {
  return (
    <Suspense fallback={<p className="page muted">載入中…</p>}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/e/:id" element={<ElectionPage />} />
        <Route path="/e/:id/c/:cid/a/:code" element={<AreaPage />} />
        <Route path="/report/*" element={<ReportPage />} />
        <Route path="/admin/*" element={<AdminPage />} />
        <Route path="*" element={<Shell><p className="empty">找不到這個頁面。<Link to="/">回首頁</Link></p></Shell>} />
      </Routes>
    </Suspense>
  );
}

// ---------- 版面 ----------

export function Shell({ children, election, updatedAt }: { children: ReactNode; election?: ElectionInfo; updatedAt?: string | null }) {
  const streaming = useStreamStatus();
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">✓</span>
          即時開票看板
        </Link>
        {election && (
          <div className="topbar-status">
            {election.status === 'live' && (
              <span className={`conn ${streaming ? 'is-on' : ''}`}>
                <span className="conn-dot" aria-hidden="true" />
                {streaming ? '即時更新中' : '重新連線中…'}
              </span>
            )}
            {updatedAt && <span className="muted">最後更新 {time(updatedAt)}</span>}
          </div>
        )}
      </header>
      <main className="page">{children}</main>
      <footer className="footer">
        <p>
          {election?.sourceNote ? `${election.sourceNote}。` : ''}
          本看板為非官方統計，正式結果以中央選舉委員會公告為準。
        </p>
        <p>
          <Link to="/report">票數回報</Link>
          <span aria-hidden="true"> · </span>
          <Link to="/admin">管理後台</Link>
        </p>
      </footer>
    </div>
  );
}

function ElectionHeader({ election, crumbs }: { election: ElectionInfo; crumbs?: { to: string | null; label: string }[] }) {
  return (
    <div className="election-head">
      <div>
        {crumbs && (
          <nav className="crumbs" aria-label="所在位置">
            {crumbs.map((c, i) => (
              <span key={i}>
                {i > 0 && <span className="crumb-sep" aria-hidden="true">›</span>}
                {c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
              </span>
            ))}
          </nav>
        )}
        <h1>{crumbs ? crumbs[crumbs.length - 1].label : election.name}</h1>
        <p className="muted">
          {crumbs ? `${election.name} · ` : ''}
          投票日 {dateLabel(election.date)}
        </p>
      </div>
      <StatusBadge status={election.status} />
    </div>
  );
}

// ---------- 首頁 ----------

type ElectionListItem = Pick<ElectionInfo, 'id' | 'name' | 'type' | 'date' | 'status'>;

function HomePage() {
  const [list, setList] = useState<ElectionListItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<ElectionListItem[]>('/api/elections').then(setList, (e: Error) => setError(e.message));
  }, []);
  if (list?.length === 1) return <Navigate to={`/e/${list[0].id}`} replace />;
  return (
    <Shell>
      <h1>選舉開票</h1>
      {error && <p className="alert">{error}</p>}
      {!list && !error && <p className="muted">載入中…</p>}
      {list && !list.length && (
        <div className="empty">
          <p>目前沒有公開的選舉。</p>
          <p className="muted">
            請到<Link to="/admin">管理後台</Link>建立選舉，並把狀態設為「開票中」。
          </p>
        </div>
      )}
      <ul className="election-list">
        {list?.map((e) => (
          <li key={e.id}>
            <Link to={`/e/${e.id}`} className="card election-item">
              <div>
                <div className="election-name">{e.name}</div>
                <div className="muted">
                  {e.type === 'president' ? '總統副總統選舉' : '直轄市長、縣市長選舉'} · {dateLabel(e.date)}
                </div>
              </div>
              <StatusBadge status={e.status} />
            </Link>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

// ---------- 選舉主畫面 ----------

function ElectionPage() {
  const id = Number(useParams().id);
  const { data, error } = useLive<Summary>(Number.isInteger(id) ? `/api/elections/${id}/summary` : null, id);
  if (error && !data) return <Shell><p className="alert">{error}</p></Shell>;
  if (!data) return <Shell><p className="muted">載入中…</p></Shell>;
  const national = data.contests.length === 1 && data.contests[0].areaCode === NATION;
  return (
    <Shell election={data.election} updatedAt={data.updatedAt}>
      <ElectionHeader election={data.election} />
      {error && <p className="alert">更新失敗（{error}），畫面顯示的是上一次取得的數字。</p>}
      {!data.contests.length ? (
        <p className="empty">這場選舉還沒有設定選舉區。</p>
      ) : national ? (
        <NationalView election={data.election} contest={data.contests[0]} />
      ) : (
        <ContestsView election={data.election} contests={data.contests} />
      )}
    </Shell>
  );
}

const areaLink = (electionId: number, contestId: number, code: string) => `/e/${electionId}/c/${contestId}/a/${code}`;

/** 全國單一選舉區（總統大選）。 */
function NationalView({ election, contest }: { election: ElectionInfo; contest: ContestSummary }) {
  const navigate = useNavigate();
  const final = election.status === 'final';
  const rows = contest.children ?? [];
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const candById = new Map(contest.candidates.map((c) => [c.id, c]));
  if (!contest.candidates.length) return <p className="empty">尚未設定候選人。</p>;
  return (
    <>
      <CandidateCards candidates={contest.candidates} totals={contest.totals} lead={final ? 'win' : 'lead'} />
      <section className="card block">
        <h2 className="block-title">得票率</h2>
        <ShareBar candidates={contest.candidates} totals={contest.totals} />
      </section>
      <Stats totals={contest.totals} unitLevel={election.unitLevel} />
      <div className="split">
        <section className="card block">
          <h2 className="block-title">各縣市領先情形</h2>
          <Legend candidates={contest.candidates} />
          <TaiwanMap
            ariaLabel="各縣市領先候選人地圖"
            fill={(code) => {
              const t = byCode.get(code)?.totals;
              return t?.leaderId != null ? (candById.get(t.leaderId)?.color ?? null) : null;
            }}
            name={(code) => byCode.get(code)?.name ?? code}
            tooltip={(code) => {
              const row = byCode.get(code);
              return <AreaTooltip title={row?.name ?? code} candidates={contest.candidates} totals={row?.totals ?? null} final={final} note={<ProgressNote totals={row?.totals} unitLevel={election.unitLevel} />} />;
            }}
            onSelect={(code) => navigate(areaLink(election.id, contest.id, code))}
          />
        </section>
        <section className="card block">
          <h2 className="block-title">各縣市得票</h2>
          <AreaTable rows={rows} candidates={contest.candidates} firstColumn="縣市" unitLevel={election.unitLevel} final={final} linkOf={(r) => areaLink(election.id, contest.id, r.code)} />
        </section>
      </div>
    </>
  );
}

function ProgressNote({ totals, unitLevel }: { totals?: Totals; unitLevel: ElectionInfo['unitLevel'] }) {
  if (!totals || totals.done || !totals.valid) return null;
  const p = progressOf(totals, unitLevel);
  return (
    <div className="tip-note">
      已開出 {num(p.done)} / {num(p.total)} {p.label}
    </div>
  );
}

function Legend({ candidates, withEmpty = true }: { candidates: Cand[]; withEmpty?: boolean }) {
  return (
    <ul className="legend">
      {candidates.map((c) => (
        <li key={c.id}>
          <Swatch color={c.color} />
          {c.name}
        </li>
      ))}
      {withEmpty && (
        <li>
          <span className="swatch swatch-empty" aria-hidden="true" />
          尚未開出／平手
        </li>
      )}
    </ul>
  );
}

/** 多個選舉區（縣市長選舉）：各縣市各自一場。 */
function ContestsView({ election, contests }: { election: ElectionInfo; contests: ContestSummary[] }) {
  const navigate = useNavigate();
  const final = election.status === 'final';
  const byCounty = new Map(contests.map((c) => [c.areaCode, c]));

  // 各政黨目前領先（或當選）的縣市數。
  const parties = new Map<string, { party: string; color: string; count: number }>();
  let undecided = 0;
  let doneCount = 0;
  for (const c of contests) {
    if (c.totals.done) doneCount++;
    const lead = leaderOf(c.candidates, c.totals);
    if (!lead) {
      undecided++;
      continue;
    }
    const key = !lead.party.trim() || /無黨籍|未經政黨推薦/.test(lead.party) ? '無黨籍' : lead.party;
    const hit = parties.get(key);
    if (hit) hit.count++;
    else parties.set(key, { party: key, color: lead.color, count: 1 });
  }
  const tally = [...parties.values()].sort((a, b) => b.count - a.count);

  return (
    <>
      <section className="card block">
        <h2 className="block-title">
          各政黨{final ? '當選' : '領先'}縣市數
          <span className="block-side">
            {doneCount} / {contests.length} 縣市{final ? '開票完成' : contests.some((c) => c.totals.done && c.totals.stationsTotal === null) ? '已回報' : '已全部開出'}
          </span>
        </h2>
        {tally.length ? (
          <>
            <div className="sharebar" role="img" aria-label={tally.map((t) => `${t.party} ${t.count} 縣市`).join('、')}>
              {tally.map((t) => (
                <span key={t.party} className="seg" style={{ flexGrow: t.count, background: t.color }}>
                  <span className="seg-label">{t.count}</span>
                </span>
              ))}
              {undecided > 0 && (
                <span className="seg seg-empty" style={{ flexGrow: undecided }}>
                  <span className="seg-label">{undecided}</span>
                </span>
              )}
            </div>
            <ul className="legend">
              {tally.map((t) => (
                <li key={t.party}>
                  <Swatch color={t.color} />
                  {t.party} <strong>{t.count}</strong>
                </li>
              ))}
              {undecided > 0 && (
                <li>
                  <span className="swatch swatch-empty" aria-hidden="true" />
                  尚未開出／平手 <strong>{undecided}</strong>
                </li>
              )}
            </ul>
          </>
        ) : (
          <p className="muted">尚未開出</p>
        )}
      </section>
      <div className="split">
        <section className="card block">
          <h2 className="block-title">各縣市{final ? '當選' : '領先'}者</h2>
          <TaiwanMap
            ariaLabel="各縣市領先候選人地圖"
            only={new Set(contests.map((c) => c.areaCode))}
            fill={(code) => {
              const c = byCounty.get(code);
              return c ? (leaderOf(c.candidates, c.totals)?.color ?? null) : null;
            }}
            name={(code) => byCounty.get(code)?.areaName ?? code}
            tooltip={(code) => {
              const c = byCounty.get(code);
              return c ? <AreaTooltip title={c.areaName} candidates={c.candidates} totals={c.totals} final={final} note={<ProgressNote totals={c.totals} unitLevel={election.unitLevel} />} /> : null;
            }}
            onSelect={(code) => {
              const c = byCounty.get(code);
              if (c) navigate(areaLink(election.id, c.id, code));
            }}
          />
          <p className="muted small">顏色為各縣市領先候選人的代表色；灰色表示尚未開出或平手。</p>
        </section>
        <section className="contest-grid" aria-label="各縣市選情">
          {contests.map((c) => (
            <ContestCard key={c.id} election={election} contest={c} final={final} />
          ))}
        </section>
      </div>
    </>
  );
}

function ContestCard({ election, contest, final }: { election: ElectionInfo; contest: ContestSummary; final: boolean }) {
  const t = contest.totals;
  const top = ranked(contest.candidates, t).slice(0, 2);
  return (
    <Link to={areaLink(election.id, contest.id, contest.areaCode)} className="card contest-card">
      <div className="contest-head">
        <span className="contest-name">{contest.areaName}</span>
        <span className="muted small">
          {t.done ? doneLabel(t, final) : t.valid ? <>已開出 <ProgressText totals={t} unitLevel={election.unitLevel} final={final} /></> : '尚未開出'}
        </span>
      </div>
      {!contest.candidates.length ? (
        <p className="muted small">尚未設定候選人</p>
      ) : (
        <>
          <ul className="contest-top">
            {top.map((c) => (
              <li key={c.id}>
                <Swatch color={t.valid ? c.color : OTHER_COLOR} />
                <span className="contest-cand">{c.name}</span>
                {t.leaderId === c.id && <LeadTag kind={final ? 'win' : 'lead'} />}
                <span className="contest-votes">{t.valid ? num(t.votes[c.id] ?? 0) : '—'}</span>
                <span className="contest-pct">{t.valid ? pct(t.votes[c.id] ?? 0, t.valid, 1) : ''}</span>
              </li>
            ))}
          </ul>
          <ShareBar candidates={contest.candidates} totals={t} thin byRank />
        </>
      )}
    </Link>
  );
}

// ---------- 下鑽頁：縣市／鄉鎮市區 ----------

function AreaPage() {
  const params = useParams();
  const id = Number(params.id);
  const cid = Number(params.cid);
  const code = params.code ?? '';
  const navigate = useNavigate();
  const { data, error } = useLive<Drill>(`/api/elections/${id}/contests/${cid}/areas/${code}`, id);
  if (error && !data) return <Shell><p className="alert">{error}</p><p><Link to={`/e/${id}`}>回到選舉總覽</Link></p></Shell>;
  if (!data) return <Shell><p className="muted">載入中…</p></Shell>;

  const { election, contest, area, children, childLevel } = data;
  const final = election.status === 'final';
  const national = contest.areaCode === NATION;
  const crumbs = [
    { to: `/e/${election.id}`, label: national ? '全國' : election.name },
    ...data.path
      .filter((p) => p.code !== NATION)
      .map((p) => ({ to: p.code === area.code ? null : areaLink(election.id, contest.id, p.code), label: national ? p.name : p.code === contest.areaCode ? contest.name : p.name })),
  ];
  const byCode = new Map(children.map((r) => [r.code, r]));
  const candById = new Map(contest.candidates.map((c) => [c.id, c]));
  const canDrill = (row: AreaRow) => row.level === 'county' || (row.level === 'town' && election.unitLevel === 'station');
  const firstColumn = childLevel === 'station' ? '投開票所' : childLevel === 'county' ? '縣市' : '鄉鎮市區';

  return (
    <Shell election={election} updatedAt={area.totals.updatedAt}>
      <ElectionHeader election={election} crumbs={crumbs} />
      {error && <p className="alert">更新失敗（{error}），畫面顯示的是上一次取得的數字。</p>}
      <section className="card block">
        <h2 className="block-title">{area.name} 得票</h2>
        <ShareBar candidates={contest.candidates} totals={area.totals} byRank />
        <RankedRows candidates={contest.candidates} totals={area.totals} lead={area.code !== contest.areaCode ? (final ? 'top' : 'lead') : final ? 'win' : 'lead'} />
      </section>
      <Stats totals={area.totals} unitLevel={election.unitLevel} />
      {children.length > 0 && (
        <div className={childLevel === 'town' ? 'split' : ''}>
          {childLevel === 'town' && (
            <section className="card block">
              <h2 className="block-title">各鄉鎮市區領先情形</h2>
              <Legend candidates={ranked(contest.candidates, area.totals).slice(0, 5)} />
              <TaiwanMap
                county={area.code}
                ariaLabel={`${area.name}各鄉鎮市區領先候選人地圖`}
                fill={(c) => {
                  const t = byCode.get(c)?.totals;
                  return t?.leaderId != null ? (candById.get(t.leaderId)?.color ?? null) : null;
                }}
                name={(c) => byCode.get(c)?.name ?? c}
                tooltip={(c) => {
                  const row = byCode.get(c);
                  return <AreaTooltip title={row?.name ?? c} candidates={contest.candidates} totals={row?.totals ?? null} final={final} note={<ProgressNote totals={row?.totals} unitLevel={election.unitLevel} />} />;
                }}
                onSelect={election.unitLevel === 'station' ? (c) => navigate(areaLink(election.id, contest.id, c)) : undefined}
              />
            </section>
          )}
          <section className="card block">
            <h2 className="block-title">各{firstColumn}得票</h2>
            <AreaTable
              rows={children}
              candidates={contest.candidates}
              firstColumn={firstColumn}
              unitLevel={election.unitLevel}
              final={final}
              linkOf={(r) => (canDrill(r) ? areaLink(election.id, contest.id, r.code) : null)}
            />
          </section>
        </div>
      )}
    </Shell>
  );
}
