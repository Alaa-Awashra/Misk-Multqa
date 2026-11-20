import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { query } from './db.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler, notFoundApi } from './middleware/errors.js';
import { csrfOriginCheck, enforceHttps, permissionsPolicy, noStoreApi } from './middleware/security.js';

import authRoutes from './routes/auth.js';
import cronRoutes from './routes/cron.js';
import profileRoutes from './routes/profile.js';
import settingsRoutes from './routes/settings.js';
import activityRoutes from './routes/activity.js';
import supervisorRoutes from './routes/supervisors.js';
import studentRoutes from './routes/students.js';
import studentRequestRoutes from './routes/studentRequests.js';
import appointmentRoutes from './routes/appointments.js';
import dashboardRoutes from './routes/dashboard.js';
import reportRoutes from './routes/reports.js';
import analyticsRoutes from './routes/analytics.js';
import complianceRoutes from './routes/compliance.js';
import messageRoutes from './routes/messages.js';
import announcementRoutes from './routes/announcements.js';
import notificationRoutes from './routes/notifications.js';
import admissionRoutes from './routes/admissions.js';
import staffRoutes from './routes/staff.js';
import googleRoutes from './routes/google.js';
import emailRoutes from './routes/email.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');

export const app = express();
app.set('trust proxy', 1); // Render يعمل خلف proxy
app.disable('x-powered-by');
app.use(enforceHttps);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
  })
);
app.use(permissionsPolicy);
app.use(compression());
if (config.clientOrigin) app.use(cors({ origin: config.clientOrigin.split(','), credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
// كل مسارات الـ API: لا تخزين مؤقت للبيانات الخاصة + رفض الطلبات المعدِّلة القادمة من مواقع أخرى (CSRF)
app.use('/api', noStoreApi, csrfOriginCheck);

// ---------------------------------------------------------------- API
app.get('/api/health', async (req, res) => {
  try {
    await query('select 1');
    res.json({ status: 'ok', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'db_unavailable' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/cron', cronRoutes); // محمي بـ CRON_SECRET وليس بجلسة مستخدم
app.use('/api', authenticate);
app.use('/api/profile', profileRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/supervisors', supervisorRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/student-requests', studentRequestRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admissions', admissionRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/google', googleRoutes);
app.use('/api/email', emailRoutes);
app.use('/api', notFoundApi);

// ---------------------------------------------------------------- الواجهة (React) في الإنتاج
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use(errorHandler);
