import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

export type Plan = 'plus' | 'pro' | 'enterprise';

export function useSubscription() {
  const [plan, setPlan] = useState<Plan>('plus');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ plan: Plan }>('/api/subscription');
      if (data.plan) setPlan(data.plan);
    } catch {
      // fallback to config
      try {
        const cfg = await api<{ subscriptionPlan?: string }>('/api/config');
        if (cfg.subscriptionPlan) setPlan(cfg.subscriptionPlan as Plan);
      } catch {}
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasVoice = plan === 'pro' || plan === 'enterprise';
  const hasImage = plan === 'pro' || plan === 'enterprise';
  const hasScoring = plan === 'pro' || plan === 'enterprise';
  const hasCallAnalysis = plan === 'pro' || plan === 'enterprise';

  return { plan, loading, refresh, hasVoice, hasImage, hasScoring, hasCallAnalysis };
}
