// المهام المجدولة — كلها "تعويضية" وآمنة للتكرار (idempotent):
// كل تشغيل يُنجز كل ما استحق حتى الآن، فلا يضيع شيء إن نام خادم Render المجاني.
// المحفّز الموثوق: Supabase Cron (pg_cron + pg_net) يستدعي POST /api/cron/tick.
// قفل استشاري في PostgreSQL يمنع تشغيلين متزامنين (حتى عبر أكثر من نسخة خادم).
import { pool } from '../db.js';
import { processOutbox } from './email/outbox.js';
import { runComplianceJob } from './compliance.js';
import { generateDueReports } from './analytics.js';
import { syncAllForms } from './admissions.js';
import { deliverScheduledAnnouncements } from '../routes/announcements.js';

const JOB_LOCK = 724_002;

const JOBS = {
  compliance: () => runComplianceJob(),
  reports: () => generateDueReports(),
  admissions: () => syncAllForms(),
  announcements: () => deliverScheduledAnnouncements(),
  email: () => processOutbox({ limit: 100 }),
};

export async function runJobs({ trigger = 'cron', only = null } = {}) {
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query('select pg_try_advisory_lock($1) as ok', [JOB_LOCK]);
    locked = rows[0].ok;
    if (!locked) return { busy: true };

    const results = {};
    for (const [name, fn] of Object.entries(JOBS)) {
      if (only && !only.includes(name)) continue;
      const { rows: run } = await client.query(`insert into job_runs (job, trigger) values ($1, $2) returning id`, [name, trigger]);
      try {
        const result = await fn();
        results[name] = { ok: true, result };
        await client.query(`update job_runs set finished_at = now(), ok = true, result = $2 where id = $1`, [
          run[0].id,
          JSON.stringify(result ?? {}),
        ]);
      } catch (err) {
        // فشل مهمة لا يوقف بقية المهام
        console.error(`❌ فشل المهمة ${name}:`, err.message);
        results[name] = { ok: false, error: err.message };
        await client.query(`update job_runs set finished_at = now(), ok = false, error = $2 where id = $1`, [
          run[0].id,
          String(err.message).slice(0, 1000),
        ]);
      }
    }
    // تنظيف سجل التشغيل القديم
    await client.query(`delete from job_runs where started_at < now() - interval '60 days'`);
    return { busy: false, results };
  } finally {
    if (locked) await client.query('select pg_advisory_unlock($1)', [JOB_LOCK]).catch(() => {});
    client.release();
  }
}

let timer = null;
/** مساعد فقط أثناء نشاط الخادم — لا يُعتمد عليه وحده (Render المجاني ينام) */
export function startInProcessScheduler(intervalMs = 15 * 60_000) {
  if (timer) return;
  const tick = () => runJobs({ trigger: 'in-process' }).catch((e) => console.error('خطأ في المهام:', e.message));
  setTimeout(tick, 30_000).unref();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}

export function stopInProcessScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
