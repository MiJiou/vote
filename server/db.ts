import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type DB = DatabaseSync;

// 主鍵一律 AUTOINCREMENT：刪除後編號不會被重複使用，舊連結與舊紀錄不會指到新資料。
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'reporter')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS elections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('president', 'mayor')),
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'final')),
  unit_level TEXT NOT NULL DEFAULT 'town' CHECK (unit_level IN ('county', 'town', 'station')),
  auto_approve_reports INTEGER NOT NULL DEFAULT 0,
  source_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  area_code TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_contests_election ON contests(election_id);
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  running_mate TEXT NOT NULL DEFAULT '',
  party TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  UNIQUE (contest_id, number)
);
CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  town_code TEXT NOT NULL,
  station_no TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  village TEXT NOT NULL DEFAULT '',
  eligible_voters INTEGER,
  UNIQUE (election_id, town_code, station_no)
);
-- 每一次回報／匯入／自動讀取都留一筆紀錄，永不覆寫，作為稽核軌跡。
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  unit_code TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('admin', 'reporter', 'import', 'auto')),
  source_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'superseded', 'cleared')),
  votes TEXT NOT NULL,
  invalid_votes INTEGER,
  eligible_voters INTEGER,
  stations_total INTEGER,
  stations_counted INTEGER,
  note TEXT NOT NULL DEFAULT '',
  submitted_by INTEGER,
  submitted_at TEXT NOT NULL,
  reviewed_by INTEGER,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_unit ON submissions(contest_id, unit_code, id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, id);
-- 目前生效的票數：每個統計單位一筆，指向被採用的 submission。
CREATE TABLE IF NOT EXISTS results (
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  unit_code TEXT NOT NULL,
  submission_id INTEGER NOT NULL,
  votes TEXT NOT NULL,
  invalid_votes INTEGER,
  eligible_voters INTEGER,
  stations_total INTEGER,
  stations_counted INTEGER,
  source TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (contest_id, unit_code)
);
CREATE TABLE IF NOT EXISTS data_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('csv_url', 'json_url', 'cec_db', 'push')),
  url TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  interval_sec INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT,
  last_run_at TEXT,
  last_ok INTEGER,
  last_message TEXT NOT NULL DEFAULT '',
  last_hash TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS assignments (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  area_code TEXT NOT NULL,
  PRIMARY KEY (user_id, election_id, area_code)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id INTEGER,
  username TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function addColumn(db: DB, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** 版本升級：舊資料庫啟動時自動補上新欄位，不需要手動處理。 */
function migrate(db: DB): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version < 1) {
    // 轉播版面：候選人照片、個別宣布當選、每場選舉的轉播設定（快訊標題、焦點選舉區…）。
    addColumn(db, 'candidates', 'declared', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'candidates', 'photo_version', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'elections', 'tv', "TEXT NOT NULL DEFAULT '{}'");
    db.exec(`CREATE TABLE IF NOT EXISTS candidate_photos (
      candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      data BLOB NOT NULL
    )`);
    db.exec('PRAGMA user_version = 1');
  }
  if (version < 2) {
    // 照片出處（作者／授權），自由授權的照片必須在畫面上標示。
    addColumn(db, 'candidates', 'photo_credit', "TEXT NOT NULL DEFAULT ''");
    db.exec('PRAGMA user_version = 2');
  }
}

const depth = new WeakMap<DB, number>();

/** 交易；可巢狀呼叫，只有最外層會真正 BEGIN/COMMIT。 */
export function tx<T>(db: DB, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try {
      return fn();
    } finally {
      depth.set(db, d);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

class Rollback extends Error {}

/** 執行後一律回復，用於匯入的「預覽」。 */
export function dryRun<T>(db: DB, fn: () => T): T {
  let out!: T;
  try {
    tx(db, () => {
      out = fn();
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out;
}

export type Area = {
  code: string;
  name: string;
  level: 'county' | 'town';
  parent: string | null;
  kind?: 'municipality' | 'county';
};

export const NATION = '00000';

/** 行政區是固定資料，啟動時載入記憶體即可。 */
export class Areas {
  list: Area[];
  byCode = new Map<string, Area>();
  counties: Area[];
  townsOf = new Map<string, Area[]>();

  constructor(list?: Area[]) {
    this.list = list ?? JSON.parse(readFileSync(resolve(import.meta.dirname, 'data/areas.json'), 'utf8'));
    for (const a of this.list) this.byCode.set(a.code, a);
    this.counties = this.list.filter((a) => a.level === 'county');
    for (const c of this.counties) this.townsOf.set(c.code, []);
    for (const a of this.list) if (a.level === 'town') this.townsOf.get(a.parent!)!.push(a);
  }

  name(code: string): string {
    return code === NATION ? '全國' : (this.byCode.get(code)?.name ?? code);
  }
}
