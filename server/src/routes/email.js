// حالة البريد وسجل التسليم (للمسؤول فقط)
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query, tx } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { badRequest, notFound } from '../utils/errors.js';
import { parse, z } from '../utils/validate.js';
import { config } from '../config.js';
import { checkAppsScript, emailConfigStatus } from '../services/email/appsScript.js';
import { dailyUsage, enqueueEmail, processOutbox } from '../services/email/outbox.js';
import { logActivity } from '../services/activity.js';

const router = Router();
router.use(requireAdmin);

router.get('/status', async (req, res) => {
  const { rows: stats } = await query(`select status, count(*)::int as n from email_outbox group by status`);
  const params = [];
  let where = '';
  if (['pending', 'sending', 'sent', 'failed', 'disabled'].includes(req.query.status)) {
    params.push(req.query.status);
    where = 'where e.status = $1';
  }
  const { rows } = await query(
    `select e.id, e.to_email, e.template, e.subject, e.status, e.attempts, e.last_error, e.created_at, e.sent_at,
            e.next_attempt_at, u.full_name
     from email_outbox e left join users u on u.id = e.to_user_id ${where} order by e.id desc limit 200`,
    params
  );
  const usage = await dailyUsage();
  res.json({ config: emailConfigStatus(), usage: { sent_24h: usage.sent, limit: usage.limit }, stats: Object.fromEntries(stats.map((s) => [s.status, s.n])), emails: rows });
});

const testLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });

/** فحص الاتصال بـ Apps Script دون إرسال رسالة: الحساب المُرسِل والحصة المتبقية */
router.post('/check', testLimiter, async (req, res) => {
  const st = emailConfigStatus();
  if (!st.operational) throw badRequest(`البريد غير مُعدّ: ${st.problems.join(' • ')}`, 'EMAIL_NOT_CONFIGURED');
  try {
    const r = await checkAppsScript();
    const matches = !r.account || r.account.toLowerCase() === config.email.senderAddress;
    res.json({ ok: true, ...r, expected_sender: config.email.senderAddress, sender_matches: matches });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code || null });
  }
});

router.post('/test', testLimiter, async (req, res) => {
  const { to: raw } = parse(z.object({ to: z.string().trim().email('البريد غير صالح') }), req.body);
  const to = raw.toLowerCase();
  const st = emailConfigStatus();
  if (!st.operational) throw badRequest(`البريد غير مُعدّ: ${st.problems.join(' • ')}`, 'EMAIL_NOT_CONFIGURED');
  // المستلم: حساب الملتقى الرسمي أو بريد مؤكد لمستخدم في المنصة فقط (لا عناوين عشوائية)
  if (to !== config.email.senderAddress) {
    const { rowCount } = await query('select 1 from users where lower(email) = $1 and email_verified_at is not null', [to]);
    if (!rowCount) throw badRequest('الرسالة التجريبية تُرسل فقط لحساب الملتقى الرسمي أو لبريد مؤكد لمستخدم في المنصة', 'EMAIL_TEST_RECIPIENT');
  }
  await tx(async (c) => {
    await enqueueEmail(c, { to, template: 'test', data: { by: req.user.full_name }, dedupeKey: `test:${Date.now()}` });
    await logActivity(c, req.user, 'email.test', 'settings', null, 'البريد', { to });
  });
  const r = await processOutbox({ limit: 5 });
  res.json(r);
});

router.post('/:id/retry', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw notFound();
  const st = emailConfigStatus();
  if (!st.operational) throw badRequest('البريد غير مُعدّ بعد');
  const r = await query(
    `update email_outbox set status = 'pending', next_attempt_at = now(), last_error = null, attempts = 0, updated_at = now()
     where id = $1 and status in ('failed', 'disabled') returning id`,
    [req.params.id]
  );
  if (!r.rowCount) throw notFound('الرسالة غير موجودة أو ليست فاشلة');
  processOutbox().catch(() => {});
  res.json({ ok: true });
});

export default router;
