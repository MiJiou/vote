import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { NATION, dryRun, tx } from './db.ts';
import type { Ctx, Election, Role } from './domain.ts';
import { audit, createElection, getContest, getElection, listCandidates, listContests, listUnits, parseTv, upsertCandidate } from './domain.ts';
import { decodePhoto } from './photos.ts';
import { fetchCommonsImage, findPhotos } from './commons.ts';
import { checkConfig, fetchPage, parseCecPage, parseConfig, pageUrl } from './ceclive.ts';
import { createUser, getUser, newToken, setPassword, sha256 } from './auth.ts';
import { adminUnits, clearResult, findUnit, reviewSubmission, setLock, submitResult } from './results.ts';
import type { ResultInput } from './results.ts';
import { candidatesCsv, importCandidates, importStations, importTable, resultsCsv, stationsCsv } from './importer.ts';
import type { DataSource, SourceKind } from './sources.ts';
import { MIN_INTERVAL, cecElections, createFromCec, runSource } from './sources.ts';
import { requireUser, toId, unitLabel } from './http.ts';
import { HttpError, asInt, parseCsv } from './util.ts';

/** 匯入類 API 的輸入：CSV 文字，或已解析好的表格（前端解析 Excel 後送來）。 */
function tableOf(body: unknown): string[][] {
  const b = (body ?? {}) as { csv?: unknown; table?: unknown };
  if (typeof b.csv === 'string') return parseCsv(b.csv);
  if (Array.isArray(b.table) && b.table.every((r) => Array.isArray(r))) {
    return (b.table as unknown[][]).map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c)))).filter((r) => r.some((c) => c.trim() !== ''));
  }
  throw new HttpError(400, '缺少要匯入的資料');
}

function csvReply(reply: FastifyReply, filename: string, csv: string) {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .send(csv);
}

