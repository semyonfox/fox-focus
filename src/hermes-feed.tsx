import { useCallback, useEffect, useState } from 'react';
import { isHermesFeed, type HermesFeed, type HermesStatus } from './hermes-model.ts';

export const hermesLabels: Record<HermesStatus, string> = {
  triage: 'Needs sorting', todo: 'To do', scheduled: 'Scheduled', ready: 'Ready',
  running: 'In progress', blocked: 'Blocked', review: 'Needs review', done: 'Completed',
};

export function useHermesFeed(enabled: boolean) {
  const [feed, setFeed] = useState<HermesFeed | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey(key => key + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let disposed = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch('/api/v1/hermes', { signal: controller.signal });
        if (!response.ok) throw new Error('Feed unavailable');
        const next: unknown = await response.json();
        if (!isHermesFeed(next)) throw new Error('Feed unavailable');
        if (!disposed) { setFeed(next); setFailed(false); }
      } catch { if (!disposed) setFailed(true); }
      finally { if (!disposed) setLoading(false); }
    }
    void load();
    const interval = window.setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
    return () => { disposed = true; controller.abort(); window.clearInterval(interval); };
  }, [enabled, refreshKey, refresh]);
  return { feed, failed, loading, refresh };
}
