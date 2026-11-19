// متابعة اكتمال سجلات المشرفين — إدارة الإعفاءات والإجازات والأعذار (للمسؤول)
import { Router } from 'express';
import { query, tx, pool } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { notFound, badRequest, uuidParam } from '../utils/errors.js';
import { parse, z, reqText } from '../utils/validate.js';
import { logActivity } from '../services/activity.js';
import { complianceConfig, excuseReview, findMissingItems, periodContaining, deadlineOf, describeItem } from '../services/compliance.js';
import { getSettings } from '../services/settings.js';
import { runJobs } from '../services/jobs.js';
import { addDays, localDateStr } from '../utils/tz.js';

const router = Router();
router.use(requireAdmin);
router.param('id', uuidParam);

router.get('/overview', async (req, res) => {
  const cfg = complianceConfig(await getSettings());
  const today = localDateStr();
  const current = periodContaining(today, cfg);
  const previous = periodContaining(addDays(current.start, -1), cfg);
  const prevDeadline = await deadlineOf(previous, cfg);
  const inGrace = new Date(prevDeadline) > new Date();

  const { rows: sups } = await query(
    `select sp.id, sp.status, sp.join_date, u.full_name, sp.supervisor_type,
            (select count(*) from compliance_reviews r where r.supervisor_id = sp.id and r.status = 'violation'
               and r.period_start >= current_date - $1::int) as violations,
            (select count(*) from supervisor_warnings w where w.supervisor_id = sp.id and w.status = 'active') as active_warnings,
            (select count(*) from appointments a where a.supervisor_id = sp.id and a.status = 'scheduled' and a.end_at < now()) as unresolved
     from supervisors sp join users u on u.id = sp.user_id
     order by sp.status, u.full_name`,
    [cfg.lookbackDays]
  );
  const rows = [];
  for (const s of sups) {
    let pending = null;
    if (inGrace && s.status === 'active') pending = (await findMissingItems(pool, s.id, previous, cfg)).length;
    rows.push({ ...s, grace_missing: pending });
  }

  const { rows: reviews } = await query(
    `select r.id, r.supervisor_id, u.full_name, r.period_start, r.period_end, r.status, r.missing_count,
            r.violation_number, r.action, r.excuse_reason, r.created_at
     from compliance_reviews r join supervisors sp on sp.id = r.supervisor_id join users u on u.id = sp.user_id
     where r.status in ('violation', 'excused') order by r.created_at desc limit 100`
  );
  const { rows: exemptions } = await query(
    `select e.*, u.full_name as supervisor_name from compliance_exemptions e
     left join supervisors sp on sp.id = e.supervisor_id left join users u on u.id = sp.user_id
     order by e.start_date desc limit 200`
  );
  const { rows: runs } = await query(`select * from job_runs order by id desc limit 10`);

  res.json({
    config: cfg,
    current,
    grace: inGrace ? { ...previous, deadline: prevDeadline } : null,
    supervisors: rows,
    reviews,
    exemptions,
    runs,
  });
});

router.get('/reviews/:id', async (req, res) => {
  const { rows } = await query(`select * from compliance_reviews where id = $1`, [req.params.id]);
  if (!rows[0]) throw notFound();
  res.json({ review: { ...rows[0], missing: rows[0].missing.map((i) => ({ ...i, label: describeItem(i) })) } });
});

router.post('/reviews/:id/excuse', async (req, res) => {
  const { reason } = parse(z.object({ reason: reqText('سبب العذر', 500) }), req.body);
  const r = await excuseReview(req.user, req.params.id, reason);
  if (!r) throw notFound('المراجعة غير موجودة');
  res.json(r);
});

const exemptionSchema = z
  .object({
    supervisor_id: z.preprocess((v) => (v === '' ? null : v), z.string().uuid('المشرف غير صالح').nullable().optional()),
    kind: z.enum(['leave', 'exempt']),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ البداية غير صالح'),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ النهاية غير صالح'),
    reason: reqText('السبب', 500),
  })
  .refine((v) => v.end_date >= v.start_date, { message: 'تاريخ النهاية يجب أن يكون بعد البداية' })
  .refine((v) => v.kind !== 'leave' || v.supervisor_id, { message: 'الإجازة يجب أن تكون لمشرف محدد' });

router.post('/exemptions', async (req, res) => {
  const b = parse(exemptionSchema, req.body);
  const row = await tx(async (c) => {
    const { rows } = await c.query(
      `insert into compliance_exemptions (supervisor_id, kind, start_date, end_date, reason, created_by)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [b.supervisor_id ?? null, b.kind, b.start_date, b.end_date, b.reason, req.user.id]
    );
    await logActivity(c, req.user, 'compliance.exemption', 'settings', b.supervisor_id ?? null, b.kind === 'leave' ? 'إجازة مشرف' : 'فترة معفاة', {
      reason: b.reason,
      from: b.start_date,
      to: b.end_date,
    });
    return rows[0];
  });
  res.status(201).json({ exemption: row });
});

router.delete('/exemptions/:id', async (req, res) => {
  const r = await query(`delete from compliance_exemptions where id = $1 returning *`, [req.params.id]);
  if (!r.rowCount) throw notFound();
  await logActivity({ query }, req.user, 'compliance.exemption_deleted', 'settings', r.rows[0].supervisor_id, 'إعفاء', {
    reason: r.rows[0].reason,
  });
  res.json({ ok: true });
});

/** تشغيل يدوي فوري للفحص (نفس منطق المهمة المجدولة — آمن للتكرار) */
router.post('/run', async (req, res) => {
  const r = await runJobs({ trigger: `manual:${req.user.id}`, only: ['compliance'] });
  if (r.busy) throw badRequest('يوجد تشغيل آخر قيد التنفيذ، حاول بعد قليل');
  res.json(r);
});

export default router;
