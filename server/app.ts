import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, companiesHaveDiscoveryAnswers } from './db.js';
import { config, resolveCorsOrigin } from './config.js';
import {
  allowedEmailError,
  isAllowedEmail,
  isUserRole,
  requireAuth,
  requireAdmin,
  signToken,
  USER_ROLES,
} from './auth.js';
import { mapCompany, mapContact } from './mappers.js';
import { registerConversationRoutes } from './conversations.js';
import { registerActivityRoutes } from './activityRoutes.js';
import {
  createSession,
  endSession,
  getOpenSession,
  IDLE_MS,
  logActivity,
  touchSession,
  collectFieldChanges,
  formatFieldChangeSummary,
  noteSnippet,
  normalizeActivityValue,
} from './activity.js';
import { resolveAutoMoveStage } from '../src/lib/championSync.js';
import {
  getAppSettings,
  isAllowedContactStatus,
  isAllowedStage,
  updateAppSettings,
  asDiscoveryQuestions,
  type SettingsPatch,
} from './settings.js';
import { scoreProspect as scoreProspectLocal } from '../src/lib/leadScoring.js';
import { scoreProspectsAI } from './ai/scoring.js';
import { extractFromVoice, extractFromImage } from './ai/extract.js';
import { getCurrentPlan, hasFeature, type Feature } from './subscription.js';
import type { ProspectRow } from '../src/types.js';

const app = express();
app.use(
  helmet({
    contentSecurityPolicy: config.isProd
      ? {
          useDefaults: true,
          directives: {
            'default-src': ["'self'"],
            'script-src': ["'self'"],
            'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            'font-src': ["'self'", 'https://fonts.gstatic.com'],
            'img-src': ["'self'", 'data:', 'blob:'],
            'media-src': ["'self'", 'blob:', 'https:'],
            'connect-src': ["'self'", ...config.corsOrigins],
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(
  cors({
    origin: (origin, cb) => {
      const resolved = resolveCorsOrigin(origin);
      if (resolved === false) cb(null, false);
      else cb(null, resolved);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
  skip: () => config.nodeEnv === 'test',
});

const COMPANY_SELECT = `
  SELECT c.*, u.name AS assigned_to_name
  FROM companies c
  LEFT JOIN users u ON u.id = c.assigned_to
`;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function cleanEmail(raw: string): string {
  return raw
    .trim()
    .replace(/\+1$/, '')
    .replace(/\+\d+$/, '')
    .toLowerCase();
}

function mapIndustry(raw: string): string | null {
  const s = raw.toLowerCase().replace(/[^a-z0-9\s&]/g, ' ');
  if (/hospital|health|care|medical|pharma/.test(s)) return 'Healthcare';
  if (/biotech|research|genome|lab/.test(s)) return 'Research / Biotech';
  if (/retail|cosmetic|wholesale|shop/.test(s)) return 'Retail';
  if (/bank|fintech|insurance|bfsi/.test(s)) return 'BFSI';
  if (/saas|software|tech/.test(s)) return 'SaaS';
  if (/edu|edtech/.test(s)) return 'EdTech';
  if (/telecom/.test(s)) return 'Telecom';
  if (/logistics|fleet|shipping/.test(s)) return 'Logistics';
  if (!raw.trim()) return null;
  return 'Other';
}

function emptyToNull<T>(v: T | '' | null | undefined): T | null {
  if (v === '' || v === undefined) return null;
  return v;
}

/** Accumulates `col = $n` assignments for a partial UPDATE. */
function sqlUpdateBuilder() {
  const fields: string[] = [];
  const values: unknown[] = [];
  return {
    set(col: string, val: unknown, cast?: string) {
      values.push(val);
      fields.push(cast ? `${col} = $${values.length}::${cast}` : `${col} = $${values.length}`);
    },
    get isEmpty() {
      return fields.length === 0;
    },
    /** Appends `updated_at = now()` + the id param; returns the SQL fragment. */
    finalize(id: unknown) {
      fields.push('updated_at = now()');
      values.push(id);
      return { assignments: fields.join(', '), idParam: values.length, values };
    },
  };
}

// ─── Public config (no auth) ────────────────────────────────────────────────

app.get('/api/config', async (_req, res) => {
  try {
    const settings = await getAppSettings();
    res.json({
      brandName: settings.brandName,
      brandTagline: settings.brandTagline,
      logoUrl: settings.logoUrl,
      stages: settings.stages,
      contactStatuses: settings.contactStatuses,
      championStatusToStage: settings.championStatusToStage,
      discoveryQuestions: settings.discoveryQuestions,
      icpDescription: settings.icpDescription,
      subscriptionPlan: settings.subscriptionPlan,
      allowedEmailDomain: config.primaryEmailDomain,
      allowedEmailDomains: config.allowedEmailAny ? ['*'] : config.allowedEmailDomains,
      allowAnyEmailDomain: config.allowedEmailAny,
    });
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : 'Failed to load config.',
    });
  }
});

// ─── Instance settings (admin / founder) ────────────────────────────────────

app.patch('/api/settings', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if (typeof b.brandName === 'string') patch.brandName = b.brandName;
  if (typeof b.brandTagline === 'string') patch.brandTagline = b.brandTagline;
  if (typeof b.logoUrl === 'string') patch.logoUrl = b.logoUrl;
  if (Array.isArray(b.stages)) {
    patch.stages = b.stages.filter((x): x is string => typeof x === 'string');
  }
  if (Array.isArray(b.contactStatuses)) {
    patch.contactStatuses = b.contactStatuses.filter((x): x is string => typeof x === 'string');
  }
  if (b.championStatusToStage && typeof b.championStatusToStage === 'object') {
    const map: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(b.championStatusToStage as Record<string, unknown>)) {
      if (v === null || typeof v === 'string') map[k] = v;
    }
    patch.championStatusToStage = map;
  }
  if (Array.isArray(b.discoveryQuestions)) {
    patch.discoveryQuestions = asDiscoveryQuestions(b.discoveryQuestions);
  }
  if (typeof b.icpDescription === 'string') patch.icpDescription = b.icpDescription;

  try {
    const settings = await updateAppSettings(patch);
    res.json({
      brandName: settings.brandName,
      brandTagline: settings.brandTagline,
      logoUrl: settings.logoUrl,
      stages: settings.stages,
      contactStatuses: settings.contactStatuses,
      championStatusToStage: settings.championStatusToStage,
      discoveryQuestions: settings.discoveryQuestions,
      icpDescription: settings.icpDescription,
      subscriptionPlan: settings.subscriptionPlan,
      updatedAt: settings.updatedAt,
    });
  } catch (e) {
    res.status(400).json({
      error: e instanceof Error ? e.message : 'Invalid settings.',
    });
  }
});

// ─── Subscription (Plus / Pro / Enterprise) ─────────────────────────────────

app.get('/api/subscription', requireAuth, async (_req, res) => {
  const plan = await getCurrentPlan();
  res.json({
    plan,
    features: {
      voice_ai: hasFeature(plan, 'voice_ai'),
      image_ai: hasFeature(plan, 'image_ai'),
      lead_scoring: hasFeature(plan, 'lead_scoring'),
      call_analysis: hasFeature(plan, 'call_analysis'),
    },
  });
});

app.patch('/api/subscription', requireAuth, requireAdmin, async (req, res) => {
  const raw = String((req.body as Record<string, unknown>).plan ?? '').trim().toLowerCase();
  if (!['free', 'plus', 'pro', 'enterprise'].includes(raw)) {
    res.status(400).json({ error: 'Invalid plan. Use free, plus, pro, or enterprise.' });
    return;
  }
  const settings = await updateAppSettings({ subscriptionPlan: raw as 'free' | 'plus' | 'pro' | 'enterprise' });
  res.json({ plan: settings.subscriptionPlan });
});

async function requireFeatureOr402(feature: Feature, res: express.Response): Promise<boolean> {
  const plan = await getCurrentPlan();
  if (hasFeature(plan, feature)) return true;
  const requiredPlan = feature === 'call_analysis' ? 'pro' : 'plus';
  res.status(402).json({
    error: `This feature requires ${requiredPlan === 'pro' ? 'Pro' : 'Plus or Pro'} plan. Upgrade in Subscription.`,
    code: 'SUBSCRIPTION_REQUIRED',
    plan,
    feature,
    requiredPlan,
  });
  return false;
}

// ─── Auth ───────────────────────────────────────────────────────────────────

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const email = String(req.body.email ?? '')
    .trim()
    .toLowerCase();
  const password = String(req.body.password ?? '');

  if (!isAllowedEmail(email)) {
    res.status(400).json({ error: allowedEmailError() });
    return;
  }

  const { rows } = await pool.query(
    'SELECT id, email, password_hash, name, role FROM users WHERE LOWER(email) = $1',
    [email]
  );
  const user = rows[0];
  if (!user) {
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }

  const sid = await createSession(String(user.id));
  await logActivity({
    userId: String(user.id),
    sessionId: sid,
    eventType: 'session.login',
    entityType: 'session',
    entityId: sid,
    summary: 'Login',
    payload: {},
  });

  const token = signToken({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    sid,
  });

  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const reasonRaw = String(req.body?.reason ?? 'manual');
  const reason =
    reasonRaw === 'idle' || reasonRaw === 'expired' || reasonRaw === 'manual'
      ? reasonRaw
      : 'manual';
  const sid = req.user!.sid;
  if (sid) {
    const closed = await endSession(sid, req.user!.sub, reason);
    if (closed) {
      await logActivity({
        userId: req.user!.sub,
        sessionId: sid,
        eventType: reason === 'idle' ? 'session.idle' : 'session.logout',
        entityType: 'session',
        entityId: sid,
        summary: reason === 'idle' ? 'Idle logout' : 'Logout',
        payload: { reason },
      });
    }
  }
  res.status(204).end();
});

app.post('/api/auth/heartbeat', requireAuth, async (req, res) => {
  const sid = req.user!.sid;
  if (!sid) {
    res.status(401).json({ error: 'Session required — please log in again' });
    return;
  }
  const session = await getOpenSession(sid, req.user!.sub);
  if (!session) {
    res.status(401).json({ error: 'Session ended — please log in again' });
    return;
  }
  const last = new Date(String(session.last_active_at)).getTime();
  if (Date.now() - last >= IDLE_MS) {
    await endSession(sid, req.user!.sub, 'idle');
    await logActivity({
      userId: req.user!.sub,
      sessionId: sid,
      eventType: 'session.idle',
      entityType: 'session',
      entityId: sid,
      summary: 'Idle logout',
      payload: { reason: 'idle' },
    });
    res.status(401).json({ error: 'Session idle — please log in again' });
    return;
  }
  await touchSession(sid);
  res.json({ ok: true, lastActiveAt: new Date().toISOString() });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  res.json({
    user: {
      id: req.user!.sub,
      email: req.user!.email,
      name: req.user!.name,
      role: req.user!.role,
    },
  });
});

// ─── Users (admin / founder) ────────────────────────────────────────────────

app.get('/api/users/roles', requireAuth, requireAdmin, (_req, res) => {
  res.json({ roles: USER_ROLES });
});

app.get('/api/users', requireAuth, requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, name, role, created_at
     FROM users
     ORDER BY name ASC`
  );
  res.json({
    users: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      createdAt: row.created_at,
    })),
  });
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const email = String(req.body.email ?? '')
    .trim()
    .toLowerCase();
  const name = String(req.body.name ?? '').trim();
  const password = String(req.body.password ?? '');
  const role = String(req.body.role ?? 'sdr')
    .trim()
    .toLowerCase();

  if (!isAllowedEmail(email)) {
    res.status(400).json({ error: allowedEmailError() });
    return;
  }
  if (!name) {
    res.status(400).json({ error: 'Name is required.' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters.' });
    return;
  }
  if (!isUserRole(role)) {
    res.status(400).json({
      error: `Invalid role. Allowed: ${USER_ROLES.join(', ')}.`,
    });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, created_at`,
      [email, passwordHash, name, role]
    );
    const row = rows[0];
    res.status(201).json({
      user: {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        createdAt: row.created_at,
      },
    });
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === '23505') {
      res.status(409).json({ error: 'A user with that email already exists.' });
      return;
    }
    throw e;
  }
});

