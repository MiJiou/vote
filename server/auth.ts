import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Ctx, Role, User } from './domain.ts';
import { audit } from './domain.ts';
import { HttpError, asInt, now } from './util.ts';

const SESSION_DAYS = 7;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(password, salt, 32).toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const newToken = (): string => randomBytes(32).toString('base64url');

export function checkPasswordRules(password: unknown): string {
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, '密碼至少需要 8 個字元');
  if (password.length > 200) throw new HttpError(400, '密碼過長');
  return password;
}

export function createUser(ctx: Ctx, input: { username: string; password: string; role: Role; display_name?: string }): User {
  const username = input.username?.trim().toLowerCase();
  if (!username || !/^[a-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, '帳號需為 3–40 個英數字（可含 . _ -）');
  if (input.role !== 'admin' && input.role !== 'reporter') throw new HttpError(400, '角色不正確');
  checkPasswordRules(input.password);
  if (ctx.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, `帳號「${username}」已存在`);
  const r = ctx.db
    .prepare('INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, input.display_name?.trim() ?? '', hashPassword(input.password), input.role, now());
  return getUser(ctx, asInt(r.lastInsertRowid)!)!;
}

export function getUser(ctx: Ctx, id: number): User | undefined {
  return ctx.db.prepare('SELECT id, username, display_name, role, active FROM users WHERE id = ?').get(id) as User | undefined;
}

// 登入失敗節流：同一來源＋帳號連續失敗 8 次後鎖 5 分鐘。
const failures = new Map<string, { count: number; until: number }>();

export function login(ctx: Ctx, username: unknown, password: unknown, ip: string): { user: User; token: string } {
  if (typeof username !== 'string' || typeof password !== 'string') throw new HttpError(400, '請輸入帳號與密碼');
  const name = username.trim().toLowerCase();
  const key = `${ip}|${name}`;
  const f = failures.get(key);
  if (f && f.count >= 8 && f.until > Date.now()) throw new HttpError(429, '登入失敗次數過多，請 5 分鐘後再試');
  const row = ctx.db.prepare('SELECT * FROM users WHERE username = ?').get(name) as (User & { password_hash: string }) | undefined;
  // 帳號不存在時也跑一次雜湊，避免從回應時間猜出帳號是否存在。
  const ok = row ? verifyPassword(password, row.password_hash) : (hashPassword(password), false);
  if (!row || !ok || !row.active) {
    const count = (f && f.until > Date.now() ? f.count : 0) + 1;
    failures.set(key, { count, until: Date.now() + 5 * 60_000 });
    if (failures.size > 10_000) failures.clear();
    throw new HttpError(401, '帳號或密碼錯誤');
  }
  failures.delete(key);
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  ctx.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), row.id, expires);
  const user: User = { id: row.id, username: row.username, display_name: row.display_name, role: row.role, active: row.active };
  audit(ctx, user, 'auth.login');
  return { user, token };
}

export function sessionUser(ctx: Ctx, token: string | undefined): User | null {
  if (!token) return null;
  const row = ctx.db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.active FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    )
    .get(sha256(token), now()) as User | undefined;
  return row ?? null;
}

export function logout(ctx: Ctx, token: string | undefined): void {
  if (token) ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function setPassword(ctx: Ctx, userId: number, password: string, keepToken?: string): void {
  checkPasswordRules(password);
  ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  // 改密碼後登出其他裝置。
  if (keepToken) ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, sha256(keepToken));
  else ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** 第一次啟動時建立管理員；沒有設定 ADMIN_PASSWORD 就產生一組隨機密碼並回傳，由呼叫端顯示一次。 */
export function ensureAdmin(ctx: Ctx): { username: string; password: string } | null {
  if (ctx.db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return null;
  const password = ctx.config.adminPassword ?? randomBytes(9).toString('base64url');
  const user = createUser(ctx, { username: ctx.config.adminUser, password, role: 'admin', display_name: '管理員' });
  return ctx.config.adminPassword ? null : { username: user.username, password };
}
