import { describe, expect, it } from 'vitest';
import { normalizeSttTranscript } from '../../server/ai/extract.js';
import { mapIndustry, cleanEmail, cleanPhone } from '../../src/lib/importProspects.js';

describe('STT Normalizer & Classification', () => {
  it('corrects spoken emails with at and dot patterns', () => {
    expect(normalizeSttTranscript('email is alex at acme dot com')).toContain('alex@acme.com');
    expect(normalizeSttTranscript('contact john dot doe at stripe dot io')).toContain('john.doe@stripe.io');
    expect(normalizeSttTranscript('reach out at priya at axis dot co dot in please')).toContain('priya@axis.co.in');
    expect(normalizeSttTranscript('email alex @ acme . com')).toContain('alex@acme.com');
  });

  it('corrects spoken phone numbers and plus prefixes', () => {
    const res = normalizeSttTranscript('phone plus one five five five zero one zero zero');
    expect(res).toMatch(/\+1\s*5550100/);

    const indianRes = normalizeSttTranscript('call plus nine one nine eight seven six five four three two one zero');
    expect(indianRes).toMatch(/\+91\s*9876543210/);
  });

  it('normalizes spoken employee words to numbers', () => {
    expect(normalizeSttTranscript('company has fifty employees')).toContain('50 employees');
    expect(normalizeSttTranscript('two hundred people working there')).toContain('200 people');
    expect(normalizeSttTranscript('around five thousand staff members')).toContain('5000 staff');
  });

  it('removes speech disfluencies cleanly', () => {
    const clean = normalizeSttTranscript('Um so basically we met Alex uh from Acme like you know');
    expect(clean).not.toMatch(/\bum\b/i);
    expect(clean).not.toMatch(/\buh\b/i);
    expect(clean).not.toMatch(/so basically/i);
    expect(clean).toContain('Alex');
    expect(clean).toContain('Acme');
  });

  it('accurately classifies standard industries from various aliases', () => {
    expect(mapIndustry('SaaS')).toBe('SaaS');
    expect(mapIndustry('software platforms & cloud')).toBe('SaaS');
    expect(mapIndustry('hospital and cancer research center')).toBe('Healthcare');
    expect(mapIndustry('medical devices and clinic')).toBe('Healthcare');
    expect(mapIndustry('fintech payment gateway')).toBe('BFSI');
    expect(mapIndustry('banking and insurance')).toBe('BFSI');
    expect(mapIndustry('ecommerce fashion apparel')).toBe('Retail');
    expect(mapIndustry('freight forwarding and trucking fleet')).toBe('Logistics');
    expect(mapIndustry('university online courses & tutoring')).toBe('EdTech');
  });

  it('cleans emails and phones reliably', () => {
    expect(cleanEmail('ALEX@ACME.COM+1')).toBe('alex@acme.com');
    expect(cleanPhone('+1   555   0100')).toBe('+1 555 0100');
  });
});
