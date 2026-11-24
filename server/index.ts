import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { createCtx } from './domain.ts';
import { ensureAdmin } from './auth.ts';
import { buildApp } from './app.ts';
import { startPoller } from './sources.ts';

const config = loadConfig();
const ctx = createCtx(openDb(config.dbPath), config);

const created = ensureAdmin(ctx);
const app = await buildApp(ctx);
const stopPoller = config.poller ? startPoller(ctx, (msg) => console.log(msg)) : () => {};

await app.listen({ port: config.port, host: config.host });
console.log(`\n  即時開票看板已啟動： http://localhost:${config.port}`);
console.log(`  管理後台：           http://localhost:${config.port}/admin`);
console.log(`  手機回報：           http://localhost:${config.port}/report`);
console.log(`  資料庫：             ${config.dbPath}\n`);
if (created) {
  console.log('  ┌─ 已建立管理員帳號（只顯示這一次，請登入後立即更改密碼）');
  console.log(`  │  帳號：${created.username}`);
  console.log(`  │  密碼：${created.password}`);
  console.log('  └─\n');
}

const shutdown = async () => {
  stopPoller();
  await app.close();
  ctx.db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
