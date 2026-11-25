import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import { NATION } from './db.ts';
import type { Ctx, Election, Unit, User } from './domain.ts';
import { audit, getContest, getElection, listCandidates, listContests, listUnits } from './domain.ts';
import { login, logout, sessionUser, setPassword, sha256, verifyPassword } from './auth.ts';
import { cleanInput, drillJson, electionIsPublic, findUnit, submitResult, summaryJson } from './results.ts';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import type { ResultInput } from './results.ts';
import type { DataSource } from './sources.ts';
import { ingest } from './sources.ts';
import { registerAdmin } from './admin.ts';
import { requireUser, toId, unitLabel } from './http.ts';
import { HttpError } from './util.ts';

/** 回報員能否回報某個單位：被指派的範圍涵蓋該單位即可（全國、縣市、鄉鎮市區或單一投開票所）。 */
export function assignedAreas(ctx: Ctx, user: User, electionId: number): Set<string> | 'all' {
  if (user.role === 'admin') return 'all';
  const rows = ctx.db.prepare('SELECT area_code FROM assignments WHERE user_id = ? AND election_id = ?').all(user.id, electionId) as { area_code: string }[];
  const set = new Set(rows.map((r) => r.area_code));
  return set.has(NATION) ? 'all' : set;
}

const covers = (areas: Set<string> | 'all', u: Unit): boolean =>
  areas === 'all' || areas.has(u.code) || areas.has(u.countyCode) || (u.townCode !== null && areas.has(u.townCode));

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.config.logger ? { level: 'warn' } : false,
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: ctx.config.trustProxy,
  });
  await app.register(cookie);
  await app.register(compress, { threshold: 1024 });
  app.addContentTypeParser(['text/csv', 'text/plain'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.statusCode === 413 ? '檔案太大（上限 25 MB）' : '請求格式不正確' });
    }
    req.log.error(err);
    return reply.code(500).send({ error: '伺服器發生錯誤，請稍後再試' });
  });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    req.user = sessionUser(ctx, req.cookies.sid);
    // 防跨站請求：會改資料的請求若帶有 Origin，必須與本站相同（搭配 SameSite Cookie）。
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.url.startsWith('/api/ingest/')) {
      const origin = req.headers.origin;
      if (origin) {
        let host = '';
        try {
          host = new URL(origin).host;
        } catch {
          /* 無法解析的 Origin 一律拒絕 */
        }
        if (host !== req.headers.host) throw new HttpError(403, '來源不被允許');
      }
    }
  });

  // ---------- 公開 API ----------

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/areas', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=3600');
    return ctx.areas.list;
  });

  app.get('/api/elections', async () => {
    const rows = ctx.db
      .prepare("SELECT * FROM elections WHERE status <> 'draft' ORDER BY CASE status WHEN 'live' THEN 0 ELSE 1 END, date DESC, id DESC")
      .all() as Election[];
    return rows.map((e) => ({ id: e.id, name: e.name, type: e.type, date: e.date, status: e.status }));
  });

  const canPreview = (req: FastifyRequest) => req.user?.role === 'admin';

  // 公開資料的壓縮結果依「網址＋資料版本」快取：開票時成千上萬的觀眾抓的是同一份內容，只壓縮一次。
  const packed = new Map<string, { json: string; gzip?: Buffer; br?: Buffer }>();
  const sendJson = (req: FastifyRequest, reply: FastifyReply, electionId: number, json: string) => {
    const etag = `"${ctx.bus.version(electionId)}"`;
    // 已公開的選舉可以讓 CDN 保留幾秒（s-maxage），瀏覽器則每次都要重新確認（max-age=0）。
    // 草稿（只有管理員預覽得到）一律不讓任何快取保存。
    const edge = ctx.config.edgeCacheSeconds;
    const cacheControl = edge > 0 && electionIsPublic(ctx, electionId) ? `public, max-age=0, s-maxage=${edge}` : 'private, no-cache';
    reply.header('etag', etag).header('cache-control', cacheControl).header('vary', 'accept-encoding');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.type('application/json; charset=utf-8');
    const accept = String(req.headers['accept-encoding'] ?? '');
    const encoding = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
    if (!encoding || json.length < 1024) return reply.send(json);
    const key = `${req.url.split('?')[0]}|${etag}`;
    let entry = packed.get(key);
    if (!entry || entry.json !== json) {
      if (packed.size > 2000) packed.clear();
      entry = { json };
      packed.set(key, entry);
    }
    const body =
      encoding === 'br'
        ? (entry.br ??= brotliCompressSync(json, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } }))
        : (entry.gzip ??= gzipSync(json, { level: 6 }));
    return reply.header('content-encoding', encoding).send(body);
  };

  app.get('/api/elections/:id/summary', async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    return sendJson(req, reply, id, summaryJson(ctx, id, canPreview(req)));
  });

  app.get('/api/elections/:id/contests/:cid/areas/:code', async (req, reply) => {
    const p = req.params as { id: string; cid: string; code: string };
    const id = toId(p.id);
    return sendJson(req, reply, id, drillJson(ctx, id, toId(p.cid), p.code, canPreview(req)));
  });

  app.get('/api/candidates/:id/photo', async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    const row = ctx.db.prepare('SELECT mime, data FROM candidate_photos WHERE candidate_id = ?').get(id) as { mime: string; data: Uint8Array } | undefined;
    if (!row) throw new HttpError(404, '這位候選人沒有照片');
    // 網址帶有版本參數，換照片就換網址，所以可以放心長期快取。
    return reply
      .header('content-type', row.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(row.data));
  });

  // 即時推播（Server-Sent Events）：資料一有變動就通知看板重新抓取。
  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const off = ctx.bus.subscribe((electionId, version) => {
      res.write(`event: update\ndata: ${JSON.stringify({ electionId, version })}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      off();
      clearInterval(heartbeat);
    });
  });

  // ---------- 登入 ----------

  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: ctx.config.cookieSecure, maxAge: 7 * 86_400 };

  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const { user, token } = login(ctx, body.username, body.password, req.ip);
    reply.setCookie('sid', token, cookieOptions);
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    logout(ctx, req.cookies.sid);
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user }));

  app.post('/api/auth/password', async (req) => {
    const user = requireUser(req);
    const body = (req.body ?? {}) as { current?: string; next?: string };
    const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (typeof body.current !== 'string' || !verifyPassword(body.current, row.password_hash)) throw new HttpError(400, '目前的密碼不正確');
    setPassword(ctx, user.id, body.next ?? '', req.cookies.sid);
    audit(ctx, user, 'auth.password');
    return { ok: true };
  });

  // ---------- 手機回報 ----------

  app.get('/api/report/elections', async (req) => {
    const user = requireUser(req);
    const rows = ctx.db.prepare("SELECT * FROM elections WHERE status <> 'final' ORDER BY date DESC, id DESC").all() as Election[];
    return rows
      .map((e) => {
        const areas = assignedAreas(ctx, user, e.id);
        return {
          id: e.id,
          name: e.name,
          date: e.date,
          status: e.status,
          areas: areas === 'all' ? [{ code: NATION, name: '全部地區' }] : [...areas].map((code) => ({ code, name: unitLabel(ctx, code) })),
        };
      })
      .filter((e) => e.areas.length);
  });

  app.get('/api/report/elections/:id/units', async (req) => {
    const user = requireUser(req);
    const election = getElection(ctx, toId((req.params as { id: string }).id));
    if (election.status === 'final') throw new HttpError(409, '這場選舉已結束，無法再回報');
    const areas = assignedAreas(ctx, user, election.id);
    const mine = new Map(
      (
        ctx.db
          .prepare(
            `SELECT s.contest_id, s.unit_code, s.status, s.submitted_at FROM submissions s
             JOIN (SELECT MAX(id) AS id FROM submissions WHERE submitted_by = ? GROUP BY contest_id, unit_code) m ON m.id = s.id`,
          )
          .all(user.id) as { contest_id: number; unit_code: string; status: string; submitted_at: string }[]
      ).map((r) => [`${r.contest_id}|${r.unit_code}`, r]),
    );
    const contests = [];
    const units = [];
    for (const contest of listContests(ctx, election.id)) {
      const list = listUnits(ctx, election, contest).filter((u) => covers(areas, u));
      if (!list.length) continue;
      contests.push({ id: contest.id, name: contest.name, candidates: listCandidates(ctx, contest.id).map((c) => ({ id: c.id, number: c.number, name: c.name, party: c.party, color: c.color })) });
      for (const u of list) {
        const last = mine.get(`${contest.id}|${u.code}`);
        units.push({
          contestId: contest.id,
          code: u.code,
          name: u.name,
          level: u.level,
          area: [ctx.areas.name(u.countyCode), u.townCode && u.level !== 'town' ? ctx.areas.name(u.townCode) : ''].filter(Boolean).join(' '),
          eligible: u.eligible,
          last: last ? { status: last.status, at: last.submitted_at } : null,
        });
      }
    }
    return { election: { id: election.id, name: election.name, status: election.status, unitLevel: election.unit_level }, contests, units };
  });

  app.post('/api/report/submit', async (req) => {
    const user = requireUser(req);
    const body = (req.body ?? {}) as ResultInput & { contestId?: number; unitCode?: string };
    const contest = getContest(ctx, toId(body.contestId));
    const election = getElection(ctx, contest.election_id);
    if (election.status === 'final') throw new HttpError(409, '這場選舉已結束，無法再回報');
    const unit = findUnit(ctx, election, contest, String(body.unitCode ?? ''));
    if (!covers(assignedAreas(ctx, user, election.id), unit)) throw new HttpError(403, '這個單位不在你的回報範圍內');
    const candidates = listCandidates(ctx, contest.id);
    // 有合理性警示的回報一律送人工審核，即使這場選舉開啟了自動核准。
    const { warnings } = cleanInput(candidates, unit, body);
    const approve = (!!election.auto_approve_reports || user.role === 'admin') && !warnings.length;
    const params = { election, contest, unit, candidates, input: body, source: user.role === 'admin' ? ('admin' as const) : ('reporter' as const), user };
    let out = submitResult(ctx, { ...params, approve, respectLock: true });
    // 已被管理員鎖定的單位不直接覆蓋，改送審核。
    if (out.status === 'locked') out = submitResult(ctx, { ...params, approve: false });
    return { status: out.status, warnings: out.warnings };
  });

  app.get('/api/report/mine', async (req) => {
    const user = requireUser(req);
    const rows = ctx.db
      .prepare(
        `SELECT s.id, s.unit_code, s.status, s.submitted_at, s.votes, s.invalid_votes, c.name AS contest_name
         FROM submissions s JOIN contests c ON c.id = s.contest_id WHERE s.submitted_by = ? ORDER BY s.id DESC LIMIT 50`,
      )
      .all(user.id) as { id: number; unit_code: string; status: string; submitted_at: string; votes: string; invalid_votes: number | null; contest_name: string }[];
    return rows.map((r) => ({
      id: r.id,
      unit: unitLabel(ctx, r.unit_code),
      contest: r.contest_name,
      status: r.status,
      at: r.submitted_at,
      total: Object.values(JSON.parse(r.votes) as Record<string, number>).reduce((a, b) => a + b, 0) + (r.invalid_votes ?? 0),
    }));
  });

  // ---------- 外部程式推送 ----------

  app.post('/api/ingest/:sourceId', async (req) => {
    const id = toId((req.params as { sourceId: string }).sourceId);
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const source = ctx.db.prepare("SELECT * FROM data_sources WHERE id = ? AND kind = 'push'").get(id) as DataSource | undefined;
    if (!token || !source?.token_hash || sha256(token) !== source.token_hash) throw new HttpError(401, '權杖不正確');
    if (!source.enabled) throw new HttpError(403, '這個資料來源目前停用中');
    const isCsv = typeof req.body === 'string';
    const report = ingest(ctx, source, req.body, isCsv);
    return report;
  });

  registerAdmin(app, ctx);

  // ---------- 前端靜態檔 ----------

  if (existsSync(ctx.config.webDist)) {
    await app.register(fastifyStatic, {
      root: ctx.config.webDist,
      cacheControl: false,
      // 檔名帶雜湊的資源可以永久快取；index.html 與地圖每次都向伺服器確認，部署新版立即生效。
      setHeaders: (reply, path) => {
        reply.header('cache-control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: '找不到這個 API' });
      // 找不到的靜態檔（例如舊版本的 JS）回 404；其餘路徑交給前端路由處理。
      if (/\.[a-z0-9]+(\?.*)?$/i.test(req.url)) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: '找不到這個 API' });
      return reply.code(404).type('text/plain; charset=utf-8').send('前端尚未建置，請先執行 npm run build（開發時請用 npm run dev）。');
    });
  }

  return app;
}
