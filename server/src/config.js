import dotenv from 'dotenv';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// الأولوية: server/.env ثم .env في جذر المشروع (dotenv لا يكتب فوق المتغيرات الموجودة)
dotenv.config({ path: path.resolve(here, '../.env') });
dotenv.config({ path: path.resolve(here, '../../.env') });

const env = process.env;
const isProd = env.NODE_ENV === 'production';

let jwtSecret = env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  if (isProd) throw new Error('JWT_SECRET مطلوب (32 حرفًا على الأقل) في بيئة الإنتاج');
  jwtSecret = 'dev-only-secret-please-change-this-before-production';
  console.warn('⚠️  JWT_SECRET غير مضبوط — يتم استخدام مفتاح تطوير فقط.');
}

let credSecret = env.CREDENTIALS_KEY;
if (!credSecret) {
  if (isProd) throw new Error('CREDENTIALS_KEY مطلوب في بيئة الإنتاج');
  credSecret = jwtSecret;
}

const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL غير مضبوط. انسخ .env.example إلى .env وضع رابط Supabase.');
}

let ssl = false;
if (env.DATABASE_SSL === 'false') ssl = false;
else if (isProd || /supabase|pooler/i.test(databaseUrl)) ssl = { rejectUnauthorized: false };

const bool = (v, def) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(String(v).trim()));
const appUrl = (env.APP_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${Number(env.PORT) || 4000}`).replace(/\/+$/, '');

export const config = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  appUrl,
  // سر استدعاء المهام المجدولة (Supabase Cron). بدونه يُرفض أي استدعاء خارجي.
  cronSecret: env.CRON_SECRET || '',
  // تشغيل المهام داخل الخادم أيضًا أثناء نشاطه (مساعد فقط — المصدر الموثوق هو Supabase Cron)
  inProcessScheduler: bool(env.IN_PROCESS_SCHEDULER, env.NODE_ENV !== 'test'),
  // البريد: Google Apps Script Web App (MailApp) من حساب الملتقى الرسمي
  email: {
    enabled: bool(env.EMAIL_NOTIFICATIONS_ENABLED, false),
    provider: (env.EMAIL_PROVIDER || 'google_apps_script').trim(),
    gasUrl: (env.GAS_WEB_APP_URL || '').trim(),
    gasSecret: (env.GAS_SHARED_SECRET || '').trim(),
    // الحساب الذي يُنشر منه Apps Script (للعرض والتحقق فقط — الإرسال يتم من حساب النشر نفسه)
    senderAddress: (env.EMAIL_SENDER_ADDRESS || 'misk.quran26@gmail.com').trim().toLowerCase(),
    replyTo: env.EMAIL_REPLY_TO || 'misk.quran26@gmail.com',
    fromName: 'إدارة ملتقى المسك القرآني',
    // حساب Gmail الشخصي: 100 مستلم يوميًا عبر MailApp — نترك هامشًا للرسائل التجريبية
    dailyLimit: Math.max(1, Math.min(100, Number(env.EMAIL_DAILY_LIMIT) || 90)),
    // مهلة بين رسالة وأخرى لتجنب نمط الإرسال الجماعي
    sendIntervalMs: /^\d+$/.test(String(env.EMAIL_SEND_INTERVAL_MS ?? '').trim()) ? Number(env.EMAIL_SEND_INTERVAL_MS) : 3000,
  },
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: env.GOOGLE_REDIRECT_URI || `${appUrl}/api/google/oauth/callback`,
  },
  port: Number(env.PORT) || 4000,
  databaseUrl,
  ssl,
  jwtSecret,
  credentialsKey: crypto.createHash('sha256').update(credSecret).digest(),
  timezone: env.APP_TIMEZONE || 'Asia/Hebron',
  clientOrigin: env.CLIENT_ORIGIN || '',
  admin: {
    username: env.ADMIN_USERNAME || 'admin',
    password: env.ADMIN_PASSWORD || '',
    fullName: env.ADMIN_NAME || 'المسؤول الإداري',
    forceReset: env.ADMIN_FORCE_RESET === 'true',
  },
};
