import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from './Auth.jsx';

// عدّادات الإشعارات والرسائل والإعلانات — استطلاع خفيف كل 30 ثانية (متوافق مع الاستضافة المجانية)
// يتوقف عند إخفاء التبويب ويتحدّث فور العودة إليه.
const Ctx = createContext({ summary: {}, refresh: () => {} });
const EMPTY = { notifications: 0, messages: 0, announcements: 0, requests: 0, applications: 0 };

export function SummaryProvider({ children }) {
  const { user } = useAuth();
  const [summary, setSummary] = useState(EMPTY);
  const timer = useRef(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      setSummary(await api.get('/notifications/summary'));
    } catch {
      /* تجاهل — المحاولة التالية بعد قليل */
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      setSummary(EMPTY);
      return undefined;
    }
    refresh();
    const start = () => {
      clearInterval(timer.current);
      timer.current = setInterval(refresh, 30_000);
    };
    const onVis = () => {
      if (document.hidden) clearInterval(timer.current);
      else {
        refresh();
        start();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(timer.current);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [user, refresh]);

  return <Ctx.Provider value={{ summary, refresh }}>{children}</Ctx.Provider>;
}

export const useSummary = () => useContext(Ctx);
