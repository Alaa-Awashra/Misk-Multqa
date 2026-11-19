// اختبارات تكامل شاملة على قاعدة PostgreSQL حقيقية مؤقتة وخادم Express الفعلي
// تشغيل: npm test   (لا يحتاج قاعدة بيانات — يُنشئ واحدة مؤقتة ويحذفها)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, client, makeSupervisor, makeStudent, insertAppointment } from './helpers.js';

let ctx;
let admin;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** يفرّغ صندوق البريد حتى لا يبقى شيء مستحق (يتجنب السباق مع المعالجة الخلفية) */
async function flushMail() {
  for (let i = 0; i < 20; i++) {
    await wait(300);
    await ctx.outbox.outboxIdle();
    await ctx.outbox.processOutbox();
    const { rows } = await ctx.pool.query(
      `select count(*)::int as n from email_outbox where status in ('pending', 'sending') and next_attempt_at <= now()`
    );
    if (!rows[0].n) return;
  }
}

/** وقت محلي (Asia/Hebron) بعد n يوم الساعة hh:mm */
async function localTs(daysAhead, hm = '16:00') {
  const { rows } = await ctx.pool.query(
    `select (((now() at time zone 'Asia/Hebron')::date + $1::int) + $2::time) at time zone 'Asia/Hebron' as t`,
    [daysAhead, hm]
  );
  return new Date(rows[0].t).toISOString();
}

