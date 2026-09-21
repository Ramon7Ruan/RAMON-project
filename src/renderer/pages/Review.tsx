import { useCallback, useEffect, useState } from 'react';
import type { Concept, Rating } from '@shared/types';
import { api } from '../api';
import { BlockFlow, BLOCK_NAMES } from '../blocks';
import { EmptyState, Skeleton } from '../components';
import type { PageCtx } from '../route';

const RATING_LABEL: Record<Rating, string> = { 0: '忘了', 1: '模糊', 2: '记得' };

/**
 * 复习页 —— 两段式：先回忆，再展开，最后评分（PRD §4.3）
 * 键盘：空格展开、1/2/3 评分。
 */
export function ReviewPage({ ctx }: { ctx: PageCtx }) {
  const [queue, setQueue] = useState<string[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const [concept, setConcept] = useState<Concept | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const q = await api.dueQueue();
      setQueue(q);
    })();
  }, []);

  const currentId = queue && idx < queue.length ? queue[idx] : null;

  useEffect(() => {
    let alive = true;
    if (!currentId) { setConcept(null); return; }
    setLoading(true);
    (async () => {
      try {
        const c = await api.getConcept(currentId);
        if (alive) setConcept(c);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [currentId]);

  const reveal = useCallback(() => setRevealed(true), []);

  const rate = useCallback(async (r: Rating) => {
    if (!currentId) return;
    await api.rate(currentId, r);
    setIdx((i) => i + 1);
    setRevealed(false);
    setDone((d) => d + 1);
    void ctx.refresh();
  }, [currentId, ctx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!currentId) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!revealed) reveal();
        return;
      }
      if (revealed && ['1', '2', '3'].includes(e.key)) {
        void rate(Number(e.key === '1' ? 0 : e.key === '2' ? 1 : 2) as Rating);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentId, revealed, reveal, rate]);

  if (queue === null) return <div className="page"><Skeleton rows={4} /></div>;

  if (queue.length === 0) {
    return (
      <div className="page">
        <EmptyState
          title="复习队列是空的"
          hint="去各分区把概念标记为「加入待复习」，它们会出现在这里"
          action={<span className="btn sm" onClick={() => ctx.go({ name: 'home' })}>返回首页</span>}
        />
      </div>
    );
  }

  if (idx >= queue.length) {
    return (
      <div className="page">
        <div className="rq-card">
          <div className="rq-t">今天复习完了</div>
          <div className="rq-o">
            本轮完成 {done} 个概念
            <br />
            明天预计有 {Math.max(0, (ctx.stats?.review ?? 0))} 个到期
          </div>
          <div style={{ marginTop: 'var(--space-5)' }}>
            <span className="btn sm" onClick={() => ctx.go({ name: 'home' })}>返回首页</span>
          </div>
        </div>
      </div>
    );
  }

  const total = queue.length;
  const pct = (idx / total) * 100;

  return (
    <div className="page">
      <div className="rq-prog"><i style={{ width: `${pct}%` }} /></div>
      <div className="rq-num">{idx + 1} / {total}</div>

      {loading || !concept ? (
        <Skeleton rows={3} />
      ) : !revealed ? (
        <>
          <div className="rq-card">
            <div className="rq-t">{concept.title}</div>
            <div className="rq-o">{concept.one_liner}</div>
          </div>
          <div className="rq-hint">想一下再看解析</div>
          <div style={{ textAlign: 'center' }}>
            <span className="btn sm" onClick={reveal}>展开解析（空格）</span>
          </div>
        </>
      ) : (
        <>
          <div className="rq-full">
            <div style={{ fontSize: 'var(--text-hero)', fontWeight: 'var(--weight-medium)' }}>
              {concept.title}
            </div>
            <div className="c-oneliner">{concept.one_liner}</div>
            <div className="recipe">
              {concept.recipe.map((r, i) => <span className="rb" key={i}>{BLOCK_NAMES[r]}</span>)}
            </div>
            <BlockFlow blocks={concept.blocks} />
          </div>
          <div className="rq-rate">
            {([0, 1, 2] as Rating[]).map((r) => (
              <div className={`rq-btn b${r}`} key={r} role="button" tabIndex={0}
                onClick={() => rate(r)}
                onKeyDown={(e) => { if (e.key === 'Enter') rate(r); }}>
                {RATING_LABEL[r]}
                <small>{r + 1}</small>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
