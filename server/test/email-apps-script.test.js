// اختبارات البريد عبر Google Apps Script: الخادم الحقيقي ↔ Code.gs الحقيقي (داخل vm)
// تغطي: الإرسال الكامل، التوقيع، انتهاء الصلاحية، إعادة الإرسال، منع التكرار، الحصة، الحد اليومي، صلاحيات المسؤول
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, client, makeSupervisor, GAS_TEST_SECRET } from './helpers.js';

let ctx;
let admin;
let gas;
let appsScript;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function flushMail() {
  for (let i = 0; i < 20; i++) {
    await wait(200);
    await ctx.outbox.outboxIdle();
    await ctx.outbox.processOutbox();
    const { rows } = await ctx.pool.query(
      `select count(*)::int as n from email_outbox where status in ('pending', 'sending') and next_attempt_at <= now()`
    );
    if (!rows[0].n) return;
  }
}

/** مشرف ببريد مؤكد (التأكيد مباشرة في قاعدة البيانات لعزل هذا الاختبار عن رسالة التأكيد) */
async function verifiedSupervisor() {
  const sup = await makeSupervisor(ctx, admin);
  await ctx.pool.query(`update users set email_verified_at = now() where username = $1`, [sup.username]);
  const { rows } = await ctx.pool.query('select email from users where username = $1', [sup.username]);
  return { ...sup, email: rows[0].email };
}

before(async () => {
  ctx = await setup();
  gas = ctx.gas;
  admin = client(ctx.base);
  await admin.login('admin', 'admin-pass-123');
  await flushMail(); // رسائل التهيئة (إن وُجدت) عبر الناقل الوهمي
  appsScript = await import('../src/services/email/appsScript.js');
  // من هنا: الناقل الحقيقي (HTTP موقّع → Code.gs)
  ctx.outbox.__setEmailTransport(null);
});

after(async () => {
  await ctx?.stop();
});