/** يؤكد بريد المستخدم عبر رابط التأكيد الفعلي المرسَل */
async function verifyEmailOf(username) {
  await flushMail();
  const { rows } = await ctx.pool.query('select email from users where username = $1', [username]);
  const msg = [...ctx.mail.sent].reverse().find((m) => m.to === rows[0].email && /verify-email\?token=/.test(m.text));
  assert.ok(msg, 'verification email should have been sent');
  const token = msg.text.match(/token=([A-Za-z0-9_-]+)/)[1];
  const r = await client(ctx.base).post('/auth/verify-email', { token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

before(async () => {
  ctx = await setup();
  admin = client(ctx.base);
  await admin.login('admin', 'admin-pass-123');
});

after(async () => {
  await ctx?.stop();
});

// =====================================================================
describe('طلبات حذف/فصل الطلاب', () => {
  let supA;
  let supB;
  let st1;
  let st2;
  before(async () => {
    supA = await makeSupervisor(ctx, admin);
    supB = await makeSupervisor(ctx, admin);
    st1 = await makeStudent(supA);
    st2 = await makeStudent(supA);
    await insertAppointment(ctx.pool, { studentId: st1.id, supervisorId: supA.id, start: '2026-03-01T14:00:00Z', pages: 4 });
  });

  it('المشرف لا يستطيع الحذف أو الفصل المباشر', async () => {
    assert.equal((await supA.client.del(`/students/${st1.id}`)).status, 403);
    assert.equal((await supA.client.post(`/students/${st1.id}/suspend`, { reason: 'x' })).status, 403);
    assert.equal((await supA.client.post(`/students/${st1.id}/reinstate`)).status, 403);
    const { rows } = await ctx.pool.query('select status from students where id = $1', [st1.id]);
    assert.equal(rows[0].status, 'active');
  });

  it('المشرف يرسل طلبًا، ولا يمكن تكراره، ولا يستطيع مشرف آخر الوصول', async () => {
    const r = await supA.client.post(`/students/${st1.id}/requests`, { kind: 'removal', reason: 'انتقل إلى مدينة أخرى', comments: 'بطلب الأهل' });
    assert.equal(r.status, 201);
    assert.equal((await supA.client.post(`/students/${st1.id}/requests`, { kind: 'dismissal', reason: 'تكرار' })).status, 409);
    assert.equal((await supB.client.post(`/students/${st1.id}/requests`, { kind: 'removal', reason: 'x' })).status, 404);
    assert.equal((await supA.client.post(`/student-requests/${r.data.request.id}/approve`)).status, 403);
    const list = await admin.get('/student-requests?status=pending');
    assert.ok(list.data.requests.some((x) => x.id === r.data.request.id));
    const n = await ctx.pool.query(`select 1 from notifications n join users u on u.id = n.user_id where u.role = 'admin' and n.type = 'student_request'`);
    assert.ok(n.rowCount >= 1);
  });

  it('موافقة المسؤول = حذف ناعم يحفظ السجلات + إشعار المشرف', async () => {
    const { data } = await admin.get('/student-requests?status=pending');
    const req = data.requests.find((x) => x.student_id === st1.id);
    assert.equal((await admin.post(`/student-requests/${req.id}/approve`, { note: 'تمت الموافقة' })).status, 200);
    assert.equal((await admin.post(`/student-requests/${req.id}/approve`)).status, 409, 'لا يمكن البت مرتين');
    const { rows } = await ctx.pool.query('select status, removed_at from students where id = $1', [st1.id]);
    assert.equal(rows[0].status, 'removed');
    assert.ok(rows[0].removed_at);
    const appts = await ctx.pool.query('select count(*)::int as n from appointments where student_id = $1', [st1.id]);
    assert.equal(appts.rows[0].n, 1, 'سجلات التسميع محفوظة');
    const mine = await supA.client.get('/students');
    assert.ok(!mine.data.students.some((s) => s.id === st1.id));
    assert.equal((await supA.client.get(`/students/${st1.id}`)).status, 404);
    const all = await admin.get('/students?include_removed=true');
    assert.ok(all.data.students.some((s) => s.id === st1.id && s.status === 'removed'));
    const notif = await supA.client.get('/notifications');
    assert.ok(notif.data.notifications.some((x) => x.type === 'student_request_decision'));
  });

  it('رفض طلب الفصل يُبقي الطالب نشطًا ويُشعر المشرف', async () => {
    const r = await supA.client.post(`/students/${st2.id}/requests`, { kind: 'dismissal', reason: 'غياب متكرر' });
    assert.equal((await admin.post(`/student-requests/${r.data.request.id}/reject`, { note: 'أعطه فرصة' })).status, 200);
    const { rows } = await ctx.pool.query('select status from students where id = $1', [st2.id]);
    assert.equal(rows[0].status, 'active');
    const list = await supA.client.get('/student-requests');
    assert.equal(list.data.requests.find((x) => x.id === r.data.request.id).status, 'rejected');
    assert.ok(!list.data.requests.some((x) => x.supervisor_id !== supA.id), 'المشرف يرى طلباته فقط');
  });

  it('المسؤول يستعيد الطالب المحذوف', async () => {
    assert.equal((await admin.post(`/students/${st1.id}/restore`)).status, 200);
    const { rows } = await ctx.pool.query('select status from students where id = $1', [st1.id]);
    assert.equal(rows[0].status, 'suspended');
  });
});

// =====================================================================
describe('التحذيرات الرسمية والإيقاف التلقائي', () => {
  let sup;
  let other;
  let student;
  before(async () => {
    sup = await makeSupervisor(ctx, admin);
    other = await makeSupervisor(ctx, admin);
    student = await makeStudent(sup);
    await verifyEmailOf(sup.username);
  });

  it('البريد إلزامي عند إنشاء المشرف', async () => {
    const r = await admin.post('/supervisors', { full_name: 'بدون بريد', supervisor_type: 'male' });
    assert.equal(r.status, 400);
    const bad = await admin.post('/supervisors', { full_name: 'بريد خطأ', supervisor_type: 'male', email: 'not-an-email' });
    assert.equal(bad.status, 400);
  });

  it('التحذير الأول: إشعار + بريد، والحساب يبقى فعالًا', async () => {
    ctx.mail.sent.length = 0;
    const r = await admin.post(`/supervisors/${sup.id}/warnings`, { reason: 'تأخر في تسجيل النتائج', notes: 'ملاحظة' });
    assert.equal(r.status, 201);
    assert.equal(r.data.active_warnings, 1);
    assert.equal(r.data.dismissed, false);
    assert.equal((await sup.client.get('/auth/me')).status, 200);
    await flushMail();
    assert.ok(ctx.mail.sent.some((m) => /تحذير إداري رسمي/.test(m.subject)));
    const rec = await sup.client.get('/profile/record');
    assert.equal(rec.data.active_warnings, 1);
  });

  it('التحذير الثاني: إيقاف تلقائي + إشعار المشرف والإدارة + حفظ الطلاب', async () => {
    const r = await admin.post(`/supervisors/${sup.id}/warnings`, { reason: 'تكرار المخالفة' });
    assert.equal(r.status, 201);
    assert.equal(r.data.dismissed, true);
    assert.equal(r.data.supervisor.status, 'suspended');
    assert.equal((await sup.client.get('/auth/me')).status, 403, 'المشرف الموقوف لا يصل للمنصة');
    assert.equal((await sup.client.get('/students')).status, 403);
    await flushMail();
    assert.ok(ctx.mail.sent.some((m) => /إيقاف صلاحيات الإشراف/.test(m.subject)));
    const n = await ctx.pool.query(`select 1 from notifications n join users u on u.id = n.user_id where u.role = 'admin' and n.type = 'supervisor_dismissed'`);
    assert.ok(n.rowCount >= 1);
    const st = await ctx.pool.query('select status, supervisor_id from students where id = $1', [student.id]);
    assert.equal(st.rows[0].status, 'active');
    assert.equal((await admin.post(`/students/${student.id}/transfer`, { supervisor_id: other.id })).status, 200, 'نقل الطلاب لمشرف آخر');
    const log = await ctx.pool.query(`select 1 from activity_log where action = 'supervisor.auto_dismiss' and entity_id = $1`, [sup.id]);
    assert.equal(log.rowCount, 1);
  });

  it('إلغاء تحذير خاطئ يُسجَّل ويبقى في السجل', async () => {
    const { data } = await admin.get(`/supervisors/${sup.id}`);
    const w = data.warnings[0];
    const r = await admin.post(`/supervisors/${sup.id}/warnings/${w.id}/revoke`, { reason: 'صدر بالخطأ' });
    assert.equal(r.status, 200);
    assert.equal(r.data.active_warnings, 1);
    const all = await ctx.pool.query('select status from supervisor_warnings where supervisor_id = $1', [sup.id]);
    assert.equal(all.rowCount, 2, 'التاريخ محفوظ');
    assert.equal((await admin.post(`/supervisors/${sup.id}/reinstate`)).status, 200);
    assert.equal((await sup.client.get('/auth/me')).status, 200);
  });
});

// =====================================================================
describe('متابعة اكتمال السجلات آليًا', () => {
  let svc;
  let periods;
  let supV;
  let supLeave;
  let supNew;
  before(async () => {
    svc = await import('../src/services/compliance.js');
    const { localDateStr, addDays } = await import('../src/utils/tz.js');
    const cfgBase = { anchor: '2026-01-03', periodDays: 7 };
    const cur = svc.periodContaining(localDateStr(), cfgBase);
    const p1 = { start: addDays(cur.start, -14), end: addDays(cur.start, -8) };
    const p2 = { start: addDays(cur.start, -7), end: addDays(cur.start, -1) };
    periods = { p1, p2, cur };
    // تُقيَّم فقط الفترتان p1 و p2 لمشرفي هذا الاختبار
    await admin.put('/settings', {
      compliance_enabled: true,
      compliance_anchor_date: '2026-01-03',
      compliance_period_days: 7,
      compliance_grace_days: 0,
      compliance_min_records: 1,
      compliance_warning_after: 2,
      compliance_lookback_days: 365,
      compliance_start_date: p1.start,
    });
    // المشرفون الآخرون في الاختبارات السابقة لا يجب أن يُعاقَبوا: نعفيهم صراحة
    await ctx.pool.query(
      `insert into compliance_exemptions (supervisor_id, kind, start_date, end_date, reason)
       select id, 'exempt', $1, $2, 'test isolation' from supervisors`,
      [p1.start, p2.end]
    );

    supV = await makeSupervisor(ctx, admin);
    supLeave = await makeSupervisor(ctx, admin);
    supNew = await makeSupervisor(ctx, admin);
    await verifyEmailOf(supV.username);
    const sV = await makeStudent(supV);
    const sL = await makeStudent(supLeave);
    await makeStudent(supNew, { joinDate: cur.start }); // لم يبدأ قبل الفترات المقيّمة
    await ctx.pool.query(`update students set created_at = '2026-01-01' where id = any($1::uuid[])`, [[sV.id, sL.id]]);
    // p1: تسميع مكتمل + موعد بلا نتيجة → مخالفة 1 (تذكير)
    await insertAppointment(ctx.pool, { studentId: sV.id, supervisorId: supV.id, start: `${p1.start}T13:00:00Z`, pages: 2 });
    await insertAppointment(ctx.pool, { studentId: sV.id, supervisorId: supV.id, start: `${p1.start}T15:00:00Z`, status: 'scheduled' });
    // p2: لا شيء → مخالفة 2 (تحذير رسمي)
    await admin.post('/compliance/exemptions', { supervisor_id: supLeave.id, kind: 'leave', start_date: p1.start, end_date: p2.end, reason: 'إجازة معتمدة' });
  });

  it('المخالفة الأولى تذكير، الثانية تحذير رسمي', async () => {
    const r = await svc.runComplianceJob();
    assert.ok(r.evaluated >= 2, JSON.stringify(r));
    const { rows } = await ctx.pool.query(
      `select period_start, status, action, violation_number, missing_count from compliance_reviews where supervisor_id = $1 order by period_start`,
      [supV.id]
    );
    assert.deepEqual(
      rows.map((x) => [x.period_start, x.status, x.action, x.violation_number]),
      [
        [periods.p1.start, 'violation', 'reminder', 1],
        [periods.p2.start, 'violation', 'warning', 2],
      ]
    );
    assert.equal(rows[0].missing_count, 1, 'p1: موعد بلا نتيجة فقط (الطالب لديه تسميع)');
    const w = await ctx.pool.query(`select source from supervisor_warnings where supervisor_id = $1`, [supV.id]);
    assert.equal(w.rowCount, 1);
    assert.equal(w.rows[0].source, 'compliance');
  });

  it('التشغيل المتكرر لا يُنشئ مخالفات أو إشعارات مكررة', async () => {
    const before = await ctx.pool.query(`select count(*)::int as n from notifications where user_id = (select user_id from supervisors where id = $1)`, [supV.id]);
    await svc.runComplianceJob();
    await svc.runComplianceJob();
    const reviews = await ctx.pool.query(`select count(*)::int as n from compliance_reviews where supervisor_id = $1`, [supV.id]);
    assert.equal(reviews.rows[0].n, 2);
    const warnings = await ctx.pool.query(`select count(*)::int as n from supervisor_warnings where supervisor_id = $1`, [supV.id]);
    assert.equal(warnings.rows[0].n, 1);
    const afterN = await ctx.pool.query(`select count(*)::int as n from notifications where user_id = (select user_id from supervisors where id = $1)`, [supV.id]);
    assert.equal(afterN.rows[0].n, before.rows[0].n);
  });

  it('الإجازة المعتمدة والطلاب الذين لم يبدؤوا لا يسببون مخالفات', async () => {
    const leave = await ctx.pool.query(`select status from compliance_reviews where supervisor_id = $1`, [supLeave.id]);
    assert.ok(leave.rows.length && leave.rows.every((r) => r.status === 'exempt'));
    const fresh = await ctx.pool.query(`select status from compliance_reviews where supervisor_id = $1`, [supNew.id]);
    assert.ok(fresh.rows.length && fresh.rows.every((r) => r.status === 'ok'), JSON.stringify(fresh.rows));
    const w = await ctx.pool.query(`select 1 from supervisor_warnings where supervisor_id = any($1::uuid[])`, [[supLeave.id, supNew.id]]);
    assert.equal(w.rowCount, 0);
  });

  it('المشرف يرى البنود الناقصة، وعذر المسؤول يلغي التحذير المرتبط', async () => {
    const rec = await supV.client.get('/profile/record');
    assert.equal(rec.status, 200);
    assert.equal(rec.data.compliance.violations_in_window, 2);
    const { rows } = await ctx.pool.query(`select id from compliance_reviews where supervisor_id = $1 and action = 'warning'`, [supV.id]);
    const r = await admin.post(`/compliance/reviews/${rows[0].id}/excuse`, { reason: 'ظرف صحي' });
    assert.equal(r.status, 200);
    assert.equal(r.data.warning_revoked, true);
    const w = await ctx.pool.query(`select status from supervisor_warnings where supervisor_id = $1`, [supV.id]);
    assert.equal(w.rows[0].status, 'revoked');
  });

  it('نقطة Supabase Cron محمية بالسر وتعمل', async () => {
    const anon = await fetch(`${ctx.base}/api/cron/tick`, { method: 'POST' });
    assert.equal(anon.status, 401);
    const wrong = await fetch(`${ctx.base}/api/cron/tick`, { method: 'POST', headers: { 'x-cron-secret': 'wrong' } });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`${ctx.base}/api/cron/tick`, { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.results.compliance.ok, true);
    assert.equal(body.results.reports.ok, true);
  });
});

// =====================================================================
describe('تحليلات الأداء', () => {
  let sup;
  let a;
  let b;
  let c;
  const from = '2026-02-01';
  const to = '2026-02-14';
  before(async () => {
    sup = await makeSupervisor(ctx, admin, { type: 'female' });
    a = await makeStudent(sup, { gender: 'female' });
    b = await makeStudent(sup, { gender: 'female' });
    c = await makeStudent(sup, { gender: 'female' });
    await ctx.pool.query(`update students set initial_parts = 1 where id = $1`, [a.id]);
    const ins = (o) => insertAppointment(ctx.pool, { supervisorId: sup.id, ...o });
    // الفترة الحالية
    await ins({ studentId: a.id, start: '2026-02-03T10:00:00Z', pages: 3 });
    await ins({ studentId: a.id, start: '2026-02-05T10:00:00Z', pages: 2 });
    await ins({ studentId: a.id, start: '2026-02-06T10:00:00Z', pages: 3, type: 'review' }); // مراجعة — لا تُحتسب
    await ins({ studentId: b.id, start: '2026-02-10T10:00:00Z', pages: 2 });
    await ins({ studentId: b.id, start: '2026-02-11T10:00:00Z', status: 'missed' });
    // الفترة السابقة
    await ins({ studentId: a.id, start: '2026-01-25T10:00:00Z', pages: 2 });
    await ins({ studentId: b.id, start: '2026-01-26T10:00:00Z', pages: 4 });
  });

  it('حسابات دقيقة: المراجعة لا تُحتسب حفظًا جديدًا، المقارنة والترتيب', async () => {
    const r = await admin.get(`/analytics?from=${from}&to=${to}&supervisor_id=${sup.id}`);
    assert.equal(r.status, 200);
    const d = r.data;
    assert.equal(d.totals.new_pages, 7);
    assert.equal(d.totals.review_pages, 3);
    assert.equal(d.totals.prev_new_pages, 6);
    assert.equal(d.totals.change_pct, 16.7);
    const sa = d.students.find((s) => s.id === a.id);
    const sb = d.students.find((s) => s.id === b.id);
    assert.equal(sa.new_pages, 5);
    assert.equal(sa.prev_new_pages, 2);
    assert.equal(sa.change_pct, 150);
    assert.equal(sa.rank, 1);
    assert.equal(sb.change_pct, -50);
    assert.equal(sa.total_juz, 1.35, '1 + (2+3+2)/20');
    assert.deepEqual(d.no_progress.map((s) => s.id), [c.id]);
    assert.equal(d.totals.participation_rate, 67);
    assert.equal(d.totals.commitment_rate, 80);
    assert.equal(d.supervisors.length, 1);
    assert.equal(d.supervisors[0].new_pages, 7);
    assert.equal(d.groups.find((g) => g.key === 'female').new_pages, 7);
    const trendLast = d.trend[d.trend.length - 1];
    assert.equal(trendLast.new_pages, 7);
    assert.equal(d.trend[d.trend.length - 2].new_pages, 6);
  });

  it('تصدير Excel حقيقي (.xlsx)', async () => {
    const r = await admin.get(`/analytics/export.xlsx?from=${from}&to=${to}&supervisor_id=${sup.id}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /spreadsheetml/);
    const buf = Buffer.from(r.data);
    assert.equal(buf.subarray(0, 2).toString(), 'PK');
  });

  it('توليد التقارير الدورية آمن للتكرار', async () => {
    const { generateDueReports } = await import('../src/services/analytics.js');
    const first = await generateDueReports();
    const second = await generateDueReports();
    assert.equal(second.generated.length, 0);
    const list = await admin.get('/analytics/reports');
    assert.ok(list.data.reports.length >= first.generated.length);
  });

  it('غير المسؤول لا يصل للتحليلات', async () => {
    assert.equal((await sup.client.get(`/analytics?from=${from}&to=${to}`)).status, 403);
  });
});

// =====================================================================
describe('التواصل مع الإدارة — الخصوصية', () => {
  let a;
  let b;
  let convId;
  before(async () => {
    a = await makeSupervisor(ctx, admin);
    b = await makeSupervisor(ctx, admin);
  });

  it('المشرف ينشئ محادثة والإدارة ترد، والعدادات صحيحة', async () => {
    const r = await a.client.post('/messages/conversations', { subject: 'استفسار عن الجدول', category: 'question', body: 'متى اجتماع المشرفين؟' });
    assert.equal(r.status, 201);
    convId = r.data.id;
    const sum = await admin.get('/notifications/summary');
    assert.ok(sum.data.messages >= 1);
    assert.equal((await admin.post(`/messages/conversations/${convId}/messages`, { body: 'يوم الخميس إن شاء الله' })).status, 201);
    const conv = await ctx.pool.query('select status from conversations where id = $1', [convId]);
    assert.equal(conv.rows[0].status, 'in_progress');
    assert.equal((await a.client.get('/notifications/summary')).data.messages, 1);
    const view = await a.client.get(`/messages/conversations/${convId}`);
    assert.equal(view.data.messages.length, 2);
    assert.equal((await a.client.get('/notifications/summary')).data.messages, 0);
  });

  it('مشرف آخر لا يصل للمحادثة إطلاقًا', async () => {
    assert.equal((await b.client.get(`/messages/conversations/${convId}`)).status, 404);
    assert.equal((await b.client.post(`/messages/conversations/${convId}/messages`, { body: 'تطفل' })).status, 404);
    assert.equal((await b.client.post(`/messages/conversations/${convId}/status`, { status: 'closed' })).status, 404);
    const list = await b.client.get('/messages/conversations');
    assert.ok(!list.data.conversations.some((x) => x.id === convId));
  });

  it('حالات المحادثة: الإدارة تغلق، والمشرف لا يغيّر إلا للإغلاق', async () => {
    assert.equal((await a.client.post(`/messages/conversations/${convId}/status`, { status: 'in_progress' })).status, 403);
    assert.equal((await admin.post(`/messages/conversations/${convId}/status`, { status: 'closed' })).status, 200);
    await a.client.post(`/messages/conversations/${convId}/messages`, { body: 'سؤال إضافي' });
    const conv = await ctx.pool.query('select status from conversations where id = $1', [convId]);
    assert.equal(conv.rows[0].status, 'open', 'رد المشرف يعيد فتح المحادثة');
  });
});

// =====================================================================
describe('مشرف التسجيل والقبول + مزامنة Google Forms', () => {
  let reg;
  let sup;
  let existing;
  let formId;
  const sheetAppends = [];
  let responses = [];

  before(async () => {
    const r = await admin.post('/staff', { full_name: 'مشرف التسجيل', email: `reg-${Date.now()}@example.org` });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    reg = client(ctx.base);
    await reg.login(r.data.username, r.data.password);
    sup = await makeSupervisor(ctx, admin);
    existing = await makeStudent(sup, { name: 'أحمد محمود سالم' });
    await ctx.pool.query(`update students set phone = '0599111222' where id = $1`, [existing.id]);

    const { encrypt } = await import('../src/utils/crypto.js');
    await ctx.pool.query(`insert into integration_secrets (key, value_enc, meta) values ('google', $1, '{"email":"forum@example.org"}')`, [encrypt('refresh-token')]);
    const google = await import('../src/services/google.js');
    google.__setGoogleFetch(async (url, opts = {}) => {
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3600 });
      if (url === 'https://forms.googleapis.com/v1/forms') return json({ formId: 'FORM1', responderUri: 'https://docs.google.com/forms/d/e/FORM1/viewform' });
      if (url.endsWith(':batchUpdate')) {
        const reqs = JSON.parse(opts.body).requests.filter((x) => x.createItem);
        return json({ replies: reqs.map((_, i) => ({ createItem: { itemId: `i${i}`, questionId: [`q${i}`] } })) });
      }
      if (url.endsWith(':setPublishSettings')) return json({});
      if (url === 'https://sheets.googleapis.com/v4/spreadsheets') return json({ spreadsheetId: 'SHEET1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/SHEET1' });
      if (url.includes('/values/')) {
        sheetAppends.push(JSON.parse(opts.body).values);
        return json({});
      }
      if (url.includes('/responses')) return json({ responses });
      return json({ error: { message: `unexpected ${url}` } }, 404);
    });
  });

  it('مشرف التسجيل ممنوع من الصفحات غير المصرح بها (على الخادم)', async () => {
    for (const [m, u] of [
      ['get', '/students'],
      ['get', '/supervisors'],
      ['get', `/supervisors/${sup.id}`],
      ['post', `/supervisors/${sup.id}/warnings`],
      ['get', '/analytics'],
      ['get', '/dashboard'],
      ['get', '/reports/warnings'],
      ['get', '/appointments'],
      ['put', '/settings'],
      ['get', '/compliance/overview'],
      ['get', '/student-requests'],
      ['get', '/activity'],
      ['get', '/staff'],
      ['delete', `/students/${existing.id}`],
    ]) {
      const r = await reg[m === 'delete' ? 'del' : m](u, m === 'get' ? undefined : { reason: 'x' });
      assert.equal(r.status, 403, `${m.toUpperCase()} ${u} → ${r.status}`);
    }
    assert.equal((await reg.get('/admissions/applications')).status, 200);
    assert.equal((await sup.client.get('/admissions/applications')).status, 403, 'المشرف العادي لا يصل للقبول');
  });

  it('إنشاء نموذج Google مع جدول خاص', async () => {
    const r = await reg.post('/admissions/forms', { title: 'تسجيل الدورة الصيفية' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    formId = r.data.form.id;
    assert.equal(r.data.form.responder_url, 'https://docs.google.com/forms/d/e/FORM1/viewform');
    assert.equal(r.data.form.sheet_id, 'SHEET1');
    assert.equal(Object.keys(r.data.form.question_map).length, 10);
  });

  it('المزامنة تستورد الاستجابات مرة واحدة وتكشف التكرار', async () => {
    const ans = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { textAnswers: { answers: [{ value: v }] } }]));
    // q0 الاسم، q1 الجنس، q2 الميلاد، q3 الهاتف، q4 البريد
    responses = [
      { responseId: 'r1', lastSubmittedTime: '2026-11-01T10:00:00Z', answers: ans({ q0: 'يوسف خالد', q1: 'ذكر', q2: '2014-05-01', q3: '+970 59-888-7777', q4: 'parent@example.org', q8: '٢٫٥' }) },
      { responseId: 'r2', lastSubmittedTime: '2026-11-01T11:00:00Z', answers: ans({ q0: 'يوسف  خالد', q1: 'ذكر', q2: '2014-05-01', q3: '0598887777' }) },
      { responseId: 'r3', lastSubmittedTime: '2026-11-01T12:00:00Z', answers: ans({ q0: 'أحمد محمود سالم', q1: 'ذكر', q2: '2012-01-01', q3: '0599111222' }) },
    ];
    const r = await reg.post(`/admissions/forms/${formId}/sync`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.imported, 3);
    const again = await reg.post(`/admissions/forms/${formId}/sync`);
    assert.equal(again.data.imported, 0, 'لا تكرار في الاستيراد');
    assert.equal(sheetAppends.at(-1).length, 3, 'نسخ الصفوف إلى Google Sheet');

    const list = await reg.get('/admissions/applications');
    const byResp = Object.fromEntries((await ctx.pool.query(`select response_id, duplicate_reason, prior_parts, phone from applications`)).rows.map((x) => [x.response_id, x]));
    assert.equal(list.data.applications.length, 3);
    assert.equal(byResp.r1.duplicate_reason, null);
    assert.equal(byResp.r1.prior_parts, 2.5, 'تحويل الأرقام العربية');
    assert.match(byResp.r2.duplicate_reason, /طلب سابق/);
    assert.match(byResp.r3.duplicate_reason, /طالب مسجّل/);
  });

  it('القبول ينشئ الطالب ويعيّنه للمشرف، والرفض يحفظ السجل', async () => {
    const { rows } = await ctx.pool.query(`select id from applications where response_id in ('r1','r2') order by response_id`);
    assert.equal((await reg.post(`/admissions/applications/${rows[0].id}/review`)).status, 200);
    assert.equal((await reg.post(`/admissions/applications/${rows[0].id}/notes`, { note: 'مقابلة ممتازة' })).status, 200);
    const acc = await reg.post(`/admissions/applications/${rows[0].id}/accept`, { supervisor_id: sup.id });
    assert.equal(acc.status, 200, JSON.stringify(acc.data));
    const mine = await sup.client.get('/students');
    const st = mine.data.students.find((s) => s.id === acc.data.student_id);
    assert.ok(st, 'الطالب ظهر عند المشرف');
    assert.equal(st.initial_parts, 2.5);
    assert.equal((await reg.post(`/admissions/applications/${rows[0].id}/accept`, { supervisor_id: sup.id })).status, 409);
    assert.equal((await reg.post(`/admissions/applications/${rows[1].id}/reject`, { note: 'طلب مكرر' })).status, 200);
    const detail = await reg.get(`/admissions/applications/${rows[0].id}`);
    assert.deepEqual(
      detail.data.events.map((e) => e.action),
      ['imported', 'review', 'note', 'accepted']
    );
    await flushMail();
    assert.ok(ctx.mail.sent.some((m) => m.to === 'parent@example.org' && /قبول/.test(m.subject)));
    assert.equal((await reg.get(`/students/${acc.data.student_id}`)).status, 403, 'لا يصل لسجل الطالب بعد القبول');
  });
});

// =====================================================================
describe('الإعلانات', () => {
  let sup;
  let reg;
  let annId;
  before(async () => {
    sup = await makeSupervisor(ctx, admin);
    await verifyEmailOf(sup.username);
    const r = await admin.post('/staff', { full_name: 'مسجل 2', email: `reg2-${Date.now()}@example.org` });
    reg = client(ctx.base);
    await reg.login(r.data.username, r.data.password);
  });

  it('إعلان المشرفين يصل للمشرفين فقط وبريد واحد لكل مستلم', async () => {
    ctx.mail.sent.length = 0;
    const r = await admin.post('/announcements', { title: 'اجتماع المشرفين', body: 'الخميس 5 مساءً', category: 'meeting', audience: 'supervisors', send_email: true });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    annId = r.data.announcement.id;
    await flushMail();
    const { rows } = await ctx.pool.query('select email from users where username = $1', [sup.username]);
    const diag = (await ctx.pool.query(`select template, status, attempts, last_error, created_at from email_outbox where to_email = $1`, [rows[0].email])).rows;
    const ver = (await ctx.pool.query(`select u.email_verified_at, u.is_active, sp.status, (select count(*) from notifications n where n.user_id = u.id and n.type = $2) as ann from users u join supervisors sp on sp.user_id = u.id where username = $1`, [sup.username, "announcement"])).rows;
    assert.equal(ctx.mail.sent.filter((m) => m.to === rows[0].email && /اجتماع المشرفين/.test(m.subject)).length, 1, JSON.stringify({ diag, ver, delivery: r.data.delivery }));
    assert.ok((await sup.client.get('/announcements')).data.announcements.some((a) => a.id === annId));
    assert.ok(!(await reg.get('/announcements')).data.announcements.some((a) => a.id === annId), 'مشرف التسجيل لا يرى إعلانات المشرفين');
    // تعديل الإعلان لا يعيد الإرسال
    await admin.put(`/announcements/${annId}`, { title: 'اجتماع المشرفين (معدل)', body: 'الخميس 6 مساءً', category: 'meeting', audience: 'supervisors', send_email: true });
    await flushMail();
    const dup = await ctx.pool.query(`select count(*)::int as n from email_outbox where dedupe_key like 'announcement:ann:' || $1 || ':%' and to_email = $2`, [annId, rows[0].email]);
    assert.equal(dup.rows[0].n, 1);
  });

  it('غير المسؤول لا ينشر، والقراءة تُسجَّل', async () => {
    assert.equal((await sup.client.post('/announcements', { title: 'x', body: 'y', category: 'urgent' })).status, 403);
    const before = (await sup.client.get('/notifications/summary')).data.announcements;
    await sup.client.post(`/announcements/${annId}/read`);
    assert.equal((await sup.client.get('/notifications/summary')).data.announcements, before - 1);
    const reg2 = await admin.post('/announcements', { title: 'للتسجيل فقط', body: 'تعليمات القبول', category: 'instructions', audience: 'registrars', send_email: false });
    assert.ok((await reg.get('/announcements')).data.announcements.some((a) => a.id === reg2.data.announcement.id));
    assert.ok(!(await sup.client.get('/announcements')).data.announcements.some((a) => a.id === reg2.data.announcement.id));
    assert.equal((await sup.client.post(`/announcements/${reg2.data.announcement.id}/read`)).status, 404);
  });
});

// =====================================================================
describe('فشل البريد لا يكسر العمليات الإدارية', () => {
  it('فشل دائم ومؤقت وغياب الإعداد', async () => {
    const sup = await makeSupervisor(ctx, admin);
    await verifyEmailOf(sup.username);
    const { EmailSendError } = await import('../src/services/email/errors.js');

    ctx.mail.fail = () => new EmailSendError('domain not verified', { retryable: false, status: 403 });
    const r = await admin.post(`/supervisors/${sup.id}/warnings`, { reason: 'اختبار فشل البريد' });
    assert.equal(r.status, 201, 'العملية الإدارية نجحت رغم فشل البريد');
    await flushMail();
    const failed = await ctx.pool.query(`select status, last_error from email_outbox where template = 'supervisor_warning' and to_user_id = (select user_id from supervisors where id = $1)`, [sup.id]);
    assert.equal(failed.rows[0].status, 'failed');
    assert.match(failed.rows[0].last_error, /domain not verified/);

    ctx.mail.fail = () => new EmailSendError('rate limited', { retryable: true, status: 429, retryAfterMs: 60_000 });
    await admin.post('/announcements', { title: 'تجربة إعادة المحاولة', body: 'نص', category: 'important', audience: 'supervisors' });
    await flushMail();
    const pend = await ctx.pool.query(
      `select count(*) filter (where status = 'pending')::int as pending, count(*)::int as total, max(attempts)::int as max_attempts
       from email_outbox where subject like '%تجربة إعادة المحاولة%'`
    );
    assert.ok(pend.rows[0].total >= 1);
    assert.equal(pend.rows[0].pending, pend.rows[0].total, 'خطأ مؤقت = إعادة محاولة لاحقًا لا فشل نهائي');
    assert.equal(pend.rows[0].max_attempts, 1);
    ctx.mail.fail = null;

    // البريد غير مُعدّ: الرسائل تُسجَّل كـ disabled والإشعار الداخلي يبقى
    ctx.outbox.__setEmailTransport(async (m) => { ctx.mail.sent.push(m); return { id: 'x' }; }, () => ({ operational: false, problems: ['GAS_WEB_APP_URL غير مضبوط'] }));
    const r2 = await admin.post(`/supervisors/${sup.id}/warnings`, { reason: 'بدون إعداد بريد' });
    assert.equal(r2.status, 201);
    const dis = await ctx.pool.query(`select status from email_outbox where template = 'supervisor_warning' order by id desc limit 1`);
    assert.equal(dis.rows[0].status, 'disabled');
    const n = await sup.client.get('/notifications').catch(() => null);
    assert.ok(n);
    ctx.outbox.__setEmailTransport(async (m) => { if (ctx.mail.fail) throw ctx.mail.fail(m); ctx.mail.sent.push(m); return { id: 'y' }; });
  });
});

// =====================================================================
describe('التقويم: جلسات متزامنة لعدة مشرفين', () => {
  let A;
  let B;
  let studsA;
  let studsB;
  let T;
  before(async () => {
    A = await makeSupervisor(ctx, admin, { type: 'kids' });
    B = await makeSupervisor(ctx, admin, { type: 'kids' });
    studsA = [];
    studsB = [];
    for (let i = 0; i < 5; i++) studsA.push(await makeStudent(A));
    for (let i = 0; i < 8; i++) studsB.push(await makeStudent(B));
    T = await localTs(3, '16:00');
  });

  it('المشرف A: 5 طلاب و B: 8 طلاب في نفس الوقت (4 مساءً)', async () => {
    const ra = await A.client.post('/appointments', { student_ids: studsA.map((s) => s.id), kind: 'recitation', start_at: T, duration_min: 60 });
    assert.equal(ra.status, 201, JSON.stringify(ra.data));
    assert.equal(ra.data.created, 5);
    const rb = await B.client.post('/appointments', { student_ids: studsB.map((s) => s.id), kind: 'recitation', start_at: T, duration_min: 45 });
    assert.equal(rb.status, 201, JSON.stringify(rb.data));
    assert.equal(rb.data.created, 8);
    const all = await admin.get(`/appointments?from=${encodeURIComponent(T)}&to=${encodeURIComponent(new Date(Date.parse(T) + 3600e3).toISOString())}`);
    const atT = all.data.appointments.filter((a) => a.start_at && new Date(a.start_at).toISOString() === T);
    assert.equal(atT.length, 13, 'لا يُستبدل أي موعد');
    assert.equal(new Set(atT.filter((a) => a.supervisor_id === A.id).map((a) => a.session_id)).size, 1);
  });

  it('التعارض الحقيقي فقط: نفس الطالب، أو جلسة أخرى لنفس المشرف', async () => {
    const extra = await makeStudent(A);
    const r1 = await A.client.post('/appointments', { student_id: extra.id, kind: 'recitation', start_at: T });
    assert.equal(r1.status, 409, 'جلسة منفصلة لنفس المشرف في نفس الوقت');
    const r2 = await A.client.post('/appointments', { student_id: studsA[0].id, kind: 'recitation', start_at: new Date(Date.parse(T) + 30 * 60e3).toISOString() });
    assert.equal(r2.status, 409, 'نفس الطالب مرتين');
    // الانضمام لجلسة قائمة مسموح
    const { rows } = await ctx.pool.query(`select session_id from appointments where student_id = $1`, [studsA[0].id]);
    const r3 = await A.client.post('/appointments', { student_id: extra.id, kind: 'recitation', start_at: T, join_session_id: rows[0].session_id });
    assert.equal(r3.status, 201, JSON.stringify(r3.data));
  });

  it('قيد قاعدة البيانات يمنع تداخل جلستين مختلفتين لنفس المشرف حتى خارج الـ API', async () => {
    const fresh = await makeStudent(A); // طالب بلا مواعيد: التعارض هنا بسبب المشرف فقط
    await assert.rejects(
      ctx.pool.query(
        `insert into appointments (student_id, supervisor_id, kind, start_at, end_at) values ($1, $2, 'recitation', $3, $3::timestamptz + interval '30 minutes')`,
        [fresh.id, A.id, T]
      ),
      (e) => e.code === '23P01'
    );
  });

  it('الجلسات المتكررة بنفس الساعة المحلية، ونقل/إلغاء الجلسة', async () => {
    const S = await makeStudent(B);
    const start = await localTs(5, '10:00');
    const r = await B.client.post('/appointments', { student_ids: [S.id, studsB[1].id], kind: 'recitation', start_at: start, recurrence: { freq: 'weekly', count: 4 } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.created, 8);
    const { rows } = await ctx.pool.query(
      `select distinct to_char(start_at at time zone 'Asia/Hebron', 'HH24:MI') as hm, series_id from appointments where student_id = $1`,
      [S.id]
    );
    assert.deepEqual(rows.map((x) => x.hm), ['10:00']);
    const sessions = await ctx.pool.query(`select distinct session_id from appointments where series_id = $1`, [rows[0].series_id]);
    assert.equal(sessions.rowCount, 4);
    const sid = (await ctx.pool.query(`select session_id from appointments where student_id = $1 order by start_at limit 1`, [S.id])).rows[0].session_id;
    const moved = await B.client.put(`/appointments/sessions/${sid}`, { start_at: await localTs(5, '11:00') });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    assert.equal(moved.data.moved, 2);
    assert.equal((await A.client.post(`/appointments/sessions/${sid}/cancel`)).status, 404, 'مشرف آخر لا يلغي جلسة غيره');
    assert.equal((await admin.post(`/appointments/sessions/${sid}/cancel`)).data.cancelled, 2, 'المسؤول يلغي الجلسة');
    const c = await B.client.post(`/appointments/series/${rows[0].series_id}/cancel`);
    assert.equal(c.data.cancelled, 6);
  });
});

// =====================================================================
describe('الوظائف القائمة ما زالت تعمل', () => {
  it('لوحة التحكم والتقارير وتسجيل نتيجة موعد', async () => {
    const sup = await makeSupervisor(ctx, admin);
    const st = await makeStudent(sup);
    assert.equal((await admin.get('/dashboard')).status, 200);
    assert.equal((await sup.client.get('/dashboard')).status, 200);
    assert.equal((await admin.get(`/reports/monthly?supervisor_id=${sup.id}`)).status, 200);
    assert.equal((await sup.client.get('/reports/monthly')).status, 200);
    assert.equal((await admin.get('/reports/supervisors')).status, 200);
    const past = new Date(Date.now() - 3600e3).toISOString();
    const rec = await sup.client.post('/appointments', { student_id: st.id, kind: 'recitation', start_at: past, status: 'completed', pages: 2 });
    assert.equal(rec.status, 201, JSON.stringify(rec.data));
    const detail = await sup.client.get(`/students/${st.id}`);
    assert.equal(detail.data.student.pages_new, 2);
    assert.equal((await sup.client.put(`/students/${st.id}`, { full_name: 'اسم معدل', initial_parts: 1 })).status, 200);
    assert.equal((await admin.get('/activity')).status, 200);
    assert.equal((await admin.put('/settings', { exam_pass_grade: 65 })).status, 200);
    assert.equal((await sup.client.put('/settings', { exam_pass_grade: 10 })).status, 403);
  });

  it('المشرف يغيّر بريده فيُعاد طلب التأكيد', async () => {
    const sup = await makeSupervisor(ctx, admin);
    await verifyEmailOf(sup.username);
    const p = await sup.client.get('/profile');
    assert.ok(p.data.profile.email_verified_at);
    const r = await sup.client.put('/profile', { full_name: p.data.profile.full_name, email: `changed-${Date.now()}@example.org` });
    assert.equal(r.data.email_changed, true);
    assert.equal(r.data.profile.email_verified_at, null);
    await verifyEmailOf(sup.username);
    assert.ok((await sup.client.get('/profile')).data.profile.email_verified_at);
  });
});
