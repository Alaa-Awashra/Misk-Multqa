import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../context/Toast.jsx';
import { useLoad } from '../lib/hooks.js';
import { Alert, Badge, ConfirmDialog, Dropdown, Empty, Field, Icon, Modal, PageHeader, Spinner, Tabs } from '../components/ui.jsx';
import { REVIEW_ACTION, REVIEW_STATUS, MissingItems } from '../components/Compliance.jsx';
import { fmtDate, fmtDateTime } from '../lib/format.js';

const EMPTY_EX = { supervisor_id: '', kind: 'leave', start_date: '', end_date: '', reason: '' };

/** متابعة اكتمال سجلات المشرفين (للمسؤول) */
export default function Compliance() {
  const toast = useToast();
  const [tab, setTab] = useState('supervisors');
  const { data, loading, error, reload } = useLoad(() => api.get('/compliance/overview'), []);
  const [excuse, setExcuse] = useState(null);
  const [reason, setReason] = useState('');
  const [exForm, setExForm] = useState(null);
  const [exBusy, setExBusy] = useState(false);
  const [exErr, setExErr] = useState('');
  const [detail, setDetail] = useState(null);
  const [running, setRunning] = useState(false);

  if (loading && !data) return <Spinner />;
  if (error) return <Alert tone="danger">{error}</Alert>;
  const { config: cfg, supervisors, reviews, exemptions, runs, grace } = data;

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await api.post('/compliance/run');
      const c = r.results?.compliance?.result || {};
      toast.success(c.skipped ? 'المتابعة معطلة من الإعدادات' : `تم الفحص: ${c.evaluated || 0} تقييم جديد، ${c.violations || 0} مخالفة`);
      reload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRunning(false);
    }
  };

  const saveExemption = async (e) => {
    e.preventDefault();
    setExBusy(true);
    setExErr('');
    try {
      await api.post('/compliance/exemptions', exForm);
      toast.success('تمت الإضافة');
      setExForm(null);
      reload();
    } catch (err) {
      setExErr(err.message);
    } finally {
      setExBusy(false);
    }
  };

  const openReview = async (id) => {
    try {
      setDetail((await api.get(`/compliance/reviews/${id}`)).review);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <>
      <PageHeader
        title="متابعة اكتمال السجلات"
        subtitle={`فترة الإبلاغ ${cfg.periodDays} أيام • مهلة التصحيح ${cfg.graceDays} يوم • التحذير يبدأ من المخالفة رقم ${cfg.warningAfter}`}
        actions={
          <>
            <button className="btn" type="button" onClick={runNow} disabled={running}><Icon name="refresh" /> {running ? 'جارٍ الفحص…' : 'فحص الآن'}</button>
            <button className="btn btn-secondary" type="button" onClick={() => { setExErr(''); setExForm(EMPTY_EX); }}><Icon name="plus" /> إجازة / إعفاء</button>
            <Link className="btn btn-ghost" to="/settings">الإعدادات</Link>
          </>
        }
      />
      {!cfg.enabled && <Alert tone="warn">المتابعة الآلية معطلة من الإعدادات — لن تُقيَّم أي فترة.</Alert>}
      {cfg.startDate && <p className="small muted" style={{ marginTop: -8, marginBottom: 12 }}>لا تُقيَّم الفترات قبل {fmtDate(cfg.startDate)} (لا عقوبات بأثر رجعي).</p>}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'supervisors', label: 'المشرفون' },
          { value: 'reviews', label: 'المخالفات', count: reviews.filter((r) => r.status === 'violation').length },
          { value: 'exemptions', label: 'الإجازات والإعفاءات', count: exemptions.length },
          { value: 'runs', label: 'سجل التشغيل' },
        ]}
      />

      {tab === 'supervisors' && (
        <div className="card card-flush">
          <div className="table-wrap">
            <table className="tbl tbl-center">
              <thead>
                <tr><th>المشرف</th><th>الحالة</th><th>مواعيد بلا نتيجة</th>{grace && <th>ناقص في فترة المهلة</th>}<th>مخالفات ({cfg.lookbackDays} يومًا)</th><th>تحذيرات سارية</th></tr>
              </thead>
              <tbody>
                {supervisors.map((s) => (
                  <tr key={s.id}>
                    <td><Link to={`/supervisors/${s.id}`}><b>{s.full_name}</b></Link></td>
                    <td>{s.status === 'active' ? <Badge tone="success">نشط</Badge> : <Badge tone="danger">موقوف</Badge>}</td>
                    <td className="num">{s.unresolved ? <Badge tone="warn">{s.unresolved}</Badge> : '0'}</td>
                    {grace && <td className="num">{s.grace_missing === null ? '—' : s.grace_missing ? <Badge tone="danger">{s.grace_missing}</Badge> : '0'}</td>}
                    <td className="num">{s.violations}</td>
                    <td className="num">{s.active_warnings ? <Badge tone="danger">{s.active_warnings}</Badge> : '0'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {grace && <p className="small muted" style={{ padding: '10px 20px' }}>فترة المهلة: {fmtDate(grace.start)} — {fmtDate(grace.end)} وتنتهي {fmtDateTime(grace.deadline)}</p>}
        </div>
      )}

      {tab === 'reviews' && (
        <div className="card card-flush">
          {reviews.length === 0 ? (
            <Empty icon="check" title="لا توجد مخالفات" />
          ) : (
            <div className="table-wrap">
              <table className="tbl tbl-center tbl-click">
                <thead><tr><th>المشرف</th><th>الفترة</th><th>البنود</th><th>رقم المخالفة</th><th>الإجراء</th><th>الحالة</th><th /></tr></thead>
                <tbody>
                  {reviews.map((r) => (
                    <tr key={r.id} onClick={() => openReview(r.id)}>
                      <td><b>{r.full_name}</b></td>
                      <td className="nowrap small">{fmtDate(r.period_start)} — {fmtDate(r.period_end)}</td>
                      <td className="num">{r.missing_count}</td>
                      <td className="num">#{r.violation_number}</td>
                      <td>{REVIEW_ACTION[r.action]}</td>
                      <td><Badge tone={REVIEW_STATUS[r.status].tone}>{REVIEW_STATUS[r.status].label}</Badge>{r.excuse_reason && <div className="small muted">{r.excuse_reason}</div>}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {r.status === 'violation' && (
                          <button className="btn btn-sm btn-ghost" type="button" onClick={() => { setReason(''); setExcuse(r); }}>قبول عذر</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'exemptions' && (
        <div className="card">
          {exemptions.length === 0 ? (
            <Empty icon="calendar" title="لا توجد إجازات أو إعفاءات" hint="الإجازة تخص مشرفًا محددًا؛ الإعفاء العام يشمل كل المشرفين (مثل العطل الرسمية)." />
          ) : (
            <ul className="list-plain">
              {exemptions.map((x) => (
                <li key={x.id}>
                  <div>
                    <Badge tone={x.kind === 'leave' ? 'info' : 'muted'}>{x.kind === 'leave' ? 'إجازة' : 'إعفاء'}</Badge>{' '}
                    <b>{x.supervisor_name || 'كل المشرفين'}</b> — {fmtDate(x.start_date)} إلى {fmtDate(x.end_date)}
                    <div className="small muted">{x.reason}</div>
                  </div>
                  <button className="icon-btn" type="button" title="حذف" onClick={async () => { await api.del(`/compliance/exemptions/${x.id}`); toast.success('تم الحذف'); reload(); }}>
                    <Icon name="trash" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'runs' && (
        <div className="card">
          <p className="small muted" style={{ marginBottom: 10 }}>
            تعمل المهام عبر Supabase Cron (موثوق حتى عند نوم الخادم المجاني) وأيضًا أثناء نشاط الخادم. كل تشغيل يُكمل ما فات ولا يكرر شيئًا.
          </p>
          {runs.length === 0 ? <p className="muted">لم تُشغَّل أي مهمة بعد.</p> : (
            <ul className="list-plain">
              {runs.map((r) => (
                <li key={r.id}>
                  <span><b>{r.job}</b> <span className="muted small">({r.trigger})</span></span>
                  <span className="small">{fmtDateTime(r.started_at)} {r.ok === false ? <Badge tone="danger">فشل</Badge> : r.ok ? <Badge tone="success">نجح</Badge> : <Badge tone="info">جارٍ</Badge>}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog open={!!excuse} onClose={() => setExcuse(null)} tone="primary" title="قبول عذر المخالفة" confirmText="قبول العذر" disabled={!reason.trim()}
        onConfirm={async () => {
          const r = await api.post(`/compliance/reviews/${excuse.id}/excuse`, { reason });
          toast.success(r.warning_revoked ? 'قُبل العذر وأُلغي التحذير المرتبط' : 'قُبل العذر');
          setExcuse(null);
          reload();
        }}>
        <p>لن تُحتسب هذه المخالفة، {excuse?.action === 'warning' ? 'وسيُلغى التحذير الرسمي المرتبط بها.' : ''}</p>
        <Field label="سبب قبول العذر" required>{(id) => <textarea id={id} className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>

      <Modal open={!!exForm} onClose={() => setExForm(null)} title="إضافة إجازة أو إعفاء" persistent={exBusy}
        footer={<><button className="btn" form="ex-form" type="submit" disabled={exBusy}>{exBusy ? 'جارٍ الحفظ…' : 'حفظ'}</button><button className="btn btn-ghost" type="button" onClick={() => setExForm(null)}>إلغاء</button></>}>
        {exForm && (
          <form id="ex-form" onSubmit={saveExemption}>
            {exErr && <Alert tone="danger">{exErr}</Alert>}
            <div className="form-grid">
              <Field label="النوع" required>
                {(id) => (
                  <Dropdown block id={id} value={exForm.kind} onChange={(v) => setExForm({ ...exForm, kind: v })}
                    options={[{ value: 'leave', label: 'إجازة معتمدة لمشرف' }, { value: 'exempt', label: 'فترة معفاة' }]} />
                )}
              </Field>
              <Field label="المشرف" required={exForm.kind === 'leave'} hint={exForm.kind === 'exempt' ? 'اتركه فارغًا ليشمل كل المشرفين' : undefined}>
                {(id) => (
                  <Dropdown block id={id} required={exForm.kind === 'leave'} value={exForm.supervisor_id} onChange={(v) => setExForm({ ...exForm, supervisor_id: v })}
                    options={[{ value: '', label: exForm.kind === 'exempt' ? 'كل المشرفين' : '— اختر —' }, ...supervisors.map((s) => ({ value: s.id, label: s.full_name }))]} />
                )}
              </Field>
              <Field label="من تاريخ" required>{(id) => <input id={id} type="date" className="input" value={exForm.start_date} onChange={(e) => setExForm({ ...exForm, start_date: e.target.value })} required />}</Field>
              <Field label="إلى تاريخ" required>{(id) => <input id={id} type="date" className="input" value={exForm.end_date} min={exForm.start_date} onChange={(e) => setExForm({ ...exForm, end_date: e.target.value })} required />}</Field>
              <Field label="السبب" required className="full">{(id) => <input id={id} className="input" value={exForm.reason} onChange={(e) => setExForm({ ...exForm, reason: e.target.value })} required maxLength={500} />}</Field>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={!!detail} onClose={() => setDetail(null)} title="تفاصيل المخالفة">
        {detail && (
          <>
            <p className="small muted" style={{ marginBottom: 10 }}>الفترة {fmtDate(detail.period_start)} — {fmtDate(detail.period_end)} • انتهت المهلة {fmtDateTime(detail.deadline_at)}</p>
            <MissingItems items={detail.missing} />
          </>
        )}
      </Modal>
    </>
  );
}
