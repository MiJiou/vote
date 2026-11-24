import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { dateLabel, num } from '../format';
import { errorText, fileToPayload, useFetch } from '../ui';
import type { Candidate, Contest, Election, ElectionDetail } from './types';
import { LEVEL_LABEL, STATUS_LABEL, TYPE_LABEL } from './types';
import { EntryTab, ImportTab, ReviewTab, SourcesTab } from './DataTabs';

export function ElectionAdmin({ onChanged }: { onChanged: () => Promise<void> }) {
  const id = Number(useParams().id);
  const detail = useFetch<ElectionDetail>(`/api/admin/elections/${id}`);
  const reload = async () => {
    await Promise.all([detail.reload(), onChanged()]);
  };
  if (detail.error && !detail.data) return <p className="alert">{detail.error}</p>;
  if (!detail.data) return <p className="muted">載入中…</p>;
  const { election, contests, pending, stations } = detail.data;
  const base = `/admin/e/${id}`;
  return (
    <>
      <div className="section-head">
        <div>
          <h1>{election.name}</h1>
          <p className="muted small">
            {TYPE_LABEL[election.type]} · {dateLabel(election.date)} · 以{LEVEL_LABEL[election.unit_level]}為單位登錄 ·{' '}
            <span className={`chip ${election.status === 'live' ? 'chip-wait' : election.status === 'final' ? 'chip-ok' : ''}`}>{STATUS_LABEL[election.status]}</span>
          </p>
        </div>
        <Link className="btn" to={`/e/${id}`} target="_blank">開啟看板 ↗</Link>
      </div>
      <nav className="tabs" aria-label="選舉管理">
        <NavLink to={base} end>總覽與設定</NavLink>
        <NavLink to={`${base}/candidates`}>候選人</NavLink>
        {election.unit_level === 'station' && <NavLink to={`${base}/stations`}>投開票所</NavLink>}
        <NavLink to={`${base}/entry`}>票數輸入</NavLink>
        <NavLink to={`${base}/import`}>匯入／匯出</NavLink>
        <NavLink to={`${base}/sources`}>自動讀取</NavLink>
        <NavLink to={`${base}/review`}>
          回報審核 {pending > 0 && <span className="count">{pending}</span>}
        </NavLink>
      </nav>
      <Routes>
        <Route index element={<Overview detail={detail.data} reload={reload} />} />
        <Route path="candidates" element={<CandidatesTab election={election} contests={contests} reload={reload} />} />
        <Route path="stations" element={<StationsTab election={election} count={stations} reload={reload} />} />
        <Route path="entry" element={<EntryTab election={election} contests={contests} />} />
        <Route path="import" element={<ImportTab election={election} reload={reload} />} />
        <Route path="sources" element={<SourcesTab election={election} />} />
        <Route path="review" element={<ReviewTab election={election} reload={reload} />} />
      </Routes>
    </>
  );
}

// ---------- 總覽與設定 ----------

