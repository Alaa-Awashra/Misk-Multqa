// يشغّل google-apps-script/Code.gs الحقيقي داخل Node (vm) مع بدائل لخدمات Apps Script،
// خلف خادم HTTP محلي — لاختبار المصادقة والحصة ومنع التكرار من الطرفين دون حساب Google.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CODE = fs.readFileSync(path.resolve(here, '../../google-apps-script/Code.gs'), 'utf8');

const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const fromSigned = (arr) => Buffer.from(arr.map((b) => b & 0xff));

export async function startFakeAppsScript({ secret, account = 'misk.quran26@gmail.com', quota = 100 } = {}) {
  const state = { secret, account, quota, sent: [], calls: 0, mailError: null, now: null };
  const cache = new Map();

  const sandbox = {
    console: { log() {}, error() {} },
    JSON,
    Math,
    String,
    Date: new Proxy(Date, { get: (t, k) => (k === 'now' ? () => state.now ?? t.now() : Reflect.get(t, k)) }),
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => (k === 'GAS_SHARED_SECRET' ? state.secret : null) }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => {
          const e = cache.get(k);
          return e && e.exp > Date.now() ? e.v : null;
        },
        put: (k, v, ttl) => cache.set(k, { v, exp: Date.now() + ttl * 1000 }),
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => state.account }) },
    MailApp: {
      getRemainingDailyQuota: () => state.quota,
      sendEmail: (o) => {
        if (state.mailError) throw new Error(state.mailError);
        state.quota -= 1;
        state.sent.push(o);
      },
    },
    Utilities: {
      computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', key).update(value, 'utf8').digest()),
      computeDigest: (_alg, value) => toSigned(crypto.createHash('sha256').update(value, 'utf8').digest()),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      base64Decode: (s) => toSigned(Buffer.from(s, 'base64')),
      base64EncodeWebSafe: (arr) => fromSigned(arr).toString('base64url'),
      newBlob: (arr) => ({ getDataAsString: () => fromSigned(arr).toString('utf8') }),
      getUuid: () => crypto.randomUUID(),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'Code.gs' });

  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      state.calls++;
      const out = req.method === 'POST' ? sandbox.doPost({ postData: { contents: data } }) : sandbox.doGet();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out.text);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/exec`,
    state,
    /** يرسل جسمًا خامًا (لاختبار رفض الطلبات المزوّرة) */
    async raw(body) {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/exec`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
      return r.json();
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
