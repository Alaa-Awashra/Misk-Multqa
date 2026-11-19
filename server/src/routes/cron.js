// نقطة استدعاء المهام المجدولة من Supabase Cron — محمية بسر مشترك (CRON_SECRET)
import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../utils/errors.js';
import { runJobs } from '../services/jobs.js';

const router = Router();

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

router.post('/tick', async (req, res) => {
  if (!config.cronSecret || config.cronSecret.length < 24) {
    throw new HttpError(503, 'CRON_SECRET غير مضبوط على الخادم (24 حرفًا على الأقل)', 'CRON_DISABLED');
  }
  const provided = req.get('x-cron-secret') || '';
  if (!safeEqual(provided, config.cronSecret)) throw new HttpError(401, 'غير مصرح', 'UNAUTHORIZED');
  const r = await runJobs({ trigger: 'supabase-cron' });
  res.status(r.busy ? 202 : 200).json(r);
});

export default router;
