import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

export type Plan = 'free' | 'plus' | 'pro' | 'enterprise';

export function useSubscription() {
  const [plan, setPlan] = useState<Plan>('pro');
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

  const hasVoice = plan !== 'free';
  const hasImage = plan !== 'free';
  const hasScoring = plan !== 'free';
  const hasCallAnalysis = plan === 'pro' || plan === 'enterprise';

  return { plan, loading, refresh, hasVoice, hasImage, hasScoring, hasCallAnalysis };
}
