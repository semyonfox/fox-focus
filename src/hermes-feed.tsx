import { useCallback, useEffect, useState } from 'react';
import { isHermesFeed, type HermesFeed, type HermesStatus } from './hermes-model.ts';

export const hermesLabels: Record<HermesStatus, string> = {
  triage: 'Needs sorting', todo: 'To do', scheduled: 'Scheduled', ready: 'Ready',
  running: 'In progress', blocked: 'Blocked', review: 'Needs review', done: 'Completed',
};

const allListsTab = "__all_lists__";

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
  const [list, setList] = useState(allListsTab);
  if (feed.state !== 'connected') return <p>Hermes is unavailable.</p>;
  const activeList = list === allListsTab || !feed.board.lists.includes(list) ? allListsTab : list;
  const tasks = feed.board.tasks.filter(task => (showCompleted || task.status !== 'done') &&
    (activeList === allListsTab || task.list === activeList) &&
    task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const groups = feed.board.lists;
  const visible = tasks.slice(0, limit);
  const checkedAt = new Intl.DateTimeFormat('en-IE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Dublin',
  }).format(new Date(feed.checkedAt));
  return <div className={embedded ? 'hermes-task-list hermes-task-list--embedded' : 'hermes-task-list'}>
    <div className="hermes-source-note">
      <span>Read-only · from Hermes</span>
      <time dateTime={feed.checkedAt}>Checked {checkedAt}</time>
    </div>
    <nav className="hermes-list-tabs" aria-label="Task lists">
      <button className={`filter-chip${activeList === allListsTab ? ' filter-chip--active' : ''}`} type="button" aria-pressed={activeList === allListsTab} onClick={() => { setList(allListsTab); setQuery(''); setLimit(25); }}>
        <span>All</span><span className="hermes-list-count">{feed.board.tasks.filter(task => showCompleted || task.status !== 'done').length}</span>
      </button>
      {groups.map(name => <button className={`filter-chip${activeList === name ? ' filter-chip--active' : ''}`} type="button" key={name} aria-pressed={activeList === name} onClick={() => { setList(name); setQuery(''); setLimit(25); }}>
        <span>{name}</span><span className="hermes-list-count">{feed.board.tasks.filter(task => task.list === name && (showCompleted || task.status !== 'done')).length}</span>
      </button>)}
    </nav>
    <div className="hermes-toolbar">
      <label className="field"><span>Find a task</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(25); }} placeholder="Search task titles" /></label>
      <label className="hermes-completed"><input type="checkbox" checked={showCompleted} onChange={event => { setShowCompleted(event.target.checked); setLimit(25); }} /> Include completed</label>
    </div>
    <p className="hermes-meta" role="status">{activeList === allListsTab ? 'All lists' : activeList} · {tasks.length} {query ? 'matching ' : ''}tasks</p>
    <div className="hermes-feed hermes-feed--live">
      {visible.map(task => <article key={task.id}>
        <strong>{task.title}</strong>
        <p>{activeList === allListsTab ? `${task.list} · ` : ''}{hermesLabels[task.status]} · {task.owner === 'human' ? 'For you' : task.owner === 'agent' ? 'Assigned to an agent' : 'Unassigned'} · {task.priority !== 0 ? `Priority ${task.priority}` : 'Default priority'}</p>
        {task.parentTitle && <p>Part of: {task.parentTitle}</p>}
      </article>)}
      {!tasks.length ? <p>No tasks match this view.</p> : null}
    </div>
    {tasks.length > limit ? <button className="secondary-action" type="button" onClick={() => setLimit(current => current + 25)}>Show 25 more</button> : null}
  </div>;
}
