// تحليلات أداء الطلاب — كلها من سجلات قاعدة البيانات الفعلية
//
// تعريفات ثابتة (متوافقة مع حساب "إجمالي المحفوظ" في services/students.js):
//   الحفظ الجديد  = مجموع صفحات التسميعات المكتملة من نوع "حفظ جديد" (recitation_type = 'new')
//   المراجعة       = صفحات التسميعات المكتملة من نوع "مراجعة" — لا تُحتسب حفظًا جديدًا أبدًا
//   إجمالي المحفوظ = initial_parts + (صفحات الحفظ الجديد حتى تاريخه ÷ juz_pages)
//   اكتمال السجلات = المواعيد المحسومة (تم/لم يلتزم) ÷ المواعيد التي انتهى وقتها في الفترة (غير الملغاة)
import { query, tx } from '../db.js';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import { addDays, localDateStr } from '../utils/tz.js';
import { notifyAdmins } from './notify.js';

const round = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
export const changePct = (cur, prev) => (prev > 0 ? round(((cur - prev) / prev) * 100, 1) : cur > 0 ? null : 0);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const GROUPS = { male: 'ذكور', female: 'إناث', kids: 'كيدز' };

/** إحصائيات كل طالب في فترة [from, to] */
async function periodStats(from, to, scope) {
  const params = [from, to, config.timezone];
  const where = [`s.status <> 'removed'`];
  if (scope.supervisorId) {
    params.push(scope.supervisorId);
    where.push(`s.supervisor_id = $${params.length}`);
  }
  if (scope.studentId) {
    params.push(scope.studentId);
    where.push(`s.id = $${params.length}`);
  }
  if (scope.group) {
    params.push(scope.group);
    where.push(`sp.supervisor_type = $${params.length}`);
  }
  const { rows } = await query(
    `select s.id, s.full_name, s.gender, s.status, s.initial_parts, s.join_date, s.supervisor_id,
            u.full_name as supervisor_name, sp.supervisor_type,
            coalesce(sum(a.pages) filter (where a.kind = 'recitation' and a.status = 'completed' and a.recitation_type = 'new'), 0) as new_pages,
            coalesce(sum(a.pages) filter (where a.kind = 'recitation' and a.status = 'completed' and a.recitation_type = 'review'), 0) as review_pages,
            count(a.id) filter (where a.kind = 'recitation' and a.status = 'completed') as rec_completed,
            count(a.id) filter (where a.kind = 'recitation' and a.status = 'missed') as rec_missed,
            count(a.id) filter (where a.status <> 'cancelled' and a.end_at < now()) as due,
            count(a.id) filter (where a.status in ('completed', 'missed')) as resolved,
            count(a.id) filter (where a.kind = 'exam' and a.status = 'completed') as exams,
            avg(a.grade) filter (where a.kind = 'exam' and a.status = 'completed') as avg_exam
     from students s
     left join supervisors sp on sp.id = s.supervisor_id
     left join users u on u.id = sp.user_id
     left join appointments a on a.student_id = s.id
       and a.start_at >= ($1::date)::timestamp at time zone $3::text
       and a.start_at < (($2::date + 1)::timestamp at time zone $3::text)
     where ${where.join(' and ')}
     group by s.id, u.full_name, sp.supervisor_type`,
    params
  );
  return rows;
}

/** صفحات الحفظ الجديد لكل طالب حتى نهاية التاريخ to (لحساب إجمالي المحفوظ) */
async function cumulativeNewPages(to) {
  const { rows } = await query(
    `select student_id, coalesce(sum(pages), 0) as pages from appointments
     where kind = 'recitation' and status = 'completed' and recitation_type = 'new'
       and start_at < (($1::date + 1)::timestamp at time zone $2::text)
     group by student_id`,
    [to, config.timezone]
  );
  return new Map(rows.map((r) => [r.student_id, r.pages]));
}

