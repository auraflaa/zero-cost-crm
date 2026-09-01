/**
 * Robust prospect parser — handles CSV, TSV, Excel, TXT, HTML, XML, JSON, MD
 * with flexible header mapping and delimiter auto-detection.
 */

import type { Industry, ProspectRow } from '../types.js';

export function cleanEmail(raw: string): string {
  return raw.trim().replace(/\+1$/, '').replace(/\+\d+$/, '').toLowerCase();
}

export function cleanPhone(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export function mapIndustry(raw: string): Industry | '' {
  const s = raw.toLowerCase().replace(/[^a-z0-9\s&]/g, ' ');
  if (/hospital|health|care|medical|pharma/.test(s)) return 'Healthcare';
  if (/biotech|research|genome|lab/.test(s)) return 'Research / Biotech';
  if (/retail|cosmetic|wholesale|shop/.test(s)) return 'Retail';
  if (/bank|fintech|insurance|bfsi/.test(s)) return 'BFSI';
  if (/saas|software|tech/.test(s)) return 'SaaS';
  if (/edu|edtech/.test(s)) return 'EdTech';
  if (/telecom/.test(s)) return 'Telecom';
  if (/logistics|fleet|shipping/.test(s)) return 'Logistics';
  if (!raw.trim()) return '';
  return 'Other';
}

// Header aliases for flexible mapping
const HEADER_ALIASES: Record<string, keyof ProspectRow> = {
  company: 'company',
  'company name': 'company',
  organisation: 'company',
  organization: 'company',
  'prospect name': 'prospectName',
  prospect: 'prospectName',
  'contact name': 'prospectName',
  name: 'prospectName',
  'job title': 'jobTitle',
  title: 'jobTitle',
  role: 'jobTitle',
  designation: 'jobTitle',
  email: 'email',
  'email address': 'email',
  'e-mail': 'email',
  phone: 'phone',
  'phone number': 'phone',
  mobile: 'phone',
  tel: 'phone',
  location: 'location',
  city: 'location',
  address: 'location',
  place: 'location',
  employees: 'employees',
  'employee count': 'employees',
  staff: 'employees',
  size: 'employees',
  headcount: 'employees',
  industry: 'industry',
  sector: 'industry',
  vertical: 'industry',
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim();
}

function headerToField(header: string): keyof ProspectRow | null {
  const n = normalizeHeader(header);
  if (HEADER_ALIASES[n]) return HEADER_ALIASES[n];
  // fuzzy contains
  for (const [alias, field] of Object.entries(HEADER_ALIASES)) {
    if (n.includes(alias) || alias.includes(n)) return field;
  }
  return null;
}

function splitLineSmart(line: string): string[] {
  // Try tab first (most reliable for Sheets)
  if (line.includes('\t')) return line.split('\t').map((c) => c.trim());
  // Detect delimiter: try common delimiters and pick one with consistent cols
  const candidates = [',', ';', '|', '\t'];
  let best: string[] | null = null;
  let bestScore = 0;
  for (const delim of candidates) {
    if (!line.includes(delim)) continue;
    const cells = splitWithDelimiter(line, delim);
    if (cells.length > bestScore) {
      bestScore = cells.length;
      best = cells;
    }
  }
  if (best && best.length >= 2) return best;
  // fallback to comma-aware split
  return splitWithDelimiter(line, ',');
}

function splitWithDelimiter(line: string, delim: string): string[] {
  if (delim === '\t') return line.split('\t').map((c) => c.trim());
  const cells: string[] = [];
  let cur = '';
  let inQ = false;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && !inQ) {
      inQ = true;
      quote = ch;
      continue;
    }
    if (ch === quote && inQ) {
      // handle escaped quote
      if (line[i + 1] === quote) {
        cur += ch;
        i++;
        continue;
      }
      inQ = false;
      quote = '';
      continue;
    }
    if (ch === delim && !inQ) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isHeaderRow(cells: string[]): boolean {
  const joined = cells.join(' ').toLowerCase();
  // at least 2 header-like tokens
  let hits = 0;
  for (const alias of Object.keys(HEADER_ALIASES)) {
    if (joined.includes(alias)) hits++;
  }
  return hits >= 2 || (joined.includes('company') && (joined.includes('prospect') || joined.includes('email') || joined.includes('job')));
}

function parseEmployees(raw: string): number | null {
  const n = Number(String(raw).replace(/[^0-9]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Flexible row maker that can handle header-mapped or positional
function cellsToProspectFlexible(cells: string[], headerMap: Map<number, keyof ProspectRow> | null, lineNo: number): { row?: ProspectRow; error?: string } {
  const minCols = headerMap ? 2 : 4;
  if (cells.length < minCols) {
    return { error: `Line ${lineNo}: too few columns — skipped.` };
  }

  let company = '';
  let prospectName = '';
  let jobTitle = '';
  let email = '';
  let phone = '';
  let location = '';
  let employees: number | null = null;
  let industry = '';

  if (headerMap && headerMap.size > 0) {
    for (let i = 0; i < cells.length; i++) {
      const field = headerMap.get(i);
      if (!field) continue;
      const val = cells[i] ?? '';
      switch (field) {
        case 'company':
          company = val;
          break;
        case 'prospectName':
          prospectName = val;
          break;
        case 'jobTitle':
          jobTitle = val;
          break;
        case 'email':
          email = cleanEmail(val);
          break;
        case 'phone':
          phone = cleanPhone(val);
          break;
        case 'location':
          location = val;
          break;
        case 'employees':
          employees = parseEmployees(val);
          break;
        case 'industry':
          industry = val;
          break;
      }
    }
  } else {
    // Positional fallback: assume order Company | Prospect Name | Job Title | Email | Phone | Location | Employees | Industry
    // But be flexible: if less than 8 cols, try to infer email/phone positions
    if (cells.length >= 8) {
      company = cells[0] ?? '';
      prospectName = cells[1] ?? '';
      jobTitle = cells[2] ?? '';
      email = cleanEmail(cells[3] ?? '');
      phone = cleanPhone(cells[4] ?? '');
      location = cells[5] ?? '';
      employees = parseEmployees(cells[6] ?? '');
      industry = cells[7] ?? '';
    } else {
      // Try to infer by content: find email, phone, employees
      company = cells[0] ?? '';
      prospectName = cells[1] ?? '';
      for (let i = 2; i < cells.length; i++) {
        const v = cells[i];
        if (!email && v.includes('@')) email = cleanEmail(v);
        else if (!phone && /^[\d\s()+-]{7,}$/.test(v)) phone = cleanPhone(v);
        else if (employees == null && /^\d+$/.test(v.replace(/[^0-9]/g, '')) && Number(v.replace(/[^0-9]/g, '')) > 0 && Number(v.replace(/[^0-9]/g, '')) < 1000000) employees = parseEmployees(v);
        else if (!jobTitle && i === 2) jobTitle = v;
        else if (!location) location = v;
        else if (!industry) industry = v;
      }
      // If still missing, use positional as fallback
      if (!jobTitle && cells[2]) jobTitle = cells[2];
      if (!email && cells[3]) email = cleanEmail(cells[3]);
      if (!phone && cells[4]) phone = cleanPhone(cells[4]);
      if (!location && cells[5]) location = cells[5];
      if (employees == null && cells[6]) employees = parseEmployees(cells[6]);
      if (!industry && cells[7]) industry = cells[7];
    }
  }

  if (!company.trim() || !prospectName.trim()) {
    return { error: `Line ${lineNo}: missing company or prospect name — skipped.` };
  }

  return {
    row: {
      company: company.trim(),
      prospectName: prospectName.trim(),
      jobTitle: jobTitle.trim(),
      email,
      phone,
      location: location.trim(),
      employees,
      industry: industry.trim(),
    },
  };
}

function buildHeaderMap(headerCells: string[]): Map<number, keyof ProspectRow> | null {
  const map = new Map<number, keyof ProspectRow>();
  let hasKnown = false;
  for (let i = 0; i < headerCells.length; i++) {
    const f = headerToField(headerCells[i]);
    if (f) {
      map.set(i, f);
      hasKnown = true;
    }
  }
  return hasKnown ? map : null;
}

export function parseProspectPaste(text: string): { rows: ProspectRow[]; errors: string[] } {
  const errors: string[] = [];
  const rows: ProspectRow[] = [];
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { rows, errors: ['Paste is empty.'] };
  }

  // Try JSON/MD/HTML detection first for paste? If it looks like JSON, delegate
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const j = tryParseJson(trimmed);
    if (j.rows.length || j.errors.length === 0) return j;
  }
  if (trimmed.includes('<table') || trimmed.includes('<tr')) {
    const h = tryParseHtml(trimmed);
    if (h.rows.length) return h;
  }
  if (trimmed.startsWith('|') && trimmed.includes('|')) {
    const m = tryParseMarkdown(trimmed);
    if (m.rows.length) return m;
  }

  let headerMap: Map<number, keyof ProspectRow> | null = null;
  let start = 0;
  const first = splitLineSmart(lines[0]);
  if (isHeaderRow(first)) {
    headerMap = buildHeaderMap(first);
    start = 1;
  }

  for (let i = start; i < lines.length; i++) {
    const cells = splitLineSmart(lines[i]);
    const parsed = cellsToProspectFlexible(cells, headerMap, i + 1);
    if (parsed.error) {
      errors.push(parsed.error);
      continue;
    }
    if (parsed.row) rows.push(parsed.row);
  }

  return { rows, errors };
}

/** Parse a 2D matrix (e.g. from Excel/CSV file) into prospect rows. */
export function parseProspectMatrix(matrix: unknown[][]): {
  rows: ProspectRow[];
  errors: string[];
} {
  const errors: string[] = [];
  const rows: ProspectRow[] = [];
  const lines = matrix
    .map((row) => row.map((c) => String(c ?? '').trim()))
    .filter((row) => row.some((c) => c.length > 0));

  if (lines.length === 0) {
    return { rows, errors: ['File is empty.'] };
  }

  let headerMap: Map<number, keyof ProspectRow> | null = null;
  let start = 0;
  if (isHeaderRow(lines[0])) {
    headerMap = buildHeaderMap(lines[0]);
    start = 1;
  }

  for (let i = start; i < lines.length; i++) {
    const parsed = cellsToProspectFlexible(lines[i], headerMap, i + 1);
    if (parsed.error) {
      errors.push(parsed.error);
      continue;
    }
    if (parsed.row) rows.push(parsed.row);
  }

  return { rows, errors };
}

function tryParseJson(text: string): { rows: ProspectRow[]; errors: string[] } {
  try {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : data.rows ?? data.data ?? data.leads ?? data.prospects ?? [data];
    if (!Array.isArray(arr)) return { rows: [], errors: [] };
    const rows: ProspectRow[] = [];
    const errors: string[] = [];
    for (let i = 0; i < arr.length; i++) {
      const obj = arr[i] as Record<string, unknown>;
      if (!obj || typeof obj !== 'object') {
        errors.push(`Item ${i + 1}: not an object — skipped.`);
        continue;
      }
      const get = (keys: string[]) => {
        for (const k of keys) {
          const targetField = headerToField(k);
          for (const ok of Object.keys(obj)) {
            if (headerToField(ok) === targetField) return String(obj[ok] ?? '').trim();
          }
        }
        for (const k of keys) {
          for (const ok of Object.keys(obj)) {
            if (normalizeHeader(ok) === normalizeHeader(k)) return String(obj[ok] ?? '').trim();
          }
        }
        return '';
      };
      const company = get(['company', 'companyName', 'organisation', 'organization']);
      const prospectName = get(['prospectName', 'prospect name', 'name', 'contactName', 'contact name']);
      const jobTitle = get(['jobTitle', 'job title', 'title', 'role', 'designation']);
      const email = cleanEmail(get(['email', 'emailAddress', 'e-mail']));
      const phone = cleanPhone(get(['phone', 'phoneNumber', 'mobile', 'tel']));
      const location = get(['location', 'city', 'address', 'place']);
      const employees = parseEmployees(get(['employees', 'employeeCount', 'staff', 'size']));
      const industry = get(['industry', 'sector', 'vertical']);
      if (!company || !prospectName) {
        errors.push(`Item ${i + 1}: missing company or prospect name — skipped.`);
        continue;
      }
      rows.push({ company, prospectName, jobTitle, email, phone, location, employees, industry });
    }
    return { rows, errors };
  } catch {
    return { rows: [], errors: [] };
  }
}

function tryParseHtml(html: string): { rows: ProspectRow[]; errors: string[] } {
  try {
    const G = globalThis as unknown as { DOMParser?: any };
    if (typeof G.DOMParser !== 'undefined') {
      const parser = new G.DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const tables: unknown = (doc as unknown as { querySelectorAll: (s: string) => unknown[] }).querySelectorAll('table');
      if ((tables as unknown[]).length > 0) {
        for (const table of Array.from(tables as unknown as Array<{ querySelectorAll: (s: string) => unknown[] }>)) {
          const rows = Array.from((table as unknown as { querySelectorAll: (s: string) => unknown[] }).querySelectorAll('tr'));
          if (rows.length < 1) continue;
          const matrix: string[][] = (rows as unknown as Array<{ querySelectorAll: (s: string) => Array<{ textContent: string | null }> }>).map((tr) => Array.from(tr.querySelectorAll('th, td')).map((c) => (c.textContent ?? '').trim()));
          const filtered = matrix.filter((r) => r.some((c) => c.length > 0));
          if (filtered.length === 0) continue;
          const headerMap = isHeaderRow(filtered[0]) ? buildHeaderMap(filtered[0]) : null;
          const start = headerMap ? 1 : 0;
          const resultRows: ProspectRow[] = [];
          const errors: string[] = [];
          for (let i = start; i < filtered.length; i++) {
            const parsed = cellsToProspectFlexible(filtered[i], headerMap, i + 1);
            if (parsed.error) errors.push(parsed.error);
            else if (parsed.row) resultRows.push(parsed.row);
          }
          if (resultRows.length > 0) return { rows: resultRows, errors };
        }
      }
    }
    // Node fallback: regex parse <table>...</table>
    const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch) return { rows: [], errors: [] };
    const rowMatches = [...tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    const matrix: string[][] = [];
    for (const m of rowMatches) {
      const cellMatches = [...m[1].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)];
      const cells = cellMatches.map((c) => c[1].replace(/<[^>]*>/g, '').trim());
      if (cells.some((c) => c.length > 0)) matrix.push(cells);
    }
    if (matrix.length === 0) return { rows: [], errors: [] };
    const headerMap = isHeaderRow(matrix[0]) ? buildHeaderMap(matrix[0]) : null;
    const start = headerMap ? 1 : 0;
    const resultRows: ProspectRow[] = [];
    const errors: string[] = [];
    for (let i = start; i < matrix.length; i++) {
      const parsed = cellsToProspectFlexible(matrix[i], headerMap, i + 1);
      if (parsed.error) errors.push(parsed.error);
      else if (parsed.row) resultRows.push(parsed.row);
    }
    return { rows: resultRows, errors };
  } catch {
    return { rows: [], errors: [] };
  }
}

function tryParseXml(xmlText: string): { rows: ProspectRow[]; errors: string[] } {
  try {
    const G = globalThis as unknown as { DOMParser?: any };
    if (typeof G.DOMParser !== 'undefined') {
      try {
        const parser = new G.DOMParser();
        const doc = parser.parseFromString(xmlText, 'text/xml');
        if (!doc.querySelector('parsererror')) {
          const rowNodes = doc.querySelectorAll('row, lead, prospect, item, entry');
          if (rowNodes.length > 0) {
            const rows: ProspectRow[] = [];
            const errors: string[] = [];
            rowNodes.forEach((node: unknown, idx: number) => {
              const elNode = node as unknown as { querySelector: (s: string) => { textContent: string | null } | null; attributes: unknown[] };
              const getTag = (names: string[]) => {
                for (const n of names) {
                  const el = elNode.querySelector(n) ?? elNode.querySelector(n.toLowerCase()) ?? elNode.querySelector(n.toUpperCase());
                  if (el?.textContent) return el.textContent.trim();
                  for (const attr of Array.from(elNode.attributes) as unknown as Array<{ name: string; value: string }>) {
                    if (normalizeHeader(attr.name) === normalizeHeader(n)) return attr.value.trim();
                  }
                }
                return '';
              };
              const company = getTag(['company', 'companyName', 'organisation']);
              const prospectName = getTag(['prospectName', 'prospect', 'name', 'contactName']);
              const jobTitle = getTag(['jobTitle', 'title', 'role']);
              const email = cleanEmail(getTag(['email', 'emailAddress']));
              const phone = cleanPhone(getTag(['phone', 'phoneNumber', 'mobile']));
              const location = getTag(['location', 'city', 'address']);
              const employees = parseEmployees(getTag(['employees', 'employeeCount']));
              const industry = getTag(['industry', 'sector']);
              if (!company || !prospectName) {
                errors.push(`Item ${idx + 1}: missing company or prospect name — skipped.`);
                return;
              }
              rows.push({ company, prospectName, jobTitle, email, phone, location, employees, industry });
            });
            if (rows.length > 0) return { rows, errors };
          }
        }
      } catch {}
    }
    // Node fallback: regex parse <row>...</row> or <item>...
    const rowRegex = /<(?:row|lead|prospect|item|entry)[^>]*>([\s\S]*?)<\/(?:row|lead|prospect|item|entry)>/gi;
    const rowMatches = [...xmlText.matchAll(rowRegex)];
    if (rowMatches.length === 0) return { rows: [], errors: [] };
    const rows: ProspectRow[] = [];
    const errors: string[] = [];
    const getTagRegex = (block: string, names: string[]) => {
      for (const n of names) {
        const re = new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`, 'i');
        const m = block.match(re);
        if (m) return m[1].replace(/<[^>]*>/g, '').trim();
        const attrRe = new RegExp(`${n}\\s*=\\s*["']([^"']+)["']`, 'i');
        const am = block.match(attrRe);
        if (am) return am[1].trim();
      }
      return '';
    };
    rowMatches.forEach((m, idx) => {
      const block = m[1];
      const company = getTagRegex(block, ['company', 'companyName', 'organisation']);
      const prospectName = getTagRegex(block, ['prospectName', 'prospect', 'name', 'contactName']);
      const jobTitle = getTagRegex(block, ['jobTitle', 'title', 'role']);
      const email = cleanEmail(getTagRegex(block, ['email', 'emailAddress']));
      const phone = cleanPhone(getTagRegex(block, ['phone', 'phoneNumber', 'mobile']));
      const location = getTagRegex(block, ['location', 'city', 'address']);
      const employees = parseEmployees(getTagRegex(block, ['employees', 'employeeCount']));
      const industry = getTagRegex(block, ['industry', 'sector']);
      if (!company || !prospectName) {
        errors.push(`Item ${idx + 1}: missing company or prospect name — skipped.`);
        return;
      }
      rows.push({ company, prospectName, jobTitle, email, phone, location, employees, industry });
    });
    return { rows, errors };
  } catch {
    return { rows: [], errors: [] };
  }
}

function tryParseMarkdown(md: string): { rows: ProspectRow[]; errors: string[] } {
  try {
    const lines = md
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('|') && l.endsWith('|'));
    if (lines.length < 2) return { rows: [], errors: [] };
    const headerCells = lines[0]
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (!isHeaderRow(headerCells)) return { rows: [], errors: [] };
    const headerMap = buildHeaderMap(headerCells);
    const rows: ProspectRow[] = [];
    const errors: string[] = [];
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if (/^\|[\s-|]+\|$/.test(line)) continue;
      const filtered = line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      const parsed = cellsToProspectFlexible(filtered, headerMap, i + 1);
      if (parsed.error) errors.push(parsed.error);
      else if (parsed.row) rows.push(parsed.row);
    }
    return { rows, errors };
  } catch {
    return { rows: [], errors: [] };
  }
}

// Public parsers for specific formats
export function parseProspectHtml(html: string) {
  return tryParseHtml(html);
}
export function parseProspectXml(xml: string) {
  return tryParseXml(xml);
}
export function parseProspectJson(text: string) {
  return tryParseJson(text);
}
export function parseProspectMarkdown(md: string) {
  return tryParseMarkdown(md);
}

// Universal auto-detect parser for any file content
export function parseProspectAuto(text: string, fileName = ''): { rows: ProspectRow[]; errors: string[] } {
  const trimmed = text.trim();
  if (!trimmed) return { rows: [], errors: ['File is empty.'] };
  const lowerName = fileName.toLowerCase();
  // JSON by extension or content
  if (lowerName.endsWith('.json') || (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    const j = tryParseJson(trimmed);
    if (j.rows.length || trimmed.startsWith('{') || trimmed.startsWith('[')) return j;
  }
  // HTML
  if (lowerName.endsWith('.html') || lowerName.endsWith('.htm') || trimmed.toLowerCase().includes('<table')) {
    const h = tryParseHtml(trimmed);
    if (h.rows.length) return h;
  }
  // XML
  if (lowerName.endsWith('.xml') || trimmed.startsWith('<?xml') || trimmed.startsWith('<rows') || trimmed.startsWith('<leads')) {
    const x = tryParseXml(trimmed);
    if (x.rows.length) return x;
  }
  // Markdown
  if (lowerName.endsWith('.md') || (trimmed.includes('|') && trimmed.includes('---'))) {
    const m = tryParseMarkdown(trimmed);
    if (m.rows.length) return m;
  }
  // Default to paste (handles CSV/TSV/TXT with any delimiter)
  return parseProspectPaste(text);
}

export function cellsToProspect(cells: string[], lineNo: number): { row?: ProspectRow; error?: string } {
  return cellsToProspectFlexible(cells, null, lineNo);
}

export const PROSPECT_TEMPLATE_CSV =
  'Company,Prospect Name,Job Title,Email,Phone,Location,Employees,Industry\n';

export function previewByCompany(rows: ProspectRow[]): { company: string; count: number }[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.company, (map.get(r.company) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([company, count]) => ({ company, count }))
    .sort((a, b) => a.company.localeCompare(b.company));
}