// ─── Bootstrap ──────────────────────────────────────────────────────────────

app.get('/api/bootstrap', requireAuth, async (_req, res) => {
  const [companies, contacts] = await Promise.all([
    pool.query(`${COMPANY_SELECT} ORDER BY c.created_at DESC`),
    pool.query('SELECT * FROM contacts ORDER BY created_at DESC'),
  ]);
  res.json({
    companies: companies.rows.map(mapCompany),
    contacts: contacts.rows.map(mapContact),
  });
});

app.get('/api/metrics', requireAuth, async (_req, res) => {
  const activeStages = [
    'Discovery Call Done',
    'Follow-up',
    'Demo Scheduled',
    'Demo Delivered',
    'Commercial Proposal Shared',
    'POC Kickoff',
    'Client Data Received',
    'POC Delivered',
    'Final Negotiation',
  ];
  const today = todayIso();
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*)::int AS total_companies,
      COUNT(*) FILTER (WHERE stage = 'Lead Added')::int AS new_leads,
      COUNT(*) FILTER (WHERE next_follow_up = $1::date)::int AS follow_ups_due_today,
      COUNT(*) FILTER (WHERE stage = 'Demo Scheduled')::int AS demo_scheduled,
      COUNT(*) FILTER (WHERE stage = ANY($2::text[]))::int AS active_opportunities,
      COUNT(*) FILTER (WHERE stage = 'Closed Won')::int AS closed_won,
      COUNT(*) FILTER (WHERE stage = 'Closed Lost')::int AS closed_lost
    FROM companies
    `,
    [today, activeStages]
  );
  const { rows: contactRows } = await pool.query('SELECT COUNT(*)::int AS n FROM contacts');
  const m = rows[0];
  res.json({
    totalCompanies: m.total_companies,
    totalContacts: contactRows[0].n,
    newLeads: m.new_leads,
    followUpsDueToday: m.follow_ups_due_today,
    demoScheduled: m.demo_scheduled,
    activeOpportunities: m.active_opportunities,
    closedWon: m.closed_won,
    closedLost: m.closed_lost,
  });
});

// ─── Companies ─────────────────────────────────────────────────────────────

app.post('/api/companies', requireAuth, async (req, res) => {
  const b = req.body;
  const settings = await getAppSettings();
  const stage = b.stage ?? settings.stages[0] ?? 'Lead Added';
  if (!isAllowedStage(settings, stage)) {
    res.status(400).json({
      error: `Invalid stage. Allowed: ${settings.stages.join(', ')}.`,
    });
    return;
  }
  const answers =
    b.discoveryAnswers &&
    typeof b.discoveryAnswers === 'object' &&
    !Array.isArray(b.discoveryAnswers)
      ? Object.fromEntries(
          Object.entries(b.discoveryAnswers as Record<string, unknown>).map(([k, v]) => [
            k,
            v == null ? '' : String(v),
          ])
        )
      : {};
  const hasDiscoveryCol = await companiesHaveDiscoveryAnswers();
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  const rawInputText = typeof b.rawInputText === 'string' ? b.rawInputText.trim() : '';
  const leadSource = typeof b.leadSource === 'string' && ['manual','bulk','single','voice','image'].includes(b.leadSource) ? b.leadSource : 'manual';
  const { rows } = await pool.query(
    hasDiscoveryCol
      ? `
    INSERT INTO companies (
      company_name, stage, industry, location, estimated_call_volume, employee_count,
      intent, offered_price, primary_contact_id, assigned_to, last_contacted,
      next_follow_up, notes, source_link, company_website, linkedin_company, discovery_answers, description, lead_source, raw_input_text
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20
    )
    RETURNING id
    `
      : `
    INSERT INTO companies (
      company_name, stage, industry, location, estimated_call_volume, employee_count,
      intent, offered_price, primary_contact_id, assigned_to, last_contacted,
      next_follow_up, notes, source_link, company_website, linkedin_company, description, lead_source, raw_input_text
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
    )
    RETURNING id
    `,
    hasDiscoveryCol
      ? [
          b.companyName,
          stage,
          emptyToNull(b.industry),
          b.location ?? '',
          b.estimatedCallVolume ?? null,
          b.employeeCount ?? null,
          emptyToNull(b.intent),
          b.offeredPrice ?? null,
          b.primaryContactId ?? null,
          req.user!.sub,
          b.lastContacted ?? null,
          b.nextFollowUp ?? null,
          b.notes ?? '',
          b.sourceLink ?? '',
          b.companyWebsite ?? '',
          b.linkedInCompany ?? '',
          JSON.stringify(answers),
          description,
          leadSource,
          rawInputText,
        ]
      : [
          b.companyName,
          stage,
          emptyToNull(b.industry),
          b.location ?? '',
          b.estimatedCallVolume ?? null,
          b.employeeCount ?? null,
          emptyToNull(b.intent),
          b.offeredPrice ?? null,
          b.primaryContactId ?? null,
          req.user!.sub,
          b.lastContacted ?? null,
          b.nextFollowUp ?? null,
          b.notes ?? '',
          b.sourceLink ?? '',
          b.companyWebsite ?? '',
          b.linkedInCompany ?? '',
          description,
          leadSource,
          rawInputText,
        ]
  );
  const { rows: full } = await pool.query(`${COMPANY_SELECT} WHERE c.id = $1`, [rows[0].id]);
  let company = mapCompany(full[0]);
  // Immediate scoring if Pro/Enterprise and ICP exists (gated)
  if (hasFeature(await getCurrentPlan(), 'lead_scoring')) {
    try {
      const settings = await getAppSettings();
      const icp = settings.icpDescription ?? '';
      if (icp.trim()) {
      const prospect = {
        company: company.companyName,
        prospectName: '',
        jobTitle: '',
        email: '',
        phone: '',
        location: company.location ?? '',
        employees: company.employeeCount ?? null,
        industry: company.industry ?? '',
        description: company.description ?? '',
        rawInputText: company.rawInputText ?? '',
      };
      const scored = scoreProspectLocal(prospect, icp);
      await pool.query(`UPDATE companies SET lead_score=$1, lead_score_reasons=$2::jsonb, lead_scored_at=now() WHERE id=$3`, [
        scored.score,
        JSON.stringify(scored.reasons),
        company.id,
      ]);
      await pool.query(`INSERT INTO lead_scores (company_id, score, reasons, icp_snapshot, model) VALUES ($1,$2,$3::jsonb,$4,$5)`, [
        company.id,
        scored.score,
        JSON.stringify(scored.reasons),
        icp,
        config.ai.provider,
      ]);
      const { rows: rescored } = await pool.query(`${COMPANY_SELECT} WHERE c.id=$1`, [company.id]);
      company = mapCompany(rescored[0]);
      }
    } catch {}
  }
  await logActivity({
    userId: req.user!.sub,
    sessionId: req.user!.sid,
    eventType: 'company.created',
    entityType: 'company',
    entityId: company.id,
    summary: `Created company ${company.companyName}`,
    payload: { name: company.companyName, stage: company.stage },
  });
  res.status(201).json(company);
});

app.patch('/api/companies/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const { rows: beforeRows } = await pool.query(`${COMPANY_SELECT} WHERE c.id = $1`, [id]);
  const before = beforeRows[0];
  if (!before) {
    res.status(404).json({ error: 'Company not found' });
    return;
  }

  const update = sqlUpdateBuilder();

  if (b.companyName !== undefined) update.set('company_name', b.companyName);
  if (b.stage !== undefined) {
    const settings = await getAppSettings();
    if (!isAllowedStage(settings, b.stage)) {
      res.status(400).json({
        error: `Invalid stage. Allowed: ${settings.stages.join(', ')}.`,
      });
      return;
    }
    update.set('stage', b.stage);
  }
  if (b.industry !== undefined) update.set('industry', emptyToNull(b.industry));
  if (b.location !== undefined) update.set('location', String(b.location ?? '').trim());
  if (b.estimatedCallVolume !== undefined)
    update.set('estimated_call_volume', b.estimatedCallVolume !== '' && b.estimatedCallVolume != null ? Number(b.estimatedCallVolume) || null : null);
  if (b.employeeCount !== undefined) update.set('employee_count', b.employeeCount !== '' && b.employeeCount != null ? Number(b.employeeCount) || null : null);
  if (b.intent !== undefined) update.set('intent', emptyToNull(b.intent));
  if (b.offeredPrice !== undefined) update.set('offered_price', b.offeredPrice !== '' && b.offeredPrice != null ? Number(b.offeredPrice) || null : null);
  if (b.primaryContactId !== undefined) update.set('primary_contact_id', b.primaryContactId ? String(b.primaryContactId).trim() : null);
  if (b.lastContacted !== undefined) update.set('last_contacted', b.lastContacted ? String(b.lastContacted).slice(0, 10) : null);
  if (b.nextFollowUp !== undefined) update.set('next_follow_up', b.nextFollowUp ? String(b.nextFollowUp).slice(0, 10) : null);
  if (b.notes !== undefined) update.set('notes', String(b.notes ?? ''));
  if (b.sourceLink !== undefined) update.set('source_link', String(b.sourceLink ?? '').trim());
  if (b.companyWebsite !== undefined) update.set('company_website', String(b.companyWebsite ?? '').trim());
  if (b.linkedInCompany !== undefined) update.set('linkedin_company', String(b.linkedInCompany ?? '').trim());
  if (b.description !== undefined) update.set('description', String(b.description ?? ''));
  if (b.leadSource !== undefined) update.set('lead_source', String(b.leadSource ?? 'manual'));
  if (b.rawInputText !== undefined) update.set('raw_input_text', String(b.rawInputText ?? ''));
  if (b.discoveryAnswers !== undefined && (await companiesHaveDiscoveryAnswers())) {
    const answers =
      b.discoveryAnswers &&
      typeof b.discoveryAnswers === 'object' &&
      !Array.isArray(b.discoveryAnswers)
        ? Object.fromEntries(
            Object.entries(b.discoveryAnswers as Record<string, unknown>).map(([k, v]) => [
              k,
              v == null ? '' : String(v),
            ])
          )
        : {};
    update.set('discovery_answers', JSON.stringify(answers), 'jsonb');
  }

  if (update.isEmpty) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  const { assignments, idParam, values } = update.finalize(id);
  await pool.query(`UPDATE companies SET ${assignments} WHERE id = $${idParam}`, values);

  const { rows: full } = await pool.query(`${COMPANY_SELECT} WHERE c.id = $1`, [id]);
  if (!full[0]) {
    res.status(404).json({ error: 'Company not found' });
    return;
  }

  let updatedCompanyRow = full[0];
  // Rescore if Pro/Enterprise and ICP-relevant fields changed
  const shouldRescore =
    b.description !== undefined ||
    b.industry !== undefined ||
    b.location !== undefined ||
    b.employeeCount !== undefined ||
    b.estimatedCallVolume !== undefined;
  if (shouldRescore && hasFeature(await getCurrentPlan(), 'lead_scoring')) {
    try {
      const settings = await getAppSettings();
      const icp = settings.icpDescription ?? '';
      if (icp.trim()) {
        const prospect = {
          company: String(updatedCompanyRow.company_name),
          prospectName: '',
          jobTitle: '',
          email: '',
          phone: '',
          location: String(updatedCompanyRow.location ?? ''),
          employees: updatedCompanyRow.employee_count != null ? Number(updatedCompanyRow.employee_count) : null,
          industry: String(updatedCompanyRow.industry ?? ''),
          description: String(updatedCompanyRow.description ?? ''),
          rawInputText: String(updatedCompanyRow.raw_input_text ?? ''),
        };
        const scored = scoreProspectLocal(prospect, icp);
        await pool.query(`UPDATE companies SET lead_score=$1, lead_score_reasons=$2::jsonb, lead_scored_at=now() WHERE id=$3`, [
          scored.score,
          JSON.stringify(scored.reasons),
          id,
        ]);
        await pool.query(`INSERT INTO lead_scores (company_id, score, reasons, icp_snapshot, model) VALUES ($1,$2,$3::jsonb,$4,$5)`, [
          id,
          scored.score,
          JSON.stringify(scored.reasons),
          icp,
          config.ai.provider,
        ]);
        const { rows: rescored } = await pool.query(`${COMPANY_SELECT} WHERE c.id=$1`, [id]);
        if (rescored[0]) updatedCompanyRow = rescored[0];
      }
    } catch {}
  }

  const name = String(updatedCompanyRow.company_name);
  const sid = req.user!.sid;
  const uid = req.user!.sub;
  if (b.stage !== undefined && b.stage !== before.stage) {
    const source =
      typeof b.stageChangeSource === 'string' && b.stageChangeSource.trim()
        ? b.stageChangeSource.trim()
        : undefined;
    await logActivity({
      userId: uid,
      sessionId: sid,
      eventType: 'company.stage_changed',
      entityType: 'company',
      entityId: String(id),
      summary: `Stage → ${b.stage} (${name})`,
      payload: {
        from: before.stage,
        to: b.stage,
        name,
        ...(source ? { source } : {}),
      },
    });
  }
  if (b.nextFollowUp !== undefined && b.nextFollowUp !== before.next_follow_up) {
    const from = normalizeActivityValue(before.next_follow_up);
    const to = normalizeActivityValue(b.nextFollowUp);
    await logActivity({
      userId: uid,
      sessionId: sid,
      eventType: 'company.follow_up_set',
      entityType: 'company',
      entityId: String(id),
      summary: `Follow-up: ${from ?? '—'} → ${to ?? '—'} (${name})`,
      payload: { from, to, nextFollowUp: to, name },
    });
  }
  if (b.notes !== undefined && b.notes !== before.notes) {
    const from = normalizeActivityValue(before.notes);
    const to = normalizeActivityValue(b.notes);
    const snippet = noteSnippet(to);
    await logActivity({
      userId: uid,
      sessionId: sid,
      eventType: 'company.note_added',
      entityType: 'company',
      entityId: String(id),
      summary: snippet ? `Note updated on ${name}: "${snippet}"` : `Note cleared on ${name}`,
      payload: { name, from, to, note: to },
    });
  }
  if (b.discoveryAnswers !== undefined && (await companiesHaveDiscoveryAnswers())) {
    const beforeAnswers =
      before.discovery_answers && typeof before.discovery_answers === 'object'
        ? (before.discovery_answers as Record<string, unknown>)
        : {};
    const afterAnswers =
      full[0].discovery_answers && typeof full[0].discovery_answers === 'object'
        ? (full[0].discovery_answers as Record<string, unknown>)
        : {};
    const keys = new Set([...Object.keys(beforeAnswers), ...Object.keys(afterAnswers)]);
    const changed: string[] = [];
    for (const key of keys) {
      const from = normalizeActivityValue(beforeAnswers[key]);
      const to = normalizeActivityValue(afterAnswers[key]);
      if (from !== to) changed.push(key);
    }
    if (changed.length > 0) {
      await logActivity({
        userId: uid,
        sessionId: sid,
        eventType: 'company.discovery_updated',
        entityType: 'company',
        entityId: String(id),
        summary: `Discovery answers updated (${changed.length}) on ${name}`,
        payload: { name, changedFields: changed },
      });
    }
  }
  const companyOtherChanges = collectFieldChanges([
    {
      field: 'companyName',
      label: 'Name',
      before: before.company_name,
      after: b.companyName,
      provided: b.companyName !== undefined,
    },
    {
      field: 'industry',
      label: 'Industry',
      before: before.industry,
      after: b.industry,
      provided: b.industry !== undefined,
    },
    {
      field: 'location',
      label: 'Location',
      before: before.location,
      after: b.location,
      provided: b.location !== undefined,
    },
    {
      field: 'intent',
      label: 'Intent',
      before: before.intent,
      after: b.intent,
      provided: b.intent !== undefined,
    },
    {
      field: 'lastContacted',
      label: 'Last contacted',
      before: before.last_contacted,
      after: b.lastContacted,
      provided: b.lastContacted !== undefined,
    },
    {
      field: 'estimatedCallVolume',
      label: 'Call volume',
      before: before.estimated_call_volume,
      after: b.estimatedCallVolume,
      provided: b.estimatedCallVolume !== undefined,
    },
    {
      field: 'employeeCount',
      label: 'Employees',
      before: before.employee_count,
      after: b.employeeCount,
      provided: b.employeeCount !== undefined,
    },
    {
      field: 'offeredPrice',
      label: 'Offered price',
      before: before.offered_price,
      after: b.offeredPrice,
      provided: b.offeredPrice !== undefined,
    },
    {
      field: 'companyWebsite',
      label: 'Website',
      before: before.company_website,
      after: b.companyWebsite,
      provided: b.companyWebsite !== undefined,
    },
    {
      field: 'linkedInCompany',
      label: 'LinkedIn',
      before: before.linkedin_company,
      after: b.linkedInCompany,
      provided: b.linkedInCompany !== undefined,
    },
    {
      field: 'sourceLink',
      label: 'Source link',
      before: before.source_link,
      after: b.sourceLink,
      provided: b.sourceLink !== undefined,
    },
    {
      field: 'primaryContactId',
      label: 'Primary contact',
      before: before.primary_contact_id,
      after: b.primaryContactId,
      provided: b.primaryContactId !== undefined,
    },
  ]);
  if (companyOtherChanges.length > 0) {
    await logActivity({
      userId: uid,
      sessionId: sid,
      eventType: 'company.updated',
      entityType: 'company',
      entityId: String(id),
      summary: formatFieldChangeSummary(name, companyOtherChanges),
      payload: { name, changes: companyOtherChanges },
    });
  }

  res.json(mapCompany(updatedCompanyRow));
});

app.delete('/api/companies/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { rows: beforeRows } = await pool.query(
    'SELECT company_name FROM companies WHERE id = $1',
    [id]
  );
  const before = beforeRows[0];
  if (!before) {
    res.status(404).json({ error: 'Company not found' });
    return;
  }
  const name = String(before.company_name);
  await pool.query('UPDATE contacts SET company_id = NULL WHERE company_id = $1', [id]);
  await pool.query('DELETE FROM companies WHERE id = $1', [id]);
  await logActivity({
    userId: req.user!.sub,
    sessionId: req.user!.sid,
    eventType: 'company.deleted',
    entityType: 'company',
    entityId: String(id),
    summary: `Deleted company ${name}`,
    payload: { name },
  });
  res.status(204).end();
});

// ─── Contacts ────────────────────────────────────────────────────────────────

app.post('/api/contacts', requireAuth, async (req, res) => {
  const b = req.body;
  const settings = await getAppSettings();
  const contactStatus = b.contactStatus ?? settings.contactStatuses[0] ?? 'Not Contacted';
  if (!isAllowedContactStatus(settings, contactStatus)) {
    res.status(400).json({
      error: `Invalid contact status. Allowed: ${settings.contactStatuses.join(', ')}.`,
    });
    return;
  }
  const { rows } = await pool.query(
    `
    INSERT INTO contacts (
      contact_name, company_id, role, phone, email, linkedin_profile,
      contact_status, champion, last_contacted, next_follow_up, notes, description, raw_input_text
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *
    `,
    [
      String(b.contactName ?? '').trim(),
      b.companyId ? String(b.companyId).trim() : null,
      String(b.role ?? '').trim(),
      String(b.phone ?? '').trim(),
      String(b.email ?? '').trim(),
      String(b.linkedInProfile ?? '').trim(),
      contactStatus,
      Boolean(b.champion),
      b.lastContacted ? String(b.lastContacted).slice(0, 10) : null,
      b.nextFollowUp ? String(b.nextFollowUp).slice(0, 10) : null,
      String(b.notes ?? ''),
      String(b.description ?? ''),
      String(b.rawInputText ?? ''),
    ]
  );
  const contact = rows[0];
  if (contact.champion && contact.company_id) {
    await pool.query('UPDATE companies SET primary_contact_id = $1 WHERE id = $2', [
      contact.id,
      contact.company_id,
    ]);
  }
  const mapped = mapContact(contact);
  await logActivity({
    userId: req.user!.sub,
    sessionId: req.user!.sid,
    eventType: 'contact.created',
    entityType: 'contact',
    entityId: mapped.id,
    summary: `Created contact ${mapped.contactName}`,
    payload: {
      name: mapped.contactName,
      companyId: mapped.companyId,
      status: mapped.contactStatus,
    },
  });
  res.status(201).json(mapped);
});

app.patch('/api/contacts/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const { rows: beforeRows } = await pool.query('SELECT * FROM contacts WHERE id = $1', [id]);
  const before = beforeRows[0];
  if (!before) {
    res.status(404).json({ error: 'Contact not found' });
    return;
  }

  const update = sqlUpdateBuilder();

  if (b.contactName !== undefined) update.set('contact_name', String(b.contactName).trim());
  if (b.companyId !== undefined) update.set('company_id', b.companyId ? String(b.companyId).trim() : null);
  if (b.role !== undefined) update.set('role', String(b.role ?? '').trim());
  if (b.phone !== undefined) update.set('phone', String(b.phone ?? '').trim());
  if (b.email !== undefined) update.set('email', String(b.email ?? '').trim());
  if (b.linkedInProfile !== undefined) update.set('linkedin_profile', String(b.linkedInProfile ?? '').trim());
  if (b.contactStatus !== undefined) {
    const settings = await getAppSettings();
    if (!isAllowedContactStatus(settings, b.contactStatus)) {
      res.status(400).json({
        error: `Invalid contact status. Allowed: ${settings.contactStatuses.join(', ')}.`,
      });
      return;
    }
    update.set('contact_status', b.contactStatus);
  }
  if (b.champion !== undefined) update.set('champion', Boolean(b.champion));
  if (b.lastContacted !== undefined) update.set('last_contacted', b.lastContacted ? String(b.lastContacted).slice(0, 10) : null);
  if (b.nextFollowUp !== undefined) update.set('next_follow_up', b.nextFollowUp ? String(b.nextFollowUp).slice(0, 10) : null);
  if (b.notes !== undefined) update.set('notes', String(b.notes ?? ''));
  if (b.description !== undefined) update.set('description', String(b.description ?? ''));
  if (b.rawInputText !== undefined) update.set('raw_input_text', String(b.rawInputText ?? ''));

  if (update.isEmpty) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  const { assignments, idParam, values } = update.finalize(id);

  // Atomic unit: the contact update, the optional champion→company writes, the
  // stage auto-move, and every related activity insert must all commit together
  // or not at all — otherwise a failed stage write leaves the contact advanced
  // while the board stays stale. Mirror the import handler's transaction shape.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE contacts SET ${assignments} WHERE id = $${idParam} RETURNING *`,
      values
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Contact not found' });
      return;
    }

    const contact = rows[0];
    // Set when a champion status change auto-advances the company; null otherwise.
    // Consumed by the web client to reconcile the Kanban board — keep this name.
    let movedCompanyStage: string | null = null;

    if (b.champion === true && contact.company_id) {
      await client.query('UPDATE companies SET primary_contact_id = $1 WHERE id = $2', [
        contact.id,
        contact.company_id,
      ]);
    }

    const name = String(contact.contact_name);
    const sid = req.user!.sid;
    const uid = req.user!.sub;

    if (b.contactStatus !== undefined && b.contactStatus !== before.contact_status) {
      await logActivity(
        {
          userId: uid,
          sessionId: sid,
          eventType: 'contact.status_changed',
          entityType: 'contact',
          entityId: String(id),
          summary: `Status: ${before.contact_status} → ${b.contactStatus} (${name})`,
          payload: { from: before.contact_status, to: b.contactStatus, name },
        },
        client
      );
    }
    if (
      b.nextFollowUp !== undefined &&
      normalizeActivityValue(b.nextFollowUp) !== normalizeActivityValue(before.next_follow_up)
    ) {
      const from = normalizeActivityValue(before.next_follow_up);
      const to = normalizeActivityValue(b.nextFollowUp);
      await logActivity(
        {
          userId: uid,
          sessionId: sid,
          eventType: 'contact.follow_up_set',
          entityType: 'contact',
          entityId: String(id),
          summary: `Follow-up: ${from ?? '—'} → ${to ?? '—'} (${name})`,
          payload: { from, to, nextFollowUp: to, name },
        },
        client
      );
    }
    if (
      b.notes !== undefined &&
      normalizeActivityValue(b.notes) !== normalizeActivityValue(before.notes)
    ) {
      const from = normalizeActivityValue(before.notes);
      const to = normalizeActivityValue(b.notes);
      const snippet = noteSnippet(to);
      await logActivity(
        {
          userId: uid,
          sessionId: sid,
          eventType: 'contact.note_added',
          entityType: 'contact',
          entityId: String(id),
          summary: snippet ? `Note updated on ${name}: "${snippet}"` : `Note cleared on ${name}`,
          payload: { name, from, to, note: to },
        },
        client
      );
    }

    const otherChanges = collectFieldChanges([
      {
        field: 'contactName',
        label: 'Name',
        before: before.contact_name,
        after: b.contactName,
        provided: b.contactName !== undefined,
      },
      {
        field: 'companyId',
        label: 'Company',
        before: before.company_id,
        after: b.companyId,
        provided: b.companyId !== undefined,
      },
      {
        field: 'role',
        label: 'Role',
        before: before.role,
        after: b.role,
        provided: b.role !== undefined,
      },
      {
        field: 'phone',
        label: 'Phone',
        before: before.phone,
        after: b.phone,
        provided: b.phone !== undefined,
      },
      {
        field: 'email',
        label: 'Email',
        before: before.email,
        after: b.email,
        provided: b.email !== undefined,
      },
      {
        field: 'linkedInProfile',
        label: 'LinkedIn',
        before: before.linkedin_profile,
        after: b.linkedInProfile,
        provided: b.linkedInProfile !== undefined,
      },
      {
        field: 'champion',
        label: 'Champion',
        before: before.champion,
        after: b.champion,
        provided: b.champion !== undefined,
      },
      {
        field: 'lastContacted',
        label: 'Last contacted',
        before: before.last_contacted,
        after: b.lastContacted,
        provided: b.lastContacted !== undefined,
      },
    ]);
    if (otherChanges.length > 0) {
      await logActivity(
        {
          userId: uid,
          sessionId: sid,
          eventType: 'contact.updated',
          entityType: 'contact',
          entityId: String(id),
          summary: formatFieldChangeSummary(name, otherChanges),
          payload: { name, changes: otherChanges },
        },
        client
      );
    }

    if (
      b.contactStatus !== undefined &&
      b.contactStatus !== before.contact_status &&
      contact.champion &&
      contact.company_id
    ) {
      const { rows: companyRows } = await client.query(
        'SELECT stage, company_name FROM companies WHERE id = $1',
        [contact.company_id]
      );
      const company = companyRows[0];
      if (company) {
        const settings = await getAppSettings();
        const target = resolveAutoMoveStage(
          company.stage,
          contact.contact_status,
          settings.stages,
          settings.championStatusToStage
        );
        if (target) {
          await client.query('UPDATE companies SET stage = $1, updated_at = now() WHERE id = $2', [
            target,
            contact.company_id,
          ]);
          movedCompanyStage = target;
          const companyName = String(company.company_name);
          await logActivity(
            {
              userId: uid,
              sessionId: sid,
              eventType: 'company.stage_changed',
              entityType: 'company',
              entityId: String(contact.company_id),
              summary: `Stage → ${target} (${companyName})`,
              payload: {
                from: company.stage,
                to: target,
                name: companyName,
                source: 'champion_contact',
              },
            },
            client
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({ ...mapContact(contact), movedCompanyStage });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

app.delete('/api/contacts/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { rows: beforeRows } = await pool.query('SELECT contact_name FROM contacts WHERE id = $1', [
    id,
  ]);
  const before = beforeRows[0];
  if (!before) {
    res.status(404).json({ error: 'Contact not found' });
    return;
  }
  const name = String(before.contact_name);
  await pool.query('UPDATE companies SET primary_contact_id = NULL WHERE primary_contact_id = $1', [
    id,
  ]);
  await pool.query('DELETE FROM contacts WHERE id = $1', [id]);
  await logActivity({
    userId: req.user!.sub,
    sessionId: req.user!.sid,
    eventType: 'contact.deleted',
    entityType: 'contact',
    entityId: String(id),
    summary: `Deleted contact ${name}`,
    payload: { name },
  });
  res.status(204).end();
});

// ─── Import ──────────────────────────────────────────────────────────────────

app.post('/api/import/prospects', requireAuth, async (req, res) => {
  const rows = req.body.rows as Array<{
    company: string;
    prospectName: string;
    jobTitle: string;
    email: string;
    phone: string;
    location: string;
    employees: number | null;
    industry: string;
    description?: string;
    rawInputText?: string;
    leadSource?: string;
  }>;

  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: 'No rows to import' });
    return;
  }

  const client = await pool.connect();
  const result = {
    companiesCreated: 0,
    companiesUpdated: 0,
    contactsCreated: 0,
    contactsSkipped: 0,
  };

  try {
    await client.query('BEGIN');

    const { rows: companyRows } = await client.query(`${COMPANY_SELECT}`);
    const { rows: contactRows } = await client.query('SELECT * FROM contacts');

    const companyByName = new Map(
      companyRows.map((c) => [String(c.company_name).toLowerCase(), c])
    );
    const emailSet = new Set(
      contactRows.map((t) => cleanEmail(String(t.email ?? ''))).filter((e) => e.length > 0)
    );
    const touchedCompanies = new Set<string>();

    for (const row of rows) {
      const key = row.company.toLowerCase();
      let company = companyByName.get(key);

      if (!company) {
        const ins = await client.query(
          `
          INSERT INTO companies (
            company_name, stage, industry, location, employee_count,
            assigned_to, next_follow_up, notes, description, lead_source, raw_input_text
          ) VALUES ($1, 'Lead Added', $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *
          `,
          [
            row.company,
            mapIndustry(row.industry),
            row.location ?? '',
            row.employees,
            req.user!.sub,
            todayIso(),
            `Imported ${todayIso()}`,
            row.description ?? '',
            row.leadSource ?? 'bulk',
            row.rawInputText ?? '',
          ]
        );
        company = ins.rows[0];
        company.assigned_to_name = req.user!.name;
        companyByName.set(key, company);
        result.companiesCreated += 1;

        // Immediate AI scoring if Pro/Enterprise and ICP configured
        const _planForScoring = await getCurrentPlan();
        if (hasFeature(_planForScoring, 'lead_scoring')) {
          try {
            const settings = await getAppSettings();
            const icp = settings.icpDescription ?? '';
            if (icp.trim()) {
              const prospectLike = {
                company: row.company,
                prospectName: row.prospectName,
                jobTitle: row.jobTitle ?? '',
                email: row.email ?? '',
                phone: row.phone ?? '',
                location: row.location ?? '',
                employees: row.employees ?? null,
                industry: row.industry ?? '',
                description: row.description ?? '',
                rawInputText: row.rawInputText ?? '',
              };
              const scored = scoreProspectLocal(prospectLike, icp);
              await client.query(
                `UPDATE companies SET lead_score=$1, lead_score_reasons=$2::jsonb, lead_scored_at=now(), description=COALESCE(NULLIF($3,''),description) WHERE id=$4`,
                [scored.score, JSON.stringify(scored.reasons), row.description ?? '', company.id]
              );
              await client.query(
                `INSERT INTO lead_scores (company_id, score, reasons, icp_snapshot, model) VALUES ($1,$2,$3::jsonb,$4,$5)`,
                [company.id, scored.score, JSON.stringify(scored.reasons), icp, config.ai.provider]
              );
              await client.query(
                `INSERT INTO extraction_jobs (user_id, source_type, status, transcript, extracted_rows) VALUES ($1,$2,'imported',$3,$4::jsonb)`,
                [req.user!.sub, (row.leadSource === 'voice' || row.leadSource === 'image') ? row.leadSource : 'bulk', row.rawInputText ?? '', JSON.stringify([row])]
              );
            }
          } catch {
            // scoring failure does not block import
          }
        }
      } else if (!touchedCompanies.has(String(company.id))) {
        const patch: string[] = [];
        const vals: unknown[] = [];
        let n = 1;
        if (row.location) {
          patch.push(`location = $${n++}`);
          vals.push(row.location);
        }
        if (row.employees != null) {
          patch.push(`employee_count = $${n++}`);
          vals.push(row.employees);
        }
        if (row.industry) {
          patch.push(`industry = $${n++}`);
          vals.push(mapIndustry(row.industry));
        }
        if (row.description) {
          patch.push(`description = $${n++}`);
          vals.push(row.description);
        }
        if (row.rawInputText) {
          patch.push(`raw_input_text = $${n++}`);
          vals.push(row.rawInputText);
        }
        if (patch.length > 0) {
          patch.push('updated_at = now()');
          vals.push(company.id);
          const upd = await client.query(
            `UPDATE companies SET ${patch.join(', ')} WHERE id = $${n} RETURNING *`,
            vals
          );
          company = { ...upd.rows[0], assigned_to_name: company.assigned_to_name };
          companyByName.set(key, company);
          result.companiesUpdated += 1;
        }
        touchedCompanies.add(String(company.id));
        // If company was rescored target, ensure unscored background will pick it up lazily if ICP now exists
      } else {
        company = companyByName.get(key)!;
      }

      const email = cleanEmail(row.email);
      if (email && emailSet.has(email)) {
        result.contactsSkipped += 1;
        continue;
      }

      if (!email) {
        const dup = contactRows.some(
          (t) =>
            t.company_id === company!.id &&
            String(t.contact_name).toLowerCase() === row.prospectName.toLowerCase()
        );
        if (dup) {
          result.contactsSkipped += 1;
          continue;
        }
      }

      try {
        const ins = await client.query(
          `
          INSERT INTO contacts (
            contact_name, company_id, role, phone, email, contact_status, description, raw_input_text
          ) VALUES ($1, $2, $3, $4, $5, 'Not Contacted', $6, $7)
          RETURNING *
          `,
          [row.prospectName, company.id, row.jobTitle ?? '', row.phone ?? '', email, row.description ?? '', row.rawInputText ?? '']
        );
        contactRows.unshift(ins.rows[0]);
        if (email) emailSet.add(email);
        result.contactsCreated += 1;
      } catch (e: unknown) {
        const err = e as { code?: string };
        if (err.code === '23505') {
          result.contactsSkipped += 1;
        } else {
          throw e;
        }
      }
    }

    await client.query('COMMIT');
    await logActivity({
      userId: req.user!.sub,
      sessionId: req.user!.sid,
      eventType: 'leads.imported',
      entityType: 'system',
      summary: `Imported ${result.contactsCreated} contacts / ${result.companiesCreated} companies`,
      payload: { ...result },
    });
    res.json(result);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// ─── AI: two-stage voice / image extraction + scoring ────────────────────────

app.post('/api/import/voice/extract', requireAuth, async (req, res) => {
  if (!(await requireFeatureOr402('voice_ai', res))) return;
  const { transcript, audioBase64 } = req.body as { transcript?: string; audioBase64?: string };
  try {
    const out = await extractFromVoice({ transcript, audioBase64 });
    // Log extraction job (text stage)
    try {
      await pool.query(
        `INSERT INTO extraction_jobs (user_id, source_type, status, transcript, extracted_rows) VALUES ($1,'voice','transcribed',$2,$3::jsonb)`,
        [req.user!.sub, out.transcript ?? transcript ?? '', JSON.stringify(out.rows)]
      );
    } catch {}
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Voice extraction failed' });
  }
});

app.post('/api/import/image/extract', requireAuth, async (req, res) => {
  if (!(await requireFeatureOr402('image_ai', res))) return;
  const { imageBase64, mimeType, fallbackText, transcript } = req.body as {
    imageBase64?: string;
    mimeType?: string;
    fallbackText?: string;
    transcript?: string;
  };
  // Allow image+voice combined — non-binary: transcript optional alongside image
  const hasImage = !!imageBase64;
  const hasFallback = !!fallbackText?.trim();
  const hasTranscript = !!transcript?.trim();
  if (!hasImage && hasFallback && !hasTranscript) {
    const { parseProspectPaste } = await import('../src/lib/importProspects.js');
    const parsed = parseProspectPaste(fallbackText!);
    try {
      await pool.query(
        `INSERT INTO extraction_jobs (user_id, source_type, status, transcript, extracted_rows) VALUES ($1,'image','transcribed',$2,$3::jsonb)`,
        [req.user!.sub, fallbackText!, JSON.stringify(parsed.rows)]
      );
    } catch {}
    res.json({ rows: parsed.rows, errors: parsed.errors, text: fallbackText, transcript });
    return;
  }
  try {
    const out = await extractFromImage({ imageBase64, mimeType, transcript, fallbackText });
    if (hasFallback && out.rows.length === 0) {
      const { parseProspectPaste: p } = await import('../src/lib/importProspects.js');
      const fb = p(fallbackText!);
      if (fb.rows.length) {
        res.json({ rows: fb.rows, errors: fb.errors, text: fallbackText, transcript });
        return;
      }
    }
    try {
      await pool.query(
        `INSERT INTO extraction_jobs (user_id, source_type, status, transcript, extracted_rows) VALUES ($1,'image','parsed',$2,$3::jsonb)`,
        [req.user!.sub, (out.transcript ?? out.text ?? fallbackText ?? '') as string, JSON.stringify(out.rows)]
      );
    } catch {}
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Image extraction failed' });
  }
});

app.post('/api/ai/score', requireAuth, async (req, res) => {
  if (!(await requireFeatureOr402('lead_scoring', res))) return;
  const rows = req.body.rows as ProspectRow[] | undefined;
  const icpOverride = typeof req.body.icpDescription === 'string' ? req.body.icpDescription : undefined;
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: 'rows required' });
    return;
  }
  const settings = await getAppSettings();
  const icp = icpOverride ?? settings.icpDescription ?? '';
  if (!icp.trim()) {
    res.status(400).json({ error: 'ICP not configured. Set ICP description in Settings → ICP.', code: 'ICP_REQUIRED' });
    return;
  }
  const scored = await scoreProspectsAI(rows, icp);
  res.json({ icp, scores: scored });
});

