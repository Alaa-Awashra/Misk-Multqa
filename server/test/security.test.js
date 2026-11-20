// اختبارات أمنية: المصادقة، الصلاحيات، الوصول للسجلات، التلاعب بالحقول، الحقن، CSRF، تحديد المعدل،
// كلمات المرور والجلسات، تسرب الأسرار، OAuth، البريد، المهام المجدولة، ترويسات الأمان.
// تعمل على قاعدة PostgreSQL مؤقتة وحسابات اختبار فقط (لا تلمس الإنتاج).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { setup, client, makeSupervisor, makeStudent, GAS_TEST_SECRET } from './helpers.js';

let ctx;
let admin;
let supA;
let supB;
let stA;
let stB;
let registrar;

const JWT_SECRET = 'test-secret-test-secret-test-secret-0123456789';

/** طلب خام مع ترويسات مخصصة (Origin، XFF، Authorization…) */
async function raw(method, url, { body, headers = {}, cookie } = {}) {
  const res = await fetch(`${ctx.base}/api${url}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* ليس JSON */
  }
  return { status: res.status, data, text, headers: res.headers };
}

/** تسجيل دخول يعيد الكوكي الخام */
async function loginCookie(username, password) {
  const r = await fetch(`${ctx.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(r.status, 200, `login ${username}`);
  return r.headers.get('set-cookie').split(';')[0];
}

before(async () => {
  ctx = await setup();
  admin = client(ctx.base);
  await admin.login('admin', 'admin-pass-123');
  supA = await makeSupervisor(ctx, admin, { name: 'مشرف أ' });
  supB = await makeSupervisor(ctx, admin, { name: 'مشرف ب' });
  stA = await makeStudent(supA, { name: 'طالب أ' });
  stB = await makeStudent(supB, { name: 'طالب ب' });
  const r = await admin.post('/staff', { full_name: 'مشرف تسجيل', email: `reg-${Date.now()}@example.org` });
  assert.equal(r.status, 201);
  registrar = { ...r.data, client: client(ctx.base) };
  await registrar.client.login(r.data.username, r.data.password);
});

after(async () => {
  await ctx?.stop();
});

// =====================================================================
describe('المصادقة والصلاحيات على مستوى الخادم', () => {
  it('كل مسار محمي يرفض الطلب بلا جلسة (401)', async () => {
    const anon = client(ctx.base);
    const paths = [
      ['get', '/auth/me'], ['get', '/students'], ['get', `/students/${stA.id}`], ['get', '/supervisors'], ['get', '/appointments'],
      ['get', '/messages/conversations'], ['get', '/announcements'], ['get', '/notifications'], ['get', '/settings'],
      ['get', '/analytics'], ['get', '/compliance/overview'], ['get', '/admissions/applications'], ['get', '/staff'],
      ['get', '/email/status'], ['get', '/google/status'], ['get', '/activity'], ['get', '/profile'], ['get', '/reports/monthly'],
      ['post', '/email/test'], ['put', '/settings'], ['post', '/supervisors'], ['del', `/students/${stA.id}`],
    ];
    for (const [m, p] of paths) {
      const r = await anon[m](p, m === 'get' ? undefined : {});
      assert.equal(r.status, 401, `${m.toUpperCase()} ${p} → ${r.status}`);
    }
  });

  it('المشرف العادي لا يصل لأي مسار إداري (403)', async () => {
    const paths = [
      ['get', '/supervisors'], ['get', `/supervisors/${supB.id}`], ['post', '/supervisors'], ['get', '/staff'], ['post', '/staff'],
      ['get', '/analytics'], ['get', '/compliance/overview'], ['post', '/compliance/run'], ['get', '/activity'],
      ['get', '/email/status'], ['post', '/email/test'], ['post', '/email/check'], ['get', '/google/status'], ['get', '/google/oauth/start'],
      ['put', '/settings'], ['get', '/admissions/applications'], ['post', `/students/${stA.id}/suspend`], ['del', `/students/${stA.id}`],
      ['post', `/students/${stA.id}/transfer`], ['post', '/announcements'], ['get', '/reports/supervisors'],
    ];
    for (const [m, p] of paths) {
      const r = await supA.client[m](p, m === 'get' ? undefined : {});
      assert.equal(r.status, 403, `${m.toUpperCase()} ${p} → ${r.status}`);
    }
  });

  it('مشرف التسجيل يصل للقبول فقط، لا للطلاب أو التحليلات أو المشرفين', async () => {
    assert.equal((await registrar.client.get('/admissions/applications')).status, 200);
    for (const p of ['/students', `/students/${stA.id}`, '/appointments', '/reports/monthly', '/analytics', '/supervisors', '/staff', '/dashboard', '/compliance/overview', '/activity']) {
      const r = await registrar.client.get(p);
      assert.equal(r.status, 403, `registrar GET ${p} → ${r.status}`);
    }
  });
});

// =====================================================================
describe('الوصول على مستوى السجل (IDOR / BOLA)', () => {
  it('مشرف لا يقرأ ولا يعدّل طالب مشرف آخر', async () => {
    assert.equal((await supA.client.get(`/students/${stB.id}`)).status, 404);
    assert.equal((await supA.client.put(`/students/${stB.id}`, { full_name: 'تلاعب', gender: 'male' })).status, 404);
    assert.equal((await supA.client.post(`/students/${stB.id}/warnings`, { reason: 'x' })).status, 404);
    assert.equal((await supA.client.post(`/students/${stB.id}/requests`, { kind: 'removal', reason: 'x' })).status, 404);
    const list = await supA.client.get('/students');
    assert.ok(!list.data.students.some((s) => s.id === stB.id), 'قائمة طلاب المشرف لا تحتوي طلاب غيره');
    const { rows } = await ctx.pool.query('select full_name from students where id = $1', [stB.id]);
    assert.equal(rows[0].full_name, 'طالب ب');
  });

  it('مشرف لا يحجز موعدًا لطالب غيره ولا يرى مواعيد غيره', async () => {
    const start = new Date(Date.now() + 3 * 86400_000);
    start.setUTCHours(14, 0, 0, 0);
    const r = await supA.client.post('/appointments', { student_id: stB.id, kind: 'recitation', start_at: start.toISOString() });
    assert.equal(r.status, 404);
    const own = await supB.client.post('/appointments', { student_id: stB.id, kind: 'recitation', start_at: start.toISOString() });
    assert.equal(own.status, 201, JSON.stringify(own.data));
    const apptId = own.data.appointments?.[0]?.id || own.data.appointment?.id;
    assert.ok(apptId);
    assert.equal((await supA.client.get(`/appointments/${apptId}`)).status, 404);
    assert.equal((await supA.client.post(`/appointments/${apptId}/cancel`, {})).status, 404);
    assert.equal((await supA.client.del(`/appointments/${apptId}`)).status, 404);
    const all = await supA.client.get(`/appointments?supervisor_id=${supB.id}`);
    assert.ok(!all.data.appointments.some((a) => a.id === apptId), 'تجاهل supervisor_id المرسل من مشرف');
  });

  it('مشرف لا يرى محادثات مشرف آخر ولا يرد عليها', async () => {
    const c = await supB.client.post('/messages/conversations', { subject: 'خاص', category: 'question', body: 'سري' });
    assert.equal(c.status, 201);
    assert.equal((await supA.client.get(`/messages/conversations/${c.data.id}`)).status, 404);
    assert.equal((await supA.client.post(`/messages/conversations/${c.data.id}/messages`, { body: 'x' })).status, 404);
    assert.equal((await supA.client.post(`/messages/conversations/${c.data.id}/status`, { status: 'closed' })).status, 404);
    const list = await supA.client.get('/messages/conversations');
    assert.ok(!list.data.conversations.some((x) => x.id === c.data.id));
  });

  it('معرّفات غير صالحة لا تكشف أخطاء داخلية', async () => {
    for (const p of ['/students/not-a-uuid', "/students/1' or '1'='1", '/messages/conversations/..%2f..%2fetc']) {
      const r = await supA.client.get(p);
      assert.ok([400, 404].includes(r.status), `${p} → ${r.status}`);
      assert.ok(!/postgres|syntax|stack|at \w+ \(/i.test(JSON.stringify(r.data)), 'لا تفاصيل داخلية في الخطأ');
    }
  });
});

// =====================================================================
describe('منع التلاعب بالحقول (Mass assignment)', () => {
  it('لا يمكن رفع الدور أو تغيير الحالة عبر الملف الشخصي', async () => {
    const r = await supA.client.put('/profile', {
      full_name: 'مشرف أ', email: 'a-new@example.org', role: 'admin', is_active: true, session_version: 99,
      supervisor_type: 'female', username: 'admin', password_hash: 'x', email_verified_at: new Date().toISOString(),
    });
    assert.equal(r.status, 200);
    const { rows } = await ctx.pool.query(
      `select u.role, u.username, u.session_version, u.password_hash, u.email_verified_at, sp.supervisor_type
       from users u join supervisors sp on sp.user_id = u.id where u.id = (select user_id from supervisors where id = $1)`,
      [supA.id]
    );
    assert.equal(rows[0].role, 'supervisor');
    assert.equal(rows[0].username, supA.username);
    assert.equal(rows[0].supervisor_type, 'male');
    assert.equal(rows[0].session_version, 0);
    assert.ok(rows[0].password_hash.startsWith('$2'));
    assert.equal(rows[0].email_verified_at, null, 'تغيير البريد يتطلب تأكيدًا جديدًا');
  });

  it('المشرف لا يستطيع إنشاء طالب عند مشرف آخر أو تغيير مشرف الطالب أو حالته', async () => {
    const r = await supA.client.post('/students', { full_name: 'طالب مزروع', gender: 'male', supervisor_id: supB.id, status: 'removed' });
    assert.equal(r.status, 201);
    assert.equal(r.data.student.supervisor_id, supA.id);
    assert.equal(r.data.student.status, 'active');
    const u = await supA.client.put(`/students/${stA.id}`, { full_name: 'طالب أ', gender: 'male', supervisor_id: supB.id, status: 'removed' });
    assert.equal(u.status, 200);
    assert.equal(u.data.student.supervisor_id, supA.id);
    assert.equal(u.data.student.status, 'active');
  });

  it('حقول غير متوقعة في المواعيد تُرفض (strict)', async () => {
    const r = await supA.client.post('/appointments', { student_id: stA.id, kind: 'recitation', start_at: new Date().toISOString(), supervisor_id: supB.id });
    assert.equal(r.status, 400);
  });
});

// =====================================================================
describe('حقن SQL و XSS', () => {
  it('مدخلات خبيثة في الاستعلامات لا تغيّر النتائج ولا تسبب خطأ خادم', async () => {
    const payloads = ["' or 1=1 --", "'; drop table users; --", '1) union select password_hash from users --'];
    for (const p of payloads) {
      const q = encodeURIComponent(p);
      for (const url of [`/students?supervisor_id=${q}`, `/appointments?status=${q}&kind=${q}&from=${q}`, `/messages/conversations?status=${q}`,
        `/admissions/applications?status=${q}&q=${q}`, `/activity?q=${q}&action=${q}`, `/reports/exams?from=${q}&supervisor_id=${q}`]) {
        const who = url.startsWith('/admissions') || url.startsWith('/activity') ? admin : supA.client;
        const r = await who.get(url);
        assert.ok(r.status < 500, `${url} → ${r.status}`);
      }
      const l = await raw('POST', '/auth/login', { body: { username: p, password: p }, headers: { 'X-Forwarded-For': '10.200.0.1' } });
      assert.equal(l.status, 401);
    }
    const { rows } = await ctx.pool.query("select to_regclass('public.users') as t");
    assert.ok(rows[0].t, 'جدول المستخدمين ما زال موجودًا');
    const list = await supA.client.get(`/students?supervisor_id=${encodeURIComponent("' or 1=1 --")}`);
    assert.ok(!list.data.students.some((s) => s.id === stB.id));
  });

  it('النصوص تُخزَّن وتُعاد كنص خام (React يعرضها كنص)، وقوالب البريد تهرّب HTML', async () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const c = await supA.client.post('/messages/conversations', { subject: evil, category: 'question', body: evil });
    assert.equal(c.status, 201);
    const t = await supA.client.get(`/messages/conversations/${c.data.id}`);
    assert.equal(t.data.messages[0].body, evil, 'يُعاد كما هو (بلا تحويل) والعرض في الواجهة نصي');
    assert.match(t.headers.get('content-type'), /application\/json/);
    const { renderEmail } = await import('../src/services/email/templates.js');
    const mail = renderEmail('test', { by: evil });
    assert.ok(!mail.html.includes('<script>') && !mail.html.includes('<img src=x'), 'لا HTML غير مهرّب في البريد');
    assert.ok(mail.html.includes('&lt;script&gt;'));
  });
});

// =====================================================================
describe('CSRF والترويسات و HTTPS', () => {
  let cookie;
  before(async () => {
    cookie = await loginCookie(supA.username, supA.password);
  });

  it('طلب معدِّل من موقع آخر يُرفض حتى مع كوكي صالح', async () => {
    const evil = await raw('POST', '/messages/conversations', { cookie, body: { subject: 's', body: 'b' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.data.code, 'BAD_ORIGIN');
    const nullOrigin = await raw('PUT', '/profile', { cookie, body: { full_name: 'x' }, headers: { Origin: 'null' } });
    assert.equal(nullOrigin.status, 403);
    const fetchSite = await raw('POST', '/notifications/read-all', { cookie, body: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(fetchSite.status, 403);
  });

  it('نفس المصدر مسموح، وطلبات GET لا تتأثر', async () => {
    const host = new URL(ctx.base).host;
    const ok = await raw('POST', '/notifications/read-all', { cookie, body: {}, headers: { Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(ok.status, 200);
    const get = await raw('GET', '/auth/me', { cookie, headers: { Origin: 'https://evil.example' } });
    assert.equal(get.status, 200);
  });

  it('كوكي الجلسة HttpOnly و SameSite=Lax', async () => {
    const r = await fetch(`${ctx.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.201.0.1' },
      body: JSON.stringify({ username: supA.username, password: supA.password }),
    });
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Lax/i);
    assert.doesNotMatch(await r.text(), /eyJ[A-Za-z0-9_-]+\./, 'الرمز لا يظهر في جسم الاستجابة');
  });

  it('ترويسات الأمان موجودة، واستجابات الـ API لا تُخزَّن مؤقتًا', async () => {
    const r = await raw('GET', '/health');
    const h = r.headers;
    assert.match(h.get('content-security-policy') || '', /default-src 'self'/);
    assert.match(h.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.ok(h.get('strict-transport-security'));
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.ok(h.get('referrer-policy'));
    assert.match(h.get('permissions-policy') || '', /camera=\(\)/);
    assert.equal(h.get('cache-control'), 'no-store');
    assert.equal(h.get('x-powered-by'), null);
  });

  it('الجسم الكبير جدًا يُرفض', async () => {
    const r = await raw('POST', '/auth/login', { body: { username: 'x', password: 'y'.repeat(200_000) }, headers: { 'X-Forwarded-For': '10.202.0.1' } });
    assert.equal(r.status, 413);
  });
});

// =====================================================================
describe('تحديد معدل محاولات الدخول', () => {
  it('حد لكل حساب: 10 محاولات فاشلة ثم 429 حتى من عناوين IP مختلفة', async () => {
    const target = supB.username;
    let last;
    for (let i = 0; i < 11; i++) {
      last = await raw('POST', '/auth/login', { body: { username: target, password: 'wrong-password' }, headers: { 'X-Forwarded-For': `10.50.${i}.7` } });
    }
    assert.equal(last.status, 429);
    assert.equal(last.data.code, 'RATE_LIMIT');
    // حساب آخر من نفس العنوان لا يتأثر
    const other = await raw('POST', '/auth/login', { body: { username: supA.username, password: supA.password }, headers: { 'X-Forwarded-For': '10.50.10.7' } });
    assert.equal(other.status, 200);
  });

  it('حد لكل عنوان IP: 20 محاولة فاشلة ثم 429', async () => {
    let last;
    for (let i = 0; i < 21; i++) {
      last = await raw('POST', '/auth/login', { body: { username: `nouser${i}`, password: 'x' }, headers: { 'X-Forwarded-For': '10.60.0.1' } });
    }
    assert.equal(last.status, 429);
  });
});

// =====================================================================
describe('كلمات المرور والجلسات', () => {
  it('كلمات المرور bcrypt فقط، ولا تُخزَّن بشكل قابل للاسترجاع ولا تُعاد في القراءة', async () => {
    const s = await makeSupervisor(ctx, admin, { name: 'مشرف كلمات المرور' });
    const { rows } = await ctx.pool.query('select password_hash, password_enc from users where username = $1', [s.username]);
    assert.ok(await bcrypt.compare(s.password, rows[0].password_hash));
    assert.match(rows[0].password_hash, /^\$2[aby]\$10\$/);
    assert.equal(rows[0].password_enc, null, 'لا نسخة مشفرة قابلة للفك');
    const d = await admin.get(`/supervisors/${s.id}`);
    assert.equal(d.data.credentials.password, null);
    assert.equal(d.data.credentials.password_known, false);
    const staff = await admin.get('/staff');
    assert.ok(staff.data.staff.every((x) => x.password === null));
  });

  it('إعادة تعيين المسؤول لكلمة المرور تُبطل جلسات المشرف وتعيد كلمة جديدة مرة واحدة', async () => {
    const s = await makeSupervisor(ctx, admin, { name: 'مشرف إعادة التعيين' });
    assert.equal((await s.client.get('/auth/me')).status, 200);
    const r = await admin.post(`/supervisors/${s.id}/reset-password`);
    assert.equal(r.status, 200);
    assert.ok(r.data.password && r.data.password !== s.password);
    assert.equal((await s.client.get('/auth/me')).status, 401, 'الجلسة القديمة باطلة');
    const { rows } = await ctx.pool.query('select password_enc from users where username = $1', [s.username]);
    assert.equal(rows[0].password_enc, null);
    const fresh = client(ctx.base);
    await fresh.login(s.username, r.data.password);
    assert.equal((await fresh.get('/auth/me')).status, 200);
  });

  it('تغيير كلمة المرور يُبطل الجلسات الأخرى ويُبقي الجلسة الحالية', async () => {
    const s = await makeSupervisor(ctx, admin, { name: 'مشرف تغيير كلمة المرور' });
    const other = client(ctx.base);
    await other.login(s.username, s.password);
    const wrong = await s.client.put('/profile/password', { current_password: 'wrong', new_password: 'NewPassw0rd!' });
    assert.equal(wrong.status, 400);
    const ok = await s.client.put('/profile/password', { current_password: s.password, new_password: 'NewPassw0rd!' });
    assert.equal(ok.status, 200);
    assert.equal((await s.client.get('/auth/me')).status, 200, 'الجهاز الحالي يبقى مسجلًا');
    assert.equal((await other.get('/auth/me')).status, 401, 'الأجهزة الأخرى تُسجَّل خارجًا');
  });

  it('رموز JWT المزوّرة أو المنتهية أو بخوارزمية none أو رمز OAuth state تُرفض', async () => {
    const { rows } = await ctx.pool.query('select user_id from supervisors where id = $1', [supA.id]);
    const uid = rows[0].user_id;
    const bearer = (t) => raw('GET', '/auth/me', { headers: { Authorization: `Bearer ${t}` } });
    assert.equal((await bearer(jwt.sign({ sub: uid, typ: 'session', sv: 0 }, JWT_SECRET, { expiresIn: '1h' }))).status, 200, 'رمز صالح للمقارنة');
    assert.equal((await bearer(jwt.sign({ sub: uid }, JWT_SECRET, { expiresIn: '1h' }))).status, 200, 'الجلسات القديمة (بلا typ) تبقى صالحة');
    assert.equal((await bearer(jwt.sign({ sub: uid, typ: 'session', sv: 0 }, 'wrong-secret-wrong-secret-wrong-secret', { expiresIn: '1h' }))).status, 401);
    assert.equal((await bearer(jwt.sign({ sub: uid, typ: 'session', sv: 0, exp: Math.floor(Date.now() / 1000) - 10 }, JWT_SECRET))).status, 401);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: uid })).toString('base64url')}.`;
    assert.equal((await bearer(none)).status, 401);
    assert.equal((await bearer(jwt.sign({ sub: uid, p: 'google' }, JWT_SECRET, { expiresIn: '1h' }))).status, 401, 'رمز لغرض آخر');
    assert.equal((await bearer(jwt.sign({ sub: uid, typ: 'email' }, JWT_SECRET, { expiresIn: '1h' }))).status, 401);
    // رمز state الحقيقي من بدء OAuth لا يصلح كجلسة
    const start = await admin.get('/google/oauth/start');
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    assert.equal((await bearer(state)).status, 401);
  });

  it('تسجيل الخروج يمسح الكوكي', async () => {
    const r = await raw('POST', '/auth/logout', { body: {} });
    assert.match(r.headers.get('set-cookie') || '', /mq_token=;/);
  });
});

// =====================================================================
describe('تسرب الأسرار في الاستجابات', () => {
  it('لا هاش كلمات مرور ولا أسرار في أي استجابة شائعة', async () => {
    const responses = [
      await admin.get('/auth/me'), await admin.get('/profile'), await admin.get(`/supervisors/${supA.id}`), await admin.get('/supervisors'),
      await admin.get('/staff'), await admin.get('/settings'), await admin.get('/email/status'), await admin.get('/google/status'),
      await admin.get('/activity'), await supA.client.get('/auth/me'), await supA.client.get('/profile'), await supA.client.get('/students'),
      await registrar.client.get('/admissions/applications'),
    ];
    const secrets = [JWT_SECRET, GAS_TEST_SECRET, 'test-credentials-key', 'test-secret', 'cron-secret-for-tests'];
    for (const r of responses) {
      const s = JSON.stringify(r.data);
      assert.doesNotMatch(s, /\$2[aby]\$\d\d\$/, 'bcrypt hash');
      assert.doesNotMatch(s, /password_hash|password_enc|value_enc|refresh_token|session_version/);
      for (const sec of secrets) assert.ok(!s.includes(sec), 'secret leaked');
    }
  });
});

// =====================================================================
describe('OAuth والبريد والمهام المجدولة', () => {
  it('OAuth callback يرفض state غير صالح أو لمستخدم آخر، ولا يصل إليه غير المسؤول', async () => {
    const bad = await admin.get('/google/oauth/callback?code=x&state=forged');
    assert.equal(bad.status, 302);
    assert.match(bad.headers.get('location'), /google=error&message=state/);
    const forgedForOther = jwt.sign({ sub: '00000000-0000-0000-0000-000000000000', p: 'google' }, JWT_SECRET, { expiresIn: '5m' });
    const r2 = await admin.get(`/google/oauth/callback?code=x&state=${forgedForOther}`);
    assert.match(r2.headers.get('location'), /message=state/);
    assert.equal((await supA.client.get('/google/oauth/callback?code=x&state=y')).status, 403);
  });

  it('لا يمكن إرسال بريد تجريبي لعنوان عشوائي، ولا لغير المسؤول', async () => {
    const r = await admin.post('/email/test', { to: 'random-victim@example.com' });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'EMAIL_TEST_RECIPIENT');
    assert.equal((await supA.client.post('/email/test', { to: 'misk.quran26@gmail.com' })).status, 403);
  });

  it('Apps Script يرفض الطلبات غير الموقّعة أو بتوقيع خاطئ', async () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, action: 'send', ts: Math.floor(Date.now() / 1000), nonce: 'n'.repeat(20), id: 'x', to: 'a@b.co', subject: 's', text: 't' })).toString('base64');
    const post = (body) => fetch(ctx.gas.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).then((r) => r.json());
    assert.equal((await post({ payload })).code, 'INVALID');
    assert.equal((await post({ payload, sig: 'a'.repeat(64) })).code, 'AUTH');
  });

  it('نقطة المهام المجدولة لا تعمل بلا السر الصحيح', async () => {
    assert.equal((await raw('POST', '/cron/tick', { body: {} })).status, 401);
    assert.equal((await raw('POST', '/cron/tick', { body: {}, headers: { 'x-cron-secret': 'wrong' } })).status, 401);
  });

  it('الإجراءات الإدارية المكررة تُرفض (فصل مشرف مفصول، تكرار طلب حذف)', async () => {
    const s = await makeSupervisor(ctx, admin, { name: 'مشرف للفصل' });
    assert.equal((await admin.post(`/supervisors/${s.id}/suspend`, { reason: 'اختبار' })).status, 200);
    assert.equal((await admin.post(`/supervisors/${s.id}/suspend`, { reason: 'اختبار' })).status, 409);
    const st = await makeStudent(supA, { name: 'طالب للطلب' });
    assert.equal((await supA.client.post(`/students/${st.id}/requests`, { kind: 'removal', reason: 'سبب' })).status, 201);
    assert.equal((await supA.client.post(`/students/${st.id}/requests`, { kind: 'removal', reason: 'سبب' })).status, 409);
  });
});
