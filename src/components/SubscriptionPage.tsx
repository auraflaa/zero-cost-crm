import { useEffect, useState } from 'react';
import { btnPrimary, btnGhost, Modal } from './ui';
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
    id: 'free',
    name: 'Free',
    tagline: 'Core CRM free forever. Perfect for solo founders getting started.',
    priceMonthly: 0,
    priceYearly: 0,
    cta: 'View Plan Details',
    ctaVariant: 'ghost',
    features: [
      '1 user, up to 500 contacts',
      '13-stage pipeline & Kanban',
      'Contacts, follow-ups & call queue',
      'Basic CSV/TSV table import',
      'Activity log & dashboard metrics',
      'Community support',
    ],
    footnote: 'Basic CRM is 100% free forever. Upgrade for Voice, Image and AI Lead Scoring.',
  },
  {
    id: 'plus',
    name: 'Plus',
    tagline: 'For early sales teams wanting essential AI with starter quotas.',
    priceMonthly: 19,
    priceYearly: 15,
    cta: 'View Plan Details',
    ctaVariant: 'ghost',
    features: [
      'Up to 3 users, 2,500 contacts',
      'Everything in Free',
      'Voice AI extraction (50 notes / mo)',
      'Image card OCR (50 scans / mo)',
      'AI lead scoring (200 leads / mo)',
      'Voice + Image combined extraction',
      'Multi-format import (Excel, JSON, MD)',
      'Standard email support',
    ],
    footnote: 'Starter AI quotas. Upgrade to Pro for high volume & call recordings.',
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'For high-velocity SDR teams who need high limits & call analysis.',
    priceMonthly: 49,
    priceYearly: 39,
    cta: 'Current Plan Active',
    ctaVariant: 'primary',
    highlight: true,
    badge: 'Active plan',
    features: [
      'Up to 10 users, unlimited contacts',
      'Everything in Plus',
      'Voice AI extraction (500 notes / mo)',
      'Image card OCR (500 scans / mo)',
      'AI lead scoring (unlimited volume)',
      'Call recording STT & analysis',
      'Company description for ICP scoring',
      'Priority email support',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'For orgs that need control, compliance and unlimited scale.',
    priceMonthly: null,
    priceYearly: null,
    cta: 'Talk to Enterprise',
    ctaVariant: 'enterprise',
    features: [
      'Unlimited users & unlimited contacts',
      'Everything in Pro',
      'Unlimited Voice, Image & Scoring volume',
      'SSO, SAML, SCIM & custom roles',
      'On-prem / VPC deployment & SLA',
      'Custom ICP tuning & private LLM option',
      'Dedicated success & migration assistance',
    ],
  },
];

