import { config } from '../config.js';
import { normalizeSttTranscript } from './extract.js';

/**
 * STT via Groq whisper-large-v3-turbo (or OpenAI) — reuses AI_API_KEY with strict handling.
 * Returns transcript text or empty. Never throws — caller decides fallback.
 */
export async function transcribeAudioBase64(
  audioBase64: string,
  mimeType = 'audio/webm'
): Promise<string> {
  if (!audioBase64 || config.ai.provider === 'mock' || !config.ai.apiKey) return '';
  try {
    const baseUrl = config.ai.provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
    const form = new FormData();
    const blob = new Blob([Buffer.from(audioBase64, 'base64')], { type: mimeType });
    const ext = mimeType.includes('mp3') ? 'mp3' : mimeType.includes('wav') ? 'wav' : mimeType.includes('m4a') ? 'm4a' : 'webm';
    form.append('file', blob, `recording.${ext}`);
    form.append('model', config.ai.whisperModel || 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.ai.apiKey}` },
      body: form as never,
    });
    if (!res.ok) return '';
    const j = (await res.json()) as { text?: string };
    return normalizeSttTranscript(j.text ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Analyse transcript against ICP + company/contact context, return score delta and summary.
 * Reuses strict JSON prompt like leadScoring but for call analysis with STT error compensation.
 */
export async function analyseTranscriptForLead(
  transcript: string,
  icpDescription: string,
  context: { companyName?: string; contactName?: string; industry?: string; stage?: string }
): Promise<{ score: number; reasons: string[]; tier: string; summary: string }> {
  const normalized = normalizeSttTranscript(transcript).trim();
  if (!normalized) return { score: 5, reasons: ['Empty transcript'], tier: 'Warm', summary: '' };
  if (!icpDescription.trim()) return { score: 5, reasons: ['No ICP configured'], tier: 'Warm', summary: normalized.slice(0, 200) };
  if (config.ai.provider === 'mock' || !config.ai.apiKey) {
    // Local heuristic: reuse simple keyword scoring + summary truncation
    const { scoreProspect } = await import('../../src/lib/leadScoring.js');
    const row = {
      company: context.companyName ?? '',
      prospectName: context.contactName ?? '',
      jobTitle: '',
      email: '',
      phone: '',
      location: '',
      employees: null,
      industry: context.industry ?? '',
      description: normalized.slice(0, 500),
      rawInputText: normalized.slice(0, 2000),
    };
    const s = scoreProspect(row as never, icpDescription);
    return { ...s, summary: normalized.slice(0, 280) };
  }
  try {
    const baseUrl = config.ai.provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
    const system = `You are a precise sales call conversation analyser with built-in tolerance for speech-to-text (STT) transcription noise and conversational disfluencies.
Input: ICP description, CRM context, and call transcript. Output ONLY a valid JSON object.
Required keys:
- "score": integer 0-10 (8-10 Hot, 5-7 Warm, 0-4 Cold)
- "reasons": string[] (1-3 concise bullet points)
- "tier": "Hot" | "Warm" | "Cold"
- "summary": 1-2 sentences summarizing key takeaway, objections, budget, or next steps (max 320 chars)

Rules: Base score on ICP alignment, prospect intent, budget, authority, and concrete next steps. Do not penalize for conversational repetition or phonetic transcription noise.`;
    const user = `ICP: """${icpDescription.trim()}"""\nContext: ${JSON.stringify(context)}\nTranscript: """${normalized.slice(0, 6000)}"""`;
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
    if (res.ok) {
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const raw = (j.choices?.[0]?.message?.content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/g, '').trim();
      const m = raw.match(/\{[\s\S]*\}/);
      const cand = m ? m[0] : raw;
      try {
        const v = JSON.parse(cand) as { score?: number; reasons?: string[]; tier?: string; summary?: string };
        if (typeof v.score === 'number') {
          let s = Number(v.score);
          if (s > 10) s = Math.round(s / 10);
          const score = Math.max(0, Math.min(10, Math.round(s)));
          return {
            score,
            reasons: Array.isArray(v.reasons) ? v.reasons.slice(0, 5).map(String) : ['Analysis complete'],
            tier: v.tier === 'Hot' || v.tier === 'Warm' || v.tier === 'Cold' ? v.tier : score >= 8 ? 'Hot' : score >= 5 ? 'Warm' : 'Cold',
            summary: String(v.summary ?? '').trim().slice(0, 320) || transcript.slice(0, 200).trim(),
          };
        }
      } catch {}
    }
  } catch {}
  // fallback (already 0-10 via local scorer)
  const { scoreProspect } = await import('../../src/lib/leadScoring.js');
  const row = {
    company: context.companyName ?? '',
    prospectName: context.contactName ?? '',
    jobTitle: '',
    email: '',
    phone: '',
    location: '',
    employees: null,
    industry: context.industry ?? '',
    description: transcript.slice(0, 500),
    rawInputText: transcript,
  };
  const s = scoreProspect(row as never, icpDescription);
  return { ...s, summary: transcript.slice(0, 280) };
}
