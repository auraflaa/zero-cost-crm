import { config } from '../config.js';
import type { ProspectRow } from '../../src/types.js';
import { scoreProspect as localScore } from '../../src/lib/leadScoring.js';

/**
 * Provider-agnostic scoring. For `mock` (default) uses deterministic local scorer.
 * When AI_PROVIDER != 'mock' and API key present, calls external AI API.
 */
export async function scoreProspectsAI(
  rows: ProspectRow[],
  icpDescription: string
): Promise<{ score: number; reasons: string[]; tier: string }[]> {
  if (!icpDescription.trim()) {
    return rows.map(() => ({ score: 5, reasons: ['No ICP configured'], tier: 'Warm' }));
  }

  if (config.ai.provider === 'mock' || !config.ai.apiKey) {
    return rows.map((r) => localScore(r, icpDescription));
  }

  try {
    const system = `You are an expert sales lead and ICP matching engine.
Input: ICP description and a list of prospect leads (which may have originated from spoken voice notes or OCR).
Return a JSON object with a "scores" array.

Schema:
{
  "scores": [
    {
      "score": number (integer 0-10),
      "reasons": string[] (1-3 concise reasons explaining ICP fit),
      "tier": "Hot" | "Warm" | "Cold"
    }
  ]
}

Rules:
- Score tiers: 8-10 Hot, 5-7 Warm, 0-4 Cold.
- Evaluate: Industry fit, company size / employee count, geographic location, title/decision-maker seniority, pain point relevance, contact detail completeness.
- Note: Leads may contain minor phonetic/STT transcription artifacts. Evaluate semantic business intent fairly.
- The "scores" array length must equal input leads count, in the exact same order.`;
    const user = `ICP: """${icpDescription.trim()}"""` + `\n\nLeads to score (${rows.length}):\n${JSON.stringify(rows, null, 2)}\n\nReturn JSON object with "scores" array (score 0-10), same order.`;
    const baseUrl = config.ai.provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.apiKey}` },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' } as unknown as Record<string, unknown>,
      }),
    });
    if (!res.ok) throw new Error(`AI ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    // Reuse robust parser
    const tryParseArray = (txt: string): unknown[] | null => {
      const clean = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/g, '').trim();
      try {
        const v = JSON.parse(clean);
        if (Array.isArray(v)) return v;
        if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          for (const k of ['scores', 'leads', 'data', 'result', 'scoring', 'items']) if (Array.isArray(o[k])) return o[k] as unknown[];
          if (typeof o.score === 'number') return [o];
        }
      } catch {}
      const m = clean.match(/\[[\s\S]*\]/);
      if (m) try { const v2 = JSON.parse(m[0]); if (Array.isArray(v2)) return v2; } catch {}
      return null;
    };
    const parsed = tryParseArray(content);
    if (parsed && Array.isArray(parsed) && parsed.length === rows.length) {
      const normalized = (parsed as Record<string, unknown>[]).map((p) => {
        let rawScore = Number((p as Record<string, unknown>).score);
        if (!Number.isFinite(rawScore)) rawScore = 5;
        // If model still returns 0-100, rescale to 0-10
        if (rawScore > 10) rawScore = Math.round(rawScore / 10);
        const score = Math.max(0, Math.min(10, Math.round(rawScore)));
        return {
          score,
          reasons: Array.isArray((p as Record<string, unknown>).reasons) ? ((p as Record<string, unknown>).reasons as string[]).slice(0, 3).map(String) : ['Scored against ICP'],
          tier: ['Hot', 'Warm', 'Cold'].includes(String((p as Record<string, unknown>).tier)) ? String((p as Record<string, unknown>).tier) : score >= 8 ? 'Hot' : score >= 5 ? 'Warm' : 'Cold',
        };
      });
      return normalized as { score: number; reasons: string[]; tier: string }[];
    }
    throw new Error('Invalid AI response shape');
  } catch {
    return rows.map((r) => localScore(r, icpDescription));
  }
}
