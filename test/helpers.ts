import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import type { Ctx, Election } from '../server/domain.ts';
import { createCtx, createElection, listContests, upsertCandidate } from '../server/domain.ts';
import { createUser } from '../server/auth.ts';
import { buildApp } from '../server/app.ts';

export function testCtx(): Ctx {
  const config = { ...loadConfig({}), dbPath: ':memory:', logger: false, poller: false, webDist: '/nonexistent' };
  return createCtx(openDb(':memory:'), config);
}

/** 建立一場三組候選人的總統大選。 */
export function presidential(ctx: Ctx, unitLevel: Election['unit_level'] = 'town') {
  const election = createElection(ctx, { name: '測試總統大選', type: 'president', date: '2028-01-08', unit_level: unitLevel, status: 'live' });
  const contest = listContests(ctx, election.id)[0];
  const a = upsertCandidate(ctx, contest, { number: 1, name: '甲候選人', running_mate: '甲副手', party: '台灣民眾黨' });
  const b = upsertCandidate(ctx, contest, { number: 2, name: '乙候選人', running_mate: '乙副手', party: '民主進步黨' });
  const c = upsertCandidate(ctx, contest, { number: 3, name: '丙候選人', running_mate: '丙副手', party: '中國國民黨' });
  return { election, contest, candidates: [a, b, c] };
}

export async function testApp(ctx: Ctx) {
  const app = await buildApp(ctx);
  createUser(ctx, { username: 'admin', password: 'admin-password', role: 'admin' });
  createUser(ctx, { username: 'reporter', password: 'reporter-password', role: 'reporter' });
  return app;
}

export async function loginAs(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'sid')!;
  return `sid=${cookie.value}`;
}
