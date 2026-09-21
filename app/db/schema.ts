/**
 * 双库 DDL。
 *
 * content.db —— 内容库，可被整包替换
 * user.db    —— 我的数据，任何更新流程都不覆盖（PRD §6.3）
 */

export const CONTENT_SCHEMA_VERSION = 1;

export const CONTENT_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  key   TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  label TEXT NOT NULL,
  sort  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS concepts (
  id          TEXT PRIMARY KEY,
  domain      TEXT NOT NULL,
  track       TEXT NOT NULL,
  title       TEXT NOT NULL,
  one_liner   TEXT NOT NULL,
  key_points  TEXT NOT NULL,
  difficulty  INTEGER NOT NULL,
  tags        TEXT NOT NULL,
  recipe      TEXT NOT NULL,
  blocks      TEXT NOT NULL,
  links       TEXT NOT NULL,
  source      TEXT,
  updated_at  TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  body_text   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_concepts_domain ON concepts(domain, track, order_index);

CREATE VIRTUAL TABLE IF NOT EXISTS concepts_fts USING fts5(
  id UNINDEXED,
  title,
  one_liner,
  tags,
  body_text,
  tokenize = 'unicode61'
);
`;

export const USER_DDL = `
CREATE TABLE IF NOT EXISTS concept_state (
  concept_id    TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'unread',
  ease          REAL NOT NULL DEFAULT 2.5,
  interval_days REAL NOT NULL DEFAULT 0,
  due_at        TEXT,
  reps          INTEGER NOT NULL DEFAULT 0,
  lapses        INTEGER NOT NULL DEFAULT 0,
  last_review   TEXT
);

CREATE TABLE IF NOT EXISTS review_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id TEXT NOT NULL,
  rating     INTEGER NOT NULL,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_at ON review_log(at);

CREATE TABLE IF NOT EXISTS favorites (
  concept_id TEXT PRIMARY KEY,
  at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 默认专题定义（与 PRD §3.2 一致） */
export const DEFAULT_TRACKS = [
  { key: 'macro', domain: 'econ', label: '宏观经济', sort: 1 },
  { key: 'micro', domain: 'econ', label: '微观经济', sort: 2 },
  { key: 'econometrics', domain: 'econ', label: '计量经济', sort: 3 },
  { key: 'equity', domain: 'finance', label: '股票', sort: 4 },
  { key: 'bond', domain: 'finance', label: '债券', sort: 5 },
  { key: 'fund', domain: 'finance', label: '基金', sort: 6 },
  { key: 'quant', domain: 'finance', label: '量化', sort: 7 },
  { key: 'event', domain: 'hotspot', label: '事件解剖', sort: 8 },
  { key: 'data', domain: 'hotspot', label: '数据观察', sort: 9 },
] as const;
