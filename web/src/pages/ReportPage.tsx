import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useAuth } from '../api';
import type { User } from '../api';
import { num, time } from '../format';
import { LoginForm, errorText, useFetch } from '../ui';
import { Swatch } from '../components/results';

type ReportElection = { id: number; name: string; date: string; status: string; areas: { code: string; name: string }[] };
type ReportCand = { id: number; number: number; name: string; party: string; color: string };
type ReportUnit = {
  contestId: number;
  code: string;
  name: string;
  level: 'county' | 'town' | 'station';
  area: string;
  eligible: number | null;
  last: { status: string; at: string } | null;
};
type UnitsResponse = {
  election: { id: number; name: string; status: string; unitLevel: string };
  contests: { id: number; name: string; candidates: ReportCand[] }[];
  units: ReportUnit[];
};

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待審核', cls: 'chip-wait' },
  approved: { label: '已生效', cls: 'chip-ok' },
  superseded: { label: '已有新版', cls: '' },
  rejected: { label: '已退回', cls: 'chip-bad' },
  cleared: { label: '已清除', cls: '' },
};

export default function ReportPage() {
  const auth = useAuth();
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">✓</span>
          票數回報
        </span>
        {auth.user && (
          <span className="topbar-status">
            <span className="muted">{auth.user.display_name || auth.user.username}</span>
            <button className="btn btn-small" onClick={() => void auth.logout()}>登出</button>
          </span>
        )}
      </header>
      <main className="page">
        {auth.user === undefined ? (
          <p className="muted">載入中…</p>
        ) : auth.user ? (
          <Reporter user={auth.user} />
        ) : (
          <LoginForm title="票數回報登入" hint="請使用管理員發給你的回報帳號登入。" onLogin={auth.login} />
        )}
      </main>
      <footer className="footer">
        <p><Link to="/">回到開票看板</Link></p>
      </footer>
    </div>
  );
}

