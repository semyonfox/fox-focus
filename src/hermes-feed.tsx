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
        if (!isHermesFeed(next) || next.state !== 'connected') throw new Error('Feed unavailable');
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

export function HermesTaskList({ feed, embedded = false }: { feed: HermesFeed; embedded?: boolean }) {
  const [query, setQuery] = useState('');
  const [showCompleted, setShowCompleted] = useState(false);
  const [limit, setLimit] = useState(25);
  const [list, setList] = useState('');
  const [includeWishlist, setIncludeWishlist] = useState(false);
  if (feed.state !== 'connected') return <p>Hermes is unavailable.</p>;
  const wishlist = (name: string) => /^(shit i want|wish\s?list|someday)$/i.test(name);
  const tasks = feed.board.tasks.filter(task => (showCompleted || task.status !== 'done') &&
    (list ? task.list === list : includeWishlist || !wishlist(task.list)) &&
    task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const groups = feed.board.lists;
  const ordered = groups.flatMap(name => tasks.filter(task => task.list === name));
  const visible = ordered.slice(0, limit);
  return <div className={embedded ? 'hermes-task-list hermes-task-list--embedded' : 'hermes-task-list'}>
    <div className="hermes-toolbar">
      <label className="field"><span>Find a task</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(25); }} placeholder="Search task titles" /></label>
      <label className="field"><span>List</span><select value={list} onChange={event => { setList(event.target.value); setLimit(25); }}><option value="">Action lists</option>{groups.map(name => <option key={name} value={name}>{name} ({feed.board.tasks.filter(task => task.list === name && (showCompleted || task.status !== 'done')).length})</option>)}</select></label>
      {!list && <label className="hermes-completed"><input type="checkbox" checked={includeWishlist} onChange={event => { setIncludeWishlist(event.target.checked); setLimit(25); }} /> Include wishlist / someday</label>}
      <label className="hermes-completed"><input type="checkbox" checked={showCompleted} onChange={event => { setShowCompleted(event.target.checked); setLimit(25); }} /> Include completed</label>
    </div>
    <p className="hermes-meta">{tasks.length} matching tasks · {feed.board.name} · Choose a list to see its items separately.</p>
    <div className="hermes-feed hermes-feed--live">
      {groups.map(name => {
        const group = visible.filter(task => task.list === name);
        return group.length ? <section key={name} aria-label={name}>
          <h3>{name}</h3>
          {group.map(task => <article key={task.id}>
            <strong>{task.title}</strong>
            <p>{hermesLabels[task.status]} · {task.owner === 'human' ? 'For you' : task.owner === 'agent' ? 'Assigned to an agent' : 'Unassigned'} · {task.priority !== 0 ? `Priority ${task.priority}` : 'Default priority'}</p>
            {task.parentTitle && <p>Part of: {task.parentTitle}</p>}
          </article>)}
        </section> : null;
      })}
      {!tasks.length ? <p>No tasks match this view.</p> : null}
    </div>
    {tasks.length > limit ? <button className="secondary-action" type="button" onClick={() => setLimit(current => current + 25)}>Show 25 more</button> : null}
  </div>;
}
