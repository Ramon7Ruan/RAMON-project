import { useEffect, useState } from 'react';
import type { Concept } from '@shared/types';
import { DOMAIN_LABEL } from '@shared/types';
import { api } from '../api';
import { BlockFlow, BLOCK_NAMES } from '../blocks';
import { EmptyState, InlineError, Skeleton, StatusDot } from '../components';
import type { PageCtx } from '../route';
import { statusOf } from '../route';

function srcDate(source?: string): string {
  return source?.match(/截至\s*([\d-]+)/)?.[1] ?? '';
}

/** 概念详情页 —— 「详情」的落点，完整解析只在这里出现（PRD §3.4） */
export function ConceptPage({ ctx, id }: { ctx: PageCtx; id: string }) {
  const [concept, setConcept] = useState<Concept | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setConcept(undefined);
    setError(null);
    (async () => {
      try {
        const c = await api.getConcept(id);
        if (!alive) return;
        setConcept(c);
        if (c) {
          const r = await api.markRead(id); // 未读 → 在读
          if (alive) ctx.setLocalStatus(id, r.status);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) return <div className="page"><InlineError message={error} onRetry={() => ctx.go({ name: 'concept', id })} /></div>;

  if (concept === undefined) {
    return <div className="page"><Skeleton rows={5} /></div>;
  }

  if (concept === null) {
    return (
      <div className="page">
        <EmptyState
          title="这个概念已不在内容库中"
          hint="它可能已在最近一次内容更新中被移除"
          action={<span className="btn sm" onClick={() => ctx.go({ name: 'home' })}>返回首页</span>}
        />
      </div>
    );
  }

  const st = statusOf(ctx, id);
  const fav = ctx.favs.has(id);
  const trackLabel = ctx.stats?.tracks.find((t) => t.key === concept.track)?.label ?? concept.track;
  const siblings = ctx.summaries.filter((c) => c.domain === concept.domain);
  const idx = siblings.findIndex((c) => c.id === id);
  const next = siblings[(idx + 1) % Math.max(1, siblings.length)];

  const setStatus = async (s: 'fuzzy' | 'review' | 'known') => {
    const r = await api.setStatus(id, s);
    ctx.setLocalStatus(id, r.status);
    void ctx.refresh();
  };

  const toggleFav = async () => {
    const r = await api.toggleFavorite(id);
    ctx.setLocalFav(id, r.favorite);
  };

  const goBack = () => ctx.go({ name: 'domain', domain: concept.domain });

  return (
    <div className="page">
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <span className="backlink" role="button" tabIndex={0} onClick={goBack}
          onKeyDown={(e) => { if (e.key === 'Enter') goBack(); }}>
          ← 返回{DOMAIN_LABEL[concept.domain]}要点速览
        </span>
      </div>

      <div className="c-head">
        <div className="crumb">
          <span className="backlink"
            onClick={() => ctx.go({ name: 'domain', domain: concept.domain })}>
            {DOMAIN_LABEL[concept.domain]}
          </span>
          {' / '}{trackLabel}
        </div>
        <div className="c-meta">
          <StatusDot status={st} />
          <span className="fav" role="button" tabIndex={0} onClick={toggleFav}
            onKeyDown={(e) => { if (e.key === 'Enter') toggleFav(); }}
            aria-label={fav ? '取消收藏' : '收藏'}>{fav ? '★' : '☆'}</span>
        </div>
      </div>

      <h1 className="c-title">{concept.title}</h1>
      <div className="c-oneliner">{concept.one_liner}</div>

      {concept.domain === 'hotspot' && srcDate(concept.source) && (
        <div className="stale">内容截至 {srcDate(concept.source)}</div>
      )}

      <div className="recipe">
        <span className="rl">本页讲解方式</span>
        {concept.recipe.map((r, i) => <span className="rb" key={i}>{BLOCK_NAMES[r]}</span>)}
      </div>

      <BlockFlow blocks={concept.blocks} />

      <div className="links">
        <div className="lh">相关概念</div>
        {concept.links.map((l, i) => {
          const target = ctx.summaries.find((s) => s.id === l.to);
          return (
            <div className="lk" key={i} role="button" tabIndex={0}
              onClick={() => ctx.go({ name: 'concept', id: l.to })}
              onKeyDown={(e) => { if (e.key === 'Enter') ctx.go({ name: 'concept', id: l.to }); }}>
              <span className="la">→</span>
              <b>{target?.title ?? l.to}</b>
              <span>{l.reason}</span>
            </div>
          );
        })}
      </div>

      <div className="action-bar">
        <button className="btn" type="button" onClick={() => setStatus('fuzzy')}>标记不懂</button>
        <button className="btn" type="button" onClick={() => setStatus('review')}>加入待复习</button>
        <button className="btn primary" type="button" onClick={() => setStatus('known')}>我掌握了</button>
      </div>

      {next && next.id !== id && (
        <div style={{ marginTop: 'var(--space-4)', textAlign: 'center' }}>
          <span className="btn sm" onClick={() => ctx.go({ name: 'concept', id: next.id })}>
            下一个：{next.title} →
          </span>
        </div>
      )}
    </div>
  );
}