/** اتجاه الحفظ الجديد لآخر n فترات بنفس الطول، منتهية بـ to */
async function trendSeries(to, len, n, scope) {
  const from = addDays(to, -(len * n) + 1);
  const params = [from, to, config.timezone, len];
  const where = [`s.status <> 'removed'`];
  if (scope.supervisorId) {
    params.push(scope.supervisorId);
    where.push(`s.supervisor_id = $${params.length}`);
  }
  if (scope.studentId) {
    params.push(scope.studentId);
    where.push(`s.id = $${params.length}`);
  }
  if (scope.group) {
    params.push(scope.group);
    where.push(`sp.supervisor_type = $${params.length}`);
  }
  const { rows } = await query(
    `select floor(($2::date - (a.start_at at time zone $3::text)::date) / $4::int)::int as bucket,
            sp.supervisor_type as grp,
            coalesce(sum(a.pages) filter (where a.recitation_type = 'new'), 0) as new_pages,
            coalesce(sum(a.pages) filter (where a.recitation_type = 'review'), 0) as review_pages,
            count(distinct a.student_id) as active_students
     from appointments a
     join students s on s.id = a.student_id
     left join supervisors sp on sp.id = s.supervisor_id
     where a.kind = 'recitation' and a.status = 'completed'
       and a.start_at >= ($1::date)::timestamp at time zone $3::text
       and a.start_at < (($2::date + 1)::timestamp at time zone $3::text)
       and ${where.join(' and ')}
     group by 1, 2`,
    params
  );
  const series = [];
  for (let k = n - 1; k >= 0; k--) {
    const end = addDays(to, -k * len);
    const start = addDays(end, -len + 1);
    const inBucket = rows.filter((r) => r.bucket === k);
    const byGroup = {};
    for (const g of Object.keys(GROUPS)) byGroup[g] = inBucket.filter((r) => r.grp === g).reduce((t, r) => t + r.new_pages, 0);
    series.push({
      from: start,
      to: end,
      new_pages: round(inBucket.reduce((t, r) => t + r.new_pages, 0), 1),
      review_pages: round(inBucket.reduce((t, r) => t + r.review_pages, 0), 1),
      by_group: byGroup,
    });
  }
  return series;
}

function aggregate(list) {
  const due = list.reduce((t, r) => t + r.due, 0);
  const resolved = list.reduce((t, r) => t + r.resolved, 0);
  const recDone = list.reduce((t, r) => t + r.rec_completed, 0);
  const recMissed = list.reduce((t, r) => t + r.rec_missed, 0);
  const active = list.filter((r) => r.status === 'active');
  const newPages = list.reduce((t, r) => t + r.new_pages, 0);
  const prevPages = list.reduce((t, r) => t + r.prev_new_pages, 0);
  return {
    students: active.length,
    new_pages: round(newPages, 1),
    prev_new_pages: round(prevPages, 1),
    change_pct: changePct(newPages, prevPages),
    review_pages: round(list.reduce((t, r) => t + r.review_pages, 0), 1),
    avg_new_pages: active.length ? round(newPages / active.length, 2) : null,
    participating: active.filter((r) => r.rec_completed > 0).length,
    participation_rate: active.length ? Math.round((100 * active.filter((r) => r.rec_completed > 0).length) / active.length) : null,
    commitment_rate: recDone + recMissed ? Math.round((100 * recDone) / (recDone + recMissed)) : null,
    completeness_rate: due ? Math.round((100 * resolved) / due) : null,
    no_progress: active.filter((r) => r.new_pages === 0).length,
  };
}

/**
 * التحليلات الكاملة لفترة.
 * scope: { supervisorId, studentId, group }
 */
