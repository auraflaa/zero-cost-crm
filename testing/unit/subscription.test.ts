import { describe, expect, it } from 'vitest';
import { hasFeature, planSupportsFeature } from '../../server/subscription.js';

describe('subscription', () => {
  it('returns true for features in test environment', () => {
    expect(hasFeature('plus', 'voice_ai')).toBe(true);
    expect(hasFeature('plus', 'image_ai')).toBe(true);
    expect(hasFeature('plus', 'lead_scoring')).toBe(true);
    expect(hasFeature('plus', 'call_analysis')).toBe(true);
  });

  it('evaluates planSupportsFeature consistently', () => {
    expect(planSupportsFeature('pro', 'voice_ai')).toBe(true);
    expect(planSupportsFeature('enterprise', 'call_analysis')).toBe(true);
  });
});
