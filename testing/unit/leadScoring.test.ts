import { describe, expect, it } from 'vitest';
import {
  scoreProspect,
  scoreProspects,
  scoreColor,
  scoreLabel,
} from '../../src/lib/leadScoring';
import type { ProspectRow } from '../../src/types';

describe('leadScoring', () => {
  const baseProspect: ProspectRow = {
    company: 'Acme SaaS',
    prospectName: 'Jane Doe',
    jobTitle: 'VP of Sales',
    email: 'jane@acmesaas.example',
    phone: '+1 555 123 4567',
    location: 'San Francisco, CA',
    employees: 150,
    industry: 'SaaS',
    description: 'High-growth B2B SaaS company looking to scale outbound sales.',
  };

  it('returns neutral score 5 and Warm tier when ICP description is empty', () => {
    const result = scoreProspect(baseProspect, '');
    expect(result.score).toBe(5);
    expect(result.tier).toBe('Warm');
    expect(result.reasons).toEqual(['No ICP configured — neutral score']);
  });

  it('gives high score (>= 8, Hot) for matching industry, employee count, and keywords', () => {
    const icp = 'SaaS company 150 employees VP of Sales San Francisco outbound sales';
    const result = scoreProspect(baseProspect, icp);
    expect(result.score).toBeGreaterThanOrEqual(8);
    expect(result.score).toBeLessThanOrEqual(10);
    expect(result.tier).toBe('Hot');
    expect(result.reasons.some((r) => r.includes('matches ICP'))).toBe(true);
  });

  it('gives lower score (Cold) when there are no matching signals', () => {
    const prospect: ProspectRow = {
      company: 'Old Mining Corp',
      prospectName: 'Bob Miner',
      jobTitle: 'Field Worker',
      email: '',
      phone: '',
      location: 'Rural Valley',
      employees: 5,
      industry: 'Mining',
      description: 'Physical extraction of minerals',
    };
    const icp = 'Fintech software startups in New York with 50-200 employees looking for AI CRM';
    const result = scoreProspect(prospect, icp);
    expect(result.score).toBeLessThan(5);
    expect(result.tier).toBe('Cold');
  });

  it('scores multiple prospects correctly with scoreProspects', () => {
    const results = scoreProspects([baseProspect, { ...baseProspect, company: 'Beta Corp' }], 'SaaS VP of Sales 150 employees');
    expect(results).toHaveLength(2);
    expect(results[0]?.score).toBeGreaterThanOrEqual(5);
    expect(results[1]?.score).toBeGreaterThanOrEqual(5);
  });

  it('formats scoreColor and scoreLabel correctly', () => {
    expect(scoreColor(null)).toContain('stone');
    expect(scoreLabel(null)).toBe('—');

    expect(scoreColor(9)).toContain('rose');
    expect(scoreLabel(9)).toBe('Hot 9');

    expect(scoreColor(6)).toContain('amber');
    expect(scoreLabel(6)).toBe('Warm 6');

    expect(scoreColor(3)).toContain('sky');
    expect(scoreLabel(3)).toBe('Cold 3');
  });
});
