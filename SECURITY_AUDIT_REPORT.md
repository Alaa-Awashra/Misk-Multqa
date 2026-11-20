# Security Audit Report — Misk-Multqa (ملتقى المسك القرآني)

**Date:** 2026-11-20
**Scope:** `server/` (Node.js / Express 5), `client/` (React 18 / Vite), `database/` (PostgreSQL on Supabase), `google-apps-script/`, `render.yaml`, Git history (9 commits).
**Method:** Manual code review against OWASP ASVS 5.0 / Top 10, dependency audit (`npm audit`), and automated security tests on an isolated, temporary PostgreSQL (embedded-postgres) with test accounts only. Nothing ran against the live site or the live Supabase database. Secrets are not printed anywhere in this report.

---

## 1. Executive Summary

Overall the application was **already in reasonably good shape**: every API route sits behind server-side authentication; roles are enforced on the server (default-deny with `allowRoles` / `requireAdmin` / `requireSupervisor`); record ownership is checked on every student, appointment, conversation and request; every SQL query is parameterized; all request bodies are validated with Zod; the session cookie is `HttpOnly` + `SameSite=Lax` + `Secure` in production; Helmet sets a strict CSP; the Apps Script email endpoint uses HMAC-SHA256 with timestamp, nonce-replay protection and constant-time comparison; and the Supabase tables have RLS enabled with no policies, which denies all access through the Data API.

The audit confirmed **one High and three Medium issues**, plus several Low-severity hardening gaps. All of them are fixed in code:

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | Supervisor and registrar login passwords stored in **recoverable** form (AES-GCM `password_enc`) and displayed to the admin indefinitely | **High** | Fixed (manual data purge pending, §6) |
| F2 | No way to invalidate sessions: a 7-day JWT stayed valid after a password change or an admin password reset | Medium | Fixed |
| F3 | The Google OAuth `state` JWT was signed with the **session key** and had a `sub` claim, so it worked as a 10-minute **admin session token** if leaked (it appears in Google URLs and browser history) | Medium | Fixed |
| F4 | Login throttling was per IP only; a single account could be brute-forced from many IPs | Medium | Fixed |
| F5 | No explicit CSRF origin check (only `SameSite=Lax`) | Low | Fixed (defense in depth) |
| F6 | Oversized request body returned **500** and was logged as an unexpected server error | Low | Fixed |
| F7 | CSV export vulnerable to spreadsheet **formula injection** (applicant data comes from a public Google Form) | Low | Fixed |
| F8 | Notification links passed to `navigate()` without checking (related to react-router advisory GHSA-wrjc-x8rr-h8h6) | Low | Fixed |
| F9 | Missing `Permissions-Policy`, missing `Cache-Control: no-store` on private API data, no app-level HTTPS redirect | Low | Fixed |
| D1 | Dependency advisories: zod (High, DoS), vite/esbuild (dev-only), react-router (Moderate), uuid via exceljs (Moderate) | Low–Medium | Documented; major-version upgrades not done automatically (§5) |

**What was not verified and still needs manual action** (§5): purging the existing `password_enc` values, a least-privilege database role, verified TLS to the database, a real Google OAuth / Apps Script run in production, and major-version dependency upgrades.

The automated tests cannot prove the application is fully secure. They show that the specific controls below behave as intended.

---

## 2. Twenty-Control Security Matrix

Legend: ✅ Implemented · 🟡 Partial · ❌ Missing · ➖ Not applicable

### 1. Hide API keys and secrets — ✅ (no change needed)
- **Evidence:** All secrets are read from `process.env` in `server/src/config.js`. `JWT_SECRET` (≥32 chars) and `CREDENTIALS_KEY` are **required in production**: the server refuses to start without them. `DATABASE_URL` is required. The client contains **no** `import.meta.env` usage and no `.env` file, so no Vite variable can leak a secret into the bundle. `render.yaml` marks every secret `sync: false`. Error responses are generic (`middleware/errors.js`).
- **Severity:** none found. **Files:** `server/src/config.js`, `render.yaml`.
- **Tests:** `security.test.js › تسرب الأسرار` checks 13 common responses for bcrypt hashes, `password_hash`/`password_enc`/`value_enc`/`refresh_token`/`session_version`, and the actual test secret values.
- **Remaining:** In development only, `CREDENTIALS_KEY` falls back to `JWT_SECRET`. This is acceptable for local use.

