import { useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { errorText } from '../ui';
import type { Contest } from './types';
import { matchPhotoFile } from './photoMatch';
import type { MatchCandidate } from './photoMatch';

/**
 * 把照片裁成 4:5 的直式大頭照並縮到 480×600，再轉成 JPEG。
 * 在瀏覽器裡先處理好，上傳的檔案只有幾十 KB，看板載入也快。
 */
export async function blobToPhoto(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const W = 480;
  const H = 600;
  const scale = Math.max(W / bitmap.width, H / bitmap.height);
  const sw = W / scale;
  const sh = H / scale;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('瀏覽器無法處理這張圖片');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  // 直向裁切時偏上取景，比較不會切到頭。
  g.drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) * 0.15, sw, sh, 0, 0, W, H);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.86);
}

export const uploadPhoto = async (candidateId: number, blob: Blob, credit: string) =>
  api(`/api/admin/candidates/${candidateId}/photo`, { method: 'PUT', body: { dataUrl: await blobToPhoto(blob), credit } });

type Status = { ok: boolean; text: string } | null;

// ====================== 維基共享資源 ======================

type CommonsMatch = {
  qid: string; label: string; description: string; birthYear: string | null; taiwan: boolean; politician: boolean;
  file: string; thumb: string; author: string; license: string; sourceUrl: string; credit: string;
};
type CommonsCandidate = { id: number; number: number; name: string; party: string; contestName: string; areaName: string; hasPhoto: boolean; matches: CommonsMatch[] };

/**
 * 預設勾選：只有在恰好一位結果是「臺灣的政治人物」時才預選，其餘讓管理員自己判斷。
 * （實測：2022 年南投縣長候選人王永慶，維基數據上同名的是台塑創辦人——臺灣人，但不是政治人物。）
 */
function preselect(list: CommonsCandidate[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const c of list) {
    const strong = c.matches.filter((m) => m.taiwan && m.politician);
    if (strong.length === 1) out[c.id] = strong[0].file;
  }
  return out;
}

