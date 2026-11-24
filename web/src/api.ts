import { useCallback, useEffect, useRef, useState } from 'react';

// ---------- 型別（與後端回應一致）----------

export type Totals = {
  votes: Record<string, number>;
  valid: number;
  invalid: number;
  total: number;
  turnout: number | null;
  unitsTotal: number;
  unitsReported: number;
  stationsTotal: number | null;
  stationsCounted: number | null;
  done: boolean;
  leaderId: number | null;
  updatedAt: string | null;
};
export type Cand = { id: number; number: number; name: string; runningMate: string; party: string; color: string };
export type AreaRow = { code: string; name: string; level: 'nation' | 'county' | 'town' | 'station'; totals: Totals };
export type ElectionInfo = {
  id: number;
  name: string;
  type: 'president' | 'mayor';
  date: string;
  status: 'draft' | 'live' | 'final';
  unitLevel: 'county' | 'town' | 'station';
  sourceNote: string;
};
export type ContestSummary = { id: number; name: string; areaCode: string; areaName: string; candidates: Cand[]; totals: Totals; children?: AreaRow[] };
export type Summary = { election: ElectionInfo; version: number; updatedAt: string | null; contests: ContestSummary[] };
export type Drill = {
  election: ElectionInfo;
  version: number;
  contest: ContestSummary;
  area: AreaRow;
  path: { code: string; name: string }[];
  childLevel: 'county' | 'town' | 'station' | null;
  children: AreaRow[];
};
export type User = { id: number; username: string; display_name: string; role: 'admin' | 'reporter' };

export const NATION = '00000';

// ---------- 請求 ----------

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let message = `請求失敗（${res.status}）`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* 非 JSON 回應 */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

// ---------- 即時更新 ----------

type Listener = (electionId: number) => void;
const listeners = new Set<Listener>();
const statusListeners = new Set<(open: boolean) => void>();
let source: EventSource | null = null;
let open = false;

function ensureStream(): void {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/stream');
  source.addEventListener('open', () => setOpen(true));
  source.addEventListener('error', () => setOpen(false));
  source.addEventListener('update', (e) => {
    try {
      const { electionId } = JSON.parse((e as MessageEvent).data) as { electionId: number };
      for (const fn of listeners) fn(electionId);
    } catch {
      /* 忽略格式錯誤的事件 */
    }
  });
}

function setOpen(value: boolean): void {
  if (open === value) return;
  open = value;
  for (const fn of statusListeners) fn(value);
}

/** 即時連線是否暢通（斷線時頁面會改用定時輪詢）。 */
export function useStreamStatus(): boolean {
  const [value, setValue] = useState(open);
  useEffect(() => {
    ensureStream();
    statusListeners.add(setValue);
    setValue(open);
    return () => void statusListeners.delete(setValue);
  }, []);
  return value;
}

/**
 * 抓取資料並在該場選舉有變動時自動重抓。
 * 重抓期間保留上一版畫面，不閃爍；即時連線中斷時每 15 秒輪詢一次。
 */
export function useLive<T>(url: string | null, electionId: number | null): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef(url);
  const busy = useRef(false);
  const again = useRef(false);

  const load = useCallback(async () => {
    const target = urlRef.current;
    if (!target) return;
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      const value = await api<T>(target);
      if (urlRef.current === target) {
        setData(value);
        setError(null);
      }
    } catch (err) {
      if (urlRef.current === target) setError(err instanceof Error ? err.message : '讀取失敗');
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, []);

  useEffect(() => {
    urlRef.current = url;
    setData(null);
    setError(null);
    void load();
  }, [url, load]);

  useEffect(() => {
    if (electionId === null) return;
    ensureStream();
    const onUpdate: Listener = (id) => {
      if (id === electionId) void load();
    };
    listeners.add(onUpdate);
    const poll = setInterval(() => {
      if (!open && document.visibilityState === 'visible') void load();
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      listeners.delete(onUpdate);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [electionId, load]);

  return { data, error, reload: load };
}

// ---------- 登入狀態 ----------

export function useAuth() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const refresh = useCallback(async () => {
    try {
      setUser((await api<{ user: User | null }>('/api/auth/me')).user);
    } catch {
      setUser(null);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  const login = async (username: string, password: string) => {
    setUser((await api<{ user: User }>('/api/auth/login', { body: { username, password } })).user);
  };
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    setUser(null);
  };
  return { user, login, logout, refresh };
}