### 2. Purge Git secrets — ✅ (nothing to purge)
- **Evidence:** `.gitignore` ignores `.env`, `.env.*` (except `.env.example`). Across all 9 commits, the only env-like file ever committed is `.env.example`. A pattern scan of the full history (`git log --all -p`) for AWS/Google/Resend/Stripe keys, JWTs, private keys and `postgres://user:pass@` URLs found only **placeholders** (`[YOUR-PASSWORD]`, `PASS…`, `GOCSPX-xxxx`, `re_xxxx`) and one false positive (an `AKIA…` substring inside the base64 PNG in `client/public/logo.svg`).
- **Remaining:** None. No history rewrite or credential rotation is needed based on this scan. If you ever suspect a secret was shared elsewhere (screenshots, chat), rotate it anyway.

### 3. Appropriate database keys — ✅
- **Evidence:** The React app never talks to Supabase directly: no `@supabase/supabase-js` and no Supabase URL or keys in `client/`. All data access goes through Express using `DATABASE_URL`, which exists only on the server.
- **Remaining (manual, recommended):** The backend connects as the Supabase `postgres` role, which bypasses RLS and has DDL rights. Least privilege would be a dedicated role with DML-only rights on `public` and a separate migration role (§5-R3).

### 4. Row-Level Security — ✅ (deny-all) / 🟡 (grants)
- **Evidence:** `database/schema.sql` and `001_platform_enhancements.sql` run `enable row level security` on all 24 application tables and on `schema_migrations`, with **no policies**. Through the Supabase Data API (roles `anon`/`authenticated`) every table is therefore deny-all. Authorization is enforced in Express (controls 6–7).
- **Not changed (by design):** Adding permissive policies would open data. Forcing RLS on the `postgres` role would break the backend.
- **Remaining (optional, manual):** Revoke table privileges from `anon`/`authenticated` as a second layer (SQL in §6).

### 5. Encrypt sensitive data — 🟡
- **Evidence:** The Google OAuth refresh token is stored AES-256-GCM encrypted (`utils/crypto.js`, `integration_secrets.value_enc`) with a key derived from `CREDENTIALS_KEY`, kept outside the database and code. Decryption failures return `null` and are never logged. Supabase encrypts storage at rest. DB transport uses TLS (`ssl` enabled for Supabase URLs).
- **Changed:** Removed the reversible encryption of **login passwords** (see F1 / control 10). That was the wrong use of encryption.
- **Not changed:** Student/supervisor PII (names, phones, addresses, `national_id`) is not field-level encrypted. Doing so would break search, sorting, duplicate detection and reports. Given that the database is reachable only from the backend, this is an accepted trade-off. Field-level encryption for `supervisors.national_id` alone is a reasonable future step.
- **Remaining:** The DB TLS connection uses `rejectUnauthorized: false` (encrypted but does not verify the server certificate) (§5-R4). `CREDENTIALS_KEY` must never be rotated without re-encrypting `integration_secrets`; in practice, reconnect Google after rotating.

### 6. Server-side authorization — ✅
- **Evidence:** `app.js` mounts `authenticate` on all `/api/*` routes except `/api/auth/*` (login, logout, email-verify) and `/api/cron/*` (shared-secret auth). Every route file declares its role guard (`router.use(requireAdmin)` for supervisors, staff, analytics, compliance, email, google; `allowRoles('admin','supervisor')` for students, appointments, dashboard, reports, requests; `allowRoles('registrar','admin')` for admissions). `authenticate` reloads the user from the DB on **every request**, so a suspended or deleted account loses access immediately.
- **Tests:** 22 protected endpoints → 401 without a session; 21 admin endpoints → 403 for a supervisor; registrar → 200 on admissions and 403 on students, appointments, reports, analytics, supervisors, staff, dashboard, compliance, activity.

### 7. Record-level access (IDOR / BOLA) — ✅
- **Evidence:**
  - Students: `loadStudentFor()` checks `supervisor_id`.
  - Appointments: `loadOwned()` and the session/series checks.
  - Conversations: `loadConv()` checks `owner_id`.
  - Requests and reports: `resolveSupervisorId()` forces the supervisor's own ID.
  - Admin-supplied `supervisor_id` query parameters are ignored for supervisors.
  - All `:id` parameters are UUID-validated (`uuidParam`).
  - Not-owned records return **404**, not 403, so a probe can't tell whether a record exists.
