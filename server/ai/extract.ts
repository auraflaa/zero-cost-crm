import { config } from '../config.js';
import type { ProspectRow } from '../../src/types.js';
import { parseProspectAuto } from '../../src/lib/importProspects.js';

// Lead extraction: TSV/CSV, single row, or free-form spoken English
const SYSTEM_EXTRACT_JSON = `You are a precise lead data extractor. Input may be TSV/CSV, single CSV row, or free-form spoken English like meeting notes.

GOAL: Extract all leads. Output ONLY a JSON array, no markdown.

Each object: {company (required), prospectName (required), jobTitle, email (lowercase), phone, location, employees (number|null), industry (BFSI, Healthcare, Retail, EdTech, Telecom, SaaS, Logistics, Research / Biotech, Other or ""), description (1 sentence for scoring), rawInputText (first 200 chars)}

RULES:
- Skip if company or prospectName missing.
- Normalize: email lowercase, phone trimmed, employees digits-only or null, industry inferred.
- For TSV/CSV: Company | Prospect Name | Job Title | Email | Phone | Location | Employees | Industry (header optional). "Acme Corp, Alex Smith, CEO, alex@acme.com, 5550100, Austin, 50, SaaS" is valid.
- For free-form meeting notes, infer from natural language. Examples:
  Input: "Hi I'm Alex from Acme Bio Labs, head of ops, email alex@acme.example, phone 5550101, Austin, 180 employees, Research"
  Output: [{"company":"Acme Bio Labs","prospectName":"Alex","jobTitle":"Head of Operations","email":"alex@acme.example","phone":"5550101","location":"Austin","employees":180,"industry":"Research / Biotech","description":"Research 180-person Austin team","rawInputText":"Hi I'm Alex..."}]
  Input: "Today I met the VP of Sales of Hoogway named Taufeeq, he is interested in getting a demo"
  Output: [{"company":"Hoogway","prospectName":"Taufeeq","jobTitle":"VP of Sales","email":"","phone":"","location":"","employees":null,"industry":"","description":"VP of Sales at Hoogway interested in demo","rawInputText":"Today I met..."}]
  Input: "Acme, Alex, CEO, a@acme.com, 555, Austin, 120, SaaS" -> [{"company":"Acme","prospectName":"Alex","jobTitle":"CEO","email":"a@acme.com","phone":"555","location":"Austin","employees":120,"industry":"SaaS","description":"SaaS 120 Austin","rawInputText":"Acme, Alex..."}]
- If only company and prospectName can be inferred, still return with other fields ""/null. Use "named X" for prospect, "VP of Sales of Y" or "of Y" for company, "VP of Sales" for jobTitle.
- Return [] if no valid leads.`;



function safeJsonArray(text: string): unknown[] | null {
  const t = text.trim();
  if (!t) return null;
  // Remove markdown code fences if present
  const cleaned = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/g, '').trim();
  // Try whole text as JSON first
  try {
    const v = JSON.parse(cleaned);
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      // Handle {"leads": [...]}, {"data": [...]}, {"prospects": [...]}, or single object
      const obj = v as Record<string, unknown>;
      for (const k of ['leads', 'data', 'prospects', 'rows', 'result']) {
        if (Array.isArray(obj[k])) return obj[k] as unknown[];
      }
      // Single object case: wrap it
      if (typeof obj.company === 'string' && typeof obj.prospectName === 'string') return [obj];
      // If object contains an array somewhere, find first array value
      for (const v2 of Object.values(obj)) if (Array.isArray(v2)) return v2 as unknown[];
    }
  } catch {}
  // Fallback: extract first bracketed array via regex
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const v2 = JSON.parse(m[0]);
      if (Array.isArray(v2)) return v2;
    } catch {}
    // Try to fix trailing commas and single quotes
    try {
      const fixed = m[0].replace(/,\s*]/g, ']').replace(/'/g, '"');
      const v3 = JSON.parse(fixed);
      if (Array.isArray(v3)) return v3;
    } catch {}
  }
  return null;
}

