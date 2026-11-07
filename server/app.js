import express from 'express';
import { PUBLIC_DIR, STAGES, QUALITIES, MANUAL_TYPES, TYPE_LABELS, TZ, TOUCH_TYPES, LINKEDIN_TYPES, MEETING_STATUSES, LINK_KINDS, DEFAULT_WEEKLY_MEETING_TARGET, LEAD_CATEGORIES, TIERS, OUTREACH_STATUSES, CHANNELS } from './config.js';
import { attachUser, authRoutes, requireAuth } from './auth.js';
import { leadsRoutes } from './routes/leads.js';
import { activityRoutes } from './routes/activity.js';
import { teamRoutes } from './routes/team.js';
import { importRoutes } from './routes/import.js';
import { meetingsRoutes } from './routes/meetings.js';
import { kpiRoutes } from './routes/kpi.js';
import { tasksRoutes } from './routes/tasks.js';
import { planRoutes } from './routes/plan.js';
import { playbookRoutes } from './routes/playbook.js';
import { reportRoutes } from './routes/reports.js';
import { targetsRoutes } from './routes/targets.js';
import { RANGES } from './lib/range.js';

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.get('/healthz', (_req, res) => { db.prepare('SELECT 1').get(); res.type('text').send('ok'); }); // for the host's health check
  app.use(express.json({ limit: '50mb' }));
  app.use(attachUser(db));
  // One line per API call in the server log (who, what, result). No query strings or bodies, so no secrets are written.
  if (!process.env.NODE_TEST_CONTEXT && !process.env.NO_ACCESS_LOG) {
    app.use('/api', (req, res, next) => {
      const t = Date.now();
      res.on('finish', () => {
        if (req.method === 'GET' && res.statusCode < 400 && !/^\/(login|me)/.test(req.path)) return; // keep reads quiet, always show writes, logins and errors
        console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${Date.now() - t}ms ${req.user ? 'user=' + req.user.email : 'anon'}`);
      });
      next();
    });
  }

  app.use('/api', authRoutes(db));
  app.get('/api/config', requireAuth, (_req, res) =>
    res.json({ stages: STAGES, qualities: QUALITIES, manualTypes: MANUAL_TYPES, typeLabels: TYPE_LABELS, ranges: RANGES, tz: TZ, touchTypes: TOUCH_TYPES, linkedinTypes: LINKEDIN_TYPES, meetingStatuses: MEETING_STATUSES, linkKinds: LINK_KINDS, defaultTarget: DEFAULT_WEEKLY_MEETING_TARGET, leadCategories: LEAD_CATEGORIES, tiers: TIERS, outreachStatuses: OUTREACH_STATUSES, channels: CHANNELS })
  );
  app.use('/api/leads', requireAuth, leadsRoutes(db));
  app.use('/api/activity', requireAuth, activityRoutes(db));
  app.use('/api/meetings', requireAuth, meetingsRoutes(db));
  app.use('/api/tasks', requireAuth, tasksRoutes(db));
  app.use('/api/plan', requireAuth, planRoutes(db));
  app.use('/api/playbook', requireAuth, playbookRoutes(db));
  app.use('/api/reports', requireAuth, reportRoutes(db));
  app.use('/api/targets', requireAuth, targetsRoutes(db));
  app.use('/api/kpi', requireAuth, kpiRoutes(db));
  app.use('/api/team', requireAuth, teamRoutes(db));
  app.use('/api/import', requireAuth, importRoutes(db));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(PUBLIC_DIR));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });
  return app;
}
