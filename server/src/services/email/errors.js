/** خطأ إرسال بريد. retryable = يُعاد إرساله تلقائيًا لاحقًا؛ retryAfterMs = أقل مهلة قبل المحاولة التالية */
export class EmailSendError extends Error {
  constructor(message, { retryable = false, retryAfterMs = null, status = null, code = null } = {}) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
    this.code = code;
  }
}
