import { resolve } from 'node:path';

export type Config = {
  port: number;
  host: string;
  dbPath: string;
  webDist: string;
  adminUser: string;
  adminPassword: string | null;
  cookieSecure: boolean;
  trustProxy: boolean;
  poller: boolean;
  logger: boolean;
};

const root = resolve(import.meta.dirname, '..');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.DATA_DIR ?? resolve(root, 'data'));
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH ?? resolve(dataDir, 'vote.db'),
    webDist: resolve(root, 'web/dist'),
    adminUser: env.ADMIN_USER ?? 'admin',
    adminPassword: env.ADMIN_PASSWORD ?? null,
    // 正式上線（HTTPS）時設為 1，Cookie 才會加上 Secure。
    cookieSecure: env.COOKIE_SECURE === '1',
    trustProxy: env.TRUST_PROXY === '1',
    poller: env.DISABLE_POLLER !== '1',
    logger: env.LOG !== '0',
  };
}