export async function computeAnalytics({ from, to, supervisorId = null, studentId = null, group = null, trendPeriods = 8 }) {
  const settings = await getSettings();
  const juz = Number(settings.juz_pages) || 20;
  const len = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -len + 1);
  const scope = { supervisorId, studentId, group };

  const [cur, prev, cum, trend] = await Promise.all([
    periodStats(from, to, scope),
    periodStats(prevFrom, prevTo, scope),
    cumulativeNewPages(to),
    trendSeries(to, len, trendPeriods, scope),
  ]);
  const prevById = new Map(prev.map((r) => [r.id, r]));

  const students = cur
    .map((r) => {
      const p = prevById.get(r.id);
      const prevNew = p ? p.new_pages : 0;
      return {
        id: r.id,
        full_name: r.full_name,
        gender: r.gender,
        status: r.status,
        supervisor_id: r.supervisor_id,
        supervisor_name: r.supervisor_name,
        group: r.supervisor_type,
        new_pages: round(r.new_pages, 1),
        prev_new_pages: round(prevNew, 1),
        change_pct: changePct(r.new_pages, prevNew),
        review_pages: round(r.review_pages, 1),
        rec_completed: r.rec_completed,
        rec_missed: r.rec_missed,
        due: r.due,
        resolved: r.resolved,
        exams: r.exams,
        avg_exam: round(r.avg_exam, 1),
        total_juz: round(Number(r.initial_parts) + (cum.get(r.id) || 0) / juz, 2),
        // لم يبدأ بعد = انضم بعد نهاية الفترة
        not_started: r.join_date > to,
      };
    })
    .filter((s) => !s.not_started)
    .sort((a, b) => b.new_pages - a.new_pages || a.full_name.localeCompare(b.full_name, 'ar'));
  students.forEach((s, i) => {
    s.rank = i + 1;
  });

  const bySup = new Map();
  for (const s of students) {
    if (!s.supervisor_id) continue;
    if (!bySup.has(s.supervisor_id)) bySup.set(s.supervisor_id, []);
    bySup.get(s.supervisor_id).push(s);
  }
  const supervisors = [...bySup.entries()]
    .map(([id, list]) => ({ id, full_name: list[0].supervisor_name, group: list[0].group, ...aggregate(list) }))
    .sort((a, b) => (b.avg_new_pages ?? 0) - (a.avg_new_pages ?? 0) || b.new_pages - a.new_pages);
  supervisors.forEach((s, i) => {
    s.rank = i + 1;
  });

  const groups = Object.entries(GROUPS)
    .map(([key, label]) => ({ key, label, ...aggregate(students.filter((s) => s.group === key)) }))
    .filter((g) => g.students > 0 || g.new_pages > 0);

  const totals = aggregate(students);
  totals.forum_total_juz = round(students.filter((s) => s.status === 'active').reduce((t, s) => t + s.total_juz, 0), 2);

  return {
    period: { from, to, days: len },
    previous: { from: prevFrom, to: prevTo },
    definitions: {
      new_pages: 'صفحات التسميعات المكتملة من نوع «حفظ جديد» فقط (المراجعة لا تُحتسب)',
      total_juz: `المحفوظ عند الانضمام + صفحات الحفظ الجديد ÷ ${juz}`,
      completeness: 'المواعيد المسجّلة نتيجتها ÷ المواعيد التي انتهى وقتها (غير الملغاة)',
    },
    totals,
    students,
    no_progress: students.filter((s) => s.status === 'active' && s.new_pages === 0),
    supervisors,
    groups,
    trend,
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- التقرير الدوري التلقائي (كل 14 يومًا)
export function reportPeriodContaining(date, s) {
  const len = Math.max(1, Number(s.report_period_days) || 14);
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(s.report_anchor_date || '') ? s.report_anchor_date : '2026-01-03';
  const k = Math.floor(daysBetween(anchor, date) / len);
  const start = addDays(anchor, k * len);
  return { start, end: addDays(start, len - 1), len };
}

/** يولّد التقارير المكتملة غير المولّدة (حتى 6 فترات للخلف). idempotent */
export async function generateDueReports({ now = new Date(), trigger = 'cron', maxBack = 6 } = {}) {
  const s = await getSettings();
  const today = localDateStr(now);
  const cur = reportPeriodContaining(today, s);
  const generated = [];
  for (let k = 1; k <= maxBack; k++) {
    const start = addDays(cur.start, -k * cur.len);
    const end = addDays(start, cur.len - 1);
    const { rowCount } = await query('select 1 from performance_reports where period_start = $1', [start]);
    if (rowCount) continue;
    // لا تولّد تقارير لفترات قبل أول نشاط في النظام
    const { rows: first } = await query(`select min(start_at) as m from appointments`);
    if (!first[0].m || localDateStr(new Date(first[0].m)) > end) continue;
    const data = await computeAnalytics({ from: start, to: end });
    const inserted = await tx(async (c) => {
      const r = await c.query(
        `insert into performance_reports (period_start, period_end, generated_by, data) values ($1, $2, $3, $4)
         on conflict (period_start) do nothing returning id`,
        [start, end, trigger, JSON.stringify(data)]
      );
      if (r.rowCount) {
        await notifyAdmins(c, {
          type: 'report_ready',
          title: 'تقرير الأداء الدوري جاهز',
          body: `فترة ${start} — ${end}: ${data.totals.new_pages} صفحة حفظ جديد (${data.totals.change_pct === null ? '—' : `${data.totals.change_pct}%`} مقارنة بالفترة السابقة).`,
          link: `/analytics?report=${r.rows[0].id}`,
          dedupeKey: `report:${start}`,
        });
      }
      return r.rowCount > 0;
    });
    if (inserted) generated.push(start);
  }
  return { generated };
}
