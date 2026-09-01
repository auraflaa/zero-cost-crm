import { describe, expect, it } from 'vitest';
import { api, loginAs, SEED } from './helpers';

let seq = 0;
const uniq = () => `${Date.now()}-${++seq}`;

describe('subscription + AI lead scoring API', () => {
  it('allows getting and patching subscription plan by admin', async () => {
    const { token: founderToken } = await loginAs(SEED.founder);
    const { token: sdrToken } = await loginAs(SEED.sdr);

    // 1. GET /api/subscription
    const subRes = await api<{ plan: string; features: Record<string, boolean> }>('/api/subscription', {
      token: founderToken,
    });
    expect(subRes.status).toBe(200);
    expect(subRes.data.plan).toBeDefined();
    expect(typeof subRes.data.features).toBe('object');

    // 2. PATCH /api/subscription with SDR should fail (403)
    const sdrPatch = await api('/api/subscription', {
      method: 'PATCH',
      token: sdrToken,
      body: { plan: 'enterprise' },
    });
    expect(sdrPatch.status).toBe(403);

    // 3. PATCH /api/subscription with invalid plan should fail (400)
    const invalidPatch = await api('/api/subscription', {
      method: 'PATCH',
      token: founderToken,
      body: { plan: 'ultra_tier' },
    });
    expect(invalidPatch.status).toBe(400);

    // 4. PATCH /api/subscription to free, plus, pro by founder
    const freePatch = await api<{ plan: string }>('/api/subscription', {
      method: 'PATCH',
      token: founderToken,
      body: { plan: 'free' },
    });
    expect(freePatch.status).toBe(200);
    expect(freePatch.data.plan).toBe('free');

    const plusPatch = await api<{ plan: string }>('/api/subscription', {
      method: 'PATCH',
      token: founderToken,
      body: { plan: 'plus' },
    });
    expect(plusPatch.status).toBe(200);
    expect(plusPatch.data.plan).toBe('plus');

    const proPatch = await api<{ plan: string }>('/api/subscription', {
      method: 'PATCH',
      token: founderToken,
      body: { plan: 'pro' },
    });
    expect(proPatch.status).toBe(200);
    expect(proPatch.data.plan).toBe('pro');
  });

  it('allows scoring prospect batch and rescoring a company record', async () => {
    const { token } = await loginAs(SEED.founder);

    // 1. POST /api/ai/score
    const scoreRes = await api<{
      icp: string;
      scores: Array<{ score: number; reasons: string[]; tier: string }>;
    }>('/api/ai/score', {
      method: 'POST',
      token,
      body: {
        icpDescription: 'Targeting Healthcare providers and hospitals with over 100 employees',
        rows: [
          {
            company: `St. Jude Healthcare ${uniq()}`,
            prospectName: 'Dr. John Doe',
            jobTitle: 'Chief Medical Officer',
            email: 'john@stjude.example',
            phone: '+1 555 456 7890',
            location: 'Boston, MA',
            employees: 250,
            industry: 'Healthcare',
            description: 'Major regional healthcare clinic',
          },
        ],
      },
    });
    expect(scoreRes.status).toBe(200);
    expect(scoreRes.data.scores).toHaveLength(1);
    expect(scoreRes.data.scores[0]?.score).toBeGreaterThanOrEqual(0);
    expect(scoreRes.data.scores[0]?.score).toBeLessThanOrEqual(10);

    // 2. Create company and rescore via POST /api/companies/:id/score
    const compName = `Rescore Co ${uniq()}`;
    const createRes = await api<{ id: string; leadScore: number | null }>('/api/companies', {
      method: 'POST',
      token,
      body: {
        companyName: compName,
        stage: 'Lead Added',
        industry: 'Healthcare',
        location: 'Boston, MA',
        employeeCount: 200,
        description: 'Hospital network requiring AI lead triage',
      },
    });
    expect(createRes.status).toBe(201);
    const companyId = createRes.data.id;

    const rescoreRes = await api<{ id: string; leadScore: number | null; leadScoreReasons: string[] }>(
      `/api/companies/${companyId}/score`,
      {
        method: 'POST',
        token,
      }
    );
    expect(rescoreRes.status).toBe(200);
    expect(rescoreRes.data.leadScore).toBeGreaterThanOrEqual(0);
    expect(rescoreRes.data.leadScore).toBeLessThanOrEqual(10);

    // Cleanup
    await api(`/api/companies/${companyId}`, { method: 'DELETE', token });
  });
});
