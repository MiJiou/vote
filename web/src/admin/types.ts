export type Area = { code: string; name: string; level: 'county' | 'town'; parent: string | null };

export type Election = {
  id: number;
  name: string;
  type: 'president' | 'mayor';
  date: string;
  status: 'draft' | 'live' | 'final';
  unit_level: 'county' | 'town' | 'station';
  auto_approve_reports: number;
  source_note: string;
};
export type AdminElection = Election & { contests: number; candidates: number; results: number; pending: number };

export type Candidate = { id: number; contest_id: number; number: number; name: string; running_mate: string; party: string; color: string };
export type Contest = { id: number; name: string; area_code: string; areaName: string; candidates: Candidate[]; units: number; reported: number };
export type ElectionDetail = { election: Election; contests: Contest[]; stations: number; pending: number };

export type ImportReport = {
  rows: number;
  applied: number;
  pending: number;
  unchanged: number;
  skipped: number;
  locked: number;
  errorCount: number;
  errors: { line: number; message: string }[];
  warnings: { line: number; message: string }[];
  dryRun?: boolean;
};

export const STATUS_LABEL = { draft: '草稿', live: '開票中', final: '開票完成' } as const;
export const TYPE_LABEL = { president: '總統副總統', mayor: '直轄市長、縣市長' } as const;
export const LEVEL_LABEL = { county: '縣市', town: '鄉鎮市區', station: '投開票所' } as const;
export const SOURCE_LABEL: Record<string, string> = { admin: '後台輸入', reporter: '回報員', import: '批次匯入', auto: '自動讀取' };
