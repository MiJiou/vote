import type { FastifyRequest } from 'fastify';
import { NATION } from './db.ts';
import type { Ctx, User } from './domain.ts';
import { HttpError } from './util.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

export const toId = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '參數不正確');
  return n;
};

export function requireUser(req: FastifyRequest, role?: 'admin'): User {
  if (!req.user) throw new HttpError(401, '請先登入');
  if (role === 'admin' && req.user.role !== 'admin') throw new HttpError(403, '需要管理員權限');
  return req.user;
}

/** 把統計單位代碼轉成人看得懂的名稱（例如「臺北市 松山區 第 0001 投開票所」）。 */
export function unitLabel(ctx: Ctx, code: string): string {
  if (code === NATION) return '全國';
  const [areaCode, station] = code.split('-');
  const area = ctx.areas.byCode.get(areaCode);
  if (!area) return code;
  const names = area.parent ? [ctx.areas.name(area.parent), area.name] : [area.name];
  if (station) names.push(`第 ${station} 投開票所`);
  return names.join(' ');
}
