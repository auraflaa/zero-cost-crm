import { config } from '../config.js';
import type { ProspectRow } from '../../src/types.js';
import { parseProspectAuto, mapIndustry, cleanEmail, cleanPhone } from '../../src/lib/importProspects.js';

/**
 * Normalizes speech-to-text transcripts by fixing common acoustic/phonetic errors:
 * - Spoken emails: "alex at acme dot com" -> "alex@acme.com"
 * - Spoken phone numbers & prefixes: "plus one five five..." -> "+1 555..."
 * - Number words for headcount: "fifty employees" -> "50 employees"
 * - Removes speech disfluencies ("um", "uh", "like you know")
 */
export function normalizeSttTranscript(raw: string): string {
  if (!raw) return '';
  let text = raw;

  // 1. Spoken email conversions
  // Multi-level TLDs e.g. .co.uk, .co.in, .org.in
  text = text.replace(/([a-zA-Z0-9._%+-]+)\s+(?:at the rate|at sign|at)\s+([a-zA-Z0-9.-]+)\s+dot\s+([a-zA-Z]{2,})\s+dot\s+([a-zA-Z]{2,})/gi, '$1@$2.$3.$4');
  text = text.replace(/([a-zA-Z0-9._%+-]+)\s+(?:at the rate|at sign|at)\s+([a-zA-Z0-9.-]+)\s+dot\s+([a-zA-Z]{2,})/gi, '$1@$2.$3');
  text = text.replace(/([a-zA-Z0-9._%+-]+)\s+dot\s+([a-zA-Z0-9._%+-]+)\s*@/gi, '$1.$2@');
  text = text.replace(/([a-zA-Z0-9._%+-]+)\s*@\s*([a-zA-Z0-9.-]+)\s*\.\s*([a-zA-Z]{2,})/gi, '$1@$2.$3');
  text = text.replace(/([a-zA-Z0-9._%+-]+)\s*@\s*([a-zA-Z0-9.-]+)\s+dot\s+([a-zA-Z]{2,})/gi, '$1@$2.$3');

  // 2. Spoken phone numbers & digits
  const wordToDigit: Record<string, string> = {
    zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9'
  };

  // Country code speech patterns: "plus one" -> "+1", "plus nine one" -> "+91"
  text = text.replace(/\bplus\s+one\b/gi, '+1');
  text = text.replace(/\bplus\s+(?:nine\s+one|91)\b/gi, '+91');
  text = text.replace(/\bplus\s+(\d+)\b/gi, '+$1');

  // Spoken double and triple digit prefixes: "double five" -> "55", "triple zero" -> "000"
  text = text.replace(/\bdouble\s+(zero|one|two|three|four|five|six|seven|eight|nine|\d)\b/gi, (_, d) => {
    const digit = wordToDigit[d.toLowerCase()] || d;
    return `${digit}${digit}`;
  });
  text = text.replace(/\btriple\s+(zero|one|two|three|four|five|six|seven|eight|nine|\d)\b/gi, (_, d) => {
    const digit = wordToDigit[d.toLowerCase()] || d;
    return `${digit}${digit}${digit}`;
  });

  // Convert sequences of 4+ spoken digits into grouped numbers
  text = text.replace(/\b((?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\s+){3,}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine))\b/gi, (match) => {
    return match.split(/\s+/).map((w) => wordToDigit[w.toLowerCase()] ?? w).join('');
  });

  // 3. Spoken employee count words
  const wordToCount: Record<string, string> = {
    ten: '10', twenty: '20', thirty: '30', forty: '40', fifty: '50',
    sixty: '60', seventy: '70', eighty: '80', ninety: '90',
    'one hundred': '100', 'two hundred': '200', 'three hundred': '300',
    'five hundred': '500', 'one thousand': '1000', 'two thousand': '2000',
    'five thousand': '5000', 'ten thousand': '10000',
  };
  for (const [w, num] of Object.entries(wordToCount)) {
    const re = new RegExp(`\\b${w}\\s+(employees|people|staff|headcount|members)\\b`, 'gi');
    text = text.replace(re, `${num} $1`);
  }

  // 4. Speech filler disfluencies removal (preserving surrounding sentence context)
  text = text.replace(/\b(um+|uh+|er+|ah+|you know what i mean|like you know|so basically)\b/gi, ' ');
  text = text.replace(/\s{2,}/g, ' ').trim();

  return text;
}

