// متابعة اكتمال سجلات المشرفين آليًا
//
// الالتزامات المطلوبة في كل فترة إبلاغ (افتراضيًا أسبوعية، تبدأ من compliance_anchor_date):
//   1) كل موعد بدأ خلال الفترة يجب أن تُسجَّل نتيجته (تم / لم يلتزم) — لا يبقى "محجوزًا" بعد وقته
//   2) كل طالب نشط بدأ قبل الفترة يجب أن يكون له على الأقل compliance_min_records تسميع مسجّل (تم أو لم يلتزم)
// بعد نهاية الفترة توجد مهلة تصحيح (compliance_grace_days). عند انتهائها تُقيَّم الفترة مرة واحدة فقط
// (قيد unique على supervisor_id + period_start)، فلا يُحتسب نفس النقص مرتين.
//
// التصعيد (ضمن compliance_lookback_days):
//   المخالفة رقم < compliance_warning_after  → تذكير
//   المخالفة رقم >= compliance_warning_after → تحذير رسمي (وعند بلوغ حد التحذيرات يُوقف المشرف)
//
// لا تُقيَّم: فترات قبل compliance_start_date، فترات تتقاطع مع إجازة/إعفاء، مشرف انضم بعد بداية الفترة،
// طلاب لم يبدؤوا بعد (تاريخ انضمامهم بعد بداية الفترة) أو موقوفون.
import { query, tx, pool } from '../db.js';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import { addDays, localDateStr } from '../utils/tz.js';
import { issueWarning, revokeWarning } from './discipline.js';
import { notifyUser } from './notify.js';
import { logActivity } from './activity.js';

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function complianceConfig(s) {
  return {
    enabled: s.compliance_enabled !== false && s.compliance_enabled !== 'false',
    periodDays: Math.max(1, Number(s.compliance_period_days) || 7),
    anchor: /^\d{4}-\d{2}-\d{2}$/.test(s.compliance_anchor_date || '') ? s.compliance_anchor_date : '2026-01-03',
    graceDays: Math.max(0, Number(s.compliance_grace_days) || 0),
    minRecords: Math.max(0, Number(s.compliance_min_records) || 0),
    warningAfter: Math.max(1, Number(s.compliance_warning_after) || 2),
    lookbackDays: Math.max(7, Number(s.compliance_lookback_days) || 90),
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(s.compliance_start_date || '') ? s.compliance_start_date : null,
  };
}

/** الفترة التي تحتوي التاريخ المحلي date */
export function periodContaining(date, cfg) {
  const k = Math.floor(daysBetween(cfg.anchor, date) / cfg.periodDays);
  const start = addDays(cfg.anchor, k * cfg.periodDays);
  return { start, end: addDays(start, cfg.periodDays - 1) };
}

/** موعد انتهاء مهلة التصحيح: بداية اليوم (end + 1 + grace) بتوقيت المنتدى */
export async function deadlineOf(period, cfg, db = pool) {
  const day = addDays(period.end, 1 + cfg.graceDays);
  const { rows } = await db.query(`select ($1::date)::timestamp at time zone $2::text as ts`, [day, config.timezone]);
  return rows[0].ts;
}

/** البنود الناقصة لمشرف في فترة. asOf: لا تُحتسب المواعيد التي لم ينتهِ وقتها بعد */
export async function findMissingItems(db, supervisorId, period, cfg) {
  const tz = config.timezone;
  const items = [];

  const { rows: unresolved } = await db.query(
    `select a.id, a.start_at, a.kind, s.id as student_id, s.full_name as student_name
     from appointments a join students s on s.id = a.student_id
     where a.supervisor_id = $1 and a.status = 'scheduled' and a.end_at < now()
       and a.start_at >= ($2::date)::timestamp at time zone $4::text
       and a.start_at < (($3::date + 1)::timestamp at time zone $4::text)
     order by a.start_at`,
    [supervisorId, period.start, period.end, tz]
  );
  for (const a of unresolved) {
    items.push({
      type: 'unresolved_appointment',
      appointment_id: a.id,
      student_id: a.student_id,
      student_name: a.student_name,
      start_at: a.start_at,
      kind: a.kind,
    });
  }

  if (cfg.minRecords > 0) {
    const { rows: students } = await db.query(
      `select s.id, s.full_name,
              (select count(*) from appointments a
                where a.student_id = s.id and a.kind = 'recitation' and a.status in ('completed', 'missed')
                  and a.start_at >= ($2::date)::timestamp at time zone $4::text
                  and a.start_at < (($3::date + 1)::timestamp at time zone $4::text))::int as records
       from students s
       where s.supervisor_id = $1 and s.status = 'active'
         and s.join_date <= $2::date
         and s.created_at < ($2::date)::timestamp at time zone $4::text
       order by s.full_name`,
      [supervisorId, period.start, period.end, tz]
    );
    for (const s of students) {
      if (s.records < cfg.minRecords) {
        items.push({ type: 'no_records', student_id: s.id, student_name: s.full_name, records: s.records, required: cfg.minRecords });
      }
    }
  }
  return items;
}