describe('البريد عبر Google Apps Script (MailApp)', () => {
  it('حالة الإعداد تعرض المزوّد الجديد والحساب الرسمي', async () => {
    const r = await admin.get('/email/status');
    assert.equal(r.status, 200);
    assert.equal(r.data.config.provider, 'google_apps_script');
    assert.equal(r.data.config.operational, true, JSON.stringify(r.data.config.problems));
    assert.equal(r.data.config.sender, 'misk.quran26@gmail.com');
    assert.equal(r.data.usage.limit, 100);
  });

  it('تحذير المشرف يُرسل فعليًا عبر Apps Script من حساب الملتقى وبقالب عربي', async () => {
    const sup = await verifiedSupervisor();
    const before = gas.state.sent.length;
    const r = await admin.post(`/supervisors/${sup.id}/warnings`, { reason: 'عدم إدخال البيانات' });
    assert.equal(r.status, 201);
    await flushMail();
    const mine = gas.state.sent.slice(before).filter((m) => m.to === sup.email && /تحذير/.test(m.subject));
    assert.equal(mine.length, 1);
    assert.match(mine[0].subject, /تحذير إداري رسمي/);
    assert.equal(mine[0].name, 'إدارة ملتقى المسك القرآني');
    assert.equal(mine[0].replyTo, 'misk.quran26@gmail.com');
    assert.match(mine[0].htmlBody, /dir="rtl"/);
    assert.ok(mine[0].body.length > 10, 'نسخة نصية موجودة');
    const row = (await ctx.pool.query(`select status, provider_message_id from email_outbox where to_email = $1 and template = 'supervisor_warning'`, [sup.email])).rows[0];
    assert.equal(row.status, 'sent');
    assert.match(row.provider_message_id, /^gas-/);
  });

  it('منع التكرار: نفس المعرّف لا يُرسل مرتين حتى عند إعادة المحاولة', async () => {
    const before = gas.state.sent.length;
    const msg = { to: 'misk.quran26@gmail.com', subject: 'اختبار', html: '<p>س</p>', text: 'س', idempotencyKey: 'mq-dup-1' };
    const a = await appsScript.sendViaAppsScript(msg);
    const b = await appsScript.sendViaAppsScript(msg);
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(b.id, a.id);
    assert.equal(gas.state.sent.length, before + 1);
  });

  it('يرفض التوقيع الخاطئ والمحتوى المعدّل والطلبات المنتهية والمعادة', async () => {
    const fields = { action: 'status' };
    // سر خاطئ
    const wrong = appsScript.signRequest(fields, 'x'.repeat(40));
    assert.equal((await gas.raw(wrong)).code, 'AUTH');
    // محتوى معدّل بعد التوقيع
    const good = appsScript.signRequest(fields, GAS_TEST_SECRET);
    const tampered = { ...good, payload: Buffer.from(JSON.stringify({ v: 1, ts: Math.floor(Date.now() / 1000), nonce: 'n'.repeat(20), action: 'status' })).toString('base64') };
    assert.equal((await gas.raw(tampered)).code, 'AUTH');
    // بدون توقيع / جسم غير صالح
    assert.equal((await gas.raw({ payload: good.payload })).code, 'INVALID');
    assert.equal((await gas.raw('not json')).code, 'INVALID');
    // طلب قديم (10 دقائق)
    const old = appsScript.signRequest(fields, GAS_TEST_SECRET, Date.now() - 10 * 60_000);
    assert.equal((await gas.raw(old)).code, 'EXPIRED');
    // إعادة نفس الطلب الصالح
    assert.equal((await gas.raw(good)).ok, true);
    assert.equal((await gas.raw(good)).code, 'REPLAY');
    // لم تُرسل أي رسالة من هذه الطلبات
  });

  it('سر غير مطابق على Render = فشل نهائي واضح بلا إعادة محاولة لا نهائية', async () => {
    const sup = await verifiedSupervisor();
    gas.state.secret = 'another-secret-another-secret-123456';
    try {
      await admin.post(`/supervisors/${sup.id}/warnings`, { reason: 'اختبار السر' });
      await flushMail();
      const row = (await ctx.pool.query(`select status, last_error from email_outbox where to_email = $1 order by id desc limit 1`, [sup.email])).rows[0];
      assert.equal(row.status, 'failed');
      assert.match(row.last_error, /GAS_SHARED_SECRET/);
    } finally {
      gas.state.secret = GAS_TEST_SECRET;
    }
  });

  it('نفاد حصة MailApp: تبقى الرسالة في الانتظار ثم تُرسل عند تجدد الحصة', async () => {
    const sup = await verifiedSupervisor();
    const saved = gas.state.quota;
    gas.state.quota = 0;
    await admin.post(`/supervisors/${sup.id}/warnings`, { reason: 'اختبار الحصة' });
    await flushMail();
    let row = (await ctx.pool.query(`select id, status, last_error, next_attempt_at from email_outbox where to_email = $1 order by id desc limit 1`, [sup.email])).rows[0];
    assert.equal(row.status, 'pending');
    assert.match(row.last_error, /حصة/);
    assert.ok(new Date(row.next_attempt_at) > new Date(Date.now() + 30 * 60_000), 'مؤجلة لساعة تقريبًا');

    gas.state.quota = saved;
    await ctx.pool.query(`update email_outbox set next_attempt_at = now() where id = $1`, [row.id]);
    await flushMail();
    row = (await ctx.pool.query(`select status from email_outbox where id = $1`, [row.id])).rows[0];
    assert.equal(row.status, 'sent');
  });

  it('الحد اليومي في الخادم: لا يتجاوز EMAIL_DAILY_LIMIT خلال 24 ساعة ويؤجل الباقي', async () => {
    const sup = await verifiedSupervisor();
    const { rows: [u] } = await ctx.pool.query(`select count(*)::int as n from email_outbox where status = 'sent' and sent_at > now() - interval '24 hours'`);
    const fill = 100 - u.n;
    await ctx.pool.query(
      `insert into email_outbox (dedupe_key, to_email, template, subject, status, sent_at)
       select 'fill:' || g, 'x@example.org', 'test', 'ملء', 'sent', now() from generate_series(1, $1) g`,
      [fill]
    );
    try {
      const before = gas.state.sent.length;
      await admin.post(`/supervisors/${sup.id}/warnings`, { reason: 'اختبار الحد اليومي' });
      await flushMail();
      assert.equal(gas.state.sent.length, before, 'لم يُرسل شيء بعد بلوغ الحد');
      const row = (await ctx.pool.query(`select status, next_attempt_at from email_outbox where to_email = $1 order by id desc limit 1`, [sup.email])).rows[0];
      assert.equal(row.status, 'pending');
      assert.ok(new Date(row.next_attempt_at) > new Date(Date.now() + 3600_000));
      const st = await admin.get('/email/status');
      assert.equal(st.data.usage.sent_24h, 100);
    } finally {
      await ctx.pool.query(`delete from email_outbox where dedupe_key like 'fill:%'`);
      await ctx.pool.query(`update email_outbox set next_attempt_at = now() where status = 'pending'`);
      await flushMail();
    }
  });

  it('الرسالة التجريبية: للمسؤول فقط، ولحساب الملتقى أو بريد مؤكد فقط', async () => {
    const sup = await verifiedSupervisor();
    assert.equal((await sup.client.post('/email/test', { to: 'misk.quran26@gmail.com' })).status, 403);
    const bad = await admin.post('/email/test', { to: 'random-person@example.org' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.code, 'EMAIL_TEST_RECIPIENT');
    const before = gas.state.sent.length;
    const ok = await admin.post('/email/test', { to: 'misk.quran26@gmail.com' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    await flushMail();
    assert.ok(gas.state.sent.slice(before).some((m) => m.to === 'misk.quran26@gmail.com'));
    const ok2 = await admin.post('/email/test', { to: sup.email });
    assert.equal(ok2.status, 200);
  });

  it('فحص الاتصال يعيد الحساب المُرسِل والحصة دون إرسال رسالة', async () => {
    const before = gas.state.sent.length;
    const r = await admin.post('/email/check');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true, JSON.stringify(r.data));
    assert.equal(r.data.account, 'misk.quran26@gmail.com');
    assert.equal(r.data.sender_matches, true);
    assert.equal(typeof r.data.remaining, 'number');
    assert.equal(gas.state.sent.length, before);
    assert.equal((await (await verifiedSupervisor()).client.post('/email/check')).status, 403);
  });

  it('خطأ مؤقت في MailApp: إعادة محاولة لاحقة لا فشل نهائي', async () => {
    const sup = await verifiedSupervisor();
    gas.state.mailError = 'Service invoked too many times';
    try {
      await admin.post(`/supervisors/${sup.id}/warnings`, { reason: 'اختبار خطأ مؤقت' });
      await flushMail();
      const row = (await ctx.pool.query(`select status, attempts from email_outbox where to_email = $1 order by id desc limit 1`, [sup.email])).rows[0];
      assert.equal(row.status, 'pending');
      assert.equal(row.attempts, 1);
    } finally {
      gas.state.mailError = null;
    }
  });
});
