import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, useAuth } from '../api';
import { dateLabel, dateTime } from '../format';
import { LoginForm, PasswordForm, errorText, useFetch } from '../ui';
import { ElectionAdmin } from './ElectionAdmin';
import type { AdminElection, Area } from './types';
import { STATUS_LABEL, TYPE_LABEL } from './types';

export default function AdminPage() {
  const auth = useAuth();
  const body =
    auth.user === undefined ? (
      <p className="muted">載入中…</p>
    ) : !auth.user ? (
      <LoginForm title="管理後台登入" hint="第一次啟動時，管理員帳號與密碼會顯示在伺服器的啟動訊息裡。" onLogin={auth.login} />
    ) : auth.user.role !== 'admin' ? (
      <div className="empty">
        <p>這個帳號沒有管理權限。</p>
        <p><Link to="/report">前往票數回報</Link></p>
      </div>
    ) : (
      <AdminHome />
    );
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/admin" className="brand">
          <span className="brand-mark" aria-hidden="true">✓</span>
          管理後台
        </Link>
        <span className="topbar-status">
          <Link to="/">開票看板</Link>
          {auth.user && (
            <>
              <span className="muted">{auth.user.display_name || auth.user.username}</span>
              <button className="btn btn-small" onClick={() => void auth.logout()}>登出</button>
            </>
          )}
        </span>
      </header>
      <main className="page">{body}</main>
    </div>
  );
}

function AdminHome() {
  const elections = useFetch<AdminElection[]>('/api/admin/elections');
  return (
    <div className="admin">
      <nav className="side" aria-label="後台選單">
        <NavLink to="/admin" end>選舉列表</NavLink>
        {(elections.data ?? []).length > 0 && <div className="side-title">選舉</div>}
        {(elections.data ?? []).map((e) => (
          <NavLink key={e.id} to={`/admin/e/${e.id}`}>
            <span>{e.name}</span>
            {e.pending > 0 && <span className="count" title="待審核的回報">{e.pending}</span>}
          </NavLink>
        ))}
        <div className="side-title">系統</div>
        <NavLink to="/admin/users">帳號管理</NavLink>
        <NavLink to="/admin/audit">稽核紀錄</NavLink>
        <NavLink to="/admin/account">我的密碼</NavLink>
      </nav>
      <div className="admin-main">
        <Routes>
          <Route index element={<ElectionsHome elections={elections.data} error={elections.error} reload={elections.reload} />} />
          <Route path="e/:id/*" element={<ElectionAdmin onChanged={elections.reload} />} />
          <Route path="users" element={<UsersPage elections={elections.data ?? []} />} />
          <Route path="audit" element={<AuditPage />} />
          <Route
            path="account"
            element={
              <>
                <h1>我的密碼</h1>
                <section className="card section"><PasswordForm /></section>
              </>
            }
          />
        </Routes>
      </div>
    </div>
  );
}

// ---------- 選舉列表／新增 ----------