function Overview({ detail, reload }: { detail: ElectionDetail; reload: () => Promise<void> }) {
  const { election, contests } = detail;
  const navigate = useNavigate();
  const [form, setForm] = useState<Election>(election);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const units = contests.reduce((s, c) => s + c.units, 0);
  const reported = contests.reduce((s, c) => s + c.reported, 0);
  const noCandidates = contests.filter((c) => !c.candidates.length).length;

  const patch = async (body: Partial<Election>, ok: string) => {
    try {
      const next = await api<Election>(`/api/admin/elections/${election.id}`, { method: 'PATCH', body });
      setForm(next);
      setMessage({ ok: true, text: ok });
      await reload();
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  };
  const setStatus = (status: Election['status']) => {
    const warn =
      status === 'final' ? '設為「開票完成」後，看板會把各選舉區的領先者標示為「當選」，回報員也無法再回報。確定嗎？'
      : status === 'live' ? '設為「開票中」後，這場選舉會出現在公開看板上。確定嗎？'
      : '改回「草稿」後，公開看板將看不到這場選舉。確定嗎？';
    if (window.confirm(warn)) void patch({ status }, `狀態已改為「${STATUS_LABEL[status]}」`);
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void patch(
      { name: form.name, date: form.date, unit_level: form.unit_level, auto_approve_reports: form.auto_approve_reports, source_note: form.source_note },
      '設定已儲存',
    );
  };
  const reset = async () => {
    if (window.prompt(`這會清除「${election.name}」的全部票數（候選人與設定保留）。\n請輸入「清除」確認：`) !== '清除') return;
    try {
      const r = await api<{ cleared: number }>(`/api/admin/elections/${election.id}/reset-results`, { method: 'POST', body: {} });
      setMessage({ ok: true, text: `已清除 ${r.cleared} 筆票數` });
      await reload();
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  };
  const remove = async () => {
    if (window.prompt(`這會永久刪除「${election.name}」及其所有資料，無法復原。\n請輸入選舉名稱確認：`) !== election.name) return;
    try {
      await api(`/api/admin/elections/${election.id}`, { method: 'DELETE' });
      await reload().catch(() => {});
      navigate('/admin');
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  };

  return (
    <>
      {message && <p className={message.ok ? 'success' : 'alert'}>{message.text}</p>}
      <section className="card section">
        <h2>公開狀態</h2>
        <div className="row row-center">
          {(['draft', 'live', 'final'] as const).map((s) => (
            <button key={s} className={`btn ${election.status === s ? 'btn-primary' : ''}`} onClick={() => election.status !== s && setStatus(s)} aria-pressed={election.status === s}>
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <p className="help">
          草稿：只有管理員看得到，可用來設定與演練。開票中：公開並即時更新，領先者標示「領先」。開票完成：領先者改標「當選」，停止回報。
        </p>
        <dl className="kv">
          <dt>選舉區</dt><dd>{contests.length} 個{noCandidates > 0 && <span className="chip chip-bad" style={{ marginLeft: 8 }}>{noCandidates} 個尚未設定候選人</span>}</dd>
          <dt>統計單位</dt><dd>已登錄 {num(reported)} / {num(units)} 個{LEVEL_LABEL[election.unit_level]}</dd>
          <dt>待審核回報</dt><dd>{detail.pending ? <Link to="review">{detail.pending} 筆，前往審核</Link> : '無'}</dd>
        </dl>
      </section>

      <section className="card section">
        <h2>設定</h2>
        <form className="stack" onSubmit={save}>
          <div className="row">
            <label className="field grow">
              <span>選舉名稱</span>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className="field">
              <span>投票日</span>
              <input className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
            </label>
            <label className="field">
              <span>票數登錄到哪一層</span>
              <select className="input" value={form.unit_level} onChange={(e) => setForm({ ...form, unit_level: e.target.value as Election['unit_level'] })}>
                <option value="county">縣市</option>
                <option value="town">鄉鎮市區</option>
                <option value="station">投開票所</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>資料來源說明（顯示在看板頁尾）</span>
            <input className="input" value={form.source_note} onChange={(e) => setForm({ ...form, source_note: e.target.value })} placeholder="例如：資料來源為本台各投開票所回報" maxLength={300} />
          </label>
          <label className="check">
            <input type="checkbox" checked={!!form.auto_approve_reports} onChange={(e) => setForm({ ...form, auto_approve_reports: e.target.checked ? 1 : 0 })} />
            回報員送出的票數直接生效（不經人工審核；數字異常的仍會進入審核）
          </label>
          <div><button className="btn btn-primary">儲存設定</button></div>
        </form>
      </section>

      <section className="card section">
        <h2>危險操作</h2>
        <div className="row">
          <button className="btn btn-danger" onClick={() => void reset()}>清除全部票數</button>
          <button className="btn btn-danger" onClick={() => void remove()}>刪除這場選舉</button>
        </div>
      </section>
    </>
  );
}

// ---------- 候選人 ----------

function CandidatesTab({ election, contests, reload }: { election: Election; contests: Contest[]; reload: () => Promise<void> }) {
  const file = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    try {
      const r = await api<{ upserted: number; errors: { line: number; message: string }[] }>(`/api/admin/elections/${election.id}/candidates/import`, { body: await fileToPayload(f) });
      setMessage({ ok: !r.errors.length, text: `已匯入 ${r.upserted} 位候選人` + (r.errors.length ? `；${r.errors.length} 列有問題：` + r.errors.slice(0, 5).map((e) => `第 ${e.line} 列 ${e.message}`).join('；') : '') });
      await reload();
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    } finally {
      if (file.current) file.current.value = '';
    }
  };
  return (
    <>
      <section className="card section">
        <div className="section-head">
          <h2>批次匯入候選人</h2>
          <div className="row">
            <a className="btn" href={`/api/admin/elections/${election.id}/export/candidates.csv`}>下載名單（可當範本）</a>
            <button className="btn" onClick={() => file.current?.click()}>上傳 CSV／Excel</button>
            <input ref={file} type="file" accept=".csv,.xlsx,text/csv" hidden onChange={(e) => void upload(e.target.files?.[0])} />
          </div>
        </div>
        <p className="help">
          欄位：{election.type === 'mayor' ? '縣市、' : ''}號次、姓名{election.type === 'president' ? '、副總統候選人' : ''}、政黨、顏色（選填，#RRGGBB）。同一選舉區相同號次會覆蓋。沒填顏色時依政黨自動配色。
        </p>
        {message && <p className={message.ok ? 'success' : 'alert'}>{message.text}</p>}
      </section>
      {contests.map((c) => (
        <ContestCandidates key={c.id} election={election} contest={c} reload={reload} open={contests.length === 1} />
      ))}
    </>
  );
}

const emptyCand = { number: '', name: '', running_mate: '', party: '', color: '' };

function ContestCandidates({ election, contest, reload, open }: { election: Election; contest: Contest; reload: () => Promise<void>; open: boolean }) {
  const [draft, setDraft] = useState(emptyCand);
  const [error, setError] = useState('');
  const president = election.type === 'president';
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(`/api/admin/contests/${contest.id}/candidates`, { body: { ...draft, number: Number(draft.number) } });
      setDraft(emptyCand);
    });
  };
  return (
    <details className="card section" open={open}>
      <summary>
        <strong>{contest.name}</strong>
        <span className="muted small"> · {contest.candidates.length ? `${contest.candidates.length} 位候選人` : '尚未設定候選人'}</span>
      </summary>
      {error && <p className="alert">{error}</p>}
      <div className="table-wrap">
        <table className="table grid-input">
          <thead>
            <tr><th>號次</th><th>姓名</th>{president && <th>副總統候選人</th>}<th>政黨</th><th>代表色</th><th /></tr>
          </thead>
          <tbody>
            {contest.candidates.map((c) => (
              <CandidateRow key={`${c.id}|${c.number}|${c.name}|${c.running_mate}|${c.party}|${c.color}`} cand={c} president={president} run={run} />
            ))}
          </tbody>
        </table>
      </div>
      <form className="row" onSubmit={add}>
        <label className="field" style={{ width: 70 }}>
          <span>號次</span>
          <input className="input input-num" inputMode="numeric" value={draft.number} onChange={(e) => setDraft({ ...draft, number: e.target.value.replace(/\D/g, '') })} required />
        </label>
        <label className="field grow">
          <span>姓名</span>
          <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
        </label>
        {president && (
          <label className="field grow">
            <span>副總統候選人</span>
            <input className="input" value={draft.running_mate} onChange={(e) => setDraft({ ...draft, running_mate: e.target.value })} />
          </label>
        )}
        <label className="field grow">
          <span>政黨</span>
          <input className="input" value={draft.party} onChange={(e) => setDraft({ ...draft, party: e.target.value })} placeholder="無黨籍可留空" list="party-list" />
        </label>
        <button className="btn">新增候選人</button>
      </form>
      <datalist id="party-list">
        {['民主進步黨', '中國國民黨', '台灣民眾黨', '時代力量', '親民黨', '台灣基進', '無黨籍'].map((p) => <option key={p} value={p} />)}
      </datalist>
    </details>
  );
}

function CandidateRow({ cand, president, run }: { cand: Candidate; president: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [v, setV] = useState(cand);
  const dirty = v.number !== cand.number || v.name !== cand.name || v.running_mate !== cand.running_mate || v.party !== cand.party || v.color.toUpperCase() !== cand.color.toUpperCase();
  return (
    <tr className={dirty ? 'is-dirty' : ''}>
      <td><input className="input input-num" style={{ width: 56 }} value={v.number} onChange={(e) => setV({ ...v, number: Number(e.target.value.replace(/\D/g, '')) || 0 })} aria-label="號次" /></td>
      <td><input className="input" style={{ width: 130 }} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} aria-label="姓名" /></td>
      {president && <td><input className="input" style={{ width: 130 }} value={v.running_mate} onChange={(e) => setV({ ...v, running_mate: e.target.value })} aria-label="副總統候選人" /></td>}
      <td><input className="input" style={{ width: 150 }} value={v.party} onChange={(e) => setV({ ...v, party: e.target.value })} aria-label="政黨" list="party-list" /></td>
      <td><input className="color-input" type="color" value={v.color} onChange={(e) => setV({ ...v, color: e.target.value })} aria-label="代表色" /></td>
      <td>
        <span className="row">
          <button className="btn btn-small btn-primary" disabled={!dirty} onClick={() => void run(() => api(`/api/admin/candidates/${cand.id}`, { method: 'PATCH', body: v }))}>儲存</button>
          <button
            className="btn btn-small btn-danger"
            onClick={() => window.confirm(`確定刪除 ${cand.number} 號 ${cand.name}？`) && void run(() => api(`/api/admin/candidates/${cand.id}`, { method: 'DELETE' }))}
          >
            刪除
          </button>
        </span>
      </td>
    </tr>
  );
}

// ---------- 投開票所清冊 ----------

function StationsTab({ election, count, reload }: { election: Election; count: number; reload: () => Promise<void> }) {
  const file = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    try {
      const r = await api<{ rows: number; upserted: number; errors: { line: number; message: string }[] }>(`/api/admin/elections/${election.id}/stations/import`, { body: await fileToPayload(f) });
      setMessage({ ok: !r.errors.length, text: `已匯入 ${r.upserted} / ${r.rows} 個投開票所` + (r.errors.length ? `；有問題的列：` + r.errors.slice(0, 5).map((e) => `第 ${e.line} 列 ${e.message}`).join('；') : '') });
      await reload();
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    } finally {
      if (file.current) file.current.value = '';
    }
  };
  const clear = async () => {
    if (!window.confirm('清除投開票所清冊會同時清除已登錄的投開票所票數。確定嗎？')) return;
    try {
      const r = await api<{ removed: number }>(`/api/admin/elections/${election.id}/stations`, { method: 'DELETE' });
      setMessage({ ok: true, text: `已清除 ${r.removed} 個投開票所` });
      await reload();
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  };
  return (
    <section className="card section">
      <div className="section-head">
        <h2>投開票所清冊（目前 {num(count)} 個）</h2>
        <div className="row">
          <a className="btn" href={`/api/admin/elections/${election.id}/export/stations.csv`}>下載清冊（可當範本）</a>
          <button className="btn btn-primary" onClick={() => file.current?.click()}>上傳 CSV／Excel</button>
          <input ref={file} type="file" accept=".csv,.xlsx,text/csv" hidden onChange={(e) => void upload(e.target.files?.[0])} />
          {count > 0 && <button className="btn btn-danger" onClick={() => void clear()}>清除清冊</button>}
        </div>
      </div>
      <p className="help">
        欄位：縣市、鄉鎮市區、投開票所（編號）、村里、名稱、選舉人數。編號會自動補滿 4 碼；同一鄉鎮市區相同編號會覆蓋。
        中選會在選前會公告各投開票所設置地點與選舉人數，整理成表格後上傳即可。
      </p>
      <p className="help">
        尚未匯入清冊的鄉鎮市區，會暫時以「整個鄉鎮市區」為一個單位登錄票數，所以清冊可以分批匯入，加總不會出錯。
      </p>
      {message && <p className={message.ok ? 'success' : 'alert'}>{message.text}</p>}
    </section>
  );
}
