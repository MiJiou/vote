import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api } from './api';

/** 一次性讀取；回傳 reload 可手動重抓。 */
export function useFetch<T>(url: string | null): { data: T | null; error: string; loading: boolean; reload: () => Promise<void>; setData: (v: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!url);
  const reload = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try {
      setData(await api<T>(url));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取失敗');
    } finally {
      setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    setData(null);
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : '發生錯誤');

export function LoginForm({ title, hint, onLogin }: { title: string; hint?: ReactNode; onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onLogin(username, password);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card login" onSubmit={submit}>
      <h1>{title}</h1>
      {hint && <p className="help">{hint}</p>}
      <label className="field">
        <span>帳號</span>
        <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required />
      </label>
      <label className="field">
        <span>密碼</span>
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </label>
      {error && <p className="alert">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? '登入中…' : '登入'}
      </button>
    </form>
  );
}

export type TablePayload = { csv?: string; table?: string[][]; filename: string };

/**
 * 把使用者選的檔案轉成可送給後端的內容。
 * Excel（.xlsx）在瀏覽器裡解析；CSV 先試 UTF-8，失敗就當作 Big5（台灣 Excel 另存 CSV 的預設編碼）。
 */
export async function fileToPayload(file: File): Promise<TablePayload> {
  if (/\.xlsx$/i.test(file.name)) {
    const { readSheet } = await import('read-excel-file/browser');
    const rows = (await readSheet(file)) as unknown[][];
    return {
      filename: file.name,
      table: rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c)))),
    };
  }
  if (/\.xls$/i.test(file.name)) throw new Error('不支援舊版 .xls 檔，請在 Excel 另存為 .xlsx 或 CSV 後再上傳');
  const buf = await file.arrayBuffer();
  let csv: string;
  try {
    csv = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    csv = new TextDecoder('big5').decode(buf);
  }
  return { filename: file.name, csv };
}

export function PasswordForm({ onDone }: { onDone?: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/api/auth/password', { body: { current, next } });
      setMessage({ ok: true, text: '密碼已更新' });
      setCurrent('');
      setNext('');
      onDone?.();
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  };
  return (
    <form className="stack" onSubmit={submit} style={{ maxWidth: 360 }}>
      <label className="field">
        <span>目前的密碼</span>
        <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
      </label>
      <label className="field">
        <span>新密碼（至少 8 個字元）</span>
        <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
      </label>
      {message && <p className={message.ok ? 'success' : 'alert'}>{message.text}</p>}
      <div>
        <button className="btn">更新密碼</button>
      </div>
    </form>
  );
}
