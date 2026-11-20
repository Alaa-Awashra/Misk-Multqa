import { Component } from 'react';

/**
 * يلتقط أي خطأ أثناء عرض صفحة فيُظهر رسالة واضحة مع زر إعادة المحاولة
 * بدل أن تختفي الواجهة كلها (صفحة بيضاء). لا يُخفي الخطأ: يُسجَّل في الـ console.
 * يُعاد ضبطه تلقائيًا عند تغيّر resetKey (مثل الانتقال لصفحة أخرى).
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" role="alert" style={{ maxWidth: 560, margin: '40px auto', textAlign: 'center' }}>
        <h2 style={{ marginTop: 0 }}>حدث خطأ غير متوقع في هذه الصفحة</h2>
        <p className="muted">بياناتك محفوظة. جرّب إعادة عرض الصفحة، وإن تكرر الخطأ أعد تحميل المتصفح.</p>
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <button className="btn" type="button" onClick={() => this.setState({ error: null })}>إعادة المحاولة</button>
          <button className="btn btn-ghost" type="button" onClick={() => window.location.reload()}>إعادة تحميل الصفحة</button>
        </div>
      </div>
    );
  }
}