const COMPARISON = [
  { label: 'Users', free: '1', plus: '3', pro: '10', enterprise: 'Unlimited' },
  { label: 'Contacts', free: '500', plus: '2,500', pro: 'Unlimited', enterprise: 'Unlimited' },
  { label: 'Pipeline & contacts', free: true, plus: true, pro: true, enterprise: true },
  { label: 'Basic CSV/TSV import', free: true, plus: true, pro: true, enterprise: true },
  { label: 'Multi-format import (Excel, JSON, MD)', free: false, plus: true, pro: true, enterprise: true },
  { label: 'Voice AI lead extraction', free: false, plus: '50 / mo', pro: '500 / mo', enterprise: 'Unlimited' },
  { label: 'Image AI (card OCR)', free: false, plus: '50 / mo', pro: '500 / mo', enterprise: 'Unlimited' },
  { label: 'Voice+image combined', free: false, plus: true, pro: true, enterprise: true },
  { label: 'AI lead scoring 0–10 vs ICP', free: false, plus: '200 / mo', pro: 'Unlimited', enterprise: 'Unlimited' },
  { label: 'Call recording STT & analysis', free: false, plus: false, pro: true, enterprise: true },
  { label: 'SSO & compliance pack', free: false, plus: false, pro: false, enterprise: true },
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
  const [currentPlan, setCurrentPlan] = useState<string>('pro');
  const [loadingPlan, setLoadingPlan] = useState(true);
  const [selectedPlanDetails, setSelectedPlanDetails] = useState<Plan | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ plan: string } | { subscriptionPlan: string } | Record<string, unknown>>('/api/subscription')
      .then((data: Record<string, unknown>) => {
        if (cancelled) return;
        const plan = (data.plan as string) || (data.subscriptionPlan as string) || 'pro';
        setCurrentPlan(plan);
      })
      .catch(() => {
        api<{ subscriptionPlan?: string }>('/api/config')
          .then((cfg) => {
            if (!cancelled && cfg.subscriptionPlan) setCurrentPlan(cfg.subscriptionPlan);
          })
          .catch(() => {});
      })
      .finally(() => {
        if (!cancelled) setLoadingPlan(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePlanClick = (plan: Plan) => {
    setSelectedPlanDetails(plan);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header className="flex flex-col items-center text-center space-y-3.5 pt-2">
        <p className="text-xs font-semibold tracking-[0.14em] text-teal-700 uppercase">
          Subscription · Free Core CRM + Tiered AI Plans
        </p>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-stone-900 sm:text-4xl">
          Simple pricing, upgrade when you need AI
        </h1>
        <p className="mx-auto max-w-2xl text-sm leading-relaxed text-stone-600">
          Core CRM features are <span className="font-medium text-stone-900">100% free forever</span>. Add <span className="font-medium text-stone-900">Plus</span> for starter AI quotas or <span className="font-medium text-stone-900">Pro</span> for high-volume Voice AI, Image OCR, and unlimited AI Lead Scoring.
        </p>
        {loadingPlan ? (
          <p className="text-xs text-stone-500">Loading current plan…</p>
        ) : (
          <div className="flex justify-center">
            <p className="inline-flex items-center gap-2 rounded-none bg-teal-50 px-3.5 py-1.5 text-xs font-semibold text-teal-900 ring-1 ring-teal-200">
              Current plan: <span className="uppercase">{currentPlan}</span> {currentPlan === 'free' ? '· Core CRM Free' : currentPlan === 'plus' ? '· Starter AI Active' : currentPlan === 'pro' ? '· High AI Limits Active' : '· Everything Unlocked'}
            </p>
          </div>
        )}
        <div className="flex flex-col items-center justify-center gap-2 pt-2">
          <div className="inline-flex rounded-none border border-[var(--color-line)] bg-stone-50 p-1 shadow-sm">
            <button
              type="button"
              onClick={() => setPeriod('monthly')}
              className={`rounded-none px-5 py-2 text-xs font-semibold transition ${period === 'monthly' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-800'}`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setPeriod('yearly')}
              className={`rounded-none px-5 py-2 text-xs font-semibold transition ${period === 'yearly' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-800'}`}
            >
              Yearly <span className="ml-1.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">Save 20%</span>
            </button>
          </div>
          <span className="text-xs text-stone-500">Cancel anytime. No charge today for setup.</span>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
                {plan.priceMonthly === null ? (
                  <p className="font-[family-name:var(--font-display)] text-3xl text-stone-900">Custom</p>
                ) : plan.priceMonthly === 0 ? (
                  <p className="flex items-baseline gap-1">
                    <span className="font-[family-name:var(--font-display)] text-3xl text-stone-900">$0</span>
                    <span className="text-sm text-stone-500">/ forever</span>
                  </p>
                ) : (
                  <p className="flex items-baseline gap-1">
                    <span className="font-[family-name:var(--font-display)] text-3xl text-stone-900">${period === 'monthly' ? plan.priceMonthly : plan.priceYearly}</span>
                    <span className="text-sm text-stone-500">/ month</span>
                  </p>
                )}
                {plan.priceMonthly != null && plan.priceMonthly > 0 ? (
                  <p className="mt-1 text-xs text-stone-500">
                    {period === 'yearly' ? `Billed yearly · $${(plan.priceYearly! * 12).toLocaleString()} / yr` : 'Billed monthly'}
                  </p>
                ) : plan.priceMonthly === 0 ? (
                  <p className="mt-1 text-xs text-stone-500">Free core features forever</p>
                ) : (
                  <p className="mt-1 text-xs text-stone-500">Tailored pricing & terms</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => handlePlanClick(plan)}
                className={(isCurrent ? btnPrimary : plan.id === 'enterprise' ? btnPrimary + ' bg-stone-900 hover:bg-black' : btnGhost) + ' mt-5 w-full'}
              >
                {isCurrent ? 'Current Plan Active' : plan.cta}
              </button>
              <p className="mt-2 text-center text-[11px] text-stone-400">{plan.id === 'enterprise' ? 'Custom SLA & deployment' : isCurrent ? 'Active on your account' : 'View plan overview'}</p>
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
          <h3 className="font-[family-name:var(--font-display)] text-lg text-stone-900">Compare plan capabilities & limits</h3>
          <p className="mt-1 text-xs text-stone-500">Free covers core CRM forever. Plus adds starter AI quotas, while Pro gives you high-capacity volume and call recording intelligence.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-line)] bg-stone-50/70 text-xs tracking-wide text-stone-500">
                <th className="px-5 py-3 font-semibold uppercase">Capability</th>
                <th className="px-5 py-3 font-semibold uppercase">Free ($0)</th>
                <th className="px-5 py-3 font-semibold uppercase">Plus ($19/mo)</th>
                <th className="px-5 py-3 font-semibold uppercase">Pro ($49/mo)</th>
                <th className="px-5 py-3 font-semibold uppercase">Enterprise</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.label} className="border-b border-[var(--color-line)]/60 last:border-0">
                  <td className="px-5 py-3 font-medium text-stone-800">{row.label}</td>
                  <td className="px-5 py-3">
                    {typeof row.free === 'boolean' ? <Check on={row.free} /> : <span className="text-stone-700">{row.free}</span>}
                  </td>
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
            <span className="font-semibold text-stone-900">Enforced:</span> Free users have unlimited core CRM. Plus/Pro/Enterprise tiers unlock AI voice extraction, card OCR, and ICP scoring.
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
          <code className="rounded bg-white px-1 py-0.5 text-[11px]">/api/import/image/*</code>, <code className="rounded bg-white px-1 py-0.5 text-[11px]">/api/ai/score</code> and <code className="rounded bg-white px-1 py-0.5 text-[11px]">/api/conversations/*/transcribe</code>. Pro tier includes unlimited lead scoring, 500 voice/image extractions/mo, and sales call analysis.
        </p>
      </section>

      <Modal
        open={!!selectedPlanDetails}
        title={
          selectedPlanDetails?.id === 'free' || selectedPlanDetails?.id === 'plus'
            ? 'Plan Comparison & Notice'
            : selectedPlanDetails?.id === 'enterprise'
            ? 'Enterprise Plan Overview'
            : 'Active Pro Plan Overview'
        }
        onClose={() => setSelectedPlanDetails(null)}
        wide
      >
        {selectedPlanDetails ? (
          <div className="space-y-5">
            {selectedPlanDetails.id === 'free' || selectedPlanDetails.id === 'plus' ? (
              <div className="space-y-4">
                <div className="rounded-none border border-emerald-300 bg-emerald-50/90 p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-xs font-bold text-white">★</span>
                    <div>
                      <h3 className="text-sm font-bold text-emerald-950">
                        You already have a better plan: Pro Tier Active
                      </h3>
                      <p className="mt-1 text-xs text-emerald-900 leading-relaxed">
                        Your CRM instance is currently powered by the <span className="font-semibold">Pro Plan ($49/mo)</span>, which includes our highest AI limits, full call recording analysis, and team quotas. Switching to the <span className="font-semibold">{selectedPlanDetails.name}</span> plan would significantly restrict your capabilities.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="rounded-none border border-[var(--color-line)] bg-stone-50/60 p-4">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-stone-600 mb-2.5">
                    What you would lose if downgrading to {selectedPlanDetails.name}:
                  </h4>
                  <ul className="space-y-2.5 text-xs text-stone-700">
                    <li className="flex items-start gap-2">
                      <span className="text-rose-600 font-bold">✕</span>
                      <span>
                        <strong className="text-stone-900">Voice AI Extraction:</strong> Drops from <span className="font-semibold text-teal-800">500 notes/mo</span> down to {selectedPlanDetails.id === 'free' ? <span className="text-rose-700 font-semibold">0 (Locked in Free)</span> : <span className="font-semibold">50 notes/mo in Plus</span>}.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-rose-600 font-bold">✕</span>
                      <span>
                        <strong className="text-stone-900">Business Card OCR:</strong> Drops from <span className="font-semibold text-teal-800">500 scans/mo</span> down to {selectedPlanDetails.id === 'free' ? <span className="text-rose-700 font-semibold">0 (Locked in Free)</span> : <span className="font-semibold">50 scans/mo in Plus</span>}.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-rose-600 font-bold">✕</span>
                      <span>
                        <strong className="text-stone-900">AI Lead Scoring:</strong> Drops from <span className="font-semibold text-teal-800">Unlimited volume</span> down to {selectedPlanDetails.id === 'free' ? <span className="text-rose-700 font-semibold">0 (Locked in Free)</span> : <span className="font-semibold">200 leads/mo in Plus</span>}.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-rose-600 font-bold">✕</span>
                      <span>
                        <strong className="text-stone-900">Sales Call Recording STT & AI Analysis:</strong> <span className="font-semibold text-teal-800">Fully active on Pro</span> ➔ {selectedPlanDetails.id === 'free' ? <span className="text-rose-700 font-semibold">Locked in Free</span> : <span className="text-rose-700 font-semibold">Locked in Plus (Pro-only feature)</span>}.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-rose-600 font-bold">✕</span>
                      <span>
                        <strong className="text-stone-900">Team Member Capacity:</strong> Supports <span className="font-semibold text-teal-800">up to 10 SDR seats</span> ➔ {selectedPlanDetails.id === 'free' ? <span className="text-stone-600">1 single user</span> : <span className="text-stone-600">Up to 3 users</span>}.
                      </span>
                    </li>
                  </ul>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-[var(--color-line)]">
                  <button
                    type="button"
                    className={btnPrimary}
                    onClick={() => setSelectedPlanDetails(null)}
                  >
                    Keep My Pro Plan (Recommended)
                  </button>
                </div>
              </div>
            ) : selectedPlanDetails.id === 'enterprise' ? (
              <div className="space-y-4">
                <div className="rounded-none border border-stone-300 bg-stone-900 text-white p-4">
                  <h3 className="text-sm font-bold">Custom Enterprise Scale & Compliance</h3>
                  <p className="mt-1 text-xs text-stone-300 leading-relaxed">
                    Designed for mid-market and enterprise sales organizations requiring dedicated infrastructure, SAML SSO, on-prem VPC hosting, custom ICP tuning, and unlimited AI quotas.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 text-xs">
                  <div className="rounded-none border border-[var(--color-line)] p-3 space-y-1">
                    <h5 className="font-bold text-stone-900">Dedicated Scale</h5>
                    <p className="text-stone-600">Unlimited users, contacts, audio transcription hours, and card scans.</p>
                  </div>
                  <div className="rounded-none border border-[var(--color-line)] p-3 space-y-1">
                    <h5 className="font-bold text-stone-900">Security & Compliance</h5>
                    <p className="text-stone-600">SSO/SAML 2.0, SCIM provisioning, custom RBAC permissions, and audit trails.</p>
                  </div>
                  <div className="rounded-none border border-[var(--color-line)] p-3 space-y-1">
                    <h5 className="font-bold text-stone-900">Custom AI Models</h5>
                    <p className="text-stone-600">Fine-tuned ICP scoring models and private on-prem LLM inference support.</p>
                  </div>
                  <div className="rounded-none border border-[var(--color-line)] p-3 space-y-1">
                    <h5 className="font-bold text-stone-900">Dedicated SLA & Support</h5>
                    <p className="text-stone-600">99.9% uptime SLA, 1-hour priority support response, and migration assistance.</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-[var(--color-line)]">
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={() => setSelectedPlanDetails(null)}
                  >
                    Close
                  </button>
                  <a
                    href="https://www.convobrains.com/contact"
                    target="_blank"
                    rel="noreferrer"
                    className={btnPrimary + ' bg-stone-900 hover:bg-black'}
                  >
                    Contact Enterprise Sales →
                  </a>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-none border border-teal-300 bg-teal-50 p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-700 text-xs font-bold text-white">✓</span>
                    <div>
                      <h3 className="text-sm font-bold text-teal-950">
                        Pro Plan Active · All Advanced AI Features Unlocked
                      </h3>
                      <p className="mt-1 text-xs text-teal-900 leading-relaxed">
                        Your account has full access to high-volume Voice AI note extraction, business card OCR, unlimited ICP lead scoring, and sales call conversation analysis.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="rounded-none border border-[var(--color-line)] bg-stone-50/50 p-4 space-y-2 text-xs">
                  <h4 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">Active Plan Inclusions:</h4>
                  <ul className="grid gap-2 sm:grid-cols-2 text-stone-700">
                    <li className="flex items-center gap-1.5"><span className="text-teal-700 font-bold">✓</span> 500 Voice AI extractions / month</li>
                    <li className="flex items-center gap-1.5"><span className="text-teal-700 font-bold">✓</span> 500 Business card scans / month</li>
                    <li className="flex items-center gap-1.5"><span className="text-teal-700 font-bold">✓</span> Unlimited AI lead scoring vs ICP</li>
                    <li className="flex items-center gap-1.5"><span className="text-teal-700 font-bold">✓</span> Call recording STT & conversation analysis</li>
                    <li className="flex items-center gap-1.5"><span className="text-teal-700 font-bold">✓</span> Up to 10 SDR seats & unlimited contacts</li>
                    <li className="flex items-center gap-1.5"><span className="text-teal-700 font-bold">✓</span> Priority email support</li>
                  </ul>
                </div>

                <div className="flex justify-end pt-2 border-t border-[var(--color-line)]">
                  <button
                    type="button"
                    className={btnPrimary}
                    onClick={() => setSelectedPlanDetails(null)}
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
