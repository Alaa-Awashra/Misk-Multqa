import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth } from '../context/Auth.jsx';
import { useToast } from '../context/Toast.jsx';
import { useLoad } from '../lib/hooks.js';
import { Alert, Badge, ConfirmDialog, Field, Icon, PageHeader, Spinner, Tabs } from '../components/ui.jsx';
import { EMAIL_STATUS } from '../lib/labels.js';
import { fmtDateTime } from '../lib/format.js';

function GeneralSettings() {
  const { settings, reloadSettings } = useAuth();
  const toast = useToast();
  const [f, setF] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setF(settings), [settings]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.put('/settings', f);
      await reloadSettings();
      toast.success('تم حفظ الإعدادات');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const num = (k, props = {}) => (id) => <input id={id} className="input" type="number" value={f[k] ?? ''} onChange={set(k)} required {...props} />;
  const date = (k) => (id) => <input id={id} className="input" type="date" value={f[k] || ''} onChange={set(k)} required />;

  return (
    <form onSubmit={save} className="stack" style={{ maxWidth: 860 }}>
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>قواعد «تحت التحذير» للطلاب</h2>
        <p className="muted small" style={{ marginBottom: 14 }}>يُحتسب الطالب تحت التحذير تلقائيًا عند تحقق أي شرط من الشرطين:</p>
        <div className="form-grid">
          <Field label="عدد مرات عدم الالتزام خلال 30 يومًا" hint="عند بلوغ هذا العدد يصبح الطالب تحت التحذير">{num('warning_missed_threshold', { min: 1, max: 30 })}</Field>
          <Field label="عدد أيام الانقطاع عن التسميع" hint="بدون أي تسميع مكتمل لهذه المدة">{num('warning_inactive_days', { min: 1, max: 365 })}</Field>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 14 }}>الحجز والمواعيد</h2>
        <div className="form-grid">
          <Field label="بداية الدوام" hint="لا يُسمح بحجز مواعيد قبل هذا الوقت">{(id) => <input id={id} className="input" type="time" value={f.work_start} onChange={set('work_start')} required />}</Field>
          <Field label="نهاية الدوام" hint="يجب أن ينتهي الموعد قبل هذا الوقت">{(id) => <input id={id} className="input" type="time" value={f.work_end} onChange={set('work_end')} required />}</Field>
          <Field label="مدة التسميع الافتراضية (دقيقة)">{num('recitation_minutes', { min: 5, max: 240, step: 5 })}</Field>
          <Field label="مدة الامتحان الافتراضية (دقيقة)">{num('exam_minutes', { min: 5, max: 240, step: 5 })}</Field>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 14 }}>الحفظ والامتحانات</h2>
        <div className="form-grid">
          <Field label="علامة النجاح في امتحان السورة (من 100)">{num('exam_pass_grade', { min: 0, max: 100, step: 0.5 })}</Field>
          <Field label="عدد صفحات الجزء الواحد" hint="يُستخدم لتحويل الصفحات المسمّعة إلى أجزاء (مصحف المدينة: 20)">{num('juz_pages', { min: 1, max: 100 })}</Field>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>التحذيرات الرسمية للمشرفين</h2>
        <p className="muted small" style={{ marginBottom: 14 }}>عند بلوغ هذا العدد من التحذيرات السارية تُوقف صلاحيات المشرف تلقائيًا ويُبلَّغ هو والإدارة.</p>
        <div className="form-grid">
          <Field label="عدد التحذيرات الموجب للإيقاف">{num('supervisor_dismissal_warnings', { min: 1, max: 10 })}</Field>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>متابعة اكتمال السجلات آليًا</h2>
        <p className="muted small" style={{ marginBottom: 14 }}>
          في كل فترة: يجب تسجيل نتيجة كل موعد بعد وقته، وأن يكون لكل طالب نشط عدد أدنى من التسميعات. تُقيَّم كل فترة مرة واحدة بعد انتهاء مهلة التصحيح.
        </p>
        <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" checked={f.compliance_enabled !== false} onChange={set('compliance_enabled')} /> تفعيل المتابعة الآلية</label>
        <div className="form-grid">
          <Field label="طول فترة الإبلاغ (أيام)" hint="7 = أسبوعية">{num('compliance_period_days', { min: 1, max: 31 })}</Field>
          <Field label="تاريخ بداية أول فترة" hint="تبدأ الفترات من هذا التاريخ وتتكرر">{date('compliance_anchor_date')}</Field>
          <Field label="مهلة التصحيح (أيام بعد نهاية الفترة)">{num('compliance_grace_days', { min: 0, max: 14 })}</Field>
          <Field label="الحد الأدنى للتسميعات المسجلة لكل طالب في الفترة" hint="0 = متابعة نتائج المواعيد فقط">{num('compliance_min_records', { min: 0, max: 14 })}</Field>
          <Field label="المخالفة التي يبدأ عندها التحذير الرسمي" hint="2 = الأولى تذكير، والثانية تحذير، والثالثة تحذير ثانٍ (إيقاف)">{num('compliance_warning_after', { min: 1, max: 10 })}</Field>
          <Field label="نافذة احتساب المخالفات (أيام)" hint="المخالفات الأقدم لا تُحتسب في التصعيد">{num('compliance_lookback_days', { min: 14, max: 365 })}</Field>
          <Field label="لا تُقيَّم الفترات قبل" hint="يمنع العقوبات بأثر رجعي">{date('compliance_start_date')}</Field>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 14 }}>التقرير الدوري للأداء</h2>
        <div className="form-grid">
          <Field label="طول فترة التقرير (أيام)" hint="الافتراضي 14 يومًا">{num('report_period_days', { min: 7, max: 31 })}</Field>
          <Field label="تاريخ بداية أول فترة تقرير">{date('report_anchor_date')}</Field>
        </div>
      </div>

      <div><button className="btn" disabled={busy} type="submit">{busy ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}</button></div>
    </form>
  );
}