app.post('/api/companies/:id/score', requireAuth, async (req, res) => {
  if (!(await requireFeatureOr402('lead_scoring', res))) return;
  const { id } = req.params;
  const { rows: existing } = await pool.query(`${COMPANY_SELECT} WHERE c.id=$1`, [id]);
  if (!existing[0]) {
    res.status(404).json({ error: 'Company not found' });
    return;
  }
  const settings = await getAppSettings();
  const icp = settings.icpDescription ?? '';
  if (!icp.trim()) {
    res.status(400).json({ error: 'ICP not configured', code: 'ICP_REQUIRED' });
    return;
  }
  const comp = existing[0];
  const prospect: ProspectRow = {
    company: String(comp.company_name),
    prospectName: '',
    jobTitle: '',
    email: '',
    phone: '',
    location: String(comp.location ?? ''),
    employees: comp.employee_count != null ? Number(comp.employee_count) : null,
    industry: String(comp.industry ?? ''),
    description: String(comp.description ?? ''),
    rawInputText: String(comp.raw_input_text ?? ''),
  };
  const [scored] = await scoreProspectsAI([prospect], icp);
  await pool.query(`UPDATE companies SET lead_score=$1, lead_score_reasons=$2::jsonb, lead_scored_at=now() WHERE id=$3`, [
    scored.score,
    JSON.stringify(scored.reasons),
    id,
  ]);
  await pool.query(`INSERT INTO lead_scores (company_id, score, reasons, icp_snapshot, model) VALUES ($1,$2,$3::jsonb,$4,$5)`, [
    id,
    scored.score,
    JSON.stringify(scored.reasons),
    icp,
    config.ai.provider,
  ]);
  const { rows: updated } = await pool.query(`${COMPANY_SELECT} WHERE c.id=$1`, [id]);
  res.json(mapCompany(updated[0] as Record<string, unknown>));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

registerConversationRoutes(app, pool);
registerActivityRoutes(app);

// Slow scoring of unscored leads — 1 per 8s when Pro/Enterprise and ICP exists
if (config.nodeEnv !== 'test') {
  setInterval(async () => {
    try {
      const plan = await getCurrentPlan();
      if (!hasFeature(plan, 'lead_scoring')) return;
      const settings = await getAppSettings();
      const icp = settings.icpDescription ?? '';
      if (!icp.trim()) return;
      const { rows } = await pool.query(
        `SELECT c.* FROM companies c WHERE lead_score IS NULL ORDER BY created_at ASC LIMIT 1`
      );
      if (!rows[0]) return;
      const comp = rows[0];
      const prospect: ProspectRow = {
        company: String(comp.company_name),
        prospectName: '',
        jobTitle: '',
        email: '',
        phone: '',
        location: String(comp.location ?? ''),
        employees: comp.employee_count != null ? Number(comp.employee_count) : null,
        industry: String(comp.industry ?? ''),
        description: String(comp.description ?? ''),
        rawInputText: String(comp.raw_input_text ?? ''),
      };
      const [scored] = await scoreProspectsAI([prospect], icp);
      await pool.query(`UPDATE companies SET lead_score=$1, lead_score_reasons=$2::jsonb, lead_scored_at=now() WHERE id=$3 AND lead_score IS NULL`, [
        scored.score,
        JSON.stringify(scored.reasons),
        comp.id,
      ]);
      await pool.query(`INSERT INTO lead_scores (company_id, score, reasons, icp_snapshot, model) VALUES ($1,$2,$3::jsonb,$4,$5)`, [
        comp.id,
        scored.score,
        JSON.stringify(scored.reasons),
        icp,
        config.ai.provider,
      ]);
    } catch {}
  }, 8000);
}

if (process.env.NODE_ENV === 'production') {
  const distPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  app.use(express.static(distPath));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(distPath, 'index.html'));
  });
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  const pgCode = (err as { code?: string }).code;
  if (pgCode === '23514') {
    res.status(400).json({
      error:
        'Invalid value for a database check constraint (often company stage). Refresh and try again, or ask an admin to update allowed stages.',
    });
    return;
  }
  if (pgCode === '42703') {
    res.status(500).json({
      error: 'Database schema is missing a required column. Apply pending migrations.',
    });
    return;
  }
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
