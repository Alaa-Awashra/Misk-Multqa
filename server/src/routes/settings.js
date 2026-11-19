import { Router } from 'express';
import { tx } from '../db.js';
import { config } from '../config.js';
import { requireAdmin } from '../middleware/auth.js';
import { getSettings, invalidateSettings } from '../services/settings.js';
import { logActivity } from '../services/activity.js';
import { parse, z } from '../utils/validate.js';
import { badRequest } from '../utils/errors.js';

const router = Router();

router.get('/', async (req, res) => {
  const s = await getSettings();
  res.json({ settings: s, timezone: config.timezone });
});

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'صيغة الوقت غير صحيحة (HH:MM)');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح');
const int = (min, max, label = 'القيمة') =>
  z.coerce.number().int('يجب أن يكون عددًا صحيحًا').min(min, `${label}: الحد الأدنى ${min}`).max(max, `${label}: الحد الأقصى ${max}`);
const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

const schema = z
  .object({
    warning_missed_threshold: int(1, 30),
    warning_inactive_days: int(1, 365),
    exam_pass_grade: z.coerce.number().min(0, 'العلامة بين 0 و 100').max(100, 'العلامة بين 0 و 100'),
    work_start: hm,
    work_end: hm,
    recitation_minutes: int(5, 240, 'مدة التسميع'),
    exam_minutes: int(5, 240, 'مدة الامتحان'),
    juz_pages: int(1, 100, 'صفحات الجزء'),
    supervisor_dismissal_warnings: int(1, 10, 'حد التحذيرات'),
    compliance_enabled: bool,
    compliance_period_days: int(1, 31, 'مدة فترة الإبلاغ'),
    compliance_anchor_date: ymd,
    compliance_grace_days: int(0, 14, 'مهلة التصحيح'),
    compliance_min_records: int(0, 14, 'الحد الأدنى للسجلات'),
    compliance_warning_after: int(1, 10, 'رقم المخالفة التي تبدأ عندها التحذيرات'),
    compliance_lookback_days: int(14, 365, 'نافذة احتساب المخالفات'),
    compliance_start_date: ymd,
    report_period_days: int(7, 31, 'مدة التقرير الدوري'),
    report_anchor_date: ymd,
  })
  .partial();

router.put('/', requireAdmin, async (req, res) => {
  const current = await getSettings();
  const known = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => k in schema.shape));
  const b = parse(schema, known);
  const merged = { ...current, ...b };
  if (merged.work_start >= merged.work_end) throw badRequest('وقت بداية الدوام يجب أن يسبق وقت نهايته');
  const changed = Object.entries(b).filter(([k, v]) => JSON.stringify(current[k]) !== JSON.stringify(v));
  await tx(async (c) => {
    for (const [key, value] of changed) {
      await c.query(
        `insert into settings (key, value, updated_at) values ($1, $2::jsonb, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, JSON.stringify(value)]
      );
    }
    if (changed.length) {
      await logActivity(c, req.user, 'settings.update', 'settings', null, 'الإعدادات', {
        changed: Object.fromEntries(changed.map(([k, v]) => [k, { from: current[k], to: v }])),
      });
    }
  });
  invalidateSettings();
  res.json({ settings: await getSettings() });
});

export default router;
