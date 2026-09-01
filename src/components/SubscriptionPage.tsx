import { useEffect, useState } from 'react';
import { btnPrimary, btnGhost } from './ui';
import { api } from '../lib/api';

type BillingPeriod = 'monthly' | 'yearly';

interface Plan {
  id: string;
  name: string;
  tagline: string;
  priceMonthly: number | null;
  priceYearly: number | null;
  cta: string;
  ctaVariant: 'primary' | 'ghost' | 'enterprise';
  highlight?: boolean;
  badge?: string;
  features: string[];
  footnote?: string;
}

const PLANS: Plan[] = [
  {
    id: 'plus',
    name: 'Plus',
    tagline: 'For solo founders and small teams getting off Sheets.',
    priceMonthly: 19,
    priceYearly: 15,
    cta: 'Start with Plus',
    ctaVariant: 'ghost',
    features: [
      'Up to 3 users',
      '1,000 contacts & companies',
      '13-stage pipeline & Kanban',
      'Contacts, follow-ups, activity feed',
      'Bulk import — CSV, Excel, HTML, JSON, MD',
      'Dashboard & basic metrics',
      'Community support',
    ],
    footnote: 'No AI features. Upgrade for voice, image and scoring.',
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'For teams of 1–10 SDRs who live on calls.',
    priceMonthly: 49,
    priceYearly: 39,
    cta: 'Start Pro — 14 days free',
    ctaVariant: 'primary',
    highlight: true,
    badge: 'Most popular',
    features: [
      'Up to 10 users, unlimited contacts',
      'Everything in Plus',
      'Voice AI — record or upload audio, auto-transcribe with whisper-large-v3-turbo',
      'Image AI — business-card OCR with vision, plus voice+image combined',
      'AI lead scoring 0–10 vs your ICP, immediate + slow background rescoring',
      'Batch import — CSV, TSV, Excel, TXT, HTML, XML, JSON, MD with auto-delimiter',
      'Call recordings — S3 or direct upload, STT + analysis, score update',
      'Company description for richer ICP scoring',
      'Priority email support',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'For orgs that need control, compliance and scale.',
    priceMonthly: null,
    priceYearly: null,
    cta: 'Talk to founders',
    ctaVariant: 'enterprise',
    features: [
      'Unlimited users & contacts',
      'Everything in Pro',
      'SSO, SAML, SCIM & advanced roles',
      'On-prem / VPC deployment & SLA',
      'Custom ICP tuning & private LLM option',
      'Dedicated success + migration from Salesforce/Sheets',
      'Audit log, retention & compliance pack',
    ],
  },
];

const COMPARISON = [
  { label: 'Users', plus: '3', pro: '10', enterprise: 'Unlimited' },
  { label: 'Contacts', plus: '1,000', pro: 'Unlimited', enterprise: 'Unlimited' },
  { label: 'Pipeline & contacts', plus: true, pro: true, enterprise: true },
  { label: 'Bulk import (all formats)', plus: true, pro: true, enterprise: true },
  { label: 'Voice AI (STT)', plus: false, pro: true, enterprise: true },
  { label: 'Image AI (card OCR)', plus: false, pro: true, enterprise: true },
  { label: 'Voice+image combined', plus: false, pro: true, enterprise: true },
  { label: 'AI lead scoring 0–10', plus: false, pro: true, enterprise: true },
  { label: 'Call recording analysis', plus: false, pro: true, enterprise: true },
  { label: 'ICM / ICP management', plus: false, pro: true, enterprise: true },
  { label: 'SSO & compliance', plus: false, pro: false, enterprise: true },
];

function Check({ on }: { on: boolean }) {
  return on ? (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-teal-700 text-[11px] font-bold text-white">✓</span>
  ) : (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-stone-100 text-stone-400">—</span>
  );
}

export function SubscriptionPage() {
  const [period, setPeriod] = useState<BillingPeriod>('monthly');
  const [currentPlan, setCurrentPlan] = useState<string>('plus');
  const [loadingPlan, setLoadingPlan] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ plan: string } | { subscriptionPlan: string } | Record<string, unknown>>('/api/subscription')
      .then((data: Record<string, unknown>) => {
        if (cancelled) return;
        const plan = (data.plan as string) || (data.subscriptionPlan as string) || 'plus';
        setCurrentPlan(plan);
      })
      .catch(() => {
        // fallback to config
        api<{ subscriptionPlan?: string }>('/api/config')
          .then((cfg) => {
            if (!cancelled && cfg.subscriptionPlan) setCurrentPlan(cfg.subscriptionPlan);
          })
          .catch(() => {});
      })
      .finally(() => {
        if (!cancelled) setLoadingPlan(false);
      });
    // also try config as fallback for initial load
    api<{ subscriptionPlan?: string }>('/api/config')
      .then((cfg) => {
        if (!cancelled && cfg.subscriptionPlan) setCurrentPlan(cfg.subscriptionPlan);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSwitch = async (planId: string) => {
    if (planId === 'enterprise') {
      window.open('https://www.convobrains.com/contact', '_blank', 'noopener,noreferrer');
      return;
    }
    setSwitching(planId);
    setMessage(null);
    try {
      const res = await api<{ plan: string }>('/api/subscription', {
        method: 'PATCH',
        body: JSON.stringify({ plan: planId }),
      });
      setCurrentPlan(res.plan);
      setMessage(`Switched to ${res.plan} plan. Voice, Image and Lead Scoring are now ${res.plan === 'plus' ? 'locked (Plus)' : 'unlocked (Pro/Enterprise)'}.`);
      // Refresh config cache
      try {
        await api('/api/config');
      } catch {}
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Failed to switch plan. Only founders/admins can switch.');
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="space-y-3">
        <p className="text-xs font-semibold tracking-[0.14em] text-teal-700 uppercase">Subscription · Voice AI, Image AI and Lead Scoring are paid</p>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-stone-900 sm:text-4xl">Simple pricing, upgrade when you need AI</h1>
        <p className="max-w-2xl text-sm text-stone-600">
          Start free on the core CRM. Unlock <span className="font-medium text-stone-900">Voice AI</span>,{' '}
          <span className="font-medium text-stone-900">Image AI</span> and <span className="font-medium text-stone-900">AI lead scoring</span> with Pro. Access is enforced by plan — Plus sees a paywall for AI features.
        </p>
        {loadingPlan ? (
          <p className="text-xs text-stone-500">Loading current plan…</p>
        ) : (
          <p className="inline-flex items-center gap-2 rounded-none bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-900 ring-1 ring-teal-200">
            Current plan: <span className="uppercase">{currentPlan}</span> {currentPlan === 'plus' ? '· AI locked' : currentPlan === 'pro' ? '· AI unlocked' : '· Everything unlocked'}
          </p>
        )}
        {message ? <p className="rounded-none bg-amber-50 px-3 py-2 text-xs text-amber-800">{message}</p> : null}
        <div className="flex items-center gap-3 pt-1">
          <div className="inline-flex rounded-none border border-[var(--color-line)] bg-stone-50 p-1">
            <button
              type="button"
              onClick={() => setPeriod('monthly')}
              className={`rounded-none px-4 py-1.5 text-xs font-semibold transition ${period === 'monthly' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-800'}`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setPeriod('yearly')}
              className={`rounded-none px-4 py-1.5 text-xs font-semibold transition ${period === 'yearly' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-800'}`}
            >
              Yearly <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">Save 20%</span>
            </button>
          </div>
          <span className="text-xs text-stone-500">Cancel anytime. No charge today for setup.</span>
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        {PLANS.map((plan) => {
          const isCurrent = currentPlan === plan.id;
          return (
            <div
              key={plan.id}
              className={`relative flex flex-col rounded-none border bg-[var(--color-panel)] p-5 sm:p-6 ${
                plan.highlight ? 'border-teal-700 shadow-[0_0_0_1px_theme(colors.teal.700)]' : 'border-[var(--color-line)]'
              } ${isCurrent ? 'ring-1 ring-teal-700' : ''}`}
            >
              {plan.badge ? (
                <span className="absolute -top-3 left-6 rounded-none bg-teal-700 px-3 py-1 text-[11px] font-bold tracking-wide text-white uppercase">{plan.badge}</span>
              ) : null}
              {isCurrent ? (
                <span className="absolute -top-3 right-6 rounded-none bg-stone-900 px-3 py-1 text-[11px] font-bold tracking-wide text-white uppercase">Current</span>
              ) : null}
              <h2 className="font-[family-name:var(--font-display)] text-xl text-stone-900">{plan.name}</h2>
              <p className="mt-1 min-h-[2.5rem] text-xs leading-relaxed text-stone-500">{plan.tagline}</p>
              <div className="mt-4">
                {plan.priceMonthly == null ? (
                  <p className="font-[family-name:var(--font-display)] text-3xl text-stone-900">Custom</p>
                ) : (
                  <p className="flex items-baseline gap-1">
                    <span className="font-[family-name:var(--font-display)] text-3xl text-stone-900">${period === 'monthly' ? plan.priceMonthly : plan.priceYearly}</span>
                    <span className="text-sm text-stone-500">/ month</span>
                  </p>
                )}
                {plan.priceMonthly != null ? (
                  <p className="mt-1 text-xs text-stone-500">
                    {period === 'yearly' ? `Billed yearly · $${(plan.priceYearly! * 12).toLocaleString()} / year` : 'Billed monthly'}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-stone-500">Tailored pricing & terms</p>
                )}
              </div>
              {plan.id === 'enterprise' ? (
                <a href="https://www.convobrains.com/contact" target="_blank" rel="noreferrer" className={btnPrimary + ' mt-5 w-full bg-stone-900 hover:bg-black'}>
                  {plan.cta}
                </a>
              ) : (
                <button
                  type="button"
                  disabled={isCurrent || switching === plan.id}
                  onClick={() => handleSwitch(plan.id)}
                  className={(plan.ctaVariant === 'primary' ? btnPrimary : btnGhost) + ' mt-5 w-full disabled:opacity-60'}
                >
                  {switching === plan.id ? 'Switching…' : isCurrent ? 'Current plan' : plan.cta}
                </button>
              )}
              <p className="mt-2 text-center text-[11px] text-stone-400">{plan.id === 'enterprise' ? 'Response within 1 business day' : isCurrent ? 'You are on this plan' : '14-day free trial on Pro'}</p>
              <ul className="mt-6 space-y-2">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2 text-sm leading-snug text-stone-700">
                    <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-teal-50 text-[10px] font-bold text-teal-700">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {plan.footnote ? <p className="mt-4 rounded-none bg-amber-50 px-3 py-2 text-xs text-amber-800">{plan.footnote}</p> : null}
            </div>
          );
        })}
      </div>

      <section className="rounded-none border border-[var(--color-line)] bg-[var(--color-panel)]">
        <div className="border-b border-[var(--color-line)] px-5 py-4">
          <h3 className="font-[family-name:var(--font-display)] text-lg text-stone-900">Compare plans</h3>
          <p className="mt-1 text-xs text-stone-500">Plus → Pro unlocks all paid AI. Enterprise is Pro plus everything you need to run at scale.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-line)] bg-stone-50/70 text-xs tracking-wide text-stone-500">
                <th className="px-5 py-3 font-semibold uppercase">Capability</th>
                <th className="px-5 py-3 font-semibold uppercase">Plus</th>
                <th className="px-5 py-3 font-semibold uppercase">Pro</th>
                <th className="px-5 py-3 font-semibold uppercase">Enterprise</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.label} className="border-b border-[var(--color-line)]/60 last:border-0">
                  <td className="px-5 py-3 font-medium text-stone-800">{row.label}</td>
                  <td className="px-5 py-3">
                    {typeof row.plus === 'boolean' ? <Check on={row.plus} /> : <span className="text-stone-700">{row.plus}</span>}
                  </td>
                  <td className="px-5 py-3">
                    {typeof row.pro === 'boolean' ? <Check on={row.pro} /> : <span className="text-stone-700">{row.pro}</span>}
                  </td>
                  <td className="px-5 py-3">
                    {typeof row.enterprise === 'boolean' ? <Check on={row.enterprise} /> : <span className="text-stone-700">{row.enterprise}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 bg-amber-50/60 px-5 py-3">
          <p className="text-xs text-stone-600">
            <span className="font-semibold text-stone-900">Enforced:</span> Voice, Image and Lead Scoring return <code className="rounded bg-white px-1 py-0.5 text-[11px]">402 SUBSCRIPTION_REQUIRED</code> on Plus. Pro and Enterprise unlock them.
          </p>
          <a href="https://www.convobrains.com/contact" target="_blank" rel="noreferrer" className="text-xs font-semibold text-teal-800 underline-offset-2 hover:underline">
            Enterprise demo →
          </a>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-none border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
          <h4 className="text-sm font-semibold text-stone-900">What counts as paid?</h4>
          <p className="mt-1 text-xs leading-relaxed text-stone-600">
            <span className="font-medium text-stone-900">Voice</span> (record/upload → transcribe),{' '}
            <span className="font-medium text-stone-900">Image</span> (card photo → fields) and{' '}
            <span className="font-medium text-stone-900">Lead scoring 0–10 vs ICP</span> (including call analysis). Core CRM stays free.
          </p>
        </div>
        <div className="rounded-none border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
          <h4 className="text-sm font-semibold text-stone-900">How enterprise call works</h4>
          <p className="mt-1 text-xs leading-relaxed text-stone-600">
            Book at <a className="font-medium text-teal-800 hover:underline" href="https://www.convobrains.com/contact" target="_blank" rel="noreferrer">convobrains.com/contact</a>. We map your ICP, migrate your Sheets/Salesforce, and tune private LLM + on-prem if needed. Typical close in 1–2 calls.
          </p>
        </div>
        <div className="rounded-none border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
          <h4 className="text-sm font-semibold text-stone-900">No lock-in</h4>
          <p className="mt-1 text-xs leading-relaxed text-stone-600">Export anytime, cancel in Settings → Subscription. Yearly saves 20%. Prices in USD, excl. tax.</p>
        </div>
      </section>

      <section className="rounded-none border border-dashed border-[var(--color-line)] bg-stone-50/60 p-5">
        <h4 className="text-sm font-semibold text-stone-900">How gating works</h4>
        <p className="mt-1 text-xs leading-relaxed text-stone-600">
          Server checks <code className="rounded bg-white px-1 py-0.5 text-[11px]">app_settings.subscription_plan</code> on every <code className="rounded bg-white px-1 py-0.5 text-[11px]">/api/import/voice/*</code>,{' '}
          <code className="rounded bg-white px-1 py-0.5 text-[11px]">/api/import/image/*</code>, <code className="rounded bg-white px-1 py-0.5 text-[11px]">/api/ai/score</code> and <code className="rounded bg-white px-1 py-0.5 text-[11px]">/api/conversations/*/transcribe</code>. Plus gets <code className="rounded bg-white px-1 py-0.5 text-[11px]">402</code> with <code className="rounded bg-white px-1 py-0.5 text-[11px]">SUBSCRIPTION_REQUIRED</code>. Use the buttons above to switch plans instantly (admin/founder only, no payment yet).
        </p>
      </section>
    </div>
  );
}
