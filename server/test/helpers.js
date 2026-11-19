// بيئة اختبار معزولة: PostgreSQL مؤقت (embedded-postgres) أو TEST_DATABASE_URL
// لا يلمس أبدًا قاعدة بيانات الإنتاج: يتجاهل DATABASE_URL الموجود في .env
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

let ctx = null;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

export async function setup() {
  if (ctx) return ctx;
  let pg = null;
  let dir = null;
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-test-pg-'));
    const port = await freePort();
    pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'test', port, persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    url = `postgresql://postgres:test@localhost:${port}/postgres`;
  }

  // يجب ضبط البيئة قبل تحميل أي وحدة من الخادم (config.js يقرأها عند التحميل)
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: url,
    DATABASE_SSL: 'false',
    JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    CREDENTIALS_KEY: 'test-credentials-key',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin-pass-123',
    APP_TIMEZONE: 'Asia/Hebron',
    CRON_SECRET: 'cron-secret-for-tests-0123456789',
    IN_PROCESS_SCHEDULER: 'false',
    EMAIL_NOTIFICATIONS_ENABLED: 'true',
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'noreply@example-forum.org',
    EMAIL_REPLY_TO: 'misk.quran26@gmail.com',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    APP_URL: 'http://localhost:4000',
  });

  const { pool } = await import('../src/db.js');
  const { runMigrations } = await import('../src/migrations.js');
  try {
    await runMigrations(pool, () => {});
  } catch (err) {
    // لا نترك PostgreSQL المؤقت يعمل إن فشل الإعداد
    await pool.end().catch(() => {});
    if (pg) await pg.stop().catch(() => {});
    throw err;
  }
  const { seedAdmin } = await import('../src/services/seed.js');
  await seedAdmin();

  // بريد وهمي: يسجّل الرسائل بدل إرسالها، ويمكن جعله يفشل
  const outbox = await import('../src/services/email/outbox.js');
  const mail = { sent: [], fail: null };
  outbox.__setEmailTransport(async (m) => {
    if (mail.fail) throw mail.fail(m);
    mail.sent.push(m);
    return { id: `fake-${mail.sent.length}` };
  });

  const { app } = await import('../src/app.js');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  ctx = {
    base,
    pool,
    mail,
    outbox,
    async stop() {
      await outbox.outboxIdle();
      await new Promise((r) => server.close(r));
      await pool.end();
      if (pg) await pg.stop().catch(() => {});
      // على Windows قد تبقى ملفات مقفلة لحظيًا بعد إيقاف PostgreSQL — التنظيف أفضل جهد
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* ignore */ } }
    },
  };
  return ctx;
}

/** عميل HTTP يحتفظ بكوكي الجلسة */
export function client(base) {
  let cookie = '';
  const req = async (method, url, body) => {
    const res = await fetch(`${base}/api${url}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (u) => req('GET', u),
    post: (u, b = {}) => req('POST', u, b),
    put: (u, b = {}) => req('PUT', u, b),
    del: (u, b = {}) => req('DELETE', u, b),
    async login(username, password) {
      const r = await req('POST', '/auth/login', { username, password });
      if (r.status !== 200) throw new Error(`login failed ${r.status}: ${JSON.stringify(r.data)}`);
      return r.data.user;
    },
  };
}

let counter = 0;
/** ينشئ مشرفًا عبر الـ API ويعيد { id, username, password, client } */
export async function makeSupervisor(ctx, admin, { type = 'male', joinDate = '2026-01-01', name } = {}) {
  counter++;
  const r = await admin.post('/supervisors', {
    full_name: name || `مشرف اختبار ${counter}`,
    supervisor_type: type,
    email: `sup${counter}-${Date.now()}@example.org`,
    join_date: joinDate,
  });
  if (r.status !== 201) throw new Error(`create supervisor: ${JSON.stringify(r.data)}`);
  const c = client(ctx.base);
  await c.login(r.data.username, r.data.password);
  return { ...r.data, client: c };
}

export async function makeStudent(sup, { name, gender = 'male', joinDate = '2026-01-01' } = {}) {
  counter++;
  const r = await sup.client.post('/students', { full_name: name || `طالب ${counter}`, gender, join_date: joinDate });
  if (r.status !== 201) throw new Error(`create student: ${JSON.stringify(r.data)}`);
  return r.data.student;
}

/** موعد مباشر في قاعدة البيانات (لإعداد بيانات تاريخية للاختبار) */
export async function insertAppointment(pool, { studentId, supervisorId, start, minutes = 30, status = 'completed', pages = null, type = 'new', kind = 'recitation' }) {
  const s = new Date(start);
  const e = new Date(s.getTime() + minutes * 60_000);
  const { rows } = await pool.query(
    `insert into appointments (student_id, supervisor_id, kind, recitation_type, start_at, end_at, status, pages, completed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, case when $7 = 'completed' then now() end) returning id`,
    [studentId, supervisorId, kind, kind === 'recitation' ? type : null, s.toISOString(), e.toISOString(), status, pages]
  );
  return rows[0].id;
}