function ElectionsHome({ elections, error, reload }: { elections: AdminElection[] | null; error: string; reload: () => Promise<void> }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', type: 'president', date: '', unit_level: 'town' });
  const [message, setMessage] = useState('');
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setMessage('');
    try {
      const created = await api<{ id: number }>('/api/admin/elections', { body: form });
      await reload();
      navigate(`/admin/e/${created.id}/candidates`);
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  return (
    <>
      <h1>選舉列表</h1>
      {error && <p className="alert">{error}</p>}
      <section className="card section">
        {!elections ? (
          <p className="muted">載入中…</p>
        ) : !elections.length ? (
          <p className="muted">還沒有任何選舉。請在下方新增，或從中選會資料庫匯入一場歷屆選舉來試用。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>選舉</th><th>類型</th><th>投票日</th><th>狀態</th><th className="num">候選人</th><th className="num">已登錄單位</th><th className="num">待審核</th><th />
                </tr>
              </thead>
              <tbody>
                {elections.map((e) => (
                  <tr key={e.id}>
                    <th><Link to={`/admin/e/${e.id}`}>{e.name}</Link></th>
                    <td>{TYPE_LABEL[e.type]}</td>
                    <td>{dateLabel(e.date)}</td>
                    <td><span className={`chip ${e.status === 'live' ? 'chip-wait' : e.status === 'final' ? 'chip-ok' : ''}`}>{STATUS_LABEL[e.status]}</span></td>
                    <td className="num">{e.candidates}</td>
                    <td className="num">{e.results}</td>
                    <td className="num">{e.pending || '—'}</td>
                    <td><Link to={`/e/${e.id}`}>看板</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card section">
        <h2>新增選舉</h2>
        <form className="stack" onSubmit={create}>
          <div className="row">
            <label className="field grow">
              <span>選舉名稱</span>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：第 17 任總統副總統選舉" required />
            </label>
            <label className="field">
              <span>類型</span>
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="president">總統副總統選舉</option>
                <option value="mayor">直轄市長、縣市長選舉</option>
              </select>
            </label>
            <label className="field">
              <span>投票日</span>
              <input className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
            </label>
            <label className="field">
              <span>票數登錄到哪一層</span>
              <select className="input" value={form.unit_level} onChange={(e) => setForm({ ...form, unit_level: e.target.value })}>
                <option value="county">縣市（22 筆，最省力）</option>
                <option value="town">鄉鎮市區（368 筆）</option>
                <option value="station">投開票所（需匯入清冊）</option>
              </select>
            </label>
          </div>
          <p className="help">
            {form.type === 'president' ? '會建立一個全國選舉區。' : '會自動建立 22 個縣市的選舉區，候選人各自設定。'}
            新選舉預設為「草稿」，不會出現在公開看板上，設定完成後再改為「開票中」。
          </p>
          {message && <p className="alert">{message}</p>}
          <div><button className="btn btn-primary">建立選舉</button></div>
        </form>
      </section>

      <CecImport onDone={reload} />
    </>
  );
}

type CecOption = { key: string; name: string; date: string; themes: { subject: string; themeId: string; name: string }[] };

function CecImport({ onDone }: { onDone: () => Promise<void> }) {
  const navigate = useNavigate();
  const [type, setType] = useState<'president' | 'mayor'>('president');
  const [options, setOptions] = useState<CecOption[] | null>(null);
  const [key, setKey] = useState('');
  const [level, setLevel] = useState('town');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = async (t: 'president' | 'mayor') => {
    setType(t);
    setOptions(null);
    setMessage('');
    setBusy(true);
    try {
      const list = await api<CecOption[]>(`/api/admin/cec/elections?type=${t}`);
      setOptions(list);
      setKey(list[0]?.key ?? '');
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    const pick = options?.find((o) => o.key === key);
    if (!pick) return;
    setBusy(true);
    setMessage('');
    try {
      const res = await api<{ election: { id: number } }>('/api/admin/cec/import', {
        body: { type, themes: pick.themes, name: pick.name, date: pick.date, unitLevel: level },
      });
      await onDone();
      navigate(`/admin/e/${res.election.id}`);
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card section">
      <h2>從中選會選舉資料庫匯入歷屆選舉</h2>
      <p className="help">
        直接讀取中選會公開的歷屆選舉結果（候選人、各鄉鎮市區票數），適合用來試用系統或做選後比較。
        這是選後公布的正式結果，不是開票當晚的即時資料；伺服器需要能連上 db.cec.gov.tw。
      </p>
      <div className="row">
        <label className="field">
          <span>類型</span>
          <select className="input" value={type} onChange={(e) => void load(e.target.value as 'president' | 'mayor')}>
            <option value="president">總統副總統選舉</option>
            <option value="mayor">直轄市長、縣市長選舉</option>
          </select>
        </label>
        {options ? (
          <>
            <label className="field grow">
              <span>選舉</span>
              <select className="input" value={key} onChange={(e) => setKey(e.target.value)}>
                {options.map((o) => (
                  <option key={o.key} value={o.key}>{o.name}（{o.date}）</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>統計層級</span>
              <select className="input" value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="town">鄉鎮市區</option>
                <option value="county">縣市</option>
              </select>
            </label>
            <button className="btn btn-primary" onClick={() => void run()} disabled={busy || !key}>
              {busy ? '匯入中（約需半分鐘）…' : '匯入'}
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => void load(type)} disabled={busy}>
            {busy ? '讀取中…' : '讀取可匯入的選舉'}
          </button>
        )}
      </div>
      {message && <p className="alert">{message}</p>}
    </section>
  );
}

// ---------- 帳號 ----------

type AdminUser = {
  id: number; username: string; display_name: string; role: 'admin' | 'reporter'; active: number; created_at: string;
  assignments: { electionId: number; areaCode: string; areaName: string }[];
};

function UsersPage({ elections }: { elections: AdminElection[] }) {
  const users = useFetch<AdminUser[]>('/api/admin/users');
  const [form, setForm] = useState({ username: '', display_name: '', password: '', role: 'reporter' });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMessage({ ok: true, text: ok });
      await users.reload();
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api('/api/admin/users', { body: form });
      setForm({ username: '', display_name: '', password: '', role: 'reporter' });
    }, '帳號已建立');
  };
  const resetPassword = (u: AdminUser) => {
    const password = window.prompt(`為「${u.username}」設定新密碼（至少 8 個字元）`);
    if (password) void act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { password } }), '密碼已重設');
  };

  return (
    <>
      <h1>帳號管理</h1>
      <p className="help">「回報員」只能用手機回報頁，且只能回報被指派的範圍；「管理員」可以使用整個後台。</p>
      {message && <p className={message.ok ? 'success' : 'alert'}>{message.text}</p>}
      <section className="card section">
        {users.error && <p className="alert">{users.error}</p>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>帳號</th><th>名稱</th><th>角色</th><th>狀態</th><th>回報範圍</th><th /></tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id}>
                  <th>{u.username}</th>
                  <td>{u.display_name || '—'}</td>
                  <td>{u.role === 'admin' ? '管理員' : '回報員'}</td>
                  <td><span className={`chip ${u.active ? 'chip-ok' : 'chip-bad'}`}>{u.active ? '啟用' : '停用'}</span></td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {u.role === 'admin' ? <span className="muted">全部</span> : u.assignments.length ? u.assignments.map((a) => a.areaName).join('、') : <span className="muted">尚未指派</span>}
                  </td>
                  <td>
                    <span className="row">
                      {u.role === 'reporter' && <button className="btn btn-small" onClick={() => setEditing(editing === u.id ? null : u.id)}>指派範圍</button>}
                      <button className="btn btn-small" onClick={() => resetPassword(u)}>重設密碼</button>
                      <button className="btn btn-small" onClick={() => void act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }), u.active ? '已停用' : '已啟用')}>
                        {u.active ? '停用' : '啟用'}
                      </button>
                      <button
                        className="btn btn-small btn-danger"
                        onClick={() => window.confirm(`確定刪除帳號「${u.username}」？`) && void act(() => api(`/api/admin/users/${u.id}`, { method: 'DELETE' }), '已刪除')}
                      >
                        刪除
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {editing !== null && users.data?.find((u) => u.id === editing) && (
        <AssignEditor
          key={editing}
          user={users.data.find((u) => u.id === editing)!}
          elections={elections}
          onSaved={() => void act(async () => setEditing(null), '回報範圍已更新')}
        />
      )}
      <section className="card section">
        <h2>新增帳號</h2>
        <form className="row" onSubmit={create}>
          <label className="field">
            <span>帳號（英數字）</span>
            <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required autoCapitalize="none" />
          </label>
          <label className="field">
            <span>名稱</span>
            <input className="input" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
          </label>
          <label className="field">
            <span>密碼（至少 8 字元）</span>
            <input className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
          </label>
          <label className="field">
            <span>角色</span>
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="reporter">回報員</option>
              <option value="admin">管理員</option>
            </select>
          </label>
          <button className="btn btn-primary">建立</button>
        </form>
      </section>
    </>
  );
}

function AssignEditor({ user, elections, onSaved }: { user: AdminUser; elections: AdminElection[]; onSaved: () => void }) {
  const areas = useFetch<Area[]>('/api/areas');
  const open = elections.filter((e) => e.status !== 'final');
  const [electionId, setElectionId] = useState<number>(open[0]?.id ?? 0);
  const [codes, setCodes] = useState<{ code: string; name: string }[]>([]);
  const [county, setCounty] = useState('');
  const [town, setTown] = useState('');
  const [station, setStation] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setCodes(user.assignments.filter((a) => a.electionId === electionId).map((a) => ({ code: a.areaCode, name: a.areaName })));
  }, [user, electionId]);

  if (!open.length) return <p className="notice">目前沒有進行中的選舉可以指派。</p>;
  const counties = (areas.data ?? []).filter((a) => a.level === 'county');
  const towns = (areas.data ?? []).filter((a) => a.parent === county);
  const nameOf = (code: string) => (areas.data ?? []).find((a) => a.code === code)?.name ?? code;

  const add = () => {
    let code = '00000';
    let name = '全部地區';
    if (county) {
      code = county;
      name = nameOf(county);
      if (town) {
        code = town;
        name += ' ' + nameOf(town);
        if (station.trim()) {
          const no = /^\d{1,4}$/.test(station.trim()) ? station.trim().padStart(4, '0') : station.trim();
          code += '-' + no;
          name += ` 第 ${no} 投開票所`;
        }
      }
    }
    if (!codes.some((c) => c.code === code)) setCodes([...codes, { code, name }]);
  };
  const save = async () => {
    setError('');
    try {
      await api(`/api/admin/users/${user.id}/assignments`, { method: 'PUT', body: { electionId, areaCodes: codes.map((c) => c.code) } });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="card section">
      <h2>指派回報範圍：{user.display_name || user.username}</h2>
      <label className="field" style={{ maxWidth: 420 }}>
        <span>選舉</span>
        <select className="input" value={electionId} onChange={(e) => setElectionId(Number(e.target.value))}>
          {open.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
      </label>
      <div className="row row-center">
        {codes.length ? (
          codes.map((c) => (
            <span key={c.code} className="chip">
              {c.name}{' '}
              <button className="btn-link" aria-label={`移除 ${c.name}`} onClick={() => setCodes(codes.filter((x) => x.code !== c.code))}>✕</button>
            </span>
          ))
        ) : (
          <span className="muted">尚未指派任何範圍</span>
        )}
      </div>
      <div className="row">
        <label className="field">
          <span>縣市</span>
          <select className="input" value={county} onChange={(e) => { setCounty(e.target.value); setTown(''); }}>
            <option value="">全部地區</option>
            {counties.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>鄉鎮市區</span>
          <select className="input" value={town} onChange={(e) => setTown(e.target.value)} disabled={!county}>
            <option value="">整個縣市</option>
            {towns.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>投開票所編號（選填）</span>
          <input className="input" value={station} onChange={(e) => setStation(e.target.value)} disabled={!town} placeholder="例如 0123" />
        </label>
        <button className="btn" onClick={add}>加入</button>
        <button className="btn btn-primary" onClick={() => void save()}>儲存指派</button>
      </div>
      {error && <p className="alert">{error}</p>}
    </section>
  );
}

// ---------- 稽核紀錄 ----------

type AuditRow = { id: number; at: string; username: string; action: string; detail: string };

const ACTIONS: Record<string, string> = {
  'auth.login': '登入', 'auth.password': '修改密碼',
  'election.create': '建立選舉', 'election.update': '修改選舉設定', 'election.delete': '刪除選舉',
  'election.reset_results': '清除全部票數', 'election.auto_live': '自動公開（開票中）', 'election.auto_final': '自動改為開票完成', 'election.import_cec': '從中選會資料庫匯入',
  'candidate.create': '新增候選人', 'candidate.update': '修改候選人', 'candidate.delete': '刪除候選人', 'candidates.import': '匯入候選人',
  'candidate.photo': '上傳候選人照片', 'candidate.photo_remove': '移除候選人照片', 'candidate.declare': '標示當選', 'candidate.undeclare': '取消當選標示',
  'stations.import': '匯入投開票所', 'stations.clear': '清除投開票所',
  'result.set': '後台輸入票數', 'result.clear': '清除票數', 'result.lock': '鎖定票數', 'result.unlock': '解除鎖定', 'results.import': '批次匯入票數',
  'submission.approve': '核准回報', 'submission.reject': '退回回報',
  'source.create': '新增資料來源', 'source.update': '修改資料來源', 'source.delete': '刪除資料來源', 'source.run': '手動執行資料來源', 'source.token': '重新產生推送權杖',
  'user.create': '新增帳號', 'user.update': '修改帳號', 'user.delete': '刪除帳號', 'user.assign': '指派回報範圍',
};

function AuditPage() {
  const log = useFetch<AuditRow[]>('/api/admin/audit?limit=300');
  return (
    <>
      <h1>稽核紀錄</h1>
      <p className="help">所有會影響票數與設定的操作都會留下紀錄（最近 300 筆）。每一筆票數的歷次版本，可在「票數輸入」頁的「紀錄」查看。</p>
      <section className="card section">
        {log.error && <p className="alert">{log.error}</p>}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>時間</th><th>帳號</th><th>動作</th><th>內容</th></tr></thead>
            <tbody>
              {(log.data ?? []).map((r) => (
                <tr key={r.id}>
                  <td>{dateTime(r.at)}</td>
                  <td>{r.username}</td>
                  <td>{ACTIONS[r.action] ?? r.action}</td>
                  <td className="mono small" style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
