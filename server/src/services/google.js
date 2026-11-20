// تكامل Google (Forms + Sheets) عبر OAuth لحساب الملتقى نفسه
//   - المسؤول يربط حساب Google مرة واحدة (موافقة OAuth) ويُحفظ refresh token مشفرًا في integration_secrets
//   - النماذج والجداول تُنشأ في Drive حساب الملتقى، والجداول خاصة (لا تُشارك علنًا)
//   - النطاقات: forms.body + forms.responses.readonly + drive.file (ملفات أنشأها التطبيق فقط)
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { HttpError } from '../utils/errors.js';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

let fetchImpl = (...a) => fetch(...a);
export const __setGoogleFetch = (fn) => {
  fetchImpl = fn || ((...a) => fetch(...a));
  tokenCache = null;
};

export const googleConfigured = () => !!(config.google.clientId && config.google.clientSecret);

// ---------------------------------------------------------------- OAuth
// مفتاح مستقل لتوقيع state مشتق من JWT_SECRET: رمز state لا يمكن استخدامه كجلسة والعكس
const stateKey = () => crypto.createHmac('sha256', config.jwtSecret).update('mq:google-oauth-state:v1').digest();

export function buildAuthUrl(userId) {
  if (!googleConfigured()) throw new HttpError(400, 'GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET غير مضبوطين', 'GOOGLE_NOT_CONFIGURED');
  const state = jwt.sign({ sub: userId, n: crypto.randomBytes(16).toString('hex'), p: 'google' }, stateKey(), { expiresIn: '10m', algorithm: 'HS256' });
  const p = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export function verifyState(state, userId) {
  try {
    const s = jwt.verify(state, stateKey(), { algorithms: ['HS256'] });
    return s.p === 'google' && s.sub === userId;
  } catch {
    return false;
  }
}

async function tokenRequest(params) {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error_description || body.error || `HTTP ${res.status}`;
    throw new HttpError(502, `رفض Google الطلب: ${msg}`, body.error === 'invalid_grant' ? 'GOOGLE_REAUTH' : 'GOOGLE_ERROR');
  }
  return body;
}

export async function exchangeCode(code) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: config.google.redirectUri });
  if (!t.refresh_token) throw new HttpError(502, 'لم يُرجع Google رمز التحديث. أزل صلاحية التطبيق من حسابك ثم أعد الربط.', 'GOOGLE_ERROR');
  let email = null;
  if (t.id_token) {
    try {
      email = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString('utf8')).email || null;
    } catch {
      /* ignore */
    }
  }
  await query(
    `insert into integration_secrets (key, value_enc, meta, updated_at) values ('google', $1, $2, now())
     on conflict (key) do update set value_enc = excluded.value_enc, meta = excluded.meta, updated_at = now()`,
    [encrypt(t.refresh_token), JSON.stringify({ email, scopes: t.scope, connected_at: new Date().toISOString() })]
  );
  tokenCache = null;
  return { email };
}

export async function googleConnection() {
  const { rows } = await query(`select meta, updated_at from integration_secrets where key = 'google'`);
  return { configured: googleConfigured(), connected: !!rows[0], account: rows[0]?.meta?.email || null, connected_at: rows[0]?.meta?.connected_at || null };
}

export async function disconnectGoogle() {
  await query(`delete from integration_secrets where key = 'google'`);
  tokenCache = null;
}