export function registerAdmin(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const admin = (req: FastifyRequest) => requireUser(req, 'admin');
  const param = (req: FastifyRequest, key: string) => (req.params as Record<string, string>)[key];

  // ---------- 選舉 ----------

  app.get('/api/admin/elections', async (req) => {
    admin(req);
    return db
      .prepare(
        `SELECT e.*,
           (SELECT COUNT(*) FROM contests c WHERE c.election_id = e.id) AS contests,
           (SELECT COUNT(*) FROM candidates k JOIN contests c ON c.id = k.contest_id WHERE c.election_id = e.id) AS candidates,
           (SELECT COUNT(*) FROM results r JOIN contests c ON c.id = r.contest_id WHERE c.election_id = e.id) AS results,
           (SELECT COUNT(*) FROM submissions s JOIN contests c ON c.id = s.contest_id WHERE c.election_id = e.id AND s.status = 'pending') AS pending
         FROM elections e ORDER BY e.date DESC, e.id DESC`,
      )
      .all();
  });

  app.post('/api/admin/elections', async (req) => {
    const user = admin(req);
    const election = createElection(ctx, (req.body ?? {}) as Parameters<typeof createElection>[1]);
    audit(ctx, user, 'election.create', { id: election.id, name: election.name });
    return election;
  });

  app.get('/api/admin/elections/:id', async (req) => {
    admin(req);
    const election = getElection(ctx, toId(param(req, 'id')));
    const reported = new Map(
      (db.prepare('SELECT contest_id, COUNT(*) AS n FROM results r JOIN contests c ON c.id = r.contest_id WHERE c.election_id = ? GROUP BY contest_id').all(election.id) as { contest_id: number; n: number }[]).map(
        (r) => [r.contest_id, r.n],
      ),
    );
    const count = (sql: string) => (db.prepare(sql).get(election.id) as { n: number }).n;
    return {
      election,
      contests: listContests(ctx, election.id).map((c) => ({
        ...c,
        areaName: ctx.areas.name(c.area_code),
        candidates: listCandidates(ctx, c.id),
        units: listUnits(ctx, election, c).length,
        reported: reported.get(c.id) ?? 0,
      })),
      stations: count('SELECT COUNT(*) AS n FROM stations WHERE election_id = ?'),
      pending: count("SELECT COUNT(*) AS n FROM submissions s JOIN contests c ON c.id = s.contest_id WHERE c.election_id = ? AND s.status = 'pending'"),
    };
  });

  app.patch('/api/admin/elections/:id', async (req) => {
    const user = admin(req);
    const election = getElection(ctx, toId(param(req, 'id')));
    const b = (req.body ?? {}) as Partial<Election>;
    const next = { ...election };
    if (b.name !== undefined) {
      if (!String(b.name).trim()) throw new HttpError(400, '請輸入選舉名稱');
      next.name = String(b.name).trim();
    }
    if (b.date !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) throw new HttpError(400, '投票日格式應為 YYYY-MM-DD');
      next.date = b.date;
    }
    if (b.status !== undefined) {
      if (!['draft', 'live', 'final'].includes(b.status)) throw new HttpError(400, '狀態不正確');
      next.status = b.status;
    }
    if (b.unit_level !== undefined && b.unit_level !== election.unit_level) {
      if (!['county', 'town', 'station'].includes(b.unit_level)) throw new HttpError(400, '統計層級不正確');
      const has = db.prepare('SELECT 1 FROM results r JOIN contests c ON c.id = r.contest_id WHERE c.election_id = ? LIMIT 1').get(election.id);
      if (has) throw new HttpError(409, '這場選舉已經有票數資料，請先清除全部票數再變更統計層級');
      next.unit_level = b.unit_level;
    }
    if (b.auto_approve_reports !== undefined) next.auto_approve_reports = b.auto_approve_reports ? 1 : 0;
    if (b.auto_live_at !== undefined) {
      const v = String(b.auto_live_at ?? '').trim();
      if (v && Number.isNaN(Date.parse(v))) throw new HttpError(400, '自動公開時間格式不正確');
      next.auto_live_at = v ? new Date(v).toISOString() : '';
    }
    if (b.auto_final !== undefined) next.auto_final = b.auto_final ? 1 : 0;
    // 手動改狀態時取消排定的自動公開，避免改回草稿後又被自動公開。
    if (b.status !== undefined && b.status !== election.status && b.auto_live_at === undefined) next.auto_live_at = '';
    if (b.source_note !== undefined) next.source_note = String(b.source_note).slice(0, 300);
    const tv = (b as { tv?: unknown }).tv;
    if (tv !== undefined) {
      // 轉播設定：只留下合法的欄位，焦點選舉區必須屬於這場選舉。
      const clean = parseTv(JSON.stringify({ ...parseTv(election.tv), ...(tv as object) }));
      const own = new Set(listContests(ctx, election.id).map((c) => c.id));
      clean.focus = clean.focus.filter((id) => own.has(id));
      clean.headline = clean.headline.trim();
      next.tv = JSON.stringify(clean);
    }
    db.prepare(
      'UPDATE elections SET name = ?, date = ?, status = ?, unit_level = ?, auto_approve_reports = ?, source_note = ?, tv = ?, auto_live_at = ?, auto_final = ? WHERE id = ?',
    ).run(next.name, next.date, next.status, next.unit_level, next.auto_approve_reports, next.source_note, next.tv, next.auto_live_at, next.auto_final, election.id);
    audit(ctx, user, 'election.update', { id: election.id, changes: b });
    ctx.bus.bump(election.id);
    return getElection(ctx, election.id);
  });

  app.delete('/api/admin/elections/:id', async (req) => {
    const user = admin(req);
    const election = getElection(ctx, toId(param(req, 'id')));
    db.prepare('DELETE FROM elections WHERE id = ?').run(election.id);
    audit(ctx, user, 'election.delete', { id: election.id, name: election.name });
    ctx.bus.bump(election.id);
    return { ok: true };
  });

  app.post('/api/admin/elections/:id/reset-results', async (req) => {
    const user = admin(req);
    const election = getElection(ctx, toId(param(req, 'id')));
    const cleared = tx(db, () => {
      const ids = 'SELECT id FROM contests WHERE election_id = ?';
      db.prepare(`UPDATE submissions SET status = 'cleared' WHERE status IN ('approved', 'pending') AND contest_id IN (${ids})`).run(election.id);
      const r = db.prepare(`DELETE FROM results WHERE contest_id IN (${ids})`).run(election.id);
      db.prepare("UPDATE data_sources SET last_hash = '' WHERE election_id = ?").run(election.id);
      return Number(r.changes);
    });
    audit(ctx, user, 'election.reset_results', { id: election.id, name: election.name, cleared });
    ctx.bus.bump(election.id);
    return { cleared };
  });

  // ---------- 候選人 ----------

  app.post('/api/admin/contests/:cid/candidates', async (req) => {
    const user = admin(req);
    const contest = getContest(ctx, toId(param(req, 'cid')));
    const c = upsertCandidate(ctx, contest, (req.body ?? {}) as Parameters<typeof upsertCandidate>[2]);
    audit(ctx, user, 'candidate.create', { contest: contest.name, number: c.number, name: c.name });
    return c;
  });

  app.patch('/api/admin/candidates/:id', async (req) => {
    const user = admin(req);
    const id = toId(param(req, 'id'));
    const row = db.prepare('SELECT contest_id FROM candidates WHERE id = ?').get(id) as { contest_id: number } | undefined;
    if (!row) throw new HttpError(404, '找不到這位候選人');
    const contest = getContest(ctx, row.contest_id);
    const c = upsertCandidate(ctx, contest, (req.body ?? {}) as Parameters<typeof upsertCandidate>[2], id);
    audit(ctx, user, 'candidate.update', { contest: contest.name, number: c.number, name: c.name });
    return c;
  });

  app.delete('/api/admin/candidates/:id', async (req) => {
    const user = admin(req);
    const id = toId(param(req, 'id'));
    const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as { contest_id: number; name: string } | undefined;
    if (!row) throw new HttpError(404, '找不到這位候選人');
    const contest = getContest(ctx, row.contest_id);
    if (db.prepare('SELECT 1 FROM results WHERE contest_id = ? LIMIT 1').get(contest.id)) {
      throw new HttpError(409, '這個選舉區已經有票數，無法刪除候選人；請先清除該選舉區的票數');
    }
    db.prepare('DELETE FROM candidates WHERE id = ?').run(id);
    audit(ctx, user, 'candidate.delete', { contest: contest.name, name: row.name });
    ctx.bus.bump(contest.election_id);
    return { ok: true };
  });

  // 照片、宣布當選：轉播版面會用到。
  const candidateOf = (req: FastifyRequest) => {
    const id = toId(param(req, 'id'));
    const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as { id: number; contest_id: number; name: string; number: number } | undefined;
    if (!row) throw new HttpError(404, '找不到這位候選人');
    return { cand: row, contest: getContest(ctx, row.contest_id) };
  };

  app.put('/api/admin/candidates/:id/photo', async (req) => {
    const user = admin(req);
    const { cand, contest } = candidateOf(req);
    const body = (req.body ?? {}) as { dataUrl?: unknown; credit?: unknown };
    const { mime, data } = decodePhoto(body.dataUrl);
    const credit = typeof body.credit === 'string' ? body.credit.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const version = Date.now().toString(36);
    tx(db, () => {
      db.prepare('INSERT INTO candidate_photos (candidate_id, mime, data) VALUES (?, ?, ?) ON CONFLICT (candidate_id) DO UPDATE SET mime = excluded.mime, data = excluded.data').run(cand.id, mime, data);
      db.prepare('UPDATE candidates SET photo_version = ?, photo_credit = ? WHERE id = ?').run(version, credit, cand.id);
    });
    audit(ctx, user, 'candidate.photo', { contest: contest.name, name: cand.name, bytes: data.length, credit });
    ctx.bus.bump(contest.election_id);
    return { photo: `/api/candidates/${cand.id}/photo?v=${version}` };
  });

  app.delete('/api/admin/candidates/:id/photo', async (req) => {
    const user = admin(req);
    const { cand, contest } = candidateOf(req);
    tx(db, () => {
      db.prepare('DELETE FROM candidate_photos WHERE candidate_id = ?').run(cand.id);
      db.prepare("UPDATE candidates SET photo_version = '', photo_credit = '' WHERE id = ?").run(cand.id);
    });
    audit(ctx, user, 'candidate.photo_remove', { contest: contest.name, name: cand.name });
    ctx.bus.bump(contest.election_id);
    return { ok: true };
  });

  // 從維基共享資源找照片：先列出候選照片給管理員確認，確認後才下載、裁切、上傳。
  app.get('/api/admin/elections/:id/commons-photos', async (req) => {
    admin(req);
    const election = getElection(ctx, toId(param(req, 'id')));
    const all = (req.query as { all?: string }).all === '1';
    const rows = db
      .prepare(
        `SELECT k.id, k.number, k.name, k.party, k.photo_version, c.id AS contest_id, c.name AS contest_name, c.area_code
         FROM candidates k JOIN contests c ON c.id = k.contest_id WHERE c.election_id = ? ORDER BY c.sort, c.id, k.number`,
      )
      .all(election.id) as { id: number; number: number; name: string; party: string; photo_version: string; contest_id: number; contest_name: string; area_code: string }[];
    const wanted = rows.filter((r) => all || !r.photo_version);
    if (!wanted.length) return { candidates: [], excluded: 0 };
    const { matches, excluded } = await findPhotos(wanted.map((r) => r.name));
    return {
      excluded,
      candidates: wanted.map((r) => ({
        id: r.id,
        number: r.number,
        name: r.name,
        party: r.party,
        contestName: r.contest_name,
        areaName: ctx.areas.name(r.area_code),
        hasPhoto: !!r.photo_version,
        matches: matches.get(r.name) ?? [],
      })),
    };
  });

  app.get('/api/admin/commons/image', async (req, reply) => {
    admin(req);
    const { mime, data } = await fetchCommonsImage((req.query as { file?: unknown }).file);
    return reply.header('content-type', mime).header('cache-control', 'private, max-age=600').header('x-content-type-options', 'nosniff').send(data);
  });

  app.post('/api/admin/candidates/:id/declare', async (req) => {
    const user = admin(req);
    const { cand, contest } = candidateOf(req);
    const declared = !!(req.body as { declared?: boolean })?.declared;
    db.prepare('UPDATE candidates SET declared = ? WHERE id = ?').run(declared ? 1 : 0, cand.id);
    audit(ctx, user, declared ? 'candidate.declare' : 'candidate.undeclare', { contest: contest.name, number: cand.number, name: cand.name });
    ctx.bus.bump(contest.election_id);
    return { ok: true };
  });

  app.post('/api/admin/elections/:id/candidates/import', async (req) => {
    const user = admin(req);
    return importCandidates(ctx, getElection(ctx, toId(param(req, 'id'))), tableOf(req.body), user);
  });

  // ---------- 投開票所清冊 ----------

  app.post('/api/admin/elections/:id/stations/import', async (req) => {
    const user = admin(req);
    return importStations(ctx, getElection(ctx, toId(param(req, 'id'))), tableOf(req.body), user);
  });

  app.delete('/api/admin/elections/:id/stations', async (req) => {
    const user = admin(req);
    const election = getElection(ctx, toId(param(req, 'id')));
    const removed = tx(db, () => {
      db.prepare("DELETE FROM results WHERE unit_code LIKE '%-%' AND contest_id IN (SELECT id FROM contests WHERE election_id = ?)").run(election.id);
      return Number(db.prepare('DELETE FROM stations WHERE election_id = ?').run(election.id).changes);
    });
    audit(ctx, user, 'stations.clear', { election: election.name, removed });
    ctx.bus.bump(election.id);
    return { removed };
  });

  // ---------- 匯出／範本 ----------

  app.get('/api/admin/elections/:id/export/:what', async (req, reply) => {
    admin(req);
    const election = getElection(ctx, toId(param(req, 'id')));
    switch (param(req, 'what')) {
      case 'results-template.csv':
        return csvReply(reply, `${election.name}-票數範本.csv`, resultsCsv(ctx, election, false));
      case 'results.csv':
        return csvReply(reply, `${election.name}-票數.csv`, resultsCsv(ctx, election, true));
      case 'stations.csv':
        return csvReply(reply, `${election.name}-投開票所.csv`, stationsCsv(ctx, election));
      case 'candidates.csv':
        return csvReply(reply, `${election.name}-候選人.csv`, candidatesCsv(ctx, election));
      default:
        throw new HttpError(404, '沒有這個匯出項目');
    }
  });

  // ---------- 票數：後台輸入與批次匯入 ----------

  app.get('/api/admin/contests/:cid/units', async (req) => {
    admin(req);
    const contest = getContest(ctx, toId(param(req, 'cid')));
    const parent = (req.query as { parent?: string }).parent || null;
    return { candidates: listCandidates(ctx, contest.id), units: adminUnits(ctx, contest, parent) };
  });

  app.put('/api/admin/contests/:cid/units/:code', async (req) => {
    const user = admin(req);
    const contest = getContest(ctx, toId(param(req, 'cid')));
    const election = getElection(ctx, contest.election_id);
    const unit = findUnit(ctx, election, contest, param(req, 'code'));
    const body = (req.body ?? {}) as ResultInput & { lock?: boolean };
    const out = submitResult(ctx, {
      election, contest, unit, candidates: listCandidates(ctx, contest.id), input: body,
      source: 'admin', user, approve: true, lock: body.lock,
    });
    if (out.status === 'approved') audit(ctx, user, 'result.set', { contest: contest.name, unit: unit.code, submission: out.id });
    return out;
  });

  app.delete('/api/admin/contests/:cid/units/:code', async (req) => {
    const user = admin(req);
    clearResult(ctx, getContest(ctx, toId(param(req, 'cid'))), param(req, 'code'), user);
    return { ok: true };
  });

  app.post('/api/admin/contests/:cid/units/:code/lock', async (req) => {
    const user = admin(req);
    setLock(ctx, getContest(ctx, toId(param(req, 'cid'))), param(req, 'code'), !!(req.body as { locked?: boolean })?.locked, user);
    return { ok: true };
  });

  app.get('/api/admin/contests/:cid/units/:code/history', async (req) => {
    admin(req);
    const contest = getContest(ctx, toId(param(req, 'cid')));
    const rows = db
      .prepare(
        `SELECT s.*, u.username, u.display_name FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by
         WHERE s.contest_id = ? AND s.unit_code = ? ORDER BY s.id DESC LIMIT 50`,
      )
      .all(contest.id, param(req, 'code')) as Record<string, unknown>[];
    return rows.map((r) => ({ ...r, votes: JSON.parse(r.votes as string) }));
  });

  app.post('/api/admin/elections/:id/import', async (req) => {
    const user = admin(req);
    const election = getElection(ctx, toId(param(req, 'id')));
    const table = tableOf(req.body);
    const preview = !!(req.body as { dryRun?: boolean }).dryRun;
    const run = () => importTable(ctx, election, table, { source: 'import', sourceRef: (req.body as { filename?: string }).filename?.slice(0, 120) ?? '', user, respectLock: true });
    // 預覽：實際跑一遍再整批回復，回報內容與正式匯入完全一致。
    if (preview) return { ...dryRun(db, run), dryRun: true };
    const report = run();
    audit(ctx, user, 'results.import', { election: election.name, applied: report.applied, errors: report.errorCount });
    return { ...report, dryRun: false };
  });

  // ---------- 回報審核 ----------

  app.get('/api/admin/submissions', async (req) => {
    admin(req);
    const q = req.query as { election?: string; status?: string; limit?: string };
    const status = ['pending', 'approved', 'rejected', 'superseded', 'cleared'].includes(q.status ?? '') ? q.status! : 'pending';
    const limit = Math.min(Number(q.limit) || 200, 500);
    const rows = db
      .prepare(
        `SELECT s.*, c.name AS contest_name, c.election_id, u.username, u.display_name,
                r.votes AS current_votes, r.invalid_votes AS current_invalid, r.locked AS current_locked
         FROM submissions s
         JOIN contests c ON c.id = s.contest_id
         LEFT JOIN users u ON u.id = s.submitted_by
         LEFT JOIN results r ON r.contest_id = s.contest_id AND r.unit_code = s.unit_code
         WHERE s.status = ? AND (? IS NULL OR c.election_id = ?)
         ORDER BY s.id ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT ?`,
      )
      .all(status, q.election ? toId(q.election) : null, q.election ? toId(q.election) : null, limit) as Record<string, unknown>[];
    const candCache = new Map<number, ReturnType<typeof listCandidates>>();
    return rows.map((r) => {
      const cid = r.contest_id as number;
      if (!candCache.has(cid)) candCache.set(cid, listCandidates(ctx, cid));
      return {
        ...r,
        votes: JSON.parse(r.votes as string),
        current_votes: r.current_votes ? JSON.parse(r.current_votes as string) : null,
        unit_name: unitLabel(ctx, r.unit_code as string),
        candidates: candCache.get(cid)!.map((c) => ({ id: c.id, number: c.number, name: c.name, color: c.color })),
      };
    });
  });

  app.post('/api/admin/submissions/:id/:action', async (req) => {
    const user = admin(req);
    const action = param(req, 'action');
    if (action !== 'approve' && action !== 'reject') throw new HttpError(404, '沒有這個動作');
    return reviewSubmission(ctx, toId(param(req, 'id')), action, user);
  });

  // ---------- 自動讀取來源 ----------

  const getSource = (id: number): DataSource => {
    const s = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(id) as DataSource | undefined;
    if (!s) throw new HttpError(404, '找不到這個資料來源');
    return s;
  };
  const publicSource = (s: DataSource) => ({ ...s, token_hash: undefined, last_hash: undefined, hasToken: !!s.token_hash, config: JSON.parse(s.config || '{}') });

  function cleanSource(b: Partial<Omit<DataSource, 'config'>> & { config?: unknown }, kind: SourceKind) {
    const name = String(b.name ?? '').trim();
    if (!name) throw new HttpError(400, '請輸入來源名稱');
    let url = String(b.url ?? '').trim();
    let config = typeof b.config === 'string' ? b.config : JSON.stringify(b.config ?? {});
    if (kind === 'csv_url' || kind === 'json_url') {
      if (!/^https?:\/\//i.test(url)) throw new HttpError(400, '請輸入 http(s) 開頭的網址');
    }
    if (kind === 'cec_live') {
      const c = checkConfig(parseConfig(config));
      config = JSON.stringify(c);
      url = c.base;
    }
    const interval = Math.max(Number(b.interval_sec) || 60, MIN_INTERVAL[kind]);
    return { name, url, config, interval, enabled: b.enabled ? 1 : 0 };
  }

  app.get('/api/admin/elections/:id/sources', async (req) => {
    admin(req);
    const rows = db.prepare('SELECT * FROM data_sources WHERE election_id = ? ORDER BY id').all(toId(param(req, 'id'))) as DataSource[];
    return rows.map(publicSource);
  });

  app.post('/api/admin/elections/:id/sources', async (req) => {
    const user = admin(req);
    const election = getElection(ctx, toId(param(req, 'id')));
    const b = (req.body ?? {}) as Partial<DataSource>;
    const kind = b.kind as SourceKind;
    if (!['csv_url', 'json_url', 'cec_live', 'push'].includes(kind)) throw new HttpError(400, '來源類型不正確');
    const c = cleanSource(b, kind);
    const token = kind === 'push' ? newToken() : null;
    const r = db
      .prepare('INSERT INTO data_sources (election_id, name, kind, url, config, interval_sec, enabled, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(election.id, c.name, kind, c.url, c.config, c.interval, c.enabled, token ? sha256(token) : null);
    audit(ctx, user, 'source.create', { election: election.name, name: c.name, kind });
    return { ...publicSource(getSource(asInt(r.lastInsertRowid)!)), token };
  });

  app.patch('/api/admin/sources/:id', async (req) => {
    const user = admin(req);
    const s = getSource(toId(param(req, 'id')));
    const c = cleanSource({ ...s, ...((req.body ?? {}) as Partial<DataSource>) }, s.kind);
    // 換了網址或設定就清掉內容雜湊，下一次一定重新讀取。
    db.prepare(
      "UPDATE data_sources SET name = ?, url = ?, config = ?, interval_sec = ?, enabled = ?, last_hash = CASE WHEN url = ? AND config = ? THEN last_hash ELSE '' END WHERE id = ?",
    ).run(c.name, c.url, c.config, c.interval, c.enabled, c.url, c.config, s.id);
    audit(ctx, user, 'source.update', { id: s.id, name: c.name, enabled: c.enabled });
    return publicSource(getSource(s.id));
  });

  // 試讀中選會開票網站的一頁：只解析、不寫入，讓管理員在選舉當天先確認網址與格式。
  app.post('/api/admin/elections/:id/cec-live/preview', async (req) => {
    admin(req);
    const election = getElection(ctx, toId(param(req, 'id')));
    const b = (req.body ?? {}) as { base?: string; prefix?: string; code?: string };
    const config = checkConfig(parseConfig(JSON.stringify({ base: b.base, prefix: b.prefix })));
    const contests = listContests(ctx, election.id);
    const code = b.code && ctx.areas.byCode.has(b.code) ? b.code : contests[0]?.area_code === '00000' ? '63000' : contests[0]?.area_code;
    if (!code) throw new HttpError(400, '這場選舉還沒有選舉區');
    const contest = contests.find((c) => c.area_code === code || c.area_code === '00000');
    const mine = contest ? listCandidates(ctx, contest.id) : [];
    try {
      const { url, html } = await fetchPage(config, code);
      const page = parseCecPage(html);
      return {
        url, areaName: ctx.areas.name(code), page,
        candidates: page.candidates.map((p) => ({ ...p, ours: mine.find((m) => m.number === p.number)?.name ?? null })),
        sum: page.candidates.reduce((s, p) => s + p.votes, 0),
      };
    } catch (err) {
      throw new HttpError(502, `讀取 ${pageUrl(config, code)} 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  app.delete('/api/admin/sources/:id', async (req) => {
    const user = admin(req);
    const s = getSource(toId(param(req, 'id')));
    db.prepare('DELETE FROM data_sources WHERE id = ?').run(s.id);
    audit(ctx, user, 'source.delete', { id: s.id, name: s.name });
    return { ok: true };
  });

  app.post('/api/admin/sources/:id/run', async (req) => {
    const user = admin(req);
    const s = getSource(toId(param(req, 'id')));
    const result = await runSource(ctx, s, true);
    audit(ctx, user, 'source.run', { id: s.id, name: s.name, message: result.message });
    return { ...result, source: publicSource(getSource(s.id)) };
  });

  app.post('/api/admin/sources/:id/token', async (req) => {
    const user = admin(req);
    const s = getSource(toId(param(req, 'id')));
    if (s.kind !== 'push') throw new HttpError(400, '只有「API 推送」來源需要權杖');
    const token = newToken();
    db.prepare('UPDATE data_sources SET token_hash = ? WHERE id = ?').run(sha256(token), s.id);
    audit(ctx, user, 'source.token', { id: s.id, name: s.name });
    return { token };
  });

  // ---------- 中選會選舉資料庫 ----------

  app.get('/api/admin/cec/elections', async (req) => {
    admin(req);
    const type = (req.query as { type?: string }).type === 'mayor' ? 'mayor' : 'president';
    return cecElections(type);
  });

  app.post('/api/admin/cec/import', async (req) => {
    const user = admin(req);
    const b = (req.body ?? {}) as Parameters<typeof createFromCec>[1];
    return createFromCec(ctx, b, user);
  });

  // ---------- 帳號 ----------

  app.get('/api/admin/users', async (req) => {
    admin(req);
    const users = db.prepare('SELECT id, username, display_name, role, active, created_at FROM users ORDER BY role, username').all() as Record<string, unknown>[];
    const assigns = db.prepare('SELECT * FROM assignments').all() as { user_id: number; election_id: number; area_code: string }[];
    return users.map((u) => ({
      ...u,
      assignments: assigns.filter((a) => a.user_id === u.id).map((a) => ({ electionId: a.election_id, areaCode: a.area_code, areaName: unitLabel(ctx, a.area_code) })),
    }));
  });

  app.post('/api/admin/users', async (req) => {
    const user = admin(req);
    const b = (req.body ?? {}) as { username: string; password: string; role: Role; display_name?: string };
    const created = createUser(ctx, b);
    audit(ctx, user, 'user.create', { username: created.username, role: created.role });
    return created;
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const user = admin(req);
    const target = getUser(ctx, toId(param(req, 'id')));
    if (!target) throw new HttpError(404, '找不到這個帳號');
    const b = (req.body ?? {}) as { display_name?: string; active?: boolean; password?: string };
    if (b.active === false && target.id === user.id) throw new HttpError(400, '不能停用自己的帳號');
    if (b.display_name !== undefined) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(b.display_name).trim(), target.id);
    if (b.active !== undefined) {
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, target.id);
      if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    }
    if (b.password) setPassword(ctx, target.id, b.password, target.id === user.id ? req.cookies.sid : undefined);
    audit(ctx, user, 'user.update', { username: target.username, fields: Object.keys(b).filter((k) => k !== 'password'), passwordReset: !!b.password });
    return getUser(ctx, target.id);
  });

  app.delete('/api/admin/users/:id', async (req) => {
    const user = admin(req);
    const target = getUser(ctx, toId(param(req, 'id')));
    if (!target) throw new HttpError(404, '找不到這個帳號');
    if (target.id === user.id) throw new HttpError(400, '不能刪除自己的帳號');
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    audit(ctx, user, 'user.delete', { username: target.username });
    return { ok: true };
  });

  app.put('/api/admin/users/:id/assignments', async (req) => {
    const user = admin(req);
    const target = getUser(ctx, toId(param(req, 'id')));
    if (!target) throw new HttpError(404, '找不到這個帳號');
    const b = (req.body ?? {}) as { electionId?: number; areaCodes?: string[] };
    const election = getElection(ctx, toId(b.electionId));
    const codes = [...new Set((b.areaCodes ?? []).map((c) => String(c).trim()).filter(Boolean))];
    for (const code of codes) {
      const base = code.split('-')[0];
      if (code !== NATION && !ctx.areas.byCode.has(base)) throw new HttpError(400, `地區代碼「${code}」不存在`);
    }
    tx(db, () => {
      db.prepare('DELETE FROM assignments WHERE user_id = ? AND election_id = ?').run(target.id, election.id);
      const add = db.prepare('INSERT INTO assignments (user_id, election_id, area_code) VALUES (?, ?, ?)');
      for (const code of codes) add.run(target.id, election.id, code);
    });
    audit(ctx, user, 'user.assign', { username: target.username, election: election.name, areas: codes });
    return { ok: true };
  });

  // ---------- 稽核紀錄 ----------

  app.get('/api/admin/audit', async (req) => {
    admin(req);
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 200, 1000);
    return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  });
}
