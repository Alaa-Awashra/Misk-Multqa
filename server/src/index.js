import { config } from './config.js';
import { pool } from './db.js';
import { app } from './app.js';
import { seedAdmin } from './services/seed.js';
import { startInProcessScheduler, stopInProcessScheduler } from './services/jobs.js';
import { emailConfigStatus } from './services/email/resend.js';
import { outboxIdle } from './services/email/outbox.js';

async function start() {
  await seedAdmin();
  const server = app.listen(config.port, () => {
    console.log(`🚀 ملتقى المسك القرآني يعمل على المنفذ ${config.port}`);
    const mail = emailConfigStatus();
    if (!mail.operational) console.warn(`✉️  البريد غير مُفعّل — الإشعارات داخل المنصة فقط. ${mail.problems.join(' • ')}`);
    if (!config.cronSecret) console.warn('⏰ CRON_SECRET غير مضبوط — نقطة Supabase Cron معطلة (المهام تعمل داخل الخادم أثناء نشاطه فقط).');
  });
  if (config.inProcessScheduler) startInProcessScheduler();

  const shutdown = (signal) => {
    console.log(`${signal} — إيقاف الخادم…`);
    stopInProcessScheduler();
    server.close(async () => {
      await outboxIdle().catch(() => {});
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('❌ فشل تشغيل الخادم:', err.message);
  process.exit(1);
});
