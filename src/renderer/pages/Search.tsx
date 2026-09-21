import { useEffect, useRef, useState } from 'react';
import type { SearchHit } from '@shared/types';
import { DOMAIN_LABEL } from '@shared/types';
import { api } from '../api';
import { StatusDot } from '../components';
import type { PageCtx } from '../route';

const RECENT_KEY = 'recall:recent-searches';

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]; } catch { return []; }
}
function pushRecent(q: string): void {
  const list = [q, ...loadRecent().filter((x) => x !== q)].slice(0, 5);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${esc})`, 'gi'));
  return parts.map((p, i) =>
    p.toLowerCase() === q.toLowerCase() ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
  );
}

/** 搜索页 —— 即时搜索，无提交按钮（PRD §4.4） */
export function SearchPage({ ctx }: { ctx: PageCtx }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (q.trim().length < 1) { setHits([]); return; }
    setLoading(true);
    timer.current = window.setTimeout(async () => {
      try {
        setHits(await api.search(q.trim()));
      } finally {
        setLoading(false);
      }
    }, 120);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [q]);

  const open = (id: string) => {
    pushRecent(q.trim());
    ctx.go({ name: 'concept', id });
  };

  const groups: { key: string; items: SearchHit[] }[] = [];
  for (const h of hits) {
    const key = `${DOMAIN_LABEL[h.domain]} · ${ctx.stats?.tracks.find((t) => t.key === h.track)?.label ?? h.track}`;
    const g = groups.find((x) => x.key === key);
    if (g) g.items.push(h); else groups.push({ key, items: [h] });
  }

  return (
    <div className="page">
      <h2 className="page-title">搜索</h2>
      <div style={{ marginTop: 'var(--space-4)' }}>
        <input
          ref={inputRef}
          className="search-input"
          placeholder="输入概念、标签或关键词…"
          value={q}
          aria-label="搜索"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {!q.trim() && (
        <>
          <div className="sec-h">最近搜索</div>
          <div className="chips">
            {loadRecent().length === 0
              ? <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>还没有搜索记录</span>
              : loadRecent().map((t) => (
                <span className="chip" key={t} onClick={() => setQ(t)}>{t}</span>
              ))}
          </div>
        </>
      )}

      {q.trim() && !loading && hits.length === 0 && (
        <div className="empty">
          <b>没有找到「{q.trim()}」</b>
          换个关键词，或去设置页检查内容更新
        </div>
      )}

      {groups.map((g) => (
        <div key={g.key}>
          <div className="srch-grp">{g.key}</div>
          <div className="card">
            <div className="rows">
              {g.items.map((h) => (
                <div className="row" key={h.id} onClick={() => open(h.id)}>
                  <StatusDot status={h.status} />
                  <div className="rt">
                    <b>{highlight(h.title, q.trim())}</b>
                    <span>{highlight(h.one_liner, q.trim())}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
