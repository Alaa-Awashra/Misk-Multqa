-- =====================================================================
-- جدولة المهام عبر Supabase Cron (pg_cron + pg_net) — مجاني ضمن Supabase
--
-- لماذا؟ خادم Render المجاني ينام بعد 15 دقيقة بلا زيارات، فلا يُعتمد على مؤقتات داخل Node وحدها.
-- Supabase Cron يستدعي نقطة /api/cron/tick كل ساعة؛ الطلب يوقظ الخادم إن كان نائمًا،
-- والمهام "تعويضية" وآمنة للتكرار: تنجز كل ما استحق منذ آخر تشغيل ولا تكرر شيئًا.
--
-- خطوات التشغيل (مرة واحدة):
--   1) Supabase → Database → Extensions: فعّل pg_cron و pg_net
--   2) ضع نفس قيمة CRON_SECRET المضبوطة على Render مكان <CRON_SECRET> أدناه،
--      وضع رابط خدمتك على Render مكان <APP_URL> (مثال: https://masak-quran-forum.onrender.com)
--   3) نفّذ هذا الملف في Supabase → SQL Editor
--
-- السر يُحفظ في Supabase Vault (مشفّر) وليس في نص المهمة.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- حفظ السر والرابط في Vault (أعد التنفيذ مع قيم جديدة لتحديثها)
select vault.create_secret('<CRON_SECRET>', 'mq_cron_secret', 'سر استدعاء مهام ملتقى المسك')
where not exists (select 1 from vault.secrets where name = 'mq_cron_secret');
select vault.create_secret('<APP_URL>', 'mq_app_url', 'رابط خادم ملتقى المسك على Render')
where not exists (select 1 from vault.secrets where name = 'mq_app_url');

-- إزالة جدولة سابقة بنفس الاسم (لإعادة التنفيذ بأمان)
select cron.unschedule(jobid) from cron.job where jobname = 'mq-tick';

-- كل ساعة عند الدقيقة 7 — مهلة 120 ثانية تكفي لاستيقاظ خادم Render المجاني
select cron.schedule(
  'mq-tick',
  '7 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'mq_app_url') || '/api/cron/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mq_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- للتحقق لاحقًا:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'mq-tick') order by start_time desc limit 10;
--   select id, status_code, error_msg, created from net._http_response order by created desc limit 10;
-- ومن داخل المنصة: صفحة «متابعة السجلات» ← تبويب «سجل التشغيل».
--
-- لتحديث السر لاحقًا:
--   select vault.update_secret((select id from vault.secrets where name = 'mq_cron_secret'), '<NEW_SECRET>');