function Integrations() {
  const toast = useToast();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [emailFilter, setEmailFilter] = useState('');
  const { data: email, reload: reloadEmail } = useLoad(() => api.get(`/email/status${qs({ status: emailFilter })}`), [emailFilter]);
  const { data: google, reload: reloadGoogle } = useLoad(() => api.get('/google/status'), []);
  const [testTo, setTestTo] = useState(user.email || 'misk.quran26@gmail.com');
  const [busy, setBusy] = useState(false);
  const [disc, setDisc] = useState(false);

  useEffect(() => {
    const g = params.get('google');
    if (g === 'connected') toast.success('تم ربط حساب Google بنجاح');
    if (g === 'error') toast.error(`تعذر ربط Google: ${params.get('message') || ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendTest = async () => {
    setBusy(true);
    try {
      const r = await api.post('/email/test', { to: testTo });
      if (r.sent) toast.success('أُرسلت الرسالة التجريبية بنجاح عبر Resend');
      else toast.error('لم تُرسل — راجع سجل البريد أدناه لمعرفة السبب');
      reloadEmail();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const cfg = email?.config;
  return (
    <div className="stack" style={{ maxWidth: 1000 }}>
      <div className="card">
        <div className="card-head">
          <h2><Icon name="mail" size={17} /> البريد الإلكتروني (Resend)</h2>
          {cfg && (cfg.operational ? <Badge tone="success">يعمل</Badge> : <Badge tone="danger">غير مُفعّل</Badge>)}
        </div>
        {!cfg ? <Spinner /> : (
          <>
            {!cfg.operational ? (
              <Alert tone="warn">
                <b>إرسال البريد غير مُفعّل — كل الإشعارات تظهر داخل المنصة فقط.</b>
                <ul style={{ margin: '6px 0 0' }}>{cfg.problems.map((p) => <li key={p}>{p}</li>)}</ul>
                <div className="small" style={{ marginTop: 6 }}>خطوات الإعداد في ملف README (قسم «إعداد Resend»): توثيق نطاق في Resend (SPF/DKIM/DMARC) ثم ضبط المتغيرات على Render.</div>
              </Alert>
            ) : (
              <p className="small muted">المرسل: <span dir="ltr">{cfg.from}</span> • الرد إلى: <span dir="ltr">{cfg.reply_to}</span></p>
            )}
            <div className="row" style={{ margin: '10px 0' }}>
              <input className="input ltr" style={{ maxWidth: 300 }} type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="بريد الاختبار" />
              <button className="btn btn-secondary" type="button" onClick={sendTest} disabled={busy || !cfg.operational}>{busy ? 'جارٍ الإرسال…' : 'إرسال رسالة تجريبية'}</button>
            </div>
            <div className="row small" style={{ marginBottom: 8 }}>
              {Object.entries(EMAIL_STATUS).map(([k, v]) => (
                <button key={k} type="button" className={`btn btn-sm ${emailFilter === k ? '' : 'btn-ghost'}`} onClick={() => setEmailFilter(emailFilter === k ? '' : k)}>
                  {v.label}: {email.stats[k] || 0}
                </button>
              ))}
            </div>
            <div className="table-wrap" style={{ maxHeight: 380, overflow: 'auto' }}>
              <table className="tbl small">
                <thead><tr><th>المستلم</th><th>الموضوع</th><th>الحالة</th><th>المحاولات</th><th>الوقت</th><th /></tr></thead>
                <tbody>
                  {email.emails.map((e) => (
                    <tr key={e.id}>
                      <td>{e.full_name || ''} <div className="muted" dir="ltr">{e.to_email}</div></td>
                      <td>{e.subject}</td>
                      <td><Badge tone={EMAIL_STATUS[e.status].tone}>{EMAIL_STATUS[e.status].label}</Badge>{e.last_error && <div className="muted">{e.last_error.slice(0, 120)}</div>}</td>
                      <td className="num">{e.attempts}</td>
                      <td className="nowrap">{fmtDateTime(e.sent_at || e.created_at)}</td>
                      <td>{e.status === 'failed' && cfg.operational && <button className="btn btn-sm btn-ghost" type="button" onClick={async () => { await api.post(`/email/${e.id}/retry`); toast.success('أُعيدت للمحاولة'); reloadEmail(); }}>إعادة</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2><Icon name="link" size={17} /> Google Forms و Google Sheets</h2>
          {google && (google.connected ? <Badge tone="success">مربوط</Badge> : <Badge tone="muted">غير مربوط</Badge>)}
        </div>
        {!google ? <Spinner /> : !google.configured ? (
          <Alert tone="warn">لم تُضبط GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET على الخادم. راجع README (قسم «إعداد Google») لإنشاء OAuth Client مجاني في Google Cloud.</Alert>
        ) : google.connected ? (
          <div className="row">
            <span>مربوط بحساب <b dir="ltr">{google.account || 'غير معروف'}</b> منذ {fmtDateTime(google.connected_at)}</span>
            <span className="spacer" />
            <a className="btn btn-sm btn-ghost" href="/api/google/oauth/start">إعادة الربط</a>
            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} type="button" onClick={() => setDisc(true)}>فصل</button>
          </div>
        ) : (
          <>
            <p className="small muted" style={{ marginBottom: 10 }}>سجّل الدخول بحساب Google الخاص بالملتقى (misk.quran26@gmail.com) ووافق على الصلاحيات. تُنشأ النماذج والجداول في Drive هذا الحساب وتبقى الجداول خاصة.</p>
            <a className="btn" href="/api/google/oauth/start"><Icon name="link" /> ربط حساب Google</a>
          </>
        )}
      </div>

      <ConfirmDialog open={disc} onClose={() => setDisc(false)} title="فصل حساب Google" confirmText="فصل"
        onConfirm={async () => { await api.post('/google/disconnect'); toast.success('تم الفصل'); setDisc(false); reloadGoogle(); }}>
        ستتوقف مزامنة نماذج التسجيل حتى تعيد الربط. الطلبات المستوردة تبقى محفوظة.
      </ConfirmDialog>
    </div>
  );
}

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'general';
  return (
    <>
      <PageHeader title="الإعدادات" subtitle="القواعد والمتابعة والتكاملات الخارجية" />
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ value: 'general', label: 'القواعد والإعدادات' }, { value: 'integrations', label: 'التكاملات (البريد و Google)' }]} />
      {tab === 'general' ? <GeneralSettings /> : <Integrations />}
    </>
  );
}
