import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { api } from '../api';
import { dateTime, num, time } from '../format';
import { errorText, fileToPayload, useFetch } from '../ui';
import type { TablePayload } from '../ui';
import { Swatch } from '../components/results';
import type { Area, Candidate, Contest, Election, ImportReport } from './types';
import { LEVEL_LABEL, SOURCE_LABEL } from './types';

const NATION = '00000';

// ====================== 票數輸入 ======================

type UnitResult = {
  votes: Record<string, number>;
  invalid: number | null;
  eligible: number | null;
  stationsTotal: number | null;
  stationsCounted: number | null;
  source: string;
  locked: boolean;
  updatedAt: string;
};
type AdminUnit = {
  code: string;
  name: string;
  level: 'county' | 'town' | 'station';
  countyCode: string;
  townCode: string | null;
  defaultEligible: number | null;
  pending: number;
  result: UnitResult | null;
};
type UnitsResponse = { candidates: Candidate[]; units: AdminUnit[] };

export function EntryTab({ election, contests }: { election: Election; contests: Contest[] }) {
  const areas = useFetch<Area[]>('/api/areas');
  const [contestId, setContestId] = useState(contests[0]?.id ?? 0);
  const contest = contests.find((c) => c.id === contestId) ?? contests[0];
  const national = contest?.area_code === NATION;
  const counties = (areas.data ?? []).filter((a) => a.level === 'county');
  const [county, setCounty] = useState('');
  const [town, setTown] = useState('');
  const [history, setHistory] = useState<AdminUnit | null>(null);

  const countyCode = !contest ? '' : national ? county || counties[0]?.code || '' : contest.area_code;
  const towns = (areas.data ?? []).filter((a) => a.parent === countyCode);
  const townCode = election.unit_level === 'station' ? town || towns[0]?.code || '' : '';
  // 以縣市為單位時一次列出全部；鄉鎮市區層級列出一個縣市；投開票所層級列出一個鄉鎮市區。
  const parent = election.unit_level === 'county' ? '' : election.unit_level === 'town' ? countyCode : townCode;
  const ready = !!contest && !!areas.data && (election.unit_level === 'county' || !!parent);
  const units = useFetch<UnitsResponse>(ready ? `/api/admin/contests/${contest.id}/units${parent ? `?parent=${parent}` : ''}` : null);

  if (!contest) return <p className="notice">這場選舉還沒有選舉區。</p>;
  const cands = units.data?.candidates ?? [];
  const station = election.unit_level === 'station';

  return (
    <>
      <section className="card section">
        <div className="row">
          {contests.length > 1 && (
            <label className="field">
              <span>選舉區</span>
              <select className="input" value={contest.id} onChange={(e) => { setContestId(Number(e.target.value)); setTown(''); setHistory(null); }}>
                {contests.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          {national && election.unit_level !== 'county' && (
            <label className="field">
              <span>縣市</span>
              <select className="input" value={countyCode} onChange={(e) => { setCounty(e.target.value); setTown(''); setHistory(null); }}>
                {counties.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
          )}
          {station && (
            <label className="field">
              <span>鄉鎮市區</span>
              <select className="input" value={townCode} onChange={(e) => { setTown(e.target.value); setHistory(null); }}>
                {towns.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
              </select>
            </label>
          )}
        </div>
        <p className="help">
          以{LEVEL_LABEL[election.unit_level]}為單位輸入。改完一列按 Enter 或「儲存」即時生效並顯示在看板。
          「鎖定」後，自動讀取與批次匯入不會覆蓋這一列。大量輸入請改用「匯入／匯出」。
        </p>
        {units.error && <p className="alert">{units.error}</p>}
        {!units.data ? (
          <p className="muted">載入中…</p>
        ) : !cands.length ? (
          <p className="notice">這個選舉區還沒有候選人，請先到「候選人」設定。</p>
        ) : !units.data.units.length ? (
          <p className="notice">這裡沒有統計單位。</p>
        ) : (
          <div className="table-wrap">
            <table className="table grid-input">
              <thead>
                <tr>
                  <th>{station ? '投開票所' : LEVEL_LABEL[election.unit_level]}</th>
                  {cands.map((c) => (
                    <th key={c.id} className="num">
                      <span className="th-cand"><Swatch color={c.color} />{c.number} {c.name}</span>
                    </th>
                  ))}
                  <th className="num">無效票</th>
                  <th className="num">有效票</th>
                  <th className="num">選舉人數</th>
                  <th className="num">已開／總票所</th>
                  <th>狀態</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {units.data.units.map((u) => (
                  <UnitRow
                    key={`${u.code}|${u.result?.updatedAt ?? ''}|${u.result?.locked ?? ''}`}
                    contestId={contest.id}
                    unit={u}
                    candidates={cands}
                    onSaved={units.reload}
                    onHistory={() => setHistory(u)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {history && <History contestId={contest.id} unit={history} candidates={cands} onClose={() => setHistory(null)} />}
    </>
  );
}

const onlyDigits = (s: string) => s.replace(/[^\d]/g, '').slice(0, 9);
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

function UnitRow({ contestId, unit, candidates, onSaved, onHistory }: { contestId: number; unit: AdminUnit; candidates: Candidate[]; onSaved: () => Promise<void>; onHistory: () => void }) {
  const r = unit.result;
  const initial = {
    votes: Object.fromEntries(candidates.map((c) => [c.id, str(r?.votes[c.id])])) as Record<number, string>,
    invalid: str(r?.invalid),
    eligible: str(r?.eligible ?? unit.defaultEligible),
    stationsTotal: str(r?.stationsTotal),
    stationsCounted: str(r?.stationsCounted),
  };
  const [v, setV] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const valid = candidates.reduce((s, c) => s + (Number(v.votes[c.id]) || 0), 0);
  const base = `/api/admin/contests/${contestId}/units/${unit.code}`;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(() =>
      api(base, {
        method: 'PUT',
        body: {
          votes: Object.fromEntries(candidates.map((c) => [c.id, v.votes[c.id] === '' ? 0 : Number(v.votes[c.id])])),
          invalid: v.invalid === '' ? null : Number(v.invalid),
          eligible: v.eligible === '' ? null : Number(v.eligible),
          stationsTotal: v.stationsTotal === '' ? null : Number(v.stationsTotal),
          stationsCounted: v.stationsCounted === '' ? null : Number(v.stationsCounted),
        },
      }),
    );
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && dirty && !busy) void save();
  };
  const cell = (value: string, set: (s: string) => void, label: string) => (
    <input className="input input-num" inputMode="numeric" value={value} onChange={(e) => set(onlyDigits(e.target.value))} onKeyDown={onKey} aria-label={`${unit.name} ${label}`} />
  );

  return (
    <>
      <tr className={dirty ? 'is-dirty' : ''}>
        <th scope="row">
          {unit.name}
          {unit.pending > 0 && <span className="chip chip-wait" style={{ marginLeft: 6 }}>待審 {unit.pending}</span>}
        </th>
        {candidates.map((c) => (
          <td key={c.id} className="num">{cell(v.votes[c.id] ?? '', (s) => setV({ ...v, votes: { ...v.votes, [c.id]: s } }), `${c.number} 號得票`)}</td>
        ))}
        <td className="num">{cell(v.invalid, (s) => setV({ ...v, invalid: s }), '無效票')}</td>
        <td className="num">{num(valid)}</td>
        <td className="num">{cell(v.eligible, (s) => setV({ ...v, eligible: s }), '選舉人數')}</td>
        <td className="num">
          {unit.level === 'station' ? (
            <span className="muted">—</span>
          ) : (
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <input className="input input-num" style={{ width: 56 }} inputMode="numeric" value={v.stationsCounted} onChange={(e) => setV({ ...v, stationsCounted: onlyDigits(e.target.value) })} onKeyDown={onKey} aria-label={`${unit.name} 已開出投開票所數`} />
              /
              <input className="input input-num" style={{ width: 56 }} inputMode="numeric" value={v.stationsTotal} onChange={(e) => setV({ ...v, stationsTotal: onlyDigits(e.target.value) })} onKeyDown={onKey} aria-label={`${unit.name} 投開票所總數`} />
            </span>
          )}
        </td>
        <td className="small">
          {r ? (
            <>
              {SOURCE_LABEL[r.source] ?? r.source} {time(r.updatedAt)}
              {r.locked && <span className="chip" style={{ marginLeft: 6 }}>🔒 已鎖定</span>}
            </>
          ) : (
            <span className="muted">未登錄</span>
          )}
        </td>
        <td>
          <span className="row" style={{ flexWrap: 'nowrap' }}>
            <button className="btn btn-small btn-primary" disabled={!dirty || busy} onClick={() => void save()}>儲存</button>
            {r && (
              <>
                <button className="btn btn-small" disabled={busy} onClick={() => void run(() => api(`${base}/lock`, { body: { locked: !r.locked } }))}>
                  {r.locked ? '解鎖' : '鎖定'}
                </button>
                <button className="btn btn-small" onClick={onHistory}>紀錄</button>
                <button className="btn btn-small btn-danger" disabled={busy} onClick={() => window.confirm(`確定清除「${unit.name}」的票數？`) && void run(() => api(base, { method: 'DELETE' }))}>
                  清除
                </button>
              </>
            )}
          </span>
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={candidates.length + 7}><p className="alert">{error}</p></td>
        </tr>
      )}
    </>
  );
}

type HistoryRow = {
  id: number; source: string; status: string; votes: Record<string, number>; invalid_votes: number | null;
  note: string; submitted_at: string; username: string | null; display_name: string | null;
};
const SUB_STATUS: Record<string, string> = { pending: '待審核', approved: '生效中', rejected: '已退回', superseded: '已被取代', cleared: '已清除' };

function History({ contestId, unit, candidates, onClose }: { contestId: number; unit: AdminUnit; candidates: Candidate[]; onClose: () => void }) {
  const rows = useFetch<HistoryRow[]>(`/api/admin/contests/${contestId}/units/${unit.code}/history`);
  return (
    <section className="card section">
      <div className="section-head">
        <h2>{unit.name} 的歷次紀錄</h2>
        <button className="btn btn-small" onClick={onClose}>關閉</button>
      </div>
      {rows.error && <p className="alert">{rows.error}</p>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>時間</th><th>來源</th><th>帳號</th><th>狀態</th>
              {candidates.map((c) => <th key={c.id} className="num">{c.number} {c.name}</th>)}
              <th className="num">無效票</th><th>備註</th>
            </tr>
          </thead>
          <tbody>
            {(rows.data ?? []).map((h) => (
              <tr key={h.id}>
                <td>{dateTime(h.submitted_at)}</td>
                <td>{SOURCE_LABEL[h.source] ?? h.source}</td>
                <td>{h.display_name || h.username || '—'}</td>
                <td>{SUB_STATUS[h.status] ?? h.status}</td>
                {candidates.map((c) => <td key={c.id} className="num">{num(h.votes[c.id] ?? 0)}</td>)}
                <td className="num">{num(h.invalid_votes)}</td>
                <td>{h.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ====================== 匯入／匯出 ======================

function ReportView({ report }: { report: ImportReport }) {
  return (
    <div className="stack">
      <p className={report.errorCount ? 'alert' : 'success'}>
        {report.dryRun ? '預覽結果（尚未寫入）：' : '匯入完成：'}
        共 {report.rows} 列，{report.dryRun ? '將更新' : '已更新'} {report.applied}、無變更 {report.unchanged}、空白略過 {report.skipped}
        {report.locked > 0 && `、已鎖定未覆蓋 ${report.locked}`}
        {report.errorCount > 0 && `、有問題 ${report.errorCount} 列（這些列不會匯入）`}
      </p>
      {report.errors.length > 0 && (
        <ul className="errors-list">
          {report.errors.map((e, i) => <li key={i}>第 {e.line} 列：{e.message}</li>)}
        </ul>
      )}
      {report.warnings.length > 0 && (
        <details className="help-box">
          <summary>提醒 {report.warnings.length} 則</summary>
          <ul className="errors-list">
            {report.warnings.map((e, i) => <li key={i}>第 {e.line} 列：{e.message}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ImportTab({ election, reload }: { election: Election; reload: () => Promise<void> }) {
  const file = useRef<HTMLInputElement>(null);
  const [payload, setPayload] = useState<TablePayload | null>(null);
  const [pasted, setPasted] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const url = `/api/admin/elections/${election.id}`;

  const send = async (data: TablePayload, dryRun: boolean) => {
    setBusy(true);
    setError('');
    try {
      const r = await api<ImportReport>(`${url}/import`, { body: { ...data, dryRun } });
      setReport(r);
      if (!dryRun) {
        setPayload(null);
        setPasted('');
        await reload();
      }
    } catch (err) {
      setError(errorText(err));
      setReport(null);
    } finally {
      setBusy(false);
    }
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    try {
      const data = await fileToPayload(f);
      setPayload(data);
      await send(data, true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      if (file.current) file.current.value = '';
    }
  };
  const previewPaste = () => {
    const data = { csv: pasted, filename: '貼上的內容' };
    setPayload(data);
    void send(data, true);
  };

  return (
    <>
      <section className="card section">
        <div className="section-head">
          <h2>1. 下載表格</h2>
          <div className="row">
            <a className="btn" href={`${url}/export/results-template.csv`}>下載空白範本</a>
            <a className="btn" href={`${url}/export/results.csv`}>匯出目前票數</a>
          </div>
        </div>
        <p className="help">
          範本已列好這場選舉的所有{LEVEL_LABEL[election.unit_level]}與候選人欄位，用 Excel 或 Google 試算表打開填入票數即可。
          還沒開出的列留空白，系統會自動略過。
        </p>
      </section>
      <section className="card section">
        <h2>2. 上傳或貼上</h2>
        <div className="row">
          <button className="btn btn-primary" onClick={() => file.current?.click()} disabled={busy}>選擇 CSV／Excel 檔案</button>
          <input ref={file} type="file" accept=".csv,.xlsx,.tsv,text/csv" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          <span className="help">或直接從 Excel 複製儲存格，貼到下面：</span>
        </div>
        <textarea className="input" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'縣市\t鄉鎮市區\t1號\t2號\t3號\t無效票\n臺北市\t松山區\t26090\t41183\t50049\t744'} spellCheck={false} />
        <div><button className="btn" onClick={previewPaste} disabled={busy || !pasted.trim()}>預覽貼上的內容</button></div>
        {busy && <p className="muted">處理中…</p>}
        {error && <p className="alert">{error}</p>}
        {report && <ReportView report={report} />}
        {report?.dryRun && payload && (
          <div className="row">
            <button className="btn btn-primary" disabled={busy || report.applied === 0} onClick={() => void send(payload, false)}>
              確認匯入 {report.applied} 筆
            </button>
            <button className="btn" onClick={() => { setReport(null); setPayload(null); }}>取消</button>
          </div>
        )}
      </section>
      <FormatHelp />
    </>
  );
}

function FormatHelp() {
  return (
    <details className="help-box">
      <summary>表格格式說明</summary>
      <ul className="stack help" style={{ listStyle: 'disc', paddingLeft: 20 }}>
        <li>第一列是欄位名稱，順序不拘。</li>
        <li><strong>地區</strong>：用「代碼」一欄，或用「縣市」＋「鄉鎮市區」（＋「投開票所」編號）。「台」與「臺」通用。</li>
        <li><strong>候選人得票</strong>：欄名用號次（「1號」、「2號」…）或候選人姓名。縣市長選舉各縣市共用同一張表時請用號次。</li>
        <li><strong>其他欄位</strong>（選填）：無效票、選舉人數、投開票所總數、已開出投開票所數。</li>
        <li>若有「有效票」或「投票數」欄，系統會核對加總，不符的列會被擋下。</li>
        <li>數字可含千分位逗號；整列票數空白代表尚未開出，會略過。</li>
        <li>重複匯入同一份表格是安全的：數字沒變的列不會產生新紀錄。</li>
      </ul>
    </details>
  );
}

// ====================== 自動讀取 ======================

type Source = {
  id: number; name: string; kind: 'csv_url' | 'json_url' | 'cec_db' | 'push'; url: string; interval_sec: number; enabled: number;
  last_run_at: string | null; last_ok: number | null; last_message: string; hasToken: boolean;
};
const KIND_LABEL = { csv_url: 'CSV 網址（例如 Google 試算表）', json_url: 'JSON 網址', cec_db: '中選會選舉資料庫', push: 'API 推送' } as const;

export function SourcesTab({ election }: { election: Election }) {
  const sources = useFetch<Source[]>(`/api/admin/elections/${election.id}/sources`);
  const [form, setForm] = useState({ name: '', kind: 'csv_url', url: '', interval_sec: 30, enabled: true });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [token, setToken] = useState<{ id: number; token: string } | null>(null);

  // 定時重新整理，才看得到每次自動讀取的結果。
  const reloadRef = useRef(sources.reload);
  reloadRef.current = sources.reload;
  useEffect(() => {
    const t = setInterval(() => void reloadRef.current(), 10_000);
    return () => clearInterval(t);
  }, []);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      const out = await fn();
      if (ok) setMessage({ ok: true, text: ok });
      await sources.reload();
      return out;
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const created = await api<Source & { token: string | null }>(`/api/admin/elections/${election.id}/sources`, { body: form });
      if (created.token) setToken({ id: created.id, token: created.token });
      setForm({ name: '', kind: form.kind, url: '', interval_sec: 30, enabled: true });
    }, '已新增資料來源');
  };

  return (
    <>
      <section className="card section">
        <h2>資料來源</h2>
        <p className="help">
          系統會依設定的間隔自動抓取資料並更新看板。來源內容沒變時不會重複寫入；被「鎖定」的單位不會被覆蓋。
          同一個單位有多個來源時，以最後寫入的為準。
        </p>
        {message && <p className={message.ok ? 'success' : 'alert'}>{message.text}</p>}
        {token && (
          <div className="notice stack">
            <p><strong>推送權杖（只顯示這一次，請立刻複製保存）：</strong></p>
            <pre className="code">{token.token}</pre>
            <p>推送範例：</p>
            <pre className="code">{`curl -X POST ${location.origin}/api/ingest/${token.id} \\
  -H "Authorization: Bearer ${token.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"results":[{"county":"臺北市","town":"松山區","votes":{"1":26090,"2":41183,"3":50049},"invalid":744}]}'`}</pre>
            <div><button className="btn btn-small" onClick={() => setToken(null)}>我已保存</button></div>
          </div>
        )}
        {sources.error && <p className="alert">{sources.error}</p>}
        {sources.data && !sources.data.length && <p className="muted">尚未設定任何自動來源。</p>}
        {(sources.data ?? []).map((s) => (
          <SourceRow key={s.id} source={s} act={act} onToken={(t) => setToken({ id: s.id, token: t })} />
        ))}
      </section>

      <section className="card section">
        <h2>新增資料來源</h2>
        <form className="stack" onSubmit={create}>
          <div className="row">
            <label className="field">
              <span>類型</span>
              <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="csv_url">{KIND_LABEL.csv_url}</option>
                <option value="json_url">{KIND_LABEL.json_url}</option>
                <option value="push">{KIND_LABEL.push}</option>
              </select>
            </label>
            <label className="field grow">
              <span>名稱</span>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：總部回報試算表" required />
            </label>
            {form.kind !== 'push' && (
              <label className="field" style={{ width: 130 }}>
                <span>每幾秒讀一次</span>
                <input className="input input-num" type="number" min={10} value={form.interval_sec} onChange={(e) => setForm({ ...form, interval_sec: Number(e.target.value) })} />
              </label>
            )}
          </div>
          {form.kind !== 'push' && (
            <label className="field">
              <span>網址</span>
              <input className="input" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" required />
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            建立後立即啟用
          </label>
          <div><button className="btn btn-primary">新增</button></div>
        </form>
      </section>

      <details className="help-box" open>
        <summary>怎麼讓資料自動進來？</summary>
        <div className="stack help">
          <p>
            <strong>方法一：Google 試算表（最簡單）。</strong>到「匯入／匯出」下載範本 → 上傳到 Google 試算表 → 檔案 › 共用 › 發布到網路 → 選擇工作表與「逗號分隔值 (.csv)」→ 把產生的網址貼到上面。
            之後任何人在試算表裡填數字，看板就會自動更新（Google 發布的內容約 1–5 分鐘更新一次）。
          </p>
          <p>
            <strong>方法二：JSON 網址或 API 推送。</strong>如果你有工程人力，可以把任何上游資料（例如向中選會申請的開票日計票資料）轉成下面的格式，放在網址上讓系統定時讀取，或直接推送進來：
          </p>
          <pre className="code">{`{ "results": [
  { "code": "63000010", "votes": { "1": 26090, "2": 41183, "3": 50049 },
    "invalid": 744, "eligible": 157451, "stationsTotal": 120, "stationsCounted": 85 },
  { "county": "新北市", "town": "板橋區", "votes": { "1": 100, "2": 200, "3": 300 } }
] }`}</pre>
          <p>votes 的鍵是候選人號次；地區可用代碼或名稱。投開票所層級請加上 "station": "0001"。</p>
          <p>
            <strong>關於中選會的即時資料：</strong>開票當晚的官方即時計票資料需事先向中選會申請，格式每屆公告。本系統內建的「中選會選舉資料庫」來源讀的是選後公布的正式結果，可在選後用來核對或更新為官方數字。
          </p>
        </div>
      </details>
    </>
  );
}

function SourceRow({ source, act, onToken }: { source: Source; act: (fn: () => Promise<unknown>, ok?: string) => Promise<unknown>; onToken: (token: string) => void }) {
  const [url, setUrl] = useState(source.url);
  const [interval, setIntervalSec] = useState(source.interval_sec);
  const [running, setRunning] = useState(false);
  const base = `/api/admin/sources/${source.id}`;
  const dirty = url !== source.url || interval !== source.interval_sec;
  const run = async () => {
    setRunning(true);
    await act(async () => {
      const r = await api<{ ok: boolean; message: string }>(`${base}/run`, { method: 'POST', body: {} });
      if (!r.ok) throw new Error(r.message);
    }, '已執行，結果如下');
    setRunning(false);
  };
  return (
    <div className="card section" style={{ boxShadow: 'none' }}>
      <div className="section-head">
        <div>
          <strong>{source.name}</strong> <span className="muted small">· {KIND_LABEL[source.kind]}</span>{' '}
          <span className={`chip ${source.enabled ? 'chip-ok' : ''}`}>{source.enabled ? '啟用中' : '已停用'}</span>
        </div>
        <div className="row">
          <button className="btn btn-small" onClick={() => void act(() => api(base, { method: 'PATCH', body: { enabled: !source.enabled } }), source.enabled ? '已停用' : '已啟用')}>
            {source.enabled ? '停用' : '啟用'}
          </button>
          {source.kind !== 'push' && <button className="btn btn-small" onClick={() => void run()} disabled={running}>{running ? '執行中…' : '立即執行一次'}</button>}
          {source.kind === 'push' && (
            <button
              className="btn btn-small"
              onClick={() => window.confirm('重新產生後，舊的權杖會立刻失效。確定嗎？') && void act(async () => onToken((await api<{ token: string }>(`${base}/token`, { method: 'POST', body: {} })).token))}
            >
              重新產生權杖
            </button>
          )}
          <button className="btn btn-small btn-danger" onClick={() => window.confirm(`確定刪除「${source.name}」？`) && void act(() => api(base, { method: 'DELETE' }), '已刪除')}>刪除</button>
        </div>
      </div>
      {(source.kind === 'csv_url' || source.kind === 'json_url') && (
        <div className="row">
          <label className="field grow">
            <span>網址</span>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="field" style={{ width: 130 }}>
            <span>每幾秒讀一次</span>
            <input className="input input-num" type="number" min={10} value={interval} onChange={(e) => setIntervalSec(Number(e.target.value))} />
          </label>
          <button className="btn" disabled={!dirty} onClick={() => void act(() => api(base, { method: 'PATCH', body: { url, interval_sec: interval } }), '已儲存')}>儲存</button>
        </div>
      )}
      {source.kind === 'push' && <p className="help">推送網址：<code>{location.origin}/api/ingest/{source.id}</code>（需帶 Authorization: Bearer 權杖）</p>}
      <p className="small">
        {source.last_run_at ? (
          <>
            <span className={`chip ${source.last_ok ? 'chip-ok' : 'chip-bad'}`}>{source.last_ok ? '✓ 成功' : '✕ 有問題'}</span>{' '}
            {dateTime(source.last_run_at)}：{source.last_message}
          </>
        ) : (
          <span className="muted">尚未執行過</span>
        )}
      </p>
    </div>
  );
}

// ====================== 回報審核 ======================

type PendingRow = {
  id: number; unit_code: string; unit_name: string; contest_name: string; source: string; status: string;
  votes: Record<string, number>; invalid_votes: number | null; eligible_voters: number | null;
  stations_total: number | null; stations_counted: number | null; note: string; submitted_at: string;
  username: string | null; display_name: string | null;
  current_votes: Record<string, number> | null; current_invalid: number | null; current_locked: number | null;
  candidates: { id: number; number: number; name: string; color: string }[];
};

export function ReviewTab({ election, reload }: { election: Election; reload: () => Promise<void> }) {
  const [status, setStatus] = useState('pending');
  const list = useFetch<PendingRow[]>(`/api/admin/submissions?election=${election.id}&status=${status}`);
  const [error, setError] = useState('');
  const reloadRef = useRef(list.reload);
  reloadRef.current = list.reload;
  useEffect(() => {
    const t = setInterval(() => void reloadRef.current(), 8000);
    return () => clearInterval(t);
  }, []);

  const review = async (id: number, action: 'approve' | 'reject') => {
    setError('');
    try {
      await api(`/api/admin/submissions/${id}/${action}`, { method: 'POST', body: {} });
    } catch (err) {
      setError(errorText(err));
    }
    await Promise.all([list.reload(), reload()]);
  };

  return (
    <>
      <section className="card section">
        <div className="section-head">
          <h2>回報審核</h2>
          <label className="field">
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="篩選狀態">
              <option value="pending">待審核</option>
              <option value="rejected">已退回</option>
            </select>
          </label>
        </div>
        <p className="help">
          回報員送出的票數要在這裡核准後才會顯示在看板上（每 8 秒自動更新）。
          {election.auto_approve_reports ? '目前已開啟「直接生效」，只有數字異常或單位被鎖定的回報會出現在這裡。' : '若想讓回報直接生效，可到「總覽與設定」開啟。'}
        </p>
        {error && <p className="alert">{error}</p>}
        {list.error && <p className="alert">{list.error}</p>}
        {list.data && !list.data.length && <p className="muted">{status === 'pending' ? '目前沒有待審核的回報。' : '沒有資料。'}</p>}
      </section>
      {(list.data ?? []).map((s) => {
        const valid = s.candidates.reduce((sum, c) => sum + (s.votes[c.id] ?? 0), 0);
        const total = valid + (s.invalid_votes ?? 0);
        const over = s.eligible_voters !== null && total > s.eligible_voters;
        return (
          <section key={s.id} className="card section">
            <div className="section-head">
              <div>
                <strong>{s.unit_name}</strong>
                <span className="muted small"> · {s.contest_name} · {s.display_name || s.username || SOURCE_LABEL[s.source]} · {dateTime(s.submitted_at)}</span>
              </div>
              {s.status === 'pending' && (
                <div className="row">
                  <button className="btn btn-primary" onClick={() => void review(s.id, 'approve')}>核准</button>
                  <button className="btn btn-danger" onClick={() => void review(s.id, 'reject')}>退回</button>
                </div>
              )}
            </div>
            {over && <p className="alert">投票數 {num(total)} 超過選舉人數 {num(s.eligible_voters)}</p>}
            {s.current_locked ? <p className="notice">這個單位目前已鎖定，核准前需先到「票數輸入」解除鎖定。</p> : null}
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {s.candidates.map((c) => (
                      <th key={c.id} className="num"><span className="th-cand"><Swatch color={c.color} />{c.number} {c.name}</span></th>
                    ))}
                    <th className="num">無效票</th><th className="num">有效票</th><th className="num">投票數</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {s.candidates.map((c) => (
                      <td key={c.id} className="num">
                        {s.current_votes && s.current_votes[c.id] !== s.votes[c.id] && <span className="diff-old">{num(s.current_votes[c.id] ?? 0)}</span>}
                        <strong>{num(s.votes[c.id] ?? 0)}</strong>
                      </td>
                    ))}
                    <td className="num">
                      {s.current_votes && s.current_invalid !== s.invalid_votes && <span className="diff-old">{num(s.current_invalid)}</span>}
                      {num(s.invalid_votes)}
                    </td>
                    <td className="num">{num(valid)}</td>
                    <td className="num">{num(total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {s.current_votes && <p className="help">劃掉的是目前看板上的數字，核准後會被新的數字取代。</p>}
            {s.note && <p className="help">備註：{s.note}</p>}
          </section>
        );
      })}
    </>
  );
}
