import { query } from '../db.js';

export const DEFAULT_SETTINGS = {
  warning_missed_threshold: 2,
  warning_inactive_days: 14,
  exam_pass_grade: 60,
  work_start: '06:00',
  work_end: '22:00',
  recitation_minutes: 30,
  exam_minutes: 45,
  juz_pages: 20,
  // التحذيرات الرسمية للمشرفين: عند بلوغ هذا العدد من التحذيرات السارية يُوقف المشرف تلقائيًا
  supervisor_dismissal_warnings: 2,
  // متابعة اكتمال السجلات
  compliance_enabled: true,
  compliance_period_days: 7,
  compliance_anchor_date: '2026-01-03',
  compliance_grace_days: 2,
  compliance_min_records: 1,
  compliance_warning_after: 2,
  compliance_lookback_days: 90,
  compliance_start_date: null,
  // التقرير الدوري
  report_period_days: 14,
  report_anchor_date: '2026-01-03',
};

let cache = null;
let cachedAt = 0;

export async function getSettings() {
  if (cache && Date.now() - cachedAt < 10_000) return cache;
  const { rows } = await query('select key, value from settings');
  cache = { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  cachedAt = Date.now();
  return cache;
}

export const invalidateSettings = () => {
  cache = null;
};
