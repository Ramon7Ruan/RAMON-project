export type Domain = 'econ' | 'finance' | 'hotspot';

export type TrackKey =
  | 'macro' | 'micro' | 'econometrics'
  | 'equity' | 'bond' | 'fund' | 'quant'
  | 'event' | 'data';

/** 11 种讲解方式 */
export type BlockType =
  | 'prose' | 'formula' | 'curve' | 'dataviz' | 'compare'
  | 'flow' | 'timeline' | 'pitfall' | 'case' | 'scale' | 'calc';

export const BLOCK_TYPES: BlockType[] = [
  'prose', 'formula', 'curve', 'dataviz', 'compare',
  'flow', 'timeline', 'pitfall', 'case', 'scale', 'calc',
];

export interface ProseBlock { type: 'prose'; label?: string; body: string }
export interface FormulaBlock {
  type: 'formula'; label?: string; latex: string; note?: string;
  symbols: { s: string; m: string }[];
}
export interface CurveBlock {
  type: 'curve'; label?: string; xLabel: string; yLabel: string;
  xDomain: [number, number]; yDomain: [number, number];
  series: { name: string; points: [number, number][]; dash?: number }[];
  note?: string;
  interactive?: 'elasticity';
}
export interface DatavizBlock {
  type: 'dataviz'; label?: string; chart: 'line' | 'bar';
  xLabel: string; yLabel: string; xTicks: string[];
  series: { name: string; points: number[] }[];
  source: string;
  /** 数据类图表的涨跌语义：up=涨（红）down=跌（绿），缺失则不应用涨跌色 */
  tone?: 'up' | 'down';
}
export interface CompareBlock {
  type: 'compare'; label?: string; columns: string[]; rows: string[][];
}
export interface FlowBlock {
  type: 'flow'; label?: string; steps: { label: string; note?: string }[];
}
export interface TimelineBlock {
  type: 'timeline'; label?: string;
  events: { date: string; title: string; note: string; hot?: boolean }[];
}
export interface PitfallBlock {
  type: 'pitfall'; label?: string; wrong: string; right: string; why: string;
}
export interface CaseBlock {
  type: 'case'; label?: string; title: string; body: string;
  nums?: { label: string; v: string }[];
}
export interface ScaleBlock {
  type: 'scale'; label?: string;
  ticks: { v: string; t: string }[];
}
export interface CalcBlock {
  type: 'calc'; label?: string; calc: 'duration';
  inputs: { key: string; label: string; min: number; max: number; step: number; v: number; unit: string }[];
}

export type Block =
  | ProseBlock | FormulaBlock | CurveBlock | DatavizBlock | CompareBlock
  | FlowBlock | TimelineBlock | PitfallBlock | CaseBlock | ScaleBlock | CalcBlock;

export interface ConceptLink { to: string; reason: string }

export interface Concept {
  id: string;
  domain: Domain;
  track: TrackKey;
  title: string;
  one_liner: string;
  key_points: string[];
  difficulty: 1 | 2 | 3;
  tags: string[];
  recipe: BlockType[];
  blocks: Block[];
  links: ConceptLink[];
  source?: string;
  updated_at: string;
  order: number;
}

export interface TrackDef { key: TrackKey; domain: Domain; label: string; sort: number }

export const DOMAIN_LABEL: Record<Domain, string> = {
  econ: '经济学', finance: '金融学', hotspot: '世界热点',
};

/** 概念状态机（PRD §3.5） */
export type ConceptStatus = 'unread' | 'reading' | 'review' | 'known' | 'fuzzy';

export const STATUS_SYMBOL: Record<ConceptStatus, string> = {
  unread: '○', reading: '◐', review: '◉', known: '●', fuzzy: '◆',
};

export const STATUS_LABEL: Record<ConceptStatus, string> = {
  unread: '未读', reading: '在读', review: '待复习', known: '已掌握', fuzzy: '不懂',
};

export interface ConceptState {
  concept_id: string;
  status: ConceptStatus;
  ease: number;
  interval_days: number;
  due_at: string | null;
  reps: number;
  lapses: number;
  last_review: string | null;
}

export type Rating = 0 | 1 | 2;

export interface SearchHit {
  id: string;
  title: string;
  one_liner: string;
  domain: Domain;
  track: TrackKey;
  status: ConceptStatus;
  score: number;
}

export interface ContentMeta {
  version: string;
  updated_at: string;
  schema_version: number;
  counts: { econ: number; finance: number; hotspot: number; total: number };
}

export interface UpdateInfo {
  version: string;
  updated_at: string;
  counts: ContentMeta['counts'];
  diff: { domain: Domain; added: number; changed: number }[];
  fileUrl: string;
  sha256: string;
  size: number;
}
