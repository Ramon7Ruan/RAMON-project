import { useState } from 'react';
import type { Domain, TrackKey } from '@shared/types';
import { DOMAIN_LABEL } from '@shared/types';
import { EmptyState, StatusDot } from '../components';
import { BLOCK_NAMES } from '../blocks';
import type { PageCtx } from '../route';
import { statusOf } from '../route';

function staleDate(source?: string): string {
  const m = source?.match(/截至\s*([\d-]+)/);
  return m ? m[1] : '';
}

/**
 * 分区首屏 = 要点速览页（PRD §3.4 / §4.2.1）
 * 硬约束：**不渲染任何解析 block**，只给结论；完整解析在「详情」后面。
 * 已确认**不做筛选**（PRD §4.2.1「共用明确不做」）。
 */
export function DomainPage({ ctx, domain }: { ctx: PageCtx; domain: Domain }) {
  const all = ctx.summaries.filter((c) => c.domain === domain);
  const tracks = (ctx.stats?.tracks ?? []).filter((t) => t.domain === domain);

  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const t of tracks) {
      init[t.key] = all.some((c) => c.track === t.key && statusOf(ctx, c.id) === 'review');
    }
    if (!Object.values(init).some(Boolean) && tracks[0]) init[tracks[0].key] = true;
    return init;
  });

  const known = all.filter((c) => statusOf(ctx, c.id) === 'known').length;
  const due = all.filter((c) => statusOf(ctx, c.id) === 'review').length;

  if (all.length === 0) {
    return (
      <div className="page">
        <div className="page-title">{DOMAIN_LABEL[domain]}</div>
        <EmptyState
          title="这个分区还没有内容"
          hint="去设置页检查内容更新，或导入内容文件"
          action={<span className="btn sm" onClick={() => ctx.go({ name: 'settings' })}>去设置页</span>}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <h2 className="page-title">{DOMAIN_LABEL[domain]}</h2>
      <div className="page-sub">
        {all.length} 个概念的要点速览 · 已掌握 {known} · 待复习 {due}
      </div>

      {tracks.map((t) => {
        const items = all.filter((c) => c.track === t.key);
        if (items.length === 0) return null;
        const trackDue = items.filter((c) => statusOf(ctx, c.id) === 'review').length;
        const isOpen = !!open[t.key];
        return (
          <div className={`acc${isOpen ? ' open' : ''}`} key={t.key}>
            <div className="acc-head" onClick={() => setOpen((p) => ({ ...p, [t.key]: !p[t.key] }))}>
              <div>
                <b>{t.label}</b>
                <span className="n">
                  {items.length} 个概念{trackDue ? ` · ${trackDue} 个待复习` : ''}
                </span>
              </div>
              <div className="ar">▶</div>
            </div>
            <div className="acc-body">
              <div className="kcards">
                {items.map((c) => (
                  <div className="kcard" key={c.id} role="button" tabIndex={0}
                    onClick={() => ctx.go({ name: 'concept', id: c.id })}
                    onKeyDown={(e) => { if (e.key === 'Enter') ctx.go({ name: 'concept', id: c.id }); }}>
                    <div className="kc-head">
                      <StatusDot status={statusOf(ctx, c.id)} />
                      <span className="kc-title">{c.title}</span>
                      <span className="kc-diff">难度 {c.difficulty}</span>
                      <button className="kc-detail" type="button">详情 →</button>
                    </div>
                    <div className="kc-one">{c.one_liner}</div>
                    <ul className="kc-pts">
                      {c.key_points.map((p, i) => <li key={i}>{p}</li>)}
                    </ul>
                    <div className="kc-recipe">
                      {c.recipe.map((r, i) => <span className="rb" key={i}>{BLOCK_NAMES[r]}</span>)}
                    </div>
                    {c.domain === 'hotspot' && staleDate(c.source) && (
                      <div className="kc-stale">内容截至 {staleDate(c.source)}</div>
                    )}
                    <div className="kc-deco" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type { TrackKey };
