/** تنزيل CSV يفتح بشكل صحيح في Excel مع العربية (UTF-8 BOM) */
export function downloadCsv(filename, headers, rows) {
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    // منع حقن الصيغ في Excel (بيانات المتقدمين تأتي من نموذج عام): خلية تبدأ بـ = أو @ أو tab،
    // أو بـ + / - متبوعة بغير الأرقام، تُسبق بـ ' فتُعرض كنص. أرقام الهواتف مثل +970… لا تتأثر.
    if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-][\d\s().-]*$/.test(s))) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers, ...rows].map((r) => r.map(esc).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