let tokenCache = null;
async function accessToken() {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  if (!googleConfigured()) throw new HttpError(400, 'تكامل Google غير مُعدّ على الخادم', 'GOOGLE_NOT_CONFIGURED');
  const { rows } = await query(`select value_enc from integration_secrets where key = 'google'`);
  const refresh = decrypt(rows[0]?.value_enc);
  if (!refresh) throw new HttpError(400, 'لم يُربط حساب Google بعد. اطلب من المسؤول ربطه من صفحة الإعدادات.', 'GOOGLE_NOT_CONNECTED');
  const t = await tokenRequest({ refresh_token: refresh, grant_type: 'refresh_token' });
  tokenCache = { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function gapi(method, url, body) {
  const token = await accessToken();
  const res = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new HttpError(502, `خطأ من Google: ${msg}`, 'GOOGLE_ERROR');
  }
  return data;
}

// ---------------------------------------------------------------- حقول نموذج القبول
export const ADMISSION_FIELDS = [
  { key: 'full_name', title: 'اسم الطالب الرباعي', required: true, type: 'text' },
  { key: 'gender', title: 'الجنس', required: true, type: 'choice', options: ['ذكر', 'أنثى'] },
  { key: 'birth_date', title: 'تاريخ الميلاد', required: true, type: 'date' },
  { key: 'phone', title: 'رقم هاتف للتواصل', required: true, type: 'text' },
  { key: 'email', title: 'البريد الإلكتروني (اختياري — لإبلاغكم بنتيجة الطلب)', required: false, type: 'text' },
  { key: 'guardian_name', title: 'اسم ولي الأمر', required: false, type: 'text' },
  { key: 'guardian_phone', title: 'هاتف ولي الأمر', required: false, type: 'text' },
  { key: 'address', title: 'العنوان', required: false, type: 'text' },
  { key: 'prior_parts', title: 'مقدار المحفوظ حاليًا (بالأجزاء، مثال: 2.5)', required: false, type: 'text' },
  { key: 'notes', title: 'ملاحظات إضافية', required: false, type: 'paragraph' },
];
export const SHEET_HEADER = ['وقت الإرسال', 'رقم الاستجابة', ...ADMISSION_FIELDS.map((f) => f.title), 'تنبيه تكرار'];

function questionFor(f) {
  if (f.type === 'choice') return { required: f.required, choiceQuestion: { type: 'RADIO', options: f.options.map((value) => ({ value })) } };
  if (f.type === 'date') return { required: f.required, dateQuestion: { includeYear: true, includeTime: false } };
  return { required: f.required, textQuestion: { paragraph: f.type === 'paragraph' } };
}

/** ينشئ Google Form + Google Sheet خاص للاستجابات. يعيد بيانات التخزين */
export async function createAdmissionForm({ title, description }) {
  const form = await gapi('POST', 'https://forms.googleapis.com/v1/forms', { info: { title, documentTitle: title } });
  const requests = [
    ...(description ? [{ updateFormInfo: { info: { description }, updateMask: 'description' } }] : []),
    ...ADMISSION_FIELDS.map((f, i) => ({
      createItem: { item: { title: f.title, questionItem: { question: questionFor(f) } }, location: { index: i } },
    })),
  ];
  const upd = await gapi('POST', `https://forms.googleapis.com/v1/forms/${form.formId}:batchUpdate`, { requests });
  const created = (upd.replies || []).filter((r) => r.createItem);
  const questionMap = {};
  created.forEach((r, i) => {
    const qid = r.createItem.questionId?.[0];
    if (qid) questionMap[qid] = ADMISSION_FIELDS[i].key;
  });

  // النماذج المنشأة عبر الـ API قد تكون غير منشورة افتراضيًا — ننشرها لتستقبل الاستجابات
  let publishWarning = null;
  try {
    await gapi('POST', `https://forms.googleapis.com/v1/forms/${form.formId}:setPublishSettings`, {
      publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } },
      updateMask: 'publishState',
    });
  } catch (e) {
    publishWarning = `تعذر نشر النموذج تلقائيًا (${e.message}). افتحه من رابط التحرير واضغط «نشر».`;
  }

  const sheet = await gapi('POST', 'https://sheets.googleapis.com/v4/spreadsheets', {
    properties: { title: `${title} — الاستجابات`, locale: 'ar' },
    sheets: [{ properties: { title: 'Responses', rightToLeft: true } }],
  });
  await gapi(
    'POST',
    `https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values/Responses!A1:append?valueInputOption=RAW`,
    { values: [SHEET_HEADER] }
  );

  return {
    google_form_id: form.formId,
    responder_url: form.responderUri || `https://docs.google.com/forms/d/${form.formId}/viewform`,
    edit_url: `https://docs.google.com/forms/d/${form.formId}/edit`,
    sheet_id: sheet.spreadsheetId,
    sheet_url: sheet.spreadsheetUrl,
    question_map: questionMap,
    publish_warning: publishWarning,
  };
}

/** كل الاستجابات منذ وقت معيّن (مع التصفح بين الصفحات) */
export async function listFormResponses(formId, since = null) {
  const out = [];
  let pageToken = null;
  for (let i = 0; i < 50; i++) {
    const p = new URLSearchParams({ pageSize: '500' });
    if (since) p.set('filter', `timestamp >= ${new Date(since).toISOString()}`);
    if (pageToken) p.set('pageToken', pageToken);
    const d = await gapi('GET', `https://forms.googleapis.com/v1/forms/${formId}/responses?${p}`);
    out.push(...(d.responses || []));
    pageToken = d.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export async function appendSheetRows(sheetId, rows) {
  if (!sheetId || !rows.length) return;
  await gapi('POST', `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Responses!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    values: rows,
  });
}
