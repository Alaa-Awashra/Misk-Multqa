import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../context/Auth.jsx';
import { BRAND } from '../lib/brand.js';
import { Icon, Spinner } from '../components/ui.jsx';

/** صفحة عامة: تُفتح من رابط التأكيد في البريد */
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const { user, refreshUser } = useAuth();
  const [state, setState] = useState({ loading: true });
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const token = params.get('token');
    if (!token) return setState({ error: 'الرابط غير مكتمل' });
    api
      .post('/auth/verify-email', { token })
      .then((r) => {
        setState({ ok: true, email: r.email });
        if (user) refreshUser().catch(() => {});
      })
      .catch((e) => setState({ error: e.message }));
  }, [params, user, refreshUser]);

  return (
    <div className="login-page">
      <div className="login-card card" style={{ textAlign: 'center' }}>
        <img src={BRAND.logo} alt="" style={{ width: 64, margin: '0 auto 10px' }} />
        <h1 style={{ marginBottom: 12 }}>تأكيد البريد الإلكتروني</h1>
        {state.loading && <Spinner label="جارٍ التأكيد…" />}
        {state.ok && (
          <div className="alert alert-success">
            <Icon name="check" /> تم تأكيد البريد <b dir="ltr">{state.email}</b> بنجاح. ستصلك إشعارات الإدارة عليه.
          </div>
        )}
        {state.error && <div className="alert alert-danger">{state.error}</div>}
        {!state.loading && (
          <Link className="btn" to={user ? '/' : '/login'} style={{ marginTop: 12 }}>
            {user ? 'العودة إلى المنصة' : 'تسجيل الدخول'}
          </Link>
        )}
      </div>
    </div>
  );
}