export function CommonsFinder({ electionId, onDone }: { electionId: number; onDone: () => Promise<void> }) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [result, setResult] = useState<{ candidates: CommonsCandidate[]; excluded: number } | null>(null);
  const [picked, setPicked] = useState<Record<number, string>>({});

  const search = async () => {
    setBusy(true);
    setStatus(null);
    setResult(null);
    try {
      const r = await api<{ candidates: CommonsCandidate[]; excluded: number }>(`/api/admin/elections/${electionId}/commons-photos${all ? '?all=1' : ''}`);
      setResult(r);
      setPicked(preselect(r.candidates));
      const found = r.candidates.filter((c) => c.matches.length).length;
      if (!r.candidates.length) setStatus({ ok: true, text: '所有候選人都已經有照片了（勾選「包含已有照片的候選人」可重新搜尋）' });
      else setStatus({ ok: true, text: `搜尋了 ${r.candidates.length} 位候選人，其中 ${found} 位找到可用的照片。請逐一確認是本人再套用。` });
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!result) return;
    const jobs = result.candidates.filter((c) => picked[c.id]).map((c) => ({ c, m: c.matches.find((m) => m.file === picked[c.id])! }));
    setBusy(true);
    let done = 0;
    const failed: string[] = [];
    for (const { c, m } of jobs) {
      setStatus({ ok: true, text: `套用中… ${done + 1} / ${jobs.length}（${c.name}）` });
      try {
        const res = await fetch(`/api/admin/commons/image?file=${encodeURIComponent(m.file)}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
        await uploadPhoto(c.id, await res.blob(), m.credit);
        done++;
      } catch (err) {
        failed.push(`${c.name}（${errorText(err)}）`);
      }
    }
    setBusy(false);
    setStatus(failed.length ? { ok: false, text: `已套用 ${done} 張；失敗：${failed.join('、')}` } : { ok: true, text: `已套用 ${done} 張照片，看板上的出處標示也一併更新了。` });
    setResult({ ...result, candidates: result.candidates.filter((c) => !picked[c.id] || failed.some((f) => f.startsWith(c.name))) });
    setPicked({});
    await onDone();
  };

  const count = Object.keys(picked).length;
  return (
    <section className="card section">
      <h2>從維基共享資源找照片</h2>
      <p className="help">
        用候選人姓名到維基數據查詢，只列出可以自由使用的照片（CC BY、CC BY-SA、CC0、公有領域、標示出處授權）。套用後轉播畫面會自動標示作者與授權，這是授權條件要求的。
        同名同姓的人很多，<strong>請確認照片是本人</strong>再套用；新人或小黨候選人通常找不到，請改用下面的批次上傳。
      </p>
      <div className="row row-center">
        <button className="btn btn-primary" onClick={() => void search()} disabled={busy}>
          {busy && !result ? '搜尋中…' : '開始搜尋'}
        </button>
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          包含已有照片的候選人
        </label>
      </div>
      {status && <p className={status.ok ? 'notice' : 'alert'}>{status.text}</p>}
      {result && result.candidates.length > 0 && (
        <>
          <ul className="commons-list">
            {result.candidates.map((c) => (
              <li key={c.id} className="commons-item">
                <div className="commons-who">
                  <strong>{c.name}</strong>
                  <span className="muted small">
                    {c.areaName} {c.number} 號 · {c.party || '無黨籍'}
                    {c.hasPhoto && ' · 已有照片'}
                  </span>
                </div>
                {c.matches.length ? (
                  <div className="commons-options" role="radiogroup" aria-label={`${c.name} 的照片`}>
                    {c.matches.map((m) => (
                      <label key={m.file} className={`commons-option${picked[c.id] === m.file ? ' is-picked' : ''}`}>
                        <input
                          type="radio"
                          name={`photo-${c.id}`}
                          checked={picked[c.id] === m.file}
                          onChange={() => setPicked({ ...picked, [c.id]: m.file })}
                        />
                        <img src={m.thumb} alt={`${m.label}（${m.description || m.qid}）`} loading="lazy" referrerPolicy="no-referrer" />
                        <span className="commons-meta">
                          <span>{m.description || '（沒有描述）'}</span>
                          {!(m.taiwan && m.politician) && <span className="chip chip-wait">可能不是同一人</span>}
                          {m.birthYear && <span className="muted">{m.birthYear} 年生</span>}
                          <span className="muted">{m.author}／{m.license}</span>
                          <a href={m.sourceUrl} target="_blank" rel="noreferrer noopener">檔案頁 ↗</a>
                        </span>
                      </label>
                    ))}
                    <label className={`commons-option is-none${!picked[c.id] ? ' is-picked' : ''}`}>
                      <input
                        type="radio"
                        name={`photo-${c.id}`}
                        checked={!picked[c.id]}
                        onChange={() => {
                          const next = { ...picked };
                          delete next[c.id];
                          setPicked(next);
                        }}
                      />
                      都不是本人
                    </label>
                  </div>
                ) : (
                  <p className="muted small">找不到可用的照片</p>
                )}
              </li>
            ))}
          </ul>
          {result.excluded > 0 && <p className="help">另有 {result.excluded} 張照片因授權不允許商業使用或改作（或授權不明）而略過。</p>}
          <div>
            <button className="btn btn-primary" onClick={() => void apply()} disabled={busy || !count}>
              套用選取的照片（{count}）
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// ====================== 批次上傳 ======================

type Item = { key: string; file: File; preview: string; candidateId: number | null; reason: string; state: 'ready' | 'done' | 'error'; message?: string };

export function BulkPhotoUpload({ contests, onDone }: { contests: Contest[]; onDone: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [credit, setCredit] = useState('');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  const candidates: MatchCandidate[] = useMemo(
    () => contests.flatMap((c) => c.candidates.map((k) => ({ id: k.id, number: k.number, name: k.name, contestId: c.id, areaName: c.areaName }))),
    [contests],
  );
  const label = (id: number) => {
    const c = candidates.find((x) => x.id === id);
    return c ? `${contests.length > 1 ? c.areaName + ' ' : ''}${c.number} 號 ${c.name}` : '';
  };

  const add = (files: FileList | File[]) => {
    const images = [...files].filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name));
    setItems((prev) => {
      const next = [...prev];
      for (const f of images) {
        const key = `${f.name}|${f.size}|${f.lastModified}`;
        if (next.some((i) => i.key === key)) continue;
        const m = matchPhotoFile(f.name, candidates);
        next.push({ key, file: f, preview: URL.createObjectURL(f), candidateId: m.candidateId, reason: m.reason, state: 'ready' });
      }
      return next;
    });
  };
  const clear = () => {
    for (const i of items) URL.revokeObjectURL(i.preview);
    setItems([]);
  };
  const setTarget = (key: string, id: number | null) => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, candidateId: id, reason: id ? '手動指定' : '不上傳', state: 'ready' } : i)));

  const duplicates = new Set(items.filter((i, idx) => i.candidateId && items.findIndex((j) => j.candidateId === i.candidateId) !== idx).map((i) => i.candidateId));
  const ready = items.filter((i) => i.candidateId && i.state !== 'done');

  const upload = async () => {
    setBusy(true);
    for (const item of ready) {
      try {
        await uploadPhoto(item.candidateId!, item.file, credit);
        setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, state: 'done', message: undefined } : i)));
      } catch (err) {
        setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, state: 'error', message: errorText(err) } : i)));
      }
    }
    setBusy(false);
    await onDone();
  };

  return (
    <section className="card section">
      <h2>批次上傳照片</h2>
      <p className="help">
        一次選取或拖進多張照片，系統依檔名自動配對：
        {contests.length > 1 ? '「臺北市-6.jpg」（縣市＋號次）或「蔣萬安.jpg」（姓名，同名時加上縣市）' : '「6.jpg」（號次）或「賴清德.jpg」（姓名）'}
        。配錯或沒配到的可以在表格裡手動指定。照片會自動裁成直式大頭照。
      </p>
      <div
        className={`dropzone${drag ? ' is-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          add(e.dataTransfer.files);
        }}
      >
        <button className="btn" onClick={() => input.current?.click()} disabled={busy}>選擇照片</button>
        <span className="muted">或把照片拖到這裡（JPEG、PNG、WebP）</span>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>照片</th><th>檔名</th><th>對應的候選人</th><th>配對依據</th><th>狀態</th></tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.key}>
                    <td><img className="photo-thumb" src={i.preview} alt="" /></td>
                    <td className="small">{i.file.name}</td>
                    <td>
                      <select className="input" value={i.candidateId ?? ''} onChange={(e) => setTarget(i.key, e.target.value ? Number(e.target.value) : null)} disabled={busy || i.state === 'done'} aria-label={`${i.file.name} 對應的候選人`}>
                        <option value="">（不上傳）</option>
                        {candidates.map((c) => (
                          <option key={c.id} value={c.id}>{label(c.id)}</option>
                        ))}
                      </select>
                    </td>
                    <td className="small">
                      {i.reason}
                      {i.candidateId && duplicates.has(i.candidateId) && <span className="chip chip-wait" style={{ marginLeft: 6 }}>重複：只會留最後一張</span>}
                    </td>
                    <td className="small">
                      {i.state === 'done' ? <span className="chip chip-ok">✓ 已上傳</span> : i.state === 'error' ? <span className="chip chip-bad" title={i.message}>失敗：{i.message}</span> : i.candidateId ? '待上傳' : <span className="muted">不上傳</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="field">
            <span>照片出處（選填，會顯示在轉播畫面的照片角落，例如「各競選總部提供」）</span>
            <input className="input" value={credit} onChange={(e) => setCredit(e.target.value)} maxLength={200} />
          </label>
          <div className="row">
            <button className="btn btn-primary" onClick={() => void upload()} disabled={busy || !ready.length}>
              {busy ? '上傳中…' : `上傳 ${ready.length} 張照片`}
            </button>
            <button className="btn" onClick={clear} disabled={busy}>清空清單</button>
          </div>
        </>
      )}
    </section>
  );
}
