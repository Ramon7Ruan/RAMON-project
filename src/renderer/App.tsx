import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConceptState, ConceptStatus, ContentMeta, Domain } from '@shared/types';
import { DOMAIN_LABEL } from '@shared/types';
import type { ConceptSummary } from '@shared/summary';
import { api, onAppEvent, type SettingsDTO, type StatsDTO } from './api';
import { DOMAIN_ORDER, InlineError, ProgressRing, Skeleton } from './components';
import type { PageCtx, Route } from './route';
import { HomePage } from './pages/Home';
import { DomainPage } from './pages/Domain';
import { ConceptPage } from './pages/Concept';
import { ReviewPage } from './pages/Review';
import { SearchPage } from './pages/Search';
import { SettingsPage } from './pages/Settings';

const EMPTY_META: ContentMeta = {
  version: '—', updated_at: '', schema_version: 1,
  counts: { econ: 0, finance: 0, hotspot: 0, total: 0 },
};

const CRUMB: Record<string, string> = { home: '首页', review: '复习', search: '搜索', settings: '设置' };

export function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [summaries, setSummaries] = useState<ConceptSummary[]>([]);
  const [states, setStates] = useState<Record<string, ConceptState>>({});
  const [meta, setMeta] = useState<ContentMeta>(EMPTY_META);
  const [settings, setSettings] = useState<SettingsDTO>({
    theme: 'system', autoCheckUpdate: true, manifestUrl: '', lastCheck: '', lastExport: '',
  });
  const [stats, setStats] = useState<StatsDTO | null>(null);
  const [favs, setFavs] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, st, m, s, stat, fav] = await Promise.all([
        api.listConcepts(), api.states(), api.meta(), api.settings(), api.stats(), api.favorites(),
      ]);
      setSummaries(list);
      setStates(st);
      setMeta(m);
      setSettings(s);
      setStats(stat);
      setFavs(new Set(fav));
      document.documentElement.dataset.theme = s.theme || 'light';
      setPhase('ready');
      setError(null);
      void api.signalReady();
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    onAppEvent((name) => { if (name === 'update-available') setUpdateReady(true); });
  }, []);

  const go = useCallback((r: Route) => {
    setRoute(r);
    // scrollTo 不是所有宿主都实现（例如无头测试环境）；它只是滚动复位，
    // 失败了绝不能连累导航本身，否则点一次导航就抛一个未捕获异常。
    try {
      document.querySelector('.view')?.scrollTo?.({ top: 0 });
    } catch { /* 忽略：滚动复位失败不影响导航 */ }
  }, []);

  const ctx: PageCtx = useMemo(() => ({
    summaries, states, meta, settings, stats, go, refresh, favs,
    setLocalStatus(id, status: ConceptStatus) {
      setStates((p) => ({ ...p, [id]: { ...(p[id] ?? ({} as ConceptState)), concept_id: id, status } as ConceptState }));
    },
    setLocalFav(id, favorite) {
      setFavs((p) => {
        const n = new Set(p);
        if (favorite) n.add(id); else n.delete(id);
        return n;
      });
    },
  }), [summaries, states, meta, settings, stats, favs, go, refresh]);

  const trackLabel = (key: string) => stats?.tracks.find((t) => t.key === key)?.label ?? key;

  const crumb = useMemo(() => {
    if (route.name === 'home') return CRUMB.home;
    if (route.name === 'domain') return DOMAIN_LABEL[route.domain];
    if (route.name === 'concept') {
      const c = summaries.find((x) => x.id === route.id);
      return c ? `${DOMAIN_LABEL[c.domain]} / ${trackLabel(c.track)}` : '概念';
    }
    return CRUMB[route.name] ?? '';
  }, [route, summaries, stats]);

  const known = summaries.filter((c) => states[c.id]?.status === 'known').length;
  const percent = summaries.length ? Math.round((known / summaries.length) * 100) : 0;
  const dueCount = stats?.review ?? 0;

  const nav = [
    { key: 'home', label: '首页', go: () => go({ name: 'home' }), count: '' },
    { sep: true },
    ...DOMAIN_ORDER.map((d: Domain) => ({
      key: d,
      label: DOMAIN_LABEL[d],
      go: () => go({ name: 'domain', domain: d }),
      count: String(summaries.filter((c) => c.domain === d).length || ''),
    })),
    { sep: true },
    { key: 'review', label: '复习', go: () => go({ name: 'review' }), count: dueCount ? String(dueCount) : '' },
    { key: 'search', label: '搜索', go: () => go({ name: 'search' }), count: '' },
    { key: 'settings', label: '设置', go: () => go({ name: 'settings' }), count: '' },
  ] as { sep?: boolean; key?: string; label?: string; go?: () => void; count?: string }[];

  const isOn = (key?: string) => {
    if (key === 'home') return route.name === 'home';
    if (key === 'review' || key === 'search' || key === 'settings') return route.name === key;
    if (route.name === 'domain' && key) return route.domain === key;
    if (route.name === 'concept' && key) {
      const c = summaries.find((x) => x.id === (route as { id: string }).id);
      return c?.domain === key;
    }
    return false;
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Recall<span>金融知识复习</span></div>
        <nav className="nav">
          {nav.map((it, i) => it.sep
            ? <div className="nav-sep" key={`sep${i}`} />
            : (
              <div key={it.key} className={`nav-item${isOn(it.key) ? ' on' : ''}`}
                onClick={it.go} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') it.go?.(); }}>
                <span>{it.label}</span>
                {it.count ? <span className="cnt">{it.count}</span> : null}
              </div>
            ))}
        </nav>
        <div className="side-foot">
          <ProgressRing percent={percent} />
          <div className="ft">已掌握 {known} / {summaries.length}<br />{percent}%</div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="crumb">{crumb}</div>
          <div className={`badge${updateReady ? ' new' : ''}`} onClick={() => go({ name: 'settings' })}>
            {updateReady && <i />}
            内容 v{meta.version}
          </div>
        </div>
        <div className="view">
          {phase === 'loading' && <div className="page"><Skeleton rows={5} /></div>}
          {phase === 'error' && (
            <div className="page">
              <InlineError message={error ?? '加载失败'} onRetry={() => { setPhase('loading'); void refresh(); }} />
            </div>
          )}
          {phase === 'ready' && (
            <>
              {route.name === 'home' && <HomePage ctx={ctx} />}
              {route.name === 'domain' && <DomainPage ctx={ctx} domain={route.domain} />}
              {route.name === 'concept' && <ConceptPage ctx={ctx} id={route.id} />}
              {route.name === 'review' && <ReviewPage ctx={ctx} />}
              {route.name === 'search' && <SearchPage ctx={ctx} />}
              {route.name === 'settings' && <SettingsPage ctx={ctx} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
