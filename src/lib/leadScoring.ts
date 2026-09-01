import type { ProspectRow } from '../types.js';

export interface LeadScore {
  score: number;
  reasons: string[];
  tier: 'Hot' | 'Warm' | 'Cold';
}

function tierForScore(score: number): LeadScore['tier'] {
  if (score >= 8) return 'Hot';
  if (score >= 5) return 'Warm';
  return 'Cold';
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

/**
 * Deterministic scoring against an ICP description.
 * Mirrors future server/ai/scoring.ts so client and server stay consistent.
 * No external API — mock AI that can be swapped via server/ai at runtime.
 */
export function scoreProspect(
  row: ProspectRow,
  icpDescription: string
): LeadScore {
  if (!icpDescription.trim()) {
    return { score: 5, reasons: ['No ICP configured — neutral score'], tier: 'Warm' };
  }

  const icpTokens = tokenize(icpDescription);
  const haystack = [row.industry, row.location, row.jobTitle, String(row.employees ?? ''), row.description ?? '', row.rawInputText ?? '']
    .join(' ')
    .toLowerCase();
  const hayTokens = tokenize(haystack);

  let matched = 0;
  for (const t of icpTokens) if (hayTokens.has(t)) matched += 1;

  // Industry exact match bonus
  const industryMatch = icpDescription.toLowerCase().includes(row.industry.toLowerCase()) && row.industry ? 20 : 0;

  // Employees proximity (if ICP mentions numbers)
  const icpNumbers = (icpDescription.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0);
  let employeeScore = 0;
  if (icpNumbers.length && row.employees) {
    const closest = icpNumbers.reduce((best, n) => (Math.abs(n - row.employees!) < Math.abs(best - row.employees!) ? n : best), icpNumbers[0]);
    const diff = Math.abs(closest - row.employees);
    if (diff === 0) employeeScore = 15;
    else if (diff < 20) employeeScore = 10;
    else if (diff < 100) employeeScore = 5;
  }

  const overlap = icpTokens.size ? matched / icpTokens.size : 0;
  let base = Math.round(overlap * 6); // 0-6 from token overlap (scaled for 0-10)

  let score100 = Math.min(100, base * 10 + industryMatch + employeeScore);

  // Email/phone present slight boost (completeness) — scaled
  if (row.email) score100 = Math.min(100, score100 + 3);
  if (row.phone) score100 = Math.min(100, score100 + 2);

  let score = Math.min(10, Math.max(0, Math.round(score100 / 10)));

  const reasons: string[] = [];
  if (industryMatch) reasons.push(`Industry "${row.industry}" matches ICP`);
  if (employeeScore) reasons.push(`Employee count ${row.employees} near ICP target`);
  if (overlap > 0.3) reasons.push(`${matched}/${icpTokens.size} ICP keywords matched`);
  else if (icpTokens.size) reasons.push('Low keyword overlap with ICP');
  if (!reasons.length) reasons.push('No strong ICP signals');

  return { score, reasons, tier: tierForScore(score) };
}

export function scoreProspects(rows: ProspectRow[], icpDescription: string): LeadScore[] {
  return rows.map((r) => scoreProspect(r, icpDescription));
}

export function scoreColor(score: number | null): string {
  if (score == null) return 'bg-stone-100 text-stone-600 ring-1 ring-stone-200';
  if (score >= 8) return 'bg-rose-50 text-rose-800 ring-1 ring-rose-300 font-semibold';
  if (score >= 5) return 'bg-amber-50 text-amber-900 ring-1 ring-amber-300 font-semibold';
  return 'bg-sky-50 text-sky-900 ring-1 ring-sky-300 font-semibold';
}

export function scoreLabel(score: number | null): string {
  if (score == null) return '—';
  if (score >= 8) return `${score}/10 · Hot`;
  if (score >= 5) return `${score}/10 · Warm`;
  return `${score}/10 · Cold`;
}
