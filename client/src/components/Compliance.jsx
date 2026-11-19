import { Link } from 'react-router-dom';
import { Badge, Empty } from './ui.jsx';
import { fmtDate, fmtDateTime } from '../lib/format.js';

export const REVIEW_STATUS = {
  ok: { label: 'مكتملة', tone: 'success' },
  violation: { label: 'مخالفة', tone: 'danger' },
  exempt: { label: 'معفاة', tone: 'muted' },
  excused: { label: 'عذر مقبول', tone: 'info' },
};
export const REVIEW_ACTION = { none: '—', reminder: 'تذكير', warning: 'تحذير رسمي' };

/** قائمة البنود الناقصة مع روابط مباشرة للطالب */
export function MissingItems({ items, linkStudents = true }) {
  if (!items?.length) return <p className="muted small">لا توجد بنود ناقصة. أحسنت!</p>;
  return (
    <ul className="list-plain missing-list">
      {items.map((it, i) => (
        <li key={`${it.type}-${it.appointment_id || it.student_id}-${i}`}>
          <span>
            <Badge tone={it.type === 'unresolved_appointment' ? 'warn' : 'danger'}>
              {it.type === 'unresolved_appointment' ? 'موعد بلا نتيجة' : 'لا يوجد تسميع'}
            </Badge>{' '}
            {linkStudents ? <Link to={`/students/${it.student_id}`}>{it.student_name}</Link> : it.student_name}
          </span>
          <span className="small muted">
            {it.type === 'unresolved_appointment' ? fmtDateTime(it.start_at) : `${it.records} من ${it.required} مطلوب`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** سجل فترات المتابعة */
export function ReviewHistory({ reviews, onExcuse }) {
  if (!reviews?.length) return <Empty icon="shield" title="لا توجد فترات مقيّمة بعد" hint="تُقيَّم كل فترة تلقائيًا بعد انتهاء مهلة التصحيح." />;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr><th>الفترة</th><th>النتيجة</th><th>البنود الناقصة</th><th>المخالفة</th><th>الإجراء</th><th>ملاحظة</th>{onExcuse && <th />}</tr>
        </thead>
        <tbody>
          {reviews.map((r) => (
            <tr key={r.id}>
              <td className="nowrap">{fmtDate(r.period_start)} — {fmtDate(r.period_end)}</td>
              <td><Badge tone={REVIEW_STATUS[r.status].tone}>{REVIEW_STATUS[r.status].label}</Badge></td>
              <td className="num">{r.missing_count || '—'}</td>
              <td className="num">{r.violation_number ? `#${r.violation_number}` : '—'}</td>
              <td>{REVIEW_ACTION[r.action] || '—'}</td>
              <td className="small muted">{r.excuse_reason || ''}</td>
              {onExcuse && (
                <td>{r.status === 'violation' && <button className="btn btn-sm btn-ghost" type="button" onClick={() => onExcuse(r)}>قبول عذر</button>}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** ملخص الفترة الحالية + فترة المهلة */
export function ComplianceNow({ data, linkStudents = true }) {
  if (!data) return null;
  if (!data.enabled) return <p className="muted">المتابعة الآلية معطلة حاليًا من الإعدادات.</p>;
  return (
    <div className="grid grid-2">
      <div>
        <h3 style={{ marginBottom: 6 }}>
          {data.grace ? 'الفترة السابقة — مهلة التصحيح جارية' : 'لا توجد فترة في مهلة التصحيح'}
        </h3>
        {data.grace ? (
          <>
            <p className="small muted" style={{ marginBottom: 8 }}>
              {fmtDate(data.grace.start)} — {fmtDate(data.grace.end)} • آخر موعد للاستكمال: <b>{fmtDateTime(data.grace.deadline)}</b>
            </p>
            <MissingItems items={data.grace.items} linkStudents={linkStudents} />
          </>
        ) : (
          <p className="small muted">تُقيَّم الفترات المنتهية تلقائيًا.</p>
        )}
      </div>
      <div>
        <h3 style={{ marginBottom: 6 }}>الفترة الحالية ({fmtDate(data.current.start)} — {fmtDate(data.current.end)})</h3>
        <p className="small muted" style={{ marginBottom: 8 }}>مواعيد انتهى وقتها ولم تُسجَّل نتيجتها بعد:</p>
        <MissingItems items={data.current.items} linkStudents={linkStudents} />
      </div>
    </div>
  );
}
