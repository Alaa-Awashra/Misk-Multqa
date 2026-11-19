// تشغيل: npm run migrate  — ينفذ database/schema.sql ثم الترحيلات الجديدة في database/migrations
import { pool } from './db.js';
import { runMigrations } from './migrations.js';

try {
  const applied = await runMigrations(pool);
  console.log(applied.length ? `✅ تم تطبيق ${applied.length} ترحيل` : '✅ قاعدة البيانات محدّثة — لا ترحيلات جديدة');
} catch (err) {
  console.error('❌ فشل الترحيل:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
