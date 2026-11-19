// تنفيذ مخطط قاعدة البيانات + الترحيلات المرقّمة (database/migrations/*.sql)
// - schema.sql: الأساس (آمن لإعادة التشغيل)
// - كل ترحيل يُنفَّذ مرة واحدة داخل transaction ويُسجَّل في schema_migrations
// - قفل استشاري يمنع تشغيل ترحيلين في نفس الوقت (مثل نشرين متزامنين على Render)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(here, '../../database');
const MIGRATION_LOCK = 724_001;

export async function runMigrations(pool, log = console.log) {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8'));
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    await client.query('alter table schema_migrations enable row level security');

    const dir = path.join(dbDir, 'migrations');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort() : [];
    const { rows } = await client.query('select name from schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const applied = [];

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
        log(`  ✓ ${file}`);
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw new Error(`فشل الترحيل ${file}: ${err.message}`);
      }
    }
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