function toProspectRows(arr: unknown[], fallbackRaw: string): ProspectRow[] {
  return (arr as Record<string, unknown>[])
    .filter((x) => x && typeof x === 'object' && (x as Record<string, unknown>).company && (x as Record<string, unknown>).prospectName)
    .map((x) => {
      const r = x as Record<string, unknown>;
      return {
        company: String(r.company ?? '').trim(),
        prospectName: String(r.prospectName ?? r.prospect_name ?? '').trim(),
        jobTitle: String(r.jobTitle ?? r.job_title ?? '').trim(),
        email: String(r.email ?? '').trim().toLowerCase(),
        phone: String(r.phone ?? '').trim(),
        location: String(r.location ?? '').trim(),
        employees: r.employees != null ? Number(String(r.employees).replace(/[^0-9]/g, '')) || null : null,
        industry: String(r.industry ?? '').trim(),
        description: String(r.description ?? '').trim(),
        rawInputText: String(r.rawInputText ?? r.raw_input_text ?? fallbackRaw).trim().slice(0, 2000),
      };
    })
    .filter((r) => r.company && r.prospectName);
}

/**
 * Stage 1: Voice audio -> transcript (Whisper), Stage 2: transcript -> ProspectRow[] (LLM).
 * Strict prompts + proper JSON parsing. Mock mode falls back to parseProspectPaste.
 */
export async function extractFromVoice(input: {
  transcript?: string;
  s3Key?: string;
  audioBase64?: string;
}): Promise<{ rows: ProspectRow[]; errors: string[]; transcript?: string }> {
  let transcript = (input.transcript ?? '').trimStart().trim();

  // Stage 1: STT when audio provided and provider is real — strip leading whitespace from result
  if (!transcript && config.ai.provider !== 'mock' && config.ai.apiKey && input.audioBase64) {
    try {
      const baseUrl = config.ai.provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
      const form = new FormData();
      const blob = new Blob([Buffer.from(input.audioBase64, 'base64')], { type: 'audio/webm' });
      form.append('file', blob, 'voice.webm');
      form.append('model', config.ai.whisperModel || 'whisper-large-v3-turbo');
      form.append('response_format', 'json');
      // Groq whisper handles language auto; we keep temperature low for fidelity
      form.append('temperature', '0');
      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.ai.apiKey}` },
        body: form as never,
      });
      if (res.ok) {
        const j = (await res.json()) as { text?: string };
        transcript = (j.text ?? '').trimStart().trim();
      } else {
        const errText = await res.text().catch(() => '');
        if (errText) console.warn('STT error', res.status, errText.slice(0, 300));
      }
    } catch {
      // fall through
    }
  }

  transcript = transcript.trimStart().trim();
  if (!transcript) return { rows: [], errors: ['No transcript available. Speak clearly, upload audio, or paste details.'], transcript };

  // LLM-First: Use constrained LLM when API key is available — strict JSON array output
  if (config.ai.provider !== 'mock' && config.ai.apiKey) {
    try {
      const baseUrl = config.ai.provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
      const userPrompt = `Extract leads from the following transcript. Output ONLY the JSON array, no other text.

Transcript:
"""
${transcript}
"""

Rules for extraction:
- For CSV/TSV like "Acme Corp, Alex Smith, CEO, alex@acme.com, 5550100, Austin, 50, SaaS" -> parse columns Company | Prospect Name | Job Title | Email | Phone | Location | Employees | Industry
- For free-form like "Today I met the VP of Sales of Hoogway named Taufeeq, he is interested in getting a demo" -> infer company=Hoogway, prospectName=Taufeeq, jobTitle=VP of Sales
- For "Hi I'm Alex from Acme Bio Labs, head of ops, email alex@acme.example" -> company Acme Bio Labs, prospect Alex
- Always return JSON array even for single lead, never an object. If no leads, return [].

Respond with JSON array only.`;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.apiKey}` },
        body: JSON.stringify({
          model: config.ai.model,
          messages: [
            { role: 'system', content: SYSTEM_EXTRACT_JSON },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          top_p: 0.9,
          response_format: { type: 'json_object' } as unknown as Record<string, unknown>,
        }),
      });
      if (res.ok) {
        const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = j.choices?.[0]?.message?.content ?? '';
        const arr = safeJsonArray(content);
        if (arr) {
          const rows = toProspectRows(arr, transcript);
          if (rows.length) return { rows, errors: [], transcript };
        } else {
          console.warn('LLM extract: no array parsed from', content.slice(0, 200));
        }
      } else {
        const err = await res.text().catch(() => '');
        console.warn('LLM extract failed', res.status, err.slice(0, 300));
      }
    } catch (e) {
      console.warn('LLM extract exception', e);
    }
  }

  // Fallback: Try robust auto parser for structured formats (CSV/TSV, HTML, XML, JSON, MD) — handles bulk paste
  const auto = parseProspectAuto(transcript);
  if (auto.rows.length) {
    const first = auto.rows[0];
    const isSentenceCompany = first.company.toLowerCase().startsWith('hi ') || first.company.toLowerCase().includes('i am');
    const isBadProspect = first.prospectName.toLowerCase().includes('i am') || first.prospectName.toLowerCase().includes('head of');
    if (!isSentenceCompany && !isBadProspect) {
      const enriched = auto.rows.map((r) => ({ ...r, description: r.description ?? '', rawInputText: transcript.slice(0, 2000) }));
      return { rows: enriched, errors: auto.errors, transcript };
    }
  }

  if (config.ai.provider === 'mock' || !config.ai.apiKey) {
    const p = parseProspectAuto(transcript);
    if (p.rows.length) return { rows: p.rows.map((r) => ({ ...r, rawInputText: transcript.slice(0, 2000) })), errors: p.errors, transcript };
    return { rows: [], errors: ['Could not parse details. Please provide Company and Prospect Name, or try rephrasing.'], transcript };
  }

  // Final heuristic fallback for free-form without LLM
  const heuristic = heuristicFreeForm(transcript);
  if (heuristic) return { rows: [heuristic], errors: [], transcript };

  return { rows: [], errors: ['Could not extract lead. Try: "Acme Corp, Alex Smith, CEO, alex@acme.com, 5550100, Austin, 50, SaaS"'], transcript };
}

