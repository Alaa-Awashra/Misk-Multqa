-- =====================================================================
-- 001 — توسعة المنصة: الأدوار، الطلبات، التحذيرات، المتابعة، التحليلات،
--        المراسلات، الإعلانات، القبول والتسجيل، البريد، الجلسات الجماعية
-- إضافي بالكامل: لا يحذف أي جدول أو بيانات موجودة.
-- يُنفَّذ مرة واحدة داخل transaction عبر: npm run migrate
-- =====================================================================

-- إسقاط قيود CHECK القديمة على users.role و students.status أيًّا كان اسمها
-- (تحسبًا لاختلاف الأسماء في قاعدة الإنتاج عن الأسماء الافتراضية)
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass::text as tbl, c.conname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'c'
      and ((c.conrelid = 'users'::regclass and a.attname = 'role')
        or (c.conrelid = 'students'::regclass and a.attname = 'status'))
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

-- ---------------------------------------------------------------- المستخدمون والأدوار
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('admin', 'supervisor', 'registrar'));

alter table users add column if not exists is_active               boolean not null default true;
alter table users add column if not exists email_verified_at       timestamptz;
alter table users add column if not exists email_verify_token_hash text;
alter table users add column if not exists email_verify_expires_at timestamptz;
alter table users add column if not exists email_verify_sent_at    timestamptz;
create index if not exists users_email_idx on users (lower(email)) where email is not null;

-- فصل المشرف تلقائيًا بسبب التحذيرات
alter table supervisors add column if not exists dismissed_by_policy boolean not null default false;

-- ---------------------------------------------------------------- الطلاب: حذف ناعم
alter table students drop constraint if exists students_status_check;
alter table students add constraint students_status_check check (status in ('active', 'suspended', 'removed'));
alter table students add column if not exists removed_at     timestamptz;
alter table students add column if not exists removal_reason text;
alter table students add column if not exists application_id uuid;

-- ---------------------------------------------------------------- طلبات حذف / فصل الطلاب (موافقة إدارية)
create table if not exists student_requests (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references students(id) on delete cascade,
  supervisor_id  uuid references supervisors(id) on delete set null,
  requested_by   uuid references users(id) on delete set null,
  requested_by_name text,
  kind           text not null check (kind in ('removal', 'dismissal')),
  reason         text not null,
  comments       text,
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by     uuid references users(id) on delete set null,
  decided_by_name text,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now()
);
create unique index if not exists student_requests_one_pending on student_requests (student_id) where status = 'pending';
create index if not exists student_requests_status_idx on student_requests (status, created_at desc);
create index if not exists student_requests_supervisor_idx on student_requests (supervisor_id, created_at desc);

-- ---------------------------------------------------------------- التحذيرات الرسمية للمشرفين
create table if not exists supervisor_warnings (
  id              uuid primary key default gen_random_uuid(),
  supervisor_id   uuid references supervisors(id) on delete set null,   -- يبقى السجل حتى لو حُذف المشرف
  supervisor_name text not null,
  reason          text not null,
  notes           text,
  source          text not null default 'manual' check (source in ('manual', 'compliance')),
  status          text not null default 'active' check (status in ('active', 'revoked')),
  issued_by       uuid references users(id) on delete set null,
  issued_by_name  text,
  review_id       uuid,
  created_at      timestamptz not null default now(),
  revoked_by      uuid references users(id) on delete set null,
  revoked_by_name text,
  revoked_at      timestamptz,
  revoke_reason   text
);
create index if not exists supervisor_warnings_sup_idx on supervisor_warnings (supervisor_id, created_at desc);