export const describeItem = (it) =>
  it.type === 'unresolved_appointment'
    ? `${it.student_name}: موعد ${it.kind === 'exam' ? 'امتحان' : 'تسميع'} بتاريخ ${localDateStr(new Date(it.start_at))} بلا نتيجة مسجّلة`
    : `${it.student_name}: لا يوجد تسميع مسجّل في الفترة (${it.records} من ${it.required})`;

async function exemptionFor(db, supervisorId, period) {
  const { rows } = await db.query(
    `select kind, reason from compliance_exemptions
     where (supervisor_id = $1 or supervisor_id is null) and start_date <= $3::date and end_date >= $2::date
     order by supervisor_id nulls last limit 1`,
    [supervisorId, period.start, period.end]
  );
  return rows[0] || null;
}

/** الفترات المغلقة (انتهت مهلتها) المستحقة للتقييم */
export async function closedPeriods(cfg, now = new Date()) {
  if (!cfg.startDate) return [];
  const today = localDateStr(now);
  const out = [];
  let p = periodContaining(today, cfg);
  const earliest = addDays(today, -cfg.lookbackDays);
  for (let i = 0; i < 60; i++) {
    p = { start: addDays(p.start, -cfg.periodDays), end: addDays(p.start, -1) };
    if (p.start < cfg.startDate || p.start < earliest) break;
    const deadline = await deadlineOf(p, cfg);
    if (new Date(deadline) <= now) out.push({ ...p, deadline });
  }
  return out.reverse(); // الأقدم أولًا لترقيم المخالفات بالترتيب
}