- **Tests:** As another supervisor, reading, updating, warning, requesting removal, booking, viewing, cancelling and deleting appointments, and reading, replying to and closing conversations all return 404. Lists don't leak other supervisors' records. The data is unchanged afterwards.

### 8. Field tampering and mass assignment — ✅
- **Evidence:** Every write uses an explicit Zod schema (unknown keys stripped; `appointments` uses `.strict()`), and every `UPDATE` lists its columns explicitly. Nothing passes `req.body` straight into SQL. `role`, `is_active`, `session_version`, `username`, `supervisor_type` (self), `status` and `supervisor_id` (for supervisors) are never writable by the account owner. Changing an email resets `email_verified_at`.
- **Tests:** A crafted `PUT /profile` with `role: admin`, `session_version`, `username`, `password_hash`, `email_verified_at` and `supervisor_type` changes none of them. A crafted `POST/PUT /students` with another `supervisor_id` and `status: removed` is ignored. Extra fields on appointments → 400.

### 9. Secure authentication sessions — 🟡 → ✅ (F2, F3, F5 fixed)
- **Before:**
  - The cookie was already `mq_token`, `HttpOnly`, `SameSite=Lax`, `Secure` in production, and `trust proxy = 1` (correct for Render's single proxy).
  - Tokens were never stored in `localStorage` (only a UI preference, `mq.nav.groups`).
  - **Gaps:** there was no way to invalidate sessions; the OAuth `state` was signed with the session key; and the CSRF defense relied only on SameSite.
- **Changed:**
  - Session JWT now carries `typ:'session'` and `sv` (session version), with `HS256` pinned on sign and verify.
  - `authenticate` rejects tokens whose `typ` isn't `session` or that carry a `p` claim, and rejects tokens whose `sv` ≠ `users.session_version`.
  - New `revokeSessions()` bumps the version on: own password change (the current device gets a fresh cookie, all others are logged out), admin reset of a supervisor password, and admin reset of a registrar password.
  - OAuth `state` is now signed with a separate HMAC-derived key and a 128-bit nonce.
  - `clearAuthCookie` now uses the same cookie attributes as `setAuthCookie`.
  - New `csrfOriginCheck`: on every non-GET `/api` request it rejects an `Origin` that isn't the app's own host, `APP_URL` or `CLIENT_ORIGIN`; `Origin: null`; and `Sec-Fetch-Site: cross-site`. Non-browser callers (Supabase Cron, CLI) that send neither header pass, and they carry no browser cookie.
- **Backward compatibility:** Existing sessions (no `typ`/`sv`) are treated as version 0 and **stay valid**, so nobody is logged out by the deploy. Suspension did not need revocation: the per-request status check already blocks it with a clear 403 "تم إيقاف حسابك" (account suspended) message, and reinstatement restores access, which preserves the existing behavior.
- **Tests:** 10 session tests, all passing:
  - forged-secret, expired, `alg:none`, `p:'google'` and `typ:'email'` tokens → 401;
  - a real OAuth `state` used as a session → 401;
  - legacy session tokens → 200;
  - after an admin reset, the old session → 401 and the new password works;
  - after an own password change, the current session → 200 and the other device → 401;
  - cross-origin, `Origin: null` and `Sec-Fetch-Site: cross-site` POST/PUT with a valid cookie → 403 `BAD_ORIGIN`;
  - same-origin requests → 200;
  - the cookie is `HttpOnly; SameSite=Lax`, and the token never appears in a response body.
- **Remaining:** Logout clears the cookie but does not server-revoke that specific JWT; a copied token stays valid until it expires (7 days) or the password is changed. Per-token revocation would need a denylist table and isn't justified for this threat model.

### 10. Secure password storage — 🟡 → ✅ (F1 fixed)
- **Before:**
  - Passwords were hashed with bcrypt (cost 10) and verified with a constant-time dummy-hash comparison for unknown usernames.
  - **But** on supervisor and registrar creation and on every admin reset, the plaintext was **also** stored AES-GCM encrypted in `users.password_enc`.
  - `GET /api/supervisors/:id` and `GET /api/staff` decrypted it and returned it to the admin every time. Anyone with DB access plus `CREDENTIALS_KEY`, or an admin session, could read every current password.
- **Changed:**
  - `password_enc` is no longer written; it's set to `NULL` on every reset.
  - Read endpoints return `password: null, password_known: false`.
  - The generated password is returned **once**, in the create/reset response, so the admin can hand it over in person.
  - Admin resets also log the user out everywhere.
  - The interface text in `SupervisorDetail.jsx`, `Supervisors.jsx` and `RegistrarDialog.jsx` now explains the one-time display and the reset flow.
- **Not changed:** bcrypt cost stays 10 to avoid slowing login on the free tier; hashes are compatible. No account was locked out: existing bcrypt hashes are untouched.
- **Remaining (manual, needs approval):** Existing `password_enc` values for accounts created before this change are **still in the database**, unused. Purge them with the SQL in §6.

### 11. Rate limiting — 🟡 → ✅ (F4 fixed)
- **Before:**
  - Login: 20 failures per 15 min per IP.
  - Email verification: 30 per 15 min.
  - Messages: 30/min per user.
  - Announcements: 20 publishes per window.
  - Email test/check: limited.
- **Changed:**
  - Added a **per-account** login limit: 10 failures per 15 min per username, from any IP; successful logins are not counted.
  - Added a password-change limit: 10 per 15 min per user.
- **Proxy:** `trust proxy = 1` makes `req.ip` the client IP from Render's `X-Forwarded-For`.
- **Tests:** 11 failures from 11 different IPs → 429 on the account limit, while another account from the same IP still logs in. 21 failures from one IP → 429.
- **Remaining:** Limits are kept in process memory and reset on restart or redeploy. That is fine for the single Render instance. If you scale to several instances, move them to a shared store (Postgres or Redis). The per-account limit lets someone deliberately lock a known username out for 15 minutes. This is an accepted, standard trade-off; the message doesn't reveal whether the account exists.

### 12. Bot and abuse protection — ✅ (no CAPTCHA justified)
- **Evidence:** The app has **no public, unauthenticated write endpoints** apart from login, email-token verification and the secret-protected cron endpoint. Public registration happens on **Google Forms** (Google's own abuse protection), and responses are imported server-side with length caps (`services/admissions.js › clean()`) and duplicate detection. Login is protected by IP and account rate limits plus constant-time comparison.
- **Decision:** No CAPTCHA or third-party service was added: it would hurt accessibility, and the threat doesn't justify it. Re-evaluate if a public form is ever hosted inside the app.

### 13. Parameterized queries — ✅
- **Evidence:** Every query uses `$n` placeholders with the `pg` driver. Dynamic SQL fragments (`where.join(' and ')`, `rangeSql()`, role-based scope strings) are built only from **constant strings** inside the code. User-supplied filter values go through allowlists (`['scheduled','completed',…].includes(...)`, `isUuid`, date regexes) **and** bind parameters. There is no dynamic `ORDER BY` from input.
- **Tests:** Three injection payloads across 6 filtered list endpoints (students, appointments, conversations, admissions, activity, reports) and the login form return no 5xx, don't widen results (no cross-supervisor rows), and leave the `users` table intact.

### 14. Validate all inputs — ✅
- **Evidence:** Zod schemas cover every body:
  - text with max lengths;
  - `email()`;
  - a phone regex;
  - ISO dates;
  - enums for categories, statuses and kinds;
  - numeric ranges (grade 0–100, pages ≤ 604, parts ≤ 30, durations 5–240);
  - recurrence limits (≤ 26, ≤ 300 appointments per request, ≤ 40 students per session);
  - settings ranges.

  Query parameters are allowlisted. JSON bodies are capped at 100 KB. Validation errors return Arabic messages without internals.
- **Changed (F6):** An oversized body now returns **413 `PAYLOAD_TOO_LARGE`**, and other body-parser client errors return a generic 4xx, instead of a 500 plus an "unexpected error" log line.
- **Tests:** a 200 KB body → 413; strict appointment schema; malformed IDs → 400/404 with no internals.

### 15. Escape user-generated content (XSS) — ✅
- **Evidence:**
  - React renders all user content as text: there is no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` anywhere in `client/src`.
  - The CSP is `script-src 'self'` with no `unsafe-inline` for scripts and `object-src 'none'`.
  - HTML email templates escape every interpolated value (`esc()` / `nl2br()` in `services/email/templates.js`).
  - External links to Google Sheets and Forms use `rel="noopener noreferrer"`.
- **Changed:**
  - **(F7)** `client/src/lib/csv.js` now prefixes cells starting with `=`, `@`, tab or CR, or with `+`/`-` followed by non-numeric content, with `'` (OWASP CSV-injection guidance). Phone numbers such as `+970 59…` and negative numbers are unchanged.
  - **(F8)** Notification links are followed only if they are internal paths (`/^\/(?![/\\])/`).
  - The XLSX export (exceljs) writes strings as values, not formulas, so no change was needed.
- **Tests:** An `<img onerror>` / `<script>` payload in a message is returned verbatim as JSON text (rendered as text by React). The rendered email HTML contains `&lt;script&gt;` and no raw tags.

### 16. Restrict file uploads — ➖ Not applicable
- **Evidence:** There's no upload functionality: no `multer` or `busboy`, no multipart parsing, and only `express.json` is mounted. Registration attachments, if any, stay in Google Forms/Drive. No upload feature was introduced.

### 17. Minimize API responses — ✅ (improved by F1)
- **Evidence:**
  - `shapeUser()` returns a fixed field set (no hash, no `session_version`).
  - The login query selects `password_hash` only for comparison and never returns it.
  - Supervisors receive only their own students, appointments and conversations.
  - Administrative statistics, analytics, compliance, activity and email logs are admin-only.
  - Lists are capped (`limit 200–5000`).
  - Errors never expose SQL or stack traces.
  - **Changed:** decrypted passwords removed from `GET /supervisors/:id` and `GET /staff`.
  - **Added (F9):** `Cache-Control: no-store` on all `/api` responses, so private data isn't kept in browser or proxy caches.
- **Remaining (performance, not security):** `GET /appointments` for the admin calendar can return up to 5000 rows. Pagination could be added later if needed.

### 18. Security headers — ✅ (improved)
- **Evidence (Helmet 8):**
  - `Content-Security-Policy`:
    - `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline' fonts.googleapis.com`;
    - `font-src 'self' fonts.gstatic.com data:`, `img-src 'self' data: blob:`, `connect-src 'self'`;
    - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`;
    - `upgrade-insecure-requests` in production.
  - `Strict-Transport-Security` (1 year, includeSubDomains)
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `X-Frame-Options: SAMEORIGIN`
  - `Cross-Origin-Opener-Policy`
  - `x-powered-by` disabled
- **Added (F9):** a `Permissions-Policy` that disables camera, microphone, geolocation, payment, USB and motion sensors.
- **Compatibility:** Google OAuth uses top-level navigation (`/api/google/oauth/start` → `accounts.google.com`), which CSP doesn't restrict, and Google Forms open in new tabs. A real-browser run (Edge headless) produced **zero CSP violations** while logging in, messaging and opening admin pages.
- **Tests:** a header assertion test.

### 19. Enforce HTTPS — ✅ (improved)
- **Evidence:** Render terminates TLS and redirects HTTP to HTTPS. The `Secure` cookie flag is set in production, along with HSTS and `upgrade-insecure-requests`. The OAuth `redirect_uri` defaults to `${APP_URL or RENDER_EXTERNAL_URL}/api/google/oauth/callback`, which is HTTPS on Render.
- **Added (F9):** `enforceHttps` is a backup layer: in production only, a request with `X-Forwarded-Proto: http` gets a 301 to HTTPS (GET/HEAD) or a 403 (other methods). Internal health checks (no header) and local HTTP development are unaffected.
- **Remaining:** Make sure the Google Cloud OAuth client lists **only** the HTTPS callback URI (plus `http://localhost:4000/...` only if you develop locally).

### 20. Scan dependencies — 🟡
- **Evidence (`npm audit`, 2026-11-20):**

  | Package | Where | Severity | Advisory | Reachability | Action |
  |---|---|---|---|---|---|
  | zod 3.25.76 | server (prod) | High | GHSA-mrhx-c7xc-m3w5 — memory exhaustion validating oversized constrained collections | Mitigated: JSON bodies are capped at 100 KB before Zod runs; arrays are bounded (`max(40)`) | Fix requires **zod 4** (breaking API). Planned upgrade, not automatic |
  | uuid 8.3.2 (via exceljs) | server (prod) | Moderate | GHSA-w5hq-g745-h8pq — v3/v5/v6 with `buf` | Not reachable: exceljs uses v4 without a caller buffer | Monitor for an exceljs release |
  | vite 5.4.21 / esbuild 0.21.5 | client (**dev only**) | High/Moderate | dev-server path traversal, launch-editor issues | **Not in production**: Render serves the static build | Upgrade to vite ≥ 6.4.4 / 7.x when convenient (major) |
  | react-router-dom 6.30.6 | client (prod) | Moderate | GHSA-wrjc-x8rr-h8h6 open redirect via backslash; GHSA-337j-9hxr-rhxg (SSR only — not used) | Mitigated in code: the only dynamic `navigate()` target is now restricted to internal paths | Upgrade to v7 (major) later |
  | root package | — | none | — | — | — |

- **Lockfiles:** `package-lock.json` exists for root, server and client, and installs are reproducible. **No dependency was changed** in this pass, so there's no lockfile churn.
- `npm audit` alone doesn't prove security; reachability was assessed manually as above.

---

## 3. Critical Vulnerabilities

There were **no Critical** findings: no authentication bypass, no SQL injection, no exposed secrets, and no cross-tenant data access.

The most serious confirmed issue was **F1 (High): recoverable passwords**. Every supervisor's and registrar's current password (unless they had changed it themselves) could be recovered by:
1. anyone holding an admin session (shown in the interface, returned by `GET /api/supervisors/:id` and `GET /api/staff`); or
2. anyone obtaining a database dump together with `CREDENTIALS_KEY`.

Because people reuse passwords, this extended the impact of an admin compromise beyond this app. It's fixed in code; the legacy data purge is in §6.

---

## 4. Implemented Improvements (files changed)

| File | Change |
|---|---|
| `database/migrations/002_session_security.sql` (new) | Adds `users.session_version integer not null default 0` (additive only). |
| `server/src/middleware/auth.js` | Session JWT with `typ`/`sv`, `HS256` pinned; rejects other-purpose tokens; checks the session version on every request; `revokeSessions()` helper; `clearAuthCookie` with matching attributes; `USER_SQL` loads `session_version` (never returned to clients). |
| `server/src/middleware/security.js` (new) | `csrfOriginCheck`, `enforceHttps`, `permissionsPolicy`, `noStoreApi`. |
| `server/src/app.js` | Mounts the new middleware (HTTPS first; `no-store` + CSRF check on `/api`). |
| `server/src/middleware/errors.js` | 413 for oversized bodies; generic 4xx for other body-parser client errors. |
| `server/src/routes/auth.js` | Per-account login limiter; signs the session with the user's `session_version`. |
| `server/src/routes/profile.js` | Password-change limiter; password change in a transaction + `revokeSessions` + fresh cookie for the current device. |
| `server/src/routes/supervisors.js` | No `password_enc` writes; detail returns no password; reset clears `password_enc` and revokes sessions. |
| `server/src/routes/staff.js` | Same as supervisors, for registrar accounts. |
| `server/src/services/google.js` | OAuth `state` signed with a separate derived key, 128-bit nonce, `HS256` pinned. |
| `client/src/pages/SupervisorDetail.jsx`, `client/src/pages/Supervisors.jsx`, `client/src/components/RegistrarDialog.jsx` | Interface text for one-time password display and reset (Arabic, RTL unchanged). |
| `client/src/components/Layout.jsx` | Notification links restricted to internal paths. |
| `client/src/lib/csv.js` | CSV formula-injection protection. |
| `server/test/security.test.js` (new) | 30 security regression tests (see §10). |

No route, feature, table, record or integration was removed. Google Forms/Sheets, Apps Script email, the Render Blueprint and the Arabic RTL interface are unchanged.

---

## 5. Remaining Security Risks (manual action required)

| ID | Risk | Recommended action | Who |
|---|---|---|---|
| R1 | Legacy `password_enc` values remain in `users` for accounts created or reset before this change | Run the purge SQL in §6 (needs your approval: it permanently removes the admin's ability to *view* those old passwords; resets keep working) | You, in the Supabase SQL editor |
| R2 | zod 3 advisory (DoS) | Plan a zod 4 migration with the test suite; the 100 KB body cap reduces the risk meanwhile | Developer |
| R3 | Backend uses the `postgres` role (superuser-like, bypasses RLS) | Create an `app_user` role with `SELECT/INSERT/UPDATE/DELETE` on `public` only; run migrations with a separate owner role | Developer + Supabase |
| R4 | DB TLS without certificate verification (`rejectUnauthorized:false`) | Download the Supabase CA certificate and pass it via `ssl.ca` (env var), then set `rejectUnauthorized:true` | Developer |
| R5 | vite/esbuild (dev-only), react-router v6 advisories | Upgrade majors in a separate branch and run the tests and browser checks | Developer |
| R6 | In-memory rate limits reset on redeploy | Acceptable on a single instance; move to a shared store if scaled | — |
| R7 | Logout doesn't revoke the specific JWT server-side | Accepted; a password change logs out all other devices | — |
| R8 | Not tested live: Google OAuth consent, Forms/Sheets sync, real Apps Script sending | Run once in production after deploying: Settings ← Integrations ← «فحص الاتصال» (Check connection) and send a test email; reconnect Google | You |
| R9 | Google Cloud OAuth client may list extra redirect URIs | Keep only `https://<your-app>/api/google/oauth/callback` | You |
| R10 | Optional second RLS layer | Revoke `anon`/`authenticated` grants (SQL in §6) | You (optional) |
| R11 | `supervisors.national_id` stored in plaintext | Consider field-level encryption (AES-GCM with `CREDENTIALS_KEY`) in a future change | Developer |

---

## 6. Database Changes

### Automatic (runs on the next deploy)
`database/migrations/002_session_security.sql`:
```sql
alter table users add column if not exists session_version integer not null default 0;
```
- **Additive and idempotent.** It touches no existing values, and the default 0 matches every current session, so **nobody is logged out**.
- It runs inside a transaction under the existing advisory lock, through `npm run migrate` in Render's build command (`render-build`).
- It was tested on a fresh database (the full suite runs all migrations).

### Manual, needs your explicit approval (not executed)
**R1: purge legacy recoverable passwords.** After this, the admin can't *view* old passwords; they use «توليد كلمة مرور جديدة» (Generate new password) instead. Login is not affected.
```sql
-- Check first how many rows hold a recoverable copy:
select count(*) from users where password_enc is not null;
-- Then purge:
update users set password_enc = null where password_enc is not null;
```

**R10 (optional): revoke Data API privileges.** RLS already denies these roles; this is defense in depth.
```sql
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
```
Run it in the Supabase SQL editor, then check the app (the backend connects as `postgres` and is unaffected).

---

## 7. Render Configuration

**No new environment variables are required.** Please confirm the existing ones (values aren't shown here):

| Variable | Requirement |
|---|---|
| `NODE_ENV` | `production` (enables the Secure cookie, HTTPS redirect, `upgrade-insecure-requests`, and the startup checks) |
| `JWT_SECRET` | ≥ 32 random characters (startup fails otherwise). Rotating it logs everyone out and invalidates pending OAuth states |
| `CREDENTIALS_KEY` | Set, random, **never rotated casually** (it encrypts the Google refresh token; reconnect Google if it changes) |
| `CRON_SECRET` | ≥ 24 characters; must match the Supabase Vault secret `mq_cron_secret` |
| `DATABASE_URL` | Supabase pooler URL, server-side only |
| `GAS_WEB_APP_URL`, `GAS_SHARED_SECRET` (≥ 32), `EMAIL_PROVIDER=google_apps_script`, `EMAIL_NOTIFICATIONS_ENABLED` | Unchanged |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, optional `GOOGLE_REDIRECT_URI` | Redirect must be HTTPS |
| `APP_URL` (optional) | If you use a custom domain, set it to `https://your-domain` so the CSRF check, emails and OAuth use it (`RENDER_EXTERNAL_URL` is used otherwise) |
| `CLIENT_ORIGIN` | Leave **empty** (the frontend is served from the same origin). Set it only if the frontend is hosted elsewhere |

---

## 8. Deployment Checklist

1. Review the diff locally: `git status`, `git diff`.
2. Run the tests: `cd server && npm test` (expect 74/74), then `cd ../client && npx vite build`.
3. Commit on a branch, e.g. `git checkout -b security-hardening && git add -A && git commit -m "Security hardening"`. Push and open a PR, or merge into `main` when ready (nothing was pushed by this audit).
4. Render deploys automatically from `main`; the build runs `npm run migrate` (migration 002).
5. After the deploy:
   - [ ] Log in as admin and as a supervisor; send a message; open the calendar and reports.
   - [ ] Open a supervisor's page: the credentials card shows the username plus the "passwords aren't stored" notice. Test «توليد كلمة مرور جديدة» (Generate new password) on a test account.
   - [ ] Settings ← Integrations: email «فحص الاتصال» (Check connection) and the Google status are OK.
   - [ ] Browser DevTools → Network: responses have `Permissions-Policy` and `Cache-Control: no-store` (API), and the console shows no CSP errors.
6. When satisfied, run the R1 purge SQL (§6), and optionally R10.
7. Plan R2–R5 as normal development tasks.

## 9. Rollback Plan

- **Code:** In Render → *Deploys*, choose the previous successful deploy → **Rollback**, or run `git revert <commit>` and push. The old code ignores the new column and the new token claims, so existing sessions keep working in both directions.
- **Database:** Migration 002 doesn't need to be reverted: the extra column with default 0 is harmless to older code. If you really want to remove it: `alter table users drop column if exists session_version;` and `delete from schema_migrations where name = '002_session_security.sql';`. Do this only after rolling back the code.
- **R1 purge:** irreversible by design (there's no copy to restore). Nothing breaks, because the admin can always generate a new password.
- No secrets were rotated and no data was deleted, so no secret or data restore is needed.

---

## 10. Test Results

All tests ran on an isolated embedded PostgreSQL started by `server/test/helpers.js` (it ignores the production `DATABASE_URL`), plus a local fake Apps Script that executes the real `Code.gs`.

| Command | Result |
|---|---|
| `cd server && npm test` | **74 / 74 passed** (44 existing functional and integration tests + 30 new security tests), 0 failed |
| `node --test test/security.test.js` | **30 / 30 passed** |
| `cd client && npx vite build` | Success |
| `npm audit --json` (root, server, client) | root: 0; server: 1 high (zod), 2 moderate (exceljs→uuid); client: 1 high + 3 moderate (vite/esbuild dev-only, react-router). See control 20 |
| Git history secret scan (`git log --all -p` + patterns; `git log --all --name-only`) | No real secrets; placeholders only |
| Real-browser end-to-end check (Edge headless, temporary DB) | Login through the interface form, new conversation and reply, password change (current session kept, other session → 401), admin supervisor page shows no password; **no JS errors, no CSP violations** |

**Security tests by area (`server/test/security.test.js`):**
- **Authentication and authorization:** unauthenticated access (22 endpoints), supervisor → admin endpoints (21), registrar scope.
- **Record-level access:** student, appointment and conversation access by another supervisor (read and write); malformed and traversal IDs.
- **Field tampering:** role, status and owner escalation through profile, students and appointments.
- **Injection and XSS:** SQL injection across 6 list endpoints plus login; stored XSS round-trip and email escaping.
- **CSRF and transport:** cross-origin, `null` origin and `Sec-Fetch-Site` POSTs; same-origin allowed; cookie flags; security headers; 413 for oversized bodies.
- **Rate limiting:** per-account and per-IP login limits.
- **Passwords and sessions:** bcrypt-only storage, no recoverable copy, one-time display; admin reset revokes sessions; own password change revokes other sessions; forged, expired, `alg:none` and wrong-purpose JWTs; OAuth `state` not usable as a session; logout clears the cookie.
- **Secret leakage:** secret and hash leakage across 13 responses.
- **Integrations and admin operations:** OAuth callback with a forged or other-user state; non-admin callback; arbitrary test-email recipient; supervisor test email; Apps Script unsigned and bad-signature requests; cron without or with a wrong secret; duplicate suspend and duplicate removal request.

**Not performed:**
- Frontend unit tests: none exist in the project.
- Any test against the live site or the live database: excluded by design.
- Real Google OAuth consent and Forms/Sheets calls, and real Gmail delivery: these need production credentials; the existing tests cover them with mocks and the real `Code.gs`.
- Automated DAST scanning (e.g. ZAP).
- Load or DoS testing.
- Major-version dependency upgrades.