-- ---------------------------------------------------------------- الإشعارات الداخلية
create table if not exists notifications (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  type       text not null,
  title      text not null,
  body       text,
  link       text,
  data       jsonb not null default '{}'::jsonb,
  dedupe_key text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists notifications_dedupe_key on notifications (user_id, dedupe_key) where dedupe_key is not null;
create index if not exists notifications_user_idx on notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on notifications (user_id) where read_at is null;

-- ---------------------------------------------------------------- صندوق البريد الصادر (Resend) + سجل التسليم
create table if not exists email_outbox (
  id                  bigserial primary key,
  dedupe_key          text not null unique,          -- يمنع إرسال نفس الرسالة مرتين
  to_email            text not null,
  to_user_id          uuid references users(id) on delete set null,
  template            text not null,
  subject             text not null,
  html                text,
  text_body           text,
  status              text not null default 'pending'
                      check (status in ('pending', 'sending', 'sent', 'failed', 'disabled')),
  attempts            integer not null default 0,
  last_error          text,
  next_attempt_at     timestamptz not null default now(),
  provider_message_id text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  updated_at          timestamptz not null default now()
);
create index if not exists email_outbox_due_idx on email_outbox (next_attempt_at) where status = 'pending';
create index if not exists email_outbox_created_idx on email_outbox (created_at desc);

-- ---------------------------------------------------------------- متابعة اكتمال بيانات المشرفين
create table if not exists compliance_exemptions (
  id            uuid primary key default gen_random_uuid(),
  supervisor_id uuid references supervisors(id) on delete cascade,     -- NULL = إعفاء عام لكل المشرفين
  kind          text not null default 'exempt' check (kind in ('leave', 'exempt')),
  start_date    date not null,
  end_date      date not null,
  reason        text not null,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists compliance_exemptions_range_idx on compliance_exemptions (start_date, end_date);

create table if not exists compliance_reviews (
  id               uuid primary key default gen_random_uuid(),
  supervisor_id    uuid not null references supervisors(id) on delete cascade,
  period_start     date not null,
  period_end       date not null,
  deadline_at      timestamptz not null,
  status           text not null check (status in ('ok', 'violation', 'exempt', 'excused')),
  missing          jsonb not null default '[]'::jsonb,
  missing_count    integer not null default 0,
  violation_number integer,
  action           text not null default 'none' check (action in ('none', 'reminder', 'warning')),
  warning_id       uuid references supervisor_warnings(id) on delete set null,
  excused_by       uuid references users(id) on delete set null,
  excused_at       timestamptz,
  excuse_reason    text,
  created_at       timestamptz not null default now(),
  unique (supervisor_id, period_start)              -- لا تُحتسب نفس الفترة مرتين
);
create index if not exists compliance_reviews_sup_idx on compliance_reviews (supervisor_id, period_start desc);

-- ---------------------------------------------------------------- التقارير الدورية (كل 14 يومًا)
create table if not exists performance_reports (
  id           uuid primary key default gen_random_uuid(),
  period_start date not null unique,
  period_end   date not null,
  generated_at timestamptz not null default now(),
  generated_by text not null default 'cron',
  data         jsonb not null
);

-- ---------------------------------------------------------------- التواصل مع الإدارة
create table if not exists conversations (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references users(id) on delete cascade,   -- المشرف صاحب المحادثة
  subject         text not null,
  category        text not null default 'question' check (category in ('question', 'complaint', 'suggestion', 'request', 'other')),
  status          text not null default 'open' check (status in ('open', 'in_progress', 'closed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index if not exists conversations_owner_idx on conversations (owner_id, last_message_at desc);
create index if not exists conversations_last_idx on conversations (last_message_at desc);

create table if not exists conversation_messages (
  id              bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id       uuid references users(id) on delete set null,
  sender_name     text,
  sender_role     text not null,
  body            text not null,
  created_at      timestamptz not null default now()
);
create index if not exists conversation_messages_conv_idx on conversation_messages (conversation_id, id);

create table if not exists conversation_reads (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- ---------------------------------------------------------------- الإعلانات والتعاميم
create table if not exists announcements (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  body              text not null,
  category          text not null check (category in ('schedule', 'meeting', 'important', 'policy', 'instructions', 'urgent')),
  audience          text not null default 'supervisors' check (audience in ('supervisors', 'registrars', 'staff')),
  pinned            boolean not null default false,
  event_at          timestamptz,
  published_at      timestamptz not null default now(),
  expires_at        timestamptz,
  send_email        boolean not null default true,
  email_enqueued_at timestamptz,
  created_by        uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index if not exists announcements_pub_idx on announcements (published_at desc) where deleted_at is null;

create table if not exists announcement_reads (
  announcement_id uuid not null references announcements(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

-- ---------------------------------------------------------------- القبول والتسجيل (Google Forms)
create table if not exists registration_forms (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  description     text,
  google_form_id  text unique,
  responder_url   text,
  edit_url        text,
  sheet_id        text,
  sheet_url       text,
  question_map    jsonb not null default '{}'::jsonb,   -- questionId -> اسم الحقل
  status          text not null default 'active' check (status in ('active', 'closed')),
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  last_synced_at  timestamptz,
  last_sync_error text,
  synced_count    integer not null default 0
);

create table if not exists applications (
  id                        uuid primary key default gen_random_uuid(),
  form_id                   uuid references registration_forms(id) on delete set null,
  response_id               text,
  submitted_at              timestamptz not null default now(),
  full_name                 text not null,
  gender                    text check (gender in ('male', 'female')),
  birth_date                date,
  phone                     text,
  email                     text,
  guardian_name             text,
  guardian_phone            text,
  address                   text,
  prior_parts               numeric(5, 2),
  notes                     text,
  raw                       jsonb not null default '{}'::jsonb,
  status                    text not null default 'new' check (status in ('new', 'under_review', 'accepted', 'rejected')),
  duplicate_of_application  uuid references applications(id) on delete set null,
  duplicate_of_student      uuid references students(id) on delete set null,
  duplicate_reason          text,
  assigned_supervisor_id    uuid references supervisors(id) on delete set null,
  student_id                uuid references students(id) on delete set null,
  admission_notes           text,
  decided_by                uuid references users(id) on delete set null,
  decided_at                timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (form_id, response_id)                       -- يمنع استيراد نفس الاستجابة مرتين
);
create index if not exists applications_status_idx on applications (status, submitted_at desc);
create index if not exists applications_phone_idx on applications (phone);

create table if not exists application_events (
  id             bigserial primary key,
  application_id uuid not null references applications(id) on delete cascade,
  actor_id       uuid references users(id) on delete set null,
  actor_name     text,
  action         text not null,
  from_status    text,
  to_status      text,
  note           text,
  created_at     timestamptz not null default now()
);
create index if not exists application_events_app_idx on application_events (application_id, id);

-- أسرار التكاملات (مشفرة من التطبيق) — منفصلة عن جدول الإعدادات المقروء للجميع
create table if not exists integration_secrets (
  key        text primary key,
  value_enc  text not null,
  meta       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- سجل تشغيل المهام المجدولة
create table if not exists job_runs (
  id          bigserial primary key,
  job         text not null,
  trigger     text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  result      jsonb,
  error       text
);
create index if not exists job_runs_started_idx on job_runs (started_at desc);

-- ---------------------------------------------------------------- التقويم: جلسات جماعية ومتكررة
-- session_id: مجموعة طلاب في نفس الجلسة مع نفس المشرف (يُسمح بتداخلها)
-- series_id : سلسلة جلسات متكررة
alter table appointments add column if not exists session_id uuid;
alter table appointments add column if not exists series_id uuid;
create index if not exists appointments_session_idx on appointments (session_id) where session_id is not null;
create index if not exists appointments_series_idx on appointments (series_id) where series_id is not null;

-- القيد القديم كان يمنع المشرف من جمع أكثر من طالب في نفس الوقت.
-- القيد الجديد: يمنع تداخل جلستين *مختلفتين* لنفس المشرف فقط، ويسمح بعدة طلاب في الجلسة نفسها.
-- (لا يوجد أي قيد عام بين المشرفين المختلفين)
alter table appointments drop constraint if exists appt_no_overlap_supervisor;
alter table appointments add constraint appt_no_overlap_supervisor
  exclude using gist (
    supervisor_id with =,
    (coalesce(session_id, id)) with <>,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status = 'scheduled');

-- ---------------------------------------------------------------- إعدادات جديدة (قابلة للتعديل من صفحة الإعدادات)
insert into settings (key, value) values
  ('supervisor_dismissal_warnings', '2'::jsonb),
  ('compliance_enabled',            'true'::jsonb),
  ('compliance_period_days',        '7'::jsonb),
  ('compliance_anchor_date',        '"2026-01-03"'::jsonb),
  ('compliance_grace_days',         '2'::jsonb),
  ('compliance_min_records',        '1'::jsonb),
  ('compliance_warning_after',      '2'::jsonb),
  ('compliance_lookback_days',      '90'::jsonb),
  -- لا تُقيَّم أي فترة قبل تاريخ تفعيل الميزة (لا عقوبات بأثر رجعي)
  ('compliance_start_date',         to_jsonb(current_date::text)),
  ('report_period_days',            '14'::jsonb),
  ('report_anchor_date',            '"2026-01-03"'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- الأمان: منع الوصول عبر واجهة Supabase العامة
alter table student_requests      enable row level security;
alter table supervisor_warnings   enable row level security;
alter table notifications         enable row level security;
alter table email_outbox          enable row level security;
alter table compliance_exemptions enable row level security;
alter table compliance_reviews    enable row level security;
alter table performance_reports   enable row level security;
alter table conversations         enable row level security;
alter table conversation_messages enable row level security;
alter table conversation_reads    enable row level security;
alter table announcements         enable row level security;
alter table announcement_reads    enable row level security;
alter table registration_forms    enable row level security;
alter table applications          enable row level security;
alter table application_events    enable row level security;
alter table integration_secrets   enable row level security;
alter table job_runs              enable row level security;
