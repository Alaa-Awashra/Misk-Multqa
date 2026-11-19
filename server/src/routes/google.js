// ربط حساب Google الخاص بالملتقى (للمسؤول فقط)
import { Router } from 'express';
import { query } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { buildAuthUrl, verifyState, exchangeCode, googleConnection, disconnectGoogle } from '../services/google.js';
import { logActivity } from '../services/activity.js';

const router = Router();
router.use(requireAdmin);

router.get('/status', async (req, res) => res.json(await googleConnection()));

router.get('/oauth/start', (req, res) => {
  res.redirect(buildAuthUrl(req.user.id));
});

router.get('/oauth/callback', async (req, res) => {
  const back = (q) => res.redirect(`/settings?tab=integrations&${new URLSearchParams(q)}`);
  if (req.query.error) return back({ google: 'error', message: String(req.query.error) });
  if (!verifyState(String(req.query.state || ''), req.user.id)) return back({ google: 'error', message: 'state' });
  try {
    const { email } = await exchangeCode(String(req.query.code || ''));
    await logActivity({ query }, req.user, 'google.connected', 'settings', null, 'Google', { account: email });
    back({ google: 'connected' });
  } catch (e) {
    back({ google: 'error', message: e.message });
  }
});

router.post('/disconnect', async (req, res) => {
  await disconnectGoogle();
  await logActivity({ query }, req.user, 'google.disconnected', 'settings', null, 'Google');
  res.json({ ok: true });
});

export default router;
