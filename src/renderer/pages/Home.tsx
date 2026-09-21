import type { Domain } from '@shared/types';
import { DOMAIN_LABEL } from '@shared/types';
import { EmptyState, ProgressBar, StatusDot, DOMAIN_ORDER } from '../components';
import type { PageCtx } from '../route';
import { statusOf } from '../route';

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function todayLabel(d = new Date()): string {
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${WEEK[d.getDay()]}`;
}

export function HomePage({ ctx }: { ctx: PageCtx }) {
  const due = ctx.stats?.review ?? 0;
  const total = ctx.summaries.length;
  const known = ctx.summaries.filter((c) => statusOf(ctx, c.id) === 'known').length;
  const recent = ctx.summaries.filter((c) => statusOf(ctx, c.id) !== 'unread').slice(0, 5);

  if (total === 0) {
    return (
      <div className="page">
        <div className="page-title">{todayLabel()}</div>
        <EmptyState
          title="内容库是空的"
          hint="去设置页检查更新，或导入一个本地的 concepts.jsonl"
          action={<span className="btn sm primary" onClick={() => ctx.go({ name: 'settings' })}>去设置页</span>}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-title">{todayLabel()}</div>
      <div className="page-sub">
        共 {total} 个概念 · 已掌握 {known} 个
      </div>

      <div style={{ marginTop: 'var(--space-5)' }}>
        <div
          className="hero"
          role="button"
          tabIndex={0}
          onClick={() => ctx.go(due > 0 ? { name: 'review' } : { name: 'domain', domain: 'econ' })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ctx.go(due > 0 ? { name: 'review' } : { name: 'domain', domain: 'econ' });
          }}
        >
          {due > 0 ? (
            <div>
              <div className="hl">今天要复习</div>
              <div className="hv"><em>{due}</em> 个概念到期</div>
            </div>
          ) : (
            <div>
              <div className="hl">今天没有到期的复习</div>
              <div className="hv">随便看一个 <em>→</em></div>
            </div>
          )}
          <div className="go">→</div>
        </div>
      </div>

      <div className="grid3">
        {DOMAIN_ORDER.map((d: Domain) => {
          const list = ctx.summaries.filter((c) => c.domain === d);
          const k = list.filter((c) => statusOf(ctx, c.id) === 'known').length;
          const pct = list.length ? Math.round((k / list.length) * 100) : 0;
          return (
            <div className="dcard" key={d} role="button" tabIndex={0}
              onClick={() => ctx.go({ name: 'domain', domain: d })}
              onKeyDown={(e) => { if (e.key === 'Enter') ctx.go({ name: 'domain', domain: d }); }}>
              <div className="dt">{DOMAIN_LABEL[d]}</div>
              <div className="dn">{list.length} 个概念 · 已掌握 {k}</div>
              <ProgressBar percent={pct} />
              <div className="dp">{pct}%</div>
            </div>
          );
        })}
      </div>

      {recent.length > 0 && (
        <>
          <div className="sec-h">最近读过</div>
          <div className="card">
            <div className="rows">
              {recent.map((c) => (
                <div className="row" key={c.id} onClick={() => ctx.go({ name: 'concept', id: c.id })}>
                  <StatusDot status={statusOf(ctx, c.id)} />
                  <div className="rt">
                    <b>{c.title}</b>
                    <span>{c.one_liner}</span>
                  </div>
                  <div className="rdf">难度 {c.difficulty}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
