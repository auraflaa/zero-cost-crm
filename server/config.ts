/**
 * Central runtime configuration. Fail closed in production.
 */

import './loadEnv.js';

function read(name: string): string | undefined {
  const v = process.env[name];
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : undefined;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const nodeEnv = read('NODE_ENV') ?? 'development';
const isProd = nodeEnv === 'production';
const isTest = nodeEnv === 'test' || read('ALLOW_ACTIVITY_SEED') === '1';

function requireJwtSecret(): string {
  const secret = read('JWT_SECRET');
  if (secret) return secret;
  if (isProd) {
    throw new Error('JWT_SECRET is required in production');
  }
  if (isTest) {
    return 'testing-jwt-secret-not-for-prod';
  }
  throw new Error(
    'JWT_SECRET is required. Copy .env.example → .env.local (or testing/functional/.env.testing) and set a long random value.'
  );
}

/** Comma-separated domains, or "*" to allow any email domain. */
function parseAllowedEmailDomains(): { any: boolean; domains: string[] } {
  // Default: any domain (generic OSS). Set ALLOWED_EMAIL_DOMAIN for your org.
  const raw = read('ALLOWED_EMAIL_DOMAIN') ?? read('ALLOWED_EMAIL_DOMAINS') ?? '*';
  if (raw === '*') return { any: true, domains: [] };
  const domains = parseList(raw).map((d) => d.replace(/^@/, '').toLowerCase());
  if (!domains.length) return { any: true, domains: [] };
  return { any: false, domains };
}

const emailPolicy = parseAllowedEmailDomains();

const corsOrigins = parseList(read('CORS_ORIGINS'));

function resolveAiConfig() {
  const genericKey = read('AI_API_KEY');
  const groqKey = read('GROQ_API_KEY');
  const openaiKey = read('OPENAI_API_KEY');
  const geminiKey = read('GEMINI_API_KEY');
  const anthropicKey = read('ANTHROPIC_API_KEY');
  const deepseekKey = read('DEEPSEEK_API_KEY');

  const apiKey = genericKey || groqKey || openaiKey || geminiKey || anthropicKey || deepseekKey;

  let provider = read('AI_PROVIDER');
  if (!provider) {
    if (groqKey || (apiKey && apiKey.startsWith('gsk_'))) {
      provider = 'groq';
    } else if (openaiKey || (apiKey && (apiKey.startsWith('sk-proj-') || apiKey.startsWith('sk-')))) {
      provider = 'openai';
    } else if (geminiKey || (apiKey && apiKey.startsWith('AIzaSy'))) {
      provider = 'gemini';
    } else if (anthropicKey || (apiKey && apiKey.startsWith('sk-ant-'))) {
      provider = 'anthropic';
    } else if (apiKey) {
      provider = 'groq';
    } else {
      provider = 'mock';
    }
  }

  let defaultModel = 'gpt-4o-mini';
  let defaultVisionModel = 'gpt-4o-mini';
  let defaultWhisperModel = 'whisper-1';

  if (provider === 'groq') {
    defaultModel = 'llama-3.3-70b-versatile';
    defaultVisionModel = 'llama-3.2-11b-vision-preview';
    defaultWhisperModel = 'whisper-large-v3';
  } else if (provider === 'gemini') {
    defaultModel = 'gemini-1.5-flash';
    defaultVisionModel = 'gemini-1.5-flash';
    defaultWhisperModel = 'gemini-1.5-flash';
  } else if (provider === 'anthropic') {
    defaultModel = 'claude-3-5-sonnet-20241022';
    defaultVisionModel = 'claude-3-5-sonnet-20241022';
    defaultWhisperModel = 'whisper-large-v3';
  }

  return {
    provider,
    apiKey,
    model: read('AI_MODEL') ?? defaultModel,
    visionModel: read('AI_VISION_MODEL') ?? defaultVisionModel,
    whisperModel: read('AI_WHISPER_MODEL') ?? defaultWhisperModel,
  };
}

export const config = {
  nodeEnv,
  isProd,
  isTest,
  port: Number(read('PORT') ?? 4000),
  jwtSecret: requireJwtSecret(),
  allowedEmailAny: emailPolicy.any,
  allowedEmailDomains: emailPolicy.domains,
  /** Primary domain for UI copy; null when any domain is allowed. */
  primaryEmailDomain: emailPolicy.any ? null : (emailPolicy.domains[0] ?? null),
  corsOrigins,
  aws: {
    accessKeyId: read('AWS_ACCESS_KEY_ID'),
    secretAccessKey: read('AWS_SECRET_ACCESS_KEY'),
    region: read('AWS_REGION'),
    bucket: read('AWS_S3_BUCKET'),
  },
  ai: resolveAiConfig(),
} as const;

export function isAllowedEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) return false;
  if (config.allowedEmailAny) return true;
  return config.allowedEmailDomains.some((d) => normalized.endsWith(`@${d}`));
}

export function allowedEmailError(): string {
  if (config.allowedEmailAny) return 'A valid email is required.';
  if (config.allowedEmailDomains.length === 1) {
    return `Only @${config.allowedEmailDomains[0]} emails are allowed.`;
  }
  return `Only these email domains are allowed: ${config.allowedEmailDomains.map((d) => `@${d}`).join(', ')}.`;
}

export function resolveCorsOrigin(origin: string | undefined): boolean | string {
  if (!config.corsOrigins.length) {
    // Reflect request origin in development; deny cross-origin in production
    // unless CORS_ORIGINS is set (same-origin SPA + reverse proxy is fine).
    if (!isProd) return origin ?? true;
    return false;
  }
  if (!origin) return false;
  return config.corsOrigins.includes(origin) ? origin : false;
}
