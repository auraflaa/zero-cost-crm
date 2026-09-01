import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { AppConfig } from '../types';
import { api } from '../lib/api';
import { Field, inputClass, btnPrimary, btnGhost } from './ui';

interface SettingsPageProps {
  config: AppConfig;
  onSaved: () => Promise<void> | void;
}

function linesToList(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function SettingsPage({ config, onSaved }: SettingsPageProps) {
  const [brandName, setBrandName] = useState(config.brandName);
  const [brandTagline, setBrandTagline] = useState(config.brandTagline);
  const [logoUrl, setLogoUrl] = useState(config.logoUrl);
  const [stagesText, setStagesText] = useState(config.stages.join('\n'));
  const [statusesText, setStatusesText] = useState(config.contactStatuses.join('\n'));
  const [icpDescription, setIcpDescription] = useState(config.icpDescription ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBrandName(config.brandName);
    setBrandTagline(config.brandTagline);
    setLogoUrl(config.logoUrl);
    setStagesText(config.stages.join('\n'));
    setStatusesText(config.contactStatuses.join('\n'));
    setIcpDescription(config.icpDescription ?? '');
  }, [config]);

  const domainHint = useMemo(() => {
    if (config.allowAnyEmailDomain) return 'Any email domain (env ALLOWED_EMAIL_DOMAIN=*)';
    if (config.allowedEmailDomain) return `@${config.allowedEmailDomain} (from env)`;
    return 'Configured via env ALLOWED_EMAIL_DOMAIN';
  }, [config]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          brandName,
          brandTagline,
          logoUrl,
          stages: linesToList(stagesText),
          contactStatuses: linesToList(statusesText),
          icpDescription,
        }),
      });
      await onSaved();
      setMessage('Settings saved. Pipeline and forms will use the new lists.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-stone-900">Instance settings</h1>
        <p className="mt-1 text-sm text-stone-500">
          Branding and pipeline lists are stored in the database so Zero Cost CRM stays generic.
          Email domain and database URL stay in server env.
        </p>
        <p className="mt-2 text-xs text-stone-500">
          Champion status → stage mapping and discovery questions aren&apos;t on this
          screen yet — update them with{' '}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-[11px]">
            PATCH /api/settings
          </code>{' '}
          or see{' '}
          <a
            className="underline decoration-stone-300 underline-offset-2 hover:text-stone-700"
            href="https://github.com/ConvoBrains/zero-cost-crm/blob/main/docs/API.md#settings-ui-vs-api-only"
            target="_blank"
            rel="noreferrer"
          >
            docs/API.md
          </a>
          .
        </p>
      </div>

      <form
        onSubmit={submit}
        className="space-y-5 border border-[var(--color-line)] bg-[var(--color-panel)] p-5"
      >
        <Field label="Brand name">
          <input
            className={inputClass}
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            required
          />
        </Field>
        <Field label="Tagline">
          <input
            className={inputClass}
            value={brandTagline}
            onChange={(e) => setBrandTagline(e.target.value)}
          />
        </Field>
        <Field label="Logo URL">
          <input
            className={inputClass}
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="/convobrains-logo.png"
          />
        </Field>
        <Field label="Pipeline stages (one per line, top → bottom)">
          <textarea
            className={`${inputClass} min-h-48 font-mono text-xs`}
            value={stagesText}
            onChange={(e) => setStagesText(e.target.value)}
            required
          />
        </Field>
        <Field label="Contact statuses (one per line)">
          <textarea
            className={`${inputClass} min-h-48 font-mono text-xs`}
            value={statusesText}
            onChange={(e) => setStatusesText(e.target.value)}
            required
          />
        </Field>
        <Field label="Ideal Customer Profile (ICP) — used for AI lead scoring">
          <textarea
            className={`${inputClass} min-h-28 text-sm`}
            value={icpDescription}
            onChange={(e) => setIcpDescription(e.target.value)}
            placeholder="E.g. B2B SaaS companies in India, 50-500 employees, Healthcare or BFSI, looking for sales automation..."
            rows={4}
          />
          <p className="mt-1 text-xs text-stone-500">
            Voice, image and bulk imports are scored against this description via AI. Leave empty to use neutral scoring.
          </p>
        </Field>

        <div className="rounded-none border border-[var(--color-line)] bg-stone-50/70 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-stone-900">AI Engine & API Keys</h3>
            {config.aiConfigured ? (
              <span className="inline-flex items-center gap-1.5 rounded-none bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-900 ring-1 ring-emerald-300">
                <span className="h-2 w-2 rounded-full bg-emerald-600 animate-pulse" />
                Live: <span className="uppercase">{config.aiProvider}</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-none bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-300">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                Mock Mode (No API Key set)
              </span>
            )}
          </div>
          <p className="text-xs leading-relaxed text-stone-600">
            Zero Cost CRM uses AI for <strong className="text-stone-900">Voice note STT</strong>, <strong className="text-stone-900">Business Card OCR</strong>, and <strong className="text-stone-900">0–10 Lead Scoring vs ICP</strong>.
          </p>
          <div className="space-y-2 rounded-none border border-[var(--color-line)] bg-white p-3 text-xs">
            <p className="font-semibold text-stone-800">How to set up your API Key in seconds:</p>
            <p className="text-stone-600">
              Run the interactive setup helper in your terminal:
            </p>
            <pre className="rounded bg-stone-900 px-3 py-2 font-mono text-[11px] text-teal-300 overflow-x-auto">
              npm run setup:env
            </pre>
            <p className="text-stone-600 pt-1">
              Or add your key directly to <code className="font-mono text-[11px] text-stone-800">.env.local</code>:
            </p>
            <pre className="rounded bg-stone-900 px-3 py-2 font-mono text-[11px] text-teal-300 overflow-x-auto">
              AI_API_KEY=gsk_your_groq_or_openai_api_key_here
            </pre>
            <p className="text-[11px] text-stone-500">
              Keys starting with <code className="text-stone-800 font-mono">gsk_</code> (Groq), <code className="text-stone-800 font-mono">sk-</code> (OpenAI), or <code className="text-stone-800 font-mono">AIza</code> (Gemini) are auto-detected automatically.
            </p>
          </div>
        </div>

        <p className="text-xs text-stone-500">Login email policy: {domainHint}</p>

        {error ? <p className="text-sm text-rose-700">{error}</p> : null}
        {message ? <p className="text-sm text-teal-800">{message}</p> : null}

        <div className="flex gap-2">
          <button type="submit" className={btnPrimary} disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          <button
            type="button"
            className={btnGhost}
            onClick={() => {
              setBrandName(config.brandName);
              setBrandTagline(config.brandTagline);
              setLogoUrl(config.logoUrl);
              setStagesText(config.stages.join('\n'));
              setStatusesText(config.contactStatuses.join('\n'));
              setIcpDescription(config.icpDescription ?? '');
              setError(null);
              setMessage(null);
            }}
          >
            Reset
          </button>
        </div>
      </form>
    </div>
  );
}