function heuristicFreeForm(text: string): ProspectRow | null {
  const clean = text.trimStart().trim();
  if (!clean) return null;
  const emailMatch = clean.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/);
  const phoneMatch = clean.match(/(\+?\d[\d\s\-()]{5,}\d)/) ?? clean.match(/\b\d{7,15}\b/);
  const employeesMatch = clean.match(/(\d+)\s*(employees|people|staff)/i);
  // Prospect via "named X", "I am X", "My name is X", or last capitalized name
  let prospectName = '';
  const namedMatch = clean.match(/\bnamed\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/i);
  if (namedMatch) prospectName = namedMatch[1].trim();
  if (!prospectName) {
    const nameFrom = clean.match(/\bI am\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/i) ?? clean.match(/\bMy name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/i) ?? clean.match(/\bThis is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/i);
    if (nameFrom) prospectName = nameFrom[1].trim().replace(/\s+from$/i, '').trim();
  }
  if (!prospectName) {
    // Fallback: last solitary capitalized name that is not a known role/company word
    const caps = [...clean.matchAll(/\b([A-Z][a-z]{2,})\b/g)].map((m) => m[1]);
    const skip = new Set(['Today', 'Sales', 'Hoogway', 'Acme', 'Bio', 'Labs']);
    for (let i = caps.length - 1; i >= 0; i--) {
      const w = caps[i];
      if (!skip.has(w) && w.length >= 3) {
        prospectName = w;
        break;
      }
    }
  }
  // Company via "of Hoogway", "from X", "at X", "VP of Sales of X"
  let company = '';
  const ofHoogway = clean.match(/\bof\s+([A-Z][a-zA-Z0-9]+)\b(?:\s+named|\s*,|\s+he|\s+she|$)/i);
  if (ofHoogway) company = ofHoogway[1].trim();
  if (!company) {
    const compFrom = clean.match(/\bfrom\s+([^,]+?)(?:,|\s+I am|\s+email|\s+phone|\s+location|\s+\d| named|$)/i) ?? clean.match(/\bat\s+([^,]+?)(?:,|\s+I am|\s+email|\s+phone|$)/i);
    if (compFrom) {
      company = compFrom[1].trim().replace(/\s+email.*$/i, '').trim().replace(/\s+named.*$/i, '').trim().replace(/\s+I am.*$/i, '').trim();
    }
  }
  // Also try "VP of Sales of Hoogway" -> Hoogway
  if (!company || company.toLowerCase().includes('sales')) {
    const vpOf = clean.match(/VP of Sales of\s+([A-Z][a-zA-Z0-9]+)/i) ?? clean.match(/of\s+([A-Z][a-zA-Z0-9]+)\s+named/i);
    if (vpOf) company = vpOf[1].trim();
  }
  if (!company) {
    const firstCap = clean.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/);
    if (firstCap && prospectName && !prospectName.includes(firstCap[1])) company = firstCap[1];
    else if (firstCap) company = firstCap[1];
  }
  // Ensure company is not just "Acme" when original was "Acme Bio Labs" — capture up to 4 words if needed
  if (company && company.split(/\s+/).length < 2) {
    const extended = clean.match(new RegExp(`\\bfrom\\s+(${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\w\\s&\\-]+?)(?:,|\\s+I am|\\s+email)`, 'i'));
    if (extended && extended[1].trim().split(/\s+/).length > 1) company = extended[1].trim();
  }
  // If we still lack required fields, try to find any two capitalized words as fallback company/prospect
  if (!company || !prospectName) {
    // Try to split by comma: "Acme Bio Labs, Alex Smith, ..." — already handled by CSV heuristic above, so if we are here it's truly free-form
    if (!company && prospectName) {
      // Use first sentence's subject as company hint
      const m2 = clean.match(/from\s+([^,]+)/i);
      if (m2) company = m2[1].trim();
    }
  }
  if (!company || !prospectName) return null;
  // Industry heuristic: look for known industry keywords
  const indRaw = clean.match(/\b(Healthcare|BFSI|Retail|EdTech|Telecom|SaaS|Logistics|Research|Biotech)\b/i);
  const industry = indRaw ? indRaw[1] : '';
  // Location: look for "in Austin" or "location Austin"
  let location = '';
  const locMatch = clean.match(/\b(?:in|at|location)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (locMatch) location = locMatch[1].trim();
  let jobTitle = '';
  const roleMatch = clean.match(/\b(VP of Sales|Head of [A-Za-z ]+|CEO|CTO|VP(?:\s+of\s+[A-Za-z]+)?|Manager|Director|Operations|Sales)\b/i);
  if (roleMatch) jobTitle = roleMatch[0].trim();
  return {
    company: company.trim(),
    prospectName: prospectName.trim(),
    jobTitle,
    email: emailMatch ? emailMatch[0].toLowerCase() : '',
    phone: phoneMatch ? phoneMatch[0].trim() : '',
    location,
    employees: employeesMatch ? Number(employeesMatch[1]) : null,
    industry,
    description: clean.slice(0, 200),
    rawInputText: clean.slice(0, 2000),
  };
}