// Lead extraction: TSV/CSV, single row, or free-form spoken English with STT compensation
const SYSTEM_EXTRACT_JSON = `You are an elite, highly intelligent CRM Lead Extraction Engine with built-in Speech-to-Text (STT) noise compensation, Optical Character Recognition (OCR) correction, and entity resolution.

Your objective: Thoroughly analyze noisy transcripts, voice memos, business card OCR, meeting debriefs, or pasted unstructured text and extract ALL unique sales leads into a structured JSON object.

### EXTRACTION & NORMALIZATION GUIDELINES:

1. **Entity Extraction & Disambiguation**:
   - **company** (string, required): The target organization/company name. If not explicitly named but a business email domain is present (e.g. "sarah@apexhealth.io"), deduce the company name ("Apex Health"). Remove legal suffixes if noisy ("Inc.", "LLC", "Ltd") unless essential.
   - **prospectName** (string, required): The full name of the human contact person. Strip conversational verbs and honorifics ("Met with Dr. Sarah Connor" -> "Sarah Connor"). If no individual person is named, use "Primary Contact" or the role.
   - **jobTitle** (string): Standardized, capitalized professional title (e.g. "VP of Sales", "CTO", "Head of Growth", "Director of Product", "Account Executive", "Founder & CEO").
   - **email** (string): Clean, lowercase email address. Convert spoken forms ("alex at stripe dot com" -> "alex@stripe.com"). If unknown, return "".
   - **phone** (string): Standardized international or national phone number with digits and leading '+' if given. Convert spoken digits. If unknown, return "".
   - **location** (string): City, State, or Country (e.g. "San Francisco, CA", "London, UK", "Bengaluru"). If unknown, return "".
   - **employees** (integer or null): Approximate headcount if mentioned in words or numbers (e.g. "fifty staff" -> 50, "150 employees" -> 150). Otherwise null.
   - **industry** (string): Standard industry taxonomy:
     - "SaaS" (software, cloud platforms, B2B applications, API tools, developer platforms)
     - "Healthcare" (digital health, biotech, medical devices, hospitals, clinical)
     - "BFSI" (banking, fintech, payments, lending, insurance, capital markets)
     - "Retail" (e-commerce, D2C brands, consumer goods, apparel, retail logistics)
     - "EdTech" (education, learning platforms, universities, training)
     - "Logistics" (supply chain, trucking, freight, warehousing, fleet management)
     - "Manufacturing" (industrial equipment, hardware, automotive, electronics)
     - "Cybersecurity" (security software, compliance, identity, SOC)
     - "Other" (any other industry)
   - **description** (string): 1-2 concise, high-value sentences capturing the prospect's core business, immediate pain points, requirements, conversation context, and next step.

2. **Multi-Lead Extraction**:
   - If the input contains multiple contacts, business cards, or companies, extract EACH one as an independent object in the "leads" array. Never omit valid contacts.

3. **Speech-to-Text (STT) & Phonetic Noise Compensation**:
   - Spoken emails: "john dot doe at gmail dot com" -> "john.doe@gmail.com".
   - Spoken numbers: "plus nine one nine eight seven six..." -> "+91 9876...".
   - Phonetic company spellings: "micro soft" -> "Microsoft", "sales force" -> "Salesforce", "open ai" -> "OpenAI".
   - Filter out filler words: "um", "uh", "like", "you know", "basically", "so yeah".

### OUTPUT SCHEMA (Strict JSON):
{
  "leads": [
    {
      "company": "Company Name",
      "prospectName": "Full Name",
      "jobTitle": "Job Title / Role",
      "email": "email@domain.com",
      "phone": "+1234567890",
      "location": "City, Country",
      "employees": 100,
      "industry": "SaaS",
      "description": "Expressed strong interest in CRM automation; looking to replace legacy tool next quarter.",
      "rawInputText": "Source excerpt"
    }
  ]
}

If no leads or business information can be extracted, return {"leads": []}.`;

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
      const obj = v as Record<string, unknown>;
      for (const k of ['leads', 'data', 'prospects', 'rows', 'result', 'items']) {
        if (Array.isArray(obj[k])) return obj[k] as unknown[];
      }
      // Single object case: wrap it if it has company or prospectName
      if (typeof obj.company === 'string' || typeof obj.prospectName === 'string' || typeof obj.name === 'string') {
        return [{
          company: obj.company ?? obj.organization ?? obj.org ?? '',
          prospectName: obj.prospectName ?? obj.prospect_name ?? obj.name ?? obj.contact ?? '',
          jobTitle: obj.jobTitle ?? obj.job_title ?? obj.title ?? obj.role ?? '',
          email: obj.email ?? '',
          phone: obj.phone ?? '',
          location: obj.location ?? obj.city ?? '',
          employees: obj.employees ?? null,
          industry: obj.industry ?? '',
          description: obj.description ?? '',
          rawInputText: obj.rawInputText ?? obj.raw_input_text ?? '',
        }];
      }
      // If object contains an array somewhere, find first array value
      for (const v2 of Object.values(obj)) {
        if (Array.isArray(v2)) return v2 as unknown[];
      }
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
  // Fallback: extract first bracketed object via regex
  const mObj = cleaned.match(/\{[\s\S]*\}/);
  if (mObj) {
    try {
      const vObj = JSON.parse(mObj[0]);
      if (vObj && typeof vObj === 'object') {
        const obj = vObj as Record<string, unknown>;
        for (const k of ['leads', 'data', 'prospects', 'rows', 'result', 'items']) {
          if (Array.isArray(obj[k])) return obj[k] as unknown[];
        }
        if (obj.company || obj.prospectName || obj.name) {
          return [{
            company: obj.company ?? obj.organization ?? obj.org ?? '',
            prospectName: obj.prospectName ?? obj.prospect_name ?? obj.name ?? '',
            jobTitle: obj.jobTitle ?? obj.job_title ?? obj.title ?? obj.role ?? '',
            email: obj.email ?? '',
            phone: obj.phone ?? '',
            location: obj.location ?? '',
            employees: obj.employees ?? null,
            industry: obj.industry ?? '',
            description: obj.description ?? '',
          }];
        }
      }
    } catch {}
  }
  return null;
}

