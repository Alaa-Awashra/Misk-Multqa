import { api } from '../api.js';
import { useLoad } from '../lib/hooks.js';
import { Alert, Badge, Empty, PageHeader, ProgressBar, Spinner, StatCard } from '../components/ui.jsx';
import { ComplianceNow, ReviewHistory } from '../components/Compliance.jsx';
import { fmtDate, fmtDateTime } from '../lib/format.js';

/** سجل المشرف: تحذيراته الرسمية + متابعة اكتمال سجلات طلابه */
export default function MyRecord() {
  const { data, loading, error } = useLoad(() => api.get('/profile/record'), []);
  if (loading && !data) return <Spinner />;
  if (error) return <Alert tone="danger">{error}</Alert>;
  const { warnings, active_warnings: active, threshold, compliance } = data;
  const graceCount = compliance.grace?.items.length || 0;

  return (
    <>
      <PageHeader title="سجلي ومتابعتي" subtitle="التحذيرات الإدارية ومتابعة اكتمال سجلات طلابك" />

      {active > 0 && (
        <Alert tone={active >= threshold - 1 ? 'danger' : 'warn'}>
          لديك <b>{active}</b> تحذير رسمي ساري من أصل {threshold}. بلوغ {threshold} تحذيرات سارية يؤدي إلى إيقاف صلاحيات الإشراف تلقائيًا.
        </Alert>
      )}
      {graceCount > 0 && (
        <Alert tone="warn">
          لديك <b>{graceCount}</b> بند ناقص يجب استكماله قبل <b>{fmtDateTime(compliance.grace.deadline)}</b> لتجنب احتساب مخالفة.
        </Alert>
      )}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard label="التحذيرات السارية" value={`${active} من ${threshold}`} icon="alert" tone={active ? 'danger' : 'success'} />
        <StatCard label="مخالفات الفترة الأخيرة" value={compliance.violations_in_window} icon="shield" tone={compliance.violations_in_window ? 'warn' : 'success'} hint={`خلال ${compliance.config.lookbackDays} يومًا`} />
        <StatCard label="بنود بحاجة لاستكمال" value={graceCount + compliance.current.items.length} icon="clipboard" tone={graceCount ? 'danger' : 'primary'} />
        <StatCard label="فترة الإبلاغ" value={`${compliance.config.periodDays} أيام`} icon="calendar" tone="info" hint={`مهلة التصحيح ${compliance.config.graceDays} يوم`} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h2>متابعة اكتمال السجلات</h2></div>
        <ComplianceNow data={compliance} />
        <details style={{ marginTop: 14 }}>
          <summary className="small">كيف تعمل المتابعة؟</summary>
          <ul className="small muted" style={{ marginTop: 8 }}>
            <li>في كل فترة يجب تسجيل نتيجة كل موعد بعد وقته (تم / لم يلتزم).</li>
            <li>ويجب أن يكون لكل طالب نشط {compliance.config.minRecords} تسميع مسجّل على الأقل في الفترة.</li>
            <li>بعد نهاية الفترة لديك {compliance.config.graceDays} يوم لاستكمال الناقص.</li>
            <li>المخالفة الأولى تذكير، ومن المخالفة رقم {compliance.config.warningAfter} يصدر تحذير رسمي.</li>
            <li>الإجازات المعتمدة والطلاب الجدد لا يُحتسبون.</li>
          </ul>
        </details>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h2>التحذيرات الإدارية</h2></div>
        {warnings.length === 0 ? (
          <Empty icon="check" title="لا توجد تحذيرات" hint="سجلك نظيف — بارك الله فيك." />
        ) : (
          <ul className="list-plain">
            {warnings.map((w) => (
              <li key={w.id} style={{ alignItems: 'flex-start' }}>
                <div>
                  <b>{w.reason}</b>
                  {w.notes && <div className="small muted" style={{ whiteSpace: 'pre-line' }}>{w.notes}</div>}
                  <div className="small muted">{fmtDateTime(w.created_at)} • {w.issued_by_name}{w.source === 'compliance' ? ' (متابعة آلية)' : ''}</div>
                  {w.status === 'revoked' && <div className="small">أُلغي في {fmtDate(w.revoked_at)}{w.revoke_reason ? ` — ${w.revoke_reason}` : ''}</div>}
                </div>
                <Badge tone={w.status === 'active' ? 'danger' : 'muted'}>{w.status === 'active' ? 'ساري' : 'ملغى'}</Badge>
              </li>
            ))}
          </ul>
        )}
        <div style={{ marginTop: 12 }}>
          <ProgressBar value={(active / threshold) * 100} tone={active ? 'danger' : 'success'} />
        </div>
      </div>

      <div className="card card-flush">
        <div className="card-head" style={{ padding: '18px 20px 0' }}><h2>سجل الفترات</h2></div>
        <ReviewHistory reviews={compliance.reviews} />
      </div>
    </>
  );
}
