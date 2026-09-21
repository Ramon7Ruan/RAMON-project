import type { Block, Concept, ConceptLink, ContentMeta, Domain, SearchHit, TrackKey } from '../../src/shared/types';
import type { ConceptSummary } from '../../src/shared/summary';
import { DOMAIN_LABEL } from '../../src/shared/types';
import { flatBody, relevance, toMatchQuery } from '../../src/shared/search';
import { CONTENT_SCHEMA_VERSION } from './schema';
import type { Db } from './index';

interface ConceptRow {
  id: string; domain: string; track: string; title: string; one_liner: string;
  key_points: string; difficulty: number; tags: string; recipe: string;
  blocks: string; links: string; source: string | null; updated_at: string;
  order_index: number;
}

function rowToConcept(r: ConceptRow): Concept {
  return {
    id: r.id,
    domain: r.domain as Domain,
    track: r.track as TrackKey,
    title: r.title,
    one_liner: r.one_liner,
    key_points: JSON.parse(r.key_points) as string[],
    difficulty: r.difficulty as 1 | 2 | 3,
    tags: JSON.parse(r.tags) as string[],
    recipe: JSON.parse(r.recipe) as Concept['recipe'],
    blocks: JSON.parse(r.blocks) as Block[],
    links: JSON.parse(r.links) as ConceptLink[],
    source: r.source ?? undefined,
    updated_at: r.updated_at,
    order: r.order_index,
  };
}

export function emptyMeta(): ContentMeta {
  return {
    version: '0.0.0',
    updated_at: '',
    schema_version: CONTENT_SCHEMA_VERSION,
    counts: { econ: 0, finance: 0, hotspot: 0, total: 0 },
  };
}

export function countsOf(concepts: Concept[]): ContentMeta['counts'] {
  const c = { econ: 0, finance: 0, hotspot: 0, total: concepts.length };
  for (const k of concepts) c[k.domain] += 1;
  return c;
}

/**
 * 把一整套概念写进一个**全新**的内容库文件。
 * 更新流程用它产出 content.db.new，校验通过后再原子 rename 到 content.db。
 */
export function buildContentDb(
  db: Db,
  concepts: Concept[],
  meta: Omit<ContentMeta, 'counts'> & { counts?: ContentMeta['counts'] },
): ContentMeta {
  const full: ContentMeta = {
    version: meta.version,
    updated_at: meta.updated_at,
    schema_version: meta.schema_version,
    counts: meta.counts ?? countsOf(concepts),
  };

  db.exec('DELETE FROM concepts');
  db.exec('DELETE FROM concepts_fts');
  db.exec('DELETE FROM meta');

  const insC = db.prepare(`INSERT OR REPLACE INTO concepts
    (id, domain, track, title, one_liner, key_points, difficulty, tags, recipe, blocks, links, source, updated_at, order_index, body_text)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insF = db.prepare('INSERT INTO concepts_fts(id, title, one_liner, tags, body_text) VALUES (?,?,?,?,?)');

  db.exec('BEGIN');
  try {
    for (const c of concepts) {
      const body = flatBody(c);
      insC.run(
        c.id, c.domain, c.track, c.title, c.one_liner,
        JSON.stringify(c.key_points), c.difficulty, JSON.stringify(c.tags),
        JSON.stringify(c.recipe), JSON.stringify(c.blocks),
        JSON.stringify(c.links), c.source ?? null, c.updated_at, c.order,
        body,
      );
      insF.run(c.id, c.title, c.one_liner, c.tags.join(' '), body);
    }
    const insM = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)');
    insM.run('version', full.version);
    insM.run('updated_at', full.updated_at);
    insM.run('schema_version', String(full.schema_version));
    insM.run('counts', JSON.stringify(full.counts));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return full;
}

export function readMeta(db: Db): ContentMeta {
  const rows = db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[];
  const m = new Map(rows.map((r) => [r.key, r.value]));
  let counts = { econ: 0, finance: 0, hotspot: 0, total: 0 };
  try {
    if (m.get('counts')) counts = JSON.parse(m.get('counts')!) as ContentMeta['counts'];
  } catch { /* 保持默认 */ }
  return {
    version: m.get('version') ?? '0.0.0',
    updated_at: m.get('updated_at') ?? '',
    schema_version: Number(m.get('schema_version') ?? CONTENT_SCHEMA_VERSION),
    counts,
  };
}

export function listSummaries(db: Db): ConceptSummary[] {
  const rows = db.prepare(`SELECT id, domain, track, title, one_liner, key_points, difficulty,
    tags, recipe, source, updated_at, order_index FROM concepts
    ORDER BY domain, order_index, id`).all() as Omit<ConceptRow, 'blocks' | 'links'>[];
  return rows.map((r) => ({
    id: r.id,
    domain: r.domain as Domain,
    track: r.track as TrackKey,
    title: r.title,
    one_liner: r.one_liner,
    key_points: JSON.parse(r.key_points) as string[],
    difficulty: r.difficulty as 1 | 2 | 3,
    tags: JSON.parse(r.tags) as string[],
    recipe: JSON.parse(r.recipe) as Concept['recipe'],
    source: r.source ?? undefined,
    updated_at: r.updated_at,
    order: r.order_index,
  }));
}

export function getConcept(db: Db, id: string): Concept | null {
  const r = db.prepare('SELECT * FROM concepts WHERE id = ?').get(id) as ConceptRow | undefined;
  return r ? rowToConcept(r) : null;
}

export function allConcepts(db: Db): Concept[] {
  const rows = db.prepare('SELECT * FROM concepts ORDER BY domain, order_index, id').all() as unknown as ConceptRow[];
  return rows.map(rowToConcept);
}

export function listTracks(db: Db): { key: TrackKey; domain: Domain; label: string }[] {
  return (db.prepare('SELECT key, domain, label FROM tracks ORDER BY sort').all() as
    { key: string; domain: string; label: string }[])
    .map((t) => ({ key: t.key as TrackKey, domain: t.domain as Domain, label: t.label }));
}

/**
 * 全文检索：FTS5 负责召回（含中文子串），JS 侧做业务加权排序。
 * 中文靠 segment() 预分词解决（见 src/shared/search.ts）。
 */
export function search(db: Db, q: string, limit = 40): SearchHit[] {
  const needle = q.trim();
  if (needle.length < 1) return [];

  let ids: string[] = [];
  const mq = toMatchQuery(needle);
  if (mq) {
    try {
      const rows = db.prepare('SELECT id FROM concepts_fts WHERE concepts_fts MATCH ? LIMIT 200').all(mq) as { id: string }[];
      ids = rows.map((r) => r.id);
    } catch {
      ids = []; // 查询串被 FTS 语法拒绝时回落到 LIKE
    }
  }
  if (ids.length === 0) {
    const like = `%${needle}%`;
    const rows = db.prepare(
      `SELECT id FROM concepts WHERE title LIKE ? OR one_liner LIKE ? OR tags LIKE ? OR body_text LIKE ? LIMIT 200`,
    ).all(like, like, like, like) as { id: string }[];
    ids = rows.map((r) => r.id);
  }

  if (ids.length === 0) return [];

  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM concepts WHERE id IN (${ph})`).all(...ids) as unknown as ConceptRow[];
  const hits = rows.map(rowToConcept).map((c) => ({
    id: c.id,
    title: c.title,
    one_liner: c.one_liner,
    domain: c.domain,
    track: c.track,
    score: relevance(c, needle),
    status: 'unread' as const,
  }));
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return hits.slice(0, limit);
}

export { DOMAIN_LABEL };
export type { ConceptSummary };