function toProspectRows(arr: unknown[], fallbackRaw: string): ProspectRow[] {
  return (arr as Record<string, unknown>[])
    .filter((x) => x && typeof x === 'object')
    .map((x) => {
      const r = x as Record<string, unknown>;
      let company = String(r.company ?? r.organization ?? r.org ?? '').trim();
      let prospectName = String(r.prospectName ?? r.prospect_name ?? r.name ?? r.contact ?? '').trim();
      // Clean up common conversational prefixes in prospectName
      prospectName = prospectName.replace(/^(?:met with|spoke with|spoke to|talking to|call with|lead:?)\s+/i, '').trim();
      // Clean up common conversational prefixes in company
      company = company.replace(/^(?:at|from|the|company:?)\s+/i, '').trim();

      // Clean email and phone
      const rawEmail = String(r.email ?? '').trim();
      const email = cleanEmail(rawEmail);
      const rawPhone = String(r.phone ?? '').trim();
      const phone = cleanPhone(rawPhone);

      // If company is missing but email has domain, infer company
      if (!company && email && email.includes('@')) {
        const domain = email.split('@')[1]?.split('.')[0];
        if (domain && !['gmail', 'yahoo', 'hotmail', 'outlook', 'example', 'mail'].includes(domain)) {
          company = domain.charAt(0).toUpperCase() + domain.slice(1);
        }
      }
      // If prospect is missing but jobTitle exists, use job title or "Lead Contact"
      if (!prospectName && (r.jobTitle || r.job_title || r.role)) {
        prospectName = String(r.jobTitle ?? r.job_title ?? r.role).trim();
      }
      if (!prospectName && company) {
        prospectName = 'Lead Contact';
      }

      // Standardize industry
      const rawIndustry = String(r.industry ?? '').trim();
      const mapped = mapIndustry(rawIndustry);
      const industry = mapped || rawIndustry;

      return {
        company,
        prospectName,
        jobTitle: String(r.jobTitle ?? r.job_title ?? r.title ?? r.role ?? '').trim(),
        email,
        phone,
        location: String(r.location ?? r.city ?? '').trim(),
        employees: r.employees != null ? Number(String(r.employees).replace(/[^0-9]/g, '')) || null : null,
        industry,
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
  let transcript = normalizeSttTranscript(input.transcript ?? '').trimStart().trim();

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
        transcript = normalizeSttTranscript(j.text ?? '').trimStart().trim();
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

  // LLM-First: Use constrained LLM when API key is available — strict JSON object with "leads" array
  if (config.ai.provider !== 'mock' && config.ai.apiKey) {
    try {
      const baseUrl = config.ai.provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
      const userPrompt = `Extract all sales leads from this input into a JSON object with a "leads" array:

"""
${transcript}
"""`;
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

  // Heuristic fallback for free-form when LLM is unavailable or unparseable
  const heuristic = heuristicFreeForm(transcript);
  if (heuristic) return { rows: [heuristic], errors: [], transcript };

  if (auto.rows.length) {
    return { rows: auto.rows.map((r) => ({ ...r, rawInputText: transcript.slice(0, 2000) })), errors: auto.errors, transcript };
  }

  return { rows: [], errors: ['Could not extract lead details. Please specify at least the company name and contact name.'], transcript };
}

function heuristicFreeForm(text: string): ProspectRow | null {
  const clean = text.trimStart().trim();
  if (!clean) return null;
  const emailMatch = clean.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/);
  const phoneMatch = clean.match(/(\+?\d[\d\s\-()]{5,}\d)/) ?? clean.match(/\b\d{7,15}\b/);
  const employeesMatch = clean.match(/(\d+)\s*(employees|people|staff)/i);
  
  // Prospect via "named X", "I am X", "My name is X", "met with X", "spoke with X"
  let prospectName = '';
  const namedMatch = clean.match(/\bnamed\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/i) ??
    clean.match(/\b(?:met with|spoke with|call with|talking to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/i);
  if (namedMatch) prospectName = namedMatch[1].trim();
  if (!prospectName) {
    const nameFrom = clean.match(/\bI am\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/i) ?? clean.match(/\bMy name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/i) ?? clean.match(/\bThis is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/i);
    if (nameFrom) prospectName = nameFrom[1].trim().replace(/\s+from$/i, '').trim();
  }
  if (!prospectName) {
    const caps = [...clean.matchAll(/\b([A-Z][a-z]{2,})\b/g)].map((m) => m[1]);
    const skip = new Set(['Today', 'Sales', 'Acme', 'Bio', 'Labs', 'Lead', 'Meeting', 'Call', 'Yesterday']);
    for (let i = caps.length - 1; i >= 0; i--) {
      const w = caps[i];
      if (!skip.has(w) && w.length >= 3) {
        prospectName = w;
        break;
      }
    }
  }

  // Company via "from X", "at X", "of X"
  let company = '';
  const compFrom = clean.match(/\bfrom\s+([^,]+?)(?:,|\s+I am|\s+email|\s+phone|\s+location|\s+\d|\s+named|\s+who|\s+is|\s+he|\s+she|$)/i) ??
    clean.match(/\bat\s+([^,]+?)(?:,|\s+I am|\s+email|\s+phone|\s+who|\s+is|$)/i) ??
    clean.match(/\bof\s+([A-Z][a-zA-Z0-9\s]+?)(?:\s+named|\s*,|\s+he|\s+she|$)/i);
  if (compFrom) {
    company = compFrom[1].trim().replace(/\s+email.*$/i, '').trim().replace(/\s+named.*$/i, '').trim();
  }
  if (!company) {
    const firstCap = clean.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/);
    if (firstCap && prospectName && !prospectName.includes(firstCap[1])) company = firstCap[1];
    else if (firstCap) company = firstCap[1];
  }

  if (!company && emailMatch) {
    const domain = emailMatch[0].split('@')[1]?.split('.')[0];
    if (domain && !['gmail', 'yahoo', 'hotmail', 'outlook', 'example'].includes(domain)) {
      company = domain.charAt(0).toUpperCase() + domain.slice(1);
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
  // Normalize inputs by stripping leading whitespace & fixing STT artifacts
  if (hasVoice) input.transcript = normalizeSttTranscript(input.transcript!).trimStart().trim();
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