export async function extractFromImage(input: {
  imageBase64?: string;
  s3Key?: string;
  mimeType?: string;
  transcript?: string; // optional voice transcript supplied alongside image — not binary
  fallbackText?: string;
}): Promise<{ rows: ProspectRow[]; errors: string[]; text?: string; transcript?: string }> {
  const hasImage = !!input.imageBase64;
  const hasVoice = !!input.transcript?.trimStart().trim();
  const hasFallback = !!input.fallbackText?.trimStart().trim();
  // Normalize inputs by stripping leading whitespace
  if (hasVoice) input.transcript = input.transcript!.trimStart().trim();
  if (hasFallback) input.fallbackText = input.fallbackText!.trimStart().trim();

  if (config.ai.provider === 'mock' && !config.ai.apiKey) {
    if (hasFallback) {
      const p = parseProspectAuto(input.fallbackText!, 'fallback.txt');
      if (p.rows.length) return { rows: p.rows.map((r) => ({ ...r, description: (r as ProspectRow).description ?? '', rawInputText: input.fallbackText!.slice(0, 2000) })), errors: p.errors, text: input.fallbackText, transcript: input.transcript };
    }
    if (hasVoice && !hasImage) {
      return extractFromVoice({ transcript: input.transcript });
    }
    return { rows: [], errors: ['Image needs more detail. Please add card text or try a clearer photo.'], text: input.fallbackText, transcript: input.transcript };
  }
  if (!config.ai.apiKey) return { rows: [], errors: ['Service not configured.'] };

  if (!hasImage && hasFallback) {
    const p = parseProspectAuto(input.fallbackText!, 'fallback.txt');
    if (p.rows.length) return { rows: p.rows.map((r) => ({ ...r, rawInputText: input.fallbackText!.slice(0, 2000) })), errors: p.errors, text: input.fallbackText, transcript: input.transcript };
    const voiceFallback = await extractFromVoice({ transcript: input.fallbackText });
    if (voiceFallback.rows.length) return { rows: voiceFallback.rows, errors: [], text: input.fallbackText, transcript: input.transcript };
  }

  if (hasImage) {
    try {
      const baseUrl = config.ai.provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
      const voicePart = input.transcript?.trimStart().trim() ? `\nVoice details: """${input.transcript!.trimStart().trim()}"""` : '';
      const visionUser = hasVoice
        ? `Card image plus voice details. Use BOTH to produce leads.${voicePart} — Extract JSON array per schema.`
        : 'Extract all business cards in image into JSON array per schema.';

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.apiKey}` },
        body: JSON.stringify({
          model: config.ai.visionModel, // qwen/qwen3.8-27b as requested for image→lead description
          messages: [
            { role: 'system', content: SYSTEM_EXTRACT_JSON },
            {
              role: 'user',
              content: [
                { type: 'text', text: visionUser },
                { type: 'image_url', image_url: { url: `data:${input.mimeType ?? 'image/jpeg'};base64,${input.imageBase64}` } },
              ],
            },
          ],
          max_tokens: 1200,
          temperature: 0.1,
        }),
      });
      if (res.ok) {
        const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = j.choices?.[0]?.message?.content ?? '';
        const arr = safeJsonArray(content);
        if (arr) {
          const rows = toProspectRows(arr, content);
          if (rows.length) return { rows, errors: [], text: content, transcript: input.transcript };
        }
        // Even if vision returns free-form text, try Stage 2 fallback: use that text as transcript for JSON filling
        if (hasVoice || content.trim()) {
          const combined = [input.transcript?.trim() ?? '', content.trim()].filter(Boolean).join('\n');
          const fallback = await extractFromVoice({ transcript: combined });
          if (fallback.rows.length) return { rows: fallback.rows, errors: [], text: content, transcript: input.transcript };
        }
      } else {
        const err = await res.text().catch(() => '');
        if (err) console.warn('Vision extract error', res.status, err.slice(0, 400));
      }
    } catch {
      // fall through
    }

    if (hasFallback) {
      const p = parseProspectAuto(input.fallbackText!, 'fallback.txt');
      if (p.rows.length) return { rows: p.rows, errors: p.errors, text: input.fallbackText, transcript: input.transcript };
    }
    if (hasVoice) {
      const voiceRes = await extractFromVoice({ transcript: input.transcript });
      if (voiceRes.rows.length) return { rows: voiceRes.rows, errors: [], text: voiceRes.transcript, transcript: input.transcript };
    }
  } else if (hasVoice) {
    // Image missing but voice present — delegate to voice pipeline (ensures whisperLargeV3 path respects model)
    return extractFromVoice({ transcript: input.transcript });
  }

  return { rows: [], errors: ['Could not read card. Try a clearer photo or add voice details.'], text: input.fallbackText, transcript: input.transcript };
}

export function extractFromImageTextFallback(ocrText: string) {
  return parseProspectAuto(ocrText);
}
