import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth } from '../context/Auth.jsx';
import { useToast } from '../context/Toast.jsx';
import { useSummary } from '../context/Summary.jsx';
import { useLoad } from '../lib/hooks.js';
import { Alert, Badge, ConfirmDialog, Empty, Field, Icon, PageHeader, Spinner, Tabs } from '../components/ui.jsx';
import { REQUEST_KIND, REQUEST_STATUS } from '../lib/labels.js';
import { fmtDateTime, norm } from '../lib/format.js';

/** طلبات حذف/فصل الطلاب — المسؤول يبت فيها، والمشرف يتابع طلباته */
export default function Requests() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const { refresh } = useSummary();
  const [tab, setTab] = useState('pending');
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState(null); // { type: approve|reject|cancel, req }
  const [note, setNote] = useState('');
  const { data, loading, error, reload } = useLoad(() => api.get(`/student-requests${qs({})}`), []);

  const all = data?.requests || [];
  const rows = useMemo(
    () =>
      all
        .filter((r) => (tab === 'all' ? true : tab === 'decided' ? r.status !== 'pending' : r.status === 'pending'))
        .filter((r) => !q || norm(`${r.student_name} ${r.supervisor_name} ${r.reason}`).includes(norm(q))),
    [all, tab, q]
  );
  const pending = all.filter((r) => r.status === 'pending').length;

  const act = async () => {
    const { type, req } = dialog;
    if (type === 'cancel') await api.post(`/student-requests/${req.id}/cancel`);
    else await api.post(`/student-requests/${req.id}/${type}`, { note });
    toast.success(type === 'approve' ? 'تمت الموافقة وتنفيذ الطلب' : type === 'reject' ? 'تم رفض الطلب وإبلاغ المشرف' : 'تم سحب الطلب');
    setDialog(null);
    reload();
    refresh();
  };

  return (
    <>
      <PageHeader
        title={isAdmin ? 'طلبات المشرفين' : 'طلباتي للإدارة'}
        subtitle={
          isAdmin
            ? 'طلبات حذف أو فصل الطلاب المرسلة من المشرفين — لا يُنفذ أي طلب إلا بموافقتك'
            : 'حذف الطلاب أو فصلهم يتم بموافقة الإدارة. أرسل الطلب من صفحة الطالب وتابع حالته هنا.'
        }
      />
      <div className="toolbar">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'pending', label: 'بانتظار القرار', count: pending },
            { value: 'decided', label: 'تم النظر فيها' },
            { value: 'all', label: 'الكل' },
          ]}
        />
        <span className="spacer" />
        <div className="search">
          <Icon name="search" size={16} />
          <input className="input" placeholder="بحث بالطالب أو المشرف أو السبب" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث" />
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="card card-flush">
        {loading && !data ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <Empty
            icon="inbox"
            title={tab === 'pending' ? 'لا توجد طلبات بانتظار القرار' : 'لا توجد طلبات'}
            hint={isAdmin ? 'تظهر هنا طلبات المشرفين فور إرسالها، مع إشعار لك.' : 'لإرسال طلب: افتح صفحة الطالب ← «طلب حذف» أو «طلب فصل».'}
          />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>الطالب</th>
                  <th>النوع</th>
                  {isAdmin && <th>المشرف</th>}
                  <th>السبب</th>
                  <th>التاريخ</th>
                  <th>الحالة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.student_status === 'removed' && !isAdmin ? <b>{r.student_name}</b> : <Link to={`/students/${r.student_id}`}><b>{r.student_name}</b></Link>}
                    </td>
                    <td><Badge tone={r.kind === 'removal' ? 'danger' : 'warn'}>{REQUEST_KIND[r.kind]}</Badge></td>
                    {isAdmin && <td>{r.supervisor_name || r.requested_by_name || '—'}</td>}
                    <td style={{ maxWidth: 360 }}>
                      {r.reason}
                      {r.comments && <div className="muted small">{r.comments}</div>}
                      {r.decision_note && <div className="small" style={{ marginTop: 4 }}><b>رد الإدارة:</b> {r.decision_note}</div>}
                    </td>
                    <td className="small nowrap">
                      {fmtDateTime(r.created_at)}
                      {r.decided_at && <div className="muted">القرار: {fmtDateTime(r.decided_at)}{r.decided_by_name ? ` • ${r.decided_by_name}` : ''}</div>}
                    </td>
                    <td><Badge tone={REQUEST_STATUS[r.status].tone}>{REQUEST_STATUS[r.status].label}</Badge></td>
                    <td className="nowrap">
                      {r.status === 'pending' && isAdmin && (
                        <div className="row" style={{ gap: 6 }}>
                          <button className="btn btn-sm btn-success" type="button" onClick={() => { setNote(''); setDialog({ type: 'approve', req: r }); }}>موافقة</button>
                          <button className="btn btn-sm btn-ghost" type="button" onClick={() => { setNote(''); setDialog({ type: 'reject', req: r }); }}>رفض</button>
                        </div>
                      )}
                      {r.status === 'pending' && !isAdmin && (
                        <button className="btn btn-sm btn-ghost" type="button" onClick={() => setDialog({ type: 'cancel', req: r })}>سحب الطلب</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!dialog}
        onClose={() => setDialog(null)}
        onConfirm={act}
        tone={dialog?.type === 'approve' ? (dialog.req.kind === 'removal' ? 'danger' : 'warn') : 'primary'}
        title={
          dialog?.type === 'approve'
            ? `الموافقة على ${REQUEST_KIND[dialog.req.kind]} ${dialog.req.student_name}`
            : dialog?.type === 'reject'
              ? 'رفض الطلب'
              : 'سحب الطلب'
        }
        confirmText={dialog?.type === 'approve' ? 'موافقة وتنفيذ' : dialog?.type === 'reject' ? 'رفض' : 'سحب'}
      >
        {dialog?.type === 'approve' && (
          <Alert tone="info">
            {dialog.req.kind === 'removal'
              ? 'سيُخفى الطالب من القوائم وتُلغى مواعيده القادمة. تبقى كل سجلاته محفوظة ويمكن استعادته لاحقًا من صفحته.'
              : 'سيُفصل الطالب وتُلغى مواعيده القادمة. تبقى سجلاته محفوظة ويمكن إعادة تفعيله.'}
          </Alert>
        )}
        {dialog?.type !== 'cancel' && (
          <Field label={dialog?.type === 'reject' ? 'سبب الرفض (يصل للمشرف)' : 'ملاحظة للمشرف (اختياري)'}>
            {(id) => <textarea id={id} className="textarea" style={{ minHeight: 60 }} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />}
          </Field>
        )}
        {dialog?.type === 'cancel' && <p>سيُسحب طلبك ولن يظهر للإدارة كطلب معلّق.</p>}
      </ConfirmDialog>
    </>
  );
}