function Reporter({ user }: { user: User }) {
  const elections = useFetch<ReportElection[]>('/api/report/elections');
  const [electionId, setElectionId] = useState<number | null>(null);
  const list = elections.data ?? [];
  const current = list.find((e) => e.id === electionId) ?? (list.length === 1 ? list[0] : null);

  if (elections.error) return <p className="alert">{elections.error}</p>;
  if (!elections.data) return <p className="muted">載入中…</p>;
  if (!list.length) {
    return (
      <div className="report">
        <p className="notice">目前沒有指派給你的回報範圍。請聯絡管理員{user.role === 'admin' ? '（你是管理員，可以到後台建立選舉）' : ''}。</p>
      </div>
    );
  }
  if (!current) {
    return (
      <div className="report">
        <h1>請選擇選舉</h1>
        <ul className="unit-list">
          {list.map((e) => (
            <li key={e.id}>
              <button className="card unit-item" onClick={() => setElectionId(e.id)}>
                <span>
                  <span className="unit-name">{e.name}</span>
                  <br />
                  <span className="muted small">回報範圍：{e.areas.map((a) => a.name).join('、')}</span>
                </span>
                <span aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return <ElectionReport election={current} onBack={list.length > 1 ? () => setElectionId(null) : undefined} />;
}

function ElectionReport({ election, onBack }: { election: ReportElection; onBack?: () => void }) {
  const units = useFetch<UnitsResponse>(`/api/report/elections/${election.id}/units`);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReportUnit | null>(null);
  const [onlyTodo, setOnlyTodo] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().replace(/台/g, '臺');
    return (units.data?.units ?? []).filter((u) => (!q || `${u.area} ${u.name} ${u.code}`.includes(q)) && (!onlyTodo || !u.last));
  }, [units.data, query, onlyTodo]);

  if (units.error) return <p className="alert">{units.error}</p>;
  if (!units.data) return <p className="muted">載入中…</p>;

  if (selected) {
    const contest = units.data.contests.find((c) => c.id === selected.contestId)!;
    return (
      <ReportForm
        unit={selected}
        contestName={units.data.contests.length > 1 ? contest.name : election.name}
        candidates={contest.candidates}
        onClose={() => {
          setSelected(null);
          void units.reload();
        }}
      />
    );
  }

  const done = units.data.units.filter((u) => u.last).length;
  return (
    <div className="report">
      <div>
        {onBack && <button className="btn-link small" onClick={onBack}>‹ 換一場選舉</button>}
        <h1>{election.name}</h1>
        <p className="muted small">
          已回報 {done} / {units.data.units.length} 個單位
          {election.status === 'draft' && '（演練中：這場選舉尚未公開）'}
        </p>
      </div>
      <div className="row row-center">
        <input className="input grow" placeholder="搜尋投開票所編號或地名" value={query} onChange={(e) => setQuery(e.target.value)} inputMode="search" />
        <label className="check">
          <input type="checkbox" checked={onlyTodo} onChange={(e) => setOnlyTodo(e.target.checked)} />
          只看未回報
        </label>
      </div>
      <ul className="unit-list">
        {filtered.slice(0, 200).map((u) => {
          const s = u.last ? STATUS[u.last.status] : null;
          return (
            <li key={`${u.contestId}-${u.code}`}>
              <button className="card unit-item" onClick={() => setSelected(u)}>
                <span>
                  <span className="unit-name">{u.name}</span>
                  <br />
                  <span className="muted small">{u.area}</span>
                </span>
                {s ? (
                  <span className={`chip ${s.cls}`}>{s.label} {time(u.last!.at).slice(0, 5)}</span>
                ) : (
                  <span className="chip">未回報</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {filtered.length > 200 && <p className="muted small">還有 {filtered.length - 200} 個單位，請用搜尋縮小範圍。</p>}
      {!filtered.length && <p className="muted">沒有符合的單位。</p>}
    </div>
  );
}

const digits = (s: string) => s.replace(/[^\d]/g, '').slice(0, 9);
const toNum = (s: string) => (s === '' ? 0 : Number(s));

function ReportForm({ unit, contestName, candidates, onClose }: { unit: ReportUnit; contestName: string; candidates: ReportCand[]; onClose: () => void }) {
  const [votes, setVotes] = useState<Record<number, string>>({});
  const [invalid, setInvalid] = useState('');
  const [stationsTotal, setStationsTotal] = useState('');
  const [stationsCounted, setStationsCounted] = useState('');
  const [note, setNote] = useState('');
  const [step, setStep] = useState<'edit' | 'confirm' | 'done'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ status: string; warnings: string[] } | null>(null);

  const valid = candidates.reduce((s, c) => s + toNum(votes[c.id] ?? ''), 0);
  const total = valid + toNum(invalid);
  const missing = candidates.some((c) => (votes[c.id] ?? '') === '') || invalid === '';
  const overEligible = unit.eligible !== null && total > unit.eligible;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ status: string; warnings: string[] }>('/api/report/submit', {
        body: {
          contestId: unit.contestId,
          unitCode: unit.code,
          votes: Object.fromEntries(candidates.map((c) => [c.id, toNum(votes[c.id] ?? '')])),
          invalid: toNum(invalid),
          stationsTotal: stationsTotal === '' ? null : Number(stationsTotal),
          stationsCounted: stationsCounted === '' ? null : Number(stationsCounted),
          note,
        },
      });
      setResult(res);
      setStep('done');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const heading = (
    <div>
      <p className="muted small">{contestName} · {unit.area}</p>
      <h1>{unit.name}</h1>
    </div>
  );

  if (step === 'done' && result) {
    return (
      <div className="report">
        {heading}
        {result.status === 'pending' ? (
          <p className="notice">已送出，等待管理員審核後才會顯示在看板上。</p>
        ) : result.status === 'unchanged' ? (
          <p className="notice">送出的數字與目前看板上的相同，不需更新。</p>
        ) : (
          <p className="success">已送出並生效，看板已更新。</p>
        )}
        {result.warnings.map((w) => (
          <p key={w} className="alert">{w}</p>
        ))}
        <button className="btn btn-primary btn-big" onClick={onClose}>回報下一個單位</button>
      </div>
    );
  }

  if (step === 'confirm') {
    return (
      <div className="report">
        {heading}
        <p className="notice">請對照投開票報告表，再核對一次數字。</p>
        <div className="card section">
          <table className="confirm-table">
            <tbody>
              {candidates.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className="th-cand"><Swatch color={c.color} />{c.number} 號 {c.name}</span>
                  </td>
                  <td>{num(toNum(votes[c.id] ?? ''))}</td>
                </tr>
              ))}
              <tr><td>有效票合計</td><td>{num(valid)}</td></tr>
              <tr><td>無效票</td><td>{num(toNum(invalid))}</td></tr>
              <tr><td>投票數</td><td>{num(total)}</td></tr>
            </tbody>
          </table>
        </div>
        {overEligible && <p className="alert">投票數 {num(total)} 超過選舉人數 {num(unit.eligible)}，請再確認；送出後會由管理員審核。</p>}
        {error && <p className="alert">{error}</p>}
        <button className="btn btn-primary btn-big" onClick={() => void submit()} disabled={busy}>
          {busy ? '送出中…' : '數字正確，確認送出'}
        </button>
        <button className="btn btn-big" onClick={() => setStep('edit')} disabled={busy}>返回修改</button>
      </div>
    );
  }

  return (
    <form
      className="report"
      onSubmit={(e) => {
        e.preventDefault();
        setStep('confirm');
      }}
    >
      <button type="button" className="btn-link small" onClick={onClose} style={{ justifySelf: 'start' }}>‹ 回單位列表</button>
      {heading}
      {unit.last && <p className="notice">你在 {time(unit.last.at)} 回報過這個單位（{STATUS[unit.last.status]?.label}）。再次送出會以新的數字為準。</p>}
      <div className="card section">
        {candidates.map((c) => (
          <label key={c.id} className="vote-row">
            <span className="vote-who">
              <Swatch color={c.color} />
              <span className="cand-no is-small">{c.number}</span>
              {c.name}
            </span>
            <input
              className="input input-num"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="0"
              value={votes[c.id] ?? ''}
              onChange={(e) => setVotes({ ...votes, [c.id]: digits(e.target.value) })}
              aria-label={`${c.number} 號 ${c.name} 得票數`}
            />
          </label>
        ))}
        <label className="vote-row">
          <span className="vote-who">無效票</span>
          <input className="input input-num" inputMode="numeric" pattern="[0-9]*" placeholder="0" value={invalid} onChange={(e) => setInvalid(digits(e.target.value))} />
        </label>
        <div className="sum-box" aria-live="polite">
          <div><b>{num(valid)}</b><span>有效票合計</span></div>
          <div><b>{num(toNum(invalid))}</b><span>無效票</span></div>
          <div><b>{num(total)}</b><span>投票數</span></div>
        </div>
        {unit.eligible !== null && <p className="help">這個投開票所的選舉人數：{num(unit.eligible)}</p>}
      </div>
      {unit.level !== 'station' && (
        <div className="card section">
          <p className="help">這個單位是整個{unit.level === 'county' ? '縣市' : '鄉鎮市區'}。若還沒全部開完，請填寫投開票所數，看板才能正確顯示開票進度。</p>
          <div className="row">
            <label className="field grow">
              <span>已開出投開票所數</span>
              <input className="input input-num" inputMode="numeric" value={stationsCounted} onChange={(e) => setStationsCounted(digits(e.target.value))} />
            </label>
            <label className="field grow">
              <span>投開票所總數</span>
              <input className="input input-num" inputMode="numeric" value={stationsTotal} onChange={(e) => setStationsTotal(digits(e.target.value))} />
            </label>
          </div>
        </div>
      )}
      <label className="field">
        <span>備註（選填）</span>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </label>
      {missing && <p className="help">每一格都要填（沒有票請填 0）。</p>}
      <button className="btn btn-primary btn-big" disabled={missing}>下一步：核對數字</button>
    </form>
  );
}