/** يقيّم مشرفًا واحدًا في فترة واحدة (idempotent). يعيد نتيجة أو null إن كانت مقيّمة مسبقًا */
export async function evaluateSupervisorPeriod(supervisor, period, cfg) {
  return tx(async (c) => {
    // قفل لمنع تقييمين متزامنين لنفس المشرف
    await c.query('select id from supervisors where id = $1 for update', [supervisor.id]);
    const { rowCount: exists } = await c.query(
      'select 1 from compliance_reviews where supervisor_id = $1 and period_start = $2',
      [supervisor.id, period.start]
    );
    if (exists) return null;

    const base = [supervisor.id, period.start, period.end, period.deadline];
    if (supervisor.join_date > period.start) {
      await c.query(
        `insert into compliance_reviews (supervisor_id, period_start, period_end, deadline_at, status, excuse_reason)
         values ($1, $2, $3, $4, 'exempt', 'انضم المشرف بعد بداية الفترة')`,
        base
      );
      return { status: 'exempt' };
    }
    const ex = await exemptionFor(c, supervisor.id, period);
    if (ex) {
      await c.query(
        `insert into compliance_reviews (supervisor_id, period_start, period_end, deadline_at, status, excuse_reason)
         values ($1, $2, $3, $4, 'exempt', $5)`,
        [...base, `${ex.kind === 'leave' ? 'إجازة معتمدة' : 'فترة معفاة'}: ${ex.reason}`]
      );
      return { status: 'exempt' };
    }

    const items = await findMissingItems(c, supervisor.id, period, cfg);
    if (!items.length) {
      await c.query(
        `insert into compliance_reviews (supervisor_id, period_start, period_end, deadline_at, status) values ($1, $2, $3, $4, 'ok')`,
        base
      );
      return { status: 'ok' };
    }

    const { rows: prev } = await c.query(
      `select count(*)::int as n from compliance_reviews
       where supervisor_id = $1 and status = 'violation' and period_start >= $2::date - $3::int`,
      [supervisor.id, period.start, cfg.lookbackDays]
    );
    const number = prev[0].n + 1;
    const action = number >= cfg.warningAfter ? 'warning' : 'reminder';
    const { rows: rev } = await c.query(
      `insert into compliance_reviews (supervisor_id, period_start, period_end, deadline_at, status, missing, missing_count,
                                       violation_number, action)
       values ($1, $2, $3, $4, 'violation', $5, $6, $7, $8) returning id`,
      [...base, JSON.stringify(items), items.length, number, action]
    );
    const reviewId = rev[0].id;
    const periodLabel = `${period.start} — ${period.end}`;

    let result = { status: 'violation', number, action, missing: items.length };
    if (action === 'reminder') {
      await notifyUser(
        c,
        supervisor.user_id,
        {
          type: 'compliance_reminder',
          title: 'تذكير: لم تُستكمل سجلات الفترة السابقة',
          body: `فترة ${periodLabel}: ${items.length} بند ناقص. هذه المخالفة رقم ${number}؛ تكرارها يؤدي إلى تحذير رسمي.`,
          link: '/my-record',
          data: { review_id: reviewId },
          dedupeKey: `compliance_violation:${reviewId}`,
        },
        {
          template: 'compliance_reminder',
          data: {
            intro: `انتهت مهلة استكمال سجلات الفترة ${periodLabel} مع وجود بنود ناقصة. هذا تذكير (المخالفة رقم ${number}). تكرار عدم الاستكمال يؤدي إلى تحذير إداري رسمي.`,
            period: periodLabel,
            count: items.length,
            items: items.map(describeItem),
          },
        }
      );
      await logActivity(c, null, 'compliance.reminder', 'supervisor', supervisor.id, supervisor.full_name, {
        period: periodLabel,
        missing: items.length,
        violation_number: number,
      });
    } else {
      const w = await issueWarning(c, null, supervisor.id, {
        reason: `عدم استكمال سجلات الطلاب للفترة ${periodLabel} (${items.length} بند ناقص) — المخالفة رقم ${number}`,
        notes: items.slice(0, 10).map(describeItem).join('\n'),
        source: 'compliance',
        reviewId,
      });
      await c.query('update compliance_reviews set warning_id = $1 where id = $2', [w.warning.id, reviewId]);
      result = { ...result, warning_id: w.warning.id, dismissed: w.dismissed };
    }
    return result;
  });
}

/** يرسل تنبيهًا (مرة واحدة لكل فترة) خلال مهلة التصحيح للفترة المنتهية حديثًا */
async function sendGraceNotices(cfg, now) {
  let sent = 0;
  const today = localDateStr(now);
  const last = periodContaining(addDays(periodContaining(today, cfg).start, -1), cfg);
  if (!cfg.startDate || last.start < cfg.startDate) return 0;
  const deadline = await deadlineOf(last, cfg);
  if (new Date(deadline) <= now) return 0; // انتهت المهلة — التقييم يتولاها

  const { rows: sups } = await query(
    `select sp.id, sp.user_id, sp.join_date, u.full_name from supervisors sp join users u on u.id = sp.user_id
     where sp.status = 'active' and sp.join_date <= $1::date`,
    [last.start]
  );
  for (const s of sups) {
    if (await exemptionFor(pool, s.id, last)) continue;
    const items = await findMissingItems(pool, s.id, last, cfg);
    if (!items.length) continue;
    const created = await tx((c) =>
      notifyUser(
        c,
        s.user_id,
        {
          type: 'compliance_due',
          title: 'سجلات بحاجة إلى استكمال قبل انتهاء المهلة',
          body: `فترة ${last.start} — ${last.end}: ${items.length} بند ناقص.`,
          link: '/my-record',
          dedupeKey: `compliance_due:${s.id}:${last.start}`,
        },
        {
          template: 'compliance_reminder',
          data: {
            intro: `توجد سجلات ناقصة في الفترة ${last.start} — ${last.end}. يرجى استكمالها قبل انتهاء المهلة لتجنب احتساب مخالفة.`,
            period: `${last.start} — ${last.end}`,
            count: items.length,
            deadline,
            items: items.map(describeItem),
          },
        }
      )
    );
    if (created) sent++;
  }
  return sent;
}

