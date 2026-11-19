// لوحة تحليلات الأداء (للمسؤول فقط)
import { Router } from 'express';
import ExcelJS from 'exceljs';
import { query } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { badRequest, notFound, isUuid, uuidParam } from '../utils/errors.js';
import { computeAnalytics, reportPeriodContaining, generateDueReports } from '../services/analytics.js';
import { getSettings } from '../services/settings.js';
import { addDays, localDateStr } from '../utils/tz.js';
import { logActivity } from '../services/activity.js';

const router = Router();
router.use(requireAdmin);
router.param('id', uuidParam);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function scopeFrom(req) {
  let { from, to } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
    // الافتراضي: آخر فترة تقرير مكتملة
    const s = await getSettings();
    const cur = reportPeriodContaining(localDateStr(), s);
    from = addDays(cur.start, -cur.len);
    to = addDays(cur.start, -1);
  }
  if (from > to) throw badRequest('تاريخ البداية يجب أن يسبق تاريخ النهاية');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 400) throw badRequest('أقصى مدة للتحليل 400 يوم');
  return {
    from,
    to,
    supervisorId: isUuid(req.query.supervisor_id) ? req.query.supervisor_id : null,
    studentId: isUuid(req.query.student_id) ? req.query.student_id : null,
    group: ['male', 'female', 'kids'].includes(req.query.group) ? req.query.group : null,
  };
}

router.get('/', async (req, res) => {
  res.json(await computeAnalytics(await scopeFrom(req)));
});

router.get('/reports', async (req, res) => {
  const { rows } = await query(
    `select id, period_start, period_end, generated_at, generated_by,
            data->'totals' as totals
     from performance_reports order by period_start desc limit 52`
  );
  res.json({ reports: rows });
});

router.get('/reports/:id', async (req, res) => {
  const { rows } = await query(`select * from performance_reports where id = $1`, [req.params.id]);
  if (!rows[0]) throw notFound('التقرير غير موجود');
  res.json({ report: rows[0] });
});

router.post('/reports/generate', async (req, res) => {
  const r = await generateDueReports({ trigger: `manual:${req.user.full_name}` });
  if (r.generated.length) {
    await logActivity({ query }, req.user, 'analytics.generate', 'settings', null, 'التقارير الدورية', { periods: r.generated });
  }
  res.json(r);
});

// ---------------------------------------------------------------- تصدير Excel (.xlsx حقيقي، من اليمين لليسار)
const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
const GROUP = { male: 'ذكور', female: 'إناث', kids: 'كيدز' };

function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c[0], key: c[1], width: c[2] || 16 }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F5C4D' } };
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

router.get('/export.xlsx', async (req, res) => {
  let data;
  if (isUuid(req.query.report)) {
    const { rows } = await query(`select data from performance_reports where id = $1`, [req.query.report]);
    if (!rows[0]) throw notFound('التقرير غير موجود');
    data = rows[0].data;
  } else {
    data = await computeAnalytics(await scopeFrom(req));
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ملتقى المسك القرآني';
  wb.created = new Date();
  const t = data.totals;

  sheet(
    wb,
    'الملخص',
    [
      ['البند', 'k', 36],
      ['القيمة', 'v', 24],
    ],
    [
      { k: 'الفترة', v: `${data.period.from} — ${data.period.to}` },
      { k: 'الفترة السابقة للمقارنة', v: `${data.previous.from} — ${data.previous.to}` },
      { k: 'إجمالي المحفوظ في الملتقى (أجزاء)', v: t.forum_total_juz },
      { k: 'الحفظ الجديد في الفترة (صفحات)', v: t.new_pages },
      { k: 'الحفظ الجديد في الفترة السابقة (صفحات)', v: t.prev_new_pages },
      { k: 'نسبة التغير', v: pct(t.change_pct) },
      { k: 'صفحات المراجعة', v: t.review_pages },
      { k: 'عدد الطلاب النشطين', v: t.students },
      { k: 'نسبة المشاركة', v: pct(t.participation_rate) },
      { k: 'نسبة الالتزام بالتسميع', v: pct(t.commitment_rate) },
      { k: 'اكتمال السجلات', v: pct(t.completeness_rate) },
      { k: 'طلاب بلا تقدم', v: t.no_progress },
      { k: 'تعريف الحفظ الجديد', v: data.definitions.new_pages },
    ]
  );
  sheet(
    wb,
    'الطلاب',
    [
      ['الترتيب', 'rank', 9],
      ['الطالب', 'full_name', 28],
      ['المشرف', 'supervisor_name', 22],
      ['الفئة', 'group', 10],
      ['حفظ جديد (صفحات)', 'new_pages', 16],
      ['الفترة السابقة', 'prev_new_pages', 14],
      ['التغير', 'change', 10],
      ['مراجعة (صفحات)', 'review_pages', 14],
      ['إجمالي المحفوظ (أجزاء)', 'total_juz', 18],
      ['تسميع تم', 'rec_completed', 10],
      ['لم يلتزم', 'rec_missed', 10],
      ['متوسط الامتحانات', 'avg_exam', 14],
    ],
    data.students.map((s) => ({ ...s, group: GROUP[s.group] || '—', change: pct(s.change_pct) }))
  );
  sheet(
    wb,
    'المشرفون',
    [
      ['الترتيب', 'rank', 9],
      ['المشرف', 'full_name', 26],
      ['الفئة', 'group', 10],
      ['الطلاب', 'students', 10],
      ['حفظ جديد', 'new_pages', 12],
      ['متوسط لكل طالب', 'avg_new_pages', 14],
      ['السابق', 'prev_new_pages', 12],
      ['التغير', 'change', 10],
      ['الالتزام', 'commitment', 10],
      ['اكتمال السجلات', 'completeness', 14],
      ['بلا تقدم', 'no_progress', 10],
    ],
    data.supervisors.map((s) => ({
      ...s,
      group: GROUP[s.group] || '—',
      change: pct(s.change_pct),
      commitment: pct(s.commitment_rate),
      completeness: pct(s.completeness_rate),
    }))
  );
  sheet(
    wb,
    'الفئات',
    [
      ['الفئة', 'label', 12],
      ['الطلاب', 'students', 10],
      ['حفظ جديد', 'new_pages', 12],
      ['متوسط لكل طالب', 'avg_new_pages', 14],
      ['التغير', 'change', 10],
      ['المشاركة', 'participation', 10],
    ],
    data.groups.map((g) => ({ ...g, change: pct(g.change_pct), participation: pct(g.participation_rate) }))
  );
  sheet(
    wb,
    'الاتجاه',
    [
      ['من', 'from', 12],
      ['إلى', 'to', 12],
      ['حفظ جديد', 'new_pages', 12],
      ['مراجعة', 'review_pages', 12],
    ],
    data.trend
  );

  const name = `analytics-${data.period.from}-${data.period.to}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  await wb.xlsx.write(res);
  res.end();
});

export default router;