/** المهمة المجدولة: تنبيهات المهلة + تقييم كل الفترات المغلقة غير المقيّمة */
export async function runComplianceJob(now = new Date()) {
  const cfg = complianceConfig(await getSettings());
  if (!cfg.enabled) return { skipped: 'disabled' };
  const result = { evaluated: 0, violations: 0, reminders: 0, warnings: 0, dismissed: 0, exempt: 0, notices: 0 };
  result.notices = await sendGraceNotices(cfg, now);

  const periods = await closedPeriods(cfg, now);
  for (const p of periods) {
    const { rows: sups } = await query(
      `select sp.id, sp.user_id, sp.join_date, u.full_name from supervisors sp join users u on u.id = sp.user_id
       where sp.status = 'active' order by sp.id`
    );
    for (const s of sups) {
      const r = await evaluateSupervisorPeriod(s, p, cfg);
      if (!r) continue;
      result.evaluated++;
      if (r.status === 'exempt') result.exempt++;
      if (r.status === 'violation') {
        result.violations++;
        if (r.action === 'reminder') result.reminders++;
        else result.warnings++;
        if (r.dismissed) result.dismissed++;
      }
    }
  }
  return result;
}

/** ملخص المتابعة لمشرف: الفترة الحالية + فترة المهلة + السجل */
export async function supervisorComplianceSummary(supervisorId) {
  const cfg = complianceConfig(await getSettings());
  const today = localDateStr();
  const current = periodContaining(today, cfg);
  const previous = periodContaining(addDays(current.start, -1), cfg);
  const prevDeadline = await deadlineOf(previous, cfg);
  const inGrace = new Date(prevDeadline) > new Date();

  const currentItems = (await findMissingItems(pool, supervisorId, current, { ...cfg, minRecords: 0 })).map((i) => ({
    ...i,
    label: describeItem(i),
  }));
  const graceItems = inGrace
    ? (await findMissingItems(pool, supervisorId, previous, cfg)).map((i) => ({ ...i, label: describeItem(i) }))
    : [];

  const { rows: reviews } = await query(
    `select id, period_start, period_end, deadline_at, status, missing_count, violation_number, action, excuse_reason, missing
     from compliance_reviews where supervisor_id = $1 order by period_start desc limit 30`,
    [supervisorId]
  );
  const { rows: exemptions } = await query(
    `select id, kind, start_date, end_date, reason from compliance_exemptions
     where (supervisor_id = $1 or supervisor_id is null) and end_date >= current_date - 60 order by start_date desc`,
    [supervisorId]
  );
  const { rows: vc } = await query(
    `select count(*)::int as n from compliance_reviews
     where supervisor_id = $1 and status = 'violation' and period_start >= current_date - $2::int`,
    [supervisorId, cfg.lookbackDays]
  );

  return {
    enabled: cfg.enabled,
    config: cfg,
    current: { ...current, items: currentItems },
    grace: inGrace ? { ...previous, deadline: prevDeadline, items: graceItems } : null,
    violations_in_window: vc[0].n,
    reviews,
    exemptions,
  };
}

/** عذر مخالفة (للمسؤول): لا تُحتسب، ويُلغى التحذير المرتبط بها إن وُجد */
export async function excuseReview(actor, reviewId, reason) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `select r.*, u.full_name from compliance_reviews r join supervisors sp on sp.id = r.supervisor_id
       join users u on u.id = sp.user_id where r.id = $1 for update of r`,
      [reviewId]
    );
    const r = rows[0];
    if (!r) return null;
    if (r.status !== 'violation') return { unchanged: true };
    await c.query(
      `update compliance_reviews set status = 'excused', excused_by = $1, excused_at = now(), excuse_reason = $2 where id = $3`,
      [actor.id, reason, r.id]
    );
    let revoked = false;
    if (r.warning_id) {
      const { rows: w } = await c.query(`select status from supervisor_warnings where id = $1`, [r.warning_id]);
      if (w[0]?.status === 'active') {
        await revokeWarning(c, actor, r.warning_id, `عذر مقبول للفترة ${r.period_start}: ${reason}`);
        revoked = true;
      }
    }
    await logActivity(c, actor, 'compliance.excuse', 'supervisor', r.supervisor_id, r.full_name, {
      reason,
      period: `${r.period_start} — ${r.period_end}`,
    });
    return { excused: true, warning_revoked: revoked };
  });
}
